'use strict';
// Vault — main process.
// Holds the encryption key, reads/writes the encrypted vault file and is the
// only place that touches the clipboard or opens links in the default browser.

const { app, BrowserWindow, webFrameMain, ipcMain, Menu, clipboard, shell, nativeTheme, powerMonitor, dialog, globalShortcut, Tray, nativeImage, screen, safeStorage, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { otp } = require('./src/otp.js');
const security = require('./security');

// Test/dev switches only exist when running from source, never in the built app.
const DEV = !app.isPackaged;
const SHOTS = DEV && process.argv.includes('--screenshots'); // README screenshots, same sandbox as the smoke test
// A second Vault started by the smoke test (and then killed) to check a forced close loses nothing.
const SMOKE_CHILD = DEV && process.argv.includes('--smoke-child');
const SMOKE = DEV && (process.argv.includes('--smoke') || SHOTS || SMOKE_CHILD);
const MAKE_ICON = DEV && process.argv.includes('--make-icon');
const START_HIDDEN = process.argv.includes('--hidden'); // started with Windows: stay in the notification area
const HOTKEY = 'CommandOrControl+Shift+Space';

// Portable edition (Vault-Portable.exe): keep the data in a "Vault Data" folder
// right next to the .exe, so the app and its vault travel together on a USB stick.
const PORTABLE_DIR = process.env.PORTABLE_EXECUTABLE_DIR || (DEV && process.env.VAULT_PORTABLE_TEST) || null;

security.hardenApp({ dev: DEV });

if (SMOKE) {
  // Never touch the real vault while testing.
  app.setPath('userData', SMOKE_CHILD && process.env.VAULT_SMOKE_DIR ? process.env.VAULT_SMOKE_DIR : path.join(app.getPath('temp'), 'vault-smoke-' + Date.now()));
  // Screenshots of a window that other windows cover (Windows otherwise skips painting it). Test runs only.
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
} else if (PORTABLE_DIR) {
  const dataDir = path.join(PORTABLE_DIR, 'Vault Data');
  fs.mkdirSync(dataDir, { recursive: true });
  app.setPath('userData', dataDir);
}

// ---------- Crypto (vaultfile.js) -----------------------------------------------
// A random 256-bit vault key encrypts the data (AES-256-GCM). It is stored wrapped by the master
// password (scrypt, N = 2^18) and by each enrolled passkey (HKDF of its WebAuthn PRF output).
const VF = require('./vaultfile');

// ---------- Vault file -------------------------------------------------------
const vaultPath = () => path.join(app.getPath('userData'), 'vault.json');
const v1BackupPath = () => path.join(app.getPath('userData'), 'vault-v1-backup.json');

// { key: vault key K, extra: the rest of the decrypted payload (website passkeys) }
// or, only if converting an old vault failed: { key: scrypt key, v1: true, salt, kdf, extra }
let session = null;
let logos = null;   // site logos (logos.js), encrypted with a key derived from session.key
let failedAttempts = 0;

function readFile() {
  return JSON.parse(fs.readFileSync(vaultPath(), 'utf8'));
}

// Write to a temp file, flush it to disk, then rename over the old one: a crash or power cut
// leaves either the old vault or the new one, never half of one. Everything written is encrypted.
function writeDurable(file, text) {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
// bak: 'previous' keeps the last version as vault.json.bak (a safety net);
// 'same' makes the .bak a copy of the new file (after the keys changed, so an old password or a
// removed passkey can't open the .bak either).
function writeFileAtomic(contents, { bak = 'previous' } = {}) {
  const file = vaultPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(contents);
  if (bak === 'previous' && fs.existsSync(file)) writeDurable(file + '.bak', fs.readFileSync(file, 'utf8'));
  writeDurable(file, text);
  if (bak === 'same') writeDurable(file + '.bak', text);
}

const payloadOf = (items) => ({ ...(session.extra || {}), items });

function persist(items) {
  if (!session) throw new Error('locked');
  if (session.v1) { // old format kept only because converting it failed
    writeFileAtomic({
      app: 'vault', version: 1,
      kdf: { name: 'scrypt', N: session.kdf.N, r: session.kdf.r, p: session.kdf.p, salt: session.salt.toString('base64') },
      cipher: 'aes-256-gcm', ...VF.sealJson(session.key, payloadOf(items), null),
    });
    return;
  }
  const cur = readFile();
  // Same key wraps, new data box (fresh nonce every save).
  writeFileAtomic({ app: 'vault', version: 2, kdf: cur.kdf, keys: cur.keys, cipher: 'aes-256-gcm', ...VF.sealJson(session.key, payloadOf(items), VF.AAD.data) });
}

function startSession(key, payload, more) {
  const { items, ...extra } = payload || {};
  if (session && session.key !== key) session.key.fill(0); // unlocked again: drop the old copy of the key
  session = { key, extra, ...(more || {}) };
  failedAttempts = 0;
  mainDirty = true; activity();
  setImmediate(() => updatePrompt()); // a passkey request waiting for the unlock can go on
  setImmediate(() => { if (session && MAIL) MAIL.onUnlock(); });
  return items || [];
}

// A fresh version-2 vault around `payload`: new vault key, new salt, current scrypt cost. No passkeys.
async function newVaultFile(password, payload) {
  const K = crypto.randomBytes(32);
  const salt = crypto.randomBytes(16);
  const pwKey = await VF.deriveKey(password, salt, VF.KDF);
  try { return { K, file: VF.buildV2({ K, pwKey, salt, kdf: VF.KDF, passkeys: [], payload }) }; } finally { pwKey.fill(0); }
}

// Old (version 1) vault: keep a copy, convert, and check the result opens before relying on it.
async function migrateV1(original, password, payload) {
  const text = fs.readFileSync(vaultPath(), 'utf8');
  if (!fs.existsSync(v1BackupPath())) writeDurable(v1BackupPath(), text);
  const { K, file } = await newVaultFile(password, payload);
  try {
    writeFileAtomic(file);
    const back = readFile();
    const pwKey = await VF.deriveKey(password, Buffer.from(back.kdf.salt, 'base64'), VF.kdfOf(back));
    const K2 = VF.unwrapWithPassword(back, pwKey);
    pwKey.fill(0);
    const p2 = VF.readPayload(back, K2);
    if (!K2.equals(K) || JSON.stringify(p2) !== JSON.stringify(payload)) throw new Error('check failed');
    K2.fill(0);
    return K;
  } catch (err) {
    writeDurable(vaultPath(), text); // put the old vault back as it was
    K.fill(0);
    logUpdate('[vault] converting to the new format failed: ' + (err && err.name));
    return null;
  }
}

function lock() {
  if (logos) logos.lock();
  if (MAIL) MAIL.onLock();
  mailFrames.clear();
  if (session) session.key.fill(0);
  session = null;
}

// Lock and also wipe what the windows held: each window that showed vault data is reloaded in a
// fresh renderer process, so its memory (accounts, typed text, undo history) goes with the old one.
// The main window first plays its short lock animation, then asks for this itself ('app:purge').
let purgeTimer = null;
function purge(w) {
  if (!w || w.isDestroyed()) return;
  const wc = w.webContents;
  const url = wc.getURL();
  wc.once('render-process-gone', () => { if (!wc.isDestroyed()) wc.loadURL(url); });
  wc.forcefullyCrashRenderer();
}
function lockVault({ notify = true } = {}) {
  const was = !!session;
  lock();
  if (notify) send('locked');
  if (quick && !quick.isDestroyed() && quickDirty) { quickDirty = false; hideQuick(); purge(quick); }
  if (prompt && !prompt.isDestroyed() && promptDirty) {
    promptDirty = false;
    purge(prompt); // a pending request stays: the fresh page asks to unlock first
    if (pkCurrent) prompt.webContents.once('did-finish-load', updatePrompt);
  }
  clearTimeout(purgeTimer);
  if (was) purgeTimer = setTimeout(() => { if (!session && mainDirty) { mainDirty = false; purge(win); } }, 2000);
}
let mainDirty = false;  // the main window has shown unlocked data since its last purge
let quickDirty = false; // the quick panel has listed accounts since its last purge

// Auto-lock after 5 minutes without anyone using Vault (window, quick search or browser).
const AUTO_LOCK_MS = 5 * 60 * 1000;
let lastActivity = Date.now();
const activity = () => { lastActivity = Date.now(); };
const idle = { ms: AUTO_LOCK_MS };
setInterval(() => { if (session && Date.now() - lastActivity > idle.ms) lockVault(); }, SMOKE ? 250 : 10_000);

// ---------- Clipboard: copied secrets clear themselves -----------------------
// (Electron 45's clipboard calls return Promises.) Only a hash of the copied secret is kept, to
// recognise it later: the clipboard is cleared only if it still holds that secret.
let clipTimer = null;
let clipHash = null;
const CLIP_CLEAR_MS = SMOKE ? 1500 : 30_000;
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
async function copy(text, isSecret) {
  await clipboard.writeText(String(text));
  clearTimeout(clipTimer);
  clipHash = isSecret ? sha(text) : null;
  if (isSecret) clipTimer = setTimeout(clearClipboard, CLIP_CLEAR_MS);
}
async function clearClipboard() {
  clearTimeout(clipTimer);
  const h = clipHash;
  clipHash = null;
  if (h && sha(await clipboard.readText()) === h) await clipboard.clear();
}

// ---------- Links: only real web addresses go to the browser ----------------
const opened = []; // smoke-test log
function openUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password) return false; // https only
  if (SMOKE) { opened.push(u.href); return true; }
  shell.openExternal(u.href);
  return true;
}

