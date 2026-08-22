#!/usr/bin/env node
/* 海龜湯 · 湯倉 CLI
 *
 * 採集的判斷歸模型，記帳與硬性檢查歸這裡 —— 跟 host.mjs 的分工一致。
 * 這支程式不呼叫任何 LLM。
 *
 * 用法：
 *   npm run pick -- check  <草稿.json>              事實檢查＋要素圖驗證
 *   npm run pick -- add    <草稿.json>              檢查通過就遮蔽入庫
 *   npm run pick -- reject <草稿.json> --code E_XXX --why "…"
 *   npm run pick -- list                            倉存清單（不印任何題目內容）
 *   npm run pick -- take   <房號> [--hash h|--find 詞]  取一題未出過的寫成 soups/<房號>.veil
 *   npm run pick -- peek   <hash> <hash>            刻意看湯底，hash 要打兩次
 *   npm run pick -- stats                           淘汰理由分佈
 *
 * 倉存一律遮蔽（tools/veil.mjs）。除了 peek，沒有任何指令會印出湯底。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { veil, unveil } from './veil.mjs';
import { leaks, bare } from './leak.mjs';
import { offVocab, VOCAB } from './vocab.mjs';

const ROOT   = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOUPS  = join(ROOT, 'soups');
const PANTRY = join(SOUPS, 'pantry');
const VETTED = join(PANTRY, 'vetted');
const REJECT = join(PANTRY, 'rejected');
const SEEN   = join(PANTRY, '.seen.json');

/* ── 規格常數（與 worker/validate.js 的 LIM 一致） ── */

const LIM = { surface: 2000, bottom: 4000, rows: 300 };
const SLOTS = ['物件', '場景', '關鍵事件', '方法', '身分關係', '動機'];
const DIR_MAX = 40;          // 方向詞字數上限
const BOTTOM_MIN = 20;       // 湯底短於此一律當抽取失敗
const KINDS = new Set(['normal', 'wordplay']);

// 湯麵是唯一讓攻擊者可控文字進入系統的入口。這裡只做字元層，
// 「這段文字有沒有在對讀者下指令」交給注入閘那次模型呼叫。
const JUNK = new RegExp(
  '[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f' +
  '\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060-\\u2064' +
  '\\u2066-\\u2069\\ufeff\\ufff9-\\ufffb]', 'u');
const URLISH = /(https?:\/\/|www\.)/i;
const MARKUP = new RegExp('(<[a-zA-Z/!]|\\{\\{|\\[/?INST\\]|\\u0060\\u0060\\u0060|\\[\\[)');

// 抽取失敗的典型長相：湯底根本不在頁面上。
const PLACEHOLDER = /(答案(在|見|請看|下收)|見(留言|樓下|下方|回覆)|待(補|更新|公布)|明天(公布|揭曉)|自行想像)/;

/* ── 小工具 ── */

const chars = s => [...s].length;
const die = m => { console.error('✗ ' + m); process.exit(1); };
const norm = v => String(v == null ? '' : v).normalize('NFC').trim();
const hashOf = bottom => createHash('sha256').update(bare(bottom)).digest('hex').slice(0, 16);
const today = () => new Date().toISOString().slice(0, 10);

function ensureDirs() {
  for (const d of [SOUPS, PANTRY, VETTED, REJECT]) if (!existsSync(d)) mkdirSync(d, { recursive: true });
}
const loadSeen = () => existsSync(SEEN) ? JSON.parse(readFileSync(SEEN, 'utf8')) : {};
const saveSeen = s => writeFileSync(SEEN, JSON.stringify(s, null, 2), 'utf8');

/* ── 同題辨識與「過度提示」判定 ──────────
 *
 * 網路上流傳的經典湯常有多個版本，其中一種變體會把湯底的細節搬進湯麵，變成
 * 自帶提示的簡單版。單看一題判不出來 —— 我們無從得知原作打算讓湯麵多含蓄。
 * 但同一題的多個版本擺在一起就很明顯：湯麵突然多出一堆說明的那個就是。
 *
 * 所以這個判斷屬於去重階段，而且**只在真的有東西可比的時候才啟動**。
 * 只抓到一個版本就不判，照收。
 */

const GRAM = 3;
function grams(s, n = GRAM) {
  const xs = [...bare(s)];
  const out = new Set();
  for (let i = 0; i + n <= xs.length; i++) out.add(xs.slice(i, i + n).join(''));
  return out;
}

