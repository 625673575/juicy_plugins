/**
 * YRC 逐字歌词解析器（移植自 SPlayer-Next src/utils/lyric/parseYRC.ts）
 *
 * 格式：
 *   [start_ms,dur_ms](start_ms,dur_ms,0)文字(start_ms,dur_ms,0)文字...
 * 时间在前文字在后（与 QRC 相反）
 */

import { detectBackgroundLine, splitTrailingBackground } from "./bg.js";

const LINE_HEADER_RE = /^\[(\d+),(\d+)\]/;
const WORD_RE = /\((\d+),(\d+),\d+\)([^(]*)/g;

export const parseYRC = (text, detectBackground = true) => {
  const lines = [];

  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const header = LINE_HEADER_RE.exec(trimmed);
    if (!header) continue;

    const lineStart = parseInt(header[1], 10);
    const lineDur = parseInt(header[2], 10);
    const rest = trimmed.slice(header[0].length);

    WORD_RE.lastIndex = 0;
    const words = [];
    let match;
    while ((match = WORD_RE.exec(rest)) !== null) {
      const start = parseInt(match[1], 10);
      const dur = parseInt(match[2], 10);
      words.push({ word: match[3], startTime: start, endTime: start + dur });
    }

    if (words.length === 0) continue;

    const line = {
      words,
      translatedLyric: "",
      romanLyric: "",
      startTime: lineStart,
      endTime: lineStart + lineDur,
      isBG: false,
      isDuet: false,
    };
    line.isBG = detectBackgroundLine(words, detectBackground);
    lines.push(line);
    if (!line.isBG) {
      const bg = splitTrailingBackground(line, detectBackground);
      if (bg) lines.push(bg);
    }
  }

  return lines;
};
