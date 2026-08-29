import React, { useCallback, useEffect, useRef, useState } from 'react';
import { PLATFORMS, searchSongs, fetchLyric, downloadText } from './lib/api.js';
import { parseLyric } from './lib/parser/parse.js';
import { buildDownloadLyric } from './lib/parser/serialize.js';
import { pickBestCandidate, buildSearchKeyword } from './lib/match.js';
import {
  pickDirectory,
  getOpfsDirectory,
  scanDirectory,
  readAudioTags,
  parseFilename,
  writeTextNextTo,
  readTextNextTo,
  supportsDirectoryPicker,
} from './lib/filelib.js';
import { t as tx } from './i18n.js';

const t = tx;

const RAW_EXT = { yrc: 'yrc', qrc: 'qrc', krc: 'krc', lys: 'lys', lrc: 'lrc', ttml: 'ttml' };

const EXPORT_TARGETS = [
  { id: 'lrc', label: 'LRC 双语', ext: 'lrc' },
  { id: 'enhanced-lrc', label: 'Enhanced LRC', ext: 'lrc' },
  { id: 'ttml', label: 'TTML', ext: 'ttml' },
  { id: 'raw', label: 'RAW 原始', ext: null },
];

const BATCH_PARAMS =
  typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();

/** 由歌词载荷构建导出文本：raw 直存最优 variant，其余按 SPlayer 优先级选源再序列化 */
function buildExport(lyData, target) {
  if (!lyData || !lyData.variants?.length) return null;
  if (target === 'raw') {
    const v = lyData.variants[0];
    return { text: v.content, ext: RAW_EXT[v.format] ?? 'txt' };
  }
  // 选源：TTML 覆盖优先，其次按平台回传顺序（服务器已按 yrc/qrc/krc > lrc 排好）
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

// ---------------------------------------------------------------- 演示种子

function synchsafe(n) {
  return [ (n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f ];
}
function id3TextFrame(id, text) {
  const enc = new Uint8Array([3]); // UTF-8
  const body = new TextEncoder().encode(text);
  const size = body.length + 1;
  const head = new Uint8Array(10);
  head.set(new TextEncoder().encode(id), 0);
  head.set(synchsafe(size), 4);
  const out = new Uint8Array(10 + size);
  out.set(head, 0);
  out.set(enc, 10);
  out.set(body, 11);
  return out;
}
/** 造一个带 ID3v2.4 标签的假 mp3（标签链路真实可读，音频体是占位） */
function makeTaggedMp3({ title, artist, album, durMs }) {
  const frames = [
    id3TextFrame('TIT2', title),
    id3TextFrame('TPE1', artist),
    id3TextFrame('TALB', album),
    id3TextFrame('TLEN', String(durMs)),
  ];
  const framesLen = frames.reduce((a, f) => a + f.length, 0);
  const pad = 256;
  const head = new Uint8Array(10);
  head.set(new TextEncoder().encode('ID3'), 0);
  head[3] = 4; // v2.4
  head.set(synchsafe(framesLen + pad), 6);
  const body = new Uint8Array(framesLen + pad);
  let off = 0;
  for (const f of frames) {
    body.set(f, off);
    off += f.length;
  }
  const out = new Uint8Array(10 + body.length);
  out.set(head, 0);
  out.set(body, 10);
  return out;
}

async function seedDemoFolder(root, log) {
  // 每次演示重建目录，保证可重复
  await root.removeEntry('Demo 音乐', { recursive: true }).catch(() => {});
  const dir = await root.getDirectoryHandle('Demo 音乐', { create: true });
  // 1) 带 ID3 标签（真实标签读取路径）
  const mp3 = makeTaggedMp3({ title: '晴天', artist: '周杰伦', album: '叶惠美', durMs: 236940 });
  {
    const fh = await dir.getFileHandle('01. 周杰伦 - 晴天.mp3', { create: true });
    const w = await fh.createWritable();
    await w.write(mp3);
    await w.close();
  }
  // 2) 无标签 → 走文件名解析
  {
    const fh = await dir.getFileHandle('陈奕迅 - 孤勇者.flac', { create: true });
    const w = await fh.createWritable();
    await w.write(new Uint8Array([0x66, 0x4c, 0x61, 0x43, 0, 0, 0, 0]));
    await w.close();
  }
  // 3) 已有同名 .lrc → 应标记「已有歌词」
  {
    const fh = await dir.getFileHandle('02. 五月天 - 温柔.mp3', { create: true });
    const w = await fh.createWritable();
    await w.write(new Uint8Array([0, 0, 0, 0]));
    await w.close();
    const lh = await dir.getFileHandle('02. 五月天 - 温柔.lrc', { create: true });
    const lw = await lh.createWritable();
    await lw.write('[00:00.00]existing lyric');
    await lw.close();
  }
  log('✓ 演示文件夹已就绪（OPFS 沙盒，含 3 个文件，其中 1 个已有歌词）');
  return dir;
}

// ---------------------------------------------------------------- 组件

const S = {
  PENDING: 'pending',
  EXISTS: 'exists',
  MATCHING: 'matching',
  WRITING: 'writing',
  DONE: 'done',
  MISS: 'miss',
  ERROR: 'error',
};

export default function BatchPanel({ health }) {
  const [dirName, setDirName] = useState('');
  const [items, setItems] = useState([]); // {key,name,base,ext,path,file,dirHandle,state,note,fileName}
  const [scanning, setScanning] = useState(false);
  const [platform, setPlatform] = useState(
    PLATFORMS.some((p) => p.id === BATCH_PARAMS.get('bplatform')) ? BATCH_PARAMS.get('bplatform') : 'netease'
  );
  const [format, setFormat] = useState(
    EXPORT_TARGETS.some((f) => f.id === BATCH_PARAMS.get('bformat')) ? BATCH_PARAMS.get('bformat') : 'lrc'
  );
  const [overwrite, setOverwrite] = useState(false);
  const [fallback, setFallback] = useState(true);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, current: '' });
  const [logs, setLogs] = useState([]);
  const [unsupported, setUnsupported] = useState(false);

  const itemsRef = useRef([]);
  const cancelRef = useRef(false);
  const demoBootedRef = useRef(false);
  itemsRef.current = items;

  const log = useCallback((line) => {
    setLogs((prev) => [...prev.slice(-199), line]);
  }, []);

  /** 更新某行状态 */
  const patchItem = useCallback((key, patch) => {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  }, []);

  // ---- 扫描 ----
  const applyDir = useCallback(
    async (dirHandle, label) => {
      setDirName(label || dirHandle.name);
      setScanning(true);
      setItems([]);
      try {
        const { audio, lyricBases } = await scanDirectory(dirHandle);
        const mapped = audio.map((a, i) => ({
          ...a,
          key: `${a.path}#${i}`,
          state: lyricBases.has(a.base.toLowerCase()) ? S.EXISTS : S.PENDING,
        }));
        mapped.sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN'));
        setItems(mapped);
        log(`✓ ${t('batch.scanned', { n: mapped.length, name: dirHandle.name })}`);
      } catch (err) {
        log(`⚠ ${t('batch.scanFail', { msg: err?.message || err })}`);
      } finally {
        setScanning(false);
      }
    },
    [log]
  );

  const onPickFolder = useCallback(async () => {
    if (running) return;
    try {
      const dir = await pickDirectory();
      if (!dir) return;
      await applyDir(dir);
    } catch (err) {
      log(`⚠ ${err?.message || err}`);
    }
  }, [applyDir, log, running]);

  // ---- 批量执行 ----
  const runBatch = useCallback(async () => {
    const cur = itemsRef.current;
    const targets = cur.filter((it) =>
      overwrite || it.state === S.PENDING || it.state === S.MISS || it.state === S.ERROR
    );
    const pending = targets.filter((it) => it.state !== S.EXISTS);
    if (pending.length === 0) {
      log(t('batch.none'));
      return;
    }
    setRunning(true);
    cancelRef.current = false;
    setProgress({ done: 0, total: pending.length, current: '' });
    log(
      `▶ ${t('batch.start', {
        n: pending.length,
        platform: fallback ? `${platformLabel(platform)}+${t('batch.fallbackShort')}` : platformLabel(platform),
        format,
      })}`
    );

    const platformChain = fallback
      ? [platform, ...PLATFORMS.map((p) => p.id).filter((p) => p !== platform)]
      : [platform];

    /** 在单个平台上完成 搜索→打分→拉词→构建；返回 {status, best?, built?, lyData?} */
    const tryPlatform = async (platformId, meta) => {
      const kw = buildSearchKeyword(meta.title, meta.artists, meta.artist);
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
      if (!best) return { status: 'no-match', kw };
      const ly = await fetchLyric(best.song);
      if (!ly.data) return { status: 'no-lyric', kw };
      const built = buildExport(ly.data, format);
      if (!built) return { status: 'no-content', kw };
      return { status: 'ok', best, built, kw };
    };

    const written = [];
    let done = 0;
    let okCount = 0;
    for (const item of pending) {
      if (cancelRef.current) {
        log(`■ ${t('batch.cancelled')}`);
        break;
      }
      setProgress((p) => ({ ...p, current: item.path }));
      patchItem(item.key, { state: S.MATCHING, note: '' });
      try {
        // 1) 元数据：标签优先，文件名兜底
        const tags = await readAudioTags(item.file, item.ext);
        const fn = parseFilename(item.base);
        const title = (tags?.title || fn.title || '').trim();
        const artist = (tags?.artist || fn.artist || '').trim();
        const artists = artist ? artist.split(/[/、,，]/).map((s) => s.trim()).filter(Boolean) : [];
        const meta = {
          title,
          artists,
          artist,
          album: (tags?.album || '').trim(),
          durationMs: tags?.durationMs || 0,
        };
        if (!title) {
          patchItem(item.key, { state: S.MISS, note: t('batch.note.noTitle') });
          done++;
          setProgress((p) => ({ ...p, done }));
          continue;
        }

        // 2) 依平台链依次尝试（网易云匿名搜索对热门歌常被翻唱刷屏，回退很关键）
        patchItem(item.key, { state: S.WRITING });
        let result = null;
        const reasons = [];
        for (const platformId of platformChain) {
          try {
            result = await tryPlatform(platformId, meta);
          } catch (err) {
            result = { status: 'error', kw: '', error: err };
          }
          if (result.status === 'ok') {
            result.usedPlatform = platformId;
            break;
          }
          reasons.push(`${platformLabel(platformId)}:${result.status}`);
          if (!fallback) break;
          await new Promise((r) => setTimeout(r, 200));
        }

        if (!result || result.status !== 'ok') {
          const note =
            result && result.status === 'no-lyric'
              ? t('batch.note.noLyric')
              : t('batch.note.noMatch', { kw: (result?.kw || meta.title).slice(0, 40) });
          patchItem(item.key, { state: S.MISS, note });
          log(`· ${item.path} → ${note}${reasons.length ? ` (${reasons.join(' / ')})` : ''}`);
          done++;
          setProgress((p) => ({ ...p, done }));
          continue;
        }

        // 3) 写回（不支持写回的目录则逐个下载）
        const { best, built, usedPlatform } = result;
        const fileName = `${item.base}.${built.ext}`;
        if (item.dirHandle) {
          await writeTextNextTo(item.dirHandle, fileName, built.text);
        } else {
          downloadText(fileName, built.text);
        }
        patchItem(item.key, {
          state: S.DONE,
          note: `${platformLabel(usedPlatform)} · “${best.name}” · ${best.artist}`,
          fileName,
        });
        written.push({ item, fileName, text: built.text });
        okCount++;
        log(`✓ ${item.path} → ${fileName}`);
        done++;
        setProgress((p) => ({ ...p, done }));
        await new Promise((r) => setTimeout(r, 350));
      } catch (err) {
        patchItem(item.key, { state: S.ERROR, note: err?.message || String(err) });
        log(`⚠ ${item.path}: ${err?.message || err}`);
        done++;
        setProgress((p) => ({ ...p, done }));
      }
    }

    setRunning(false);
    setProgress((p) => ({ ...p, current: '' }));
    log(`■ ${t('batch.finish', { done: okCount, total: pending.length })}`);

    // 演示模式：读回第一个写入的文件做写回校验
    if (BATCH_PARAMS.get('demo') === '1' && written.length > 0) {
      try {
        const { item, fileName } = written[0];
        const head = (await readTextNextTo(item.dirHandle, fileName)).slice(0, 80).replace(/\n/g, ' | ');
        log(`↺ ${t('batch.verify', { file: fileName })}: ${head}`);
      } catch (err) {
        log(`⚠ verify: ${err?.message || err}`);
      }
    }
  }, [format, log, overwrite, patchItem, platform]);

  const onCancel = useCallback(() => {
    cancelRef.current = true;
  }, []);

  // ---- 深链：?view=batch&demo=1[&autostart=1] 自动扫描（并可自动批量）----
  useEffect(() => {
    if (demoBootedRef.current) return;
    if (BATCH_PARAMS.get('demo') !== '1') return;
    demoBootedRef.current = true;
    setUnsupported(!supportsDirectoryPicker());
    (async () => {
      try {
        const root = await getOpfsDirectory();
        const dir = await seedDemoFolder(root, log);
        await applyDir(dir, 'OPFS:/Demo 音乐');
        if (BATCH_PARAMS.get('autostart') === '1') {
          setTimeout(() => runBatchRef.current?.(), 400);
        }
      } catch (err) {
        log(`⚠ demo: ${err?.message || err}`);
      }
    })();
  }, [applyDir, log, health]);

  // runBatch 的 ref，供 demo 自动启动用（避免把回调加进依赖造成重跑）
  const runBatchRef = useRef(null);
  runBatchRef.current = runBatch;

  const platformLabel = (id) => PLATFORMS.find((p) => p.id === id)?.label ?? id;

  // ---- 汇总 ----
  const counts = items.reduce(
    (acc, it) => {
      acc[it.state] = (acc[it.state] || 0) + 1;
      return acc;
    },
    {}
  );
  const hasTargets = items.some((it) => it.state === S.PENDING || it.state === S.MISS || it.state === S.ERROR);

  const badge = (it) => {
    switch (it.state) {
      case S.EXISTS: return <span className="chip chip-good">{t('batch.st.exists')}</span>;
      case S.PENDING: return <span className="chip chip-muted">{t('batch.st.pending')}</span>;
      case S.MATCHING: return <span className="chip chip-accent">…</span>;
      case S.WRITING: return <span className="chip chip-accent">✍</span>;
      case S.DONE: return <span className="chip chip-good">✓ {it.fileName}</span>;
      case S.MISS: return <span className="chip chip-warn">{t('batch.st.miss')}</span>;
      case S.ERROR: return <span className="chip chip-err">⚠</span>;
      default: return null;
    }
  };

  return (
    <div className="batch-pane">
      {/* 工具行 */}
      <div className="batch-toolbar">
        <button type="button" className="btn primary" onClick={onPickFolder} disabled={scanning || running}>
          📂 {t('batch.pick')}
        </button>
        {dirName && (
          <span className="batch-dir" title={dirName}>
            {dirName} · {t('batch.files', { n: items.length })}
          </span>
        )}

        <label className="batch-field">
          <span>{t('batch.platform')}</span>
          <select value={platform} onChange={(e) => setPlatform(e.target.value)} disabled={running || health !== 'ok'}>
            {PLATFORMS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </label>
        <label className="batch-field">
          <span>{t('batch.format')}</span>
          <select value={format} onChange={(e) => setFormat(e.target.value)} disabled={running}>
            {EXPORT_TARGETS.map((f) => (
              <option key={f.id} value={f.id}>{f.label}</option>
            ))}
          </select>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} disabled={running} />
          {t('batch.overwrite')}
        </label>
        <label className="toggle">
          <input type="checkbox" checked={fallback} onChange={(e) => setFallback(e.target.checked)} disabled={running} />
          {t('batch.fallback')}
        </label>

        {running ? (
          <button type="button" className="btn danger" onClick={onCancel}>
            ■ {t('batch.stop')}
          </button>
        ) : (
          <button
            type="button"
            className="btn primary"
            onClick={runBatch}
            disabled={scanning || !dirName || health !== 'ok'}
            title={hasTargets ? '' : t('batch.none')}
          >
            ⬇ {t('batch.run')}
          </button>
        )}
      </div>

      {(running || progress.total > 0) && (
        <div className="batch-progress">
          <div className="batch-progress-bar">
            <div
              className="batch-progress-fill"
              style={{ width: progress.total ? `${Math.round((progress.done / progress.total) * 100)}%` : '0%' }}
            />
          </div>
          <span className="mono">
            {progress.done}/{progress.total} {progress.current ? `· ${progress.current}` : ''}
          </span>
        </div>
      )}

      {unsupported && <div className="banner warn">{t('batch.unsupported')}</div>}

      {/* 列表 */}
      <div className="batch-list">
        {items.length === 0 && !scanning && (
          <div className="empty-hint">
            <p>{t('batch.empty')}</p>
            <small>{t('batch.emptySub')}</small>
          </div>
        )}
        {scanning && <div className="status-line">{t('batch.scanning')}</div>}
        {items.map((it) => (
          <div key={it.key} className={`batch-row st-${it.state}`}>
            <div className="batch-row-main">
              <span className="batch-row-name" title={it.path}>{it.name}</span>
              <span className="batch-row-note">{it.note || ''}</span>
            </div>
            <div className="batch-row-side">{badge(it)}</div>
          </div>
        ))}
      </div>

      {/* 日志 */}
      {logs.length > 0 && (
        <pre className="batch-log">{logs.join('\n')}</pre>
      )}
    </div>
  );
}
