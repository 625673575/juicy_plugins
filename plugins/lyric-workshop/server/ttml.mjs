/**
 * AMLL TTML DB 抓取（移植自 SPlayer-Next electron/main/apis/common/lyric/ttml.ts）
 *
 * URL 模板默认 https://amlldb.bikonoo.com/%p/%s.ttml
 *   - 网易云 → ncm-lyrics
 *   - QQ     → qq-lyrics（mid 与数字 id 都可能是 key，依次尝试）
 * 正常 GET，200 且非空即命中；404 视为无覆盖。
 */

const TIMEOUT_MS = 8000;
const DEFAULT_TEMPLATE = "https://amlldb.bikonoo.com/%p/%s.ttml";

const inflight = new Map();

async function doFetch(path, id) {
  const url = DEFAULT_TEMPLATE.replace("%p", path).replace("%s", encodeURIComponent(id));
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 200) {
      const content = await res.text();
      return content.trim() ? content : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** 多候选 id 依次尝试，命中即停；inflight 去重 */
export function fetchTTML(platform, ids) {
  const path = platform === "netease" ? "ncm-lyrics" : "qq-lyrics";
  const key = `${path}:${ids.join("|")}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = (async () => {
    for (const id of ids) {
      if (!id) continue;
      const result = await doFetch(path, id);
      if (result) return result;
    }
    return null;
  })().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}
