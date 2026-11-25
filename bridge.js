'use strict';
// Browser bridge: lets the Vault browser extension find and fill logins.
//
// - Listens on 127.0.0.1 only, and only once a browser has been paired (or a pairing is open).
// - Pairing: Vault shows a one-time code (160 random bits, valid 10 minutes). The extension and
//   Vault both derive a 256-bit key from it with HKDF, salted with the extension's random id.
// - Every request and reply is AES-256-GCM encrypted with that key, time-stamped and single-use,
//   so another program on this PC, or a web page, can't read or replay anything.
// - Keys are stored with Windows DPAPI (Electron safeStorage) in settings.json.

const http = require('http');
const crypto = require('crypto');

const PORTS = [47290, 47291, 47292, 47293, 47294];
const PAIR_MS = 10 * 60 * 1000;
const MAX_SKEW = 2 * 60 * 1000;
const INFO = Buffer.from('vault-browser-v1');
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function b32encode(buf) {
  let bits = 0, acc = 0, out = '';
  for (const byte of buf) { acc = (acc << 8) | byte; bits += 8; while (bits >= 5) { bits -= 5; out += B32[(acc >>> bits) & 31]; } }
  if (bits) out += B32[(acc << (5 - bits)) & 31];
  return out;
}
function b32decode(s) {
  const clean = String(s).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, acc = 0; const out = [];
  for (const ch of clean) { acc = (acc << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { bits -= 8; out.push((acc >>> bits) & 255); } }
  return Buffer.from(out);
}
const deriveKey = (codeBytes, clientId) => Buffer.from(crypto.hkdfSync('sha256', codeBytes, Buffer.from(clientId), INFO, 32));
const hmac = (key, text) => crypto.createHmac('sha256', key).update(text).digest();

function seal(key, clientId, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(clientId));
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final(), c.getAuthTag()]);
  return { iv: iv.toString('base64'), ct: ct.toString('base64') };
}
function open(key, clientId, box) {
  const iv = Buffer.from(String(box.iv), 'base64');
  const all = Buffer.from(String(box.ct), 'base64');
  if (iv.length !== 12 || all.length < 17) throw new Error('bad box');
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(Buffer.from(clientId));
  d.setAuthTag(all.subarray(all.length - 16));
  return JSON.parse(Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]).toString('utf8'));
}

// "accounts.netflix.com" and "www.netflix.com" are the same site; so are "bbc.co.uk" subdomains.
function siteOf(hostname) {
  const parts = String(hostname || '').toLowerCase().replace(/\.$/, '').split('.');
  if (parts.length <= 2) return parts.join('.');
  const sld = parts[parts.length - 2];
  const short = parts[parts.length - 1].length === 2 && /^(co|com|net|org|gov|ac|edu|or|ne|go)$/.test(sld);
  return parts.slice(short ? -3 : -2).join('.');
}

