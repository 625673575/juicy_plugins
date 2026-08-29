/**
 * LRC / ESLRC 解析器（移植自 SPlayer-Next src/utils/lyric/parseLRC.ts）
 * [mm:ss.xx] 整行；尖括号 <mm:ss.xxx> 逐字（ESLRC）；方括号内联逐字也支持；
 * 同时间戳隔行 = 翻译 / 第三行 = 音译
 */

import { BRACKET_TIME_RE, ANGLE_TIME_RE, parseTime, MAX_TIME } from "./timestamp.js";
import { detectBackgroundLine } from "./bg.js";

const META_TAG_RE = /^\[[a-zA-Z]+:/;
const HAS_ANGLE_TAGS = /<\d+:\d+/;

const shouldSkipLine = (line) => {
  if (!line) return true;
  if (META_TAG_RE.test(line)) return true;
  // JSON 行（平台的扩展元数据）
  if (line.startsWith("{")) return true;
  return false;
};

/** 提取行首连续的方括号时间戳 */
const extractHeaderTimes = (line) => {
  BRACKET_TIME_RE.lastIndex = 0;
  const times = [];
  let textStart = 0;
  let match;
  while ((match = BRACKET_TIME_RE.exec(line)) !== null) {
    if (match.index !== textStart) break;
    times.push(parseTime(match[1], match[2], match[3]));
    textStart = BRACKET_TIME_RE.lastIndex;
  }
  return { times, textStart };
};

/** 尝试解析 ESLRC 逐字：<00:00.000>一<00:00.186>句 */
const parseEslrcWords = (content) => {
  if (!HAS_ANGLE_TAGS.test(content)) return null;
  ANGLE_TIME_RE.lastIndex = 0;
  const words = [];
  let match;
  while ((match = ANGLE_TIME_RE.exec(content)) !== null) {
    const startTime = parseTime(match[1], match[2], match[3] ?? "0");
    const wordText = match[4];
    if (!wordText) {
      const lastWord = words[words.length - 1];
      if (lastWord && startTime >= lastWord.startTime) lastWord.endTime = startTime;
      continue;
    }
    words.push({ startTime, endTime: 0, word: wordText });
  }
  if (words.length === 0) return null;
  for (let i = 0; i < words.length - 1; i++) {
    if (words[i].endTime <= words[i].startTime) {
      words[i].endTime = words[i + 1].startTime;
    }
  }
  return words;
};

/** 尝试 LRC 内联逐字：[00:00.000]一[00:00.186]句（同一行内多个时间戳） */
const parseLrcWords = (line) => {
  BRACKET_TIME_RE.lastIndex = 0;
  const words = [];
  let prevTime = -1;
  let prevTextStart = -1;
  let tagCount = 0;
  let match;
  while ((match = BRACKET_TIME_RE.exec(line)) !== null) {
    const time = parseTime(match[1], match[2], match[3]);
    tagCount++;
    if (prevTime >= 0 && prevTextStart >= 0) {
      const word = line.slice(prevTextStart, match.index);
      if (word) words.push({ startTime: prevTime, endTime: time, word });
    }
    prevTime = time;
    prevTextStart = BRACKET_TIME_RE.lastIndex;
  }
  if (tagCount < 2 || words.length === 0) return null;
  if (prevTextStart < line.length) {
    const word = line.slice(prevTextStart);
    if (word) words.push({ startTime: prevTime, endTime: 0, word });
  }
  return words;
};

export const parseLRC = (text, detectBackground = true) => {
  const lines = [];
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (shouldSkipLine(trimmed)) continue;
    const { times, textStart } = extractHeaderTimes(trimmed);
    if (times.length === 0) continue;
    const content = trimmed.slice(textStart);
    if (!content.trim()) {
      for (const t of times) {
        lines.push({
          words: [],
          translatedLyric: "",
          romanLyric: "",
          startTime: t,
          endTime: 0,
          isBG: false,
          isDuet: false,
        });
      }
      continue;
    }
    const eslrcWords = parseEslrcWords(content);
    if (eslrcWords) {
      for (const _ of times) {
        const words = times.length > 1 ? eslrcWords.map((w) => ({ ...w })) : eslrcWords;
        lines.push({
          words,
          translatedLyric: "",
          romanLyric: "",
          startTime: words[0].startTime,
          endTime: words[words.length - 1].endTime,
          isBG: detectBackgroundLine(words, detectBackground),
          isDuet: false,
        });
      }
      continue;
    }
    const lrcWords = parseLrcWords(trimmed);
    if (lrcWords) {
      lines.push({
        words: lrcWords,
        translatedLyric: "",
        romanLyric: "",
        startTime: lrcWords[0].startTime,
        endTime: lrcWords[lrcWords.length - 1].endTime,
        isBG: detectBackgroundLine(lrcWords, detectBackground),
        isDuet: false,
      });
      continue;
    }
    // 回退标准整行模式
    const lineText = content.trim();
    const probeWords = [{ startTime: 0, endTime: 0, word: lineText }];
    const isBG = detectBackgroundLine(probeWords, detectBackground);
    for (const t of times) {
      lines.push({
        words: [{ startTime: t, endTime: 0, word: lineText }],
        translatedLyric: "",
        romanLyric: "",
        startTime: t,
        endTime: 0,
        isBG,
        isDuet: false,
      });
    }
  }
  lines.sort((a, b) => a.startTime - b.startTime);

  // 合并同 startTime 的隔行翻译：第一行为主；第二行 translation；第三行 romaji
  const merged = [];
  for (const line of lines) {
    const prev = merged[merged.length - 1];
    if (prev && prev.startTime === line.startTime) {
      const text = line.words.map((w) => w.word).join("").trim();
      if (!text) continue;
      if (!prev.translatedLyric) prev.translatedLyric = text;
      else if (!prev.romanLyric) prev.romanLyric = text;
      continue;
    }
    merged.push(line);
  }

  // 反向遍历填充 endTime
  let lastStartTime = MAX_TIME;
  for (let i = merged.length - 1; i >= 0; i--) {
    const line = merged[i];
    if (line.endTime <= line.startTime) line.endTime = lastStartTime;
    const lastWord = line.words[line.words.length - 1];
    if (lastWord && lastWord.endTime <= lastWord.startTime) lastWord.endTime = line.endTime;
    if (line.words.length === 1 && line.words[0].endTime <= line.words[0].startTime) {
      line.words[0].endTime = line.endTime;
    }
    lastStartTime = line.startTime;
  }
  return merged;
};
