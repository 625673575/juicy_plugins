import React, { useCallback, useEffect, useRef, useState } from 'react';
import { PLATFORMS, dirnameOf, downloadText, saveTextTo } from './lib/api.js';
import { EXPORT_TARGETS, matchAndBuild } from './lib/matchPipeline.js';
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
import { t as tx, lang } from './i18n.js';

const t = tx;

const BATCH_PARAMS =
  typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();

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
  const demoDirName = lang() === 'en' ? 'Demo Music' : 'Demo 音乐';
  await root.removeEntry(demoDirName, { recursive: true }).catch(() => {});
  const dir = await root.getDirectoryHandle(demoDirName, { create: true });
  // 1) 带 ID3 标签（真实标签读取路径）
  const mp3 = makeTaggedMp3({ title: lang() === 'en' ? 'Sunny Day' : '晴天', artist: lang() === 'en' ? 'Jay Chou' : '周杰伦', album: lang() === 'en' ? 'Ye Hui Mei' : '叶惠美', durMs: 236940 });
  const songName = lang() === 'en' ? '01. Jay Chou - Sunny Day.mp3' : '01. 周杰伦 - 晴天.mp3';
  {
    const fh = await dir.getFileHandle(songName, { create: true });
    const w = await fh.createWritable();
    await w.write(mp3);
    await w.close();
  }
  // 2) 无标签 → 走文件名解析
  {
    const n = lang() === 'en' ? 'Eason Chan - Lone Warrior.flac' : '陈奕迅 - 孤勇者.flac';
    const fh = await dir.getFileHandle(n, { create: true });
    const w = await fh.createWritable();
    await w.write(new Uint8Array([0x66, 0x4c, 0x61, 0x43, 0, 0, 0, 0]));
    await w.close();
  }
  // 3) 已有同名 .lrc → 应标记「已有歌词」
  {
    const n = lang() === 'en' ? '02. Mayday - Tenderness.mp3' : '02. 五月天 - 温柔.mp3';
    const fh = await dir.getFileHandle(n, { create: true });
    const w = await fh.createWritable();
    await w.write(new Uint8Array([0, 0, 0, 0]));
    await w.close();
    const lh = await dir.getFileHandle(n.replace(/\.mp3$/, '.lrc'), { create: true });
    const lw = await lh.createWritable();
    await lw.write('[00:00.00]existing lyric');
    await lw.close();
  }
  log('✓ ' + (lang() === 'en' ? 'Demo folder ready (OPFS sandbox, 3 files, 1 with existing lyrics)' : '演示文件夹已就绪（OPFS 沙盒，含 3 个文件，其中 1 个已有歌词）'));
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
  const [items, setItems] = useState([]); // {key,name,base,ext,path,file,dirHandle,meta?,state,note,fileName}
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
  // 右键菜单：{x,y,item}
  const [ctx, setCtx] = useState(null);

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

  const platformLabel = (id) => PLATFORMS.find((p) => p.id === id)?.label ?? id;

  // ---- 单曲处理（批量循环与右键单首下载共用同一配置链路）----
  const processOneItem = useCallback(
    async (item, { force }) => {
      patchItem(item.key, { state: S.MATCHING, note: '' });
      try {
        // 1) 元数据：曲库来源自带；本地文件走标签优先、文件名兜底
        let meta = item.meta;
        if (!meta) {
          const tags = await readAudioTags(item.file, item.ext);
          const fn = parseFilename(item.base);
          const title = (tags?.title || fn.title || '').trim();
          const artist = (tags?.artist || fn.artist || '').trim();
          meta = {
            title,
            artists: artist.split(/[、,，]/).map((s) => s.trim()).filter(Boolean),
            artist,
            album: (tags?.album || '').trim(),
            durationMs: tags?.durationMs || 0,
          };
        }
        if (!meta.title) {
          patchItem(item.key, { state: S.MISS, note: t('batch.note.noTitle') });
          return { ok: false };
        }

        // 2) 匹配 → 拉词 → 构建导出文本（matchPipeline，与曲库面板共用）
        patchItem(item.key, { state: S.WRITING });
        const result = await matchAndBuild({ meta, platform, fallback, format });

        if (result.status !== 'ok') {
          const note =
            result.status === 'no-lyric'
              ? t('batch.note.noLyric')
              : t('batch.note.noMatch', { kw: (result.kw || meta.title).slice(0, 40) });
          patchItem(item.key, { state: S.MISS, note });
          log(
            `· ${item.path} → ${note}${
              result.reasons?.length ? ` (${result.reasons.join(' / ')})` : ''
            }`
          );
          return { ok: false };
        }

        // 3) 写回：本地目录句柄直写；曲库来源（无句柄）走后端写进音频所在文件夹；
        //    后端也不可用时才退化为浏览器下载（文件会落到下载文件夹）
        const { best, built, usedPlatform } = result;
        const fileName = `${item.base}.${built.ext}`;
        if (item.dirHandle) {
          await writeTextNextTo(item.dirHandle, fileName, built.text);
          log(`✓ ${item.path} → ${fileName}`);
        } else if (health === 'ok') {
          try {
            const res = await saveTextTo(fileName, built.text, dirnameOf(item.path) || undefined);
            log(`✓ ${item.path} → ${res.path}`);
          } catch (err) {
            downloadText(fileName, built.text);
            log(`⚠ ${t('save.fallbackLog', { msg: err?.message || err })}`);
          }
        } else {
          downloadText(fileName, built.text);
          log(`✓ ${item.path} → ${fileName} (${t('save.downloaded')})`);
        }
        patchItem(item.key, {
          state: S.DONE,
          note: `${platformLabel(usedPlatform)} · “${best.name}” · ${best.artist}`,
          fileName,
        });
        return { ok: true, fileName };
      } catch (err) {
        patchItem(item.key, { state: S.ERROR, note: err?.message || String(err) });
        log(`⚠ ${item.path}: ${err?.message || err}`);
        return { ok: false };
      }
    },
    // platformLabel 为组件内稳定纯函数，不列入依赖
    [fallback, format, health, log, patchItem, platform]
  );

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

    const written = [];
    let done = 0;
    let okCount = 0;
    for (const item of pending) {
      if (cancelRef.current) {
        log(`■ ${t('batch.cancelled')}`);
        break;
      }
      setProgress((p) => ({ ...p, current: item.path }));
      const res = await processOneItem(item, { force: overwrite });
      if (res.ok) {
        written.push({ item, fileName: res.fileName });
        okCount++;
      }
      done++;
      setProgress((p) => ({ ...p, done }));
      if (res.ok) await new Promise((r) => setTimeout(r, 350));
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
  }, [log, overwrite, processOneItem]);

  const onCancel = useCallback(() => {
    cancelRef.current = true;
  }, []);

  // ---- 右键菜单：单首下载（沿用批量配置，强制覆盖）----
  useEffect(() => {
    if (!ctx) return undefined;
    const close = () => setCtx(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [ctx]);

  const onCtxDownload = useCallback(
    async (item) => {
      if (running || health !== 'ok') return;
      setCtx(null);
      await processOneItem(item, { force: true });
    },
    [health, processOneItem, running]
  );

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
              <option key={f.id} value={f.id}>{lang() === 'en' && f.labelEn ? f.labelEn : f.label}</option>
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
          <div
            key={it.key}
            className={`batch-row st-${it.state}`}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtx({ x: e.clientX, y: e.clientY, item: it });
            }}
          >
            <div className="batch-row-main">
              <span className="batch-row-name" title={it.path}>{it.name}</span>
              <span className="batch-row-note">{it.note || ''}</span>
            </div>
            <div className="batch-row-side">{badge(it)}</div>
          </div>
        ))}
      </div>

      {/* 右键菜单：单首下载 */}
      {ctx && (
        <div className="ctx-menu" style={{ left: ctx.x, top: ctx.y }}>
          <button type="button" disabled={running || health !== 'ok'} onClick={() => onCtxDownload(ctx.item)}>
            ⬇ {t('batch.ctxDownload')}
          </button>
        </div>
      )}

      {/* 日志 */}
      {logs.length > 0 && (
        <pre className="batch-log">{logs.join('\n')}</pre>
      )}
    </div>
  );
}
