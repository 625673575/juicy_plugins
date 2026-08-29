/**
 * TTML（Apple Music）歌词解析器（移植自 SPlayer-Next src/utils/lyric/parseTTML.ts）
 *
 * 支持：逐字 span begin/end、背景行 role="x-bg"、对唱 agent、
 * 行内翻译 x-translation / 音译 x-roman、iTunes translations/transliterations 段
 * （含逐词罗马音 ±2ms 快配 + IoU≥10% 对齐）、逐字间有意义空格保留。
 */

import { parseTTMLTime } from "./timestamp.js";

/** 获取元素属性值，兼容命名空间前缀（如 ttm:agent → agent） */
const getAttr = (el, name) => {
  const direct = el.getAttribute(name);
  if (direct !== null) return direct;
  for (const attr of Array.from(el.attributes)) {
    if (attr.localName === name || attr.name.endsWith(":" + name)) {
      return attr.value;
    }
  }
  return null;
};

/** 递归提取 span 中的纯文本，跳过翻译和音译子 span */
const getWordText = (el) => {
  let text = "";
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? "";
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const role = getAttr(node, "role");
      if (role !== "x-translation" && role !== "x-roman") {
        text += getWordText(node);
      }
    }
  }
  return text;
};

/** 收集演唱者 agent：id→type 映射 + 第一个 person 作为主唱 */
const collectAgents = (doc) => {
  const agentTypes = new Map();
  let mainAgent = "";
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    if (el.localName !== "agent") continue;
    const id = el.getAttribute("xml:id") || getAttr(el, "id");
    if (!id) continue;
    const type = el.getAttribute("type") || "";
    agentTypes.set(id, type);
    if (!mainAgent && type === "person") mainAgent = id;
  }
  return { mainAgent: mainAgent || "v1", agentTypes };
};

const stripParens = (text) =>
  text.trim().replace(/^[（(]/, "").replace(/[)）]$/, "").trim();

const normalizeLang = (lang) => (lang ?? "").toLowerCase().replace(/_/g, "-");

/** 从多语言候选中选出最匹配偏好语言的索引 */
const pickLangIndex = (langs, preferred) => {
  if (langs.length === 0) return -1;
  const want = normalizeLang(preferred);
  if (!want) return 0;
  const wantBase = want.split("-")[0];
  let baseMatch = -1;
  let hasTagged = false;
  for (let i = 0; i < langs.length; i++) {
    const lang = normalizeLang(langs[i]);
    if (!lang) continue;
    hasTagged = true;
    if (lang === want) return i;
    if (baseMatch === -1 && lang.split("-")[0] === wantBase) baseMatch = i;
  }
  if (baseMatch !== -1) return baseMatch;
  return hasTagged ? -1 : 0;
};

/** 收集 iTunes 翻译元数据（translations 段中的 text[for] 元素） */
const collectTranslations = (doc, preferredLang) => {
  const candidates = new Map();

  for (const textEl of Array.from(doc.querySelectorAll("text[for]"))) {
    const parent = textEl.parentElement;
    if (!parent || (parent.localName !== "translation" && !parent.closest("translations"))) {
      continue;
    }
    const key = textEl.getAttribute("for");
    if (!key) continue;

    let main = "";
    let bg = "";
    for (const node of Array.from(textEl.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        main += node.textContent ?? "";
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const childEl = node;
        if (getAttr(childEl, "role") === "x-bg") {
          bg += childEl.textContent ?? "";
        } else {
          main += childEl.textContent ?? "";
        }
      }
    }

    main = main.trim();
    bg = stripParens(bg);
    if (!main && !bg) continue;

    const lang = getAttr(parent, "lang");
    const list = candidates.get(key) ?? [];
    list.push({ lang, main, bg });
    candidates.set(key, list);
  }

  const translations = new Map();
  for (const [key, list] of candidates) {
    const idx = pickLangIndex(
      list.map((item) => item.lang),
      preferredLang,
    );
    if (idx !== -1) translations.set(key, { main: list[idx].main, bg: list[idx].bg });
  }
  return translations;
};

