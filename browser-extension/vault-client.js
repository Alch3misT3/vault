'use strict';
// Talks to the Vault app on this PC through native messaging. Shared by the popup and the background worker.
// Every message is AES-256-GCM encrypted with the key made during pairing; Vault refuses anything else.

/* global chrome */
var VaultClient = (() => {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const te = new TextEncoder();
  const td = new TextDecoder();

  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

  function b32decode(s) {
    const clean = String(s).toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = 0, acc = 0; const out = [];
    for (const ch of clean) { acc = (acc << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { bits -= 8; out.push((acc >>> bits) & 255); } }
    return new Uint8Array(out);
  }

  async function deriveRaw(codeBytes, clientId) {
    const base = await crypto.subtle.importKey('raw', codeBytes, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: te.encode(clientId), info: te.encode('vault-browser-v1') }, base, 256));
  }
  async function hmac(raw, text) {
    const k = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', k, te.encode(text)));
  }
  const aesKey = (raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

  const store = {
    get: () => chrome.storage.local.get(['clientId', 'key', 'vaultName']),
    set: (o) => chrome.storage.local.set(o),
    clear: () => chrome.storage.local.remove(['clientId', 'key']),
  };

  // ---- native messaging: the browser starts Vault's relay, which passes messages to Vault ----
  const HOST = 'local.vault.app';
  let port = null;
  let nextId = 1;
  let idleTimer = null;
  const waiting = new Map(); // id -> { resolve, reject, timer }
  const offline = (msg) => { const e = new Error(msg || 'Vault isn’t running'); e.code = 'offline'; return e; };

  function closePort() {
    if (port) { try { port.disconnect(); } catch {} }
    port = null;
  }
  function failAll(err) {
    for (const [, w] of waiting) { clearTimeout(w.timer); w.reject(err); }
    waiting.clear();
  }
  function getPort() {
    if (port) return port;
    const p = chrome.runtime.connectNative(HOST);
    port = p;
    p.onMessage.addListener((m) => {
      if (m && m.offline) { if (port === p) { closePort(); failAll(offline()); } return; }
      const w = m && waiting.get(m.id);
      if (!w) return;
      waiting.delete(m.id);
      clearTimeout(w.timer);
      delete m.id;
      w.resolve(m);
      idle();
    });
    p.onDisconnect.addListener(() => {
      const why = chrome.runtime.lastError && chrome.runtime.lastError.message;
      if (port !== p) return; // an older port we closed ourselves
      port = null;
      failAll(offline(/not found|not registered/i.test(why || '') ? 'Open Vault once on this PC, then try again.' : 'Vault isn’t running'));
    });
    return p;
  }
  // The relay (and Vault's side of the pipe) closes again when not in use for a while.
  function idle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!waiting.size) closePort(); }, 60000);
  }
  function call(msg, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => { waiting.delete(id); reject(offline('Vault didn’t answer')); }, timeoutMs);
      waiting.set(id, { resolve, reject, timer });
      try { getPort().postMessage({ id, ...msg }); } catch (e) { clearTimeout(timer); waiting.delete(id); reject(offline()); }
    });
  }

  async function hello() {
    try { const j = await call({ kind: 'hello' }, 4000); return j && j.app === 'vault' ? j : null; } catch { return null; }
  }

  function browserName() {
    const ua = navigator.userAgent;
    if (/Firefox\//.test(ua)) return 'Firefox';
    if (/Edg\//.test(ua)) return 'Microsoft Edge';
    if (/OPR\//.test(ua)) return 'Opera';
    if (navigator.brave) return 'Brave';
    if (/Vivaldi/.test(ua)) return 'Vivaldi';
    return 'Chrome';
  }

  async function pair(code) {
    const bytes = b32decode(code);
    if (bytes.length !== 20) throw new Error('That code looks incomplete. Copy it again from Vault.');
    const info = await hello();
    if (!info) throw new Error('Vault isn’t running. Open Vault, then try again.');
    if (!info.pairing) throw new Error('In Vault, open ••• → Connect a Browser first, then paste the code it shows.');
    const clientId = hex(rand(16));
    const raw = await deriveRaw(bytes, clientId);
    const j = await call({ kind: 'pair', clientId, name: browserName(), proof: b64(await hmac(raw, 'pair:' + clientId)) });
    if (!j.ok) throw new Error(j.error === 'code' ? 'That code doesn’t match. Check it and try again.' : 'Vault didn’t accept the code. Open Connect a Browser again for a fresh one.');
    // Make sure it's really Vault answering, not something pretending to be it.
    if (j.proof !== b64(await hmac(raw, 'paired:' + clientId))) throw new Error('Unexpected answer from Vault.');
    await store.set({ clientId, key: b64(raw) });
    return true;
  }

  // timeoutMs: passkey requests wait while the user answers in Vault.
  async function rpc(type, args = {}, timeoutMs) {
    const s = await store.get();
    if (!s.clientId || !s.key) { const e = new Error('Not connected to Vault'); e.code = 'unpaired'; throw e; }
    const key = await aesKey(unb64(s.key));
    const n = hex(rand(12));
    const iv = rand(12);
    const aad = te.encode(s.clientId);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, te.encode(JSON.stringify({ t: Date.now(), n, type, ...args })));
    const j = await call({ kind: 'rpc', clientId: s.clientId, iv: b64(iv), ct: b64(ct) }, timeoutMs);
    if (j.error === 'not-paired') { await store.clear(); const e = new Error('Vault no longer knows this browser. Pair it again.'); e.code = 'unpaired'; throw e; }
    if (j.error) throw new Error('Vault refused the request (' + j.error + ')');
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(j.iv), additionalData: aad }, key, unb64(j.ct));
    const out = JSON.parse(td.decode(plain));
    if (out.n !== n) throw new Error('Mismatched reply');
    delete out.n;
    return out;
  }

  // ---- page helpers (run inside the web page via chrome.scripting) --------------
  function fillPage(username, password) {
    const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.disabled && !el.readOnly; };
    const setValue = (el, v) => {
      const proto = Object.getPrototypeOf(el);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
      el.focus();
      if (setter) setter.call(el, v); else el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const inputs = [...document.querySelectorAll('input')].filter(visible);
    const pw = inputs.find((i) => i.type === 'password' && !/new|confirm|repeat/i.test(i.autocomplete + ' ' + i.name + ' ' + i.id));
    const userLike = (i) => /^(text|email|tel|)$/.test(i.type) && (/username|email/.test(i.autocomplete) || /user|mail|login|account|phone|identifier/i.test(i.name + ' ' + i.id + ' ' + (i.placeholder || '') + ' ' + (i.getAttribute('aria-label') || '')));
    let user = null;
    if (pw) {
      const scope = pw.form ? [...pw.form.querySelectorAll('input')].filter(visible) : inputs;
      const before = scope.slice(0, scope.indexOf(pw));
      user = before.reverse().find(userLike) || before.find((i) => /^(text|email|tel)$/.test(i.type)) || null;
    } else {
      user = inputs.find(userLike) || null; // first step of a two-step login
    }
    let filled = 0;
    if (user && username) { setValue(user, username); filled++; }
    if (pw && password) { setValue(pw, password); filled++; }
    if (pw) pw.focus(); else if (user) user.focus();
    return { filled, hasPassword: !!pw, hasUser: !!user };
  }

  function fillCodeInPage(code) {
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !el.disabled && !el.readOnly; };
    const inputs = [...document.querySelectorAll('input')].filter(visible);
    let el = inputs.find((i) => i.autocomplete === 'one-time-code') ||
      inputs.find((i) => /otp|totp|2fa|mfa|one.?time|verif|auth.?code|security.?code|code/i.test(i.name + ' ' + i.id + ' ' + (i.placeholder || '') + ' ' + (i.getAttribute('aria-label') || '')));
    if (!el && document.activeElement && document.activeElement.tagName === 'INPUT') el = document.activeElement;
    // Some sites use one box per digit.
    const boxes = inputs.filter((i) => i.maxLength === 1);
    const set = (target, v) => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), 'value').set;
      target.focus(); setter.call(target, v);
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
    };
    if (!el && boxes.length >= code.length) { code.split('').forEach((d, i) => set(boxes[i], d)); return { filled: 1 }; }
    if (!el) return { filled: 0 };
    set(el, code);
    return { filled: 1 };
  }

  // "accounts.google.com" -> "google.com" (same idea as in Vault).
  function siteOf(hostname) {
    const parts = String(hostname || '').toLowerCase().split('.');
    if (parts.length <= 2) return parts.join('.');
    const sld = parts[parts.length - 2];
    const short = parts[parts.length - 1].length === 2 && /^(co|com|net|org|gov|ac|edu|or|ne|go)$/.test(sld);
    return parts.slice(short ? -3 : -2).join('.');
  }

  async function fill(tab, item) {
    const login = await rpc('login', { id: item.id });
    if (login.error) throw new Error('That account is gone from Vault.');
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: fillPage, args: [login.username, login.password] });
    return res && res.result;
  }
  async function fillCode(tab, item) {
    const r = await rpc('code', { id: item.id });
    if (!r.code) throw new Error('No verification code for this account.');
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: fillCodeInPage, args: [r.code] });
    return res && res.result;
  }

  return { pair, rpc, hello, fill, fillCode, siteOf, unpair: () => store.clear(), paired: async () => !!(await store.get()).clientId };
})();
