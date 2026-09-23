import { LIM, newDoc, applyPatch, wipeDoc, sanitizeDoc, hasContent, cleanSoup } from './validate.js';
import { judge } from './judge.js';

const BUCKET_MAX = 20;        // 每連線的操作桶容量
const BUCKET_RATE = 5;        // 每秒回補
const SEED_COOLDOWN = 3000;   // 兩次「求救」之間至少隔這麼久

const DAY = 24 * 3600 * 1000;
const CALLS_MAX = 200;        // 一題最多判幾次。生命可以加到 300，但額度是全站共用的
const HOST_PER_HOUR = 3;      // 每個 IP 貼新題的次數。接續同一題不算
const HOST_PER_DAY = 10;
const IDLE = 7 * DAY;         // 題目放在 storage 裡，這麼久沒人在就清掉
const STUCK = '🐢 判不出來，換個問法再問一次';
const ACTS = 8;                // 記住最近幾個呼叫／請離的操作 ID（見 done）

/**
 * 一個房間一個 Durable Object。
 * 單執行緒＝所有 patch 天然序列化，不需要 CRDT 也不會壞資料。
 *
 * 文件只活在記憶體裡，永不落地 —— 這是刻意的：派對工具的房間本來就短命，
 * 而高頻共編若每次都寫 SQLite，正常一場派對就要吃掉一大塊每日額度。
 * 代價是休眠或重啟會清空記憶體，靠客戶端 re-seed 補回來（見 askSeed / onSeed）。
 *
 * 唯一會落地的是交給 AI 主持的那一題（soup）：湯底不能進文件，文件人人讀得到，
 * 而記憶體會掉，所以它只能在 storage 裡。一局只寫幾次，外加每判一題記一次次數。
 */
