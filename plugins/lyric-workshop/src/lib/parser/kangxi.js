/**
 * CJK 同形异码还原（移植自 SPlayer-Next src/utils/lyric/kangxi.ts）
 *
 * NCM 歌词常混入康熙部首（⾔ 实为 言）或 CJK 兼容表意文字，导致字体回退与逐字匹配失配。
 * 仅对这些区间做 NFKC；不动全角字母数字与日文兼容假名。
 */

const COMPAT_RE = /[\u2E80-\u2EFF\u2F00-\u2FDF\uF900-\uFAFF]/g;

export const normalizeKangxi = (text) =>
  text.replace(COMPAT_RE, (char) => char.normalize("NFKC"));
