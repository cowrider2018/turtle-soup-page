/* 開房限流：唯一對外公開、可被枚舉的端點就是「開新局」，所以只有它需要按 IP 擋。
   房間本體靠 128 bit 不可猜的 ID 保護，不需要再按 IP 限制加入。 */

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const PER_HOUR = 10;
const PER_DAY = 60;

export class Limiter {
  constructor(state) {
    this.state = state;
  }

  async fetch() {
    const now = Date.now();
    const hits = ((await this.state.storage.get('hits')) || []).filter(t => now - t < DAY);

    const lastHour = hits.filter(t => now - t < HOUR).length;
    if (lastHour >= PER_HOUR || hits.length >= PER_DAY) {
      const retry = lastHour >= PER_HOUR
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

  // 沒人再開房就把自己清乾淨，不留下 IP 相關資料
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
