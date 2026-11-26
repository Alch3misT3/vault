'use strict';
// App-wide hardening (Electron security checklist).
//
// - Vault's pages are served from https://vault.localhost/ by an in-app handler, never from file://
//   (checklist #18). Nothing goes over the network: every other request from these pages is refused.
//   The https origin is also what lets the window use WebAuthn (passkey unlock).
// - No page may navigate, open windows or attach <webview>s; DevTools stay shut in the built app.
// - Every permission request is refused.
// - IPC: each handler names the one page allowed to call it; anything else is refused.

const { app, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');

const HOST = 'vault.localhost';
const ORIGIN = 'https://' + HOST;
const SRC = path.join(__dirname, 'src');

// Same policy as the pages' own <meta> tags, plus what only a header can say.
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; " +
  "connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'";
const CSP_DECODER = "default-src 'none'; script-src 'self'; img-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
};

const pageUrl = (name) => `${ORIGIN}/${name}`;

// Serve src/ at https://vault.localhost/ in this session, and refuse everything else it asks for.
const served = new WeakSet();
function serveApp(ses) {
  if (served.has(ses)) return ses; // a session is set up once (windows using it may come and go)
  served.add(ses);
  ses.protocol.handle('https', (req) => {
    let u;
    try { u = new URL(req.url); } catch { return new Response(null, { status: 400 }); }
    if (u.host !== HOST || req.method !== 'GET') return new Response(null, { status: 403 });
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    const file = path.resolve(SRC, rel);
    if (!rel || !file.startsWith(SRC + path.sep) || !TYPES[path.extname(file)]) return new Response(null, { status: 404 });
    let body;
    try { body = fs.readFileSync(file); } catch { return new Response(null, { status: 404 }); }
    const headers = {
      'Content-Type': TYPES[path.extname(file)],
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
    };
    if (file.endsWith('.html')) headers['Content-Security-Policy'] = rel === 'logo-decoder.html' ? CSP_DECODER : CSP;
    return new Response(body, { headers });
  });
  // Belt and braces: the pages may only load Vault's own files.
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (d, cb) => {
    let ok = false;
    try { const u = new URL(d.url); ok = (u.protocol === 'https:' && u.host === HOST) || u.protocol === 'devtools:'; } catch {}
    cb({ cancel: !ok });
  });
  lockDownSession(ses);
  return ses;
}

function lockDownSession(ses) {
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler((_req, cb) => cb({}));
  // (the callback is the last argument; an empty id means "none chosen")
  for (const ev of ['select-hid-device', 'select-serial-port', 'select-usb-device']) {
    ses.on(ev, (e, ...args) => { e.preventDefault(); const cb = args[args.length - 1]; if (typeof cb === 'function') try { cb(''); } catch {} });
  }
  ses.on('will-download', (e) => e.preventDefault());
  ses.setSpellCheckerEnabled(false);
}

let uiSession = null;
// One in-memory session for all of Vault's windows: nothing they hold is ever written to disk.
function appSession() {
  if (!uiSession) uiSession = serveApp(session.fromPartition('vault-ui'));
  return uiSession;
}

function hardenApp({ dev }) {
  app.enableSandbox();
  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.on('will-frame-navigate', (e) => { if (!e.isMainFrame) e.preventDefault(); });
    wc.on('will-redirect', (e) => e.preventDefault());
    wc.on('will-attach-webview', (e) => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('select-bluetooth-device', (e, _list, cb) => { e.preventDefault(); cb(''); });
    if (!dev) wc.on('devtools-opened', () => wc.closeDevTools());
  });
  app.whenReady().then(() => lockDownSession(session.defaultSession));
}

// webPreferences every Vault window uses.
function webPrefs(extra) {
  return {
    contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
    webSecurity: true, allowRunningInsecureContent: false, experimentalFeatures: false, webviewTag: false,
    navigateOnDragDrop: false, spellcheck: false, safeDialogs: true,
    ...extra,
  };
}

// ---------- IPC: only the named page of the named window may call --------------------
// pages: { 'index.html': () => win, 'quick.html': () => quick, ... }
function makeGuard(pages) {
  const refused = [];
  function allowed(e, page) {
    const f = e.senderFrame;
    if (!f || f.parent || f.isDestroyed?.()) return false;
    const w = pages[page] && pages[page]();
    if (!w || w.isDestroyed() || e.sender !== w.webContents) return false;
    let u;
    try { u = new URL(f.url); } catch { return false; }
    return u.origin === ORIGIN && u.pathname === '/' + page && !u.search;
  }
  return {
    handle(page, channel, fn) {
      ipcMain.handle(channel, (e, ...args) => {
        if (!allowed(e, page)) { refused.push(channel); return null; }
        return fn(e, ...args);
      });
    },
    on(page, channel, fn) {
      ipcMain.on(channel, (e, ...args) => {
        if (!allowed(e, page)) { refused.push(channel); return; }
        fn(e, ...args);
      });
    },
    allowed, refused,
  };
}

module.exports = { HOST, ORIGIN, CSP, pageUrl, serveApp, appSession, hardenApp, webPrefs, makeGuard, lockDownSession };
