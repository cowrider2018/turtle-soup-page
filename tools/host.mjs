#!/usr/bin/env node
/* 海龜湯 · 本機主持人 CLI
 *
 * 這支程式只做傳輸：連上房間、讀文件、寫回答。它不呼叫任何 LLM，
 * 判斷交給跑在本機的 Claude Code —— 房間的 Worker 因此完全不用改，
 * 也不會多出一個 runtime 的 AI 呼叫路徑。
 *
 * 用法：
 *   npm run host -- init <房號> --soup <湯底檔>
 *   npm run host -- wait <房號> [--timeout 540]
 *   npm run host -- answer <房號> <列號> <T|F|I> [--note "…"] --soup <湯底檔>
 *   npm run host -- reveal <房號> <房號> --soup <湯底檔>
 *
 *   --host <網址>   目標站台，預設 http://127.0.0.1:8787（wrangler dev），
 *                   也可以用環境變數 SOUP_HOST。
 *
 * 湯底檔是 JSON：{ "surface": "湯麵", "bottom": "湯底", "lives": 6 }
 * 湯底只留在本機，除了 reveal 之外絕不寫進房間 —— 房裡的文件所有人都讀得到。
 *
 * 防注入的紅線在這支程式，不在提示詞裡：
 *   1. 回答只接受 T / F / I，且不可為空。被劫持的模型能洩漏的上限就是每題 log2(3) bit。
 *   2. 註解只在玩家自己開口要提示的那一列才寫得進去。
 *   3. 註解送出前跟湯底做 n-gram 比對，重疊就整筆退回。
 *   4. 揭曉湯底是獨立指令、房號要打兩次，不放進主持迴圈。
 */

import { readFileSync } from 'node:fs';

/* ── 參數 ─────────────────────────── */

const argv = process.argv.slice(2);

function flag(name, fallback) {
  const i = argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) die('--' + name + ' 後面要接一個值');
  return v;
}
const positional = (() => {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { i++; continue; }   // 旗標一律吃掉後面那個值
    out.push(argv[i]);
  }
  return out;
})();

const [cmd, ...rest] = positional;
const BASE = flag('host', process.env.SOUP_HOST || 'http://127.0.0.1:8787');

const ID = /^[\p{L}\p{N}\p{M}_-]{2,64}$/u;
const ANS = new Set(['T', 'F', 'I']);
const NOTE_MAX = 200;        // 與 worker/validate.js 的 LIM.n 一致
const ROWS_MAX = 300;        // 與 LIM.rows 一致
const NGRAM = 6;             // 註解與湯底的連續重疊字數上限
const SEED_WAIT = 3500;      // 房間說自己是空的之後，等別人補一份回來的時間（略大於 DO 的 SEED_COOLDOWN）
const TAG = '🐢 ';           // 機器回答的識別前綴
// 玩家「主動明確要求提示」的判準。判斷放在程式裡而不是模型裡，
// 才不會被「玩家說他要提示」這種注入話術繞過。
const HINT = /提示|線索|hint|給點|給個|clue/i;

const chars = s => [...s].length;

