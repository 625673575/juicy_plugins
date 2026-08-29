/**
 * QRC 逐字歌词解析器（移植自 SPlayer-Next src/utils/lyric/parseQRC.ts）
 *
 * 格式（解密后）：
 *   [start_ms,dur_ms]文字(start_ms,dur_ms)文字(start_ms,dur_ms)...
 * 额外支持 XML 包裹：LyricContent="..." 属性 或 <![CDATA[...]]> 段
 */

import { detectBackgroundLine, splitTrailingBackground } from "./bg.js";

const LINE_HEADER_RE = /^\[(\d+),(\d+)\]/;
const TIMING_RE = /\((\d+),(\d+)\)/;

/**
 * 逐字符解析单行 QRC 字级歌词
 * 文本与时间标记交替出现，只有 `(` 后紧跟数字才是时间标记
 */
const parseWords = (rest) => {
  const words = [];
  let pos = 0;

  while (pos < rest.length) {
    let timingIdx = rest.indexOf("(", pos);
    while (timingIdx !== -1 && timingIdx + 1 < rest.length && !/\d/.test(rest[timingIdx + 1])) {
      timingIdx = rest.indexOf("(", timingIdx + 1);
    }
    if (timingIdx === -1 || timingIdx + 1 >= rest.length) break;

    const timingMatch = TIMING_RE.exec(rest.slice(timingIdx));
    if (!timingMatch) break;

    const start = parseInt(timingMatch[1], 10);
    const dur = parseInt(timingMatch[2], 10);

    // 被跳过的 `(` 是文本中的括号，作为独立字保留
    for (let i = pos; i < timingIdx; i++) {
      if (rest[i] === "(") {
        words.push({ word: "(", startTime: start, endTime: start + dur });
      }
    }

    const wordText = rest.slice(pos, timingIdx).replace(/\(/g, "");
    if (wordText) {
      words.push({ word: wordText, startTime: start, endTime: start + dur });
    }

    pos = timingIdx + timingMatch[0].length;

    // 时间标记后紧跟的 `)` 是文本括号的闭合，保留为独立字
    if (pos < rest.length && rest[pos] === ")") {
      words.push({ word: ")", startTime: start, endTime: start + dur });
      pos++;
    }
  }

  return words;
};

/** 从 XML 包裹中提取纯文本歌词内容（非 XML 原样返回） */
export const extractFromXml = (text) => {
  if (!text.trimStart().startsWith("<")) return text;
  const greedyMatch = text.match(/LyricContent="([\s\S]*)"\s*\/?>/);
  if (greedyMatch) return greedyMatch[1];
  const cdataMatch = text.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  if (cdataMatch) return cdataMatch[1];
  const attrMatch = text.match(/LyricContent="([^"]*)"/);
  if (attrMatch) return attrMatch[1];
  return text;
};

export const parseQRC = (text, detectBackground = true) => {
  const content = extractFromXml(text);
  const lines = [];

  for (const raw of content.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const header = LINE_HEADER_RE.exec(trimmed);
    if (!header) continue;

    const lineStart = parseInt(header[1], 10);
    const lineDur = parseInt(header[2], 10);
    const rest = trimmed.slice(header[0].length);

    const words = parseWords(rest);
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
