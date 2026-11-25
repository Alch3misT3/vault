'use strict';
// Talks to the Vault app on this PC (127.0.0.1). Shared by the popup and the background worker.
// Every message is AES-256-GCM encrypted with the key made during pairing; Vault refuses anything else.

/* global chrome */
var VaultClient = (() => {
  const PORTS = [47290, 47291, 47292, 47293, 47294];
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
    get: () => chrome.storage.local.get(['clientId', 'key', 'port', 'vaultName']),
    set: (o) => chrome.storage.local.set(o),
    clear: () => chrome.storage.local.remove(['clientId', 'key', 'port']),
  };

  async function hello(port) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 800);
      const r = await fetch(`http://127.0.0.1:${port}/hello`, { signal: ctl.signal, cache: 'no-store' });
      clearTimeout(timer);
      const j = await r.json();
      return j && j.app === 'vault' ? j : null;
    } catch { return null; }
  }
  // Vault uses the first free port of a short list.
  async function findPort(preferred) {
    for (const p of [preferred, ...PORTS.filter((x) => x !== preferred)].filter(Boolean)) {
      const j = await hello(p);
      if (j) return { port: p, info: j };
    }
    return null;
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
    const found = await findPort();
    if (!found) throw new Error('Vault isn’t running. Open Vault, then try again.');
    if (!found.info.pairing) throw new Error('In Vault, open ••• → Connect a Browser first, then paste the code it shows.');
    const clientId = hex(rand(16));
    const raw = await deriveRaw(bytes, clientId);
    const r = await fetch(`http://127.0.0.1:${found.port}/pair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, name: browserName(), proof: b64(await hmac(raw, 'pair:' + clientId)) }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error === 'code' ? 'That code doesn’t match. Check it and try again.' : 'Vault didn’t accept the code. Open Connect a Browser again for a fresh one.');
    // Make sure it's really Vault answering, not something pretending to be it.
    if (j.proof !== b64(await hmac(raw, 'paired:' + clientId))) throw new Error('Unexpected answer from Vault.');
    await store.set({ clientId, key: b64(raw), port: found.port });
    return true;
  }

  async function rpc(type, args = {}) {
    const s = await store.get();
    if (!s.clientId || !s.key) { const e = new Error('Not connected to Vault'); e.code = 'unpaired'; throw e; }
    let port = s.port;
    if (!(await hello(port))) {
      const f = await findPort(port);
      if (!f) { const e = new Error('Vault isn’t running'); e.code = 'offline'; throw e; }
      port = f.port;
      await store.set({ port });
    }
    const key = await aesKey(unb64(s.key));
    const n = hex(rand(12));
    const iv = rand(12);
    const aad = te.encode(s.clientId);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, te.encode(JSON.stringify({ t: Date.now(), n, type, ...args })));
    const r = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
      body: JSON.stringify({ clientId: s.clientId, iv: b64(iv), ct: b64(ct) }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && j.error === 'not-paired') { await store.clear(); const e = new Error('Vault no longer knows this browser. Pair it again.'); e.code = 'unpaired'; throw e; }
    if (!r.ok) throw new Error('Vault refused the request (' + (j.error || r.status) + ')');
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

  return { pair, rpc, fill, fillCode, findPort, siteOf, unpair: () => store.clear(), paired: async () => !!(await store.get()).clientId };
})();
