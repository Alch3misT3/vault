'use strict';
// Real-browser check of the extension (Edge by default, or VAULT_E2E_BROWSER, e.g. Helium),
// run by the smoke test when VAULT_EXT_E2E=1:
// - starts the browser with a throw-away profile and a test copy of the extension, whose native
//   messaging host ("local.vault.app.smoke") is registered for Edge only during the test and points
//   at this smoke run's own pipe (the real "local.vault.app" registration is never touched);
// - pairs through the actual popup page, checks the account list and the fill code;
// - on https://webauthn.io: registers a passkey kept in Vault, signs in with it, locks and unlocks
//   Vault and signs in again; and checks that "Use Another Device" leaves the browser's own flow working.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nh = require('../nativehost');

const EDGE = process.env.VAULT_E2E_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const DBG = 9333;
const TEST_HOST = 'local.vault.app.smoke';

module.exports = async function extE2E({ area, code, check, shotsDir, wait, master, pipe, hostExe, test, win, js, waitFor, relock }) {
  const srcDir = path.join(__dirname, '..', 'browser-extension');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-e2e-'));
  const profile = path.join(tmp, 'profile');
  const extDir = path.join(tmp, 'extension');
  const hostDir = path.join(tmp, 'host');

  // Test copy of the extension: same id (same key), but it talks to the test host.
  fs.mkdirSync(extDir, { recursive: true });
  for (const name of fs.readdirSync(srcDir)) {
    const from = path.join(srcDir, name);
    if (fs.statSync(from).isDirectory()) { fs.mkdirSync(path.join(extDir, name)); for (const f of fs.readdirSync(from)) fs.copyFileSync(path.join(from, f), path.join(extDir, name, f)); }
    else fs.copyFileSync(from, path.join(extDir, name));
  }
  const vc = path.join(extDir, 'vault-client.js');
  fs.writeFileSync(vc, fs.readFileSync(vc, 'utf8').replace("const HOST = 'local.vault.app';", `const HOST = '${TEST_HOST}';`));
  // The host: a tiny batch file that points the relay at this smoke run's pipe.
  fs.mkdirSync(hostDir, { recursive: true });
  const cmd = path.join(hostDir, 'host.cmd');
  fs.writeFileSync(cmd, `@echo off\r\nset VAULT_PIPE=${pipe}\r\n"${hostExe}" %*\r\n`);
  const extId = nh.extensionId(path.join(extDir, 'manifest.json'));
  await nh.register({ dir: hostDir, exe: cmd, extId, name: TEST_HOST, browsers: 'edge' });

  const edge = spawn(EDGE, [
    `--user-data-dir=${profile}`, `--load-extension=${extDir}`, `--disable-extensions-except=${extDir}`,
    `--remote-debugging-port=${DBG}`, '--no-first-run', '--no-default-browser-check', '--disable-features=msEdgeSidebar',
    ...(area ? [`--window-position=${area.x + 80},${area.y + 80}`, '--window-size=1280,900'] : []), 'about:blank',
  ], { stdio: 'ignore' });
  const json = async (p, method = 'GET') => (await fetch(`http://127.0.0.1:${DBG}${p}`, { method })).json();

  // Tiny DevTools-protocol client.
  async function connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let id = 0; const waiting = new Map();
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } };
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const evaluate = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result && r.result.result ? r.result.result.value : undefined; };
    const until = async (expr, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await evaluate(expr)) return true; } catch {} await wait(150); } return false; };
    const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); if (r.result) fs.writeFileSync(path.join(shotsDir, name + '.png'), Buffer.from(r.result.data, 'base64')); };
    return { ws, send, evaluate, until, shot };
  }
  // Vault's confirmation window, driven like a user would.
  const prompt = () => test.getPrompt();
  const promptUntil = async (expr, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { try { const p = prompt(); if (p && p.isVisible() && (await p.webContents.executeJavaScript(expr))) return true; } catch {} await wait(120); } return false; };
  const promptDo = (expr) => prompt().webContents.executeJavaScript(expr);

  try {
    // 1. The browser started and the extension's background worker is running.
    let worker = null;
    for (let i = 0; i < 60 && !worker; i++) {
      await wait(250);
      try {
        // Edge has built-in extensions with a background.js too: pick the one named "Vault".
        for (const t of (await json('/json/list')).filter((x) => /^chrome-extension:\/\/[a-p]{32}\/background\.js$/.test(x.url))) {
          const c = await connect(t.webSocketDebuggerUrl);
          const name = await c.evaluate('chrome.runtime.getManifest().name');
          c.ws.close();
          if (name === 'Vault') { worker = t; break; }
        }
      } catch {}
    }
    check('[browser] extension loads and its background worker starts', !!worker, worker ? worker.url : 'no worker');
    if (!worker) return;
    check('[browser] the extension has its fixed id', worker.url.split('/')[2] === extId, worker.url);

    // 2. Pair through the real popup page (opened as a tab), over native messaging.
    const sw = await connect(worker.webSocketDebuggerUrl);
    await sw.evaluate("chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') }).then(() => true)");
    let popupTarget = null;
    for (let i = 0; i < 40 && !popupTarget; i++) { await wait(150); popupTarget = (await json('/json/list')).find((t) => t.type === 'page' && t.url === `chrome-extension://${extId}/popup.html`); }
    sw.ws.close();
    const pop = await connect(popupTarget.webSocketDebuggerUrl);
    await pop.send('Runtime.enable');
    const asks = await pop.until("!document.getElementById('vPair').hidden");
    check('[browser] popup asks to connect at first', asks);
    await pop.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 470, deviceScaleFactor: 1, mobile: false });
    await pop.shot('30-ext-pair');
    await pop.evaluate(`(() => { document.getElementById('pairCode').value = ${JSON.stringify(code)}; document.getElementById('pairForm').requestSubmit(); })()`);
    const listed = await pop.until("!document.getElementById('vList').hidden", 15000);
    const why = listed ? '' : await pop.evaluate("document.getElementById('pairErr').textContent + ' | ' + document.querySelector('section:not([hidden]) h1, section:not([hidden]) p')?.textContent");
    check('[browser] pairing from the popup works (real WebCrypto + native messaging relay)', listed, why);

    // 3. Search lists accounts.
    await pop.evaluate(`(() => { const q = document.getElementById('q'); q.value = 'git'; q.dispatchEvent(new Event('input')); })()`);
    check('[browser] popup search finds GitHub', await pop.until("/GitHub/.test(document.getElementById('list').textContent)"));
    await pop.evaluate(`(() => { const q = document.getElementById('q'); q.value = 'e'; q.dispatchEvent(new Event('input')); })()`);
    await pop.until("document.querySelectorAll('#list .row').length > 3");
    await pop.shot('31-ext-list');

    // 4. The fill code fills a realistic login form (React-style value setter, two-field form).
    const page = await json('/json/new?about:blank', 'PUT');
    const pg = await connect(page.webSocketDebuggerUrl);
    await pg.send('Runtime.enable');
    await pg.send('Page.enable');
    const html = `<!doctype html><title>Sign in</title><form><input name="search" placeholder="Search site">
      <h2>Sign in</h2><input id="u" name="login" type="email" autocomplete="username" placeholder="Email">
      <input id="p" type="password" autocomplete="current-password"><button>Sign in</button></form>
      <form><input id="c" autocomplete="one-time-code" placeholder="6-digit code"></form>
      <script>window.events = 0; for (const el of document.querySelectorAll('input')) el.addEventListener('input', () => window.events++);</script>`;
    await pg.send('Page.navigate', { url: 'data:text/html,' + encodeURIComponent(html) });
    await pg.until("!!document.getElementById('p')");
    const fillSrc = fs.readFileSync(path.join(srcDir, 'vault-client.js'), 'utf8').match(/function fillPage[\s\S]*?\n  }\n/)[0];
    const codeSrc = fs.readFileSync(path.join(srcDir, 'vault-client.js'), 'utf8').match(/function fillCodeInPage[\s\S]*?\n  }\n/)[0];
    const res = await pg.evaluate(`(${fillSrc})('dev-user', 'gh-Pa55-word')`);
    const vals = await pg.evaluate("[document.getElementById('u').value, document.getElementById('p').value, document.querySelector('[name=search]').value, window.events]");
    check('[browser] fill puts user name and password in the right boxes', res && res.filled === 2 && vals[0] === 'dev-user' && vals[1] === 'gh-Pa55-word' && vals[2] === '' && vals[3] >= 2, JSON.stringify(vals));
    const cres = await pg.evaluate(`(${codeSrc})('123456')`);
    check('[browser] 2FA code goes into the one-time-code box', cres && cres.filled === 1 && (await pg.evaluate("document.getElementById('c').value")) === '123456');

    // 5. webauthn.io: a passkey kept in Vault.
    const user = 'vault-e2e-' + Math.random().toString(36).slice(2, 10);
    const openSite = async () => {
      await pg.send('Page.navigate', { url: 'https://webauthn.io/' });
      const ok = await pg.until("!!document.getElementById('register-button') && !!window.Alpine", 30000);
      await wait(2500); // the site starts its own autofill passkey request after loading; a click before that is cancelled by it
      return ok;
    };
    const alertText = () => pg.evaluate("(document.querySelector('.alert') || {}).textContent || ''");
    check('[webauthn.io] the site loads', await openSite());
    check('[webauthn.io] Vault’s passkey hook is in the page (navigator.credentials.create is Vault’s)', await pg.evaluate("navigator.credentials.create.name === 'create' && !/native code/.test(String(navigator.credentials.create))"));
    await pg.evaluate(`(() => { const i = document.getElementById('input-email'); i.value = ${JSON.stringify(user)}; i.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('register-button').click(); return true; })()`);
    const asked = await promptUntil(`document.getElementById('pTitle').textContent.includes('webauthn.io') && document.getElementById('pAccount').textContent === ${JSON.stringify(user)}`);
    check('[webauthn.io] Register: Vault asks to save a passkey (site + account)', asked);
    if (asked) await promptDo("document.getElementById('pGo').click()");
    const registered = await pg.until("/Success! Now try to authenticate/.test((document.querySelector('.alert') || {}).textContent || '')", 20000);
    check('[webauthn.io] the site accepts the passkey Vault made', registered, await alertText());
    await pg.shot('48-webauthn-registered');
    const kept = test.sitePasskeys().filter((p) => p.rpId === 'webauthn.io' && p.userName === user);
    check('[webauthn.io] the passkey is stored in Vault (rpId webauthn.io)', kept.length === 1);

    const signIn = async (label, unlockFirst) => {
      await pg.evaluate(`(() => { const i = document.getElementById('input-email'); i.value = ${JSON.stringify(user)}; i.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('login-button').click(); return true; })()`);
      if (unlockFirst) {
        const locked = await promptUntil("!document.getElementById('pLock').hidden");
        check(`[webauthn.io] ${label}: Vault is locked, so its prompt asks to unlock first`, locked);
        await promptDo(`document.getElementById('ppw').value = ${JSON.stringify(master)}; document.getElementById('pLock').requestSubmit(); true`);
      }
      const offered = await promptUntil(`[...document.querySelectorAll('#pAccounts .q-row')].some((r) => r.textContent.includes(${JSON.stringify(user)}))`);
      check(`[webauthn.io] ${label}: Vault offers the account`, offered);
      if (offered) await promptDo("document.getElementById('pGo').click()");
      const inside = await pg.until("location.pathname === '/profile'", 20000);
      check(`[webauthn.io] ${label}: signed in with the Vault passkey`, inside, inside ? '' : await alertText());
      return inside;
    };
    if (await signIn('Authenticate')) await pg.shot('49-webauthn-signed-in');
    check('[webauthn.io] the sign counter went up', test.sitePasskeys().find((p) => p.userName === user).signCount === 1);

    // 6. Lock Vault, then sign in again: unlock in Vault's prompt first.
    await openSite();
    await relock();
    await signIn('After locking', true);
    check('[webauthn.io] counter 2 after the second sign-in', (test.sitePasskeys().find((p) => p.userName === user) || {}).signCount === 2);
    // the window was unlocked from the prompt too
    await waitFor("!document.getElementById('app').hidden");

    // 7. "Use Another Device": the browser's own flow runs (here a virtual security key stands in).
    await openSite();
    await pg.send('WebAuthn.enable', { enableUI: false });
    await pg.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'usb', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await pg.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    const user2 = user + '-other';
    await pg.evaluate(`(() => { const i = document.getElementById('input-email'); i.value = ${JSON.stringify(user2)}; i.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('register-button').click(); return true; })()`);
    const asked2 = await promptUntil("!document.getElementById('pOther').hidden && !document.getElementById('pCreate').hidden");
    await pg.send('Page.bringToFront'); // Windows gives focus back to the browser when Vault's window closes
    if (asked2) await promptDo("document.getElementById('pOther').click()");
    const native = await pg.until("/Success! Now try to authenticate/.test((document.querySelector('.alert') || {}).textContent || '')", 20000);
    check('[webauthn.io] “Use Another Device” hands over to the browser’s own passkey flow, which works', asked2 && native && !test.sitePasskeys().some((p) => p.userName === user2), await alertText());
    pg.ws.close();
    pop.ws.close();
  } catch (err) {
    check('[browser] browser test crashed', false, err && err.stack);
  } finally {
    try { edge.kill(); } catch {}
    await wait(800);
    await nh.unregister({ name: TEST_HOST, browsers: 'edge' });
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
};
