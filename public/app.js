/* 海龜湯 · 共編
   前端只是伺服器文件的鏡子。上限一律以伺服器為準，這裡的檢查只是為了少送一趟往返。

   紅線：遠端字串永不進 innerHTML。所有使用者內容只走 .value 與 .textContent，
   儲存型 XSS 因此在結構上不存在，不依賴任何黑名單過濾。 */
(function () {
  'use strict';

  const LIM = { livesMin: 1, livesMax: 300, rows: 300, q: 300, n: 200 };
  // 揭底提議的兩句文案，也是 ask 欄位僅有的兩個合法值。
  // near＝還差一格，full＝全部解開；文案寫死在這裡，房間文件只帶鍵名。
  const OFFER = {
    near: ['你已經非常接近謎底', '還差一點沒問到，要現在揭露湯底嗎？'],
    full: ['你已經猜出夠多線索', '要揭曉湯底嗎？'],
  };
  const doc = { rev: 0, lives: 6, rows: [], surface: '', bottom: '', ask: '', want: false };

  const $ = id => document.getElementById(id);
  const qlist = $('qlist'), bulbs = $('bulbs'), tally = $('tally'), count = $('count'),
        leftNum = $('left'), ghost = $('ghost'),
        stash = $('stash'), surface = $('surface'), bottom = $('bottom'),
        veil = $('veil'), ctitle = $('ctitle'), ctext = $('ctext'), cacts = $('cacts');

  const pad = n => String(n).padStart(2, '0');
  // 用掉生命的條件：問了問題或收到回答。只寫註解不算。
  const alive = r => !!(r && (r.q.trim() || r.a));
  // 有任何內容（含註解），用來判斷收起來的列是否還存著東西。
  const hasAny = r => !!(r && (r.q.trim() || r.a || r.n.trim()));

  function row(i) {
    while (doc.rows.length <= i) doc.rows.push({ q: '', a: '', n: '' });
    return doc.rows[i];
  }
  function used() {
    let n = 0;
    for (let i = 0; i < doc.lives; i++) if (alive(doc.rows[i])) n++;
    return n;
  }
  // 遠端更新不能蓋掉正在打字的欄位，否則字會被吃掉、游標會跳。
  // 例外是清空與還原：那是全房一起重設，連正在打字的欄位也要跟著換掉。
  function put(el, v, force) {
    if (el && (force || document.activeElement !== el)) el.value = v;
  }

  /* ── 列的 DOM：增減用 ensureRows，內容用 paintRow，不整批重建 ── */

  function makeRow(i) {
    const li = document.createElement('li');
    li.className = 'qrow';
    li.dataset.i = i;

    const num = document.createElement('span');
    num.className = 'qnum';
    num.textContent = pad(i + 1);

    const q = document.createElement('textarea');
    q.className = 'qtext';
    q.rows = 1;
    q.maxLength = LIM.q;
    q.placeholder = '第 ' + (i + 1) + ' 個問題…';
    q.setAttribute('aria-label', '第 ' + (i + 1) + ' 個問題');

    const sel = makePick(i);

    const n = document.createElement('textarea');
    n.className = 'qnote';
    n.rows = 1;
    n.maxLength = LIM.n;
    n.placeholder = '註解';
    n.setAttribute('aria-label', '第 ' + (i + 1) + ' 題的註解');

    li.append(num, q, sel, n);
    return li;
  }

  function ensureRows() {
    while (qlist.children.length < doc.lives) qlist.appendChild(makeRow(qlist.children.length));
    while (qlist.children.length > doc.lives) qlist.removeChild(qlist.lastChild);
    if (openPick && !qlist.contains(openPick)) openPick = null;   // 那一列被收掉了
  }

  /* ── 回答選單 ──────────────────────
     原生 <select> 的下拉是作業系統畫的，字體與配色都套不進來，所以自己做一個。
     值仍然只有 '' / T / F / I；焦點永遠留在按鈕上，游標所在的項目用
     aria-activedescendant 指過去 —— listbox 的標準作法，讀螢幕的人才跟得上。 */

  const ANSWERS = [['', '— 未答'], ['T', 'T 是'], ['F', 'F 否'], ['I', 'I 無關']];
  const label = v => (ANSWERS.find(a => a[0] === v) || ANSWERS[0])[1];
  let openPick = null;

  function makePick(i) {
    const wrap = document.createElement('span');
    wrap.className = 'pick';
    wrap.dataset.a = '';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pick-btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', '第 ' + (i + 1) + ' 題的回答');
    btn.textContent = label('');

    const menu = document.createElement('ul');
    menu.className = 'pick-menu';
    menu.setAttribute('role', 'listbox');
    menu.hidden = true;
    ANSWERS.forEach(([v, t]) => {
      const opt = document.createElement('li');
      opt.className = 'pick-opt';
      opt.id = 'a' + i + (v || 'x');
      opt.setAttribute('role', 'option');
      opt.setAttribute('aria-selected', v === '' ? 'true' : 'false');
      opt.dataset.v = v;
      opt.textContent = t;
      menu.appendChild(opt);
    });

    wrap.append(btn, menu);
    return wrap;
  }

  function paintPick(li, v) {
    const wrap = li.querySelector('.pick');
    if (!wrap) return;
    wrap.dataset.a = v;
    wrap.querySelector('.pick-btn').textContent = label(v);
    for (const opt of wrap.querySelectorAll('.pick-opt'))
      opt.setAttribute('aria-selected', String(opt.dataset.v === v));
  }

  // 游標停在哪一項。焦點不搬家，只換記號。
  function mark(wrap, v) {
    let cur = null;
    for (const opt of wrap.querySelectorAll('.pick-opt')) {
      const on = opt.dataset.v === v;
      opt.classList.toggle('on', on);
      if (on) cur = opt;
    }
    if (cur) wrap.querySelector('.pick-btn').setAttribute('aria-activedescendant', cur.id);
  }
  function marked(wrap) {
    const on = wrap.querySelector('.pick-opt.on');
    return on ? on.dataset.v : wrap.dataset.a;
  }

  function openMenu(wrap) {
    if (openPick && openPick !== wrap) closeMenu();
    openPick = wrap;
    const menu = wrap.querySelector('.pick-menu');
    menu.hidden = false;
    wrap.dataset.open = '1';
    wrap.querySelector('.pick-btn').setAttribute('aria-expanded', 'true');
    // 靠近視窗底部就往上開，不然清單會掉到看不見的地方
    const box = wrap.getBoundingClientRect();
    wrap.classList.toggle('up',
      box.bottom + menu.offsetHeight + 10 > innerHeight && box.top > menu.offsetHeight + 10);
    mark(wrap, wrap.dataset.a);
  }

  function closeMenu() {
    if (!openPick) return;
    const wrap = openPick;
    openPick = null;
    wrap.querySelector('.pick-menu').hidden = true;
    delete wrap.dataset.open;
    wrap.classList.remove('up');
    const btn = wrap.querySelector('.pick-btn');
    btn.setAttribute('aria-expanded', 'false');
    btn.removeAttribute('aria-activedescendant');
  }

  function answer(li, v) {
    const i = Number(li.dataset.i), r = row(i);
    paintPick(li, v);
    if (r.a === v) return;
    r.a = v;
    li.classList.toggle('filled', alive(r));
    queue('rows.' + i + '.a', r.a);
    drawStatus();
  }

  qlist.addEventListener('click', e => {
    const btn = e.target.closest('.pick-btn');
    if (btn) {
      const wrap = btn.parentNode;
      if (openPick === wrap) closeMenu(); else openMenu(wrap);
      return;
    }
    const opt = e.target.closest('.pick-opt');
    if (!opt) return;
    const wrap = opt.closest('.pick');
    answer(opt.closest('.qrow'), opt.dataset.v);
    closeMenu();
    wrap.querySelector('.pick-btn').focus();
  });

  qlist.addEventListener('keydown', e => {
    const wrap = e.target.closest && e.target.closest('.pick');
    if (!wrap) return;
    const open = openPick === wrap;
    const key = e.key;

    if (key === 'Escape') { if (open) { e.preventDefault(); closeMenu(); } return; }
    if (key === 'Tab') { closeMenu(); return; }
    if (key === 'Enter' || key === ' ') {
      e.preventDefault();
      if (open) { answer(wrap.closest('.qrow'), marked(wrap)); closeMenu(); }
      else openMenu(wrap);
      return;
    }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { openMenu(wrap); return; }
      const at = ANSWERS.findIndex(a => a[0] === marked(wrap));
      const to = (at + (key === 'ArrowDown' ? 1 : ANSWERS.length - 1) + ANSWERS.length) % ANSWERS.length;
      mark(wrap, ANSWERS[to][0]);
      return;
    }
    // 主持一局要按很多次，所以 T / F / I 直接就是答案，0 或退格是收回
    const k = key.length === 1 ? key.toUpperCase() : key;
    if (k === 'T' || k === 'F' || k === 'I' || k === '0' || k === 'Backspace' || k === 'Delete') {
      e.preventDefault();
      answer(wrap.closest('.qrow'), 'TFI'.indexOf(k) >= 0 ? k : '');
      closeMenu();
    }
  });

  // 點到別處就收起來。按鈕本身的點擊在上面處理完了，這裡看的是選單以外的點擊。
  document.addEventListener('click', e => {
    if (openPick && !openPick.contains(e.target)) closeMenu();
  });

  function paintRow(i, force) {
    const li = qlist.children[i];
    if (!li) return;
    const r = row(i);
    const q = li.querySelector('.qtext'), n = li.querySelector('.qnote');
    put(q, r.q, force);
    put(n, r.n, force);
    // 選單開著就別重畫：那等於使用者正在挑答案
    if (force || li.querySelector('.pick') !== openPick) paintPick(li, r.a);
    li.classList.toggle('filled', alive(r));
    grow(q); grow(n);
  }

  /* ── 輸入框跟著內容長高 ──────────────
     長問題要看得到全文，短問題不該佔一整塊，所以高度由內容決定。
     寫的是 min-height 不是 height：湯底那格還要能被 flex:1 撐滿右欄。 */

  // 量一次就強迫瀏覽器重排一次，300 列時很傷，所以內容沒變就不重量。
  const measured = new WeakMap();
  const floor = new WeakMap();
  let epoch = 0;   // 視窗寬度變了，換行位置就變了，之前量的一律作廢

  function grow(el) {
    if (!el) return;
    const key = epoch + '|' + el.value;
    if (measured.get(el) === key) return;
    measured.set(el, key);
    if (!floor.has(el)) floor.set(el, parseFloat(getComputedStyle(el).minHeight) || 0);

    const st = el.style;
    st.minHeight = '0px';
    st.height = 'auto';
    // 不先解掉 flex:1 與 grid 的 stretch，量到的會是被撐開的高度，而不是內容高度
    st.flex = '0 0 auto';
    st.alignSelf = 'start';
    const h = el.scrollHeight + el.offsetHeight - el.clientHeight;   // 加回上下框線
    st.alignSelf = '';
    st.flex = '';
    st.height = '';
    st.minHeight = Math.max(h, floor.get(el)) + 'px';
  }

  function growAll() {
    grow(surface); grow(bottom);
    for (const li of qlist.children) {
      grow(li.querySelector('.qtext'));
      grow(li.querySelector('.qnote'));
    }
  }

  // 盯的是版面寬度而不是視窗：內容一長，捲軸就出現，可用寬度少掉十幾像素、
  // 換行位置整個變掉，而捲軸的出現並不會觸發 resize。不重量的話舊的高度就會切掉字。
  let lastW = 0, refitting = false;
  function refit() {
    if (refitting) return;
    refitting = true;
    requestAnimationFrame(() => {
      refitting = false;
      const w = document.documentElement.clientWidth;
      if (w === lastW) return;
      lastW = w;
      epoch++;
      growAll();
    });
  }
  window.addEventListener('resize', refit);
  if (window.ResizeObserver) new ResizeObserver(refit).observe(document.documentElement);
  // 字體是後來才載入的，載入前量到的是備援字體的高度
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { epoch++; growAll(); sizeCount(); });
  }

  const HEART = 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 '
              + '3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 '
              + '6.86-8.55 11.54L12 21.35z';

  let announced = false;

  // 分母是輸入框，沒在編輯時要跟純文字分不出來，所以寬度得剛好等於那幾個數字。
  // 用一個同樣字體、同樣字距的隱形分身去量，才不會被字距或字體換行為影響。
  function sizeCount() {
    ghost.textContent = count.value || '0';
    count.style.width = ghost.getBoundingClientRect().width + 'px';
  }

  function drawStatus() {
    const u = used(), left = doc.lives - u;
    put(count, String(doc.lives));
    sizeCount();
    $('minus').disabled = doc.lives <= LIM.livesMin;
    $('plus').disabled = doc.lives >= LIM.livesMax;

    bulbs.textContent = '';
    for (let i = 0; i < doc.lives; i++) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('class', 'bulb' + (i < u ? ' spent' : (left === 1 ? ' last' : '')));
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', HEART);
      svg.appendChild(p);
      bulbs.appendChild(svg);
    }

    // 這一段不重建，分母的輸入框正在裡面，重建會把游標踢掉
    tally.className = 'tally' + (left === 0 ? ' out' : '');
    leftNum.textContent = String(left);

    const hidden = doc.rows.slice(doc.lives).filter(hasAny).length;
    stash.textContent = hidden ? '另有 ' + hidden + ' 列被收起，內容還在，加回生命就會出現。' : '';

    // 正在輸入生命數時先不打斷，等離開欄位、數字確定了再提示
    if (left === 0 && !announced && document.activeElement !== count) { announced = true; outOfLives(); }
    if (left > 0) announced = false;
  }

  function render(force) {
    for (let i = 0; i < doc.lives; i++) row(i);
    ensureRows();
    for (let i = 0; i < doc.lives; i++) paintRow(i, force);
    put(surface, doc.surface, force);
    put(bottom, doc.bottom, force);
    grow(surface); grow(bottom);
    drawStatus();
  }

  /* ── 連線 ────────────────────────── */

  // 房號就是網址後綴。沒帶或格式不合的，伺服器已經先 302 到一個新房號了。
  const ROOM_RE = /^[\p{L}\p{N}\p{M}_-]{2,64}$/u;
  let RID = '';
  try { RID = decodeURIComponent(location.pathname.slice(1)).normalize('NFC'); } catch { RID = ''; }
  let ws = null, backoff = 1000, everOpen = false, dead = false, tries = 0;

  function connect() {
    if (dead) return;
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://')
      + location.host + '/ws?r=' + encodeURIComponent(RID));

    tries++;
    ws.onopen = () => { everOpen = true; tries = 0; backoff = 1000; flush(); };
    ws.onmessage = e => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      handle(m);
    };
    ws.onclose = () => {
      // 從沒連上過就連續失敗：多半是開房次數達上限或服務異常，別無限重試
      if (!everOpen && tries >= 3) {
        return fatal('連不上這個房間',
          '可能是短時間內開了太多房而被限流，或服務暫時異常。稍後重新整理，或換一個已經存在的房號。');
      }
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 15000);
    };
    ws.onerror = () => { /* 收尾一律交給 onclose */ };
  }

  function handle(m) {
    if (m.t === 'sync') {
      // hollow＝伺服器休眠醒來、手上是空的。手上有內容就別讓空文件蓋掉，反過來餵回去。
      if (m.hollow && hasContent(doc)) { sendSeed(); return; }
      doc.rev = m.doc.rev;
      doc.lives = m.doc.lives;
      doc.rows = m.doc.rows.map(r => ({ q: r.q, a: r.a, n: r.n }));
      doc.surface = m.doc.surface;
      doc.bottom = m.doc.bottom;
      doc.ask = OFFER[m.doc.ask] ? m.doc.ask : '';
      doc.want = m.doc.want === true;
      // why = wipe：全房重設，正在打字的欄位也一併覆蓋
      render(!!m.why);
      if (m.why) { pending.clear(); inflight.clear(); }
      else replay();   // 這份全量可能沒帶到我們剛送出、卻被空窗期丟掉的那幾筆
      keep();
      offerReveal();   // 中途進房、或重整回來，該問的還是要問
      return;
    }
    if (m.t === 'need') { sendSeed(); return; }
    if (m.t === 'patch') {
      // rev 不連續代表漏了訊息，別自己猜，直接要一份全量
      if (m.rev !== doc.rev + 1) { send({ t: 'resync' }); return; }
      doc.rev = m.rev;
      applyOps(m.ops);
      keep();
      return;
    }
    if (m.t === 'err') { onErr(m.code); return; }
  }

  /* ── 伺服器不落地，所以這一份鏡像就是備份 ── */

  function hasContent(d) {
    return !!(d && (d.surface || d.bottom || d.rows.some(r => r.q || r.a || r.n)));
  }

  // 只有伺服器說它空了才餵回去，所以不會拿舊內容去蓋掉新的
  function sendSeed() {
    const src = hasContent(doc) ? doc : backup;
    if (!hasContent(src)) return;
    if (send({ t: 'seed', doc: src })) flush();   // 順手補送斷線期間累積的修改
  }

  // 同一個分頁重整也救得回來。用 sessionStorage 而不是 localStorage：
  // 分頁關掉就跟著消失，不會拿隔夜的內容去汙染同名的新房間。
  const KEY = 'soup:' + RID;
  let keepTimer = null;
  function keep() {
    if (keepTimer) return;
    keepTimer = setTimeout(() => {
      keepTimer = null;
      try { sessionStorage.setItem(KEY, JSON.stringify(doc)); } catch { /* 滿了就算了 */ }
    }, 1000);
  }

  // 只當備援，不直接畫到畫面上 —— 畫面永遠以伺服器那份為準
  const backup = (() => {
    try {
      const d = JSON.parse(sessionStorage.getItem(KEY) || 'null');
      if (!d || !Array.isArray(d.rows) || !hasContent(d)) return null;
      return {
        rev: d.rev | 0,
        lives: d.lives,
        rows: d.rows.map(r => ({ q: r.q || '', a: r.a || '', n: r.n || '' })),
        surface: d.surface || '',
        bottom: d.bottom || '',
        ask: OFFER[d.ask] ? d.ask : '',
        want: d.want === true,
      };
    } catch { return null; }
  })();

  function applyOps(ops) {
    let structural = false, offer = false;
    for (const op of ops) {
      if (op.p === 'lives') { doc.lives = op.v; structural = true; continue; }
      if (op.p === 'surface') { doc.surface = op.v; put(surface, op.v); grow(surface); continue; }
      if (op.p === 'bottom') { doc.bottom = op.v; put(bottom, op.v); grow(bottom); continue; }
      if (op.p === 'ask') { doc.ask = op.v; offer = true; continue; }
      if (op.p === 'want') { doc.want = op.v; if (inflight.get(op.p) === op.v) inflight.delete(op.p); continue; }
      const m = /^rows\.(\d{1,3})\.(q|a|n)$/.exec(op.p);
      if (!m) continue;
      const i = Number(m[1]);
      row(i)[m[2]] = op.v;
      if (inflight.get(op.p) === op.v) inflight.delete(op.p);   // 回聲到了，這一筆確認送達
      if (m[2] === 'a' && op.v) offer = true;                   // 又答完一列，再問一次
      paintRow(i);
    }
    if (structural) render(); else drawStatus();
    if (offer) offerReveal();
  }

  // 同一種錯誤 60 秒內只提示一次，否則邊打字邊彈視窗會沒完沒了
  const shown = new Map();
  function once(code, fn) {
    const now = Date.now();
    if (shown.get(code) > now - 60000) return;
    shown.set(code, now);
    fn();
  }

  function onErr(code) {
    if (code === 'rate_limited') return;                        // 客戶端已 debounce，偶發即可忽略
    if (code === 'locked') {
      return once(code, () => note('這一鍋被鎖住了',
        '目前是唯讀狀態，改不動了。看得到的內容還是最新的。'));
    }
    if (code === 'frozen') {
      return once(code, () => note('暫停服務中', '服務目前停止寫入，請稍後再試。'));
    }
    if (code === 'doc_too_big' || code === 'too_many_rows') {
      return once(code, () => note('這鍋湯已經到上限了', '伺服器拒絕了剛才的修改，請先精簡內容。'));
    }
    once(code, () => note('這一筆沒存進去',
      '伺服器退回了剛才的修改（' + code + '）。重新整理可取得最新內容。'));
  }

  /* ── 送出：合併同一欄位的連續輸入，350ms 一批 ── */

  const pending = new Map();
  let timer = null;

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(msg)); return true; }
    return false;
  }
  function queue(p, v) {
    pending.set(p, v);
    if (!timer) timer = setTimeout(flush, 350);
    keep();
  }
  // 送出去但還沒被伺服器回聲確認的操作。
  // 伺服器在「休眠醒來、等人補文件」的空窗期會默默丟掉 patch（見 worker/room.js），
  // 所以送出不等於送到。確認前先留著，收到全量 sync 時重送。
  const inflight = new Map();

  function flush() {
    timer = null;
    if (!pending.size) return;
    const ops = [...pending].map(([p, v]) => ({ p, v }));
    if (!send({ t: 'patch', ops })) return;   // 斷線時留在 pending，重連的 onopen 會再送
    for (const [p, v] of pending) inflight.set(p, v);
    pending.clear();
  }

  /** 全量 sync 之後，把還沒被確認的修改補回去 —— 沒補的話那幾筆就真的消失了。 */
  function replay() {
    if (!inflight.size) return;
    for (const [p, v] of inflight) if (!pending.has(p)) pending.set(p, v);
    inflight.clear();
    if (!timer) timer = setTimeout(flush, 50);
  }

  /* ── 本地編輯 ────────────────────── */

  // 提問與註解邊打邊送的話，主持機器人會抓到打到一半的句子就作答 —— 實測就是這樣壞的。
  // 所以未送出的文字**只留在 DOM 裡**，連 doc 都不寫：doc 會經由 sendSeed（房間醒來
  // 要一份回去）與 sessionStorage 備份流出去，寫進 doc 等於還是漏了半句話出去。
  qlist.addEventListener('input', e => {
    const li = e.target.closest('.qrow');
    if (!li) return;
    if (!e.target.classList.contains('qtext') && !e.target.classList.contains('qnote')) return;
    grow(e.target);
    const r = row(Number(li.dataset.i));
    const typing = li.querySelector('.qtext').value;
    li.classList.toggle('filled', !!(typing.trim() || r.a));
  });

  // 離開輸入框才把文字寫進 doc 並送出。到這一刻為止，這一列對房間與機器人都不存在。
  qlist.addEventListener('focusout', e => {
    const li = e.target.closest && e.target.closest('.qrow');
    if (!li) return;
    const i = Number(li.dataset.i), r = row(i);
    if (e.target.classList.contains('qtext')) {
      if (r.q === e.target.value) return;
      r.q = e.target.value;
      queue('rows.' + i + '.q', r.q);
    } else if (e.target.classList.contains('qnote')) {
      if (r.n === e.target.value) return;
      r.n = e.target.value;
      queue('rows.' + i + '.n', r.n);
    } else return;
    li.classList.toggle('filled', alive(r));
    drawStatus();
  });

  // Enter 等於「我打完了」，不用真的把游標移開。
  qlist.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    if (!e.target.classList.contains('qtext') && !e.target.classList.contains('qnote')) return;
    e.preventDefault();
    e.target.blur();
  });

  surface.addEventListener('input', () => { grow(surface); doc.surface = surface.value; queue('surface', doc.surface); });
  bottom.addEventListener('input', () => { grow(bottom); doc.bottom = bottom.value; queue('bottom', doc.bottom); });

  function setLives(n) {
    const v = Math.min(LIM.livesMax, Math.max(LIM.livesMin, n));
    if (v === doc.lives) return;
    doc.lives = v;
    queue('lives', v);
    render();
  }
  // 上下鍵與鍵盤共用。欄位正在編輯時 put() 不會覆蓋它，所以這裡要自己補上
  // 值與寬度，不然 9 加到 10 時分母只有一位數寬，第二位就看不見了。
  function bump(d) {
    setLives(doc.lives + d);
    count.value = String(doc.lives);
    sizeCount();
  }
  $('minus').onclick = () => bump(-1);
  $('plus').onclick = () => bump(1);

  count.addEventListener('input', () => {
    const digits = count.value.replace(/\D/g, '');
    if (digits !== count.value) count.value = digits;
    sizeCount();
    const n = parseInt(digits, 10);
    // 打到一半的數字（空的、0、超出上限）先不動，等離開欄位再收斂
    if (!isNaN(n) && n >= LIM.livesMin && n <= LIM.livesMax) setLives(n);
  });
  count.addEventListener('blur', () => {
    const n = parseInt(count.value, 10);
    if (!isNaN(n)) setLives(n);
    count.value = String(doc.lives);
    sizeCount();
    drawStatus();   // 離開欄位才判斷生命是否已經用光
  });
  count.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); count.blur(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); bump(1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); bump(-1); }
  });
  count.addEventListener('focus', () => count.select());

  /* ── 提示視窗 ────────────────────── */

  let lastFocus = null;
  let owedOffer = false;      // 被別的視窗擋掉的揭底提議，等它關掉再跳
  function ask(title, text, actions, locked) {
    lastFocus = document.activeElement;
    ctitle.textContent = title;
    ctext.textContent = text;
    cacts.textContent = '';
    veil.dataset.locked = locked ? '1' : '';
    actions.forEach(a => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = a.label;
      if (a.danger) btn.className = 'danger';
      btn.onclick = () => { close(); a.run && a.run(); };
      cacts.appendChild(btn);
    });
    veil.classList.add('open');
    if (cacts.firstChild) cacts.firstChild.focus();
  }
  function close() {
    if (veil.dataset.locked) return;
    veil.classList.remove('open');
    if (lastFocus) lastFocus.focus();
    // 剛才被這個視窗擋掉的提議，現在補跳。關掉提議本身時 owedOffer 是 false，不會打轉。
    if (owedOffer) offerReveal();
  }
  veil.addEventListener('click', e => { if (e.target === veil) close(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && veil.classList.contains('open')) close();
  });

  const note = (t, x) => ask(t, x, [{ label: '知道了' }]);
  function fatal(t, x) { dead = true; if (ws) ws.close(); ask(t, x, [], true); }

  /* 主持人認定玩家夠近了就會把 ask 點亮，然後每答完一列再問一次 ——
     選了「繼續玩」也不會關掉它，是刻意的：想揭的時候不必去找按鈕，
     畫面上也就不必為了這件事多長出一顆常駐按鈕來。

     兩句文案分開，是因為它們對玩家的意思不同：near 是「還差一格」，full 是「全解了」。
     只寫一句的話，差一格的人會以為自己全中，被揭出沒想到的那塊時只覺得被暴雷。
     文案寫死在這裡，房間文件只帶 near / full 兩個字面值。

     湯底不在伺服器上，所以這裡按下去只是把 want 寫進房間；真正把湯底寫回來的是
     主持人那一端（tools/host.mjs 的 wait 收到 want 就揭）。按下去到湯底出現會差幾秒。 */
  function offerReveal() {
    const copy = OFFER[doc.ask];
    if (!copy || doc.want) return;
    // 已經有別的視窗開著就先不蓋掉，但要記住這一次欠著 —— 那個視窗關掉時補跳。
    // 少了這個補跳，回答剛好在視窗開著時送達的話，那一列的提議就永遠消失了。
    if (veil.classList.contains('open')) { owedOffer = true; return; }
    owedOffer = false;
    ask(copy[0], copy[1], [
      { label: '揭曉湯底', run: () => { doc.want = true; queue('want', true); } },
      { label: '繼續玩' },
    ]);
  }

  function outOfLives() {
    ask('燈全滅了', '生命已經用完。', [
      { label: '加開一條生命', run: () => setLives(doc.lives + 1) },
      { label: '知道了' },
    ]);
  }

  $('wipe').onclick = () => {
    const n = used();
    ask('要清空整鍋湯嗎',
      '湯麵、湯底' + (n ? '和 ' + n + ' 則提問' : '') + '都會消失，房內所有人都會被清空。',
      [
        { label: '全部清空', danger: true, run: () => send({ t: 'wipe' }) },
        { label: '留著' },
      ]);
  };

  render();
  if (ROOM_RE.test(RID)) {
    connect();
  } else {
    // 正常走不到這裡（伺服器會先導向）；直接讓伺服器發一個新房號
    location.replace('/');
  }
})();
