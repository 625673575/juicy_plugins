import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  PLATFORMS,
  FORMAT_LABELS,
  checkHealth,
  searchSongs,
  fetchLyric,
  downloadText,
  copyText,
} from './lib/api.js';
import { parseLyric, detectFormat } from './lib/parser/parse.js';
import { buildDownloadLyric, extOfTarget } from './lib/parser/serialize.js';
import BatchPanel from './BatchPanel.jsx';
import { t as tx, lang, setLang } from './i18n.js';

const t = tx;

// 与 SPlayer 的 DEFAULT_LYRIC_FORMAT_ORDER 保持一致：ttml > qrc > krc > yrc > lrc
const FORMAT_PRIORITY = ['ttml', 'qrc', 'krc', 'yrc', 'lys', 'lrc'];
const prioIndex = (fmt) => {
  const p = FORMAT_PRIORITY.indexOf(fmt);
  return p === -1 ? FORMAT_PRIORITY.length : p;
};

const fmtTime = (ms) => {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

const fmtDurationBadge = (ms) => {
  if (!ms || ms <= 0) return '--:--';
  let m = Math.floor(ms / 60000);
  let s = Math.round((ms % 60000) / 1000);
  if (s === 60) {
    m += 1;
    s = 0;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
};

const sanitizeName = (s) =>
  String(s || '').replace(/[\\/:*?"<>|\n\r]+/g, '_').replace(/\s+/g, ' ').trim() || 'lyric';

// 深链参数：?platform=qq&q=关键词&open=1&tab=export&t=毫秒
// q+open 可直达某首歌的某个页签，t 直接把播放头定位到该时刻（便于分享/复现）
const URL_PARAMS =
  typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
const urlPlatform = URL_PARAMS.get('platform');
const urlQuery = URL_PARAMS.get('q') ?? '';
const urlOpenIdx = parseInt(URL_PARAMS.get('open') || '0', 10) || 0;
const urlTab = URL_PARAMS.get('tab');
const urlTimeMs = parseInt(URL_PARAMS.get('t') || '0', 10) || 0;
const urlVariant = URL_PARAMS.get('variant'); // yrc | qrc | krc | lrc | ttml
const urlView = URL_PARAMS.get('view') === 'batch' ? 'batch' : 'search';

// ----------------------------------------------------------------------------
// 小组件

function StatusChip({ tone, children }) {
  return <span className={`chip chip-${tone}`}>{children}</span>;
}

/** 左列结果行 */
const SongRow = React.memo(function SongRow({ song, active, onClick }) {
  return (
    <button type="button" className={`song-row${active ? ' active' : ''}`} onClick={onClick}>
      <div className="song-row-main">
        <span className="song-name">{song.name}</span>
        <span className="song-meta">{song.artist}{song.album ? ` · ${song.album}` : ''}</span>
      </div>
      <span className="song-dur">{fmtDurationBadge(song.durationMs)}</span>
    </button>
  );
});

/**
 * 歌词行。memo 化：非当前行只依赖 line/phase/开关，不随每帧时间变化重渲染。
 * 当前行内逐字按 --p 百分比填充。
 */
const LineRow = React.memo(
  function LineRow({ line, phase, showTrans, showRomaji, progressMs, onSeek, index }) {
    const words = line.words.length ? line.words : [{ word: '', startTime: line.startTime, endTime: line.endTime }];
    const ghost = !words.some((w) => w.word.trim());
    const body = words.map((w, i) => {
      let pct = null;
      if (phase === 'current') {
        // 无词级时长的时间标注词按整块点亮
        pct =
          w.endTime > w.startTime
            ? Math.min(1, Math.max(0, (progressMs - w.startTime) / (w.endTime - w.startTime)))
            : progressMs >= w.endTime
              ? 1
              : 0;
      }
      const style = pct == null ? undefined : { ['--p']: `${Math.round(pct * 100)}%` };
      return (
        <span key={i} className="kw" style={style}>
          {w.word}
        </span>
      );
    });
    return (
      <div
        className={[
          'lyr-line',
          `phase-${phase}`,
          line.isBG ? 'is-bg' : '',
          line.isDuet ? 'is-duet' : '',
          ghost ? 'is-ghost' : '',
        ].join(' ').trim()}
        onClick={() => onSeek(line.startTime)}
        data-index={index}
      >
        <div className="lyr-main" lang="und">{body}</div>
        {showRomaji && line.romanLyric ? <div className="lyr-roman">{line.romanLyric}</div> : null}
        {showTrans && line.translatedLyric ? (
          <div className="lyr-trans">{line.translatedLyric}</div>
        ) : null}
      </div>
    );
  },
  (prev, next) =>
    prev.line === next.line &&
    prev.phase === next.phase &&
    prev.showTrans === next.showTrans &&
    prev.showRomaji === next.showRomaji &&
    prev.index === next.index &&
    (next.phase !== 'current' ||
      // 当前行需要跟随播放进度；粗粒度比较，250ms 内不更新
      Math.floor(prev.progressMs / 250) === Math.floor(next.progressMs / 250))
);

/** 导出卡片 */
function ExportCard({ title, desc, text, filename, highlight }) {
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  const kb = (new Blob([text]).size / 1024).toFixed(1);
  return (
    <div className={`export-card${highlight ? ' highlight' : ''}`}>
      <div className="export-head">
        <span className="export-title">{title}</span>
        <span className="export-size">{t('export.size', { kb, chars: text.length.toLocaleString() })}</span>
      </div>
      <p className="export-desc">{desc}</p>
      <pre className="export-snippet">{text.split('\n').slice(0, 4).join('\n')}</pre>
      <div className="export-actions">
        <button
          type="button"
          className="btn primary"
          onClick={() => downloadText(filename, text)}
        >
          ⬇ {t('export.download')}
        </button>
        <button
          type="button"
          className="btn"
          onClick={async () => {
            if (await copyText(text)) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            }
          }}
        >
          {copied ? t('raw.copied') : t('raw.copy')}
        </button>
        <code className="export-file">{filename}</code>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------

export default function App() {
  // ---- 服务状态 / 搜索 ----
  const [health, setHealth] = useState('checking'); // checking | ok | off
  const [view, setView] = useState(urlView); // search | batch
  // UI language: zh / en. Persisted by i18n (localStorage); bumping this state
  // re-renders every t() lookup with the new dictionary.
  const [uiLang, setUiLang] = useState(lang());
  const toggleLang = useCallback(() => {
    const next = uiLang === 'zh' ? 'en' : 'zh';
    setLang(next);
    setUiLang(next);
  }, [uiLang]);
  const [platform, setPlatform] = useState(
    PLATFORMS.some((p) => p.id === urlPlatform) ? urlPlatform : 'netease'
  );
  const [keyword, setKeyword] = useState(urlQuery);
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [searchError, setSearchError] = useState('');

  // ---- 选中歌曲与歌词载荷 ----
  const [selected, setSelected] = useState(null);
  const [lyricPayload, setLyricPayload] = useState(null); // {variants,translation,romaji,ttml}
  const [loadingLyric, setLoadingLyric] = useState(false);
  const [lyricError, setLyricError] = useState('');

  // ---- 当前源（哪个格式变体）----
  const [activeSourceId, setActiveSourceId] = useState('');
  const [tab, setTab] = useState(
    ['preview', 'raw', 'export'].includes(urlTab) ? urlTab : 'preview'
  );

  // ---- 播放模拟 ----
  const [playing, setPlaying] = useState(false);
  const [posMs, setPosMs] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [showTrans, setShowTrans] = useState(true);
  const [showRomaji, setShowRomaji] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);

  // ---- 离线粘贴模式 ----
  const [pasteMain, setPasteMain] = useState('');
  const [pasteTrans, setPasteTrans] = useState('');

  const posRef = useRef(0);
  const listWrapRef = useRef(null);
  const autoScrollSuspendUntil = useRef(0);
  const prevActiveRef = useRef(-1);

  // 探测本地 API
  useEffect(() => {
    let alive = true;
    checkHealth().then((okFlag) => alive && setHealth(okFlag ? 'ok' : 'off'));
    return () => {
      alive = false;
    };
  }, []);

  // 深链自动流：?q=... 直达搜索并自动打开第 open 条结果（批量视图下不跑）
  const bootRef = useRef(false);
  useEffect(() => {
    if (bootRef.current || health !== 'ok' || view === 'batch') return;
    const q = urlQuery.trim();
    bootRef.current = true;
    if (!q) return;
    (async () => {
      try {
        const res = await searchSongs(platform, q, 25, 1);
        setResults(res.songs);
        setTotal(res.total ?? res.songs.length);
        const song = res.songs[urlOpenIdx] ?? res.songs[0];
        if (song) await openSong({ ...song, platform });
      } catch (err) {
        setSearchError(err?.message || String(err));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [health]);

  // ---- 搜索 ----
  const keywordRef = useRef('');
  const inputRef = useRef(null);
  const doSearch = useCallback(
    async (kwArg, nextPage = 1, append = false) => {
      const kw = String(kwArg ?? keywordRef.current ?? '').trim();
      if (!kw || searching) return;
      setSearching(true);
      setSearchError('');
      try {
        const res = await searchSongs(platform, kw, 25, nextPage);
        setResults((prev) => (append ? [...prev, ...res.songs] : res.songs));
        setTotal(res.total ?? res.songs.length);
        setPage(nextPage);
      } catch (err) {
        setSearchError(err?.message || String(err));
        if (!append) {
          setResults([]);
          setTotal(0);
        }
      } finally {
        setSearching(false);
      }
    },
    [platform, searching]
  );

  // ---- 选中歌曲 → 拉歌词 ----
  const openSong = useCallback(async (song) => {
    setSelected(song);
    setLoadingLyric(true);
    setLyricError('');
    setLyricPayload(null);
    setPlaying(false);
    posRef.current = 0;
    setPosMs(0);
    try {
      const res = await fetchLyric(song);
      if (!res.data) {
        setLyricError('miss');
      } else {
        setLyricPayload(res.data);
      }
    } catch (err) {
      setLyricError(err?.message || String(err));
    } finally {
      setLoadingLyric(false);
    }
  }, []);

  // ---- 可选源列表 ----
  const sources = useMemo(() => {
    if (!lyricPayload) return [];
    const arr = lyricPayload.variants.map((v, i) => ({
      id: `v${i}`,
      format: v.format,
      content: v.content,
      translation: lyricPayload.translation || '',
      romaji: lyricPayload.romaji || '',
    }));
    if (lyricPayload.ttml) {
      arr.push({
        id: 'ttml',
        format: 'ttml',
        content: lyricPayload.ttml,
        translation: '',
        romaji: '',
      });
    }
    return arr;
  }, [lyricPayload]);

  // 默认按 SPlayer 优先级选一个源；深链 ?variant= 可指定格式
  useEffect(() => {
    if (sources.length === 0) return;
    setActiveSourceId((prev) => {
      if (prev && sources.some((s) => s.id === prev)) return prev;
      if (urlVariant) {
        const wanted = sources.find((s) => s.format === urlVariant || (urlVariant === 'ttml' && s.id === 'ttml'));
        if (wanted) return wanted.id;
      }
      const best = [...sources].sort((a, b) => prioIndex(a.format) - prioIndex(b.format))[0];
      return best.id;
    });
  }, [sources]);

  const activeSource = useMemo(
    () => sources.find((s) => s.id === activeSourceId) ?? sources[0] ?? null,
    [sources, activeSourceId]
  );

  // ---- 解析当前源 ----
  const parsedLines = useMemo(() => {
    if (!activeSource?.content) return [];
    try {
      // 显式传 variant 的格式：KRC/QRC 等逐字格式不能靠内容嗅探（会误判成 LRC）
      return parseLyric(
        { content: activeSource.content, translation: activeSource.translation, romaji: activeSource.romaji },
        activeSource.format,
      );
    } catch (err) {
      console.warn('parse failed:', err);
      return [];
    }
  }, [activeSource]);

  // 内容真实结束时间：parseLRC 会把最后一行 endTime 填成 MAX_TIME 哨兵，须排除
  const SENTINEL_MS = 60000000;
  const contentEndMs = useMemo(() => {
    let m = 0;
    for (const line of parsedLines) {
      if (line.startTime > m && line.startTime < SENTINEL_MS) m = line.startTime;
      if (line.endTime > m && line.endTime < SENTINEL_MS) m = line.endTime;
      for (const w of line.words) {
        if (w.endTime > m && w.endTime < SENTINEL_MS) m = w.endTime;
      }
    }
    return m;
  }, [parsedLines]);

  const durationMs = useMemo(() => {
    const base = Math.max(selected?.durationMs || 0, contentEndMs);
    return base > 0 ? base + 1200 : 240000;
  }, [contentEndMs, selected]);

  // 当前活动行下标
  const activeIndex = useMemo(() => {
    if (!parsedLines.length) return -1;
    let idx = -1;
    for (let i = 0; i < parsedLines.length; i++) {
      if (parsedLines[i].startTime <= posMs) idx = i;
      else break;
    }
    // 停在行尾之后也算下一行"预备"态——保持最后一行高亮即可
    return idx;
  }, [parsedLines, posMs]);

  // 自动滚动到当前行
  useEffect(() => {
    if (!autoScroll || tab !== 'preview') return;
    if (Date.now() < autoScrollSuspendUntil.current) return;
    const wrap = listWrapRef.current;
    if (!wrap || activeIndex < 0) return;
    const el = wrap.querySelector(`[data-index="${activeIndex}"]`);
    if (!el || el === prevActiveRef.current) return;
    prevActiveRef.current = el;
    wrap.scrollTo({ top: Math.max(0, el.offsetTop - wrap.clientHeight * 0.38), behavior: 'smooth' });
  }, [activeIndex, autoScroll, tab]);

  // 切歌 / 换源时复位滚动位置与播放头；深链 ?t= 则定位到指定时刻
  useEffect(() => {
    prevActiveRef.current = -1;
    if (urlTimeMs > 0) {
      posRef.current = urlTimeMs;
      setPosMs(urlTimeMs);
    } else {
      posRef.current = 0;
      setPosMs(0);
    }
    setPlaying(false);
    listWrapRef.current?.scrollTo({ top: 0 });
  }, [activeSourceId, selected]);

  // ---- 播放时钟 ----
  useEffect(() => {
    if (!playing) return undefined;
    let raf = 0;
    let last = performance.now();
    const tick = (now) => {
      const dt = now - last;
      last = now;
      let next = posRef.current + dt * speed;
      if (next >= durationMs) {
        next = durationMs;
        posRef.current = next;
        setPosMs(Math.round(next));
        setPlaying(false);
        return undefined;
      }
      posRef.current = next;
      setPosMs(Math.round(next));
      raf = requestAnimationFrame(tick);
      return undefined;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, durationMs]);

  const seek = useCallback((ms) => {
    posRef.current = ms;
    setPosMs(Math.round(ms));
  }, []);

  // ---- 离线解析 ----
  const parsePasted = useCallback(() => {
    const content = pasteMain.trim();
    if (!content) return;
    const detected = detectFormat(content);
    setSelected({
      id: '',
      name: t('offline.pasteHead'),
      artist: detected.toUpperCase(),
      album: '',
      durationMs: 0,
      platform: '',
    });
    setLyricError('');
    setLyricPayload({
      variants: [{ format: detected, content }],
      translation: pasteTrans.trim(),
      romaji: '',
      ttml: null,
    });
  }, [pasteMain, pasteTrans]);

  // ---- 搜索加载更多 ----
  const loadMore = useCallback(
    () => doSearch(keywordRef.current, page + 1, true),
    [doSearch, page]
  );

  // ---------------------------------------------------------------- export --
  const exportTexts = useMemo(() => {
    if (!activeSource?.content || parsedLines.length === 0) return {};
    return {
      lrc: buildDownloadLyric(parsedLines, 'lrc'),
      enhancedLrc: buildDownloadLyric(parsedLines, 'enhanced-lrc'),
      ttml: buildDownloadLyric(parsedLines, 'ttml'),
    };
  }, [activeSource, parsedLines]);

  const fileBase = selected ? sanitizeName(`${selected.artist ? selected.artist + ' - ' : ''}${selected.name}`) : 'lyric';
  const rawExt = activeSource ? extOfTarget(activeSource.format === 'enhanced-lrc' ? 'lrc' : activeSource.format) : 'txt';
  const rawFilename = `${fileBase}.${rawExt}`;

  const hasWordTiming =
    !!parsedLines &&
    parsedLines.some((line) => line.words.length > 1 && line.words.some((w) => w.endTime > w.startTime));

  // ------------------------------------------------------------------ view --

  return (
    <div className="app-shell">
      {/* ---------- 顶栏 ---------- */}
      <header className="topbar glass">
        <div className="brand">
          <h1>{t('app.title')}</h1>
          <span className="brand-sub">{t('app.sub')}</span>
        </div>
        <div className="topbar-status">
          <div className="view-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={view === 'search'}
              className={`vtab${view === 'search' ? ' on' : ''}`}
              onClick={() => setView('search')}
            >
              🔍 {t('view.single')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'batch'}
              className={`vtab${view === 'batch' ? ' on' : ''}`}
              onClick={() => setView('batch')}
            >
              📂 {t('view.batch')}
            </button>
          </div>
          <button
            type="button"
            className="vtab lang-switch"
            title={uiLang === 'zh' ? 'Switch to English' : '切换到中文'}
            onClick={toggleLang}
          >
            {uiLang === 'zh' ? 'EN' : '中文'}
          </button>
          <StatusChip tone={health === 'ok' ? 'good' : health === 'off' ? 'warn' : 'muted'}>
            {health === 'ok' ? '● ' + t('status.online') : health === 'off' ? '○ ' + t('status.offline') : '◌ ' + t('status.checking')}
          </StatusChip>
        </div>
      </header>

      {health === 'off' && (
        <div className="banner warn">{t('banner.offline')}</div>
      )}

      {/* ---------- 搜索区 ---------- */}
      <section className="search-bar glass">
        <div className="platform-tabs" role="tablist">
          {PLATFORMS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={platform === p.id}
              className={`ptab${platform === p.id ? ' on' : ''}`}
              disabled={health === 'off'}
              onClick={() => setPlatform(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <form
          className="search-form"
          onSubmit={(e) => {
            e.preventDefault();
            const v = inputRef.current?.value ?? '';
            keywordRef.current = v;
            setKeyword(v);
            doSearch(v, 1, false);
          }}
        >
          {/* 非受控：提交时以 DOM 值为准，避免程序化赋值（自动化/WebView 场景）丢事件 */}
          <input
            ref={inputRef}
            className="search-input"
            defaultValue={keyword}
            placeholder={health === 'off' ? '' : t('search.placeholder')}
            disabled={health === 'off'}
            onChange={(e) => {
              keywordRef.current = e.target.value;
              setKeyword(e.target.value);
            }}
          />
          <button type="submit" className="btn primary" disabled={health === 'off' || searching}>
            {searching ? t('search.searching') : t('search.button')}
          </button>
        </form>
      </section>

      {/* ---------- 主体 ---------- */}
      {view === 'batch' ? (
        <main className="layout layout-batch">
          <BatchPanel health={health} />
        </main>
      ) : (
      <main className="layout">
        {/* 左栏：结果列表 or 粘贴框 */}
        <aside className="left glass">
          {health !== 'off' ? (
            <>
              <div className="panel-head">
                <h2>
                  {results.length > 0
                    ? t('result.count', { n: results.length })
                    : t('search.empty.title')}
                </h2>
              </div>
              <div className="left-body">
                {searchError && <p className="error-text">⚠ {searchError}</p>}
                {results.map((song, i) => (
                  <SongRow
                    key={`${song.id}-${song.hash}-${i}`}
                    song={song}
                    active={
                      selected &&
                      selected.id === song.id &&
                      (song.hash || '') === (selected.hash || '')
                    }
                    onClick={() => openSong({ ...song, platform })}
                  />
                ))}
                {results.length > 0 && results.length < total && (
                  <button type="button" className="btn block" onClick={loadMore} disabled={searching}>
                    {searching ? '…' : '+'}
                  </button>
                )}
                {results.length === 0 && !searching && !searchError && (
                  <div className="empty-hint">
                    <p>{t('search.empty.title')}</p>
                    <small>{t('search.empty.sub')}</small>
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="panel-head">
                <h2>{t('offline.pasteHead')}</h2>
                <small>{t('offline.pasteSub')}</small>
              </div>
              <textarea
                className="paste-area"
                value={pasteMain}
                onChange={(e) => setPasteMain(e.target.value)}
                spellCheck={false}
                placeholder={'[00:12.34]歌词一行\n[1000,500](1000,500,0)YRC 也行'}
              />
              <textarea
                className="paste-area small"
                value={pasteTrans}
                onChange={(e) => setPasteTrans(e.target.value)}
                spellCheck={false}
                placeholder={'[00:12.34]可选翻译行'}
              />
              <button type="button" className="btn primary block" onClick={parsePasted} disabled={!pasteMain.trim()}>
                {t('offline.parse')}
              </button>
            </>
          )}
        </aside>

        {/* 右栏：详情 */}
        <section className="right glass">
          {!selected && (
            <div className="detail-empty">
              <div className="big-icon">📝</div>
              <p>{t('search.empty.title')}</p>
              <small>{t('search.empty.sub')}</small>
            </div>
          )}

          {selected && (
            <>
              <div className="song-head">
                <div>
                  <h2 className="song-title">{selected.name}</h2>
                  <p className="song-sub">
                    {[selected.artist, selected.album, fmtDurationBadge(selected.durationMs)]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
              </div>

              {loadingLyric && <div className="status-line">{t('lyric.loading')}</div>}
              {!loadingLyric && lyricError === 'miss' && (
                <div className="status-line muted">{t('lyric.miss')}</div>
              )}
              {!loadingLyric && lyricError && lyricError !== 'miss' && (
                <div className="status-line error-text">⚠ {t('lyric.error', { msg: lyricError })}</div>
              )}

              {!loadingLyric && !lyricError && parsedLines.length > 0 && (
                <>
                  {/* 格式变体 + 特性徽章 */}
                  <div className="source-row">
                    <span className="source-label">{t('source.label')}</span>
                    <div className="variant-chips">
                      {sources.map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          className={`chip selectable${s.id === activeSource?.id ? ' selected' : ''}`}
                          onClick={() => setActiveSourceId(s.id)}
                        >
                          {s.id === 'ttml' ? 'TTML · AMLL' : FORMAT_LABELS[s.format] ?? s.format}
                        </button>
                      ))}
                    </div>
                    <div className="feature-chips">
                      {hasWordTiming && <StatusChip tone="accent">{t('chip.wordByWord')}</StatusChip>}
                      {!!lyricPayload?.translation && <StatusChip tone="good">{t('chip.translation')}</StatusChip>}
                      {!!lyricPayload?.romaji && <StatusChip tone="good">{t('chip.romaji')}</StatusChip>}
                      {!!lyricPayload?.ttml && <StatusChip tone="muted">{t('chip.ttmlOverlay')}</StatusChip>}
                    </div>
                  </div>

                  {/* Tabs */}
                  <nav className="tabs" role="tablist">
                    {['preview', 'raw', 'export'].map((id) => (
                      <button
                        key={id}
                        type="button"
                        role="tab"
                        aria-selected={tab === id}
                        className={`tab${tab === id ? ' on' : ''}`}
                        onClick={() => setTab(id)}
                      >
                        {t(`tab.${id}`)}
                      </button>
                    ))}
                  </nav>

                  {/* -------- 预览 -------- */}
                  {tab === 'preview' && (
                    <>
                      <div className="player-bar">
                        <button
                          type="button"
                          className="play-btn"
                          onClick={() => {
                            if (posMs >= durationMs) seek(0);
                            setPlaying((p) => !p);
                          }}
                        >
                          {playing ? '⏸' : '▶'}
                        </button>
                        <span className="time mono">{fmtTime(posMs)}</span>
                        <input
                          className="slider"
                          type="range"
                          min={0}
                          max={Math.max(1000, durationMs)}
                          step={50}
                          value={posMs}
                          onChange={(e) => seek(Number(e.target.value))}
                        />
                        <span className="time mono dim">{fmtTime(durationMs)}</span>
                        <select
                          className="speed-select"
                          value={speed}
                          onChange={(e) => setSpeed(Number(e.target.value))}
                          title="speed"
                        >
                          <option value={0.5}>0.5×</option>
                          <option value={1}>1×</option>
                          <option value={1.5}>1.5×</option>
                          <option value={2}>2×</option>
                        </select>
                        <label className="toggle">
                          <input type="checkbox" checked={showTrans} onChange={(e) => setShowTrans(e.target.checked)} />
                          {t('opt.translation')}
                        </label>
                        <label className="toggle">
                          <input type="checkbox" checked={showRomaji} onChange={(e) => setShowRomaji(e.target.checked)} />
                          {t('opt.romaji')}
                        </label>
                        <label className="toggle">
                          <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
                          {t('opt.autoscroll')}
                        </label>
                      </div>
                      <div
                        className="lyrics-wrap"
                        ref={listWrapRef}
                        onWheel={() => {
                          autoScrollSuspendUntil.current = Date.now() + 4000;
                        }}
                      >
                        <div className="lyrics-list">
                          {parsedLines.map((line, i) => (
                            <LineRow
                              key={i}
                              index={i}
                              line={line}
                              phase={i === activeIndex ? 'current' : i < activeIndex ? 'past' : 'future'}
                              showTrans={showTrans}
                              showRomaji={showRomaji}
                              progressMs={posMs}
                              onSeek={seek}
                            />
                          ))}
                        </div>
                      </div>
                    </>
                  )}

                  {/* -------- 原文 -------- */}
                  {tab === 'raw' && (
                    <RawPane
                      content={activeSource?.content ?? ''}
                      filename={rawFilename}
                    />
                  )}

                  {/* -------- 导出 -------- */}
                  {tab === 'export' && (
                    <div className="export-pane">
                      <h3 className="export-heading">{t('export.head')}</h3>
                      <ExportCard
                        title="LRC"
                        desc={t('export.lrc.desc')}
                        text={exportTexts.lrc}
                        filename={`${fileBase}.lrc`}
                      />
                      <ExportCard
                        title="Enhanced LRC"
                        desc={t('export.elrc.desc')}
                        text={exportTexts.enhancedLrc}
                        filename={`${fileBase}.lrc`}
                      />
                      <ExportCard
                        title="TTML"
                        desc={t('export.ttml.desc')}
                        text={exportTexts.ttml}
                        filename={`${fileBase}.ttml`}
                      />
                      {activeSource && (
                        <ExportCard
                          title={`RAW · ${(FORMAT_LABELS[activeSource.format] ?? activeSource.format).toUpperCase()}`}
                          desc={t('export.raw.desc', { fmt: activeSource.format.toUpperCase() })}
                          text={activeSource.content}
                          filename={rawFilename}
                          highlight
                        />
                      )}
                      <p className="dim tip-line">{t('export.previewTip')}</p>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </section>
      </main>
      )}

      <footer className="foot-note">
        LRC · ESLRC · QRC · YRC · KRC · TTML parsers ported from SPlayer-Next ·
        platform requests (NetEase eapi / QQ musicu.fcg / KuGou lyrics) are proxied by the plugin's local backend
      </footer>
    </div>
  );
}

/** 原文面板：等宽展示 + 复制/下载 */
function RawPane({ content, filename }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="raw-pane">
      <div className="raw-actions">
        <button
          type="button"
          className="btn"
          onClick={async () => {
            if (await copyText(content)) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            }
          }}
        >
          {copied ? t('raw.copied') : t('raw.copy')}
        </button>
        <button type="button" className="btn primary" onClick={() => downloadText(filename, content)}>
          ⬇ {t('raw.download')}
        </button>
        <code className="export-file">{filename}</code>
      </div>
      <pre className="raw-pre">{content}</pre>
    </div>
  );
}
