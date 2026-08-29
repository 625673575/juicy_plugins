/**
 * 时间戳解析工具（移植自 SPlayer-Next src/utils/lyric/timestamp.ts）
 * 支持 LRC / TTML 等多种时间戳格式，可被各歌词解析器复用
 */

/** 最大时间戳（999:59.999） */
export const MAX_TIME = 60039999;

/**
 * 匹配方括号时间戳 [mm:ss.xxx] / [mm:ss:xxx] / [mm:ss.xx] / [mm:ss.x]
 * 使用时注意 lastIndex（全局正则）
 */
export const BRACKET_TIME_RE = /\[(\d+):(\d+)[.:](\d{1,3})\]/g;

/**
 * 匹配尖括号时间戳 <mm:ss.xxx> / <mm:ss:xxx> / <mm:ss.xx> / <mm:ss.x>
 * 使用时注意 lastIndex（全局正则）
 */
export const ANGLE_TIME_RE = /<(\d+):(\d+)(?:[.:](\d{1,3}))?>([^<]*)/g;

/**
 * 将分、秒、毫秒字符串解析为毫秒数，自动归一化毫秒位数（1 位 ×100，2 位 ×10）
 */
export const parseTime = (min, sec, ms, padEndMs = true) => {
  const m = parseInt(min, 10);
  const s = parseInt(sec, 10);
  let millis = parseInt(ms, 10) || 0;
  if (padEndMs) {
    if (ms.length === 1) millis *= 100;
    else if (ms.length === 2) millis *= 10;
  }
  return Math.min(m * 60000 + s * 1000 + millis, MAX_TIME);
};

/**
 * 解析 TTML 时间戳为毫秒数
 * 支持纯秒数 "1.234s"、"[hh:]mm:ss[.fff]"
 */
export const parseTTMLTime = (value) => {
  const text = value.trim();
  if (!text) return 0;
  if (text.endsWith("s") && !text.includes(":")) {
    return Math.round(Number(text.slice(0, -1)) * 1000);
  }
  const parts = text.split(":");
  const last = parts[parts.length - 1] ?? "0";
  const [secStr, fracStr] = last.split(".");
  const sec = Number(secStr || "0");
  const ms = fracStr ? Number(fracStr.padEnd(3, "0").slice(0, 3)) : 0;
  let min = 0;
  let hr = 0;
  if (parts.length === 2) {
    min = Number(parts[0] || "0");
  } else if (parts.length >= 3) {
    hr = Number(parts[0] || "0");
    min = Number(parts[1] || "0");
  }
  return ((hr * 60 + min) * 60 + sec) * 1000 + ms;
};
