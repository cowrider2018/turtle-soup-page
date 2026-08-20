#!/usr/bin/env node
/* 海龜湯管理 CLI
 *
 * 沒有管理端點、沒有自製 token。認證就是你的 Cloudflare 帳號（wrangler login）。
 *
 *   freeze / unfreeze  直接寫 KV 旗標（全站，比較鈍的工具）
 *   其餘               排進 KV 的 queue，Cron 每分鐘取走執行，結果寫回 out:<id>
 *
 * 用法：
 *   npm run soup -- lock <房號>
 *   npm run soup -- unlock <房號>
 *   npm run soup -- freeze | unfreeze | flags
 *   npm run soup -- status <房號>
 *   npm run soup -- dump <房號> [檔名]
 *   npm run soup -- wipe <房號>
 *   npm run soup -- delete <房號> <房號>        # 房號要打兩次
 *
 * 加 --local 就對 wrangler dev 的本機 KV 操作。
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync, mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const LOCAL = argv.includes('--local');
const args = argv.filter(a => a !== '--local');
const [cmd, ...rest] = args;

const ID = /^[\p{L}\p{N}\p{M}_-]{2,64}$/u;
const WAIT_MS = 150000;   // Cron 每分鐘跑一次，等兩輪半

/* ── wrangler kv 包裝 ─────────────────── */

// 直接用 node 跑 wrangler 的進入點：不經過 shell，房號裡的中文與 JSON 裡的引號
// 就不會被 cmd.exe 的引號規則或編碼吃掉。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = (() => {
  const pkg = join(ROOT, 'node_modules', 'wrangler', 'package.json');
  if (!existsSync(pkg)) die('找不到 wrangler，先跑 npm install');
  const bin = JSON.parse(readFileSync(pkg, 'utf8')).bin;
  const rel = typeof bin === 'string' ? bin : bin.wrangler;
  return join(ROOT, 'node_modules', 'wrangler', rel);
})();

function kv(sub, ...rest) {
  const scope = LOCAL ? '--local' : '--remote';
  const r = spawnSync(process.execPath,
    [WRANGLER, 'kv', 'key', sub, '--binding=CTRL', scope, ...rest],
    { encoding: 'utf8', cwd: ROOT });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

// key 不存在時 wrangler 會印 "Value not found" 而且回傳成功，不能直接當成內容
const MISSING = /^Value not found/i;
function kvGet(key) {
  const r = kv('get', key);
  const has = r.ok && r.out && !MISSING.test(r.out);
  return { ...r, value: has ? r.out : null };
}
const kvDel = key => kv('delete', key);

// 值一律走暫存檔（--path），不當成命令列參數傳
function kvPut(key, value) {
  const dir = mkdtempSync(join(tmpdir(), 'soup-'));
  const file = join(dir, 'value');
  try {
    writeFileSync(file, value, 'utf8');
    const r = kv('put', key, '--path=' + file);
    if (!r.ok) die('寫入 KV 失敗：\n' + (r.err || r.out));
    return r;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function die(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

function room(v, what = '房號') {
  const s = String(v || '').normalize('NFC');
  if (!ID.test(s)) die(what + '格式不對（文字／數字／_／-，2 到 64 個字）：' + JSON.stringify(v || ''));
  return s;
}

/* ── 全站凍結：唯一還放在 KV 的旗標 ──── */

function setFrozen(on) {
  if (on) kvPut('frozen', '1');
  else {
    const r = kvDel('frozen');
    if (!r.ok && !/not found|does not exist/i.test(r.err + r.out)) die('清除旗標失敗：\n' + (r.err || r.out));
  }
  console.log('✓ ' + (on ? '已全站停寫' : '已解除全站停寫'));
  console.log('  新連線與新房間立即生效；已經開著的房間會在下次醒來時跟上。');
  console.log('  要立刻擋住某一間，用 lock <房號>。');
}

function showFlags() {
  console.log('全站凍結：' + (kvGet('frozen').value === '1' ? '是' : '否'));
  console.log('（鎖房狀態存在各房自己的 DO 裡，沒有清單可列 —— 這是刻意的，見 README）');
  console.log('（單一房間的狀態用 status <房號> 查）');
}

/* ── 指令佇列 ───────────────────────── */

async function enqueue(job) {
  let queue = [];
  const cur = kvGet('queue').value;
  if (cur) {
    try { queue = JSON.parse(cur); } catch { queue = []; }
    if (!Array.isArray(queue)) queue = [];
  }

  const id = randomUUID().replace(/-/g, '').slice(0, 16);
  queue.push({ id, ...job });
  kvPut('queue', JSON.stringify(queue));

  console.log('→ 已排入指令 ' + job.cmd + ' ' + (job.room || '') + '（id ' + id + '）');
  console.log('  Cron 每分鐘取走一次，等結果…');

  const started = Date.now();
  while (Date.now() - started < WAIT_MS) {
    await new Promise(r => setTimeout(r, 10000));
    const out = kvGet('out:' + id).value;
    if (out) {
      kvDel('out:' + id);
      try { return JSON.parse(out); }
      catch { die('結果不是合法 JSON：' + out); }
    }
    process.stdout.write('.');
  }
  console.log('');
  die('等了 ' + Math.round(WAIT_MS / 1000) + ' 秒還沒有結果。\n'
    + '  用 npx wrangler tail 看看 Cron 有沒有跑，或稍後用 npx wrangler kv key get '
    + '--binding=CTRL --remote out:' + id + ' 自己撈。');
}

function report(res) {
  console.log('');
  if (res.ok === false) die(res.error || '執行失敗');
  console.log(JSON.stringify(res, null, 2));
}

/* ── 主流程 ─────────────────────────── */

const HELP = `海龜湯管理 CLI

  lock <房號>          單房唯讀：寫入與清空全擋，讀取照常
  unlock <房號>        解鎖
  freeze               全站停止寫入，並停止長出新房間
  unfreeze             解除
  flags                看全站旗標

  status <房號>        在線人數、鎖房狀態、rev、大小
  dump <房號> [檔名]    匯出整份文件（房間要有人在線）
  wipe <房號>          強制清空
  delete <房號> <房號>  踢掉所有人並清除鎖房狀態，房號要打兩次

  加 --local 對本機 wrangler dev 的 KV 操作

  註：文件不落地，所以沒有快照與還原。房間沒人在線就沒有內容。`;

switch (cmd) {
  case 'freeze':
    setFrozen(true);
    break;
  case 'unfreeze':
    setFrozen(false);
    break;
  case 'flags':
    showFlags();
    break;

  case 'lock':
  case 'unlock':
  case 'status':
  case 'wipe':
    report(await enqueue({ cmd, room: room(rest[0]) }));
    break;

  case 'delete': {
    const a = room(rest[0]), b = room(rest[1], '第二次的房號');
    if (a !== b) die('兩次房號不一致，為了避免刪錯房，這裡不接受');
    report(await enqueue({ cmd, room: a, confirm: b }));
    break;
  }

  case 'dump': {
    const res = await enqueue({ cmd, room: room(rest[0]) });
    if (res.ok === false) die(res.error || '執行失敗');
    const file = rest[1] || ('dump-' + room(rest[0]) + '-' + Date.now() + '.json');
    writeFileSync(file, JSON.stringify(res.doc, null, 2), 'utf8');
    console.log('\n✓ 已寫入 ' + file);
    break;
  }

  default:
    console.log(HELP);
    process.exit(cmd ? 1 : 0);
}
