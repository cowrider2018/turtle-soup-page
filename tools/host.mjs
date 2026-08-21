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
import { unveil, isVeiled } from './veil.mjs';
import { leaks, NGRAM, bare } from './leak.mjs';
import { offVocab } from './vocab.mjs';

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
// 要素圖的六格，由具體到抽象。順序就是提示的掃描順序。
const SLOTS = ['物件', '場景', '關鍵事件', '方法', '身分關係', '動機'];
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

  // 湯倉的檔案是遮蔽過的（見 tools/veil.mjs）。明文 JSON 也照收，手寫的湯還是能用。
  let soup;
  if (isVeiled(raw)) {
    try { soup = unveil(raw); }
    catch (e) { die('解不開遮蔽檔 ' + path + '：' + e.message); }
  } else {
    try { soup = JSON.parse(raw); }
    catch (e) { die('湯底檔不是合法 JSON：' + e.message); }
  }

  const surface = String(soup?.surface || '').normalize('NFC');
  const bottom = String(soup?.bottom || '').normalize('NFC');
  if (!surface) die('湯底檔缺 surface（湯麵）');
  if (!bottom) die('湯底檔缺 bottom（湯底）');

  const lives = soup.lives === undefined ? 6 : soup.lives;
  if (!Number.isInteger(lives) || lives < 1 || lives > ROWS_MAX) die('lives 要是 1 到 ' + ROWS_MAX + ' 的整數');

  return {
    surface, bottom, lives,
    kind: String(soup.kind || 'normal'),
    elements: soup.elements || null,
    '紅鯡魚': Array.isArray(soup['紅鯡魚']) ? soup['紅鯡魚'] : [],
  };
}

/**
 * 房間裡已經人人看得見的文字：湯麵，加上玩家自己打過的每一則提問。
 * 提示引用這些字是刻意的設計（「想想他為什麼要開燈」比「想想動機」有用得多），
 * 所以洩底檢查要把它們排除在外 —— 見 tools/leak.mjs。
 */
function exposedIn(doc) {
  return [doc.surface, ...doc.rows.map(r => r.q)].filter(s => s && s.trim());
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
        // 不補。主持人是短命客戶端 —— 每個指令都重新連一次線，手上的列永遠可能是舊的，
        // 拿它去補會整份蓋掉玩家剛打進去的提問（seed 是整份取代，不是合併）。
        //
        // 列的內容歸玩家的瀏覽器保管，它們才是全程在線的那一方。主持人只負責湯麵，
        // 而湯麵是靠 restoreSurface 明確補的，不走 seed。
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

    // 提示一律要指名是哪一格。這逼主持人從要素圖挑，而不是憑感覺造句，
    // 也讓每一則提示在文件之外留下可追的來源。
    const slot = flag('slot');
    if (!slot) {
      s.close();
      die('給提示要用 --slot 指名要素圖的哪一格：' + SLOTS.join('／') + '\n'
        + '  跑 brief 看要素圖，照 skill 的掃描規則挑一格。');
    }
    if (!SLOTS.includes(slot)) { s.close(); die('沒有這一格：' + slot + '\n  只能是 ' + SLOTS.join('／')); }

    const cell = soup.elements && soup.elements[slot];
    if (!cell) { s.close(); die(slot + ' 這一格是空的（null），這題沒有這個方向可指'); }

    const approved = (Array.isArray(cell['方向']) ? cell['方向'] : [cell['方向']])
      .map(d => String(d || '').normalize('NFC').trim()).filter(Boolean);

    // 採集期就驗過的方向句直接放行。其餘（引用了玩家問過的話的變體）走白名單檢查。
    if (!approved.some(d => bare(d) === bare(note))) {
      const exposed = exposedIn(s.doc);

      const off = offVocab(note, exposed);
      if (off) {
        s.close();
        die('註解裡的「' + off + '」既不在固定詞庫、也沒在房間裡出現過，退回。\n'
          + '  提示只能用核准詞彙，加上房間裡已經有的字（湯麵、玩家問過的話）。\n'
          + '  ' + slot + ' 格的現成方向句：' + approved.map(d => '「' + d + '」').join('、') + '\n'
          + '  真的缺常用詞就補進 tools/vocab.mjs 的 SCAFFOLD，別繞過檢查。');
      }

      const hit = leaks(note, soup.bottom, exposed);
      if (hit) {
        s.close();
        die('註解帶進了房間裡還沒有的湯底文字（「' + hit + '」，' + NGRAM + ' 字以上），退回。');
      }
    }

    // 紅鯡魚是湯麵裡「看起來重要、其實無關」的詞。誤導多半不是引用了無關詞，
    // 是引用了看起來有關的無關詞 —— 所以這些字任何時候都不准出現在提示裡。
    const herring = soup['紅鯡魚'].find(h => h && bare(note).includes(bare(h)));
    if (herring) {
      s.close();
      die('註解引用了紅鯡魚「' + herring + '」，退回。\n'
        + '  那個詞在湯麵裡看起來重要，其實與湯底無關，指過去會把玩家帶進死胡同。');
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

/**
 * 解開遮蔽，印出湯底與要素圖。不連線、不寫任何東西。
 *
 * ⚠ 這是整套工具裡唯一會印出湯底的主持指令，只給主持用的 subagent 跑。
 * 主對話不得執行 —— 使用者自己也是玩家，湯底一旦進了主對話就在他眼前。
 */
function cmdBrief() {
  const soup = loadSoup();
  console.log(JSON.stringify({
    warning: '本段含湯底，不得複述、摘要或暗示給使用者',
    bottom: soup.bottom,
    kind: soup.kind,
    lives: soup.lives,
    elements: soup.elements,
    '紅鯡魚': soup['紅鯡魚'],
  }, null, 2));
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
  answer <房號> <列號> <T|F|I> --soup <檔> [--note "…" --slot <格名>]
                                          回答一列。T/F/I 以外一律退回
                                          給提示要同時指名要素圖的哪一格：
                                          ${SLOTS.join('／')}
  brief  --soup <檔>                      印出湯底與要素圖（⚠ 只給主持 subagent 跑）
  reveal <房號> <房號> --soup <檔>        揭曉湯底，房號要打兩次

  --host <網址>   目標站台，預設 ${BASE}
                  （也吃環境變數 SOUP_HOST）

  湯底檔吃兩種格式：湯倉的遮蔽檔（.veil），或手寫的明文 JSON
  { "surface": "湯麵", "bottom": "湯底", "lives": 6 }
  湯底除了 reveal 之外絕不上傳 —— 房裡的文件所有人都讀得到。`;

try {
  switch (cmd) {
    case 'init':   await cmdInit(room(rest[0])); break;
    case 'wait':   await cmdWait(room(rest[0])); break;
    case 'answer': await cmdAnswer(room(rest[0])); break;
    case 'brief':  cmdBrief(); break;
    case 'reveal': await cmdReveal(room(rest[0])); break;
    default:
      console.log(HELP);
      process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  die(e && e.message || String(e));
}
process.exit(0);
