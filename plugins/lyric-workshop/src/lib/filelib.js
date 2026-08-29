// 文件夹扫描 / 音频标签读取 / 歌词写回
// 主通道：File System Access API（showDirectoryPicker，可读可写回）
// 降级：不支持时仍可扫描（OPFS 演示），但写回退化为浏览器逐个下载

export const AUDIO_EXTS = ['mp3', 'flac', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'ape', 'wma'];
export const LYRIC_EXTS = ['lrc', 'elrc', 'ttml', 'krc', 'yrc', 'qrc', 'trc'];

export const supportsDirectoryPicker = () =>
  typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';

/** 弹出系统文件夹选择器（需用户手势），返回可读写句柄；取消返回 null */
export async function pickDirectory() {
  if (!supportsDirectoryPicker()) return null;
  try {
    return await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (err) {
    if (err?.name === 'AbortError') return null;
    throw err;
  }
}

/** OPFS 根目录（演示/自动化测试用：真实可读写的沙盒文件夹） */
export async function getOpfsDirectory() {
  return navigator.storage.getDirectory();
}

/**
 * 递归扫描目录：返回 { audio:[{name, base, ext, path, file, dirHandle}], lyricBases:Set<小写base> }
 * @param dirHandle 目录句柄
 * @param onProgress (scanned:number) 回调
 */
export async function scanDirectory(dirHandle, onProgress, opts = {}) {
  const maxDepth = opts.maxDepth ?? 4;
  const audio = [];
  const lyricBases = new Set();
  let scanned = 0;

  async function walk(handle, prefix, depth) {
    if (depth > maxDepth) return;
    for await (const entry of handle.values()) {
      if (entry.name.startsWith('.')) continue;
      if (entry.kind === 'directory') {
        await walk(entry, prefix ? `${prefix}/${entry.name}` : entry.name, depth + 1);
        continue;
      }
      const dot = entry.name.lastIndexOf('.');
      const ext = dot >= 0 ? entry.name.slice(dot + 1).toLowerCase() : '';
      const base = dot >= 0 ? entry.name.slice(0, dot) : entry.name;
      if (AUDIO_EXTS.includes(ext)) {
        let file = null;
        try {
          file = await entry.getFile();
        } catch {
          /* 文件被占用等：仍列入但读不了标签 */
        }
        audio.push({
          name: entry.name,
          base,
          ext,
          path: prefix ? `${prefix}/${entry.name}` : entry.name,
          file,
          dirHandle: handle,
        });
      } else if (LYRIC_EXTS.includes(ext)) {
        lyricBases.add(base.toLowerCase());
      }
      scanned++;
      if (onProgress && scanned % 20 === 0) onProgress(scanned);
    }
  }

  await walk(dirHandle, '', 0);
  onProgress?.(scanned);
  return { audio, lyricBases, scanned };
}

/** 在某个子目录句柄旁写文本文件；返回实际写入的文件名 */
export async function writeTextNextTo(dirHandle, fileName, text) {
  const fh = await dirHandle.getFileHandle(fileName, { create: true });
  const w = await fh.createWritable();
  await w.write(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  await w.close();
  return fileName;
}

/** 读回刚写入的文件文本（校验用） */
export async function readTextNextTo(dirHandle, fileName) {
  const fh = await dirHandle.getFileHandle(fileName, { create: false });
  return (await fh.getFile()).text();
}

// ---------------------------------------------------------------------------
// 标签读取：MP3 ID3v2.3/2.4 + FLAC（STREAMINFO 时长 + VORBIS_COMMENT）
// 读不到就用文件名解析兜底

const latin1 = new TextDecoder('latin1');
const utf8 = new TextDecoder('utf-8');
const utf16 = new TextDecoder('utf-16');

function decodeTextFrame(bytes, encByte) {
  const body = bytes.subarray(1);
  try {
    if (encByte === 1) return utf16.decode(body).replace(/\0+$/, '');
    if (encByte === 2) return new TextDecoder('utf-16be').decode(body).replace(/\0+$/, '');
    if (encByte === 3) return utf8.decode(body).replace(/\0+$/, '');
    return latin1.decode(body).replace(/\0+$/, '');
  } catch {
    return '';
  }
}

/** ID3v2.3/2.4 标签（covers MP3）。读取失败返回 null */
async function readId3(file) {
  const head = new DataView(await file.slice(0, 10).arrayBuffer());
  if (latin1.decode(new Uint8Array(head.buffer, 0, 3)) !== 'ID3') return null;
  const verMajor = head.getUint8(3);
  const size =
    ((head.getUint8(6) & 0x7f) << 21) |
    ((head.getUint8(7) & 0x7f) << 14) |
    ((head.getUint8(8) & 0x7f) << 7) |
    (head.getUint8(9) & 0x7f);
  const cap = Math.min(size + 10, 6 * 1024 * 1024);
  const buf = new Uint8Array(await file.slice(0, cap).arrayBuffer());
  const out = {};
  let pos = 10;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  while (pos + 10 <= buf.length) {
    const id = latin1.decode(buf.subarray(pos, pos + 4));
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    let frameSize;
    if (verMajor === 4) {
      frameSize =
        ((buf[pos + 4] & 0x7f) << 21) | ((buf[pos + 5] & 0x7f) << 14) | ((buf[pos + 6] & 0x7f) << 7) | (buf[pos + 7] & 0x7f);
    } else {
      frameSize = dv.getUint32(pos + 4);
    }
    if (frameSize <= 0 || pos + 10 + frameSize > buf.length) break;
    const frame = buf.subarray(pos + 10, pos + 10 + frameSize);
    if (id === 'TIT2') out.title = decodeTextFrame(frame, frame[0]);
    else if (id === 'TPE1') out.artist = decodeTextFrame(frame, frame[0]);
    else if (id === 'TALB') out.album = decodeTextFrame(frame, frame[0]);
    else if (id === 'TLEN') {
      const t = parseInt(decodeTextFrame(frame, frame[0]), 10);
      if (Number.isFinite(t) && t > 0) out.durationMs = t;
    }
    pos += 10 + frameSize;
  }
  return out;
}

/** FLAC：STREAMINFO 时长 + VORBIS_COMMENT 标签 */
async function readFlac(file) {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (latin1.decode(head) !== 'fLaC') return null;
  const out = {};
  let pos = 4;
  for (let guard = 0; guard < 16; guard++) {
    const blockHead = new DataView(await file.slice(pos, pos + 4).arrayBuffer());
    const last = (blockHead.getUint8(0) & 0x80) !== 0;
    const type = blockHead.getUint8(0) & 0x7f;
    const len = blockHead.getUint32(0) & 0xffffff;
    if (type === 0 && len >= 34) {
      const si = new Uint8Array(await file.slice(pos + 4, pos + 4 + 18).arrayBuffer());
      const dv = new DataView(si.buffer);
      const sampleRate = (si[10] << 12) | (si[11] << 4) | (si[12] >> 4);
      const totalSamples =
        (si[13] & 0x0f) * 2 ** 32 + dv.getUint32(14) ;
      if (sampleRate > 0 && totalSamples > 0) out.durationMs = Math.round((totalSamples / sampleRate) * 1000);
    } else if (type === 4) {
      const body = new Uint8Array(await file.slice(pos + 4, pos + 4 + len).arrayBuffer());
      const dv = new DataView(body.buffer);
      let p = 0;
      const vlen = dv.getUint32(0);
      p = 4 + vlen;
      if (p + 4 <= body.length) {
        const count = dv.getUint32(p);
        p += 4;
        for (let i = 0; i < count && p + 4 <= body.length; i++) {
          const clen = dv.getUint32(p);
          p += 4;
          const kv = utf8.decode(body.subarray(p, p + clen));
          p += clen;
          const eq = kv.indexOf('=');
          if (eq > 0) {
            const key = kv.slice(0, eq).toUpperCase();
            const val = kv.slice(eq + 1).trim();
            if (key === 'TITLE') out.title = out.title || val;
            else if (key === 'ARTIST' || key === 'ALBUMARTIST') out.artist = out.artist || val;
            else if (key === 'ALBUM') out.album = out.album || val;
          }
        }
      }
    }
    pos += 4 + len;
    if (last) break;
  }
  return out;
}

/** 读音频文件标签；不支持的格式返回 null（调用方走文件名解析） */
export async function readAudioTags(file, ext) {
  if (!file) return null;
  try {
    if (ext === 'mp3') return await readId3(file);
    if (ext === 'flac') return await readFlac(file);
  } catch {
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 文件名解析兜底："01. 歌手 - 标题.mp3" / "歌手 - 标题" / "标题"

export function parseFilename(base) {
  let name = base.replace(/_/g, ' ').trim();
  // 去掉开头音轨号：01. / 01 - / 01_
  name = name.replace(/^\s*\d{1,3}\s*[.\-—_)\]]\s*/, '');
  // 去掉常见杂尾
  name = name.replace(/\s*[(（]\s*(official|mv|lyrics?|audio|hq)\s*[^)）]*[)）]\s*$/i, '');
  // "歌手 - 标题"（第一个分隔符）
  const sep = name.match(/^(.{1,60}?)\s+[-—–]\s+(.+)$/);
  if (sep && sep[1].trim() && sep[2].trim()) {
    return { artist: sep[1].trim(), title: sep[2].trim() };
  }
  return { artist: '', title: name.trim() };
}
