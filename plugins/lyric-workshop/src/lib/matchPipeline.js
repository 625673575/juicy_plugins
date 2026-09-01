// 单曲匹配管线：搜索 → 候选打分选优 → 拉词 → 构建导出文本。
// 文件夹批量面板与曲库面板共用；这里只做数据，不碰 UI 状态。

import { PLATFORMS, searchSongs, fetchLyric } from './api.js';
import { pickBestCandidate, buildSearchKeyword } from './match.js';
import { parseLyric } from './parser/parse.js';
import { buildDownloadLyric } from './parser/serialize.js';

export const RAW_EXT = { yrc: 'yrc', qrc: 'qrc', krc: 'krc', lys: 'lys', lrc: 'lrc', ttml: 'ttml' };

/** 导出目标（UI 下拉选项；label 走 i18n，labelEn 为英文直译） */
export const EXPORT_TARGETS = [
  { id: 'lrc', label: 'LRC 双语', labelEn: 'LRC bilingual', ext: 'lrc' },
  { id: 'enhanced-lrc', label: 'Enhanced LRC', labelEn: 'Enhanced LRC', ext: 'lrc' },
  { id: 'ttml', label: 'TTML', labelEn: 'TTML', ext: 'ttml' },
  { id: 'raw', label: 'RAW 原始', labelEn: 'RAW original', ext: null },
];

/** 由歌词载荷构建导出文本：raw 直存最优 variant，其余按 TTML 覆盖 > 平台回传顺序选源再序列化 */
export function buildExport(lyData, target) {
  if (!lyData || !lyData.variants?.length) return null;
  if (target === 'raw') {
    const v = lyData.variants[0];
    return { text: v.content, ext: RAW_EXT[v.format] ?? 'txt' };
  }
  const sources = lyData.variants.map((v) => ({
    format: v.format,
    content: v.content,
    translation: lyData.translation || '',
    romaji: lyData.romaji || '',
  }));
  if (lyData.ttml) {
    sources.push({ format: 'ttml', content: lyData.ttml, translation: '', romaji: '' });
  }
  const source = sources.find((s) => s.format === 'ttml') ?? sources[0];
  let lines;
  try {
    lines = parseLyric(
      { content: source.content, translation: source.translation, romaji: source.romaji },
      source.format
    );
  } catch {
    return null;
  }
  const text = buildDownloadLyric(lines, target);
  if (!text) return null;
  const ext = target === 'ttml' ? 'ttml' : 'lrc';
  return { text, ext };
}

/**
 * 按平台链完成一次 匹配→拉词→构建。
 * @param meta {title, artists:[string], artist, album?, durationMs?}
 * @returns 成功 {status:'ok', best, built, usedPlatform}
 *          失败 {status:'no-match'|'no-lyric'|'no-content'|'error', kw, reasons:[...]}
 */
export async function matchAndBuild({ meta, platform, fallback, format }) {
  const chain = fallback
    ? [platform, ...PLATFORMS.map((p) => p.id).filter((p) => p !== platform)]
    : [platform];
  const reasons = [];
  let last = null;
  for (const platformId of chain) {
    const kw = buildSearchKeyword(meta.title, meta.artists, meta.artist);
    let result;
    try {
      const res = await searchSongs(platformId, kw, 20, 1);
      const best = pickBestCandidate(
        res.songs.map((s) => ({
          name: s.name,
          artist: s.artist,
          album: s.album,
          duration: s.durationMs,
          song: s,
        })),
        meta
      );
      if (!best) {
        result = { status: 'no-match', kw };
      } else {
        const ly = await fetchLyric(best.song);
        if (!ly.data) {
          result = { status: 'no-lyric', kw };
        } else {
          const built = buildExport(ly.data, format);
          result = built ? { status: 'ok', best, built, kw } : { status: 'no-content', kw };
        }
      }
    } catch (err) {
      result = { status: 'error', kw, error: err };
    }
    if (result.status === 'ok') {
      return { ...result, usedPlatform: platformId };
    }
    reasons.push(`${platformId}:${result.status}`);
    last = result;
    if (!fallback) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  return { status: last?.status || 'error', kw: last?.kw || meta.title, reasons };
}