function die(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

function room(v, what = '房號') {
  const s = String(v || '').normalize('NFC');
  if (!ID.test(s)) die(what + '格式不對（文字／數字／_／-，2 到 64 個字）：' + JSON.stringify(v || ''));
  return s;
}

/* ── 湯底檔 ───────────────────────── */

function loadSoup(required = true) {
  const path = flag('soup');
  if (!path) {
    if (!required) return null;
    die('要用 --soup 指定湯底檔');
  }
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch (e) { die('讀不到湯底檔 ' + path + '：' + e.message); }

  let soup;
  try { soup = JSON.parse(raw); }
  catch (e) { die('湯底檔不是合法 JSON：' + e.message); }

  const surface = String(soup?.surface || '').normalize('NFC');
  const bottom = String(soup?.bottom || '').normalize('NFC');
  if (!surface) die('湯底檔缺 surface（湯麵）');
  if (!bottom) die('湯底檔缺 bottom（湯底）');

  const lives = soup.lives === undefined ? 6 : soup.lives;
  if (!Number.isInteger(lives) || lives < 1 || lives > ROWS_MAX) die('lives 要是 1 到 ' + ROWS_MAX + ' 的整數');

  return { surface, bottom, lives };
}

// 比對前先把空白與標點拿掉：換個標點就繞過去的檢查沒有意義。
const bare = s => s.normalize('NFC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

/** 註解跟湯底有沒有 NGRAM 個字以上的連續重疊？有就是抄過去了。 */
function leaks(note, bottom) {
  const a = bare(note), b = bare(bottom);
  const xs = [...a];
  if (xs.length < NGRAM) return null;
  for (let i = 0; i + NGRAM <= xs.length; i++) {
    const win = xs.slice(i, i + NGRAM).join('');
    if (b.includes(win)) return win;
  }
  return null;
}

/* ── 連線 ─────────────────────────── */

function endpoints(name) {
  let u;
  try { u = new URL(BASE); }
  catch { return die('--host 不是合法網址：' + BASE); }
  const ws = new URL(u.href);
  ws.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  ws.pathname = '/ws';
  ws.search = '?r=' + encodeURIComponent(name);
  return { url: ws.href, origin: u.origin };
}

const EMPTY = () => ({ rev: 0, lives: 6, rows: [], surface: '', bottom: '' });

function grow(rows, i) {
  while (rows.length <= i) rows.push({ q: '', a: '', n: '' });
  return rows[i];
}

function hasContent(d) {
  return !!(d && (d.surface || d.bottom || d.rows.some(r => r.q || r.a || r.n)));
}

/**
 * 連上房間，拿到第一份 sync 之後才 resolve。
 * 回傳的物件把文件鏡像在 doc 裡，每收到一則訊息就呼叫一次 onChange。
 *
 * 注意：Worker 那邊只要房間不存在就會當場開房（見 worker/index.js 的 openWs），
 * 客戶端無從選擇，所以打錯房號等於開了一間空房 —— 沒人在線它就會自己消失。
 */
function connect(name) {
  const { url, origin } = endpoints(name);
  const doc = EMPTY();
  const listeners = [];

  return new Promise((resolve, reject) => {
    let ws, graced = false;
    try { ws = new WebSocket(url, { headers: { Origin: origin } }); }
    catch (e) { return reject(new Error('連線失敗：' + e.message)); }

    const session = {
      doc,
      on: fn => listeners.push(fn),
      send: m => ws.send(JSON.stringify(m)),
      close: () => { try { ws.close(1000); } catch { /* 已斷線 */ } },
    };

    const timer = setTimeout(() => {
      reject(new Error('連線逾時：' + url + '\n  站台起來了嗎？本機開發要先跑 npm run dev。'));
      session.close();
    }, 15000);

    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('連不上 ' + url
        + '\n  房間可能已滿或被鎖，或 --host 指錯了。目前指向 ' + BASE));
    });

    ws.addEventListener('close', ev => {
      clearTimeout(timer);
      for (const fn of listeners) fn({ t: 'closed', code: ev.code, reason: ev.reason });
    });

    ws.addEventListener('message', ev => {
      let m;
      try { m = JSON.parse(String(ev.data)); } catch { return; }

      if (m.t === 'sync') {
        Object.assign(doc, {
          rev: m.doc.rev, lives: m.doc.lives, surface: m.doc.surface, bottom: m.doc.bottom,
          rows: (m.doc.rows || []).map(r => ({ q: r.q || '', a: r.a || '', n: r.n || '' })),
        });
        // hollow＝房間剛醒來、手上是空的，正在跟其他人要一份回來。
        // 這時候的空文件不是真相，等補完的那一份，等不到才認了。
        // 少了這一段，wait 會回報「沒有問題」，answer 會以為那一列還沒人問。
        if (m.hollow && !graced) {
          graced = true;
          clearTimeout(timer);
          setTimeout(() => resolve(session), SEED_WAIT);
        } else {
          clearTimeout(timer);
          resolve(session);
        }
      } else if (m.t === 'patch') {
        doc.rev = m.rev;
        for (const op of m.ops) {
          if (op.p === 'lives' || op.p === 'surface' || op.p === 'bottom') { doc[op.p] = op.v; continue; }
          const g = /^rows\.(\d{1,3})\.(q|a|n)$/.exec(op.p);
          if (g) grow(doc.rows, Number(g[1]))[g[2]] = op.v;
        }
      } else if (m.t === 'need') {
        // 房間休眠後醒來，記憶體是空的。我們手上這份也是一份鏡像，順手補回去。
        if (hasContent(doc)) session.send({ t: 'seed', doc });
      }

      for (const fn of listeners) fn(m);
    });
  });
}

