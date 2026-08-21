/* 湯倉遮蔽層 —— 遮蔽，不是加密。
 *
 * 目的只有一個：讓開發者（同時也是玩家）不會在編輯器、grep、ls 裡不小心
 * 掃到湯底。金鑰就放在版控裡，想解的人一秒就解開 —— 這是刻意的，威脅模型
 * 是手滑，不是攻擊者。
 *
 * 真正會爆雷的管道是主持迴圈把湯底讀進主對話，那條靠 subagent 隔離擋，
 * 不靠這裡。兩件事互相獨立，都要做。
 */

const KEY = 'turtle-soup-pantry-v1';
const HEADER = 'TURTLE-SOUP-VEILED-v1';

// XOR 自反：同一份程式碼負責兩個方向。
function mask(buf) {
  const k = Buffer.from(KEY, 'utf8');
  const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ k[i % k.length];
  return out;
}

export function veil(obj) {
  const body = mask(Buffer.from(JSON.stringify(obj, null, 2), 'utf8')).toString('base64');
  // 折行只是為了別讓編輯器卡在一條無限長的行上。
  const lines = body.match(/.{1,96}/g) || [];
  return HEADER + '\n' + lines.join('\n') + '\n';
}

export function unveil(txt) {
  const lines = String(txt).split(/\r?\n/);
  if (lines[0].trim() !== HEADER) throw new Error('不是遮蔽檔（缺少標頭 ' + HEADER + '）');
  const body = lines.slice(1).join('').trim();
  return JSON.parse(mask(Buffer.from(body, 'base64')).toString('utf8'));
}

export const isVeiled = txt => String(txt).startsWith(HEADER);
