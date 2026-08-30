// Minimal i18n: English by default; the in-app switch persists zh/en to
// localStorage and the dictionary below keeps the Chinese strings.

const LANG_KEY = 'lyric-workshop.lang';

export function lang() {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'zh' || saved === 'en') return saved;
  } catch {
    /* storage unavailable — fall through */
  }
  return 'en';
}

/** Persist the user's language choice; pass null/undefined to go back to auto. */
export function setLang(l) {
  try {
    if (l === 'zh' || l === 'en') localStorage.setItem(LANG_KEY, l);
    else localStorage.removeItem(LANG_KEY);
  } catch {
    /* ignore */
  }
}

// Dictionary keyed by stable ids. zh is the source (UI 主文案), en mirrors it.
const DICT = {
  zh: {
    'meta.title': '歌词工坊 · 富歌词下载器',
    'meta.desc': '网易云 / QQ音乐 / 酷狗 富歌词下载工具：LRC / QRC / YRC / KRC / TTML，逐字高亮与翻译，支持 LRC、增强 LRC、TTML 导出。',
    'app.title': '歌词工坊',
    'app.sub': 'Rich Lyrics Downloader',
    'status.checking': '连接本地服务…',
    'status.online': '本地服务已连接',
    'status.offline': '离线模式',
    'banner.offline':
      '未检测到本地 API 服务。请在工程目录运行 npm run dev（或 npm run preview）启用平台搜索；当前仍可粘贴歌词解析。',
    'tab.preview': '预览',
    'tab.raw': '原文',
    'tab.export': '导出',
    'search.placeholder': '输入歌名 / 歌手，例如：晴天 周杰伦',
    'search.button': '搜索',
    'search.searching': '搜索中…',
    'search.empty.title': '搜索你想下载的歌词',
    'search.empty.sub': '支持网易云音乐、QQ音乐、酷狗音乐',
    'result.count': '{n} 个结果',
    'lyric.loading': '正在获取歌词…',
    'lyric.miss': '该歌曲在这些平台上没有可用的富歌词，换一首试试，或切换其它平台。',
    'lyric.error': '获取失败：{msg}',
    'chip.wordByWord': '逐字时间轴',
    'chip.translation': '翻译',
    'chip.romaji': '罗马音',
    'chip.ttmlOverlay': 'AMLL TTML 覆盖',
    'source.label': '歌词源',
    'variant.tip': '同一首歌可能有多种格式，点击切换预览/导出对象',
    'play.play': '播放',
    'play.pause': '暂停',
    'opt.translation': '翻译',
    'opt.romaji': '音译',
    'opt.autoscroll': '自动滚动',
    'raw.copy': '复制',
    'raw.copied': '✓ 已复制',
    'raw.download': '下载原始格式',
    'offline.pasteHead': '粘贴歌词文本',
    'offline.pasteSub': 'LRC / QRC / YRC / KRC / TTML 自动识别，翻译同贴即可',
    'offline.parse': '解析',
    'export.head': '导出为…',
    'export.lrc.desc': '标准行级时间轴；有翻译时双语共时间戳输出',
    'export.elrc.desc': 'A2 内联逐字增强格式 <mm:ss.xx>字，保留词级高亮信息',
    'export.ttml.desc': '完整 TTML：逐字 span + 翻译 + 音译 + 背景行嵌套',
    'export.raw.desc': '不动一个字节，直接保存平台下发的 {fmt} 原文',
    'export.size': '{kb} KB · {chars} 字符',
    'export.download': '下载',
    'export.previewTip': '下载前可在「预览」标签确认效果，或到「原文」检查原始内容',
    'err.generic': '出错了：{msg}',
    'misc.noLyric': '暂无歌词',
    'view.single': '单曲搜索',
    'view.batch': '文件夹批量',
    'batch.pick': '选择文件夹',
    'batch.files': '{n} 个音频',
    'batch.platform': '搜索平台',
    'batch.format': '导出格式',
    'batch.overwrite': '覆盖已有歌词',
    'batch.fallback': '全平台回退',
    'batch.fallbackShort': '回退',
    'batch.run': '批量下载缺失歌词',
    'batch.stop': '停止',
    'batch.none': '没有需要下载的歌曲',
    'batch.scanned': '扫描完成：{name} 内 {n} 个音频文件',
    'batch.scanFail': '扫描失败：{msg}',
    'batch.scanning': '正在扫描文件夹…',
    'batch.empty': '选择音乐文件夹开始',
    'batch.emptySub': '扫描后列出缺失歌词的曲目，批量下载并写回同名 .lrc/.ttml',
    'batch.start': '开始批量：{n} 首 · 平台 {platform} · 格式 {format}',
    'batch.cancelled': '已取消',
    'batch.finish': '批量完成：成功 {done}/{total}',
    'batch.st.exists': '已有歌词',
    'batch.st.pending': '缺歌词',
    'batch.st.miss': '未匹配',
    'batch.note.noTitle': '无法从标签或文件名识别标题',
    'batch.note.noMatch': '无匹配候选：{kw}',
    'batch.note.noMatchShort': '未匹配到歌曲',
    'batch.note.noLyric': '该歌曲在平台无歌词',
    'batch.note.noContent': '歌词序列化失败',
    'batch.verify': '写回校验 {file}',
    'batch.unsupported':
      '当前浏览器不支持文件夹写回（File System Access API）。请使用 Edge / Chrome 打开本页选择真实文件夹；此沙盒演示仍可运行。',
    'batch.library': '🎵 曲库文件夹',
    'batch.libLoad': '加载曲目',
    'batch.libLoaded': '已获取曲库文件夹 {n} 个',
    'batch.libFail': '曲库加载失败',
    'batch.libTracks': '曲库 {name}：{n} 首',
    'batch.ctxDownload': '下载歌词（覆盖）',
  },
  en: {
    'meta.title': 'Lyric Studio · Rich Lyrics Downloader',
    'meta.desc': 'Rich lyrics downloader for NetEase / QQ Music / KuGou: LRC / QRC / YRC / KRC / TTML, word-by-word highlighting and translations.',
    'app.title': 'Lyric Studio',
    'app.sub': 'Rich Lyrics Downloader',
    'status.checking': 'Connecting local service…',
    'status.online': 'Local service connected',
    'status.offline': 'Offline mode',
    'banner.offline':
      'Local API not detected. Run `npm run dev` (or `npm run preview`) in this folder to enable platform search; paste-parse still works offline.',
    'tab.preview': 'Preview',
    'tab.raw': 'Raw',
    'tab.export': 'Export',
    'search.placeholder': 'Title / artist, e.g. Gravity',
    'search.button': 'Search',
    'search.searching': 'Searching…',
    'search.empty.title': 'Search lyrics you want to download',
    'search.empty.sub': 'NetEase Cloud Music, QQ Music, KuGou supported',
    'result.count': '{n} results',
    'lyric.loading': 'Fetching lyrics…',
    'lyric.miss': 'No rich lyrics found on these platforms for this track. Try another song or platform.',
    'lyric.error': 'Fetch failed: {msg}',
    'chip.wordByWord': 'Word timing',
    'chip.translation': 'Translation',
    'chip.romaji': 'Romaji',
    'chip.ttmlOverlay': 'AMLL TTML overlay',
    'source.label': 'Lyric source',
    'variant.tip': 'One track can carry several formats — click to switch preview/export target',
    'play.play': 'Play',
    'play.pause': 'Pause',
    'opt.translation': 'Translation',
    'opt.romaji': 'Romanize',
    'opt.autoscroll': 'Auto scroll',
    'raw.copy': 'Copy',
    'raw.copied': '✓ Copied',
    'raw.download': 'Download original format',
    'offline.pasteHead': 'Paste lyric text',
    'offline.pasteSub': 'LRC / QRC / YRC / KRC / TTML auto-detected, translations included as-is',
    'offline.parse': 'Parse',
    'export.head': 'Export as…',
    'export.lrc.desc': 'Standard line-level timeline; bilingual lines share timestamps',
    'export.elrc.desc': 'A2 inline word-level enhanced format <mm:ss.xx>word',
    'export.ttml.desc': 'Full TTML: word spans + translation + roman + nested background lines',
    'export.raw.desc': 'Byte-for-byte original {fmt} delivered by the platform',
    'export.size': '{kb} KB · {chars} chars',
    'export.download': 'Download',
    'export.previewTip': 'Verify in Preview before download, or inspect Raw for the untouched text',
    'err.generic': 'Something went wrong: {msg}',
    'misc.noLyric': 'No lyrics',
    'view.single': 'Single',
    'view.batch': 'Folder batch',
    'batch.pick': 'Pick folder',
    'batch.files': '{n} audio files',
    'batch.platform': 'Platform',
    'batch.format': 'Export as',
    'batch.overwrite': 'Overwrite existing',
    'batch.fallback': 'Fallback to other platforms',
    'batch.fallbackShort': 'fallback',
    'batch.run': 'Download missing lyrics',
    'batch.stop': 'Stop',
    'batch.none': 'Nothing to download',
    'batch.scanned': 'Scanned {name}: {n} audio files',
    'batch.scanFail': 'Scan failed: {msg}',
    'batch.scanning': 'Scanning folder…',
    'batch.empty': 'Pick a music folder to start',
    'batch.emptySub': 'Lists songs missing lyrics, then batch-downloads sidecar .lrc/.ttml next to them',
    'batch.start': 'Batch started: {n} tracks · platform {platform} · format {format}',
    'batch.cancelled': 'Cancelled',
    'batch.finish': 'Batch finished: {done}/{total} succeeded',
    'batch.st.exists': 'Has lyrics',
    'batch.st.pending': 'Missing',
    'batch.st.miss': 'No match',
    'batch.note.noTitle': 'Cannot parse title from tags or filename',
    'batch.note.noMatch': 'No matching candidate: {kw}',
    'batch.note.noMatchShort': 'no match',
    'batch.note.noLyric': 'no lyric on platform',
    'batch.note.noContent': 'serialize failed',
    'batch.verify': 'write-back verified {file}',
    'batch.unsupported':
      'This browser lacks the File System Access API. Use Edge / Chrome to pick a real folder; the sandboxed demo still works.',
    'batch.library': '🎵 Library folders',
    'batch.libLoad': 'Load tracks',
    'batch.libLoaded': 'Loaded {n} library folder(s)',
    'batch.libFail': 'Failed to load library folders',
    'batch.libTracks': 'Library {name}: {n} track(s)',
    'batch.ctxDownload': 'Download lyrics (overwrite)',
  },
};

export function t(key, params) {
  const table = DICT[lang()] ?? DICT.zh;
  let text = table[key] ?? DICT.zh[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, String(v));
    }
  }
  return text;
}