/** 送出 patch，等伺服器把它廣播回來（或回報錯誤）才算數。 */
function commit(session, ops, check) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('送出後沒有等到伺服器回應')), 10000);
    session.on(m => {
      if (m.t === 'err') {
        clearTimeout(timer);
        reject(new Error('伺服器退回：' + m.code
          + (m.code === 'locked' ? '（這間房被鎖了）'
            : m.code === 'frozen' ? '（全站停寫中）' : '')));
      } else if ((m.t === 'patch' || m.t === 'sync') && check(session.doc)) {
        clearTimeout(timer);
        resolve();
      } else if (m.t === 'closed') {
        clearTimeout(timer);
        reject(new Error('連線中斷：' + (m.reason || m.code)));
      }
    });
    session.send({ t: 'patch', ops });
  });
}

/* ── 指令 ─────────────────────────── */

/**
 * 房間的文件不落地，沒人在線的那段空窗會把湯麵一起帶走（見 README）。
 * 主持人手上有原稿，所以每次進房發現湯麵不見了就補回去 —— 玩家已經問出來的列
 * 由玩家自己的鏡像補（DO 的 need/seed），我們只負責題目本身。
 */
async function restoreSurface(session, soup) {
  if (!soup || session.doc.surface) return false;
  await commit(session, [
    { p: 'lives', v: soup.lives },
    { p: 'surface', v: soup.surface },
  ], d => d.surface === soup.surface);
  console.error('· 房間裡的湯麵不見了（沒人在線的空窗），已從湯底檔補回');
  return true;
}

async function cmdInit(name) {
  const soup = loadSoup();
  const s = await connect(name);

  if (hasContent(s.doc)) {
    s.close();
    die('這間房已經有內容了。要重出一題請先 npm run soup -- wipe ' + name);
  }

  await commit(s, [
    { p: 'lives', v: soup.lives },
    { p: 'surface', v: soup.surface },
  ], d => d.surface === soup.surface);
  s.close();

  console.log('✓ 已出題到 ' + name + '（生命 ' + soup.lives + '）');
  console.log('  湯底留在本機，沒有寫進房間。');
}

/** 有問題但還沒答的列。 */
function pendingOf(doc) {
  const out = [];
  for (let i = 0; i < doc.rows.length && i < doc.lives; i++) {
    const r = doc.rows[i];
    if (r.q.trim() && !r.a) out.push({ row: i + 1, q: r.q, hint: HINT.test(r.q) });
  }
  return out;
}

async function cmdWait(name) {
  const secs = Number(flag('timeout', '540'));
  if (!Number.isFinite(secs) || secs < 1 || secs > 3600) die('--timeout 要是 1 到 3600 秒');

  const soup = loadSoup(false);
  const s = await connect(name);
  await restoreSurface(s, soup);

  const pending = await new Promise(resolve => {
    const now = pendingOf(s.doc);
    if (now.length) return resolve(now);

    const timer = setTimeout(() => resolve([]), secs * 1000);
    s.on(m => {
      if (m.t === 'closed') { clearTimeout(timer); return resolve([]); }
      const p = pendingOf(s.doc);
      if (p.length) { clearTimeout(timer); resolve(p); }
    });
  });
  s.close();

  // 給 Claude Code 讀的：整局的來龍去脈都在這裡，但湯底不在（湯底在本機檔案）。
  console.log(JSON.stringify({
    room: name,
    rev: s.doc.rev,
    lives: s.doc.lives,
    surface: s.doc.surface,
    history: s.doc.rows
      .map((r, i) => ({ row: i + 1, q: r.q, a: r.a, n: r.n }))
      .filter(r => r.q || r.a || r.n),
    pending,
  }, null, 2));
}