module.exports = function createBridge(o) {
  // o: { app, safeStorage, prefs, setPref, sessionItems, unlock, isUnlocked, exists, copy, otp, links, nodeHmac, onActivity, onChange, log }
  let server = null;
  let port = null;
  let pending = null;              // { bytes, code, expires }
  const seen = new Map();          // nonce -> time (replay protection)

  const enc = async (buf) => ((await o.safeStorage.isAsyncEncryptionAvailable())
    ? 'dpapi:' + (await o.safeStorage.encryptStringAsync(buf.toString('base64'))).toString('base64')
    : 'raw:' + buf.toString('base64'));
  const dec = async (s) => (s.startsWith('dpapi:')
    ? Buffer.from((await o.safeStorage.decryptStringAsync(Buffer.from(s.slice(6), 'base64'))).result, 'base64')
    : Buffer.from(s.slice(4), 'base64'));
  const keyCache = new Map(); // id -> key, so DPAPI isn't asked on every request
  const clients = () => o.prefs().browsers || [];
  const saveClients = (list) => { o.setPref('browsers', list); o.onChange(); };
  async function keyFor(id) {
    const c = clients().find((x) => x.id === id);
    if (!c) { keyCache.delete(id); return null; }
    if (keyCache.has(id)) return keyCache.get(id);
    try { const k = await dec(c.key); keyCache.set(id, k); return k; } catch { return null; }
  }

  // ---- what the extension can ask -------------------------------------------
  function listFor(url, query) {
    const items = (o.sessionItems() || []).filter((x) => !x.deletedAt);
    let tabSite = null;
    try { const u = new URL(url); if (/^https?:$/.test(u.protocol)) tabSite = siteOf(u.hostname); } catch {}
    const q = String(query || '').trim().toLowerCase();
    const out = [];
    for (const it of items) {
      const link = o.links.loginLink(it);
      const host = link ? link.host : '';
      const web = o.links.hostOf(it.website);
      const sites = [host, web && web.hostname].filter(Boolean).map(siteOf);
      const match = !!tabSite && sites.includes(tabSite);
      if (q) {
        const hay = [it.title, it.username, it.website].join('\n').toLowerCase();
        if (!q.split(/\s+/).every((t) => hay.includes(t))) continue;
      } else if (!match) continue;
      out.push({ id: it.id, title: it.title, username: it.username, host, match, favorite: !!it.favorite, hasPassword: !!it.password, hasCode: !!o.otp.otpField(it) });
    }
    out.sort((a, b) => (b.match - a.match) || (b.favorite - a.favorite) || a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
    return out.slice(0, 50);
  }

  async function handle(msg) {
    const unlocked = o.isUnlocked();
    if (msg.type === 'status') return { unlocked, exists: o.exists(), version: o.app.getVersion() };
    if (msg.type === 'unlock') {
      if (unlocked) return { ok: true };
      const r = await o.unlock(String(msg.password || ''));
      return { ok: !!r.ok, error: r.error };
    }
    if (!unlocked) return { locked: true };
    o.onActivity();
    if (msg.type === 'list') return { items: listFor(msg.url, msg.query) };
    const it = (o.sessionItems() || []).find((x) => x.id === msg.id && !x.deletedAt);
    if (!it) return { error: 'missing' };
    if (msg.type === 'login') return { username: it.username || '', password: it.password || '' };
    if (msg.type === 'code' || msg.type === 'copy') {
      const f = o.otp.otpField(it);
      const cfg = f && o.otp.parse(f.value);
      if (msg.type === 'code') return cfg ? { code: await o.otp.code(cfg, o.nodeHmac) } : { error: 'no-code' };
      const what = msg.what;
      if (what === 'username' && it.username) await o.copy(it.username, false);
      else if (what === 'password' && it.password) await o.copy(it.password, true);
      else if (what === 'code' && cfg) await o.copy(await o.otp.code(cfg, o.nodeHmac), true);
      else return { error: 'empty' };
      return { ok: true };
    }
    return { error: 'unknown' };
  }

  // ---- HTTP -------------------------------------------------------------------
  function reply(res, status, body) {
    const data = JSON.stringify(body);
    // No CORS headers on purpose: web pages can't read anything. The extension has host permission.
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  }

  async function onRequest(req, res) {
    // Only this machine, only the extension: refuse web-page origins and rebinding tricks.
    const origin = req.headers.origin || '';
    if (origin && !/^(chrome|moz)-extension:\/\//.test(origin) && !/^extension:\/\//.test(origin)) return reply(res, 403, { error: 'origin' });
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host || '')) return reply(res, 403, { error: 'host' });
    if (req.method === 'GET' && req.url === '/hello') return reply(res, 200, { app: 'vault', v: 1, pairing: !!(pending && pending.expires > Date.now()) });
    if (req.method !== 'POST') return reply(res, 405, { error: 'method' });

    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 65536) return reply(res, 413, { error: 'size' }); }
    let body;
    try { body = JSON.parse(raw); } catch { return reply(res, 400, { error: 'json' }); }
    const clientId = String(body.clientId || '');
    if (!/^[a-f0-9]{32}$/.test(clientId)) return reply(res, 400, { error: 'client' });

    if (req.url === '/pair') {
      if (!pending || pending.expires < Date.now()) return reply(res, 403, { error: 'no-pairing' });
      const key = deriveKey(pending.bytes, clientId);
      const proof = Buffer.from(String(body.proof || ''), 'base64');
      const want = hmac(key, 'pair:' + clientId);
      if (proof.length !== want.length || !crypto.timingSafeEqual(proof, want)) {
        pending.tries = (pending.tries || 0) + 1;
        if (pending.tries >= 5) pending = null; // a few typos are fine, guessing isn't
        return reply(res, 403, { error: 'code' });
      }
      const name = String(body.name || 'Browser').slice(0, 60);
      saveClients([...clients().filter((c) => c.id !== clientId), { id: clientId, name, key: await enc(key), added: Date.now() }]);
      pending = null;
      o.log('paired ' + name);
      return reply(res, 200, { ok: true, proof: hmac(key, 'paired:' + clientId).toString('base64') });
    }

    if (req.url === '/rpc') {
      const key = await keyFor(clientId);
      if (!key) return reply(res, 401, { error: 'not-paired' });
      let msg;
      try { msg = open(key, clientId, body); } catch { return reply(res, 401, { error: 'auth' }); }
      const now = Date.now();
      if (typeof msg.t !== 'number' || Math.abs(now - msg.t) > MAX_SKEW || typeof msg.n !== 'string' || seen.has(msg.n)) return reply(res, 401, { error: 'replay' });
      seen.set(msg.n, now);
      for (const [n, t] of seen) if (now - t > 2 * MAX_SKEW) seen.delete(n);
      let result;
      try { result = await handle(msg); } catch (err) { result = { error: 'failed' }; o.log('bridge error: ' + (err && err.message)); }
      return reply(res, 200, seal(key, clientId, { n: msg.n, ...result }));
    }
    return reply(res, 404, { error: 'path' });
  }

  function listen(i = 0) {
    if (server || i >= PORTS.length) return;
    const s = http.createServer((req, res) => { onRequest(req, res).catch(() => { try { reply(res, 500, { error: 'failed' }); } catch {} }); });
    s.on('error', () => { s.close(); listen(i + 1); });
    s.listen(PORTS[i], '127.0.0.1', () => { server = s; port = PORTS[i]; });
  }
  function stop() { if (server) { server.close(); server = null; port = null; } }
  function sync() { if (clients().length || (pending && pending.expires > Date.now())) listen(); else stop(); }

  return {
    start: sync,
    stop,
    // A fresh one-time code, shown in Vault's Connect a Browser dialog.
    startPairing() {
      const bytes = crypto.randomBytes(20);
      const code = b32encode(bytes).match(/.{4}/g).join('-');
      pending = { bytes, code, expires: Date.now() + PAIR_MS, tries: 0 };
      listen();
      setTimeout(sync, PAIR_MS + 1000);
      return { code, expires: pending.expires };
    },
    cancelPairing() { pending = null; sync(); },
    clients: () => clients().map(({ id, name, added }) => ({ id, name, added })),
    remove(id) { keyCache.delete(id); saveClients(clients().filter((c) => c.id !== id)); sync(); },
    state: () => ({ listening: !!server, port, pairing: !!(pending && pending.expires > Date.now()) }),
    _test: { b32decode, deriveKey, hmac, seal, open, siteOf },
  };
};
