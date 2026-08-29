/**
 * KRC 逐字歌词解析器（移植自 SPlayer-Next src/utils/lyric/parseKRC.ts）
 *
 * 格式（已解密）：
 *   [mm:ss.xxx]<offset,dur>字<offset,dur>字...
 * 行头是 LRC 式绝对时间戳；逐字部分 `<相对行首偏移毫秒,时长毫秒>字`
 */

import { parseTime } from "./timestamp.js";
import { detectBackgroundLine } from "./bg.js";

const LINE_HEADER_RE = /^\[(\d+):(\d+)[.:](\d{1,3})\]/;
const WORD_RE = /<(\d+),(\d+)>([^<]*)/g;

export const parseKRC = (text, detectBackground = true) => {
  const lines = [];

  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const header = LINE_HEADER_RE.exec(trimmed);
    if (!header) continue;

    // krc 的第三位永远是毫秒数，如 [01:02.3] 实际是 [01:02.003]，padEndMs=false
    const lineStart = parseTime(header[1], header[2], header[3], false);
    const rest = trimmed.slice(header[0].length);

    WORD_RE.lastIndex = 0;
    const words = [];
    let match;
    let lastEnd = lineStart;
    while ((match = WORD_RE.exec(rest)) !== null) {
      const word = match[3];
      if (!word) continue;
      const offset = parseInt(match[1], 10);
      const dur = parseInt(match[2], 10);
      const start = lineStart + offset;
      const end = start + dur;
      words.push({ word, startTime: start, endTime: end });
      lastEnd = Math.max(lastEnd, end);
    }

    if (words.length === 0) continue;

    lines.push({
      words,
      translatedLyric: "",
      romanLyric: "",
      startTime: lineStart,
      endTime: lastEnd,
      isBG: detectBackgroundLine(words, detectBackground),
      isDuet: false,
    });
  }

  return lines;
};