// ---------- Password changes and the breach check (pwchange.js) ---------------
const PW = require('./pwchange')({ links: require('./src/links.js') });
const liveItem = (id) => (sessionItems() || []).find((x) => x.id === id && !x.deletedAt) || null;
const breachOn = () => prefs().breachCheck === true;

// The window saved the new password as "pending" first; now open the site's change-password page.
async function openChangePage(id) {
  const it = session && liveItem(String(id));
  if (!it || !it.pending) return null;
  activity();
  const r = await PW.changePage(it);
  if (!r || !openUrl(r.url)) return null;
  return r;
}

// Small settings that belong to the vault, not to this PC (queue and checklist progress, breach
// results), saved inside the encrypted vault next to the accounts as they are on disk.
const UI_KEYS = ['changeQueue', 'emailChange'];
function saveExtra(patch) {
  const items = sessionItems();
  if (!session || !items) return false;
  const before = session.extra;
  session.extra = { ...(session.extra || {}), ...patch };
  try { persist(items); } catch { session.extra = before; return false; }
  return true;
}

let breachRun = null;
async function checkBreaches() {
  if (!session || !breachOn()) return { on: breachOn(), counts: {} };
  if (breachRun) return breachRun;
  breachRun = (async () => {
    const items = sessionItems() || [];
    const r = await PW.breachCheck(items, (session && session.extra && session.extra.breach) || {});
    if (!session) return { on: true, counts: {} };
    if (JSON.stringify(r.cache) !== JSON.stringify(session.extra.breach || {})) saveExtra({ breach: r.cache });
    return { on: true, counts: r.counts, failed: r.failed };
  })().finally(() => { breachRun = null; });
  return breachRun;
}

// ---------- Generated email addresses and their mail (mail/) ---------------------
let MAIL = null;
const mailFrames = new Map(); // id -> cleaned HTML of a mail being shown (only while unlocked)
function setupMail() {
  MAIL = require('./mail')({
    app, getKey: () => (session ? session.key : null), getExtra: () => (session && !session.v1 ? session.extra : null), saveExtra, send,
    log: (m) => logUpdate('[mail] ' + m), // fixed messages and error codes only
  });
  security.setMailFrames((id) => (session && mailFrames.has(id) ? mailFrames.get(id) : null), (url) => send('mail:link', url));
  const op = (name, fn) => handle('mail:' + name, async (_e, ...args) => {
    if (!session) return { error: 'locked' };
    activity();
    try { return await fn(...args); } catch (err) { logUpdate('[mail] ' + name + ' failed: ' + ((err && err.code) || (err && err.name))); return { error: (err && err.code) || 'failed' }; }
  });
  op('state', () => MAIL.publicState());
  op('set-temp', (on) => MAIL.setTemp(on === true));
  op('alias-key', (service, key) => MAIL.setAliasKey(String(service), key == null ? null : String(key)));
  op('mailbox', (box) => MAIL.setMailbox(box && typeof box === 'object' ? box : null));
  op('cf-zones', (token) => MAIL.cfZones(String(token || '')));
  op('cf-deploy', (o) => MAIL.cfDeploy(o && typeof o === 'object' ? o : {}).then((st) => { MAIL.restart(); return st; }));
  op('cf-test', () => MAIL.cfTest());
  op('cf-remove', () => MAIL.cfRemove());
  op('create', async (o) => { const a = await MAIL.create(o && typeof o === 'object' ? o : {}); MAIL.restart(); return { address: a, state: MAIL.publicState() }; });
  op('remove', (id) => MAIL.remove(String(id)).then(() => MAIL.publicState()));
  op('set-state', (id, on) => MAIL.setState(String(id), on === true).then(() => MAIL.publicState()));
  op('link', (id, entryId) => MAIL.link(String(id), entryId == null ? null : String(entryId)));
  op('check', () => MAIL.check('all'));
  op('list', () => MAIL.messages());
  op('get', (id) => MAIL.message(String(id)));
  op('seen', (id) => MAIL.markSeen(String(id)));
  op('delete', (id) => MAIL.deleteMessage(String(id)));
  // The window cleaned the mail's HTML; Vault serves it at a random address the mail frame loads.
  op('frame', (html) => {
    if (typeof html !== 'string' || html.length > 4 * 1024 * 1024) return null;
    const id = crypto.randomBytes(16).toString('hex');
    mailFrames.set(id, html);
    while (mailFrames.size > 4) mailFrames.delete(mailFrames.keys().next().value);
    return security.MAIL_FRAME + id;
  });
}

// ---------- Window -----------------------------------------------------------
let win = null;

// Test runs put their windows on a second screen when there is one, out of the way of the main screen.
function testWorkArea() {
  const main = screen.getPrimaryDisplay();
  return (screen.getAllDisplays().find((d) => d.id !== main.id) || main).workArea;
}
const placeArea = () => (SMOKE ? testWorkArea() : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea);

// IPC: every handler belongs to one page; calls from anything else are refused (security.js).
const guard = security.makeGuard({ 'index.html': () => win, 'quick.html': () => quick, 'prompt.html': () => prompt });
const handle = (channel, fn) => guard.handle('index.html', channel, fn);
const handleQuick = (channel, fn) => guard.handle('quick.html', channel, fn);

