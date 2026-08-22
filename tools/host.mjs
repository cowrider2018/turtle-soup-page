#!/usr/bin/env node
/* 海龜湯 · 本機主持人 CLI
 *
 * 這支程式只做傳輸：連上房間、讀文件、寫回答。它不呼叫任何 LLM，
 * 判斷交給跑在本機的 Claude Code —— 房間的 Worker 因此完全不用改，
 * 也不會多出一個 runtime 的 AI 呼叫路徑。
 *
 * 用法：
 *   npm run host -- init <房號> --soup <湯底檔>
 *   npm run host -- hold <房號> --soup <湯底檔>   （背景跑，當房間的地板）
 *   npm run host -- wait <房號> [--timeout 100]
 *   npm run host -- answer <房號> <列號> <T|F|I> [--note "…"] [--then] --soup <湯底檔>
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
 *   4. 揭曉湯底不由主持人自己決定：reveal 是獨立指令、房號要打兩次；
 *      wait 只有在玩家於房間裡按下「揭曉湯底」（want）之後才會代為揭底。
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
const BOOL = new Set(['hold', 'covered']);             // 這些旗標不吃值（--then 可帶秒數，不算在內）
const has = name => argv.includes('--' + name);
const positional = (() => {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      if (!BOOL.has(argv[i].slice(2))) i++;             // 其餘旗標吃掉後面那個值
      continue;
    }
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
const nap = ms => new Promise(r => setTimeout(r, ms));

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

/**
 * role 是自報身分，房間拿它算出「現在有沒有人會回答」並廣播給玩家：
 * ear＝掛著等問題（wait），floor＝守著房間（hold）。其餘指令都是短命連線，
 * 不報身分 —— 它們連上又走，報了只會讓玩家那顆燈亂閃。
 */
function endpoints(name, role) {
  let u;
  try { u = new URL(BASE); }
  catch { return die('--host 不是合法網址：' + BASE); }
  const ws = new URL(u.href);
  ws.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  ws.pathname = '/ws';
  ws.search = '?r=' + encodeURIComponent(name) + (role ? '&role=' + role : '');
  return { url: ws.href, origin: u.origin };
}

