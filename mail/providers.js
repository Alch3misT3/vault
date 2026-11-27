'use strict';
// The outside services behind generated email addresses. Every call: main process only, https,
// a timeout, the key or token in a header (never in a URL), and nothing is logged.
//
// One-time inboxes sit behind one small interface ({ create, list, raw, alive, remove }), so the
// provider can be swapped. Today it is mail.tm (https://docs.mail.tm): password-protected inboxes,
// messages kept 7 days, 8 requests a second per IP.
// Alias services ({ verify, create, setEnabled, remove }): SimpleLogin, addy.io and Firefox Relay,
// each with your own account's API key.

const crypto = require('crypto');

class ServiceError extends Error {
  constructor(code, status, message) { super(message || code); this.code = code; this.status = status; }
}

async function call(base, method, path, { headers = {}, body, timeout = 15000, raw = false } = {}) {
  let res;
  try {
    res = await fetch(base + path, {
      method, headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout), redirect: 'error',
    });
  } catch (e) { throw new ServiceError(e && e.name === 'TimeoutError' ? 'timeout' : 'network', 0); }
  if (res.status === 401 || res.status === 403) throw new ServiceError('auth', res.status);
  if (res.status === 404) throw new ServiceError('gone', 404);
  if (res.status === 429) throw new ServiceError('rate', 429);
  if (!res.ok) throw new ServiceError('failed', res.status);
  if (res.status === 204) return null;
  if (raw) return res;
  const text = await res.text();
  if (text.length > 30 * 1024 * 1024) throw new ServiceError('failed', res.status, 'too large');
  try { return text ? JSON.parse(text) : null; } catch { throw new ServiceError('failed', res.status, 'bad reply'); }
}

const rand = (n, set = 'abcdefghijkmnopqrstuvwxyz23456789') => Array.from(crypto.randomBytes(n), (b) => set[b % set.length]).join('');
// "Netflix Account" -> "netflix"; nothing personal goes into an address.
const slug = (s) => (String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '').slice(0, 12)) || 'site';

