'use strict';
// Smoke test, security part (Electron security checklist + crypto + lock), run with the vault unlocked.

const fs = require('fs');
const path = require('path');
const { BrowserWindow, powerMonitor, session } = require('electron');
const security = require('../security');

module.exports = async function securityChecks({ app, win, js, wait, waitFor, check, clipboard, vaultPath, relock, test, MASTER, getQuick }) {
  const wc = win.webContents;

  // ---------- every window: isolated, sandboxed, no Node, web security on ----------
  const quick = test.getQuickWin && test.getQuickWin();
  const wins = [['main', win], ['quick search', quick]].filter(([, w]) => w && !w.isDestroyed());
  for (const [name, w] of wins) {
    const p = w.webContents.getLastWebPreferences();
    check(`${name} window: contextIsolation, sandbox, no nodeIntegration, webSecurity`,
      p.contextIsolation === true && p.sandbox === true && p.nodeIntegration === false && p.webSecurity !== false && !p.allowRunningInsecureContent && !p.webviewTag && !p.experimentalFeatures,
      JSON.stringify({ ci: p.contextIsolation, sb: p.sandbox, ni: p.nodeIntegration, ws: p.webSecurity }));
  }
  check('pages come from Vault’s own origin, not file://', wc.getURL() === 'https://vault.localhost/index.html' && (!quick || quick.webContents.getURL() === 'https://vault.localhost/quick.html'), wc.getURL());
  check('the page can’t reach Node or Electron', await js("typeof require === 'undefined' && typeof process === 'undefined' && typeof window.vault === 'object' && !('ipcRenderer' in window.vault)"));
  check('the page API is a short fixed list of functions', await js("Object.values(window.vault).every((f) => typeof f === 'function') && Object.keys(window.vault).length < 60"));

  // ---------- IPC: calls from anything but Vault's own page are refused ----------
  const evil = new BrowserWindow({ show: false, webPreferences: security.webPrefs({ preload: path.join(__dirname, 'smoke-evil-preload.js'), session: security.appSession() }) });
  await evil.loadURL(security.pageUrl('index.html'));
  const before = test.guard.refused.length;
  const r1 = await evil.webContents.executeJavaScript("window.evil.invoke('vault:status')");
  const r2 = await evil.webContents.executeJavaScript("window.evil.invoke('quick:list')");
  const r3 = await evil.webContents.executeJavaScript(`window.evil.invoke('vault:unlock', ${JSON.stringify(MASTER)})`);
  check('another window, even on Vault’s own page, is refused by every IPC handler', r1 === null && r2 === null && r3 === null && test.guard.refused.length - before === 3, JSON.stringify([r1, r2, r3]));
  const outside = new BrowserWindow({ show: false, webPreferences: security.webPrefs({ preload: path.join(__dirname, 'smoke-evil-preload.js'), partition: 'smoke-outside' }) });
  await outside.loadURL('data:text/html,<title>x</title>');
  const r4 = await outside.webContents.executeJavaScript("window.evil.invoke('vault:status')");
  check('a page from anywhere else is refused too', r4 === null);
  evil.destroy(); outside.destroy();

  // ---------- navigation, new windows, links ----------
  await js("location.href = 'https://example.com/'; true").catch(() => {});
  await wait(300);
  check('the window can’t navigate away', wc.getURL() === 'https://vault.localhost/index.html', wc.getURL());
  const nWins = BrowserWindow.getAllWindows().length;
  await js("window.open('https://example.com/x'); true");
  await wait(200);
  check('the page can’t open windows', BrowserWindow.getAllWindows().length === nWins);
  const links = await js("Promise.all([vault.open('https://example.com/'), vault.open('http://example.com/'), vault.open('javascript:alert(1)'), vault.open('file:///C:/Windows/win.ini'), vault.open('https://user:pw@example.com/')])");
  check('links open in the browser only when they are https', JSON.stringify(links) === '[true,false,false,false,false]', JSON.stringify(links));

  // ---------- Content Security Policy ----------
  const csp = await js("document.querySelector('meta[http-equiv=Content-Security-Policy]').content");
  check('strict CSP: no unsafe-eval / unsafe-inline, scripts only from Vault', /script-src 'self'/.test(csp) && !/unsafe/.test(csp) && /default-src 'none'/.test(csp), csp);
  check('eval and new Function are blocked', await js("(() => { let a = false, b = false; try { eval('1'); } catch { a = true; } try { new Function('return 1')(); } catch { b = true; } return a && b; })()"));
  check('remote scripts are blocked', await js("new Promise((r) => { const s = document.createElement('script'); s.src = 'https://example.com/x.js'; s.onerror = () => r(true); s.onload = () => r(false); document.head.append(s); setTimeout(() => r(true), 3000); })"));
  check('inline scripts are blocked', await js("(() => { window.__inl = 0; const s = document.createElement('script'); s.textContent = 'window.__inl = 1'; document.head.append(s); return window.__inl === 0; })()"));
  const hdr = await security.appSession().fetch('https://vault.localhost/index.html');
  check('pages are also served with a CSP header (frame-ancestors none)', /frame-ancestors 'none'/.test(hdr.headers.get('content-security-policy') || ''));
  let twice = true; try { security.serveApp(security.appSession()); security.serveApp(security.appSession()); } catch { twice = false; }
  check('a window can be made again on the same session (handler set up once)', twice);
  const trav = await security.appSession().fetch('https://vault.localhost/..%2F..%2Fmain.js');
  check('only files inside the app’s page folder are served', trav.status === 404, String(trav.status));

  // ---------- permissions ----------
  const perms = await js(`(async () => {
    const n = await Notification.requestPermission();
    let cam = 'allowed'; try { await navigator.mediaDevices.getUserMedia({ video: true }); } catch (e) { cam = e.name; }
    let geo = await new Promise((r) => navigator.geolocation.getCurrentPosition(() => r('allowed'), (e) => r('denied ' + e.code)));
    const q = await navigator.permissions.query({ name: 'clipboard-read' });
    return [n, cam, geo, q.state];
  })()`);
  check('every permission request is refused', perms[0] === 'denied' && perms[1] !== 'allowed' && perms[2] !== 'allowed' && perms[3] === 'denied', JSON.stringify(perms));

  // ---------- fuses / DevTools ----------
  const fuses = require('../package.json').build.electronFuses;
  check('build fuses: no RunAsNode, no NODE_OPTIONS, no --inspect, app only from asar, asar integrity, no file:// extras',
    fuses.runAsNode === false && fuses.enableNodeOptionsEnvironmentVariable === false && fuses.enableNodeCliInspectArguments === false &&
    fuses.onlyLoadAppFromAsar === true && fuses.enableEmbeddedAsarIntegrityValidation === true && fuses.grantFileProtocolExtraPrivileges === false);
  const srcs = ['main.js', 'logos.js'].map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
  const prefCalls = srcs.match(/security\.webPrefs\(\{[^\n]*\}\)/g) || [];
  check('DevTools: every window turns them off in the built app', prefCalls.length >= 3 && prefCalls.every((c) => /devTools: (DEV|false)/.test(c)), prefCalls.length + ' windows');

  // ---------- crypto on disk ----------
  const f1 = JSON.parse(fs.readFileSync(vaultPath(), 'utf8'));
  await js('persist()');
  const f2 = JSON.parse(fs.readFileSync(vaultPath(), 'utf8'));
  check('a fresh random nonce on every save', f1.iv !== f2.iv && Buffer.from(f2.iv, 'base64').length === 12 && Buffer.from(f2.tag, 'base64').length === 16);
  check('scrypt cost of a new vault: N = 2^18, r = 8 (256 MiB)', f2.kdf.name === 'scrypt' && f2.kdf.N >= 2 ** 18 && f2.kdf.r >= 8 && Buffer.from(f2.kdf.salt, 'base64').length >= 16, JSON.stringify(f2.kdf));
  check('no temp file is left behind after saving', !fs.existsSync(vaultPath() + '.tmp'));
  const bak = fs.readFileSync(vaultPath() + '.bak', 'utf8');
  check('the .bak copy is encrypted too', /"cipher":"aes-256-gcm"/.test(bak) && !/GitHub|gh-Pa55-word|dev-user/.test(bak));

  // a damaged or shortened tag is refused
  const good = fs.readFileSync(vaultPath(), 'utf8');
  await relock();
  const unlockWith = async (pw) => js(`window.vault.unlock(${JSON.stringify(pw)}).then((r) => r.ok)`);
  const tampered = JSON.parse(good);
  const ct = Buffer.from(tampered.data, 'base64'); ct[5] ^= 1; tampered.data = ct.toString('base64');
  fs.writeFileSync(vaultPath(), JSON.stringify(tampered));
  const okTampered = await unlockWith(MASTER);
  const short = JSON.parse(good); short.tag = Buffer.from(short.tag, 'base64').subarray(0, 4).toString('base64');
  fs.writeFileSync(vaultPath(), JSON.stringify(short));
  const okShort = await unlockWith(MASTER);
  fs.writeFileSync(vaultPath(), good);
  check('a changed byte or a shortened GCM tag is refused (tag verified)', okTampered === false && okShort === false);
  await js(`(() => { const el = document.getElementById('pw1'); el.value = ${JSON.stringify(MASTER)}; el.dispatchEvent(new Event('input')); document.getElementById('unlockGo').click(); })()`);
  check('the untouched vault still opens', await waitFor("!document.getElementById('app').hidden"));

  // ---------- lock: key zeroed, window process replaced; idle, Windows lock, sleep ----------
  const key = test.getSession().key;
  const pid = wc.getOSProcessId();
  const fresh = await relock();
  check('locking zeroes the key in memory and starts the window over in a new process', !test.getSession() && key.every((b) => b === 0) && fresh && wc.getOSProcessId() !== pid);
  check('after locking, the page holds no accounts', await js('window.__vaultState.items.length === 0 && !document.querySelector("#list .row")'));

  const unlockUI = async () => {
    await js(`(() => { const el = document.getElementById('pw1'); el.value = ${JSON.stringify(MASTER)}; el.dispatchEvent(new Event('input')); document.getElementById('unlockGo').click(); })()`);
    return waitFor("!document.getElementById('app').hidden");
  };
  for (const ev of ['lock-screen', 'suspend']) {
    await unlockUI();
    const p0 = wc.getOSProcessId();
    powerMonitor.emit(ev);
    const gone = !test.getSession();
    const reloaded = await waitFor(`window.__vaultState && !document.getElementById('lock').hidden`, 5000) && (await (async () => { for (let i = 0; i < 40 && wc.getOSProcessId() === p0; i++) await wait(100); return wc.getOSProcessId() !== p0; })());
    check(`${ev === 'lock-screen' ? 'Windows lock (Win+L)' : 'sleep'} locks Vault and clears the window`, gone && reloaded);
  }
  await unlockUI();
  test.idle.ms = 1200;
  const idleLocked = await (async () => { for (let i = 0; i < 40; i++) { if (!test.getSession()) return true; await wait(100); } return false; })();
  test.idle.ms = 5 * 60 * 1000;
  check('Vault locks itself when nobody uses it (idle)', idleLocked && (await waitFor("window.__vaultState && !document.getElementById('lock').hidden", 6000)));

  // ---------- clipboard ----------
  await test.copy('s3cret-from-test', true);
  await test.copy('not secret', false); // the user (or Vault) copied something else since
  await wait(1700);
  check('the clipboard is left alone if it no longer holds the secret', (await clipboard.readText()) === 'not secret');
  await test.copy('s3cret-from-test', true);
  await test.clearClipboard(); // what happens when Vault quits within the 30 seconds
  check('quitting clears a copied secret right away', (await clipboard.readText()) === '');
  await test.copy('s3cret-2', true);
  await wait(1700);
  check('a copied secret clears itself (smoke: 1.5 s, real: 30 s)', (await clipboard.readText()) === '');

  await unlockUI();
};

// After the whole run: no secret may be in any file Vault wrote (logs, settings, caches, temp files).
module.exports.scanDisk = function scanDisk({ app, check, secrets }) {
  const hits = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) { walk(p); continue; }
      if (/^Vault Passwords .*\.(csv|json)$/.test(name)) continue; // plain exports the test asked for on purpose
      if (st.size > 20 * 1024 * 1024) continue;
      let buf; try { buf = fs.readFileSync(p); } catch { continue; }
      const text = buf.toString('latin1') + '\n' + buf.toString('utf16le');
      for (const s of secrets) if (text.includes(s)) hits.push(path.relative(app.getPath('userData'), p) + ': ' + s.slice(0, 3) + '…');
    }
  };
  walk(app.getPath('userData'));
  check('no password, account or master password in any file Vault wrote (logs, settings, caches)', !hits.length, hits.join(' | '));
};