/** 小的那一邊有多少比例被大的那邊蓋住。同題的不同寫法用這個比 Jaccard 準。 */
function containment(a, b) {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const g of small) if (big.has(g)) hit++;
  return hit / small.size;
}

const SAME_SOUP = 0.55;   // 湯底重疊到這個程度就當作同一題的不同版本

/**
 * 湯麵裡有多少比例是湯底的內容？
 * 含蓄的原版只會跟湯底共用人名場景，被塞了提示的改寫版會共用一大段因果。
 */
function hintiness(surface, bottom) {
  const s = grams(surface);
  if (!s.size) return 0;
  const b = grams(bottom);
  let hit = 0;
  for (const g of s) if (b.has(g)) hit++;
  return hit / s.size;
}

/** 倉裡有沒有同一題的其他版本？回傳最像的那個。 */
function findVariant(bottom) {
  const cand = grams(bottom);
  let best = null;
  for (const dir of [VETTED, SOUPS]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter(x => x.endsWith('.veil'))) {
      let d;
      try { d = unveil(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
      if (!d.bottom) continue;
      const sim = containment(cand, grams(d.bottom));
      if (sim >= SAME_SOUP && (!best || sim > best.sim)) {
        best = { sim, doc: d, file: join(dir, f), hash: f.slice(0, -5), where: dir === VETTED ? 'vetted' : 'in-play' };
      }
    }
  }
  return best;
}

function readDraft(path) {
  if (!path) die('要指定草稿檔');
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch (e) { die('讀不到 ' + path + '：' + e.message); }
  try { return JSON.parse(raw); } catch (e) { die('草稿不是合法 JSON：' + e.message); }
}

/* ── 檢查 ──────────────────────────────
 * 回傳 { ok, errors[], warns[], soup }。errors 非空就是淘汰。
 * 判準從寬：只擋「明顯抓錯」與「不能上線」。
 * 諧音／血腥／獵奇／致鬱／老梗一律放行 —— 玩家有權選自己要的內容。
 */

function inspect(draft) {
  const errors = [], warns = [];
  const push = (code, msg) => errors.push({ code, msg });

  const surface = norm(draft.surface);
  const bottom  = norm(draft.bottom);
  const kind    = norm(draft.kind) || 'normal';
  const source  = norm(draft.source);
  const rawSurface = norm(draft.raw_surface);

  /* 湯麵 */
  if (!surface) push('E_PARSE', '缺 surface（湯麵）');
  else {
    if (chars(surface) > LIM.surface) push('E_PARSE', '湯麵超過 ' + LIM.surface + ' 字');
    if (JUNK.test(surface))   push('E_CHARS', '湯麵含控制字元／零寬字元／雙向控制字元');
    if (URLISH.test(surface)) push('E_CHARS', '湯麵含網址');
    if (MARKUP.test(surface)) push('E_CHARS', '湯麵含疑似標記語言或指令標記');

    // 逐字照抄是這套設計的前提。自報的 verbatim 布林值驗證不了任何事 ——
    // 要有保證就得留下原始抓取文字，讓湯麵必須是它的一段連續子字串。
    //
    // 比對要逐字，不能用 bare()：bare 會把空白全剝掉，抽取時把換行壓成一行也照樣過。
    // 有些謎面的分行是題目的一部分（藏頭、對照、視覺排版），壓掉就等於毀了那一題。
    if (!rawSurface) {
      push('E_PARSE', '缺 raw_surface（原始抓取文字），無法驗證湯麵是否逐字照抄');
    } else {
      const lf = s => s.replace(/\r\n?/g, '\n');
      if (!lf(rawSurface).includes(lf(surface))) {
        push('E_PARSE', bare(rawSurface).includes(bare(surface))
          ? '湯麵的空白或換行跟 raw_surface 對不起來 —— 分行是題目的一部分，要逐字保留\n'
            + '        （原文若本來就是軟斷行，把 raw_surface 也記成你實際採用的樣子）'
          : '湯麵不是 raw_surface 的連續片段 —— 去雜訊可以，改寫不行');
      }
    }
  }

  /* 湯底 */
  if (!bottom) push('E_NO_BOTTOM', '缺 bottom（湯底）');
  else {
    if (chars(bottom) > LIM.bottom) push('E_PARSE', '湯底超過 ' + LIM.bottom + ' 字');
    if (chars(bottom) < BOTTOM_MIN) push('E_NO_BOTTOM', '湯底只有 ' + chars(bottom) + ' 字，判定為抽取失敗');
    if (PLACEHOLDER.test(bottom))   push('E_NO_BOTTOM', '湯底是佔位字串，真正的答案沒有抓到');
    if (bare(bottom) === bare(surface)) push('E_NO_BOTTOM', '湯底只是複述湯麵');
  }

  /* 其餘欄位 */
  if (!KINDS.has(kind)) push('E_PARSE', 'kind 只能是 ' + [...KINDS].join(' / '));
  if (!source) warns.push('沒有記 source，之後查不到出處');

  /* 要素圖 */
  const el = draft.elements;
  let filled = 0, anchoredSlots = 0;
  if (!el || typeof el !== 'object' || Array.isArray(el)) {
    push('E_PARSE', '缺 elements（要素圖）');
  } else {
    const extra = Object.keys(el).filter(k => !SLOTS.includes(k));
    if (extra.length) push('E_PARSE', 'elements 有多餘的格：' + extra.join('、'));

    for (const slot of SLOTS) {
      if (!(slot in el)) { push('E_PARSE', 'elements 缺格：' + slot); continue; }
      const v = el[slot];
      if (v === null) continue;
      if (typeof v !== 'object') { push('E_PARSE', slot + ' 格式不對（要是物件或 null）'); continue; }
      filled++;

      // 方向句可以是一句，也可以是幾句備選（主持時只能從中挑，不自撰）。
      const dirs = (Array.isArray(v['方向']) ? v['方向'] : [v['方向']]).map(norm).filter(Boolean);
      if (!dirs.length) { push('E_PARSE', slot + ' 缺方向句'); continue; }

      for (const dir of dirs) {
        if (chars(dir) > DIR_MAX) push('E_PARSE', slot + ' 的方向句超過 ' + DIR_MAX + ' 字：' + dir);
        if (JUNK.test(dir))       push('E_CHARS', slot + ' 的方向句含不可見字元');

        // 詞彙白名單：方向句只能由固定詞庫與湯麵已有的字組成。
        // 開局時房間裡只有湯麵，所以這裡用湯麵當唯一的曝光來源 —— 過得了這關，
        // 整局任何時候都送得出去。玩到一半才發現方向句用不了是最糟的失敗。
        const off = offVocab(dir, [surface]);
        if (off) push('E_SPOILED', slot + ' 的方向句帶進了固定詞庫與湯麵都沒有的字（「' + off + '」）：' + dir);

        const hit = leaks(dir, bottom, [surface]);
        if (hit) push('E_SPOILED', slot + ' 的方向句抄了湯麵沒有的湯底文字（「' + hit + '」）：' + dir);
      }

      if (typeof v['已揭露'] !== 'boolean') push('E_PARSE', slot + ' 的「已揭露」要是布林值');

      // 觸及詞：這一格被玩家碰到時，提問裡會出現的表面形式（含同義說法）。
      // 主持時用它機械判定觸及／解開，取代原本那個寫多寫少全憑感覺的散文判準。
      const touch = v['觸及詞'];
      if (!Array.isArray(touch) || !touch.length) {
        push('E_PARSE', slot + ' 缺觸及詞（陣列，至少一個），主持時無法判斷這格有沒有被碰到');
      } else if (touch.some(w => !norm(w))) {
        push('E_PARSE', slot + ' 的觸及詞有空字串');
      } else if (!touch.some(w => !VOCAB.has(bare(w)) && bare(bottom).includes(bare(w)))) {
        // 只填「為什麼／理由／動機」這種通用詞的話，玩家隨口一問就算觸及，
        // 那一格永久失效 —— 提示預算被一句廢問題燒掉。至少要有一個詞是這題專屬的：
        // 不在固定詞庫裡，而且真的出現在湯底裡。
        push('E_PARSE', slot + ' 的觸及詞全是通用詞，玩家隨口一問就會誤判成已觸及。\n'
          + '        至少要有一個這題專屬的詞（出現在湯底裡、不在 vocab.mjs 的固定詞庫中）');
      }

      // 錨點詞必須真的在湯麵裡，否則主持人一引用就是憑空生出新資訊。
      // 兩種比對都要過：剝掉標點的版本可能讓跨標點的片段矇混過關。
      const anchors = (Array.isArray(v['錨點詞']) ? v['錨點詞'] : []).map(norm).filter(Boolean);
      if (v['錨點詞'] !== undefined && !Array.isArray(v['錨點詞'])) push('E_PARSE', slot + ' 的錨點詞要是陣列');
      for (const a of anchors) {
        if (!bare(surface).includes(bare(a))) push('E_PARSE', slot + ' 的錨點詞「' + a + '」不在湯麵裡');
        else if (!surface.includes(a)) push('E_PARSE', slot + ' 的錨點詞「' + a + '」在湯麵裡是跨標點的片段，不是可引用的詞');
      }

      // 有錨點卻沒有一句方向用到它，等於白填。引用型提示（「想想他為什麼要開燈」）
      // 遠比範本（「想想動機」）有用，而主持時只能從這裡挑、不准自撰 ——
      // 所以變體必須在採集時就寫進來。
      const usesAnchor = anchors.some(a => dirs.some(d => d.includes(a)));
      if (anchors.length) {
        if (!usesAnchor) push('E_PARSE', slot + ' 有錨點詞卻沒有任何一句方向用到，等於白填');
        else if (dirs.length < 2) push('E_PARSE', slot + ' 只有一句方向。有錨點的格要兩句：一句範本、一句引用錨點的版本');
      }
      if (usesAnchor) anchoredSlots++;
    }
    if (filled < 2) push('E_PARSE', '要素圖只填了 ' + filled + ' 格，至少要 2 格才給得出提示');

    // 全部只用範本的話，每一題的提示都長一樣，等於沒有提示。
    // 這個失敗模式實際發生過：13 題共用同 6 句方向、零錨點引用。
    if (filled >= 2 && anchoredSlots < 2) {
      push('E_PARSE', '只有 ' + anchoredSlots + ' 格提供了引用湯麵詞的方向句，至少要 2 格。\n'
        + '        全用範本的話每題提示都一樣（「想想動機」「想想死法」），玩家得不到東西');
    }
  }

  /* 紅鯡魚：看起來重要、實際無關的詞，主持時永不引用 */
  const herrings = draft['紅鯡魚'];
  if (herrings !== undefined) {
    if (!Array.isArray(herrings)) push('E_PARSE', '紅鯡魚要是陣列');
    else for (const h of herrings) {
      if (!bare(surface).includes(bare(h))) push('E_PARSE', '紅鯡魚「' + h + '」不在湯麵裡');
    }
  }

  const lives = Math.max(6, filled * 3);
  if (lives > LIM.rows) push('E_PARSE', 'lives 推定值超過上限');

  const soup = {
    surface, bottom, lives, kind, source,
    raw_surface: rawSurface,
    elements: el && typeof el === 'object' ? el : null,
    '紅鯡魚': Array.isArray(herrings) ? herrings : [],
    harvested: today(),
  };

  return { ok: errors.length === 0, errors, warns, soup, filled };
}

/* ── 指令 ── */

function report(res, hash) {
  console.log('hash        ' + hash);
  console.log('要素格      ' + res.filled + ' / ' + SLOTS.length + '（lives 推定 ' + res.soup.lives + '）');
  console.log('kind        ' + res.soup.kind);
  for (const w of res.warns)  console.log('⚠  ' + w);
  for (const e of res.errors) console.log('✗  [' + e.code + '] ' + e.msg);
  console.log(res.ok ? '✓ 通過' : '✗ 淘汰（' + res.errors.length + ' 項）');
}

/**
 * 倉裡已經有同一題的別的版本時，判斷該留哪一個。
 * 回傳 { verdict: 'new' | 'old' | 'tie', ours, theirs, sim }。
 */
function compareVariant(soup, variant) {
  const ours   = hintiness(soup.surface, soup.bottom);
  const theirs = hintiness(variant.doc.surface, variant.doc.bottom);
  const gap = ours - theirs;
  // 差距很小就不是「被塞了提示」，只是行文差異 —— 這時當單純重複處理。
  const verdict = Math.abs(gap) < 0.08 ? 'tie' : (gap < 0 ? 'new' : 'old');
  return { verdict, ours, theirs, sim: variant.sim };
}

function reportVariant(cmp, variant) {
  console.log('· 倉裡有同一題的別的版本（湯底重疊 ' + (cmp.sim * 100).toFixed(0) + '%）：' + variant.hash);
  console.log('  湯麵含湯底內容比例　新 ' + (cmp.ours * 100).toFixed(0) + '%　舊 ' + (cmp.theirs * 100).toFixed(0) + '%');
}

function cmdCheck(path) {
  const res = inspect(readDraft(path));
  const hash = hashOf(res.soup.bottom);
  const seen = loadSeen();
  if (seen[hash]) console.log('⚠  湯底完全相同的一題已經在倉裡（狀態 ' + seen[hash].state + '）');

  const variant = findVariant(res.soup.bottom);
  if (variant) {
    const cmp = compareVariant(res.soup, variant);
    reportVariant(cmp, variant);
    console.log(cmp.verdict === 'new' ? '  → add 會用這一版換掉倉裡那版'
      : cmp.verdict === 'old' ? '  → 這一版的湯麵被塞了較多湯底內容，add 會擋下（E_HINTED）'
      : '  → 兩版含蓄程度相當，add 會當成重複擋下（E_DUPE）');
  }

  report(res, hash);
  process.exit(res.ok ? 0 : 1);
}

function cmdAdd(path) {
  ensureDirs();
  const res = inspect(readDraft(path));
  const hash = hashOf(res.soup.bottom);
  const seen = loadSeen();

  if (!res.ok) { report(res, hash); die('沒通過檢查，不入庫。要記錄淘汰請用 reject'); }

  // 同一題的別的版本 —— 這是判斷「被過度提示的改寫版」的唯一時機。
  // 單獨一題看不出湯麵該多含蓄，兩個版本擺在一起就看得出來。
  const variant = findVariant(res.soup.bottom);
  if (variant) {
    const cmp = compareVariant(res.soup, variant);
    reportVariant(cmp, variant);

    if (cmp.verdict === 'old') {
      writeFileSync(join(REJECT, hash + '.veil'), veil({
        code: 'E_HINTED', why: '同題已有更含蓄的版本 ' + variant.hash,
        at: today(), machine: res.errors, draft: res.soup,
      }), 'utf8');
      seen[hash] = { state: 'rejected', code: 'E_HINTED', at: today() };
      saveSeen(seen);
      die('這一版的湯麵含較多湯底內容，判定為被塞了提示的改寫版，不入庫（E_HINTED）');
    }
    if (cmp.verdict === 'tie') {
      die('重複（E_DUPE）：倉裡的 ' + variant.hash + ' 是同一題，含蓄程度也相當');
    }
    if (variant.where !== 'vetted') {
      die('同一題的 ' + variant.hash + ' 正在某個房間裡玩，等那局結束再說');
    }

    // 新的比較含蓄 —— 換掉舊的，舊的收進 rejected 當語料。
    //
    // 湯底照抄、只改寫湯麵的變體 hash 會跟舊版一模一樣。那種情況直接原地換掉，
    // 不能走 rejected 流程 —— 檔名與記帳的 key 都會撞在一起，移過去的紀錄立刻
    // 被入庫覆寫回來，等於什麼都沒做。
    const old = unveil(readFileSync(variant.file, 'utf8'));
    if (variant.hash === hash) {
      console.log('  湯底相同、湯麵不同 —— 原地換成這一版');
    } else {
      writeFileSync(join(REJECT, variant.hash + '.veil'), veil({
        code: 'E_HINTED', why: '同題出現更含蓄的版本 ' + hash,
        at: today(), draft: old,
      }), 'utf8');
      unlinkSync(variant.file);
      seen[variant.hash] = { state: 'rejected', code: 'E_HINTED', at: today() };
      console.log('  已把舊版 ' + variant.hash + ' 移到 rejected');
    }
  } else if (seen[hash]) {
    report(res, hash);
    die('重複（E_DUPE）：這題已經在倉裡，狀態 ' + seen[hash].state);
  }

  writeFileSync(join(VETTED, hash + '.veil'), veil(res.soup), 'utf8');
  seen[hash] = { state: 'vetted', kind: res.soup.kind, lives: res.soup.lives, at: res.soup.harvested };
  saveSeen(seen);
  report(res, hash);
  console.log('✓ 已入庫 vetted/' + hash + '.veil（已遮蔽）');
}

function cmdReject(path, code, why) {
  ensureDirs();
  if (!code) die('要用 --code 指定理由碼');
  const draft = readDraft(path);
  const key = norm(draft.bottom) || norm(draft.surface) || String(Math.random());
  const hash = hashOf(key);
  const seen = loadSeen();

  // 淘汰的也照跑一次檢查。rejected/ 是要拿來回頭修判準的語料，
  // 沒有格式保證的話日後分析得自己防呆 —— 那就違背了留著它的用意。
  const res = inspect(draft);
  writeFileSync(join(REJECT, hash + '.veil'),
    veil({ code, why: norm(why), at: today(), machine: res.errors, warns: res.warns, draft }), 'utf8');
  seen[hash] = { state: 'rejected', code, at: today() };
  saveSeen(seen);
  console.log('✓ 已記錄淘汰 ' + hash + '（' + code + '）'
    + (res.errors.length ? '，另有 ' + res.errors.length + ' 項機器檢查也沒過' : ''));
}

function cmdList() {
  const seen = loadSeen();
  const rows = Object.entries(seen);
  if (!rows.length) return console.log('湯倉是空的。');
  console.log('狀態      數量');
  for (const s of ['vetted', 'served', 'rejected']) {
    console.log(s.padEnd(10) + rows.filter(([, v]) => v.state === s).length);
  }
  console.log('');
  console.log('hash              狀態      kind      lives  日期');
  for (const [h, v] of rows.sort((a, b) => (a[1].at || '').localeCompare(b[1].at || ''))) {
    console.log(h.padEnd(18) + String(v.state).padEnd(10) + String(v.kind || v.code || '').padEnd(10)
      + String(v.lives || '').padEnd(7) + (v.at || ''));
  }
  console.log('\n（刻意不印任何題目內容。要看湯底：peek <hash> <hash>）');
}

/* 指名要哪一題。沒指名就是最舊的一題。
 * --hash 直接點名；--find 比對湯麵 —— 湯麵本來就會進房間，拿它當鑰匙不會多洩什麼，
 * 而且指名的人（使用者、主線）因此不必為了找題目去 peek 湯底。
 * 兩者都只印 hash，任何情況下都不印題目內容。 */
function pickHash(ready, want, find) {
  if (want) {
    if (!ready.some(([h]) => h === want)) die(want + ' 不在未出過的倉存裡（跑 list 看狀態）');
    return want;
  }
  if (find) {
    const key = norm(find);
    const hit = ready.filter(([h]) =>
      norm(unveil(readFileSync(join(VETTED, h + '.veil'), 'utf8')).surface).includes(key));
    if (!hit.length) die('沒有湯麵含「' + find + '」的未出過湯');
    if (hit.length > 1) die('有 ' + hit.length + ' 題的湯麵都含「' + find + '」：'
      + hit.map(([h]) => h).join(' ') + '。改用 --hash 指名一題');
    return hit[0][0];
  }
  return ready[0][0];
}

function cmdTake(name) {
  ensureDirs();
  if (!name) die('要指定房號');
  const seen = loadSeen();
  const ready = Object.entries(seen)
    .filter(([, v]) => v.state === 'vetted')
    .sort((a, b) => (a[1].at || '').localeCompare(b[1].at || ''));
  if (!ready.length) die('倉裡沒有未出過的湯了。跑 /soup-harvest 補貨。');

  const hash = pickHash(ready, flag('hash'), flag('find'));
  const src = join(VETTED, hash + '.veil');
  if (!existsSync(src)) die('記帳說有 ' + hash + '，但檔案不見了：' + src);

  const dst = join(SOUPS, name + '.veil');
  if (existsSync(dst)) die('soups/' + name + '.veil 已經存在，先確認那一局結束了再刪掉它');

  writeFileSync(dst, readFileSync(src, 'utf8'), 'utf8');   // 原封搬過去，不解封、不落地明文
  unlinkSync(src);
  seen[hash] = { ...seen[hash], state: 'served', room: name, served: today() };
  saveSeen(seen);

  console.log('✓ 已取出 ' + hash + ' → soups/' + name + '.veil');
  console.log('  出題：npm run host -- init ' + name + ' --soup soups/' + name + '.veil');
  console.log('  （內容沒有印出來，也沒有解封）');
}

function cmdPeek(a, b) {
  if (!a || !b) die('peek 的 hash 要打兩次，這是刻意的');
  if (a !== b) die('兩次 hash 不一致，不給看');

  const inPlay = existsSync(SOUPS)
    ? readdirSync(SOUPS).filter(f => f.endsWith('.veil')).map(f => join(SOUPS, f)) : [];
  for (const p of [join(VETTED, a + '.veil'), join(REJECT, a + '.veil'), ...inPlay]) {
    if (!existsSync(p)) continue;
    const doc = unveil(readFileSync(p, 'utf8'));
    const key = norm(doc.bottom || (doc.draft && doc.draft.bottom) || '');
    if (p.startsWith(SOUPS + '\\') || p.startsWith(SOUPS + '/')) {
      if (hashOf(key) !== a) continue;
    }
    console.log('⚠ 以下是湯底，你自己要求的。\n');
    console.log(JSON.stringify(doc, null, 2));
    return;
  }
  die('找不到 ' + a);
}

/**
 * 從 vetted/ 與 rejected/ 的檔案重建 .seen.json。
 *
 * .veil 檔才是真相，記帳表是衍生的 —— 多個採集程序同時 add 會互相覆蓋記帳，
 * 但不會動到彼此的檔案。壞掉就重建，並行因此無害。
 */
function cmdReindex() {
  ensureDirs();
  const seen = {};
  const scan = (dir, state) => {
    if (!existsSync(dir)) return 0;
    let n = 0;
    for (const f of readdirSync(dir).filter(x => x.endsWith('.veil'))) {
      let doc;
      try { doc = unveil(readFileSync(join(dir, f), 'utf8')); }
      catch { console.log('⚠  解不開，略過：' + f); continue; }
      seen[f.slice(0, -5)] = state === 'rejected'
        ? { state, code: doc.code || 'E_PARSE', at: doc.at || today() }
        : { state, kind: doc.kind || 'normal', lives: doc.lives, at: doc.harvested || today() };
      n++;
    }
    return n;
  };

  const v = scan(VETTED, 'vetted');
  const r = scan(REJECT, 'rejected');

  // 已經取出去開局的：檔案在 soups/ 底下，hash 用湯底算回來。
  let s = 0;
  for (const f of readdirSync(SOUPS).filter(x => x.endsWith('.veil'))) {
    try {
      const doc = unveil(readFileSync(join(SOUPS, f), 'utf8'));
      seen[hashOf(norm(doc.bottom))] = {
        state: 'served', kind: doc.kind || 'normal', lives: doc.lives,
        at: doc.harvested || today(), room: f.slice(0, -5),
      };
      s++;
    } catch { /* 不是湯檔就略過 */ }
  }

  saveSeen(seen);
  console.log('✓ 已重建記帳表：vetted ' + v + '、rejected ' + r + '、served ' + s);
}

/**
 * 檢查一份要交給使用者的回報有沒有洩題。
 *
 * 「回報不得出現題目內容」原本只寫在 skill 裡，然後就被違反了 —— 跟方向句退化成
 * 套版是同一個病灶：**寫在提示詞裡的規則會被優化掉，只有檢查器要求的才會發生。**
 * 所以把它也變成檢查：拿回報跟倉裡每一題的湯麵湯底比對，重疊就拒收。
 *
 * 門檻壓得很低（3 字），寧可誤報 —— 誤報只要換句話說，漏報是直接爆雷。
 */
const SCRUB_N = 3;

/** 倉裡每一題的湯麵＋湯底，正規化後備用。 */
function scrubCorpus() {
  const corpus = [];
  for (const dir of [VETTED, REJECT, SOUPS]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter(x => x.endsWith('.veil'))) {
      try {
        const d = unveil(readFileSync(join(dir, f), 'utf8'));
        const src = d.draft || d;
        corpus.push({ id: f.slice(0, 8), text: bare(norm(src.surface) + norm(src.bottom)) });
      } catch { /* 解不開就略過 */ }
    }
  }
  return corpus;
}

