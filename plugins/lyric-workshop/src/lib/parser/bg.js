/**
 * 背景歌词行识别（移植自 SPlayer-Next src/utils/lyric/bg.ts）
 * 括号启发式：整行 (…) 包裹视为背景人声；行尾 (…) 段拆成独立背景行
 */

/** 行首括号（全/半角），允许前导空格 */
const OPEN_PAREN_RE = /^\s*[（(]/;

/** 行尾括号（全/半角） */
const CLOSE_PAREN_RE = /[）)]$/;

const HAN_RE = /\p{Script=Han}/u;
const KANA_ONLY_RE = /^[\p{Script=Hiragana}\p{Script=Katakana}\u30fc\s]+$/u;

const joinedWords = (words) => words.map((word) => word.word).join("");

const stripParens = (text) =>
  text.replace(/^[\s（(]+/, "").replace(/[）)\s]+$/, "").trim();

/** 是否为日文汉字后的假名注音（避免把注音当和声拆掉） */
const isJapaneseRubyTail = (words, openIndex) => {
  const before = joinedWords(words.slice(0, openIndex)).trim();
  const prevChar = Array.from(before).at(-1) ?? "";
  if (!HAN_RE.test(prevChar)) return false;
  const rubyText = stripParens(joinedWords(words.slice(openIndex)));
  return !!rubyText && KANA_ONLY_RE.test(rubyText);
};

/**
 * 检测整行是否为背景人声并就地剥离包裹括号
 * @returns 是否为背景人声行
 */
export const detectBackgroundLine = (words, enabled = true) => {
  if (!enabled) return false;
  if (words.length === 0) return false;
  const first = words[0];
  const last = words[words.length - 1];
  if (!OPEN_PAREN_RE.test(first.word) || !CLOSE_PAREN_RE.test(last.word)) return false;
  first.word = first.word.replace(OPEN_PAREN_RE, "");
  last.word = last.word.replace(CLOSE_PAREN_RE, "");
  return true;
};

/**
 * 把一行里「行尾的 (…) 段」拆成独立的背景人声行
 * @returns 拆出的背景人声行；未命中返回 null
 */
export const splitTrailingBackground = (line, enabled = true) => {
  if (!enabled) return null;
  const words = line.words;
  if (words.length < 2) return null;
  // 整行包裹交给 detectBackgroundLine，这里只管行内尾随
  if (OPEN_PAREN_RE.test(words[0].word)) return null;
  if (!CLOSE_PAREN_RE.test(words[words.length - 1].word)) return null;
  let openIndex = -1;
  for (let index = words.length - 1; index >= 1; index--) {
    if (OPEN_PAREN_RE.test(words[index].word)) {
      openIndex = index;
      break;
    }
  }
  if (openIndex < 1) return null;
  if (isJapaneseRubyTail(words, openIndex)) return null;
  const bgWords = words.slice(openIndex).map((word) => ({ ...word }));
  bgWords[0].word = bgWords[0].word.replace(OPEN_PAREN_RE, "");
  bgWords[bgWords.length - 1].word = bgWords[bgWords.length - 1].word.replace(CLOSE_PAREN_RE, "");
  const cleaned = bgWords.filter((word) => word.word !== "");
  if (cleaned.length === 0) return null;
  line.words = words.slice(0, openIndex);
  line.endTime = line.words[line.words.length - 1].endTime;
  return {
    words: cleaned,
    translatedLyric: "",
    romanLyric: "",
    startTime: cleaned[0].startTime,
    endTime: cleaned[cleaned.length - 1].endTime,
    isBG: true,
    isDuet: false,
  };
};
