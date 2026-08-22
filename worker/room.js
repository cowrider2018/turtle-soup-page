import { LIM, newDoc, applyPatch, wipeDoc, sanitizeDoc, hasContent } from './validate.js';

const BUCKET_MAX = 20;        // 每連線的操作桶容量
const BUCKET_RATE = 5;        // 每秒回補
const SEED_COOLDOWN = 3000;   // 兩次「求救」之間至少隔這麼久

/**
 * 一個房間一個 Durable Object。
 * 單執行緒＝所有 patch 天然序列化，不需要 CRDT 也不會壞資料。
 *
 * 文件只活在記憶體裡，永不落地 —— 這是刻意的：派對工具的房間本來就短命，
 * 而高頻共編若每次都寫 SQLite，正常一場派對就要吃掉一大塊每日額度。
 * 代價是休眠或重啟會清空記憶體，靠客戶端 re-seed 補回來（見 askSeed / onSeed）。
 *
 * 唯一會落地的是 lock 這一個 key，一天最多被寫幾次。
 */
export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.doc = null;            // null＝這顆物件手上沒有文件
    this.buckets = new Map();   // ws -> {t, at}；休眠後重建，重建即滿桶
    this.flags = null;          // {locked, frozen}，每個實例只讀一次
    this.seeding = 0;           // 上次向客戶端求救的時間
    this.told = undefined;      // 上次廣播出去的主持端狀態；休眠後重來一次不影響正確性
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
      return this.connect(url.searchParams.get('create') === '1', url.searchParams.get('role') || '');
    }
    if (url.pathname === '/admin') return this.admin(url.searchParams);
    return new Response('not found', { status: 404 });
  }

  sockets() { return this.state.getWebSockets(); }

  // ── 連線 ────────────────────────────
  async connect(mayCreate, role) {
    const live = this.sockets().length;

    // 手上沒文件又沒人在線＝這間房不存在。不自己開，先回報給 Worker，
    // 讓它過完開房限流再回來；少了這個轉手，掃網址就等於無限開房。
    if (!this.doc && live === 0) {
      if (!mayCreate) {
        return new Response('no such room', { status: 404, headers: { 'X-Room-Missing': '1' } });
      }
      this.doc = newDoc();
    }
    if (live >= LIM.peers) return new Response('room full', { status: 429 });

    // 有人在線但我手上是空的＝休眠後醒來，記憶體掉了
    if (!this.doc && live > 0) {
      this.doc = newDoc();
      this.askSeed();
    }

    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    // 身分要存在連線上，不能存在實例欄位裡 —— 物件休眠後醒來，實例欄位沒了，
    // 連線還在，那時候只有 attachment 說得出誰是主持端。
    if (role === 'floor' || role === 'ear') pair[1].serializeAttachment({ role });
    this.sendSync(pair[1]);
    this.tellHere();

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

    // 休眠醒來、記憶體是空的：先向房裡的人要一份回來
    if (!this.doc) {
      this.doc = newDoc();
      this.askSeed();
    }

    // 鎖房與全站凍結擋掉所有寫入，seed 也算寫入 —— 否則鎖了房還能整份蓋掉
    if (m.t === 'patch' || m.t === 'wipe' || m.t === 'seed') {
      const stop = await this.guard();
      if (stop) return this.err(ws, stop);
    }

    if (m.t === 'seed') return this.onSeed(ws, m);

    // 還在等人補的期間丟掉 patch：這一筆不會消失，送出的人手上那份已經含了它，
    // 接下來的 seed 會把它一起帶回來。清空不受影響 —— 反正目標就是空的。
    if (m.t === 'patch' && this.isHollow()) return;

    switch (m.t) {
      case 'patch':  return this.onPatch(ws, m);
      case 'wipe':   return this.wipe();
      case 'resync': return this.sendSync(ws);
      default:       return this.err(ws, 'unknown');
    }
  }

  onPatch(ws, m) {
    const res = applyPatch(this.doc, m.ops);
    if (res.err) return this.err(ws, res.err);
    this.doc = res.doc;
    // 廣播給所有人（含發送者）：rev 才能連續，發送者也才會拿到清理過的值
    this.blast({ t: 'patch', rev: res.doc.rev, ops: res.ops });
  }

  /** 清空。同時取消「等人補」的狀態，否則晚到的 seed 會把剛清掉的內容救回來。 */
  wipe() {
    this.seeding = 0;
    this.doc = wipeDoc(this.doc || newDoc());
    this.blast(this.syncMsg('wipe'));
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

  /* ── 主持端在不在 ──────────────────────
   *
   * 這件事刻意不放進文件：文件沒有 TTL，主持行程被 kill、網路斷掉、筆電闔上，
   * 最後寫進去的「在線」會永遠留著，玩家看著綠燈卻等不到人。從連線推導就不會說謊 ——
   * 行程沒了連線就沒了，狀態自動歸零，也沒有任何清理邏輯要維護。
   *
   * ear（wait 掛著，問題一到就有人判）優先於 floor（hold 守著房間，主持人還在準備）。
   */
  here(skip) {
    let floor = false;
    for (const ws of this.sockets()) {
      if (ws === skip) continue;
      let att = null;
      try { att = ws.deserializeAttachment(); } catch { /* 沒帶身分的普通玩家 */ }
      const role = att && att.role;
      if (role === 'ear') return 'ear';
      if (role === 'floor') floor = true;
    }
    return floor ? 'floor' : '';
  }

  /** 只在真的變了才廣播。斷線那一刻 skip 掉正在關的那條，否則它會被算進在場。 */
  tellHere(skip) {
    const here = this.here(skip);
    if (here === this.told) return;
    this.told = here;
    this.blast({ t: 'here', here });
  }

  webSocketClose(ws) { this.tellHere(ws); }
  webSocketError(ws) { this.tellHere(ws); }

  // ── 記憶體掉了之後的補救 ──────────────
  askSeed() {
    const now = Date.now();
    if (now - this.seeding < SEED_COOLDOWN) return;
    this.seeding = now;
    this.blast({ t: 'need' });
  }

  /**
   * 只在「我確實開口要過」的期間才接受整份文件。條件放寬會出事：
   * 剛被清空的房間也是空的，那時候若還收 seed，舊內容就會被救回來。
   */
  onSeed(ws, m) {
    if (!this.isHollow() || hasContent(this.doc)) return;
    const doc = sanitizeDoc(m.doc);
    if (!doc) return this.err(ws, 'bad_seed');
    this.doc = doc;
    this.seeding = 0;                          // 補齊了，關掉窗口
    this.blast(this.syncMsg());
  }

  // 不特別在最後一人離線時清掉文件：物件閒置後本來就會被回收，記憶體跟著沒。
  // 中間那段空窗反而是好事 —— 有人不小心關掉分頁馬上回來，這局還在。

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

  /**
   * 寫入闖關：'locked'（單房唯讀）、'frozen'（全站停寫）或 null。
   * 每個物件實例只讀一次就記在記憶體 —— 沒有輪詢，所以不會白吃額度。
   * lock 由管理指令直接打進這顆 DO，當下就會更新 this.flags，所以是即時的；
   * frozen 在 KV，這裡只在物件醒來時讀一次，屬於比較鈍的工具。
   */
  async guard() {
    if (!this.flags) {
      const locked = (await this.state.storage.get('lock')) === 1;
      let frozen = false;
      if (this.env.CTRL) frozen = (await this.env.CTRL.get('frozen', { cacheTtl: 60 })) === '1';
      this.flags = { locked, frozen };
    }
    return this.flags.locked ? 'locked' : (this.flags.frozen ? 'frozen' : null);
  }

  // ── 廣播 ────────────────────────────
  blast(msg) {
    const s = JSON.stringify(msg);
    for (const ws of this.sockets()) {
      try { ws.send(s); } catch { /* 對方已斷線，交給 close handler */ }
    }
  }

  err(ws, code) {
    try { ws.send(JSON.stringify({ t: 'err', code })); } catch { /* ignore */ }
  }

  // ── 管理（只從 Worker 的排程處理器進來）────
  async admin(params) {
    const op = params.get('op');
    const peers = this.sockets().length;
    const locked = (await this.state.storage.get('lock')) === 1;

    if (op === 'lock' || op === 'unlock') {
      if (op === 'lock') await this.state.storage.put('lock', 1);
      else await this.state.storage.delete('lock');
      if (this.flags) this.flags.locked = op === 'lock';   // 立刻生效，不等下次醒來
      return Response.json({ ok: true, locked: op === 'lock', peers });
    }

    if (op === 'status') {
      const doc = this.doc;
      return Response.json({
        ok: true,
        online: peers > 0,
        peers,
        locked,
        hasDoc: !!doc,
        ...(doc ? {
          rev: doc.rev,
          lives: doc.lives,
          rows: doc.rows.length,
          bytes: new TextEncoder().encode(JSON.stringify(doc)).length,
        } : {}),
        ...(!doc && peers > 0 ? { note: this.nudge() } : {}),
        ...(!doc && peers === 0 ? { note: '房間沒人在線，文件不落地所以沒有內容可看' } : {}),
      });
    }

    if (op === 'dump') {
      if (!this.doc) {
        return Response.json({
          ok: true, online: peers > 0, doc: null,
          note: peers > 0 ? this.nudge() : '房間沒人在線，文件不落地所以沒有內容可匯出',
        });
      }
      return Response.json({ ok: true, online: true, doc: this.doc });
    }

    // 剛醒來、手上是空的也照樣清 —— 廣播出去就會把大家手上那份一起清掉，
    // 而且會取消「等人補」，所以不會被晚到的 seed 救回來。
    if (op === 'wipe') {
      this.wipe();
      return Response.json({ ok: true, rev: this.doc.rev, peers });
    }

    if (op === 'delete') {
      for (const ws of this.sockets()) {
        try { ws.close(1001, 'room deleted'); } catch { /* 已斷線 */ }
      }
      this.doc = null;
      this.flags = null;
      await this.state.storage.deleteAll();   // 只有 lock 這一個 key
      return Response.json({ ok: true, kicked: peers });
    }

    return Response.json({ ok: false, error: 'unknown_op' }, { status: 400 });
  }

  nudge() {
    this.askSeed();
    return '房間醒來後記憶體是空的，已向線上的人要一份回來，過幾秒再跑一次';
  }
}
