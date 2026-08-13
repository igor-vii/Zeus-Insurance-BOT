import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import API_BASE from './lib/api-base';

import * as Sentry from "@sentry/react";

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  environment: import.meta.env.MODE,
  integrations: [
    new Sentry.BrowserTracing(),
    new Sentry.Replay(),
  ],
  tracesSampleRate: 0.1,
  replaysSessionSampleRate: 0.05,
  replaysOnErrorSampleRate: 1.0,
});

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
    const apiUrl = API_BASE + '/client-error';
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

createRoot(document.getElementById('root')!).render(<App />
  </Sentry.ErrorBoundary>);