/** text 裡有哪些片段跟倉存重疊？回傳 片段 → 命中的題目 id。 */
function scrubHits(text, corpus, n = SCRUB_N) {
  const xs = [...bare(text)];
  const hits = new Map();
  for (let i = 0; i + n <= xs.length; i++) {
    const win = xs.slice(i, i + n).join('');
    if (VOCAB.has(win)) continue;
    for (const c of corpus) {
      if (c.text.includes(win)) {
        if (!hits.has(win)) hits.set(win, new Set());
        hits.get(win).add(c.id);
      }
    }
  }
  return hits;
}

/** 掃整個工作目錄，找出夾帶明文題目內容的檔案。 */
const SWEEP_N = 10;
const SWEEP_SKIP = new Set(['node_modules', '.git', '.wrangler', 'soups', 'public']);
function sweepFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SWEEP_SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) sweepFiles(p, out);
    else if (/\.(mjs|js|json|md|txt|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

function cmdScrub(path) {
  // 不給檔名就掃整個工作目錄。採集 subagent 很愛把湯底硬編進暫存腳本再忘記刪掉，
  // 那些明文檔案躺在 tools/ 底下，遮蔽設計等於白做。
  if (!path) {
    const corpus = scrubCorpus();
    if (!corpus.length) die('倉是空的，沒有東西可以比對');
    let dirty = 0;
    for (const f of sweepFiles(ROOT)) {
      if (f.endsWith('soup-pick.mjs') || f.endsWith('vocab.mjs') || f.endsWith('leak.mjs')) continue;
      let n = 0;
      // 掃描用長視窗：短視窗在中文散文與程式註解上誤報爆炸（三字巧合太多）。
      // 硬編進腳本的湯底會有很長的逐字重疊，10 字幾乎不可能是巧合。
      try { n = scrubHits(readFileSync(f, 'utf8'), corpus, SWEEP_N).size; } catch { continue; }
      if (n) { console.log('✗ ' + n + ' 個重疊片段  ' + f.slice(ROOT.length + 1)); dirty++; }
    }
    if (!dirty) return console.log('✓ 工作目錄裡沒有夾帶題目內容的檔案');
    console.log('\n這些檔案含明文題目內容，遮蔽設計對它們無效。確認不需要就刪掉。');
    process.exit(1);
  }

  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) { die('讀不到 ' + path + '：' + e.message); }

  const corpus = scrubCorpus();
  if (!corpus.length) die('倉是空的，沒有東西可以比對');
  const hits = scrubHits(text, corpus);

  if (!hits.size) {
    console.log('✓ 回報裡沒有跟倉存重疊的片段（比對長度 ' + SCRUB_N + ' 字）');
    return;
  }
  console.log('✗ 回報裡有 ' + hits.size + ' 個片段跟倉存重疊，不能就這樣交出去：\n');
  for (const [win, ids] of [...hits].slice(0, 30)) {
    console.log('  「' + win + '」 ← ' + [...ids].join('、'));
  }
  if (hits.size > 30) console.log('  …還有 ' + (hits.size - 30) + ' 個');
  console.log('\n改寫成不涉及內容的講法（數量、格數、hash、理由碼）再送一次。');
  console.log('少數是中文常用詞造成的誤報 —— 誤報換句話說就好，漏報是直接爆雷。');
  process.exit(1);
}

function cmdStats() {
  const seen = loadSeen();
  const codes = {};
  for (const v of Object.values(seen)) if (v.state === 'rejected') codes[v.code] = (codes[v.code] || 0) + 1;
  const total = Object.values(seen).length;
  const rej = Object.values(codes).reduce((a, b) => a + b, 0);
  console.log('總候選 ' + total + '，淘汰 ' + rej + (total ? '（' + Math.round(rej / total * 100) + '%）' : ''));
  for (const [c, n] of Object.entries(codes).sort((a, b) => b[1] - a[1])) console.log('  ' + c.padEnd(14) + n);
}

/* ── 主流程 ── */

const argv = process.argv.slice(2);
const flag = name => {
  const i = argv.indexOf('--' + name);
  return i === -1 ? undefined : argv[i + 1];
};
const pos = (() => {
  const out = [];
  for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith('--')) { i++; continue; } out.push(argv[i]); }
  return out;
})();
const [cmd, ...rest] = pos;

