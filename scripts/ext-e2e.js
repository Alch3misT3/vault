'use strict';
// Real-browser check of the extension (run by the smoke test when VAULT_EXT_E2E=1):
// starts Microsoft Edge with a throw-away profile and the extension loaded, pairs it through the
// actual popup page, checks the account list, and fills a test login form with the extension's fill code.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const DBG = 9333;

module.exports = async function extE2E({ code, check, shotsDir, wait, master }) {
  const extDir = path.join(__dirname, '..', 'browser-extension');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-edge-'));
  const edge = spawn(EDGE, [
    `--user-data-dir=${profile}`, `--load-extension=${extDir}`, `--disable-extensions-except=${extDir}`,
    `--remote-debugging-port=${DBG}`, '--no-first-run', '--no-default-browser-check', '--disable-features=msEdgeSidebar', 'about:blank',
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

  try {
    // 1. Edge started and the extension's background worker is running.
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
    check('[Edge] extension loads and its background worker starts', !!worker, worker ? worker.url : 'no worker');
    if (!worker) return;
    const extId = worker.url.split('/')[2];

    // 2. Pair through the real popup page (opened as a tab).
    const sw = await connect(worker.webSocketDebuggerUrl);
    await sw.evaluate("chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') }).then(() => true)");
    let popupTarget = null;
    for (let i = 0; i < 40 && !popupTarget; i++) { await wait(150); popupTarget = (await json('/json/list')).find((t) => t.type === 'page' && t.url === `chrome-extension://${extId}/popup.html`); }
    sw.ws.close();
    const pop = await connect(popupTarget.webSocketDebuggerUrl);
    await pop.send('Runtime.enable');
    const asks = await pop.until("!document.getElementById('vPair').hidden");
    check('[Edge] popup asks to connect at first', asks, asks ? '' : await pop.evaluate("location.href + ' :: ' + document.readyState + ' :: ' + [...document.querySelectorAll('section')].map(s => s.id + '=' + s.hidden).join(',')"));
    await pop.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 470, deviceScaleFactor: 1, mobile: false });
    await pop.shot('30-ext-pair');
    await pop.evaluate(`(() => { document.getElementById('pairCode').value = ${JSON.stringify(code)}; document.getElementById('pairForm').requestSubmit(); })()`);
    const listed = await pop.until("!document.getElementById('vList').hidden", 10000);
    const why = listed ? '' : await pop.evaluate("document.getElementById('pairErr').textContent + ' | ' + document.querySelector('section:not([hidden]) h1, section:not([hidden]) p')?.textContent");
    check('[Edge] pairing from the popup works (real WebCrypto + 127.0.0.1 fetch)', listed, why);

    // 3. Search lists accounts.
    await pop.evaluate(`(() => { const q = document.getElementById('q'); q.value = 'git'; q.dispatchEvent(new Event('input')); })()`);
    check('[Edge] popup search finds GitHub', await pop.until("/GitHub/.test(document.getElementById('list').textContent)"));
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
    const fillSrc = fs.readFileSync(path.join(extDir, 'vault-client.js'), 'utf8').match(/function fillPage[\s\S]*?\n  }\n/)[0];
    const codeSrc = fs.readFileSync(path.join(extDir, 'vault-client.js'), 'utf8').match(/function fillCodeInPage[\s\S]*?\n  }\n/)[0];
    const res = await pg.evaluate(`(${fillSrc})('dev-user', 'gh-Pa55-word')`);
    const vals = await pg.evaluate("[document.getElementById('u').value, document.getElementById('p').value, document.querySelector('[name=search]').value, window.events]");
    check('[Edge] fill puts user name and password in the right boxes', res && res.filled === 2 && vals[0] === 'dev-user' && vals[1] === 'gh-Pa55-word' && vals[2] === '' && vals[3] >= 2, JSON.stringify(vals));
    const cres = await pg.evaluate(`(${codeSrc})('123456')`);
    check('[Edge] 2FA code goes into the one-time-code box', cres && cres.filled === 1 && (await pg.evaluate("document.getElementById('c').value")) === '123456');
    pg.ws.close();
    pop.ws.close();
  } catch (err) {
    check('[Edge] browser test crashed', false, err && err.stack);
  } finally {
    try { edge.kill(); } catch {}
    await wait(800);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
};
