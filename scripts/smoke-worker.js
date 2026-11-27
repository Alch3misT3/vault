'use strict';
// Smoke test, part: the Cloudflare mail Worker (mail/worker.js), run locally with Cloudflare's own
// tooling (wrangler dev, workerd). Checks: it encrypts each message for Vault, stores only ciphertext,
// sets a 7-day expiry, deletes after Vault fetches, its daily run deletes anything older than 7 days,
// it forwards a copy when asked, and it refuses every request without the secret.
// Run on its own: node scripts/smoke-worker.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const CF = require('../mail/cloudflare');

module.exports = async function workerTest({ check, wait = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const root = path.join(__dirname, '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-worker-'));
  const state = path.join(tmp, 'state');
  const keys = CF.newKeys();
  const SECRET = crypto.randomBytes(24).toString('base64url');
  const port = 18000 + crypto.randomInt(2000);
  const base = `http://127.0.0.1:${port}`;
  const config = path.join(tmp, 'wrangler.jsonc');
  fs.writeFileSync(config, JSON.stringify({
    name: 'vault-mail-test', main: path.join(root, 'mail', 'worker.js').replace(/\\/g, '/'), compatibility_date: '2025-09-01',
    kv_namespaces: [{ binding: 'MAIL', id: 'local-test' }],
    vars: { PUBLIC_KEY: JSON.stringify(keys.publicJwk), FETCH_SECRET: SECRET, FORWARD_TO: 'copies@example.com' },
  }));
  let out = '';
  const wr = spawn('node', [path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), 'dev', '--config', config, '--port', String(port), '--ip', '127.0.0.1', '--persist-to', state],
    { cwd: tmp, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  wr.stdout.on('data', (d) => { out += d; });
  wr.stderr.on('data', (d) => { out += d; });
  const auth = { Authorization: 'Bearer ' + SECRET };
  const get = (p, headers) => fetch(base + p, { headers });
  const list = async () => (await (await get('/list', auth)).json());
  const email = (to, subject, body) => fetch(`${base}/cdn-cgi/local/email?from=${encodeURIComponent('shop@example.net')}&to=${encodeURIComponent(to)}`, {
    method: 'POST', body: `From: Shop <shop@example.net>\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <${crypto.randomUUID()}@example.net>\r\nDate: ${new Date().toUTCString()}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`,
  });
  try {
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) { try { const r = await get('/list'); ready = r.status === 401; } catch {} if (!ready) await wait(500); }
    check('the Worker runs locally (wrangler dev)', ready, ready ? '' : out.slice(-400));
    if (!ready) return;

    // no secret, no entry
    const noAuth = await Promise.all([get('/list'), get('/list', { Authorization: 'Bearer wrong' }), fetch(base + '/selftest?nonce=' + 'a'.repeat(16), { method: 'POST' }), get('/m/m:0000000000-0123456789abcdef'), fetch(base + '/m/m:0000000000-0123456789abcdef', { method: 'DELETE' })]);
    check('the Worker refuses every request without the secret (or with a wrong one)', noAuth.every((r) => r.status === 401), noAuth.map((r) => r.status).join());

    // a message arrives: encrypted for Vault at once, only ciphertext stored, 7-day expiry, copy forwarded
    const r1 = await email('netflix.k3x9qa@example.com', 'Secret subject codeword', 'Your verification code is 482913');
    check('an email to the Worker is accepted', r1.ok, String(r1.status));
    const l1 = await list();
    check('it is stored (one item)', l1.ids.length === 1, JSON.stringify(l1));
    const box = Buffer.from(await (await get('/m/' + encodeURIComponent(l1.ids[0]), auth)).arrayBuffer());
    const plain = CF.openBox(keys.privateJwk, box).toString('utf8');
    check('Vault’s private key opens it: the whole message, with the address it was sent to', /^X-Vault-Envelope-To: netflix\.k3x9qa@example\.com\r\n/.test(plain) && plain.includes('Secret subject codeword') && plain.includes('482913'));
    check('what is stored is ciphertext only', !box.includes('Secret subject') && !box.includes('482913') && box[0] === 1);
    const exp = l1.expires[0];
    check('it expires after 7 days on its own (KV expiry)', typeof exp === 'number' && Math.abs(exp - (Date.now() / 1000 + 7 * 86400)) < 300, String(exp));
    let leaks = [];
    const scan = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); const st = fs.statSync(p); if (st.isDirectory()) scan(p); else { const b = fs.readFileSync(p); if (b.includes('Secret subject') || b.includes('482913')) leaks.push(n); } } };
    scan(state);
    check('nothing readable on the storage’s disk', !leaks.length, leaks.join(' '));
    check('with copies on, the Worker forwards the message to your address too', /forwarded message[\s\S]{0,80}copies@example\.com/.test(out), out.match(/Email handler.*\n.*/) ? out.match(/Email handler.*\n.*/)[0] : '');
    const otherKeys = CF.newKeys();
    let wrongKey = false; try { CF.openBox(otherKeys.privateJwk, box); } catch { wrongKey = true; }
    check('another private key can’t open it', wrongKey);

    // Vault deletes it after fetching
    const del = await fetch(base + '/m/' + encodeURIComponent(l1.ids[0]), { method: 'DELETE', headers: auth });
    check('Vault deletes it after fetching', del.ok && (await list()).ids.length === 0);

    // the daily run: older than 7 days goes, newer stays
    await email('steam.p2m8tw@example.com', 'Recent mail', 'hello');
    const sched = (ms) => fetch(`${base}/cdn-cgi/local/scheduled?cron=${encodeURIComponent('17 3 * * *')}&time=${ms}`);
    await sched(Date.now() + 1 * 86400000);
    const stay = (await list()).ids.length;
    await sched(Date.now() + 8 * 86400000);
    const gone = (await list()).ids.length;
    check('the daily run deletes messages older than 7 days, and only those', stay === 1 && gone === 0, `${stay} → ${gone}`);

    // the Test button's round trip
    const nonce = crypto.randomBytes(16).toString('hex');
    const st = await fetch(`${base}/selftest?nonce=${nonce}`, { method: 'POST', headers: auth });
    const l2 = await list();
    const tb = Buffer.from(await (await get('/m/' + encodeURIComponent(l2.ids[0]), auth)).arrayBuffer());
    check('the Test message goes through the same encryption', st.ok && CF.openBox(keys.privateJwk, tb).toString('utf8').includes('Vault test ' + nonce));
  } catch (err) {
    check('Worker test crashed', false, err && err.stack);
  } finally {
    try { if (process.platform === 'win32') require('child_process').execFileSync('taskkill', ['/pid', String(wr.pid), '/t', '/f'], { stdio: 'ignore' }); else wr.kill(); } catch {}
    await wait(500);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
};

if (require.main === module) {
  let fails = 0;
  module.exports({ check: (n, ok, x) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); } }).then(() => process.exit(fails ? 1 : 0));
}