const EMPTY = () => ({ rev: 0, lives: 6, rows: [], surface: '', bottom: '', ask: '', want: false });

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
function connect(name, role) {
  const { url, origin } = endpoints(name, role);
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
          ask: m.doc.ask === 'near' || m.doc.ask === 'full' ? m.doc.ask : '',
          want: m.doc.want === true,
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
          if (op.p === 'lives' || op.p === 'surface' || op.p === 'bottom'
            || op.p === 'ask' || op.p === 'want') { doc[op.p] = op.v; continue; }
          const g = /^rows\.(\d{1,3})\.(q|a|n)$/.exec(op.p);
          if (g) grow(doc.rows, Number(g[1]))[g[2]] = op.v;
        }
      } else if (m.t === 'need') {
        // 這裡不補。短命客戶端（init、wait、answer）每個指令都重新連一次線，手上的列
        // 永遠可能是舊的，拿它去補會整份蓋掉玩家剛打進去的提問（seed 是整份取代，不是合併）。
        //
        // 補的人是 hold：它整局掛著同一條連線，鏡像跟著房間一起走，而且排在玩家的瀏覽器
        // 後面才出手（見 cmdHold）。這裡只把訊息轉給監聽器，由它決定。
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

const SEED_GRACE = 1500;    // 讓玩家的瀏覽器先補的寬限（伺服器的 seed 窗口是 3 秒）
const SEED_ACK = 600;       // 送出 seed 之後，等伺服器把全量 sync 廣播回來
const HEAL_COOLDOWN = 5000; // 補救不成時別黏著房間一直重試
const OPS_MAX = 48;         // 單筆 patch 的操作數（伺服器上限 64）
const BYTES_MAX = 6000;     // 單筆 patch 的位元組數（伺服器上限 8192）

/**
 * 把整份鏡像用一般的 patch 寫回空房間。
 *
 * seed 只有在伺服器自己喊過 need 的那幾秒收得下（見 worker/room.js 的 isHollow）。
 * 房間整顆消失、被下一個連線重新開出來的時候它不算 hollow —— 那時候 seed 會被靜靜丟掉，
 * 唯一寫得進去的是 patch。所以兩條路都要有，這是 patch 那一條。
 *
 * 只在房間確實是空的時候呼叫，所以蓋不到任何人。
 */
async function restoreMirror(session, mirror) {
  const ops = [{ p: 'lives', v: mirror.lives }, { p: 'surface', v: mirror.surface }];
  if (mirror.bottom) ops.push({ p: 'bottom', v: mirror.bottom });
  if (mirror.ask) ops.push({ p: 'ask', v: mirror.ask });
  if (mirror.want) ops.push({ p: 'want', v: true });
  mirror.rows.forEach((r, i) => {
    for (const k of ['q', 'a', 'n']) if (r[k]) ops.push({ p: 'rows.' + i + '.' + k, v: r[k] });
  });

  for (const chunk of chunks(ops)) {
    const last = chunk[chunk.length - 1];
    await commit(session, chunk, d => applied(d, last));
  }
}

/** 一筆 patch 同時受操作數與訊息位元組數限制，兩個都要顧（LIM.ops / LIM.msgBytes）。 */
function chunks(ops) {
  const out = [];
  let cur = [], bytes = 0;
  for (const op of ops) {
    const n = Buffer.byteLength(JSON.stringify(op), 'utf8') + 1;
    if (cur.length && (cur.length >= OPS_MAX || bytes + n > BYTES_MAX)) { out.push(cur); cur = []; bytes = 0; }
    cur.push(op); bytes += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** 這一筆操作在鏡像裡生效了沒 —— commit 用它判斷伺服器是不是真的收下了。 */
function applied(doc, op) {
  const bits = op.p.split('.');
  if (bits.length !== 3 || bits[0] !== 'rows') return doc[op.p] === op.v;
  const row = doc.rows[Number(bits[1])];
  return !!row && row[bits[2]] === op.v;
}

/**
 * 房間的地板。
 *
 * 房間的文件只活在 DO 的記憶體裡，沒有客戶端在線就隨時會蒸發。主持人是短命客戶端
 * —— init、wait、answer 各連一次就走 —— 所以從出題到玩家開頁面之間、以及每答完一列
 * 到下一次 wait 之間，房間都是沒有地板的：那幾秒到幾分鐘裡房間掉了，玩家開進去就是空房。
 *
 * 這支指令就是那塊地板：連上就不放，斷了自己接回來，發現房間空了就補回去。
 * 開局時在背景起一支，整局都有人在線。
 *
 * 它也保管整局的鏡像。列原本只存在玩家的瀏覽器裡，那一份撐不過一次 F5 —— 房間醒來喊
 * need 的時候剛重整完的分頁手上是空的，沒有人補得出來，整局就沒了。地板是全程在線、
 * 不會重整的那一方，所以由它兜底，但排在玩家後面：先等 SEED_GRACE 讓瀏覽器補（它手上
 * 那份比較新），過了寬限期房間還是空的才餵鏡像。伺服器只在自己確實空著的時候收 seed，
 * 所以晚到的那一份不會蓋掉任何人。
 */
async function cmdHold(name) {
  const soup = loadSoup();
  const minutes = Number(flag('minutes', '180'));
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) die('--minutes 要是 1 到 1440');
  const until = Date.now() + minutes * 60000;

  console.log('· 守著 ' + name + '（' + minutes + ' 分鐘，Ctrl-C 可以提早收）');
  let laps = 0, fixes = 0;
  let mirror = null;          // 跨連線保留：重連拿到的第一份 sync 本身就可能是空的

  const snap = d => JSON.parse(JSON.stringify(d));
  const rowsOf = d => d.rows.filter(r => r.q || r.a || r.n).length;

  while (Date.now() < until) {
    let s;
    try { s = await connect(name, 'floor'); }
    catch (e) { console.error('· 連不上，5 秒後重試：' + e.message); await nap(5000); continue; }
    laps++;

    // 房間是不是空的，這裡自己記。收到 need 之後 s.doc 還留著上一次的內容，
    // 光看鏡像分不出「房間好好的」跟「房間掉了，只是還沒有人把空的那份送來」。
    let empty = !hasContent(s.doc);
    let busy = false, healedAt = 0;
    if (!empty) mirror = snap(s.doc);

    const heal = async () => {
      await nap(SEED_GRACE);
      if (!empty) return;                       // 這段時間裡有人補好了
      if (mirror && hasContent(mirror)) {
        s.send({ t: 'seed', doc: mirror });
        await nap(SEED_ACK);
        if (empty) await restoreMirror(s, mirror);       // 不是 hollow，seed 被丟掉了
        if (!empty) {
          console.error('· 房間的記憶體掉了，已把整份紀錄補回（' + rowsOf(mirror) + ' 列）');
          fixes++;
          return;
        }
      }
      if (await restoreSurface(s, soup)) fixes++;
    };

    const tend = async () => {
      if (busy || !empty || Date.now() - healedAt < HEAL_COOLDOWN) return;
      busy = true;
      try { await heal(); }
      catch (e) { console.error('· 補救失敗：' + e.message); }
      healedAt = Date.now();
      busy = false;
    };

    // 掛著，直到斷線或時間到。監聽器要先掛上再補救：反過來的話，補救期間沒有人更新
    // empty，heal 就看不出伺服器已經收下了，會白做一次。
    const done = new Promise(resolve => {
      const timer = setTimeout(resolve, Math.max(0, until - Date.now()));
      s.on(m => {
        if (m.t === 'closed') { clearTimeout(timer); return resolve(); }

        // 只有真的帶了房間狀態的訊息才動 empty。here 與 err 不帶 —— 拿鏡像去判斷的話，
        // 房間空了以後隨便一則 here 就會把 empty 抹掉，補救永遠不會發生。
        if (m.t === 'need') empty = true;                        // 伺服器自己說它空了
        else if (m.t === 'sync') {
          if (m.why === 'wipe') mirror = null;                   // 清空之後別再補回來
          empty = !hasContent(s.doc);
          if (!empty) mirror = snap(s.doc);
        } else if (m.t === 'patch' && hasContent(s.doc)) {
          empty = false;
          mirror = snap(s.doc);
        }
        tend();
      });
    });
    tend();
    await done;
    s.close();
  }

  console.log('✓ 不守了：' + name + '（連線 ' + laps + ' 次，補回 ' + fixes + ' 次）');
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

/**
 * 玩家離謎底夠近了嗎？
 *
 * 解開的定義跟提示的掃描規則同一套：該格的觸及詞出現在**拿到 T** 的提問裡。
 * 湯麵就已經揭露的格算送分 —— 玩家本來就知道，不該擋著整張圖。
 *
 * 門檻是「非空格數減一」，不是全解。要求全解會卡死：觸及詞是湯底那一側的詞，
 * 玩家問的是問題那一側的詞（湯底寫「救命」，玩家打「求救」），總有一格永遠對不上，
 * 於是提議永遠不亮。放過一格，最窄的那一格就不再是整局的死結。
 *
 * 下限是 2，因為 n-1 在格子很少的時候太鬆 —— 只有兩格非空時解開一格就跳窗，
 * 等於開局沒多久就問玩家要不要看答案。
 *
 * 判定放在程式裡而不是模型裡，是為了不飄：同一局裡「夠不夠近」每答一列重算一次，
 * 交給模型自由心證的話，第 12 列說夠了、第 13 列又說不夠。
 */
function coverage(doc, elements) {
  const el = elements || {};
  const yes = doc.rows.filter(r => r.a === 'T' && r.q.trim()).map(r => bare(r.q));
  const solved = [], open = [];
  for (const slot of SLOTS) {
    const cell = el[slot];
    if (!cell) continue;                                  // 空格不算在內
    if (cell['已揭露'] === true) { solved.push(slot); continue; }
    const words = (Array.isArray(cell['觸及詞']) ? cell['觸及詞'] : [cell['觸及詞']])
      .map(w => bare(String(w || ''))).filter(Boolean);
    (words.length && yes.some(q => words.some(w => q.includes(w))) ? solved : open).push(slot);
  }
  const need = Math.max(2, solved.length + open.length - 1);
  return { covered: solved.length >= need, solved, open, need };
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

/**
 * 等到有待答問題、或玩家按了揭曉，或期限到。
 *
 * 期限內斷線就自己接回來繼續等 —— 斷線在這裡是常態（DO 休眠會關掉閒置連線），
 * 把它當成「這一輪沒人提問」丟回去，主持人就會以為房間安靜，實際上是它沒在聽。
 *
 * 已經連著的話把 session 傳進來（answer 續攤用），省掉一次連線。
 */
async function watch(name, soup, deadline, session) {
  // 玩家在房間裡按了「揭曉湯底」。湯底只在本機，房間自己揭不了，所以這裡也要醒。
  // 揭完之後 want 仍然是 true（它單向鎖定），所以條件要看湯底寫進去了沒有 ——
  // 只看 want 的話，下一次 wait 會立刻返回，主持迴圈就變成空轉。
  const owed = d => d.want === true && soup && soup.bottom && d.bottom !== soup.bottom;
  let s = session, revealed = false, lost = '';

  for (;;) {
    if (!s) {
      try {
        s = await connect(name, 'ear');
        await restoreSurface(s, soup);
        lost = '';
      } catch (e) {
        lost = e.message;
        if (Date.now() >= deadline) return { s: null, pending: [], revealed, lost };
        await nap(2000);
        continue;
      }
    }

    const left = deadline - Date.now();
    const out = left <= 0
      ? { pending: pendingOf(s.doc) }
      : await new Promise(resolve => {
        const now = pendingOf(s.doc);
        if (now.length || owed(s.doc)) return resolve({ pending: now });

        const timer = setTimeout(() => resolve({ pending: [] }), left);
        s.on(m => {
          if (m.t === 'closed') { clearTimeout(timer); return resolve({ closed: true }); }
          const p = pendingOf(s.doc);
          if (p.length || owed(s.doc)) { clearTimeout(timer); resolve({ pending: p }); }
        });
      });

    if (out.closed) {
      s = null;
      if (Date.now() >= deadline) return { s: null, pending: [], revealed, lost: '連線中斷' };
      continue;                                   // 期限還沒到，接回來繼續等
    }

    // 授權來自玩家按下去的那一下，所以這裡直接揭，不再回頭問主持人 ——
    // 中間多一次判斷，玩家就要多等一輪 wait 才看得到湯底。
    if (owed(s.doc)) {
      await commit(s, [{ p: 'bottom', v: soup.bottom }], d => d.bottom === soup.bottom);
      revealed = true;
    }
    return { s, pending: out.pending, revealed, lost };
  }
}

/** 給 Claude Code 讀的報告：整局的來龍去脈都在這裡，但湯底不在（湯底在本機檔案）。 */
function report(name, r) {
  if (!r.s) die('連不上 ' + name + '：' + (r.lost || '不明原因'));
  const d = r.s.doc;
  console.log(JSON.stringify({
    room: name,
    rev: d.rev,
    lives: d.lives,
    ask: d.ask || '',             // 揭底提議：''／near／full
    want: d.want === true,        // 玩家按了揭曉
    revealed: r.revealed,         // 這一輪剛把湯底寫進房間
    surface: d.surface,
    history: d.rows
      .map((row, i) => ({ row: i + 1, q: row.q, a: row.a, n: row.n }))
      .filter(row => row.q || row.a || row.n),
    pending: r.pending,
  }, null, 2));
}

// 預設 100 秒，不是 9 分鐘：主持 subagent 的 Bash 工具預設 120 秒就會砍掉指令，
// 卡更久只會換來一個逾時錯誤，而不是「這段時間沒人提問」。回空就再跑一次，很便宜。
function deadlineFrom(name, fallback) {
  const secs = Number(flag(name, fallback));
  if (!Number.isFinite(secs) || secs < 1 || secs > 3600) die('--' + name + ' 要是 1 到 3600 秒');
  return Date.now() + secs * 1000;
}

async function cmdWait(name) {
  const deadline = deadlineFrom('timeout', '100');
  const soup = loadSoup(false);
  const r = await watch(name, soup, deadline, null);
  if (r.s) r.s.close();
  report(name, r);
}

async function cmdAnswer(name) {
  const soup = loadSoup();

  // --then：答完不斷線，直接接著等下一批問題，一次工具呼叫做完一輪。
  // 每題省掉一次行程啟動、一次連線、一次工具呼叫 —— 模型路徑上唯一能省的那一段。
  const then = has('then') ? deadlineFrom('then', '100') : 0;

  const n = Number(rest[1]);
  if (!Number.isInteger(n) || n < 1 || n > ROWS_MAX) die('列號要是 1 到 ' + ROWS_MAX + ' 的整數');
  const i = n - 1;

  // 白名單解析：這是防注入的主要防線，不是格式檢查而已。
  const a = String(rest[2] === undefined ? '' : rest[2]).trim().toUpperCase();
  if (!ANS.has(a)) die('回答只能是 T（是）、F（否）、I（無關），而且不可為空，收到：' + JSON.stringify(rest[2] ?? ''));

  const s = await connect(name, then ? 'ear' : '');
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

  // 答完這一列，重算一次距離。夠近了就把揭底提議點亮，房間會跳出
  // 「你已經非常接近謎底，要現在揭露湯底嗎？」——按不按是玩家的事。
  //
  // --covered 是往上覆寫：機械判定還沒到，但你看得出玩家其實已經懂了。
  // 觸及詞窄到玩家問不出來的格不只一個時，這是唯一的出口。
  const cov = coverage(s.doc, soup.elements);
  // near＝還差一格，full＝全部解開。兩者在房間裡是兩句不同的文案：只寫一句的話，
  // 差一格的玩家會以為自己全中，被揭出沒想到的那一塊時只覺得被暴雷。
  const level = cov.open.length === 0 ? 'full' : 'near';
  const show = (cov.covered || has('covered')) && !has('hold');
  // 已經亮著 near、現在全解了，就升級成 full。伺服器只准往上升，不准退回。
  const lit = show && s.doc.ask !== level && !(s.doc.ask === 'full' && level === 'near');
  if (lit) await commit(s, [{ p: 'ask', v: level }], d => d.ask === level);
  if (!then) s.close();

  const score = cov.solved.length + '/' + (cov.solved.length + cov.open.length)
    + ' 格（門檻 ' + cov.need + '）';
  console.log('✓ 第 ' + n + ' 列已回答 ' + a + (note ? '（附提示）' : ''));
  const still = cov.open.length ? '，尚未解開：' + cov.open.join('、') : '';
  if (lit) console.log('  已解開 ' + score + still
    + '，房裡跳出了揭底提議（' + level + '）。' + (cov.covered ? '' : '（--covered 覆寫）'));
  else if (has('hold')) console.log('  （--hold：這一列不點亮提議）已解開 ' + score + still);
  else console.log('  已解開 ' + score + still);

  // 續攤：不斷線，直接接著等下一批。印出來的 JSON 跟 wait 完全一樣，
  // 主持人拿到之後就能直接判斷下一列，不必再跑一次 wait。
  if (then) {
    const r = await watch(name, soup, then, s);
    if (r.s) r.s.close();
    report(name, r);
  }
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
  hold <房號> --soup <檔> [--minutes 180]
                                          當房間的地板：連著不放，房間空了就補回湯麵
                                          開局時在背景起一支，整局都有客戶端在線
  wait <房號> [--soup <檔>] [--timeout 100]
                                          卡住等玩家提問，出現待答問題就印出 JSON 並結束
                                          期限內斷線會自己接回來繼續等
                                          給了 --soup 就順便補回不見的湯麵；
                                          玩家按了「揭曉湯底」也會醒，並代為揭底
  answer <房號> <列號> <T|F|I> --soup <檔> [--note "…" --slot <格名>]
                                          [--hold] [--covered] [--then [秒]]
                                          回答一列。T/F/I 以外一律退回
                                          給提示要同時指名要素圖的哪一格：
                                          ${SLOTS.join('／')}
                                          解開的格數到門檻就點亮揭底提議
                                          --hold 這次不點亮，--covered 這次強制點亮
                                          --then：答完不斷線，接著等下一批（預設 100 秒），
                                          印出跟 wait 一樣的 JSON —— 一次呼叫做完一輪
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
    case 'hold':   await cmdHold(room(rest[0])); break;
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
