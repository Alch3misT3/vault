'use strict';
// Vault — main process.
// Holds the encryption key, reads/writes the encrypted vault file and is the
// only place that touches the clipboard or opens links in the default browser.

const { app, BrowserWindow, ipcMain, Menu, clipboard, shell, nativeTheme, powerMonitor, dialog, globalShortcut, Tray, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { otp } = require('./src/otp.js');

// Test/dev switches only exist when running from source, never in the built app.
const DEV = !app.isPackaged;
const SHOTS = DEV && process.argv.includes('--screenshots'); // README screenshots, same sandbox as the smoke test
const SMOKE = DEV && (process.argv.includes('--smoke') || SHOTS);
const MAKE_ICON = DEV && process.argv.includes('--make-icon');
const START_HIDDEN = process.argv.includes('--hidden'); // started with Windows: stay in the notification area
const HOTKEY = 'CommandOrControl+Shift+Space';

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
// (Electron 45's clipboard calls return Promises.)
const CLIP_CLEAR_MS = SMOKE ? 1500 : 30_000;
async function copy(text, isSecret) {
  await clipboard.writeText(String(text));
  clearTimeout(clipTimer);
  if (isSecret) {
    clipTimer = setTimeout(async () => {
      // Only clear if it's still ours; the user may have copied something else since.
      if ((await clipboard.readText()) === String(text)) clipboard.clear();
    }, CLIP_CLEAR_MS);
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
        { label: 'Password Generator…', accelerator: 'CmdOrCtrl+G', click: () => send('menu', 'generator') },
        { label: 'Change Master Password…', click: () => send('menu', 'change-password') },
        { label: 'Show Vault File', click: () => shell.showItemInFolder(vaultPath()) },
        { type: 'separator' },
        { label: 'Lock Vault', accelerator: 'CmdOrCtrl+L', click: () => { lock(); send('locked'); } },
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

ipcMain.handle('update:check', () => checkForUpdates());
ipcMain.handle('update:state', () => ({ ...update }));
ipcMain.handle('update:install', () => {
  if (update.status === 'ready' && autoUpdater) { lock(); quitting = true; autoUpdater.quitAndInstall(true, true); return true; }
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

ipcMain.handle('vault:unlock', (_e, password) => unlock(password));

async function unlock(password) {
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
}

// The decrypted vault as last saved by the window (the quick-search panel reads it from here).
function sessionItems() {
  if (!session) return null;
  try { return decrypt(session.key, readFile()).items || []; } catch { return null; }
}
const nodeHmac = (alg, key, msg) => new Uint8Array(crypto.createHmac(alg.toLowerCase(), Buffer.from(key)).update(Buffer.from(msg)).digest());

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
    { label: 'Password Generator…', click: pick('generator') },
    { label: 'Change Master Password…', click: pick('change-password') },
    { type: 'separator' },
    { label: 'Quick Search', accelerator: HOTKEY, registerAccelerator: false, click: () => showQuick() },
    ...(canOpenAtLogin() ? [{ label: 'Open Vault When Windows Starts', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (m) => setOpenAtLogin(m.checked) }] : []),
    { label: 'Check for Updates…', click: pick('check-updates') },
    { label: 'Show Vault File', click: () => shell.showItemInFolder(vaultPath()) },
  ]).popup({ window: win, callback: () => resolve(picked) });
}));

ipcMain.handle('vault:lock', () => { lock(); return true; });
ipcMain.handle('clip:copy', async (_e, text, isSecret) => { await copy(text, !!isSecret); return true; });
ipcMain.handle('open:url', (_e, url) => openUrl(url));

// Native right-click menu for a list row.
ipcMain.handle('menu:row', (_e, opts) => new Promise((resolve) => {
  let picked = null;
  const p = (v) => () => (picked = v);
  const t = opts.deleted ? [
    { label: 'Copy User Name', enabled: !!opts.hasUser, click: p('copy-user') },
    { label: 'Copy Password', enabled: !!opts.hasPassword, click: p('copy-password') },
    { type: 'separator' },
    { label: 'Recover', click: p('recover') },
    { label: 'Delete Now…', click: p('purge') },
  ] : [
    { label: 'Copy User Name', enabled: !!opts.hasUser, click: p('copy-user') },
    { label: 'Copy Password', enabled: !!opts.hasPassword, click: p('copy-password') },
    ...(opts.hasCode ? [{ label: 'Copy Verification Code', click: p('copy-code') }] : []),
    { label: 'Open Login Page', enabled: !!opts.hasLink, click: p('open') },
    { type: 'separator' },
    { label: opts.favorite ? 'Remove from Favorites' : 'Add to Favorites', click: p('favorite') },
    { label: 'Edit', click: p('edit') },
    { label: 'Delete…', click: p('delete') },
  ];
  Menu.buildFromTemplate(t).popup({ window: win, callback: () => resolve(picked) });
}));

