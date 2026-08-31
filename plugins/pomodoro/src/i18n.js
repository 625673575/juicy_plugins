// Minimal i18n: English by default; the in-app switch persists zh/en to
// localStorage (same pattern as lyric-workshop).

const LANG_KEY = 'pomodoro.lang';

export function lang() {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'zh' || saved === 'en') return saved;
  } catch {
    /* storage unavailable — fall through */
  }
  return 'en';
}

/** Persist the user's language choice; pass null/undefined to go back to auto (en). */
export function setLang(l) {
  try {
    if (l === 'zh' || l === 'en') localStorage.setItem(LANG_KEY, l);
    else localStorage.removeItem(LANG_KEY);
  } catch {
    /* ignore */
  }
}

const DICT = {
  en: {
    'app.title': 'Pomodoro',
    'app.sub': 'Stay focused, take breaks',
    'mode.focus': 'Focus',
    'mode.short': 'Short Break',
    'mode.long': 'Long Break',
    'action.start': 'Start',
    'action.pause': 'Pause',
    'action.reset': 'Reset',
    'action.skip': 'Skip',
    'settings.title': 'Settings',
    'settings.focus': 'Focus (min)',
    'settings.short': 'Short break (min)',
    'settings.long': 'Long break (min)',
    'settings.auto': 'Auto-start next round',
    'settings.chime': 'Chime when a round ends',
    'settings.done': 'Done',
    'stats.today': 'focus sessions today',
    'stats.round': 'Round',
    'stats.of': 'of',
    'msg.focusDone': 'Focus complete — take a break!',
    'msg.breakDone': 'Break over — back to focus!',
    'lang.switch': '中文',
  },
  zh: {
    'app.title': '番茄钟',
    'app.sub': '保持专注，记得休息',
    'mode.focus': '专注',
    'mode.short': '短休息',
    'mode.long': '长休息',
    'action.start': '开始',
    'action.pause': '暂停',
    'action.reset': '重置',
    'action.skip': '跳过',
    'settings.title': '设置',
    'settings.focus': '专注时长（分钟）',
    'settings.short': '短休息（分钟）',
    'settings.long': '长休息（分钟）',
    'settings.auto': '自动开始下一轮',
    'settings.chime': '一轮结束时响铃',
    'settings.done': '完成',
    'stats.today': '今日专注轮数',
    'stats.round': '第',
    'stats.of': '/ 4 轮',
    'msg.focusDone': '专注完成，休息一下！',
    'msg.breakDone': '休息结束，继续专注！',
    'lang.switch': 'EN',
  },
};

export function t(key, params) {
  const table = DICT[lang()] ?? DICT.en;
  let text = table[key] ?? DICT.en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, String(v));
    }
  }
  return text;
}
