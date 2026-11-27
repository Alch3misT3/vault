'use strict';
// Mail kept by Vault: one file (mail.vault) next to the vault, encrypted with AES-256-GCM under a key
// derived from the vault key, like everything else. Loaded only while Vault is unlocked; dropped on lock.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PER_ADDRESS = 200;   // newest messages kept per address
const INFO = 'vault-mail-store-v1';

module.exports = function createStore({ dir, getKey }) {
  const file = () => path.join(dir(), 'mail.vault');
  const keyFor = (k) => Buffer.from(crypto.hkdfSync('sha256', k, Buffer.alloc(0), INFO, 32));
  let data = null; // { messages: [] } while unlocked

  function load(k = getKey()) {
    if (data) return data;
    data = { messages: [] };
    if (!k || !fs.existsSync(file())) return data;
    const box = JSON.parse(fs.readFileSync(file(), 'utf8'));
    const d = crypto.createDecipheriv('aes-256-gcm', keyFor(k), Buffer.from(box.iv, 'base64'));
    d.setAAD(Buffer.from('vault:mail:v1'));
    d.setAuthTag(Buffer.from(box.tag, 'base64'));
    const json = Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8');
    data = JSON.parse(json);
    if (!Array.isArray(data.messages)) data.messages = [];
    return data;
  }

  function write(k = getKey()) {
    if (!k || !data) return false;
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', keyFor(k), iv);
    c.setAAD(Buffer.from('vault:mail:v1'));
    const body = Buffer.concat([c.update(JSON.stringify(data), 'utf8'), c.final()]);
    const text = JSON.stringify({ app: 'vault-mail', v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: body.toString('base64') });
    fs.mkdirSync(dir(), { recursive: true });
    const tmp = file() + '.tmp';
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file());
    return true;
  }

  return {
    load,
    // Adds new messages (skips ones already kept), keeps the newest per address, saves. Returns the added ones.
    add(list) {
      load();
      const have = new Set(data.messages.map((m) => m.id));
      const fresh = list.filter((m) => m && !have.has(m.id));
      if (!fresh.length) return [];
      data.messages.push(...fresh);
      const byAddr = new Map();
      for (const m of data.messages.sort((a, b) => b.receivedAt - a.receivedAt)) {
        const n = byAddr.get(m.addrId) || 0;
        byAddr.set(m.addrId, n + 1);
        if (n >= PER_ADDRESS) m._drop = true;
      }
      data.messages = data.messages.filter((m) => !m._drop);
      write();
      return fresh;
    },
    has: (id) => load().messages.some((m) => m.id === id),
    list: () => load().messages,
    get: (id) => load().messages.find((m) => m.id === id) || null,
    update(id, patch) { const m = load().messages.find((x) => x.id === id); if (!m) return false; Object.assign(m, patch); write(); return true; },
    remove(pred) { load(); const before = data.messages.length; data.messages = data.messages.filter((m) => !pred(m)); if (data.messages.length !== before) write(); },
    lock() { data = null; },
    // The master password changed (new vault key): re-encrypt with the new key.
    rekey(oldKey) { try { if (!data) load(oldKey); write(); } catch { data = null; } },
    reset() { data = null; try { fs.rmSync(file(), { force: true }); } catch {} },
    file,
  };
};
