'use strict';
// Vault — main process.
// Holds the encryption key, reads/writes the encrypted vault file and is the
// only place that touches the clipboard or opens links in the default browser.

const { app, BrowserWindow, ipcMain, Menu, clipboard, shell, nativeTheme, powerMonitor, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Test/dev switches only exist when running from source, never in the built app.
const DEV = !app.isPackaged;
const SMOKE = DEV && process.argv.includes('--smoke');
const MAKE_ICON = DEV && process.argv.includes('--make-icon');

// Portable edition (Vault-Portable.exe): keep the data in a "Vault Data" folder
// right next to the .exe, so the app and its vault travel together on a USB stick.
const PORTABLE_DIR = process.env.PORTABLE_EXECUTABLE_DIR || (DEV && process.env.VAULT_PORTABLE_TEST) || null;

if (SMOKE) {
  // Never touch the real vault while testing.
  app.setPath('userData', path.join(app.getPath('temp'), 'vault-smoke-' + Date.now()));
} else if (PORTABLE_DIR) {
  const dataDir = path.join(PORTABLE_DIR, 'Vault Data');
  fs.mkdirSync(dataDir, { recursive: true });
  app.setPath('userData', dataDir);
}

// ---------- Crypto -----------------------------------------------------------
// Master password -> scrypt -> 256-bit key -> AES-256-GCM over the whole vault.
const KDF = { N: 2 ** 17, r: 8, p: 1, keyLen: 32, maxmem: 256 * 1024 * 1024 };

function deriveKey(password, salt, params = KDF) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password.normalize('NFKC'), salt, params.keyLen || 32,
      { N: params.N, r: params.r, p: params.p, maxmem: KDF.maxmem },
      (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function encrypt(key, obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function decrypt(key, box) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  const out = Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]);
  return JSON.parse(out.toString('utf8'));
}

// ---------- Vault file -------------------------------------------------------
const vaultPath = () => path.join(app.getPath('userData'), 'vault.json');

let session = null; // { key: Buffer, salt: Buffer, kdf }
let failedAttempts = 0;

function readFile() {
  return JSON.parse(fs.readFileSync(vaultPath(), 'utf8'));
}

function writeFileAtomic(contents) {
  const file = vaultPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(contents), { mode: 0o600 });
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak'); // previous version as a safety net
  fs.renameSync(tmp, file);
}

function persist(items) {
  if (!session) throw new Error('locked');
  const box = encrypt(session.key, { items });
  writeFileAtomic({
    app: 'vault', version: 1,
    kdf: { name: 'scrypt', N: session.kdf.N, r: session.kdf.r, p: session.kdf.p, salt: session.salt.toString('base64') },
    cipher: 'aes-256-gcm', ...box,
  });
}

function lock() {
  if (session) session.key.fill(0);
  session = null;
}

// ---------- Clipboard: copied secrets clear themselves -----------------------
let clipTimer = null;
function copy(text, isSecret) {
  clipboard.writeText(String(text));
  clearTimeout(clipTimer);
  if (isSecret) {
    clipTimer = setTimeout(() => {
      if (clipboard.readText() === String(text)) clipboard.clear();
    }, 30_000);
  }
}

// ---------- Links: only real web addresses go to the browser ----------------
const opened = []; // smoke-test log
function openUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (SMOKE) { opened.push(u.href); return true; }
  shell.openExternal(u.href);
  return true;
}

// ---------- Window -----------------------------------------------------------
let win = null;

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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: DEV,
    },
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  if (!SMOKE) win.once('ready-to-show', () => win.show());

  // Nothing inside the app may navigate away or spawn windows.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => { openUrl(url); return { action: 'deny' }; });
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
        { label: 'Change Master Password…', click: () => send('menu', 'change-password') },
        { label: 'Show Vault File', click: () => shell.showItemInFolder(vaultPath()) },
        { type: 'separator' },
        { label: 'Lock Vault', accelerator: 'CmdOrCtrl+L', click: () => { lock(); send('locked'); } },
        { role: 'quit' },
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
const PUBLISH = (require('./package.json').build || {}).publish || null;
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
    console.error('update check failed', err && err.message);
  }
  return { ...update };
}

function setupUpdates() {
  if (DEV || !PUBLISH) return;
  if (!PORTABLE_DIR) {
    autoUpdater = require('electron-updater').autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;
    autoUpdater.on('update-available', (i) => setUpdate({ status: 'downloading', version: i.version }));
    autoUpdater.on('update-downloaded', (i) => setUpdate({ status: 'ready', version: i.version }));
    autoUpdater.on('error', () => { if (update.status !== 'ready') setUpdate({ status: 'error' }); });
  }
  setTimeout(checkForUpdates, 6000);
  setInterval(checkForUpdates, 6 * 60 * 60 * 1000);
}

ipcMain.handle('update:check', () => checkForUpdates());
ipcMain.handle('update:state', () => ({ ...update }));
ipcMain.handle('update:install', () => {
  if (update.status === 'ready' && autoUpdater) { lock(); autoUpdater.quitAndInstall(true, true); return true; }
  if (update.status === 'available' && update.url) { openUrl(update.url); return true; }
  return false;
});

// ---------- IPC --------------------------------------------------------------
ipcMain.handle('vault:status', () => ({ exists: fs.existsSync(vaultPath()), unlocked: !!session }));

