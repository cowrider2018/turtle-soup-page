/* 管理指令的執行端。
   對外沒有任何路由：指令是我用 wrangler 寫進 KV 的 queue，Cron 醒來時才在這裡執行。
   認證＝我的 Cloudflare 帳號，沒有自製 token，也沒有多開一個可以被打的入口。 */

const ROOM_OPS = new Set(['status', 'dump', 'wipe', 'delete', 'lock', 'unlock']);
const ID = /^[\p{L}\p{N}\p{M}_-]{2,64}$/u;

export async function runCommand(env, job) {
  const cmd = String(job?.cmd || '');
  if (!ROOM_OPS.has(cmd)) return { ok: false, error: 'unknown_cmd: ' + cmd };

  const room = String(job?.room || '').normalize('NFC');
  if (!ID.test(room)) return { ok: false, error: 'bad_room' };

  // 刪房要把房號寫兩次才算數，避免手誤刪錯房
  if (cmd === 'delete' && String(job?.confirm || '').normalize('NFC') !== room) {
    return { ok: false, error: 'delete 需要 confirm 欄位等於房號' };
  }

  const url = new URL('https://room/admin');
  url.searchParams.set('op', cmd);

  const res = await env.ROOM.get(env.ROOM.idFromName(room)).fetch(url);
  const body = await res.json().catch(() => ({ ok: false, error: 'bad_response' }));
  return { room, ...body };
}

/** Cron 進來的入口：把 queue 裡的指令跑完，結果寫回 out:<id>。 */
export async function drainQueue(env) {
  if (!env.CTRL) {
    console.warn('[admin] CTRL KV 未綁定，管理指令佇列未啟用（見 README）');
    return;
  }

  const raw = await env.CTRL.get('queue');
  if (!raw) return;

  let queue;
  try { queue = JSON.parse(raw); } catch { await env.CTRL.delete('queue'); return; }
  if (!Array.isArray(queue) || queue.length === 0) return;

  // 先清空再執行：寧可漏跑也不要因為中途失敗而重複執行 delete 這種指令
  await env.CTRL.delete('queue');

  for (const job of queue.slice(0, 20)) {
    const id = String(job?.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
    if (!id) continue;

    let out;
    try { out = await runCommand(env, job); }
    catch (e) { out = { ok: false, error: String(e && e.message || e) }; }

    // 兩份紀錄：KV 給 CLI 撈回結果，日誌當審計軌跡
    console.log('[admin]', JSON.stringify({ id, cmd: job.cmd, room: job.room, ok: out.ok }));
    await env.CTRL.put('out:' + id, JSON.stringify({ at: new Date().toISOString(), ...out }),
      { expirationTtl: 3600 });
  }
}
