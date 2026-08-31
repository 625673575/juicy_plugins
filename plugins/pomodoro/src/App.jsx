import React, { useCallback, useEffect, useRef, useState } from 'react';
import { t as tx, lang, setLang } from './i18n.js';

const t = tx;

const MODES = {
  focus: { key: 'focus', color: '#a78bfa', length: (s) => s.focusMin },
  short: { key: 'short', color: '#4ade80', length: (s) => s.shortMin },
  long:  { key: 'long',  color: '#38bdf8', length: (s) => s.longMin },
};
const ROUNDS_PER_SET = 4;
const DAY_KEY = 'pomodoro.day';
const DONE_KEY = 'pomodoro.done';

const pad2 = (n) => String(n).padStart(2, '0');

function todayStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function readDoneToday() {
  try {
    if (localStorage.getItem(DAY_KEY) !== todayStamp()) return 0;
    return parseInt(localStorage.getItem(DONE_KEY) || '0', 10) || 0;
  } catch {
    return 0;
  }
}

function writeDoneToday(n) {
  try {
    localStorage.setItem(DAY_KEY, todayStamp());
    localStorage.setItem(DONE_KEY, String(n));
  } catch {
    /* ignore */
  }
}

/** Three short合成 chime notes via WebAudio (no assets needed). */
function playChime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [880, 1108.7, 1318.5].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t0 = ctx.currentTime + i * 0.22;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.45);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.5);
    });
    setTimeout(() => ctx.close(), 2000);
  } catch {
    /* audio unavailable */
  }
}