async function cmdAnswer(name) {
  const soup = loadSoup();

  const n = Number(rest[1]);
  if (!Number.isInteger(n) || n < 1 || n > ROWS_MAX) die('列號要是 1 到 ' + ROWS_MAX + ' 的整數');
  const i = n - 1;

  // 白名單解析：這是防注入的主要防線，不是格式檢查而已。
  const a = String(rest[2] === undefined ? '' : rest[2]).trim().toUpperCase();
  if (!ANS.has(a)) die('回答只能是 T（是）、F（否）、I（無關），而且不可為空，收到：' + JSON.stringify(rest[2] ?? ''));

  const s = await connect(name);
  await restoreSurface(s, soup);
  const r = s.doc.rows[i];

  if (!r || !r.q.trim()) { s.close(); die('第 ' + n + ' 列沒有問題可答'); }
  if (r.a) { s.close(); die('第 ' + n + ' 列已經答過 ' + r.a + ' 了，不覆蓋'); }

  const ops = [{ p: 'rows.' + i + '.a', v: a }];

  let note = flag('note');
  if (note) {
    note = String(note).replace(/\s+/g, ' ').trim().normalize('NFC');

    // 只在玩家自己開口要提示的那一列才寫註解。
    if (!HINT.test(r.q)) {
      s.close();
      die('第 ' + n + ' 列的問題沒有要提示，不寫註解。\n'
        + '  問題：' + r.q + '\n'
        + '  要給提示請等玩家自己開口（問題裡出現「提示」「線索」之類的字）。');
    }

    const hit = leaks(note, soup.bottom);
    if (hit) {
      s.close();
      die('註解跟湯底有 ' + NGRAM + ' 個字以上重疊（「' + hit + '」），退回。\n'
        + '  提示要用自己的話講方向，不要抄湯底原文。');
    }

    const full = TAG + note;
    if (chars(full) > NOTE_MAX) {
      s.close();
      die('註解太長：' + chars(full) + ' 字，上限 ' + NOTE_MAX + '（含前綴）');
    }
    ops.push({ p: 'rows.' + i + '.n', v: full });
  }

  await commit(s, ops, d => d.rows[i] && d.rows[i].a === a);
  s.close();

  console.log('✓ 第 ' + n + ' 列已回答 ' + a + (note ? '（附提示）' : ''));
}

async function cmdReveal(name) {
  const second = room(rest[1], '第二次的房號');
  if (name !== second) die('兩次房號不一致，為了避免在別間房揭底，這裡不接受');

  const soup = loadSoup();
  const s = await connect(name);

  await commit(s, [{ p: 'bottom', v: soup.bottom }], d => d.bottom === soup.bottom);
  s.close();

  console.log('✓ 已揭曉湯底到 ' + name);
  console.log('  房裡所有人現在都看得到了，這一步不可逆。');
}

/* ── 主流程 ───────────────────────── */

const HELP = `海龜湯 · 本機主持人 CLI

  init <房號> --soup <檔>                 出題：把湯麵與生命數寫進房間，湯底留在本機
  wait <房號> [--soup <檔>] [--timeout 540]
                                          卡住等玩家提問，出現待答問題就印出 JSON 並結束
                                          給了 --soup 就順便補回不見的湯麵
  answer <房號> <列號> <T|F|I> --soup <檔> [--note "…"]
                                          回答一列。T/F/I 以外一律退回
  reveal <房號> <房號> --soup <檔>        揭曉湯底，房號要打兩次

  --host <網址>   目標站台，預設 ${BASE}
                  （也吃環境變數 SOUP_HOST）

  湯底檔是 JSON：{ "surface": "湯麵", "bottom": "湯底", "lives": 6 }
  湯底除了 reveal 之外絕不上傳 —— 房裡的文件所有人都讀得到。`;

try {
  switch (cmd) {
    case 'init':   await cmdInit(room(rest[0])); break;
    case 'wait':   await cmdWait(room(rest[0])); break;
    case 'answer': await cmdAnswer(room(rest[0])); break;
    case 'reveal': await cmdReveal(room(rest[0])); break;
    default:
      console.log(HELP);
      process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  die(e && e.message || String(e));
}
process.exit(0);