function themeColors() {
  const dark = nativeTheme.shouldUseDarkColors;
  return dark
    ? { bg: '#0a0c12', overlay: 'rgba(0,0,0,0)', symbol: '#f4f4f7' }
    : { bg: '#e8ecf4', overlay: 'rgba(0,0,0,0)', symbol: '#16161a' };
}

function createWindow() {
  const c = themeColors();
  win = new BrowserWindow({
    width: 1080, height: 720, minWidth: 780, minHeight: 520,
    title: 'Vault',
    show: false,
    backgroundColor: c.bg,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: c.overlay, symbolColor: c.symbol, height: 44 },
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: security.webPrefs({ preload: path.join(__dirname, 'preload.js'), session: security.appSession(), devTools: DEV }),
  });
  win.loadURL(security.pageUrl('index.html'));
  if (!SMOKE && !START_HIDDEN) win.once('ready-to-show', () => win.show());

  // Closing the window keeps Vault in the notification area (Quit is in the tray menu and File menu).
  win.on('close', (e) => {
    if (quitting || SMOKE || !tray) return;
    e.preventDefault();
    win.hide();
    if (!prefs().trayHintShown) {
      setPref('trayHintShown', true);
      tray.displayBalloon({ iconType: 'info', title: 'Vault is still running', content: 'Press Ctrl+Shift+Space anywhere to find a password. To quit, right-click the Vault icon here.' });
    }
  });

  // Nothing inside the app may navigate away or spawn windows (security.js); links go to the browser.
  win.webContents.setWindowOpenHandler(({ url }) => { openUrl(url); return { action: 'deny' }; });
  // A link clicked inside a mail: the page's policy stops the frame from going there; the window
  // then shows the real address and asks before opening it in the browser.
  // (The only frames this page may have are mail frames, so a frame stopped by that policy is one.)
  win.webContents.on('did-fail-provisional-load', (_e, code, _desc, url, isMainFrame, pid, rid) => {
    if (isMainFrame || code !== -30 || !/^https?:/i.test(String(url))) return; // -30: ERR_BLOCKED_BY_CSP
    const f = webFrameMain.fromId(pid, rid);
    const top = win.webContents.mainFrame;
    if (f && f.parent && f.parent.frameTreeNodeId === top.frameTreeNodeId && String(top.url).startsWith(security.ORIGIN + '/index.html')) send('mail:link', String(url));
  });
}

nativeTheme.on('updated', () => {
  if (!win) return;
  const c = themeColors();
  win.setBackgroundColor(c.bg);
  try { win.setTitleBarOverlay({ color: c.overlay, symbolColor: c.symbol, height: 44 }); } catch {}
});

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'New Account', accelerator: 'CmdOrCtrl+N', click: () => send('menu', 'new') },
        { label: 'Find', accelerator: 'CmdOrCtrl+F', click: () => send('menu', 'find') },
        { type: 'separator' },
        { label: 'Import Passwords…', accelerator: 'CmdOrCtrl+I', click: () => send('menu', 'import') },
        { label: 'Export Passwords…', accelerator: 'CmdOrCtrl+Shift+E', click: () => send('menu', 'export') },
        { label: 'Back Up Vault…', click: () => send('menu', 'backup') },
        { type: 'separator' },
        { label: 'Password Generator…', accelerator: 'CmdOrCtrl+G', click: () => send('menu', 'generator') },
        { label: 'Connect a Browser…', click: () => send('menu', 'browser') },
        { label: 'Change Master Password…', click: () => send('menu', 'change-password') },
        { label: 'Unlock With Passkey…', click: () => send('menu', 'passkeys') },
        { label: 'Show Vault File', click: () => shell.showItemInFolder(vaultPath()) },
        { type: 'separator' },
        { label: 'Lock Vault', accelerator: 'CmdOrCtrl+L', click: () => lockVault() },
        { label: 'Quit Vault', accelerator: 'CmdOrCtrl+Q', click: () => { quitting = true; app.quit(); } },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    {
      label: 'Help',
      submenu: [{
        label: 'About Vault',
        click: () => dialog.showMessageBox(win, {
          type: 'info', title: 'About Vault', message: 'Vault ' + app.getVersion(), buttons: ['OK'],
          detail: 'A private, offline password manager.\nYour vault is encrypted with AES-256-GCM and never leaves this computer.\n\n' +
            'Vault file: ' + vaultPath() + (PORTABLE_DIR ? '\n(portable mode: data is kept next to the app)' : ''),
        }),
      }, { label: 'Check for Updates…', click: () => send('menu', 'check-updates') }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- Updates ------------------------------------------------------------
// Installed app: electron-updater downloads new GitHub releases in the background
// (checked against the release's SHA-512) and installs them on restart.
// Portable app: can't replace itself, so it just offers the download page.
// Where releases live. (Kept here because the build tool strips 'build.publish' from the bundled package.json.)
const PUBLISH = { owner: 'Alch3misT3', repo: 'vault' };

// Update problems are written to update.log in the app's data folder (no passwords or vault data ever go here).
function logUpdate(msg) {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'update.log'), new Date().toISOString() + '  ' + msg + '\n'); } catch {}
}
const update = { status: 'idle', version: null, url: null }; // idle | checking | downloading | ready | available | latest | error
let autoUpdater = null;

function setUpdate(patch) {
  Object.assign(update, patch);
  send('update', { ...update });
}

function newer(a, b) { // is version a newer than b?
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
}

async function checkForUpdates() {
  if (!PUBLISH || DEV) return { ...update, status: 'unavailable' };
  if (update.status === 'downloading' || update.status === 'ready') return { ...update };
  setUpdate({ status: 'checking' });
  try {
    if (PORTABLE_DIR) {
      const { net } = require('electron');
      const res = await net.fetch(`https://api.github.com/repos/${PUBLISH.owner}/${PUBLISH.repo}/releases/latest`, { headers: { 'User-Agent': 'Vault-updater', Accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const rel = await res.json();
      if (newer(rel.tag_name, app.getVersion())) setUpdate({ status: 'available', version: rel.tag_name.replace(/^v/, ''), url: rel.html_url });
      else setUpdate({ status: 'latest' });
    } else {
      const r = await autoUpdater.checkForUpdates();
      if (!r || !r.updateInfo || !newer(r.updateInfo.version, app.getVersion())) setUpdate({ status: 'latest' });
    }
  } catch (err) {
    setUpdate({ status: 'error' });
    logUpdate('check failed: ' + (err && err.message));
  }
  return { ...update };
}

function setupUpdates() {
  if (DEV || !PUBLISH) return;
  if (!PORTABLE_DIR) {
    autoUpdater = require('electron-updater').autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.disableWebInstaller = true;
    autoUpdater.logger = { info: () => {}, debug: () => {}, warn: (m) => logUpdate('warn: ' + m), error: (m) => logUpdate('error: ' + m) };
    autoUpdater.on('update-available', (i) => setUpdate({ status: 'downloading', version: i.version }));
    autoUpdater.on('update-downloaded', (i) => setUpdate({ status: 'ready', version: i.version }));
    autoUpdater.on('error', () => { if (update.status !== 'ready') setUpdate({ status: 'error' }); });
  }
  setTimeout(checkForUpdates, 6000);
  setInterval(checkForUpdates, 6 * 60 * 60 * 1000);
}

handle('update:check', () => checkForUpdates());
handle('update:state', () => ({ ...update }));
handle('update:install', () => {
  if (update.status === 'ready' && autoUpdater) { lock(); quitting = true; autoUpdater.quitAndInstall(true, true); return true; }
  if (update.status === 'available' && update.url) { openUrl(update.url); return true; }
  return false;
});

// ---------- IPC --------------------------------------------------------------
// The lock screen needs to know which passkeys can unlock (ids, PRF salts: neither is secret).
function unlockPasskeys() {
  try { const f = readFile(); return f.version === 2 && f.keys && Array.isArray(f.keys.passkeys) ? f.keys.passkeys : []; } catch { return []; }
}
handle('vault:status', () => ({
  exists: fs.existsSync(vaultPath()), unlocked: !!session,
  passkeys: unlockPasskeys().map((p) => ({ id: p.id, salt: p.salt, transports: p.transports || [] })),
}));

handle('vault:create', async (_e, password) => {
  if (fs.existsSync(vaultPath())) return { ok: false, error: 'exists' };
  if (typeof password !== 'string' || password.length < 8) return { ok: false, error: 'short' };
  const { K, file } = await newVaultFile(password, { items: [] });
  writeFileAtomic(file);
  startSession(K, { items: [] });
  return { ok: true, items: [] };
});

handle('vault:unlock', (_e, password) => unlock(password));

async function backoff() {
  // Gentle back-off after repeated wrong guesses.
  if (failedAttempts > 3) await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** (failedAttempts - 4))));
}