/** 收集 iTunes 音译元数据：行级文本 + 带时间戳的逐词条目 */
const collectTransliterations = (doc) => {
  const lines = new Map();
  const words = new Map();

  for (const textEl of Array.from(doc.querySelectorAll("text[for]"))) {
    const parent = textEl.parentElement;
    if (!parent || (parent.localName !== "transliteration" && !parent.closest("transliterations"))) {
      continue;
    }
    const key = textEl.getAttribute("for");
    if (!key) continue;

    const mainWords = [];
    const bgWords = [];
    let lineMain = "";
    let lineBg = "";

    for (const node of Array.from(textEl.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        lineMain += node.textContent ?? "";
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const childEl = node;
        if (getAttr(childEl, "role") === "x-bg") {
          const timedSpans = Array.from(childEl.querySelectorAll("span[begin][end]"));
          if (timedSpans.length > 0) {
            for (const span of timedSpans) {
              bgWords.push({
                startTime: parseTTMLTime(span.getAttribute("begin") ?? ""),
                endTime: parseTTMLTime(span.getAttribute("end") ?? ""),
                text: stripParens(span.textContent ?? ""),
              });
            }
          } else {
            lineBg += childEl.textContent ?? "";
          }
        } else if (childEl.hasAttribute("begin") && childEl.hasAttribute("end")) {
          mainWords.push({
            startTime: parseTTMLTime(childEl.getAttribute("begin") ?? ""),
            endTime: parseTTMLTime(childEl.getAttribute("end") ?? ""),
            text: childEl.textContent ?? "",
          });
        }
      }
    }

    if (mainWords.length > 0 || bgWords.length > 0) {
      words.set(key, { main: mainWords, bg: bgWords });
    }

    lineMain = lineMain.trim();
    lineBg = stripParens(lineBg);
    if (lineMain || lineBg) lines.set(key, { main: lineMain, bg: lineBg });
  }

  return { lines, words };
};

/**
 * 逐词音译对齐：起始时间 ±2ms 快配，失败用时间区间 IoU≥10% 兜底
 * @param words 带时间戳的逐字单词（命中时原地写入 romanWord）
 * @param romanWords 逐词罗马音候选
 */
const alignRomanWords = (words, romanWords) => {
  if (words.length === 0 || romanWords.length === 0) return;
  const FAST_TRACK_TOLERANCE_MS = 2;
  const MIN_IOU = 0.1;
  let searchStart = 0;
  for (const word of words) {
    let bestIou = 0;
    let bestIdx = -1;
    let fastMatched = false;
    for (let idx = searchStart; idx < romanWords.length; idx++) {
      const roman = romanWords[idx];
      if (Math.abs(word.startTime - roman.startTime) <= FAST_TRACK_TOLERANCE_MS) {
        word.romanWord = roman.text;
        searchStart = idx + 1;
        fastMatched = true;
        break;
      }
      const overlapStart = Math.max(word.startTime, roman.startTime);
      const intersection = Math.max(0, Math.min(word.endTime, roman.endTime) - overlapStart);
      if (intersection > 0) {
        const unionStart = Math.min(word.startTime, roman.startTime);
        const union = Math.max(1, Math.max(word.endTime, roman.endTime) - unionStart);
        const iou = intersection / union;
        if (iou > bestIou) {
          bestIou = iou;
          bestIdx = idx;
        }
      }
      if (roman.startTime >= word.endTime) break;
    }
    if (!fastMatched && bestIdx !== -1 && bestIou >= MIN_IOU) {
      word.romanWord = romanWords[bestIdx].text;
      searchStart = bestIdx + 1;
    }
  }
};

/**
 * 解析 TTML 歌词文本
 * @throws XML 解析失败时抛错
 */
