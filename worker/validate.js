/* 唯一的真相在這裡：所有上限與清理規則都由伺服器決定，前端只是先行檢查。 */

export const LIM = {
  livesMin: 1,
  livesMax: 300,
  rows: 300,          // 列數硬上限，與前端 stepper 無關
  q: 300,             // 提問字數（code point）
  n: 200,             // 註解字數
  surface: 2000,      // 湯麵字數
  bottom: 4000,       // 湯底字數
  ops: 64,            // 單筆 patch 最多幾個操作
  docBytes: 256 * 1024,
  msgBytes: 8 * 1024,
  peers: 32,          // 單房同時連線數
};

const PATH = /^(?:lives|surface|bottom|ask|want|rows\.(\d{1,3})\.(q|a|n))$/;

// 保留 \t \n，其餘控制字元、零寬字元、雙向控制字元一律移除。
// 這不是 XSS 防線（XSS 靠「遠端字串永不進 innerHTML」擋），只是避免不可見字元汙染文件。
const JUNK = new RegExp(
  '[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f' +
  '\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060-\\u2064' +
  '\\u2066-\\u2069\\ufeff\\ufff9-\\ufffb]',
  'g'
);

const enc = new TextEncoder();
const chars = s => [...s].length;

export function newDoc() {
  return { rev: 0, lives: 6, rows: [], surface: '', bottom: '', ask: '', want: false, updatedAt: Date.now() };
}

function text(v, max, singleLine) {
  if (typeof v !== 'string') return null;
  let s = v.replace(/\r\n?/g, '\n').replace(JUNK, '').normalize('NFC');
  if (singleLine) s = s.replace(/\n/g, ' ');
  return chars(s) > max ? null : s;
}

function field(path, v) {
  if (path === 'lives') {
    if (typeof v !== 'number' || !Number.isInteger(v)) return null;
    if (v < LIM.livesMin || v > LIM.livesMax) return null;
    return v;
  }
  if (path === 'surface') return text(v, LIM.surface, false);
  if (path === 'bottom') return text(v, LIM.bottom, false);
  if (path === 'q') return text(v, LIM.q, true);
  if (path === 'n') return text(v, LIM.n, true);
  if (path === 'a') return (v === '' || v === 'T' || v === 'F' || v === 'I') ? v : null;

  // 揭底提議（ask，主持人寫）只收兩個字面值：near＝只差一格，full＝全部解開。
  // 前端照這兩個值挑寫死的文案，所以這個欄位帶得動的東西就只有這兩種狀態，
  // 主持人寫不進任何自由文字。
  //
  // 收不到空字串，所以提議一旦亮起就熄不掉。這是刻意的 ——「亮了又熄」會透露
  // 剛才那一題問錯了方向，而那是這個通道不該帶的訊息。
  if (path === 'ask') return (v === 'near' || v === 'full') ? v : null;

  // 揭底請求（want，玩家寫）同理，只收 true。
  if (path === 'want') return v === true ? true : null;

  return null;
}

function grow(rows, i) {
  while (rows.length <= i) rows.push({ q: '', a: '', n: '' });
  return rows[i];
}

/**
 * 在複本上套用 patch。任何一個操作不合格就整筆退回 —— 不做部分套用，
 * 免得客戶端與伺服器對「現在是什麼狀態」有不同的理解。
 * @returns {{doc,ops}|{err:string}}
 */
export function applyPatch(prev, ops) {
  if (!Array.isArray(ops) || ops.length === 0) return { err: 'bad_ops' };
  if (ops.length > LIM.ops) return { err: 'too_many_ops' };

  const doc = {
    rev: prev.rev,
    lives: prev.lives,
    rows: prev.rows.map(r => ({ q: r.q, a: r.a, n: r.n })),
    surface: prev.surface,
    bottom: prev.bottom,
    ask: prev.ask === 'near' || prev.ask === 'full' ? prev.ask : '',
    want: prev.want === true,
    updatedAt: prev.updatedAt,
  };
  const clean = [];

  for (const op of ops) {
    if (!op || typeof op !== 'object' || typeof op.p !== 'string') return { err: 'bad_op' };
    const m = PATH.exec(op.p);
    if (!m) return { err: 'bad_path' };

    if (m[1] === undefined) {
      const v = field(op.p, op.v);
      if (v === null) return { err: 'bad_value:' + op.p };
      // 提議只准往上升級。玩家解開的格子只增不減，所以退回 near 只可能是寫錯，
      // 而它在畫面上的意思是「你其實還差一格」—— 那會把已經給出的答覆收回去。
      if (op.p === 'ask' && doc.ask === 'full' && v === 'near') return { err: 'bad_value:ask' };
      doc[op.p] = v;
      clean.push({ p: op.p, v });
    } else {
      const i = Number(m[1]);
      if (i >= LIM.rows) return { err: 'row_out_of_range' };
      const v = field(m[2], op.v);
      if (v === null) return { err: 'bad_value:' + op.p };
      grow(doc.rows, i)[m[2]] = v;
      clean.push({ p: op.p, v });
    }
  }

  if (doc.rows.length > LIM.rows) return { err: 'too_many_rows' };
  if (enc.encode(JSON.stringify(doc)).length > LIM.docBytes) return { err: 'doc_too_big' };

  doc.rev = prev.rev + 1;
  doc.updatedAt = Date.now();
  return { doc, ops: clean };
}

/** 清空：保留生命數，其餘歸零。 */
export function wipeDoc(prev) {
  return { rev: prev.rev + 1, lives: prev.lives, rows: [], surface: '', bottom: '', ask: '', want: false, updatedAt: Date.now() };
}

/** 這份文件裡有東西嗎？用來判斷該不該拿客戶端那份來補。 */
export function hasContent(doc) {
  if (!doc) return false;
  if (doc.surface || doc.bottom) return true;
  return Array.isArray(doc.rows) && doc.rows.some(r => r && (r.q || r.a || r.n));
}

/**
 * 檢查客戶端送回來的整份文件（re-seed）。
 * 客戶端是不可信的，所以走的是跟 patch 完全同一套欄位規則與上限。
 * @returns 清理過的文件，或 null（不合格就整份丟掉）
 */
export function sanitizeDoc(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.rows)) return null;
  if (raw.rows.length > LIM.rows) return null;

  const lives = field('lives', raw.lives);
  const surface = field('surface', raw.surface);
  const bottom = field('bottom', raw.bottom);
  if (lives === null || surface === null || bottom === null) return null;

  const rows = [];
  for (const r of raw.rows) {
    if (!r || typeof r !== 'object') return null;
    const q = field('q', r.q), a = field('a', r.a), n = field('n', r.n);
    if (q === null || a === null || n === null) return null;
    rows.push({ q, a, n });
  }

  const rev = Number.isInteger(raw.rev) && raw.rev >= 0 && raw.rev < 1e9 ? raw.rev : 0;
  // 補文件只發生在伺服器手上是空的時候，所以這裡照收客戶端的旗標 ——
  // 沒有舊值會被它蓋掉，單向鎖定不受影響。
  const ask = raw.ask === 'near' || raw.ask === 'full' ? raw.ask : '';
  const doc = { rev, lives, rows, surface, bottom, ask, want: raw.want === true, updatedAt: Date.now() };
  if (enc.encode(JSON.stringify(doc)).length > LIM.docBytes) return null;
  return doc;
}