export default function App() {
  // settings (persisted)
  const [settings, setSettings] = useState(() => {
    try {
      return {
        focusMin: parseInt(localStorage.getItem('pomodoro.focusMin') || '25', 10) || 25,
        shortMin: parseInt(localStorage.getItem('pomodoro.shortMin') || '5', 10) || 5,
        longMin: parseInt(localStorage.getItem('pomodoro.longMin') || '15', 10) || 15,
        autoStart: localStorage.getItem('pomodoro.autoStart') !== '0',
        chime: localStorage.getItem('pomodoro.chime') !== '0',
      };
    } catch {
      return { focusMin: 25, shortMin: 5, longMin: 15, autoStart: true, chime: true };
    }
  });
  const [showSettings, setShowSettings] = useState(false);

  const [mode, setMode] = useState('focus');
  const [running, setRunning] = useState(false);
  // remaining seconds of the current round; derived from a wall-clock deadline
  // so sleep/thermal throttling never makes the timer drift.
  const [remaining, setRemaining] = useState(settings.focusMin * 60);
  const [round, setRound] = useState(1); // 1..4 within a set
  const [doneToday, setDoneToday] = useState(readDoneToday);
  const [flash, setFlash] = useState(''); // end-of-round banner text

  const deadlineRef = useRef(0);
  const modeRef = useRef(mode);
  const runningRef = useRef(running);
  const settingsRef = useRef(settings);
  modeRef.current = mode;
  runningRef.current = running;
  settingsRef.current = settings;

  const total = Math.max(1, Math.round(MODES[mode].length(settings) * 60));

  const persistSettings = useCallback((next) => {
    setSettings(next);
    try {
      localStorage.setItem('pomodoro.focusMin', String(next.focusMin));
      localStorage.setItem('pomodoro.shortMin', String(next.shortMin));
      localStorage.setItem('pomodoro.longMin', String(next.longMin));
      localStorage.setItem('pomodoro.autoStart', next.autoStart ? '1' : '0');
      localStorage.setItem('pomodoro.chime', next.chime ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, []);

  const resetRemaining = useCallback((m) => {
    const secs = Math.round(MODES[m].length(settingsRef.current) * 60);
    setRemaining(secs);
  }, []);

  const switchMode = useCallback((m) => {
    setMode(m);
    setRunning(false);
    const secs = Math.round(MODES[m].length(settingsRef.current) * 60);
    setRemaining(secs);
  }, []);

  const advance = useCallback(() => {
    // focus -> (round 4 ? long : short) -> focus; breaks always go back to focus
    if (modeRef.current === 'focus') {
      const nextRound = (round % ROUNDS_PER_SET) + 1;
      setRound(nextRound);
      return nextRound === 1 ? 'long' : 'short';
    }
    return 'focus';
  }, [round]);

  // tick: wall-clock deadline keeps the countdown accurate
  useEffect(() => {
    if (!running) return undefined;
    deadlineRef.current = Date.now() + remaining * 1000;
    const id = setInterval(() => {
      const left = Math.max(0, Math.round((deadlineRef.current - Date.now()) / 1000));
      setRemaining(left);
      if (left <= 0) {
        setRunning(false);
        if (settingsRef.current.chime) playChime();

        const finished = modeRef.current;
        if (finished === 'focus') {
          const n = readDoneToday() + 1;
          writeDoneToday(n);
          setDoneToday(n);
        }
        setFlash(t(finished === 'focus' ? 'msg.focusDone' : 'msg.breakDone'));
        setTimeout(() => setFlash(''), 4000);

        const nextMode = advance();
        const nextSecs = Math.round(MODES[nextMode].length(settingsRef.current) * 60);
        setMode(nextMode);
        setRemaining(nextSecs);
        if (settingsRef.current.autoStart) {
          deadlineRef.current = Date.now() + nextSecs * 1000;
          setRunning(true);
        }
      }
    }, 250);
    return () => clearInterval(id);
    // remaining intentionally read at start; interval resets whenever running flips
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, advance]);

  const mm = pad2(Math.floor(remaining / 60));
  const ss = pad2(remaining % 60);
  const pct = 1 - remaining / total;

  const [uiLang, setUiLang] = useState(lang());
  const toggleLang = useCallback(() => {
    const next = uiLang === 'zh' ? 'en' : 'zh';
    setLang(next);
    setUiLang(next);
  }, [uiLang]);

  const modeMeta = MODES[mode];
  const R = 132;
  const CIRC = 2 * Math.PI * R;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="logo">🍅</span>
          <div>
            <h1>{t('app.title')}</h1>
            <span className="sub">{t('app.sub')}</span>
          </div>
        </div>
        <div className="topbar-actions">
          <button type="button" className="ghost" onClick={toggleLang}>{t('lang.switch')}</button>
          <button type="button" className="ghost" onClick={() => setShowSettings((v) => !v)} aria-label="settings">⚙</button>
        </div>
      </header>

      <div className="mode-tabs" role="tablist">
        {Object.entries(MODES).map(([id, m]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={mode === id}
            className={`mode-tab${mode === id ? ' on' : ''}`}
            style={mode === id ? { borderColor: m.color, color: m.color } : undefined}
            onClick={() => !running && switchMode(id)}
            disabled={running}
          >
            {t(`mode.${m.key}`)}
          </button>
        ))}
      </div>

      <div className="dial-wrap">
        <svg className="dial" viewBox="0 0 320 320">
          <circle className="dial-track" cx="160" cy="160" r={R} />
          <circle
            className="dial-fill"
            cx="160"
            cy="160"
            r={R}
            stroke={modeMeta.color}
            strokeDasharray={CIRC}
            strokeDashoffset={CIRC * (1 - pct)}
            style={{ transition: 'stroke-dashoffset 0.3s linear' }}
          />
        </svg>
        <div className="dial-center">
          <div className="time" style={{ color: modeMeta.color }}>{mm}:{ss}</div>
          <div className="round-line">
            {t('stats.round')} {round} {t('stats.of')} {ROUNDS_PER_SET}
          </div>
        </div>
        {flash && <div className="flash">{flash}</div>}
      </div>

      <div className="controls">
        <button type="button" className="ctrl" onClick={() => { setRunning(false); resetRemaining(mode); }}>
          ↺<span>{t('action.reset')}</span>
        </button>
        <button type="button" className="ctrl main" onClick={() => setRunning((v) => !v)}>
          {running ? '⏸' : '▶'}<span>{running ? t('action.pause') : t('action.start')}</span>
        </button>
        <button
          type="button"
          className="ctrl"
          onClick={() => {
            const nextMode = advance();
            setMode(nextMode);
            setRunning(false);
            resetRemaining(nextMode);
          }}
        >
          ⏭<span>{t('action.skip')}</span>
        </button>
      </div>

      <footer className="stats">
        🍅 <b>{doneToday}</b> {t('stats.today')}
      </footer>

      {showSettings && (
        <div className="settings" onClick={(e) => { if (e.target === e.currentTarget) setShowSettings(false); }}>
          <div className="sheet">
            <h2>{t('settings.title')}</h2>
            {[
              ['focusMin', t('settings.focus')],
              ['shortMin', t('settings.short')],
              ['longMin', t('settings.long')],
            ].map(([key, label]) => (
              <label key={key} className="row">
                <span>{label}</span>
                <input
                  type="number"
                  min={1}
                  max={120}
                  value={settings[key]}
                  onChange={(e) => {
                    const v = Math.min(120, Math.max(1, parseInt(e.target.value, 10) || 1));
                    const next = { ...settings, [key]: v };
                    persistSettings(next);
                    if (!running && modeRef.current === MODES[key.replace('Min', '')]?.key) resetRemaining(key.replace('Min', ''));
                  }}
                />
              </label>
            ))}
            <label className="row toggle">
              <input
                type="checkbox"
                checked={settings.autoStart}
                onChange={(e) => persistSettings({ ...settings, autoStart: e.target.checked })}
              />
              <span>{t('settings.auto')}</span>
            </label>
            <label className="row toggle">
              <input
                type="checkbox"
                checked={settings.chime}
                onChange={(e) => persistSettings({ ...settings, chime: e.target.checked })}
              />
              <span>{t('settings.chime')}</span>
            </label>
            <button type="button" className="done" onClick={() => setShowSettings(false)}>{t('settings.done')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
