// 轻量用户偏好（localStorage）：主题、一键下载默认格式、搜索历史。
// 全部 try/catch 静默降级 —— WebView 隐私模式下不可用也不影响功能。

const THEME_KEY = 'lyric-workshop.theme';
const TARGET_KEY = 'lyric-workshop.quickTarget';
const HIST_KEY = 'lyric-workshop.history';

const THEMES = ['light', 'dark'];
const TARGETS = ['lrc', 'enhanced-lrc', 'ttml', 'raw'];
const HIST_MAX = 8;

export function getTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (THEMES.includes(saved)) return saved;
  } catch {
    /* fall through */
  }
  try {
    if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) return 'dark';
  } catch {
    /* fall through */
  }
  return 'light';
}

export function setTheme(theme) {
  try {
    if (THEMES.includes(theme)) localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* ignore */
  }
}

export function getQuickTarget() {
  try {
    const saved = localStorage.getItem(TARGET_KEY);
    if (TARGETS.includes(saved)) return saved;
  } catch {
    /* fall through */
  }
  return 'lrc';
}

export function setQuickTarget(target) {
  try {
    if (TARGETS.includes(target)) localStorage.setItem(TARGET_KEY, target);
  } catch {
    /* ignore */
  }
}

export function getHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
    if (Array.isArray(raw)) {
      return raw.filter((x) => typeof x === 'string' && x.trim()).slice(0, HIST_MAX);
    }
  } catch {
    /* fall through */
  }
  return [];
}

export function setHistory(list) {
  try {
    localStorage.setItem(HIST_KEY, JSON.stringify(list.slice(0, HIST_MAX)));
  } catch {
    /* ignore */
  }
}

/** 记一次搜索（去重、最新在前、封顶 HIST_MAX），返回新列表 */
export function pushHistory(list, kw) {
  const q = String(kw || '').trim();
  if (!q) return list;
  const next = [q, ...list.filter((x) => x.toLowerCase() !== q.toLowerCase())];
  return next.slice(0, HIST_MAX);
}
