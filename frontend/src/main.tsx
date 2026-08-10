import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

// === Error Reporting for Mobile Wallet Browsers ===
function showErrorOverlay(text: string) {
  let el = document.getElementById('zeus-error-overlay') as HTMLDivElement | null;
  if (!el) {
    el = document.createElement('div');
    el.id = 'zeus-error-overlay';
    el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;' +
      'background:#7f1d1d;color:#fff;font:12px monospace;padding:8px;' +
      'white-space:pre-wrap;max-height:40vh;overflow:auto;';
    document.body.appendChild(el);
  }
  el.textContent += text + '\n';
}

function report(msg: string) {
  try {
    const apiUrl = (import.meta.env.VITE_API_BASE_URL || '/api') + '/client-error';
    fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: msg,
        ua: navigator.userAgent,
        url: location.href,
      }),
    }).catch(() => {});
  } catch {}
}

window.addEventListener('error', (e) => {
  const msg = `[fe-error] ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`;
  showErrorOverlay(msg);
  report(msg);
});

window.addEventListener('unhandledrejection', (e) => {
  const msg = `[fe-reject] ${String(e.reason)}`;
  showErrorOverlay(msg);
  report(msg);
});
// === End Error Reporting ===

createRoot(document.getElementById('root')!).render(<App />);