// ---------- one-time inbox: mail.tm ----------
function mailTm({ base = 'https://api.mail.tm', gap = 400, backoff = [2000, 5000, 10000] } = {}) {
  // mail.tm limits requests per IP: keep calls apart, and when it still says "too many" (429),
  // wait and try again a few times before giving up.
  let next = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function tmCall(method, path, opts) {
    for (let i = 0; ; i++) {
      const wait = next - Date.now();
      next = Math.max(Date.now(), next) + gap;
      if (wait > 0) await sleep(wait);
      try { return await call(base, method, path, opts); } catch (e) {
        if (e.code !== 'rate' || i >= backoff.length) throw e;
        next = Date.now() + backoff[i];
      }
    }
  }
  const auth = (token) => ({ Authorization: 'Bearer ' + token });
  // With Accept: application/json a list is a plain array; as JSON-LD it is wrapped in hydra:member.
  const members = (r) => (Array.isArray(r) ? r : (r && r['hydra:member']) || []);
  async function token(acct) {
    const r = await tmCall('POST', '/token', { body: { address: acct.address, password: acct.password } });
    acct.token = r.token;
    return r.token;
  }
  // Retry once with a fresh token if the old one ran out.
  async function authed(acct, method, path, opts = {}) {
    if (!acct.token) await token(acct);
    try { return await tmCall(method, path, { ...opts, headers: auth(acct.token) }); } catch (e) {
      if (e.code !== 'auth') throw e;
      await token(acct);
      return tmCall(method, path, { ...opts, headers: auth(acct.token) });
    }
  }
  return {
    id: 'mailtm', name: 'mail.tm', site: 'https://mail.tm', keepsDays: 7,
    async create() {
      const d = await tmCall('GET', '/domains');
      const domains = members(d).filter((x) => x.isActive && !x.isPrivate).map((x) => x.domain);
      if (!domains.length) throw new ServiceError('failed', 0, 'no domain');
      const acct = { address: `${rand(10, 'abcdefghijkmnopqrstuvwxyz')}${rand(4, '23456789')}@${domains[crypto.randomInt(domains.length)]}`, password: rand(28, 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789') };
      const a = await tmCall('POST', '/accounts', { body: { address: acct.address, password: acct.password } });
      acct.accountId = a.id;
      await token(acct);
      return acct; // { address, password, accountId, token }
    },
    // newest first: [{ id, createdAt }]
    async list(acct) {
      const r = await authed(acct, 'GET', '/messages?page=1');
      return members(r).map((m) => ({ id: String(m.id), createdAt: Date.parse(m.createdAt) || Date.now() }));
    },
    async raw(acct, id) {
      const r = await authed(acct, 'GET', '/sources/' + encodeURIComponent(id));
      return Buffer.from(String((r && r.data) || ''), 'utf8');
    },
    // false once the inbox is gone at mail.tm (deleted or expired there)
    async alive(acct) {
      try { await authed(acct, 'GET', '/me'); return true; } catch (e) { if (e.code === 'gone' || e.code === 'auth') return false; throw e; }
    },
    async remove(acct) {
      try { await authed(acct, 'DELETE', '/accounts/' + encodeURIComponent(acct.accountId)); } catch (e) { if (e.code !== 'gone') throw e; }
    },
  };
}

// ---------- alias services ----------
function simpleLogin({ base = 'https://app.simplelogin.io', key }) {
  const h = { Authentication: key };
  return {
    id: 'simplelogin', name: 'SimpleLogin',
    async verify() { const r = await call(base, 'GET', '/api/user_info', { headers: h }); return { account: r && r.email ? String(r.email) : '' }; },
    async create(site, host) {
      const r = await call(base, 'POST', '/api/alias/random/new' + (host ? '?hostname=' + encodeURIComponent(host) : ''), { headers: h, body: { note: site } });
      return { aliasId: String(r.id), address: String(r.email), enabled: r.enabled !== false };
    },
    async setEnabled(a, on) {
      const cur = await call(base, 'GET', '/api/aliases/' + encodeURIComponent(a.aliasId), { headers: h });
      if (!!cur.enabled === !!on) return !!on;
      const r = await call(base, 'POST', `/api/aliases/${encodeURIComponent(a.aliasId)}/toggle`, { headers: h });
      return !!r.enabled;
    },
    async remove(a) { try { await call(base, 'DELETE', '/api/aliases/' + encodeURIComponent(a.aliasId), { headers: h }); } catch (e) { if (e.code !== 'gone') throw e; } },
  };
}

function addy({ base = 'https://app.addy.io', key }) {
  const h = { Authorization: 'Bearer ' + key, 'X-Requested-With': 'XMLHttpRequest' };
  return {
    id: 'addy', name: 'addy.io',
    async verify() { const r = await call(base, 'GET', '/api/v1/account-details', { headers: h }); return { account: r && r.data && r.data.username ? String(r.data.username) : '' }; },
    async create(site) {
      const opt = await call(base, 'GET', '/api/v1/domain-options', { headers: h });
      const domain = (opt && (opt.defaultAliasDomain || (opt.data || [])[0])) || null;
      if (!domain) throw new ServiceError('failed', 0, 'no domain');
      const r = await call(base, 'POST', '/api/v1/aliases', { headers: h, body: { domain, description: site, format: 'random_characters' } });
      return { aliasId: String(r.data.id), address: String(r.data.email), enabled: r.data.active !== false };
    },
    async setEnabled(a, on) {
      if (on) await call(base, 'POST', '/api/v1/active-aliases', { headers: h, body: { id: a.aliasId } });
      else await call(base, 'DELETE', '/api/v1/active-aliases/' + encodeURIComponent(a.aliasId), { headers: h });
      return !!on;
    },
    async remove(a) { try { await call(base, 'DELETE', '/api/v1/aliases/' + encodeURIComponent(a.aliasId), { headers: h }); } catch (e) { if (e.code !== 'gone') throw e; } },
  };
}

function relay({ base = 'https://relay.firefox.com', key }) {
  const h = { Authorization: 'Token ' + key };
  return {
    id: 'relay', name: 'Firefox Relay',
    async verify() { await call(base, 'GET', '/api/v1/relayaddresses/', { headers: h }); return { account: '' }; },
    async create(site, host) {
      const r = await call(base, 'POST', '/api/v1/relayaddresses/', { headers: h, body: { enabled: true, description: site, generated_for: host || '' } });
      return { aliasId: String(r.id), address: String(r.full_address), enabled: r.enabled !== false };
    },
    async setEnabled(a, on) {
      const r = await call(base, 'PATCH', `/api/v1/relayaddresses/${encodeURIComponent(a.aliasId)}/`, { headers: h, body: { enabled: !!on } });
      return r ? !!r.enabled : !!on;
    },
    async remove(a) { try { await call(base, 'DELETE', `/api/v1/relayaddresses/${encodeURIComponent(a.aliasId)}/`, { headers: h }); } catch (e) { if (e.code !== 'gone') throw e; } },
  };
}

const ALIAS_SERVICES = { simplelogin: simpleLogin, addy, relay };

module.exports = { call, ServiceError, mailTm, ALIAS_SERVICES, slug, rand };
