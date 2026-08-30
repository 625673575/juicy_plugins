// 后端 API 客户端。
// 开发（vite dev/preview）：同源 /api/*，由本地中间件提供。
// 插件形态（JuicyPlayer 工具窗口）：静态页面没有同源后端，宿主启动
// server/server.mjs 并把端口注入为 window.__JUICY_API_PORT__，这里改走
// http://127.0.0.1:<port>/api/*。
const API_BASE =
  typeof window !== 'undefined' && window.__JUICY_API_PORT__
    ? `http://127.0.0.1:${window.__JUICY_API_PORT__}`
    : '';

async function fetchJson(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json) {
      throw new Error(json?.error || `HTTP ${res.status}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/** 探测本地 API 是否可用（决定在线搜索 or 离线粘贴模式） */
export async function checkHealth() {
  try {
    const json = await fetchJson(`${API_BASE}/api/healthz`, 4000);
    return !!json.ok;
  } catch {
    return false;
  }
}

/**
 * 平台搜索
 * @returns {{total:number, songs:Array<{id,mid,hash,name,artist,album,durationMs}>}}
 */
export async function searchSongs(platform, keyword, limit = 25, page = 1) {
  const url = `${API_BASE}/api/search?platform=${encodeURIComponent(platform)}&keyword=${encodeURIComponent(keyword)}&limit=${limit}&page=${page}`;
  const json = await fetchJson(url);
  if (!json.ok) throw new Error(json.error || 'search failed');
  return json;
}

/**
 * 拉取歌词原文（多格式 variants + 翻译/罗马音 + AMLL TTML 覆盖）
 */
export async function fetchLyric(song) {
  const qs = new URLSearchParams({ platform: song.platform ?? '', id: song.id ?? '' });
  if (song.mid) qs.set('mid', song.mid);
  if (song.hash) qs.set('hash', song.hash);
  if (song.name) qs.set('name', song.name);
  if (song.artist) qs.set('artist', song.artist);
  if (song.album) qs.set('album', song.album);
  if (song.durationMs) qs.set('durationMs', String(Math.round(song.durationMs)));
  const json = await fetchJson(`${API_BASE}/api/lyric?${qs.toString()}`, 20000);
  if (!json.ok) throw new Error(json.error || 'lyric failed');
  return json; // {platform, song, data}
}

/** 触发浏览器下载文本文件 */
export function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // WebView 兜底：隐藏 textarea + execCommand
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;left:-999px';
    document.body.appendChild(ta);
    ta.select();
    let okFlag = false;
    try {
      okFlag = document.execCommand('copy');
    } catch {
      okFlag = false;
    }
    ta.remove();
    return okFlag;
  }
}

// ---------------------------------------------------------------------------
// JuicyPlayer host library (local HTTP API, CORS open; see the repo's
// docs/player-api.md). Port is injected by the host when it differs from the
// default 8080.

const HOST_API_BASE =
  typeof window !== 'undefined' && window.__JUICY_HTTP_PORT__
    ? `http://127.0.0.1:${window.__JUICY_HTTP_PORT__}/api/v1`
    : 'http://127.0.0.1:8080/api/v1';

/** Curated library folders known to the host (sidebar sources). */
export async function fetchLibraryFolders() {
  const json = await fetchJson(`${HOST_API_BASE}/library/folders`, 8000);
  if (json.status !== 'ok') throw new Error(json.message || 'library folders failed');
  return json.data || [];
}

/** Tracks of one library folder (index from fetchLibraryFolders). */
export async function fetchLibraryFolderTracks(index) {
  const json = await fetchJson(`${HOST_API_BASE}/library/folders/${index}/tracks?limit=500`, 12000);
  if (json.status !== 'ok') throw new Error(json.message || 'library tracks failed');
  return json.data || [];
}

export const PLATFORMS = [
  { id: 'netease', label: '网易云' },
  { id: 'qq', label: 'QQ音乐' },
  { id: 'kugou', label: '酷狗' },
];

export const FORMAT_LABELS = {
  yrc: 'YRC 逐字',
  qrc: 'QRC 逐字',
  krc: 'KRC 逐字',
  lys: 'LyS 逐字',
  lrc: 'LRC 行级',
};
