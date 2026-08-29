/**
 * 歌词序列化（移植自 SPlayer-Next src/utils/lyric/serialize.ts）
 *
 * 走 parse → 重序列化，[ti:]/[ar:] 等信息头天然丢弃：
 *   - lrc          标准 LRC，双语时翻译行共用时间戳
 *   - enhanced-lrc A2 内联逐字增强 <mm:ss.xx>字，翻译降级为整行
 *   - ttml         完整 TTML（原文+翻译+音译+背景嵌套+对唱 agent），可被 parseTTML 回读
 */

import { parseLyric } from "./parse.js";

const pad2 = (value) => String(value).padStart(2, "0");
const pad3 = (value) => String(value).padStart(3, "0");

/** 毫秒 → mm:ss.xx（厘秒，标准 LRC） */
const formatLrcTime = (ms) => {
  const totalCs = Math.round(Math.max(0, ms) / 10);
  const cs = totalCs % 100;
  const totalSec = (totalCs - cs) / 100;
  const sec = totalSec % 60;
  const min = (totalSec - sec) / 60;
  return `${pad2(min)}:${pad2(sec)}.${pad2(cs)}`;
};

/** 毫秒 → mm:ss.mmm（TTML） */
const formatTtmlTime = (ms) => {
  const total = Math.max(0, Math.round(ms));
  const msPart = total % 1000;
  const totalSec = (total - msPart) / 1000;
  const sec = totalSec % 60;
  const min = (totalSec - sec) / 60;
  return `${pad2(min)}:${pad2(sec)}.${pad3(msPart)}`;
};

const lineMainText = (line) =>
  line.words.map((word) => word.word).join("").trim();

/** 逐行 LRC；双语时翻译行紧随主歌词、共用时间戳 */
const toLrc = (lines) => {
  const out = [];
  for (const line of lines) {
    const text = lineMainText(line);
    if (!text) continue;
    const ts = `[${formatLrcTime(line.startTime)}]`;
    out.push(`${ts}${text}`);
    if (line.translatedLyric) out.push(`${ts}${line.translatedLyric}`);
  }
  return out.join("\n");
};

/** 逐字增强 LRC（A2 内联 <mm:ss.xx>）；翻译降级为整行 */
const toEnhancedLrc = (lines) => {
  const out = [];
  for (const line of lines) {
    if (line.words.length === 0) continue;
    const lineTs = `[${formatLrcTime(line.startTime)}]`;
    const body = line.words
      .map((word) => `<${formatLrcTime(word.startTime)}>${word.word}`)
      .join("");
    if (!body.trim()) continue;
    out.push(`${lineTs}${body}`);
    if (line.translatedLyric) out.push(`${lineTs}${line.translatedLyric}`);
  }
  return out.join("\n");
};

const escapeXml = (text) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const wordSpans = (line) =>
  line.words
    .map(
      (word) =>
        `<span begin="${formatTtmlTime(word.startTime)}" end="${formatTtmlTime(word.endTime)}">${escapeXml(word.word)}</span>`,
    )
    .join("");

const roleSpan = (role, text) =>
  text ? `<span ttm:role="${role}">${escapeXml(text)}</span>` : "";

const bgSpan = (bg) =>
  `<span ttm:role="x-bg">${wordSpans(bg)}${roleSpan("x-translation", bg.translatedLyric)}${roleSpan("x-roman", bg.romanLyric)}</span>`;

/** 一行 <p>：主词 + 翻译 + 音译 + 背景行；对唱标 agent */
const paragraph = (main, bgs) => {
  const agent = main.isDuet ? ' ttm:agent="v2"' : "";
  const inner =
    wordSpans(main) +
    roleSpan("x-translation", main.translatedLyric) +
    roleSpan("x-roman", main.romanLyric) +
    bgs.map(bgSpan).join("");
  return `<p begin="${formatTtmlTime(main.startTime)}" end="${formatTtmlTime(main.endTime)}"${agent}>${inner}</p>`;
};

/** 完整 TTML：扁平 LyricLine[] 里背景行紧随主行，按此还原嵌套 */
const toTtml = (lines) => {
  const groups = [];
  for (const line of lines) {
    if (line.isBG && groups.length) groups[groups.length - 1].bg.push(line);
    else groups.push({ main: line, bg: [] });
  }
  const body = groups.map((group) => `      ${paragraph(group.main, group.bg)}`).join("\n");
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:amll="http://www.example.com/ns/amll">',
    "  <body>",
    "    <div>",
    body,
    "    </div>",
    "  </body>",
    "</tt>",
  ].join("\n");
};

/**
 * 把解析后的歌词序列化为目标格式
 * @param target 'lrc' | 'enhanced-lrc' | 'ttml'
 * @returns 歌词文本；无有效内容返回 null
 */
export const buildDownloadLyric = (lines, target) => {
  if (!lines || lines.length === 0) return null;
  let out;
  if (target === "ttml") out = toTtml(lines);
  else if (target === "enhanced-lrc") out = toEnhancedLrc(lines);
  else out = toLrc(lines);
  out = out.trim();
  return out ? out : null;
};

/** 导出时的文件扩展名 */
export const extOfTarget = (target) => {
  if (target === "ttml") return "ttml";
  if (target === "enhanced-lrc") return "lrc";
  return "lrc";
};

/** 便捷：原文 + 翻译 + 罗马音一次性解析 */
export const parseAll = ({ content, translation, romaji }, formatOverride) =>
  parseLyric({ content, translation, romaji }, formatOverride || undefined);

// 保持与 parse 模块的引用一致（供调用方组合使用）
export { parseLyric };