async function unlock(password) {
  if (typeof password !== 'string') return { ok: false, error: 'wrong' };
  await backoff();
  let file;
  try { file = readFile(); } catch { return { ok: false, error: 'missing' }; }
  let key;
  try { key = await VF.deriveKey(password, Buffer.from(file.kdf.salt, 'base64'), VF.kdfOf(file)); } catch { return { ok: false, error: 'damaged' }; }
  if (file.version === 2) {
    let K, payload;
    try { K = VF.unwrapWithPassword(file, key); payload = VF.readPayload(file, K); } catch { failedAttempts++; return { ok: false, error: 'wrong' }; } finally { key.fill(0); }
    return { ok: true, items: startSession(K, payload) };
  }
  // Version 1 (Vault 1.3 and older): open it, then convert it (a copy of the old file is kept).
  let payload;
  try { payload = VF.readV1(file, key); } catch { key.fill(0); failedAttempts++; return { ok: false, error: 'wrong' }; }
  const K = await migrateV1(file, password, payload);
  if (!K) return { ok: true, items: startSession(key, payload, { v1: true, salt: Buffer.from(file.kdf.salt, 'base64'), kdf: VF.kdfOf(file) }) };
  const items = startSession(K, payload);
  try { if (logos) logos.rekey(key); if (MAIL) MAIL.rekey(key); } finally { key.fill(0); } // caches sealed with the old key
  return { ok: true, items, migrated: true };
}

handle('vault:unlock-passkey', (_e, id, prf) => unlockWithPasskey(id, prf));
async function unlockWithPasskey(id, prfB64) {
  if (session) return { ok: true, items: sessionItems() };
  const entry = unlockPasskeys().find((p) => p.id === id);
  const prf = typeof prfB64 === 'string' ? Buffer.from(prfB64, 'base64') : null;
  if (!entry || !prf || prf.length !== 32) return { ok: false, error: 'unknown' };
  await backoff();
  let K, payload;
  try { K = VF.unwrapWithPasskey(entry, prf); payload = VF.readPayload(readFile(), K); } catch { failedAttempts++; return { ok: false, error: 'wrong' }; } finally { prf.fill(0); }
  return { ok: true, items: startSession(K, payload) };
}

// The decrypted vault as last saved by the window (the quick-search panel reads it from here).
function sessionPayload() {
  if (!session) return null;
  try { const f = readFile(); return session.v1 ? VF.readV1(f, session.key) : VF.readPayload(f, session.key); } catch { return null; }
}
function sessionItems() { const p = sessionPayload(); return p ? p.items || [] : null; }
const nodeHmac = (alg, key, msg) => new Uint8Array(crypto.createHmac(alg.toLowerCase(), Buffer.from(key)).update(Buffer.from(msg)).digest());

handle('vault:save', (_e, items) => {
  if (!session) return { ok: false, error: 'locked' };
  if (!Array.isArray(items)) return { ok: false, error: 'bad' };
  try { persist(items); return { ok: true }; } catch { return { ok: false, error: 'failed' }; }
});

// A new master password gets a new vault key too, so an old copy of the file plus the old password
// opens nothing current. Passkeys wrapped the old key, so they have to be added again.
handle('vault:change-password', async (_e, current, next, items) => {
  if (!session) return { ok: false, error: 'locked' };
  if (typeof next !== 'string' || next.length < 8) return { ok: false, error: 'short' };
  if (!Array.isArray(items)) return { ok: false, error: 'bad' };
  if (!(await verifyPassword(String(current)))) return { ok: false, error: 'wrong' };
  const removed = unlockPasskeys().length;
  const { K, file } = await newVaultFile(next, payloadOf(items));
  writeFileAtomic(file, { bak: 'same' });
  try { fs.rmSync(v1BackupPath(), { force: true }); } catch {}
  const oldKey = session.key;
  session = { key: K, extra: session.extra };
  try { if (logos) logos.rekey(oldKey); if (MAIL) MAIL.rekey(oldKey); } finally { oldKey.fill(0); }
  return { ok: true, passkeysRemoved: removed };
});

async function verifyPassword(pw) {
  if (!session || typeof pw !== 'string') return false;
  let f; try { f = readFile(); } catch { return false; }
  let key; try { key = await VF.deriveKey(pw, Buffer.from(f.kdf.salt, 'base64'), VF.kdfOf(f)); } catch { return false; }
  try {
    if (session.v1) return crypto.timingSafeEqual(key, session.key);
    const K = VF.unwrapWithPassword(f, key);
    const same = crypto.timingSafeEqual(K, session.key);
    K.fill(0);
    return same;
  } catch { return false; } finally { key.fill(0); }
}

// ---- Passkeys that unlock Vault (WebAuthn PRF) --------------------------------------
// The window runs the WebAuthn ceremony (Windows shows its own dialog: phone by QR code,
// Windows Hello PIN or a USB security key); Vault keeps only the vault key wrapped by the PRF output.
const RP_ID = security.HOST;
let pendingAdd = null; // { salt, name, expires } after the master password was checked
const listPasskeys = () => unlockPasskeys().map(({ id, name, added, transports }) => ({ id, name, added, transports }));
function setUnlockPasskeys(fn) {
  const f = readFile();
  if (f.version !== 2) throw new Error('old format');
  f.keys.passkeys = fn(f.keys.passkeys || []);
  writeFileAtomic(f, { bak: 'same' });
}

