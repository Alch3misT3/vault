'use strict';
// Browser bridge: lets the Vault browser extension find and fill logins.
//
// - The extension reaches Vault through native messaging: the browser starts Vault's small relay
//   (vault-native-host.exe), which passes messages over a named pipe that only this Windows user can
//   open. Vault listens only once a browser has been paired (or a pairing is open). No network port.
// - Pairing: Vault shows a one-time code (160 random bits, valid 10 minutes). The extension and
//   Vault both derive a 256-bit key from it with HKDF, salted with the extension's random id.
// - Every request and reply is AES-256-GCM encrypted with that key, time-stamped and single-use,
//   so another program on this PC, or a web page, can't read or replay anything.
// - Keys are stored with Windows DPAPI (Electron safeStorage) in settings.json.

const net = require('net');
const nh = require('./nativehost');
const crypto = require('crypto');

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
  let failed = false;
  const pipe = o.pipeName || nh.pipeName();
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

  async function handle(msg, client) {
    const unlocked = o.isUnlocked();
    if (msg.type === 'status') return { unlocked, exists: o.exists(), version: o.app.getVersion() };
    if (msg.type === 'unlock') {
      if (unlocked) return { ok: true };
      const r = await o.unlock(String(msg.password || ''));
      return { ok: !!r.ok, error: r.error };
    }
    // Passkeys: Vault asks the user itself (and asks to unlock first when locked).
    if (msg.type === 'passkey' && o.passkeyRequest) {
      return o.passkeyRequest({ op: msg.op, origin: msg.origin, options: msg.options, requestId: String(msg.requestId || ''), browser: client ? client.name : 'Browser' });
    }
    if (msg.type === 'passkey-cancel' && o.passkeyCancel) { o.passkeyCancel(String(msg.requestId || '')); return { ok: true }; }
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

  // ---- transport: a named pipe, reached through the native messaging relay -------------
  // Messages: { id, kind: 'hello' } | { id, kind: 'pair', clientId, name, proof } | { id, kind: 'rpc', clientId, iv, ct }
  async function onMessage(m) {
    if (!m || typeof m !== 'object') return { error: 'bad' };
    if (m.kind === 'hello') return { app: 'vault', v: 2, pairing: !!(pending && pending.expires > Date.now()) };
    const clientId = String(m.clientId || '');
    if (!/^[a-f0-9]{32}$/.test(clientId)) return { error: 'client' };

    if (m.kind === 'pair') {
      if (!pending || pending.expires < Date.now()) return { error: 'no-pairing' };
      const key = deriveKey(pending.bytes, clientId);
      const proof = Buffer.from(String(m.proof || ''), 'base64');
      const want = hmac(key, 'pair:' + clientId);
      if (proof.length !== want.length || !crypto.timingSafeEqual(proof, want)) {
        pending.tries = (pending.tries || 0) + 1;
        if (pending.tries >= 5) pending = null; // a few typos are fine, guessing isn't
        return { error: 'code' };
      }
      const name = String(m.name || 'Browser').slice(0, 60);
      saveClients([...clients().filter((c) => c.id !== clientId), { id: clientId, name, key: await enc(key), added: Date.now() }]);
      pending = null;
      o.log('paired ' + name);
      return { ok: true, proof: hmac(key, 'paired:' + clientId).toString('base64') };
    }

    if (m.kind === 'rpc') {
      const key = await keyFor(clientId);
      if (!key) return { error: 'not-paired' };
      let msg;
      try { msg = open(key, clientId, m); } catch { return { error: 'auth' }; }
      const now = Date.now();
      if (typeof msg.t !== 'number' || Math.abs(now - msg.t) > MAX_SKEW || typeof msg.n !== 'string' || seen.has(msg.n)) return { error: 'replay' };
      seen.set(msg.n, now);
      for (const [n, t] of seen) if (now - t > 2 * MAX_SKEW) seen.delete(n);
      let result;
      const client = clients().find((c) => c.id === clientId);
      try { result = await handle(msg, client); } catch (err) { result = { error: 'failed' }; o.log('bridge error: ' + (err && err.name)); }
      return seal(key, clientId, { n: msg.n, ...result });
    }
    return { error: 'kind' };
  }

  const sockets = new Set();
  function onConnection(sock) {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    const read = nh.frameReader((m) => {
      const id = m && m.id;
      onMessage(m).catch(() => ({ error: 'failed' })).then((reply) => {
        if (!sock.destroyed) sock.write(nh.frame({ id, ...reply }));
      });
    }, () => sock.destroy());
    sock.on('data', read);
  }

  function listen() {
    if (server || failed) return;
    const s = net.createServer(onConnection);
    s.maxConnections = 16;
    s.on('error', () => { s.close(); failed = true; o.log('pipe busy'); setTimeout(() => { failed = false; }, 5000); });
    s.listen(nh.pipePath(pipe), () => { server = s; });
  }
  function stop() { if (server) { server.close(); server = null; } for (const s of sockets) s.destroy(); sockets.clear(); }
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
    state: () => ({ listening: !!server, pipe, pairing: !!(pending && pending.expires > Date.now()) }),
    _test: { b32decode, deriveKey, hmac, seal, open, siteOf },
  };
};
