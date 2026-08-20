import { drainQueue } from './admin.js';

export { Room } from './room.js';
export { Limiter } from './limiter.js';

/* 路由
     /                → 302 到一個隨機房號（即開即用，沒有入口畫面）
     /<房號>          → 回 index.html
     /ws?r=<房號>     → WebSocket；房間不存在就當場開，但要過開房限流
     /app.css 等      → 靜態檔

   房號可讀可寫可猜：使用者自己打的短房號等於公開，這是「直接輸入網址就能用」的代價。
   預設產生的房號是 128 bit 隨機，不可枚舉。 */

// 房號允許中日文等文字、數字、_ 與 -。刻意不含 . / % ? #，
// 才不會跟靜態檔路徑或編碼變形混在一起。
const ID = /^[\p{L}\p{N}\p{M}_-]{2,64}$/u;
const norm = s => s.normalize('NFC');   // 同一個字的不同編碼要算同一間房
const RESERVED = new Set(['ws', 'api', 'font']);   // 不含 . 的保留字，不能當房號

const SEC = {
  'content-security-policy': [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",       // 同源 wss:// 由 'self' 涵蓋
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'referrer-policy': 'no-referrer',            // 房號就在路徑上，別讓它跟著外連跑
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'geolocation=(), camera=(), microphone=(), payment=()',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-robots-tag': 'noindex, nofollow',         // 移除垃圾內容的 SEO 動機
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    let seg;
    try { seg = norm(decodeURIComponent(url.pathname.slice(1))); }
    catch { return toNewRoom(); }   // 壞掉的百分號編碼

    if (url.pathname === '/ws') {
      if (!sameOrigin(req, url)) return fail(403, 'origin');
      return openWs(req, env, url);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, 'method');

    // 靜態檔一律含 . 或 /（房號的字元集刻意不含這兩個），所以路徑歸屬不會互相搶
    if (seg.includes('.') || seg.includes('/') || RESERVED.has(seg)) return assets(req, env);

    // 沒給房號、或房號格式不合，就發一個新的給他
    if (!ID.test(seg)) return toNewRoom();

    // 房號路徑一律回同一份 index.html。注意這裡不建房，
    // 爬蟲掃路徑不會在儲存體留下任何東西。
    return page(req, env, url);
  },

  // 管理指令唯一的執行時機。對外沒有任何路由，所以沒有東西可以被攻擊。
  async scheduled(event, env) {
    await drainQueue(env);
  },
};

/* ── 房號 ─────────────────────────── */

function newId() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toNewRoom() {
  return new Response(null, {
    status: 302,
    headers: { ...SEC, location: '/' + newId(), 'cache-control': 'no-store' },
  });
}

/* ── 連線 ─────────────────────────── */

async function openWs(req, env, url) {
  if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return fail(426, 'upgrade');

  const id = norm(url.searchParams.get('r') || '');
  if (!ID.test(id) || RESERVED.has(id)) return fail(400, 'bad_room');

  const room = env.ROOM.get(env.ROOM.idFromName(id));
  const q = '&name=' + encodeURIComponent(id);   // DO 自己不知道房號，鎖房要用

  // 第一趟只問「房間在不在」，不會建立任何東西
  const res = await room.fetch('https://room/ws?probe=1' + q, { headers: { Upgrade: 'websocket' } });
  if (res.status !== 404 || res.headers.get('X-Room-Missing') !== '1') return res;

  // 開新房才動用限流：這是唯一會增加儲存體用量的路徑。
  // 全站凍結時也擋在這裡 —— 凍結只停寫入，但也該停止長出新房間。
  if (await frozen(env)) return fail(503, 'frozen');
  if (!(await allowCreate(req, env))) return fail(429, 'create_rate_limited');

  return room.fetch('https://room/ws?create=1' + q, { headers: { Upgrade: 'websocket' } });
}

async function allowCreate(req, env) {
  const ip = req.headers.get('CF-Connecting-IP') || '0.0.0.0';
  const gate = env.LIMITER.get(env.LIMITER.idFromName('ip:' + await hash(ip)));
  const res = await gate.fetch('https://limiter/');
  return res.ok;
}

/* ── 靜態檔 ───────────────────────── */

function page(req, env, url) {
  const rewritten = new Request(new URL('/index.html', url), req);
  return assets(rewritten, env);
}

async function assets(req, env) {
  const res = await env.ASSETS.fetch(req);
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SEC)) out.headers.set(k, v);
  return out;
}

/* ── 雜項 ─────────────────────────── */

// WebSocket 不受 CORS 保護，Origin 檢查是唯一能阻止其他站台驅動這個後端的手段。
function sameOrigin(req, url) {
  const origin = req.headers.get('Origin');
  if (!origin) return false;
  try { return new URL(origin).host === url.host; } catch { return false; }
}

async function frozen(env) {
  if (!env.CTRL) return false;
  return (await env.CTRL.get('frozen', { cacheTtl: 60 })) === '1';
}

// IP 只用來限流，不落長期紀錄，所以先雜湊再當 DO 名稱
async function hash(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
}

function fail(status, error) {
  return Response.json({ error }, { status, headers: SEC });
}