handle('passkeys:list', () => (session ? listPasskeys() : null));
handle('passkeys:begin', async (_e, password, name) => {
  if (!session) return { error: 'locked' };
  if (session.v1) return { error: 'old-format' };
  if (!(await verifyPassword(String(password)))) return { error: 'wrong' };
  const label = String(name || '').trim().slice(0, 40) || 'Passkey';
  pendingAdd = { salt: crypto.randomBytes(32), name: label, expires: Date.now() + 5 * 60 * 1000 };
  const host = require('os').hostname();
  return {
    rpId: RP_ID, rpName: 'Vault',
    userId: VF.b64(crypto.randomBytes(16)), userName: 'Vault on ' + host, displayName: 'Vault on ' + host,
    challenge: VF.b64(crypto.randomBytes(32)), salt: VF.b64(pendingAdd.salt),
    exclude: unlockPasskeys().map((p) => ({ id: p.id, transports: p.transports || [] })),
  };
});
handle('passkeys:finish', (_e, id, transports, prfB64) => {
  if (!session || session.v1) return { error: 'locked' };
  if (!pendingAdd || pendingAdd.expires < Date.now()) { pendingAdd = null; return { error: 'expired' }; }
  const prf = typeof prfB64 === 'string' ? Buffer.from(prfB64, 'base64') : null;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{16,1400}$/.test(id) || !prf || prf.length !== 32) return { error: 'bad' };
  const tr = Array.isArray(transports) ? transports.filter((t) => /^(usb|nfc|ble|hybrid|internal|smart-card)$/.test(t)) : [];
  const entry = VF.passkeyEntry({ id, name: pendingAdd.name, transports: tr, salt: pendingAdd.salt, prf, K: session.key });
  prf.fill(0);
  pendingAdd = null;
  setUnlockPasskeys((list) => [...list.filter((p) => p.id !== id), entry]);
  return { ok: true, list: listPasskeys() };
});
handle('passkeys:cancel', () => { pendingAdd = null; return true; });
handle('passkeys:remove', (_e, id) => {
  if (!session || session.v1) return { error: 'locked' };
  setUnlockPasskeys((list) => list.filter((p) => p.id !== String(id)));
  return { ok: true, list: listPasskeys() };
});

// ---- Import / export ---------------------------------------------------------
const smokeIO = { importPath: null, exportDir: null };