powerMonitor.on('lock-screen', () => { if (session) { lock(); send('locked'); } });
powerMonitor.on('suspend', () => { if (session) { lock(); send('locked'); } });

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
    webPreferences: {
      preload: path.join(__dirname, 'preload-quick.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, devTools: DEV,
    },
  });
  quick.loadFile(path.join(__dirname, 'src', 'quick.html'));
  quick.webContents.on('will-navigate', (e) => e.preventDefault());
  quick.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  quick.on('blur', () => { if (!SMOKE) hideQuick(); });
  quick.on('close', (e) => { if (!quitting) { e.preventDefault(); hideQuick(); } });
}

function showQuick() {
  if (!quick || quick.isDestroyed()) createQuick();
  if (quick.isVisible()) return hideQuick();
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const [w, h] = quick.getSize();
  quick.setPosition(Math.round(workArea.x + (workArea.width - w) / 2), Math.round(workArea.y + workArea.height * 0.22));
  const go = () => { quick.webContents.send('quick:show'); if (SMOKE) quick.showInactive(); else { quick.show(); quick.focus(); } };
  if (quick.webContents.isLoading()) quick.webContents.once('did-finish-load', go); else go();
}
function hideQuick() { if (quick && !quick.isDestroyed() && quick.isVisible()) quick.hide(); }

const fromQuick = (e) => quick && !quick.isDestroyed() && e.sender === quick.webContents;
const quickItem = (id) => (sessionItems() || []).find((x) => x.id === id && !x.deletedAt);

ipcMain.handle('quick:list', (e) => {
  if (!fromQuick(e)) return null;
  const items = sessionItems();
  if (!items) return { locked: true, exists: fs.existsSync(vaultPath()) };
  send('activity');
  return {
    locked: false,
    items: items.filter((x) => !x.deletedAt).map((x) => ({
      id: x.id, title: x.title, username: x.username, website: x.website, favorite: !!x.favorite,
      hasPassword: !!x.password, hasCode: !!otp.otpField(x),
    })),
  };
});
ipcMain.handle('quick:unlock', async (e, password) => {
  if (!fromQuick(e)) return { ok: false };
  if (session) return { ok: true };
  const r = await unlock(password);
  if (r.ok) send('unlocked-elsewhere', r.items);
  return { ok: r.ok, error: r.error };
});
ipcMain.handle('quick:copy', async (e, id, what) => {
  if (!fromQuick(e)) return { ok: false };
  const it = quickItem(id);
  if (!it) return { ok: false };
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
ipcMain.handle('quick:code', async (e, id) => {
  if (!fromQuick(e)) return null;
  const it = quickItem(id);
  const f = it && otp.otpField(it);
  const cfg = f && otp.parse(f.value);
  if (!cfg) return null;
  return { code: otp.pretty(await otp.code(cfg, nodeHmac)), left: otp.remaining(cfg), period: cfg.period };
});
ipcMain.handle('quick:open', (e, url) => fromQuick(e) && openUrl(url));
ipcMain.handle('quick:hide', (e) => { if (fromQuick(e)) hideQuick(); });
ipcMain.handle('quick:main', (e) => { if (fromQuick(e)) { hideQuick(); showMain(); } });

// ---------- Notification area: Vault keeps running so the hotkey works ---------
let tray = null;
let quitting = false;
app.on('before-quit', () => { quitting = true; });

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
    { label: 'Lock Vault', click: () => { lock(); send('locked'); } },
    { label: 'Quit Vault', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showMain);
}

// Start with Windows (installed app only; a portable copy may be on a USB stick that isn't there).
const canOpenAtLogin = () => app.isPackaged && !PORTABLE_DIR;
function setOpenAtLogin(on) {
  if (canOpenAtLogin()) app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] });
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
    createWindow();
    setupUpdates();
    if (!SMOKE) {
      setupTray();
      createQuick();
      if (!globalShortcut.register(HOTKEY, showQuick)) console.warn('Quick-search hotkey is taken by another app');
    }
    if (SHOTS) require('./scripts/screenshots')({ app, win, nativeTheme, showQuick, getQuick: () => quick });
    else if (SMOKE) require('./scripts/smoke')({ app, win, nativeTheme, vaultPath, opened, clipboard, smokeIO, showQuick, getQuick: () => quick });
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => { lock(); app.quit(); });
}
