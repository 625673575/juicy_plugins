import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import { t, lang } from './i18n.js';

// Apply detected language to <html lang>, document title and meta description.
const L = lang();
document.documentElement.lang = L === 'zh' ? 'zh-CN' : 'en';
document.title = t('meta.title');
const meta = document.querySelector('meta[name="description"]');
if (meta) meta.setAttribute('content', t('meta.desc'));

// --- Global error overlay --------------------------------------------------
// 把未捕获错误（含异步）直接铺在页面上，WebView 里不至于白屏无信息。
function showErrorOverlay(err, stack) {
  let el = document.getElementById('__err_overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = '__err_overlay';
    el.style.cssText =
      'position:fixed;inset:0;z-index:99999;background:rgba(20,0,0,.92);color:#ffb4b4;' +
      'font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;padding:16px;overflow:auto;white-space:pre-wrap';
    document.body.appendChild(el);
  }
  const msg = (err && (err.stack || err.message || String(err))) || String(err);
  el.textContent = '⚠ Runtime error\n\n' + msg + (stack ? '\n\n' + stack : '');
}
window.addEventListener('error', (e) => showErrorOverlay(e.error || e.message, e.error && e.error.stack));
window.addEventListener('unhandledrejection', (e) => showErrorOverlay(e.reason, e.reason && e.reason.stack));
// ---------------------------------------------------------------------------

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