handle('file:pick-import', async () => {
  let file = smokeIO.importPath;
  if (!SMOKE) {
    const r = await dialog.showOpenDialog(win, {
      title: 'Import Passwords',
      buttonLabel: 'Import',
      filters: [{ name: 'Password exports', extensions: ['csv', 'json'] }, { name: 'All files', extensions: ['*'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    file = r.filePaths[0];
  }
  const stat = fs.statSync(file);
  if (stat.size > 50 * 1024 * 1024) return { error: 'That file is too large to be a password export.' };
  return { name: path.basename(file), text: fs.readFileSync(file, 'utf8') };
});

// kind: 'csv' | 'json' | 'backup'
handle('file:export', async (_e, kind, contents, password) => {
  if (!(await verifyPassword(password))) return { ok: false, error: 'wrong' };
  const stamp = new Date().toISOString().slice(0, 10);
  const names = { csv: `Vault Passwords ${stamp}.csv`, json: `Vault Passwords ${stamp}.json`, backup: `Vault Backup ${stamp}.vault` };
  const filters = {
    csv: [{ name: 'CSV', extensions: ['csv'] }],
    json: [{ name: 'JSON', extensions: ['json'] }],
    backup: [{ name: 'Vault backup', extensions: ['vault'] }],
  };
  if (!names[kind]) return { ok: false, error: 'bad' };
  let target;
  if (SMOKE) target = path.join(smokeIO.exportDir || app.getPath('userData'), names[kind]);
  else {
    const r = await dialog.showSaveDialog(win, { title: 'Export Passwords', defaultPath: path.join(app.getPath('documents'), names[kind]), filters: filters[kind] });
    if (r.canceled || !r.filePath) return { ok: false, error: 'canceled' };
    target = r.filePath;
  }
  if (kind === 'backup') fs.copyFileSync(vaultPath(), target);
  else fs.writeFileSync(target, kind === 'csv' ? '﻿' + contents : contents, 'utf8');
  return { ok: true, path: target };
});

// Restore an encrypted backup made by this app: it replaces the current vault.
handle('file:restore', async () => {
  let file = smokeIO.importPath;
  if (!SMOKE) {
    const r = await dialog.showOpenDialog(win, { title: 'Restore Backup', buttonLabel: 'Restore', filters: [{ name: 'Vault backup', extensions: ['vault', 'json'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, error: 'canceled' };
    file = r.filePaths[0];
  }
  try {
    const f = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (f.app !== 'vault' || !f.kdf || !f.data || (f.version === 2 && !(f.keys && f.keys.password))) return { ok: false, error: 'That file is not a Vault backup.' };
    if (logos) logos.reset();
    if (MAIL) MAIL.reset();
    writeFileAtomic(f);
    lockVault({ notify: false });
    return { ok: true };
  } catch { return { ok: false, error: 'That file is not a Vault backup.' }; }
});

handle('vault:lock', () => { lockVault({ notify: false }); return true; });
handle('app:purge', () => { if (!session && mainDirty) { mainDirty = false; clearTimeout(purgeTimer); setImmediate(() => purge(win)); } return true; });
handle('app:activity', () => { activity(); return true; });
// The window started over while Vault was (again) unlocked: show the open vault.
handle('vault:resume', () => (session ? { ok: true, items: sessionItems() || [] } : { ok: false }));
// A short message for the window to show after it starts over (e.g. "Backup restored").
let note = null;
handle('app:note', (_e, text) => { note = String(text).slice(0, 120); return true; });
handle('app:take-note', () => { const n = note; note = null; return n; });
handle('clip:copy', async (_e, text, isSecret) => { await copy(text, !!isSecret); return true; });
handle('open:url', (_e, url) => openUrl(url));
handle('pw:change-page', (_e, id) => openChangePage(id));
handle('breach:check', () => checkBreaches());
handle('vault:ui', () => (session ? Object.fromEntries(UI_KEYS.map((k) => [k, (session.extra.ui || {})[k] || null])) : null));
handle('vault:ui-save', (_e, key, value) => {
  if (!session || !UI_KEYS.includes(key)) return { ok: false };
  let v = null;
  try { v = value == null ? null : JSON.parse(JSON.stringify(value)); } catch { return { ok: false }; }
  if (v && JSON.stringify(v).length > 200000) return { ok: false };
  return { ok: saveExtra({ ui: { ...(session.extra.ui || {}), [key]: v } }) };
});

// The ••• and right-click menus are drawn by the window itself (Liquid Glass); these do what they can't.
const appPrefs = () => ({ openAtLogin: canOpenAtLogin() ? app.getLoginItemSettings().openAtLogin : null, logos: prefs().logos !== false, gen: prefs().gen || null, breachCheck: breachOn() });
handle('app:prefs', () => appPrefs());
handle('app:set-pref', (_e, key, value) => {
  if (key === 'openAtLogin') setOpenAtLogin(!!value);
  if (key === 'logos') logos.setEnabled(!!value);
  if (key === 'gen') setPref('gen', cleanGen(value));
  if (key === 'breachCheck') setPref('breachCheck', value === true);
  return appPrefs();
});
// Password generator settings (not secret).
function cleanGen(v) {
  const o = v && typeof v === 'object' ? v : {};
  const int = (x, lo, hi, d) => (Number.isInteger(x) && x >= lo && x <= hi ? x : d);
  return { style: ['apple', 'random', 'words'].includes(o.style) ? o.style : 'apple', length: int(o.length, 8, 64, 20), words: int(o.words, 3, 10, 5), symbols: !!o.symbols };
}
handle('app:quick', () => { showQuick(); return true; });
handle('app:show-file', () => { if (!SMOKE) shell.showItemInFolder(vaultPath()); return true; });

// Windows locked (Win+L), going to sleep or hibernating: lock straight away.
for (const ev of ['lock-screen', 'suspend', 'shutdown']) powerMonitor.on(ev, () => { if (session) lockVault(); });

// ---------- Quick search (Ctrl+Shift+Space from anywhere) ----------------------
// A small panel that finds an account and copies its password. It never receives
// passwords or 2FA secrets: it asks this process to copy them straight to the clipboard.
let quick = null;

function createQuick() {
  quick = new BrowserWindow({
    width: 640, height: 452, show: false, frame: false, resizable: false, maximizable: false, minimizable: false,
    fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, title: 'Vault Quick Search',
    backgroundColor: '#00000000', backgroundMaterial: 'acrylic',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: security.webPrefs({ preload: path.join(__dirname, 'preload-quick.js'), session: security.appSession(), devTools: DEV }),
  });
  quick.loadURL(security.pageUrl('quick.html'));
  quick.on('blur', () => { if (!SMOKE) hideQuick(); });
  quick.on('close', (e) => { if (!quitting) { e.preventDefault(); hideQuick(); } });
}

// The panel fades in and out (window opacity) while its content springs in.
let quickFade = null;
const reducedMotion = () => { try { return systemPreferences.getAnimationSettings().prefersReducedMotion; } catch { return false; } };
function fadeQuick(from, to, done) {
  clearInterval(quickFade);
  const steps = reducedMotion() ? 2 : 5; let i = 0;
  quick.setOpacity(from);
  quickFade = setInterval(() => {
    i++;
    if (!quick || quick.isDestroyed()) return clearInterval(quickFade);
    const e = 1 - (1 - i / steps) ** 3;
    quick.setOpacity(from + (to - from) * e);
    if (i >= steps) { clearInterval(quickFade); quickFade = null; if (done) done(); }
  }, 16);
}
function showQuick() {
  if (!quick || quick.isDestroyed()) createQuick();
  if (quick.isVisible() && !quickHiding) return hideQuick();
  quickHiding = false;
  const workArea = placeArea();
  const [w, h] = quick.getSize();
  quick.setPosition(Math.round(workArea.x + (workArea.width - w) / 2), Math.round(workArea.y + workArea.height * 0.22));
  const go = () => { quick.webContents.send('quick:show'); if (SMOKE) quick.showInactive(); else { quick.setOpacity(0); quick.show(); quick.focus(); fadeQuick(0, 1); } };
  if (quick.webContents.isLoading()) quick.webContents.once('did-finish-load', go); else go();
}
let quickHiding = false;
function hideQuick() {
  if (!quick || quick.isDestroyed() || !quick.isVisible() || quickHiding) return;
  if (SMOKE) { quick.hide(); return; }
  quickHiding = true;
  quick.webContents.send('quick:hiding');
  fadeQuick(1, 0, () => { if (quickHiding) { quick.hide(); quick.setOpacity(1); } quickHiding = false; });
}

const fromQuick = (e) => quick && !quick.isDestroyed() && e.sender === quick.webContents;
const quickItem = (id) => (sessionItems() || []).find((x) => x.id === id && !x.deletedAt);

handleQuick('quick:list', (e) => {
  if (!fromQuick(e)) return null;
  const items = sessionItems();
  if (!items) return { locked: true, exists: fs.existsSync(vaultPath()) };
  quickDirty = true; activity();
  send('activity');
  return {
    locked: false,
    items: items.filter((x) => !x.deletedAt).map((x) => ({
      id: x.id, title: x.title, username: x.username, website: x.website, favorite: !!x.favorite,
      hasPassword: !!x.password, hasCode: !!otp.otpField(x), logo: logos ? logos.peek(x) : null,
    })),
  };
});
handleQuick('quick:unlock', async (e, password) => {
  if (!fromQuick(e)) return { ok: false };
  if (session) return { ok: true };
  const r = await unlock(password);
  if (r.ok) send('unlocked-elsewhere', r.items);
  return { ok: r.ok, error: r.error };
});
handleQuick('quick:copy', async (e, id, what) => {
  if (!fromQuick(e)) return { ok: false };
  const it = quickItem(id);
  if (!it) return { ok: false };
  activity();
  send('activity');
  if (what === 'username' && it.username) { await copy(it.username, false); return { ok: true }; }
  if (what === 'password' && it.password) { await copy(it.password, true); return { ok: true }; }
  if (what === 'code') {
    const f = otp.otpField(it);
    const cfg = f && otp.parse(f.value);
    if (cfg) { await copy(await otp.code(cfg, nodeHmac), true); return { ok: true }; }
  }
  return { ok: false };
});
// The current code for one account (shown on the selected row), not the secret behind it.
handleQuick('quick:code', async (e, id) => {
  if (!fromQuick(e)) return null;
  const it = quickItem(id);
  const f = it && otp.otpField(it);
  const cfg = f && otp.parse(f.value);
  if (!cfg) return null;
  return { code: otp.pretty(await otp.code(cfg, nodeHmac)), left: otp.remaining(cfg), period: cfg.period };
});
handleQuick('quick:open', (e, url) => fromQuick(e) && openUrl(url));
handleQuick('quick:hide', (e) => { if (fromQuick(e)) hideQuick(); });
handleQuick('quick:main', (e) => { if (fromQuick(e)) { hideQuick(); showMain(); } });

// ---------- Notification area: Vault keeps running so the hotkey works ---------
let tray = null;
let quitting = false;
app.on('before-quit', () => { quitting = true; });
// A copied password must not outlive Vault on the clipboard: clear it (if still ours) before quitting.
let clipCleared = false;
app.on('will-quit', (e) => {
  if (clipCleared || !clipHash) return;
  e.preventDefault();
  clipCleared = true;
  clearClipboard().catch(() => {}).finally(() => app.quit());
});

function showMain() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// Small preferences file (not secret): e.g. whether the tray hint was shown.
const prefsPath = () => path.join(app.getPath('userData'), 'settings.json');
function prefs() { try { return JSON.parse(fs.readFileSync(prefsPath(), 'utf8')); } catch { return {}; } }
function setPref(k, v) { try { fs.writeFileSync(prefsPath(), JSON.stringify({ ...prefs(), [k]: v })); } catch {} }

function setupTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('Vault');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Vault', click: showMain },
    { label: 'Quick Search', accelerator: HOTKEY, registerAccelerator: false, click: showQuick },
    { type: 'separator' },
    { label: 'Lock Vault', click: () => lockVault() },
    { label: 'Quit Vault', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showMain);
}

// Start with Windows (installed app only; a portable copy may be on a USB stick that isn't there).
const canOpenAtLogin = () => app.isPackaged && !PORTABLE_DIR;
function setOpenAtLogin(on) {
  if (canOpenAtLogin()) app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] });
}

// ---------- Passkeys for websites (through the browser extension) ---------------
// The extension hands Vault a site's WebAuthn request. Vault checks the origin and rpId, shows its own
// confirmation (which site, which account; unlock first if locked), and signs here: the private key
// never leaves this process. "Use Another Device" sends the page back to the browser's own flow.
const PK = require('./passkeys');
const NOT_ALLOWED = { error: 'NotAllowedError', message: 'The operation either timed out or was not allowed.' };
const sitePasskeys = () => (session && session.extra && Array.isArray(session.extra.passkeys) ? session.extra.passkeys : []);
// Saves the passkey list with the accounts as they are on disk. If the file can't be read right now,
// nothing is written (never an empty account list) and the caller gets false.
function saveSitePasskeys(list) {
  const items = sessionItems();
  if (!session || !items) return false;
  const before = session.extra;
  session.extra = { ...(session.extra || {}), passkeys: list };
  try { persist(items); } catch { session.extra = before; return false; }
  send('site-passkeys');
  return true;
}

handle('passkeys:site-list', () => (session ? sitePasskeys().map(({ id, rpId, userName, displayName, created, lastUsed }) => ({ id, rpId, userName, displayName, created, lastUsed })) : null));
handle('passkeys:site-delete', (_e, id) => {
  if (!session) return { ok: false };
  const list = sitePasskeys();
  if (!list.some((p) => p.id === id)) return { ok: false };
  return { ok: saveSitePasskeys(list.filter((p) => p.id !== id)) };
});

const pkQueue = [];
let pkCurrent = null;
let prompt = null;
let promptDirty = false; // the prompt has shown account names since its last purge

function passkeyRequest({ op, origin, options, requestId, browser }) {
  return new Promise((resolve) => {
    const parsed = op === 'create' ? PK.parseCreate(options) : op === 'get' ? PK.parseGet(options) : { error: 'TypeError' };
    if (parsed.error) return resolve({ fallback: true });
    const rp = PK.checkRp(String(origin || ''), parsed.rpId);
    if (!rp.ok) return resolve({ error: 'SecurityError', message: 'This site may not use a passkey for that domain.' });
    if (op === 'create' && !parsed.es256) return resolve({ fallback: true }); // the site doesn't accept Vault's key type
    const req = { op, origin, host: rp.host, rpId: rp.rpId, parsed, requestId, browser: String(browser || 'Browser').slice(0, 40), resolve, at: Date.now() };
    // Signing in, unlocked, nothing saved for this site: let the browser handle it without asking.
    if (op === 'get' && session && !matchesFor(req).length) return resolve({ fallback: true });
    req.timer = setTimeout(() => finish(req, NOT_ALLOWED), 5 * 60 * 1000);
    pkQueue.push(req);
    nextPasskeyRequest();
  });
}

function matchesFor(req) {
  const allow = req.parsed.allow || [];
  return sitePasskeys().filter((p) => p.rpId === req.rpId && (!allow.length || allow.includes(p.credentialId)));
}

function promptState() {
  const r = pkCurrent;
  if (!r) return null;
  const st = { op: r.op, site: r.host, rpId: r.rpId, browser: r.browser, locked: !session };
  if (!session) st.passkeys = unlockPasskeys().map((p) => ({ id: p.id, salt: p.salt, transports: p.transports || [] }));
  else if (r.op === 'create') {
    st.rpName = r.parsed.rpName;
    st.account = r.parsed.user.name || r.parsed.user.displayName;
    st.displayName = r.parsed.user.displayName;
    st.exists = sitePasskeys().some((p) => p.rpId === r.rpId && (r.parsed.exclude.includes(p.credentialId) || p.userHandle === r.parsed.user.id));
  } else {
    st.accounts = matchesFor(r).map((p) => ({ id: p.id, userName: p.userName, displayName: p.displayName, lastUsed: p.lastUsed, created: p.created }));
  }
  return st;
}

function nextPasskeyRequest() {
  if (pkCurrent || !pkQueue.length) return;
  pkCurrent = pkQueue.shift();
  showPrompt();
}

function finish(req, result) {
  clearTimeout(req.timer);
  const i = pkQueue.indexOf(req);
  if (i >= 0) pkQueue.splice(i, 1);
  req.resolve(result);
  if (pkCurrent === req) {
    pkCurrent = null;
    hidePrompt();
    setTimeout(nextPasskeyRequest, 200);
  }
}

// The page gave up (its AbortSignal fired, or the tab went away).
function passkeyCancel(requestId) {
  const req = (pkCurrent && pkCurrent.requestId === requestId) ? pkCurrent : pkQueue.find((r) => r.requestId === requestId);
  if (req) finish(req, { error: 'AbortError', message: 'The operation was aborted.' });
}

function answerPasskey(action, accountId) {
  const req = pkCurrent;
  if (!req) return { ok: false };
  if (action === 'other') { finish(req, { fallback: true }); return { ok: true }; }
  if (action === 'cancel') { finish(req, NOT_ALLOWED); return { ok: true }; }
  if (action !== 'confirm' || !session) return { ok: false };
  activity();
  if (req.op === 'create') {
    const st = promptState();
    if (st.exists) {
      finish(req, { error: 'InvalidStateError', message: 'A passkey for this account is already saved in Vault.' });
      return { ok: true };
    }
    const { entry, response } = PK.makeCredential({ rpId: req.rpId, origin: req.origin, user: req.parsed.user, challenge: req.parsed.challenge, credProps: req.parsed.credProps });
    if (!saveSitePasskeys([...sitePasskeys(), entry])) { logUpdate('[passkeys] could not save'); finish(req, NOT_ALLOWED); return { ok: true }; }
    finish(req, { credential: response });
    return { ok: true };
  }
  const entry = matchesFor(req).find((p) => p.id === accountId);
  if (!entry) return { ok: false };
  const { counter, response } = PK.getAssertion(entry, { origin: req.origin, challenge: req.parsed.challenge });
  // The new counter is stored before the site gets the signature.
  if (!saveSitePasskeys(sitePasskeys().map((p) => (p.id === entry.id ? { ...p, signCount: counter, lastUsed: Date.now() } : p)))) { logUpdate('[passkeys] could not save'); finish(req, NOT_ALLOWED); return { ok: true }; }
  finish(req, { credential: response });
  return { ok: true };
}

// ---- the confirmation window ----
function createPrompt() {
  prompt = new BrowserWindow({
    width: 440, height: 360, show: false, frame: false, resizable: false, maximizable: false, minimizable: false,
    fullscreenable: false, skipTaskbar: false, alwaysOnTop: true, title: 'Vault Passkey',
    backgroundColor: '#00000000', backgroundMaterial: 'acrylic',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: security.webPrefs({ preload: path.join(__dirname, 'preload-prompt.js'), session: security.appSession(), devTools: DEV }),
  });
  prompt.loadURL(security.pageUrl('prompt.html'));
  prompt.on('close', (e) => { if (!quitting) { e.preventDefault(); if (pkCurrent) finish(pkCurrent, NOT_ALLOWED); else hidePrompt(); } });
}
function showPrompt() {
  if (!prompt || prompt.isDestroyed()) createPrompt();
  promptDirty = true;
  const workArea = placeArea();
  const [w, h] = prompt.getSize();
  prompt.setPosition(Math.round(workArea.x + (workArea.width - w) / 2), Math.round(workArea.y + workArea.height * 0.2));
  const go = () => {
    prompt.webContents.send('prompt:update', promptState());
    if (SMOKE) prompt.showInactive(); else { prompt.show(); prompt.focus(); }
  };
  if (prompt.webContents.isLoading()) prompt.webContents.once('did-finish-load', go); else go();
}
function hidePrompt() { if (prompt && !prompt.isDestroyed() && prompt.isVisible()) prompt.hide(); }
const updatePrompt = () => { if (prompt && !prompt.isDestroyed() && pkCurrent) prompt.webContents.send('prompt:update', promptState()); };

const handlePrompt = (channel, fn) => guard.handle('prompt.html', channel, fn);
handlePrompt('prompt:state', () => promptState());
handlePrompt('prompt:answer', (_e, action, accountId) => answerPasskey(String(action), String(accountId || '')));
handlePrompt('prompt:unlock', async (_e, password) => {
  if (!session) {
    const r = await unlock(password);
    if (!r.ok) return { ok: false, error: r.error };
    send('unlocked-elsewhere', r.items);
  }
  return afterPromptUnlock();
});
handlePrompt('prompt:unlock-passkey', async (_e, id, prf) => {
  if (!session) {
    const r = await unlockWithPasskey(id, prf);
    if (!r.ok) return { ok: false, error: r.error };
    send('unlocked-elsewhere', r.items);
  }
  return afterPromptUnlock();
});
// Unlocked from the prompt: if Vault has nothing for this site, go straight to the browser's own flow.
function afterPromptUnlock() {
  const req = pkCurrent;
  if (req && req.op === 'get' && !matchesFor(req).length) return { ok: true, state: { ...promptState(), none: true } };
  return { ok: true, state: promptState() };
}

// ---- registering the native messaging host with the browsers ----
async function registerNativeHost() {
  try {
    const nh = require('./nativehost');
    const dir = path.join(app.getPath('userData'), 'NativeMessagingHosts');
    fs.mkdirSync(dir, { recursive: true });
    // A copy next to Vault's data, so the portable edition (unpacked to a temp folder) works too.
    const src = app.isPackaged ? path.join(process.resourcesPath, 'vault-native-host.exe') : require('./scripts/build-host')();
    const exe = path.join(dir, 'vault-native-host.exe');
    const bytes = fs.readFileSync(src);
    if (!fs.existsSync(exe) || !fs.readFileSync(exe).equals(bytes)) fs.writeFileSync(exe, bytes);
    const extId = nh.extensionId(path.join(__dirname, 'browser-extension', 'manifest.json'));
    if (!(await nh.register({ dir, exe, extId }))) logUpdate('[browser] could not register the native host');
  } catch (err) { logUpdate('[browser] native host setup failed: ' + (err && err.name)); }
}

// ---------- Browser extension bridge -------------------------------------------
let bridge = null;
function setupBridge() {
  bridge = require('./bridge')({
    app, safeStorage, prefs, setPref, sessionItems, copy, otp, nodeHmac,
    links: require('./src/links.js'),
    isUnlocked: () => !!session,
    exists: () => fs.existsSync(vaultPath()),
    unlock: async (pw) => { const r = await unlock(pw); if (r.ok) send('unlocked-elsewhere', r.items); return r; },
    onActivity: () => { activity(); send('activity'); },
    onChange: () => send('bridge', bridgeState()),
    passkeyRequest, passkeyCancel,
    pipeName: SMOKE ? 'vault-browser-smoke-' + process.pid : undefined,
    log: (m) => logUpdate('[browser] ' + m), // fixed messages only, never request contents
  });
  bridge.start();
}
const bridgeState = () => (bridge ? { ...bridge.state(), clients: bridge.clients() } : { clients: [] });

// The extension's files, copied to a fixed folder the browser can load (and refreshed on updates).
function extensionFolder() {
  const target = path.join(app.getPath('userData'), 'Browser Extension');
  const src = path.join(__dirname, 'browser-extension');
  fs.mkdirSync(target, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    if (fs.statSync(from).isDirectory()) {
      fs.mkdirSync(path.join(target, name), { recursive: true });
      for (const sub of fs.readdirSync(from)) fs.writeFileSync(path.join(target, name, sub), fs.readFileSync(path.join(from, sub)));
    } else fs.writeFileSync(path.join(target, name), fs.readFileSync(from));
  }
  return target;
}

handle('bridge:state', () => bridgeState());
handle('bridge:pair', () => (bridge ? bridge.startPairing() : null));
handle('bridge:cancel', () => { if (bridge) bridge.cancelPairing(); return true; });
handle('bridge:remove', (_e, id) => { if (bridge) bridge.remove(String(id)); return bridgeState(); });
handle('bridge:folder', () => { try { const dir = extensionFolder(); if (!SMOKE) shell.openPath(dir); return dir; } catch (err) { return null; } });

// ---------- Crash reports ------------------------------------------------------
// Vault never starts Electron's crash reporter, so it writes no crash dumps. Windows Error Reporting
// could still save one (with memory in it) if Vault crashed: tell Windows to leave Vault.exe out.
function keepOutOfCrashReports() {
  if (!app.isPackaged || prefs().werExcluded === process.execPath) return;
  const exe = path.basename(process.execPath);
  require('child_process').execFile('reg.exe', ['add', String.raw`HKCU\Software\Microsoft\Windows\Windows Error Reporting\ExcludedApplications`, '/v', exe, '/t', 'REG_DWORD', '/d', '1', '/f'],
    { windowsHide: true }, (err) => { if (!err) setPref('werExcluded', process.execPath); });
}

// ---------- Boot -------------------------------------------------------------
app.setAppUserModelId('local.vault.app');

if (!SMOKE && !MAKE_ICON && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMain());
  app.whenReady().then(async () => {
    if (MAKE_ICON) return require('./scripts/make-icon')(app, BrowserWindow);
    buildMenu();
    keepOutOfCrashReports();
    logos = require('./logos')({
      app, BrowserWindow, handle, getKey: () => (session ? session.key : null), prefs, setPref, send,
      log: (m) => logUpdate('[logos] ' + m), smoke: SMOKE, links: require('./src/links.js'),
    });
    setupMail();
    createWindow();
    setupUpdates();
    setupBridge();
    if (!SMOKE) {
      registerNativeHost();
      // The extension folder you loaded in the browser gets this version's extension (used after the browser restarts).
      if (fs.existsSync(path.join(app.getPath('userData'), 'Browser Extension'))) try { extensionFolder(); } catch {}
    }
    if (!SMOKE) {
      setupTray();
      createQuick();
      if (!globalShortcut.register(HOTKEY, showQuick)) console.warn('Quick-search hotkey is taken by another app');
    }
    if (SHOTS) require('./scripts/screenshots')({ testWorkArea, app, win, nativeTheme, showQuick, getQuick: () => quick });
    else if (SMOKE_CHILD) require('./scripts/smoke-child')({ win, PW, opened });
    else if (SMOKE && process.env.VAULT_REAL_LOGOS) require('./scripts/real-logos')({ testWorkArea, win, nativeTheme, getLogos: () => logos });
    else if (SMOKE) require('./scripts/smoke')({ app, win, nativeTheme, vaultPath, opened, clipboard, smokeIO, showQuick, getQuick: () => quick, getBridge: () => bridge, getLogos: () => logos,
      test: { testWorkArea, PW, getMail: () => MAIL, mailFrames, getExtra: () => session && session.extra, guard, idle, getSession: () => session, lockVault, clearClipboard, copy, logUpdate, getQuickWin: () => quick, getPrompt: () => prompt, sitePasskeys } });
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => { lock(); app.quit(); });
}
