// JuicyPlayer 曲库面板：从宿主曲库（通道 3 HTTP API）读取文件夹/曲目，
// 单曲或批量下载歌词，经插件后端直接写进音频所在文件夹。
//
// 与 BatchPanel（本地文件夹 + File System Access 写回）共用 matchPipeline
// 的匹配管线；这里没有目录句柄，写盘一律走后端 /api/save。

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  PLATFORMS,
  dirnameOf,
  downloadText,
  fetchLibraryFolderTracks,
  fetchLibraryFolders,
  fetchSaveConfig,
  putSaveConfig,
  saveTextTo,
} from './lib/api.js';
import { isDemucsStemBase } from './lib/filelib.js';
import { canDetectLyricFiles, existingLyricExts } from './lib/hostfs.js';
import { EXPORT_TARGETS, matchAndBuild } from './lib/matchPipeline.js';
import { t as tx, lang } from './i18n.js';

const t = tx;

const S = {
  PENDING: 'pending',
  EXISTS: 'exists',
  MATCHING: 'matching',
  WRITING: 'writing',
  DONE: 'done',
  MISS: 'miss',
  ERROR: 'error',
};

export default function LibraryPanel({ health }) {
  const [folders, setFolders] = useState(null); // null=加载中, []=无
  const [folderIdx, setFolderIdx] = useState('');
  const [folderName, setFolderName] = useState('');
  const [libError, setLibError] = useState('');
  const [items, setItems] = useState([]); // {key,name,base,ext,path,meta,state,note,fileName}
  const [platform, setPlatform] = useState('netease');
  const [format, setFormat] = useState('lrc');
  const [overwrite, setOverwrite] = useState(false);
  const [fallback, setFallback] = useState(true);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, current: '' });
  const [logs, setLogs] = useState([]);
  // 单曲保存位置（后端记忆；单曲搜索页的保存也写到这里）
  const [targetDir, setTargetDir] = useState('');
  const [targetDraft, setTargetDraft] = useState('');
  const [targetSaved, setTargetSaved] = useState(false);

  const itemsRef = useRef([]);
  const cancelRef = useRef(false);
  itemsRef.current = items;

  const log = useCallback((line) => {
    setLogs((prev) => [...prev.slice(-199), line]);
  }, []);

  const patchItem = useCallback((key, patch) => {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  }, []);

  const platformLabel = (id) => PLATFORMS.find((p) => p.id === id)?.label ?? id;

  // ---- 进入面板即读曲库并自动加载第一个文件夹，零点击即可见曲目列表 ----
  const loadFolder = useCallback(
    async (idx, list) => {
      const name = (list || []).find((f) => String(f.index) === String(idx))?.name || 'library';
      try {
        const tracks = await fetchLibraryFolderTracks(Number(idx));
        const mapped = tracks
          .filter((tr) => tr.filePath || tr.title)
          .map((tr, i) => {
            const filePath = tr.filePath || `${tr.title}.mp3`;
            const fileName = filePath.split(/[\\/]/).pop();
            const dot = fileName.lastIndexOf('.');
            const base = dot > 0 ? fileName.slice(0, dot) : fileName;
            return {
              key: `lib#${tr.id || i}#${i}`,
              name: fileName,
              base,
              ext: (dot > 0 ? fileName.slice(dot + 1) : 'mp3').toLowerCase(),
              path: filePath,
              meta: {
                title: tr.title || base,
                artists: (tr.artist || '').split(/[、,，]/).map((s) => s.trim()).filter(Boolean),
                artist: tr.artist || '',
                album: tr.album || '',
                durationMs: Math.round((tr.duration || 0) * 1000),
              },
              state: S.PENDING,
              note: '',
              fileName: '',
            };
          })
          .filter((it) => it.base && !isDemucsStemBase(it.base)); // demucs 分离产物不入列
        setFolderName(name);
        setItems(mapped);
        log(`✓ ${t('library.tracks', { name, n: mapped.length })}`);
        // Mark tracks whose lyrics already sit next to the audio (host
        // native, when available). Async so the list renders immediately.
        if (canDetectLyricFiles()) {
          for (const it of mapped) {
            existingLyricExts(it.path, it.base).then((exts) => {
              if (exts && exts.length > 0)
                patchItem(it.key, { state: 'exists', note: exts.join(' ') });
            });
          }
        }
      } catch (err) {
        log(`⚠ ${err?.message || err}`);
      }
    },
    [log]
  );

  useEffect(() => {
    if (health !== 'ok') return undefined;
    let alive = true;
    setLibError('');
    fetchLibraryFolders()
      .then((f) => {
        if (!alive) return;
        setFolders(f);
        if (f.length > 0) {
          setFolderIdx(String(f[0].index));
          loadFolder(f[0].index, f);
        }
        log(`✓ ${t('library.loadedFolders', { n: f.length })}`);
      })
      .catch((err) => {
        if (!alive) return;
        setFolders([]);
        setLibError(err?.message || String(err));
      });
    return () => {
      alive = false;
    };
  }, [health, loadFolder, log]);

  const onSelectFolder = useCallback(
    (idx) => {
      setFolderIdx(idx);
      loadFolder(idx, folders);
    },
    [folders, loadFolder]
  );

  // ---- 读取后端记忆的单曲保存位置 ----
  useEffect(() => {
    if (health !== 'ok') return undefined;
    let alive = true;
    fetchSaveConfig()
      .then((cfg) => {
        if (!alive) return;
        setTargetDir(cfg.targetDir || '');
        setTargetDraft(cfg.targetDir || '');
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [health]);

  const onSetTargetDir = useCallback(async () => {
    const dir = targetDraft.trim();
    if (!dir) return;
    try {
      await putSaveConfig(dir);
      setTargetDir(dir);
      setTargetSaved(true);
      setTimeout(() => setTargetSaved(false), 2000);
      log(`✓ ${t('save.savedTo', { path: dir })}`);
    } catch (err) {
      log(`⚠ ${t('save.failed', { msg: err?.message || err })}`);
    }
  }, [log, targetDraft]);

  // ---- 单曲处理（行内按钮与批量循环共用）----
  const processOneTrack = useCallback(
    async (item) => {
      patchItem(item.key, { state: S.MATCHING, note: '' });
      try {
        if (!item.meta?.title) {
          patchItem(item.key, { state: S.MISS, note: t('batch.note.noTitle') });
          return false;
        }
        patchItem(item.key, { state: S.WRITING });
        const result = await matchAndBuild({
          meta: item.meta,
          platform,
          fallback,
          format,
        });
        if (result.status !== 'ok') {
          const note =
            result.status === 'no-lyric'
              ? t('batch.note.noLyric')
              : t('batch.note.noMatch', { kw: (result.kw || item.meta.title).slice(0, 40) });
          patchItem(item.key, { state: S.MISS, note });
          log(
            `· ${item.path} → ${note}${
              result.reasons?.length ? ` (${result.reasons.join(' / ')})` : ''
            }`
          );
          return false;
        }

        // 写盘：写入音频所在文件夹（后端 /api/save），失败才回退浏览器下载
        const { best, built, usedPlatform } = result;
        const fileName = `${item.base}.${built.ext}`;
        let savedPath = '';
        try {
          const res = await saveTextTo(fileName, built.text, dirnameOf(item.path) || undefined);
          savedPath = res.path;
        } catch (err) {
          downloadText(fileName, built.text);
          log(`⚠ ${t('save.fallbackLog', { msg: err?.message || err })}`);
        }
        patchItem(item.key, {
          state: S.DONE,
          note: `${platformLabel(usedPlatform)} · “${best.name}” · ${best.artist}`,
          fileName,
        });
        log(`✓ ${item.path} → ${savedPath || `${fileName} (${t('save.downloaded')})`}`);
        return true;
      } catch (err) {
        patchItem(item.key, { state: S.ERROR, note: err?.message || String(err) });
        log(`⚠ ${item.path}: ${err?.message || err}`);
        return false;
      }
    },
    [fallback, format, log, patchItem, platform]
  );

  // ---- 批量 ----
  const runBatch = useCallback(async () => {
    const targets = itemsRef.current.filter(
      (it) => overwrite || it.state === S.PENDING || it.state === S.MISS || it.state === S.ERROR
    );
    if (targets.length === 0) {
      log(t('batch.none'));
      return;
    }
    setRunning(true);
    cancelRef.current = false;
    setProgress({ done: 0, total: targets.length, current: '' });
    log(
      `▶ ${t('batch.start', {
        n: targets.length,
        platform: fallback ? `${platformLabel(platform)}+${t('batch.fallbackShort')}` : platformLabel(platform),
        format,
      })}`
    );
    let done = 0;
    let okCount = 0;
    for (const item of targets) {
      if (cancelRef.current) {
        log(`■ ${t('batch.cancelled')}`);
        break;
      }
      setProgress((p) => ({ ...p, current: item.path }));
      if (await processOneTrack(item)) okCount++;
      done++;
      setProgress((p) => ({ ...p, done }));
      await new Promise((r) => setTimeout(r, 350));
    }
    setRunning(false);
    setProgress((p) => ({ ...p, current: '' }));
    log(`■ ${t('batch.finish', { done: okCount, total: targets.length })}`);
  }, [log, overwrite, processOneTrack, fallback, platform]);

  const onOneClick = useCallback(
    async (item) => {
      if (running || health !== 'ok') return;
      await processOneTrack(item);
    },
    [health, processOneTrack, running]
  );

  const badge = (it) => {
    switch (it.state) {
      case S.PENDING: return <span className="chip chip-muted">{t('batch.st.pending')}</span>;
      case S.EXISTS: return <span className="chip chip-good">✓ {t('batch.st.exists')}</span>;
      case S.MATCHING: return <span className="chip chip-accent">…</span>;
      case S.WRITING: return <span className="chip chip-accent">✍</span>;
      case S.DONE: return <span className="chip chip-good">✓ {it.fileName}</span>;
      case S.MISS: return <span className="chip chip-warn">{t('batch.st.miss')}</span>;
      case S.ERROR: return <span className="chip chip-err">⚠</span>;
      default: return null;
    }
  };

  const disabled = health !== 'ok';

  return (
    <div className="batch-pane">
      {/* 工具行 */}
      <div className="batch-toolbar">
        <span className="lib-brand">🎵 {t('library.brand')}</span>
        {folders === null && !libError && <span className="lib-hint">{t('library.loading')}</span>}
        {folders !== null && folders.length > 0 && (
          <>
            <select
              value={folderIdx}
              onChange={(e) => onSelectFolder(e.target.value)}
              disabled={running}
            >
              {folders.map((f) => (
                <option key={f.index} value={String(f.index)}>
                  {f.name} ({f.trackCount})
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn"
              onClick={() => onSelectFolder(folderIdx)}
              disabled={running}
            >
              {t('library.loadTracks')}
            </button>
            {folderName && <span className="batch-dir" title={folderName}>{folderName} · {t('library.count', { n: items.length })}</span>}
          </>
        )}
        {folders !== null && folders.length === 0 && !libError && (
          <span className="lib-hint">{t('library.none')}</span>
        )}

        <label className="batch-field">
          <span>{t('batch.platform')}</span>
          <select value={platform} onChange={(e) => setPlatform(e.target.value)} disabled={running || disabled}>
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
          <button type="button" className="btn danger" onClick={() => { cancelRef.current = true; }}>
            ■ {t('batch.stop')}
          </button>
        ) : (
          <button
            type="button"
            className="btn primary"
            onClick={runBatch}
            disabled={disabled || items.length === 0}
          >
            ⬇ {t('library.run')}
          </button>
        )}
      </div>

      {/* 单曲保存位置（后端持久化，供单曲搜索页与兜底使用） */}
      <div className="batch-toolbar secondary">
        <label className="batch-field grow">
          <span>{t('library.targetLabel')}</span>
          <input
            className="target-input mono"
            value={targetDraft}
            disabled={disabled || running}
            placeholder={t('library.targetPlaceholder')}
            onChange={(e) => setTargetDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSetTargetDir();
            }}
          />
        </label>
        <button type="button" className="btn" onClick={onSetTargetDir} disabled={disabled || running || !targetDraft.trim()}>
          {targetSaved ? `✓ ${t('library.targetSetDone')}` : t('library.targetSet')}
        </button>
        {targetDir && <span className="lib-hint" title={targetDir}>{targetDir}</span>}
      </div>

      {libError && <div className="banner warn">⚠ {t('library.fail')}: {libError}</div>}

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

      {/* 列表 */}
      <div className="batch-list">
        {items.length === 0 && (
          <div className="empty-hint">
            <p>{t('library.empty')}</p>
            <small>{t('library.emptySub')}</small>
          </div>
        )}
        {items.map((it) => (
          <div key={it.key} className={`batch-row st-${it.state}`}>
            <div className="batch-row-main">
              <span className="batch-row-name" title={it.path}>{it.name}</span>
              <span className="batch-row-note">{it.note || ''}</span>
            </div>
            <div className="batch-row-side">
              <button
                type="button"
                className="row-dl"
                title={t('library.dlOne')}
                disabled={running || disabled}
                onClick={() => onOneClick(it)}
              >
                ⬇
              </button>
              {badge(it)}
            </div>
          </div>
        ))}
      </div>

      {/* 日志 */}
      {logs.length > 0 && <pre className="batch-log">{logs.join('\n')}</pre>}
    </div>
  );
}