ipcMain.handle('vault:create', async (_e, password) => {
  if (fs.existsSync(vaultPath())) return { ok: false, error: 'exists' };
  if (typeof password !== 'string' || password.length < 8) return { ok: false, error: 'short' };
  const salt = crypto.randomBytes(16);
  session = { key: await deriveKey(password, salt), salt, kdf: { N: KDF.N, r: KDF.r, p: KDF.p } };
  persist([]);
  return { ok: true, items: [] };
});

ipcMain.handle('vault:unlock', async (_e, password) => {
  if (typeof password !== 'string') return { ok: false, error: 'wrong' };
  // Gentle back-off after repeated wrong guesses.
  if (failedAttempts > 3) await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** (failedAttempts - 4))));
  let file;
  try { file = readFile(); } catch { return { ok: false, error: 'missing' }; }
  const salt = Buffer.from(file.kdf.salt, 'base64');
  const kdf = { N: file.kdf.N, r: file.kdf.r, p: file.kdf.p };
  const key = await deriveKey(password, salt, kdf);
  try {
    const { items } = decrypt(key, file);
    session = { key, salt, kdf };
    failedAttempts = 0;
    return { ok: true, items };
  } catch {
    key.fill(0);
    failedAttempts++;
    return { ok: false, error: 'wrong' };
  }
});

ipcMain.handle('vault:save', (_e, items) => {
  if (!session) return { ok: false, error: 'locked' };
  if (!Array.isArray(items)) return { ok: false, error: 'bad' };
  try { persist(items); return { ok: true }; } catch (err) { return { ok: false, error: String(err.message || err) }; }
});

ipcMain.handle('vault:change-password', async (_e, current, next, items) => {
  if (!session) return { ok: false, error: 'locked' };
  if (typeof next !== 'string' || next.length < 8) return { ok: false, error: 'short' };
  if (!(await verifyPassword(String(current)))) return { ok: false, error: 'wrong' };
  const salt = crypto.randomBytes(16);
  const key = await deriveKey(next, salt);
  session.key.fill(0);
  session = { key, salt, kdf: { N: KDF.N, r: KDF.r, p: KDF.p } };
  persist(items);
  return { ok: true };
});

async function verifyPassword(pw) {
  if (!session || typeof pw !== 'string') return false;
  const check = await deriveKey(pw, session.salt, session.kdf);
  const same = crypto.timingSafeEqual(check, session.key);
  check.fill(0);
  return same;
}

// ---- Import / export ---------------------------------------------------------
const smokeIO = { importPath: null, exportDir: null };

ipcMain.handle('file:pick-import', async () => {
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
ipcMain.handle('file:export', async (_e, kind, contents, password) => {
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
ipcMain.handle('file:restore', async () => {
  let file = smokeIO.importPath;
  if (!SMOKE) {
    const r = await dialog.showOpenDialog(win, { title: 'Restore Backup', buttonLabel: 'Restore', filters: [{ name: 'Vault backup', extensions: ['vault', 'json'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, error: 'canceled' };
    file = r.filePaths[0];
  }
  try {
    const f = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (f.app !== 'vault' || !f.kdf || !f.data) return { ok: false, error: 'That file is not a Vault backup.' };
    writeFileAtomic(f);
    lock();
    return { ok: true };
  } catch { return { ok: false, error: 'That file is not a Vault backup.' }; }
});

ipcMain.handle('menu:more', () => new Promise((resolve) => {
  let picked = null;
  const pick = (v) => () => (picked = v);
  Menu.buildFromTemplate([
    { label: 'Import Passwords…', click: pick('import') },
    { label: 'Export Passwords…', click: pick('export') },
    { type: 'separator' },
    { label: 'Back Up Vault…', click: pick('backup') },
    { label: 'Restore From Backup…', click: pick('restore') },
    { type: 'separator' },
    { label: 'Change Master Password…', click: pick('change-password') },
    { label: 'Check for Updates…', click: pick('check-updates') },
    { label: 'Show Vault File', click: () => shell.showItemInFolder(vaultPath()) },
  ]).popup({ window: win, callback: () => resolve(picked) });
}));

ipcMain.handle('vault:lock', () => { lock(); return true; });
ipcMain.handle('clip:copy', (_e, text, isSecret) => { copy(text, !!isSecret); return true; });
ipcMain.handle('open:url', (_e, url) => openUrl(url));

// Native right-click menu for a list row.
ipcMain.handle('menu:row', (_e, opts) => new Promise((resolve) => {
  let picked = null;
  const t = [
    { label: 'Copy User Name', enabled: !!opts.hasUser, click: () => (picked = 'copy-user') },
    { label: 'Copy Password', enabled: !!opts.hasPassword, click: () => (picked = 'copy-password') },
    { label: 'Open Login Page', enabled: !!opts.hasLink, click: () => (picked = 'open') },
    { type: 'separator' },
    { label: 'Edit', click: () => (picked = 'edit') },
    { label: 'Delete…', click: () => (picked = 'delete') },
  ];
  Menu.buildFromTemplate(t).popup({ window: win, callback: () => resolve(picked) });
}));

powerMonitor.on('lock-screen', () => { if (session) { lock(); send('locked'); } });
powerMonitor.on('suspend', () => { if (session) { lock(); send('locked'); } });

// ---------- Boot -------------------------------------------------------------
app.setAppUserModelId('local.vault.app');

if (!SMOKE && !MAKE_ICON && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(async () => {
    if (MAKE_ICON) return require('./scripts/make-icon')(app, BrowserWindow);
    buildMenu();
    createWindow();
    setupUpdates();
    if (SMOKE) require('./scripts/smoke')({ app, win, nativeTheme, vaultPath, opened, clipboard, smokeIO });
  });
  app.on('window-all-closed', () => { lock(); app.quit(); });
}
