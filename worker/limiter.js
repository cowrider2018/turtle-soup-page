/* 按 IP 限流。對外會被濫用的動作只有兩個：開新局（吃儲存體），以及呼叫 AI 主持
   貼一題新的（吃每天的 AI 額度）。各用一顆以雜湊 IP 命名的物件，額度由呼叫端帶過來。
   房間本體靠 128 bit 不可猜的 ID 保護，不需要再按 IP 限制加入。 */

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const PER_HOUR = 10;
const PER_DAY = 60;

function limit(url, name, fallback) {
  const n = Number(url.searchParams.get(name));
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export class Limiter {
  constructor(state) {
    this.state = state;
  }

  async fetch(req) {
    const url = new URL(req.url);
    const perHour = limit(url, 'h', PER_HOUR);
    const perDay = limit(url, 'd', PER_DAY);

    const now = Date.now();
    const hits = ((await this.state.storage.get('hits')) || []).filter(t => now - t < DAY);

    const lastHour = hits.filter(t => now - t < HOUR).length;
    if (lastHour >= perHour || hits.length >= perDay) {
      const retry = lastHour >= perHour
        ? Math.ceil((HOUR - (now - hits[hits.length - lastHour])) / 1000)
        : Math.ceil((DAY - (now - hits[0])) / 1000);
      await this.state.storage.put('hits', hits);
      return Response.json({ ok: false, retryAfter: Math.max(retry, 1) }, { status: 429 });
    }

    hits.push(now);
    await this.state.storage.put('hits', hits);
    await this.state.storage.setAlarm(now + DAY + HOUR);
    return Response.json({ ok: true });
  }

  // 沒人再用就把自己清乾淨，不留下 IP 相關資料
  async alarm() {
    const now = Date.now();
    const hits = ((await this.state.storage.get('hits')) || []).filter(t => now - t < DAY);
    if (hits.length === 0) await this.state.storage.deleteAll();
    else {
      await this.state.storage.put('hits', hits);
      await this.state.storage.setAlarm(now + DAY);
    }
  }
}
