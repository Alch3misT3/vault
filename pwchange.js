'use strict';
// Password changes and the breach check (main process only; every request has a timeout).
//
// - Change page: Vault first asks the site itself whether it supports the W3C "well-known URL for
//   changing passwords" (/.well-known/change-password). Sites that answer 200 to any address can't be
//   trusted on that, so a made-up address is tried first (the spec's status-code reliability test).
//   Then a hand-checked list of direct links (src/links.js), then the site's home page.
//   Only the site's own address is requested: no cookies, no account data.
// - Breach check (off unless turned on): Have I Been Pwned's Pwned Passwords range API with
//   k-anonymity. Only the first 5 characters of each password's SHA-1 hash leave this PC, and the
//   Add-Padding header makes every answer 800-1,000 lines long, so its size gives nothing away.

const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const NOT_THERE = '/.well-known/resource-that-should-not-exist-whose-status-code-should-not-be-200';
const RECHECK_MS = 7 * 24 * 3600 * 1000; // a password's breach count is looked up again after a week

module.exports = function createPwChange({ links }) {
  // test hooks (smoke test only): base(host) points a site at a local test server
  const t = { base: null, timeout: 6000, hibp: 'https://api.pwnedpasswords.com', requests: [] };

  async function get(url) {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(t.timeout), headers: { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8' } });
    try { if (res.body) await res.body.cancel(); } catch {}
    return res;
  }

  async function supportsWellKnown(site) {
    const base = t.base ? t.base(site.host) : site.origin;
    try {
      if ((await get(base + NOT_THERE)).ok) return false; // answers "OK" to anything: can't tell
      return (await get(base + '/.well-known/change-password')).ok;
    } catch { return false; }
  }

  // { url, how: 'standard' | 'known' | 'home' } for an account, or null if it has no website.
  async function changePage(item) {
    const site = links.siteOfItem(item);
    if (!site) return null;
    if (await supportsWellKnown(site)) return { url: site.origin + '/.well-known/change-password', how: 'standard' };
    const known = links.changePasswordPage(site.host);
    if (known) return { url: known, how: 'known' };
    return { url: site.origin + '/', how: 'home' };
  }

  // ---- breach check ----
  const sha1 = (s) => crypto.createHash('sha1').update(String(s), 'utf8').digest('hex').toUpperCase();

  async function range(prefix) {
    t.requests.push(prefix);
    const res = await fetch(`${t.hibp}/range/${prefix}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'Vault-password-manager' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = (await res.text()).slice(0, 2 * 1024 * 1024);
    const out = new Map();
    for (const line of text.split(/\r?\n/)) {
      const m = /^([0-9A-F]{35}):(\d+)\s*$/i.exec(line);
      if (m && +m[2] > 0) out.set(m[1].toUpperCase(), +m[2]); // padding lines have a count of 0
    }
    return out;
  }

  // items: the vault's accounts. cache: { [sha1]: { n, at } } kept inside the encrypted vault.
  // Returns { counts: { itemId: n }, cache, failed }.
  async function breachCheck(items, cache = {}, now = Date.now()) {
    const byHash = new Map();
    for (const it of items) {
      if (!it || it.deletedAt || !it.password) continue;
      const hh = sha1(it.password);
      byHash.set(hh, [...(byHash.get(hh) || []), it.id]);
    }
    const next = {};
    const todo = new Map(); // prefix -> [hash]
    for (const hh of byHash.keys()) {
      const c = cache[hh];
      if (c && now - c.at < RECHECK_MS) next[hh] = c;
      else todo.set(hh.slice(0, 5), [...(todo.get(hh.slice(0, 5)) || []), hh]);
    }
    let failed = 0;
    const prefixes = [...todo.keys()];
    const worker = async () => {
      while (prefixes.length) {
        const p = prefixes.shift();
        try {
          const r = await range(p);
          for (const hh of todo.get(p)) next[hh] = { n: r.get(hh.slice(5)) || 0, at: now };
        } catch { failed++; for (const hh of todo.get(p)) if (cache[hh]) next[hh] = cache[hh]; }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    const counts = {};
    for (const [hh, ids] of byHash) if (next[hh] && next[hh].n > 0) for (const id of ids) counts[id] = next[hh].n;
    return { counts, cache: next, failed };
  }

  return { changePage, breachCheck, _test: t };
};