export const parseTTML = (text, preferredLang = "") => {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("Invalid TTML XML");
  }

  const { mainAgent, agentTypes } = collectAgents(doc);
  const translations = collectTranslations(doc, preferredLang);
  const transliterations = collectTransliterations(doc);
  const lines = [];

  /** 递归解析段落元素（支持嵌套背景行） */
  const parseParagraph = (el, isBG, isDuet, parentKey) => {
    const begin = getAttr(el, "begin");
    const end = getAttr(el, "end");
    const lineAgent = getAttr(el, "agent");

    const line = {
      words: [],
      translatedLyric: "",
      romanLyric: "",
      isBG,
      // 合唱（type="group"）不算对唱，仅非主唱的个人 agent 才算
      isDuet: isBG
        ? isDuet
        : !!lineAgent && lineAgent !== mainAgent && agentTypes.get(lineAgent) !== "group",
      startTime: begin ? parseTTMLTime(begin) : 0,
      endTime: end ? parseTTMLTime(end) : 0,
    };

    const itunesKey = isBG ? parentKey : getAttr(el, "key");
    if (itunesKey) {
      const trans = translations.get(itunesKey);
      if (trans) line.translatedLyric = isBG ? trans.bg : trans.main;
      const lineRoman = transliterations.lines.get(itunesKey);
      if (lineRoman) line.romanLyric = isBG ? lineRoman.bg : lineRoman.main;
    }

    const romanWordData = itunesKey ? transliterations.words.get(itunesKey) : undefined;
    const availableRomanWords = romanWordData
      ? [...(isBG ? romanWordData.bg : romanWordData.main)]
      : [];
    const timedWords = [];

    let bgCount = 0;
    let lastWasTimedSpan = false;
    const transCandidates = [];

    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        const word = node.textContent ?? "";
        if (word.trim()) {
          line.words.push({ word, startTime: line.startTime, endTime: line.endTime });
          lastWasTimedSpan = false;
        } else if (
          lastWasTimedSpan &&
          word.includes(" ") &&
          !word.includes("\n") &&
          !word.includes("\r")
        ) {
          // 逐字 span 之间有意义的空格，保留为空白单词
          const lastWord = line.words[line.words.length - 1];
          line.words.push({
            word: " ",
            startTime: lastWord?.endTime ?? line.startTime,
            endTime: lastWord?.endTime ?? line.startTime,
          });
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const span = node;
        if (span.localName !== "span") continue;
        const role = getAttr(span, "role");

        if (role === "x-bg") {
          parseParagraph(span, true, line.isDuet, itunesKey);
          bgCount++;
        } else if (role === "x-translation") {
          transCandidates.push({ lang: getAttr(span, "lang"), text: span.textContent?.trim() ?? "" });
        } else if (role === "x-roman") {
          if (!line.romanLyric) line.romanLyric = span.textContent?.trim() ?? "";
        } else {
          const wb = getAttr(span, "begin");
          const we = getAttr(span, "end");
          if (wb && we) {
            const lyricWord = {
              word: getWordText(span),
              startTime: parseTTMLTime(wb),
              endTime: parseTTMLTime(we),
            };
            line.words.push(lyricWord);
            timedWords.push(lyricWord);
            lastWasTimedSpan = true;
          }
        }
      }
    }

    alignRomanWords(timedWords, availableRomanWords);

    if (!line.translatedLyric) {
      const valid = transCandidates.filter((item) => item.text);
      const idx = pickLangIndex(
        valid.map((item) => item.lang),
        preferredLang,
      );
      if (idx !== -1) line.translatedLyric = valid[idx].text;
    }

    // 行级时间未设置时，从逐字时间推断
    if (!begin || !end) {
      const timed = line.words.filter((w) => w.word.trim());
      if (timed.length) {
        line.startTime = Math.min(...timed.map((w) => w.startTime));
        line.endTime = Math.max(...timed.map((w) => w.endTime));
      }
    }

    // 背景歌词去掉首尾括号
    if (isBG && line.words.length) {
      const first = line.words[0];
      if (/^[（(]/.test(first.word)) {
        first.word = first.word.replace(/^[（(]/, "");
        if (!first.word) line.words.shift();
      }
      const last = line.words[line.words.length - 1];
      if (last && /[)）]$/.test(last.word)) {
        last.word = last.word.replace(/[)）]$/, "");
        if (!last.word) line.words.pop();
      }
    }

    // 背景行排在主行后面
    if (bgCount > 0) {
      const bgLines = lines.splice(lines.length - bgCount, bgCount);
      lines.push(line, ...bgLines);
    } else {
      lines.push(line);
    }
  };

  for (const p of Array.from(doc.querySelectorAll("p"))) {
    if (getAttr(p, "begin") && getAttr(p, "end")) {
      parseParagraph(p, false, false, null);
    }
  }

  return lines;
};
