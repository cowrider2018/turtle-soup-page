/* 洩底檢查 —— 採集期驗方向詞、主持期驗提示註解，共用同一份實作。
 *
 * 規則不是「跟湯底重疊就退」，而是「**帶進了房間裡還沒有的湯底文字**才退」。
 * 房間裡已經出現過的字（湯麵、已回答的提問）人人都看得到，提示引用它們是
 * 刻意的設計 —— 「想想他為什麼要開燈」比「想想動機」有用得多。
 *
 * 做法是先把註解裡「引用自房間」的片段整段扣掉，剩下的殘料才拿去跟湯底比對。
 * 直接用視窗比對會誤判：註解把「男子」改寫成「他」，視窗跨在改寫處與引用處的
 * 交界上就會命中，但那一段其實沒有帶進任何新資訊。
 */

export const NGRAM = 6;   // 帶進新湯底文字的容忍長度
export const QUOTE = 4;   // 從房間引用多長才算引用（低於此視為巧合）

// 比對前先把空白與標點拿掉：換個標點就繞過去的檢查沒有意義。
export const bare = s => String(s).normalize('NFC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

const SEP = '\u0000';

/** 把 note 裡所有「在 pub 裡找得到、且長度 >= QUOTE」的片段挖掉，換成分隔符。 */
function stripQuoted(note, pub, minq) {
  const xs = [...note];
  const out = [];
  let i = 0;
  while (i < xs.length) {
    let hit = 0;
    for (let len = Math.min(xs.length - i, 64); len >= minq; len--) {
      if (pub.includes(xs.slice(i, i + len).join(''))) { hit = len; break; }
    }
    if (hit) { out.push(SEP); i += hit; }
    else { out.push(xs[i]); i++; }
  }
  return out.join('');
}

/**
 * note 有沒有把湯底裡尚未曝光的文字帶進房間？
 * @param {string}   note     要送出的提示
 * @param {string}   bottom   湯底
 * @param {string[]} exposed  房間裡已經出現過的字串（湯麵＋已答提問）
 * @returns {string|null}     命中的片段，沒命中回 null
 */
export function leaks(note, bottom, exposed = [], n = NGRAM) {
  const b = bare(bottom);
  // SEP 當分隔，避免兩段曝光文字接起來湊出一段假的「已曝光」。
  const pub = exposed.map(bare).filter(Boolean).join(SEP);
  const residue = stripQuoted(bare(note), pub, QUOTE);

  for (const frag of residue.split(SEP)) {
    const xs = [...frag];
    if (xs.length < n) continue;
    for (let i = 0; i + n <= xs.length; i++) {
      const win = xs.slice(i, i + n).join('');
      if (b.includes(win)) return win;
    }
  }
  return null;
}
