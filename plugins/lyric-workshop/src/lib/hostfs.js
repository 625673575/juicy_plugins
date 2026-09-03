// Native helpers for the plugin: write lyrics next to the audio file and
// check whether a lyric file already exists there.
//
// All of this only works when running inside the JuicyPlayer tool window
// (window.__JUCE__ backend present) AND when the host is new enough to
// register the natives — window.__JUICY_NATIVES__ (injected by the host)
// lists what is available. Everything degrades to null/false otherwise, and
// the caller falls back to browser downloads.

import { callNative, chunkedSave, backendReady } from './native.js';

const LYRIC_EXTS = ['lrc', 'ttml', 'elrc', 'trc', 'krc', 'yrc', 'qrc'];

/** Host-advertised native function names (undefined on older hosts). */
export function hostNatives() {
  if (typeof window === 'undefined') return null;
  const list = window.__JUICY_NATIVES__;
  return Array.isArray(list) ? list : null;
}

export function hasNative(name) {
  const list = hostNatives();
  if (!backendReady()) return false;
  return list ? list.includes(name) : false; // unknown host version → treat as absent
}

/** Whether per-track lyric files can be written next to the audio. */
export function canSaveNextToAudio() {
  return hasNative('toolSaveBegin') && hasNative('toolSaveAppend') && hasNative('toolSaveFinish');
}

/** Whether same-directory lyric detection is available. */
export function canDetectLyricFiles() {
  return hasNative('toolHasLyric');
}

/**
 * Writes `text` next to `audioPath` via the host's chunked-file saver.
 * Returns the final path, or null when unsupported/failed (caller falls back
 * to a browser download).
 */
export async function saveLyricNextToAudio(audioPath, fileName, text) {
  if (!audioPath || !canSaveNextToAudio()) return null;
  const target = audioPath.replace(/[^\\/]+$/, '') + fileName;
  try {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    return await chunkedSave(
      { begin: 'toolSaveBegin', append: 'toolSaveAppend', finish: 'toolSaveFinish', abort: 'toolSaveAbort' },
      [target],
      blob
    );
  } catch {
    return null;
  }
}

/**
 * Returns the extensions of lyric files that already exist next to the audio
 * (e.g. ['.lrc']), or null when detection is unavailable.
 */
export async function existingLyricExts(audioPath, baseName) {
  if (!audioPath || !canDetectLyricFiles()) return null;
  try {
    const r = await callNative('toolHasLyric', audioPath, baseName);
    if (!r || !Array.isArray(r.exists)) return null;
    return r.exists.map((s) => String(s));
  } catch {
    return null;
  }
}

export { LYRIC_EXTS };
