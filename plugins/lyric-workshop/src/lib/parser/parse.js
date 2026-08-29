/**
 * 解析统一入口（移植自 SPlayer-Next src/utils/lyric/parse.ts）
 * detectFormat 内容嗅探 + parseLyric 主/翻译/音译多轨解析 + pairTranslation 时间对齐
 */

import { parseLRC } from "./parseLRC.js";
import { parseQRC } from "./parseQRC.js";
import { parseYRC } from "./parseYRC.js";
import { parseKRC } from "./parseKRC.js";
import { parseTTML } from "./parseTTML.js";
import { normalizeKangxi } from "./kangxi.js";

/** 默认格式优先级（高到低） */
export const DEFAULT_LYRIC_FORMAT_ORDER = ["ttml", "lys", "qrc", "krc", "yrc", "lrc"];

/**
 * 根据内容特征检测歌词格式（无扩展名场景）
 */
export const detectFormat = (text) => {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("<?xml") || trimmed.startsWith("<")) {
    // 注意：QRC 的 XML 包裹形如 <QrcInfos>，要排在 TTML 判定之前
    if (/LyricContent=|<QrcInfos|<Lyric_/i.test(text)) return "qrc";
    if (trimmed.startsWith("<tt") || /<tt\s/i.test(text)) return "ttml";
  }
  if (/\[\d+,\d+\]\(\d+,\d+,\d+\)/.test(text)) return "yrc";
  if (/\[\d+,\d+\][^[\n]+\(\d+,\d+\)/.test(text)) return "qrc";
  return "lrc";
};

const parseContent = (text, format, preferredLang = "", detectBackground = true) => {
  switch (format) {
    case "ttml":
      return parseTTML(text, preferredLang);
    case "qrc":
      return parseQRC(text, detectBackground);
    case "krc":
      return parseKRC(text, detectBackground);
    case "yrc":
      return parseYRC(text, detectBackground);
    default:
      return parseLRC(text, detectBackground);
  }
};

/**
 * 解析歌词：主歌词 + 可选翻译 / 音译
 * @param input { content, translation?, romaji? } 原始文本
 * @param format 主歌词格式；省略时用 detectFormat 嗅探
 */
export const parseLyric = (input, format, preferredLang = "", options = {}) => {
  const fmt = format || detectFormat(input.content);
  const detectBackground = options.detectBackground !== false;
  const lines = parseContent(normalizeKangxi(input.content), fmt, preferredLang, detectBackground);
  if (input.translation && input.translation.trim()) {
    pairTranslation(
      lines,
      parseContent(normalizeKangxi(input.translation), undefined, "", detectBackground),
      "translatedLyric",
    );
  }
  if (input.romaji && input.romaji.trim()) {
    pairTranslation(
      lines,
      parseContent(normalizeKangxi(input.romaji), undefined, "", detectBackground),
      "romanLyric",
    );
  }
  return lines;
};

/** 对齐容差（毫秒） */
const ALIGN_TOLERANCE_MS = 300;

const lineText = (line) =>
  line.words.map((w) => w.word).join("").trim();

/** 是否为有意义的翻译文本 */
const isMeaningfulTrans = (text) => !!text && text !== "//" && !text.includes("作品的著作权");

/**
 * 将翻译/音译歌词按时间戳对齐到主歌词行（±300ms 容差）
 */
export const pairTranslation = (lines, transLines, field) => {
  const trans = [...transLines].sort((a, b) => a.startTime - b.startTime);
  let i = 0;
  let j = 0;
  while (i < lines.length && j < trans.length) {
    const diff = lines[i].startTime - trans[j].startTime;
    if (Math.abs(diff) <= ALIGN_TOLERANCE_MS) {
      const text = lineText(trans[j]);
      if (isMeaningfulTrans(text)) lines[i][field] = text;
      i++;
      j++;
    } else if (diff < 0) {
      i++;
    } else {
      j++;
    }
  }
};