const HELP = `海龜湯 · 湯倉 CLI

  check  <草稿.json>                事實檢查＋要素圖驗證（不入庫）
  add    <草稿.json>                通過就遮蔽入庫
  reject <草稿.json> --code E_XXX --why "…"
  list                              倉存清單（不印任何題目內容）
  take   <房號> [--hash h]          取一題未出過的寫成 soups/<房號>.veil
                [--find 詞]         沒指名就取最舊的；--find 比對湯麵指名一題
  peek   <hash> <hash>              刻意看湯底，hash 要打兩次
  stats                             淘汰理由分佈
  reindex                           從檔案重建記帳表（並行寫壞時用）
  scrub  [回報檔]                   檢查回報有沒有洩題；不給檔名就掃整個工作目錄

  理由碼：E_PARSE E_CHARS E_INJECT E_NO_BOTTOM E_SPOILED E_DUPE E_HINTED

  倉存一律遮蔽。除了 peek，沒有任何指令會印出湯底。`;

switch (cmd) {
  case 'check':  cmdCheck(rest[0]); break;
  case 'add':    cmdAdd(rest[0]); break;
  case 'reject': cmdReject(rest[0], flag('code'), flag('why')); break;
  case 'list':   cmdList(); break;
  case 'take':   cmdTake(rest[0]); break;
  case 'peek':   cmdPeek(rest[0], rest[1]); break;
  case 'stats':  cmdStats(); break;
  case 'reindex': cmdReindex(); break;
  case 'scrub':  cmdScrub(rest[0]); break;
  default:
    console.log(HELP);
    process.exit(cmd ? 1 : 0);
}