export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.doc = null;            // null＝這顆物件手上沒有文件
    this.buckets = new Map();   // ws -> {t, at}；休眠後重建，重建即滿桶
    this.seeding = 0;           // 上次向客戶端求救的時間
    this.told = undefined;      // 上次廣播出去的主持狀態；休眠後重來一次不影響正確性

    // {surface, bottom, on, shown, calls}；undefined＝還沒讀，null＝這間房沒有交給 AI
    this.soup = undefined;
    this.judging = null;        // 判題迴圈正在跑的那個 promise
    this.starting = false;      // 新題目正在過限流；重送的那一則別再算一次
    this.acts = [];             // 最近處理過的呼叫／請離操作 ID
    this.stuck = new Map();     // 列 -> 判不出來的那句提問；玩家改了問法才再試
  }

  /**
   * 「我手上這份是醒來後現編的空文件，正在等人補」的狀態。
   * 這段期間不接受寫入，否則會用空文件當基底往下改，把大家的內容洗掉。
   * 但不能無限等 —— 萬一房裡沒人有內容（例如全部剛重整過），
   * 超過冷卻時間就認定這份空的是真的，開始正常運作。
   */
  isHollow() {
    return this.seeding > 0 && Date.now() - this.seeding < SEED_COOLDOWN;
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      const ip = url.searchParams.get('ip') || '';
      return this.connect(url.searchParams.get('create') === '1', /^[0-9a-f]{32}$/.test(ip) ? ip : '');
    }
    return new Response('not found', { status: 404 });
  }

  sockets() { return this.state.getWebSockets(); }

  // ── 連線 ────────────────────────────
  async connect(mayCreate, ip) {
    await this.loadSoup();
    const live = this.sockets().length;

    // 手上沒文件又沒人在線＝這間房不存在。不自己開，先回報給 Worker，
    // 讓它過完開房限流再回來；少了這個轉手，掃網址就等於無限開房。
    // 交給 AI 的題目還在 storage 裡的話，房間就還在：題目本身補得回來，列補不回來。
    if (!this.doc && live === 0) {
      if (!mayCreate && !this.soup) {
        return new Response('no such room', { status: 404, headers: { 'X-Room-Missing': '1' } });
      }
      this.doc = newDoc();
      this.fillSoup(this.doc);
    }
    if (live >= LIM.peers) return new Response('room full', { status: 429 });

    // 有人在線但我手上是空的＝休眠後醒來，記憶體掉了
    if (!this.doc && live > 0) {
      this.doc = newDoc();
      this.askSeed();
    }

    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    // 限流要用的 IP 雜湊存在連線上：物件休眠後實例欄位沒了，連線還在。
    if (ip) pair[1].serializeAttachment({ ip });
    this.sendSync(pair[1]);

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // ── 訊息 ────────────────────────────
  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string') return ws.close(1003, 'text only');
    // 先用字元數快篩，超過才算真正的位元組數（CJK 一字三位元組）
    if (raw.length > LIM.msgBytes || new TextEncoder().encode(raw).length > LIM.msgBytes) {
      return ws.close(1009, 'too big');
    }
    if (!this.spend(ws)) return this.err(ws, 'rate_limited');

    let m;
    try { m = JSON.parse(raw); } catch { return this.err(ws, 'bad_json'); }
    if (!m || typeof m.t !== 'string') return this.err(ws, 'bad_msg');

    await this.loadSoup();

    // 休眠醒來、記憶體是空的：先向房裡的人要一份回來
    if (!this.doc) {
      this.doc = newDoc();
      this.askSeed();
    }

    if (m.t === 'seed') return this.onSeed(ws, m);

    // 還在等人補的期間丟掉 patch：這一筆不會消失，送出的人手上那份已經含了它，
    // 接下來的 seed 會把它一起帶回來。清空不受影響 —— 反正目標就是空的。
    if (m.t === 'patch' && this.isHollow()) return;

    switch (m.t) {
      case 'patch':   return this.onPatch(ws, m);
      case 'wipe':    return this.wipe();
      case 'resync':  return this.sendSync(ws);
      case 'host':    return this.onHost(ws, m);
      case 'dismiss': return this.onDismiss(ws, m);
      default:        return this.err(ws, 'unknown');
    }
  }

  async onPatch(ws, m) {
    // 題目交給 AI 之後，有些欄位只剩伺服器能寫。擋下的那幾筆退回，其餘照收 ——
    // 整筆退回的話，同一批裡玩家剛打完的提問也會跟著消失。
    let ops = m.ops;
    if (Array.isArray(ops)) {
      const kept = ops.filter(op => this.mayWrite(op));
      if (kept.length !== ops.length) {
        this.err(ws, 'hosted');
        if (!kept.length) return;
      }
      ops = kept;
    }

    const res = applyPatch(this.doc, ops);
    if (res.err) return this.err(ws, res.err);
    this.doc = res.doc;
    // 廣播給所有人（含發送者）：rev 才能連續，發送者也才會拿到清理過的值
    this.blast({ t: 'patch', rev: res.doc.rev, ops: res.ops });

    // 玩家按下「揭曉湯底」。湯底只在伺服器上，所以這裡直接揭。
    const s = this.soup;
    if (s && !s.shown && res.ops.some(op => op.p === 'want' && op.v === true)) return this.reveal();
    this.kick();
  }

  /** 伺服器自己寫的修改：答案、揭底、補回湯麵。不經過玩家那一層的限制。 */
  commit(ops) {
    const res = applyPatch(this.doc, ops);
    if (res.err) {
      console.warn('[room] commit rejected', res.err);
      return false;
    }
    this.doc = res.doc;
    this.blast({ t: 'patch', rev: res.doc.rev, ops: res.ops });
    return true;
  }

  /** 清空。同時取消「等人補」的狀態，否則晚到的 seed 會把剛清掉的內容救回來。 */
  async wipe() {
    this.seeding = 0;
    this.doc = wipeDoc(this.doc || newDoc());
    // 清空就是這一局結束：交給 AI 的題目一起丟掉，下一題重新貼
    if (this.soup) {
      this.soup = null;
      this.stuck.clear();
      await this.state.storage.deleteAll();
    }
    this.blast(this.syncMsg('wipe'));
    this.tellHere();
  }

  /**
   * 每一則 sync 都要長得一樣。
   *
   * 少帶 here 的那種曾經存在過：清空與 seed 各自組了自己的訊息，於是房間每被補一次，
   * 所有人的主持端狀態就被那份殘缺的 sync 歸零一次 —— 玩家看到的是「沒有主持人」，
   * 但主持人一直都在。少帶 hollow 更糟：客戶端會拿空文件蓋掉自己手上的內容。
   */
  syncMsg(why) {
    return {
      t: 'sync', doc: this.doc, lim: LIM,
      here: this.here(), hollow: this.isHollow() || undefined, why,
    };
  }

  sendSync(ws) {
    try { ws.send(JSON.stringify(this.syncMsg())); } catch { /* 已斷線 */ }
  }

  /* ── 主持狀態 ──────────────────────
   *
   * ear＝AI 正在回答；away＝題目還藏在伺服器上，但 AI 被請離了；''＝沒有交給 AI。
   *
   * 刻意不放進文件：文件會被客戶端整份 seed 回來，玩家就能自己宣稱「有人在主持」。
   * 從 soup 推導的話，狀態永遠跟伺服器實際在做的事一致。
   */
  here() {
    const s = this.soup;
    if (!s || s.shown) return '';
    return s.on ? 'ear' : 'away';
  }

  /** 只在真的變了才廣播。 */
  tellHere() {
    const here = this.here();
    if (here === this.told) return;
    this.told = here;
    this.blast({ t: 'here', here });
  }

  webSocketClose(ws) { this.buckets.delete(ws); }
  webSocketError(ws) { this.buckets.delete(ws); }

  // ── 記憶體掉了之後的補救 ──────────────
  askSeed() {
    const now = Date.now();
    if (now - this.seeding < SEED_COOLDOWN) return;
    this.seeding = now;
    this.blast({ t: 'need' });
    // 題目在伺服器手上，不必等人補。等窗口過了還是空的，自己把湯麵放回去。
    if (this.soup) this.healLater();
  }

  healLater() {
    const left = SEED_COOLDOWN - (Date.now() - this.seeding);
    setTimeout(() => this.heal(), Math.max(left, 0) + 100);
  }

  heal() {
    if (!this.doc || !this.soup || this.isHollow() || this.doc.surface) return;
    const s = this.soup;
    this.commit([{ p: 'surface', v: s.surface }, ...(s.shown ? [{ p: 'bottom', v: s.bottom }] : [])]);
    this.kick();
  }

  /** 題目自己的那兩格。湯底只有揭曉之後才進文件。 */
  fillSoup(doc) {
    const s = this.soup;
    if (!s) return doc;
    doc.surface = s.surface;
    doc.bottom = s.shown ? s.bottom : '';
    return doc;
  }

  /**
   * 只在「我確實開口要過」的期間才接受整份文件。條件放寬會出事：
   * 剛被清空的房間也是空的，那時候若還收 seed，舊內容就會被救回來。
   */
  onSeed(ws, m) {
    if (!this.isHollow() || hasContent(this.doc)) return;
    const doc = sanitizeDoc(m.doc);
    if (!doc) return this.err(ws, 'bad_seed');
    // 題目那兩格以伺服器為準：客戶端送回來的湯底是誰寫的都有可能
    this.doc = this.fillSoup(doc);
    this.seeding = 0;                          // 補齊了，關掉窗口
    this.blast(this.syncMsg());
    this.kick();
  }

  // 不特別在最後一人離線時清掉文件：物件閒置後本來就會被回收，記憶體跟著沒。
  // 中間那段空窗反而是好事 —— 有人不小心關掉分頁馬上回來，這局還在。

  // ── AI 主持 ─────────────────────────
  async loadSoup() {
    if (this.soup === undefined) this.soup = (await this.state.storage.get('soup')) || null;
    return this.soup;
  }

  saveSoup() { return this.state.storage.put('soup', this.soup); }

  hosting() {
    const s = this.soup;
    return !!(s && s.on && !s.shown);
  }

  /**
   * 題目交給 AI 之後誰能寫什麼。湯麵、湯底與揭底提議只有伺服器能寫 ——
   * 湯底一旦能被玩家寫進文件，就不再是藏起來的那一份。AI 在場時答案與註解也是它的。
   * 被請離的期間答案欄還給人：貼題的人知道湯底，可以自己接著主持。
   */
  mayWrite(op) {
    const s = this.soup;
    if (!s || s.shown || !op || typeof op.p !== 'string') return true;   // 格式錯的交給 applyPatch
    if (op.p === 'surface' || op.p === 'bottom' || op.p === 'ask') return false;
    return !(s.on && /^rows\.\d{1,3}\.(a|n)$/.test(op.p));
  }

  /**
   * 呼叫 AI 主持。房間裡已經有藏著的題目就是接續那一題，不必再貼；
   * 否則收下這一次貼上來的湯麵與湯底。湯底只進 storage，不進文件。
   *
   * 每一次按鈕帶一個操作 ID，前端等不到這個 ID 的回應就用同一個 ID 重送。處理過的 ID
   * 再來只回報現況：它多半是回應在路上掉了。只看狀態判斷會出錯 —— 中間要是有人按了請離，
   * 遲到的重送會把 AI 又叫回來。
   *
   * ID 是客戶端寫的，不可信，所以它只用來「別做兩次」，不用來省限流：
   * 開新題不管 ID 怎麼寫都要過每個 IP 的限流。同一個循環裡多的呼叫本來就沒有作用。
   */
  async onHost(ws, m) {
    const id = actId(m.id);
    if (this.done(id)) return this.ack(ws, id);

    const s = this.soup;
    if (s && !s.shown) {
      this.remember(id);
      if (!s.on) {
        s.on = true;
        await this.saveSoup();
        this.tellHere();
        this.kick();                          // 還在等人補的話 kick 不會動，補完或 heal 之後才開始
      }
      return this.ack(ws, id);
    }
    if (this.starting) return;                // 上一則還在過限流；這一則等不到回應會重送

    const soup = cleanSoup(m);
    if (!soup) return this.err(ws, 'bad_soup', id);
    this.starting = true;
    try {
      if (!(await this.allowHost(ws))) return this.err(ws, 'host_rate_limited', id);
      this.soup = { ...soup, on: true, shown: false, calls: 0 };
      this.remember(id);
      this.stuck.clear();
      await this.saveSoup();
      await this.state.storage.setAlarm(Date.now() + IDLE);
    } finally {
      this.starting = false;
    }

    // 題目以 storage 為準，文件裡的湯麵只是它的投影。還在等人補的話現在寫進文件，
    // 文件就有了內容，seed 會被擋掉；所以交給補完那一刻（onSeed 的 fillSoup）或
    // 窗口過了還沒人補時的 heal。
    //
    // 這一則多半就是叫醒物件、讓它進入空窗的那一則：貼題要花時間，對話框開著的期間
    // 房裡沒有任何訊息，物件早就休眠了。丟掉它曾經是「按了沒反應」的原因。
    if (this.isHollow()) this.healLater();
    else this.commit([{ p: 'surface', v: soup.surface }, { p: 'bottom', v: '' }]);
    this.tellHere();
    this.kick();
    this.ack(ws, id);
  }

  async onDismiss(ws, m) {
    const id = actId(m.id);
    if (this.done(id)) return this.ack(ws, id);
    this.remember(id);
    const s = this.soup;
    if (s && !s.shown && s.on) {
      s.on = false;                           // 正在等的那一題回來時會看到這個，結果直接丟掉
      await this.saveSoup();
      this.tellHere();
    }
    this.ack(ws, id);
  }

  /**
   * 這個操作處理過了嗎。只記最後一個不夠：呼叫之後接著請離，請離的 ID 會把呼叫的蓋掉，
   * 遲到的呼叫重送就又把 AI 叫回來了。所以記最近幾個。
   *
   * 記憶體裡的那份撐不過休眠，所以題目上也記一份 —— 呼叫與請離本來就要寫題目，
   * 順手帶上不多花一次寫入。
   */
  done(id) {
    if (!id) return false;
    return this.acts.includes(id) || !!(this.soup && Array.isArray(this.soup.acts) && this.soup.acts.includes(id));
  }

  remember(id) {
    if (!id) return;
    const had = this.soup && Array.isArray(this.soup.acts) ? this.soup.acts : [];
    this.acts = [...new Set([...had, ...this.acts, id])].slice(-ACTS);
    if (this.soup) this.soup.acts = this.acts;
  }

  /** 只回給送出的那個連線，帶著它的操作 ID：前端收到這一則才解除按鈕的封鎖。 */
  ack(ws, id) {
    try { ws.send(JSON.stringify({ t: 'ack', id, here: this.here() })); } catch { /* 已斷線 */ }
  }

  async reveal() {
    const s = this.soup;
    s.shown = true;
    s.on = false;                             // 湯底都攤開了，AI 再回答也沒有意義
    await this.saveSoup();
    this.commit([{ p: 'bottom', v: s.bottom }]);
    this.tellHere();
  }

  async allowHost(ws) {
    let ip = '';
    try { ip = (ws.deserializeAttachment() || {}).ip || ''; } catch { /* 沒帶 */ }
    if (!ip) return false;
    const gate = this.env.LIMITER.get(this.env.LIMITER.idFromName('host:' + ip));
    const res = await gate.fetch('https://limiter/?h=' + HOST_PER_HOUR + '&d=' + HOST_PER_DAY);
    return res.ok;
  }

  /** 有待答的列就開始判。同一時間只跑一個迴圈，照列號一題一題來。 */
  kick() {
    if (this.judging || !this.hosting()) return;
    this.judging = this.judgeAll()
      .catch(e => console.error('[judge]', String(e && e.message || e)))
      .finally(() => { this.judging = null; });
  }

  nextPending() {
    const d = this.doc;
    for (let i = 0; i < d.rows.length && i < d.lives; i++) {
      const r = d.rows[i];
      if (r.q.trim() && !r.a && this.stuck.get(i) !== r.q) return i;
    }
    return -1;
  }

  async judgeAll() {
    for (;;) {
      const s = this.soup;
      if (!this.hosting() || !this.doc || this.isHollow()) return;
      const i = this.nextPending();
      if (i < 0) return;

      if (s.calls >= CALLS_MAX) {
        s.on = false;
        await this.saveSoup();
        this.tellHere();
        return this.blast({ t: 'err', code: 'host_cap' });
      }
      const q = this.doc.rows[i].q;
      s.calls++;
      await this.saveSoup();

      const t0 = Date.now();
      const r = await judge(this.env.AI, s, q);

      // 等模型的這幾秒裡什麼都可能發生：被請離、被清空、玩家改了題目、別人先答了
      if (this.soup !== s || !this.hosting() || !this.doc) return;
      const row = this.doc.rows[i];
      if (!row || row.q !== q || row.a) continue;

      // 只記列號與用量，不記提問與湯底 —— 日誌是 wrangler tail 看得到的地方
      console.log('[judge]', JSON.stringify({ row: i + 1, a: r.a, err: r.err, ms: Date.now() - t0, neurons: r.neurons }));

      if (r.err === 'spent') {
        s.on = false;
        await this.saveSoup();
        this.tellHere();
        return this.blast({ t: 'err', code: 'ai_spent' });
      }
      if (r.err) {
        this.stuck.set(i, q);
        if (row.n !== STUCK) this.commit([{ p: 'rows.' + i + '.n', v: STUCK }]);
        continue;
      }
      const ops = [{ p: 'rows.' + i + '.a', v: r.a }];
      if (row.n === STUCK) ops.push({ p: 'rows.' + i + '.n', v: '' });
      this.commit(ops);
    }
  }

  // 題目在 storage 裡放著，房間就一直在（見 connect）。沒人在就別讓它永遠留著。
  async alarm() {
    if (this.sockets().length) return this.state.storage.setAlarm(Date.now() + DAY);
    this.soup = null;
    this.doc = null;
    await this.state.storage.deleteAll();
  }

  // ── 限流 ────────────────────────────
  spend(ws) {
    const now = Date.now();
    let b = this.buckets.get(ws);
    if (!b) { b = { t: BUCKET_MAX, at: now }; this.buckets.set(ws, b); }
    b.t = Math.min(BUCKET_MAX, b.t + ((now - b.at) / 1000) * BUCKET_RATE);
    b.at = now;
    if (b.t < 1) return false;
    b.t -= 1;
    return true;
  }

  // ── 廣播 ────────────────────────────
  blast(msg) {
    const s = JSON.stringify(msg);
    for (const ws of this.sockets()) {
      try { ws.send(s); } catch { /* 對方已斷線，交給 close handler */ }
    }
  }

  err(ws, code, id) {
    try { ws.send(JSON.stringify({ t: 'err', code, id })); } catch { /* ignore */ }
  }
}

// 操作 ID 是客戶端寫的：只收短的英數字串，其餘當作沒帶
const actId = v => (typeof v === 'string' && /^[A-Za-z0-9_-]{8,40}$/.test(v) ? v : '');
