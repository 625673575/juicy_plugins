// 单曲保存流程：把歌词写进「目标文件夹」而不是浏览器下载目录。
//
// 目标文件夹的解析顺序：
//   1. 后端已记忆的 targetDir（server/.settings.json，曲库页可改）
//   2. 宿主曲库第一个有曲目的文件夹（自动记忆为默认值）
//   3. 系统「另存为」对话框（showSaveFilePicker，选哪算哪）
// 全都不可用时由调用方回退浏览器下载。
//
// 依赖宿主曲库（通道 3 HTTP API）探测默认目录失败是常态（纯浏览器开发形态
// 没有宿主），因此全部 try/catch 静默降级。

import {
  dirnameOf,
  fetchLibraryFolderTracks,
  fetchLibraryFolders,
  fetchSaveConfig,
  putSaveConfig,
  saveTextTo,
} from './api.js';

/** 解析（必要时自动初始化）目标文件夹；拿不到返回 '' */
export async function ensureTargetDir() {
  try {
    const cfg = await fetchSaveConfig();
    if (cfg.targetDir) return cfg.targetDir;
  } catch {
    return ''; // 后端不在或版本过旧：无法写盘
  }
  // 未设置：借用宿主曲库第一个含曲目的文件夹作为默认保存位置
  try {
    const folders = await fetchLibraryFolders();
    for (const f of folders) {
      const tracks = await fetchLibraryFolderTracks(f.index).catch(() => []);
      const filePath = tracks.find((tr) => tr.filePath)?.filePath;
      if (filePath) {
        const dir = dirnameOf(filePath);
        await putSaveConfig(dir).catch(() => {});
        return dir;
      }
    }
  } catch {
    /* 宿主 API 不可用 */
  }
  return '';
}

const supportsSavePicker = () =>
  typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';

/** 系统「另存为」对话框（需用户手势；取消抛 AbortError） */
export async function saveViaPicker(filename, text) {
  const ext = filename.includes('.') ? filename.split('.').pop() : 'txt';
  const handle = await window.showSaveFilePicker({
    suggestedName: filename,
    types: [{ description: 'Lyrics', accept: { 'text/plain': [`.${ext}`] } }],
  });
  const w = await handle.createWritable();
  await w.write(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  await w.close();
}

/**
 * 单曲保存统一入口（单曲搜索页的导出卡片 / 原文面板共用）。
 * 返回状态对象交由 UI 展示：
 *   {state:'saved', path}  已写入目标文件夹
 *   {state:'picked'}       已通过另存为写入用户所选位置
 *   {state:'cancel'}       用户取消了另存为
 *   {state:'error', msg}   保存失败（调用方可回退浏览器下载）
 */
export async function saveLyric(filename, text) {
  const dir = await ensureTargetDir();
  if (dir) {
    try {
      const res = await saveTextTo(filename, text);
      return { state: 'saved', path: res.path };
    } catch {
      /* 目标文件夹失效等：落到另存为兜底 */
    }
  }
  if (supportsSavePicker()) {
    try {
      await saveViaPicker(filename, text);
      return { state: 'picked' };
    } catch (err) {
      if (err?.name === 'AbortError') return { state: 'cancel' };
      return { state: 'error', msg: err?.message || String(err) };
    }
  }
  return { state: 'error', msg: 'no target folder' };
}
