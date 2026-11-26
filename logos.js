'use strict';
// Site logos for the account tiles.
// - Fetched from each site ITSELF (its <link rel="icon">, apple-touch-icon, web app manifest, /favicon.ico),
//   never from a third-party icon service, so nobody else learns which sites the vault has accounts on.
// - Only the domain is requested: no cookies (Node's fetch has no cookie jar), no account data, https only,
//   timeouts and size limits.
// - Every image is re-drawn in an isolated hidden window into a plain PNG. SVGs are drawn as images there,
//   where scripts and external resources never run.
// - Kept on disk encrypted with a key derived from the vault key (the list of icons would reveal the sites),
//   refreshed in the background about once a week.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { session } = require('electron');
const security = require('./security');

const WEEK = 7 * 24 * 3600 * 1000;
const RETRY_FAILED = 24 * 3600 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const LIMITS = { html: 512 * 1024, manifest: 128 * 1024, image: 1024 * 1024 };
const OUT = 144; // stored logo size in pixels (sharp at 72 px on a 2x screen)

module.exports = function createLogos({ app, BrowserWindow, handle, getKey, prefs, setPref, send, log, smoke, links }) {
  const file = () => path.join(app.getPath('userData'), 'logos.vault');
  const t = { base: null, timeout: 8000, now: () => Date.now() }; // test hooks (smoke test only)
  let cache = null;          // Map domain -> record, while unlocked
  let gen = 0;               // bumps on lock/disable so late results are dropped
  const queue = [];
  const queued = new Set();
  let running = 0;

  const enabled = () => prefs().logos !== false;
  const keyFor = (k) => Buffer.from(crypto.hkdfSync('sha256', k, Buffer.alloc(0), 'vault-logos-v1', 32));

  // ---------- encrypted cache ----------
  function load(k = getKey()) {
    if (cache) return cache;
    cache = new Map();
    if (!k) return cache;
    try {
      const box = JSON.parse(fs.readFileSync(file(), 'utf8'));
      const d = crypto.createDecipheriv('aes-256-gcm', keyFor(k), Buffer.from(box.iv, 'base64'));
      d.setAuthTag(Buffer.from(box.tag, 'base64'));
      const json = Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8');
      for (const [dom, rec] of Object.entries(JSON.parse(json).items || {})) cache.set(dom, rec);
    } catch { /* none yet, or made with an older master password: start over */ }
    return cache;
  }
  let saveTimer = null;
  function save(now) {
    clearTimeout(saveTimer);
    const write = () => {
      const k = getKey();
      if (!k || !cache) return;
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', keyFor(k), iv);
      const data = Buffer.concat([c.update(JSON.stringify({ items: Object.fromEntries(cache) }), 'utf8'), c.final()]);
      const tmp = file() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ app: 'vault-logos', iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }), { mode: 0o600 });
      fs.renameSync(tmp, file());
    };
    if (now) write(); else saveTimer = setTimeout(() => { try { write(); } catch (e) { log('save failed: ' + e.message); } }, 600);
  }

  // ---------- network ----------
  const okScheme = (u) => u.protocol === 'https:' || (smoke && u.protocol === 'http:' && u.hostname === '127.0.0.1');
  // partial: for web pages, read only the first part (the <head> with the icon links) instead of failing on big pages
  async function get(url, max, accept, partial) {
    let u = new URL(url);
    for (let hop = 0; hop < 5; hop++) {
      if (!okScheme(u)) throw new Error('not https');
      const res = await fetch(u, {
        redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer',
        headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en' },
        signal: AbortSignal.timeout(t.timeout),
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        try { await res.body?.cancel(); } catch {}
        u = new URL(res.headers.get('location'), u);
        continue;
      }
      if (!res.ok) { try { await res.body?.cancel(); } catch {} throw new Error('HTTP ' + res.status); }
      const len = +res.headers.get('content-length');
      if (len > max && !partial) { try { await res.body?.cancel(); } catch {} throw new Error('too large'); }
      const reader = res.body.getReader();
      const parts = []; let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > max) { try { await reader.cancel(); } catch {} if (!partial) throw new Error('too large'); break; }
        parts.push(value);
        if (partial && /<\/head>|<body[\s>]/i.test(Buffer.from(value).toString('latin1'))) { try { await reader.cancel(); } catch {} break; }
      }
      return { url: u, type: (res.headers.get('content-type') || '').toLowerCase(), body: Buffer.concat(parts.map((p) => Buffer.from(p))) };
    }
    throw new Error('too many redirects');
  }

  // <link rel="…icon…" href sizes type> from the page's markup (attributes only; nothing is executed).
  function linkTags(html) {
    const head = html.slice(0, 200000);
    const out = [];
    for (const m of head.matchAll(/<link\b([^>]*)>/gi)) {
      const attrs = {};
      for (const a of m[1].matchAll(/([a-zA-Z:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) attrs[a[1].toLowerCase()] = (a[3] ?? a[4] ?? a[5] ?? '').trim();
      out.push(attrs);
    }
    return out;
  }
  const decodeEntities = (s) => s.replace(/&amp;/g, '&').replace(/&#x2f;/gi, '/').replace(/&#47;/g, '/');
  const sizeOf = (sizes) => {
    if (!sizes) return 0;
    if (/any/i.test(sizes)) return 512;
    return Math.max(0, ...String(sizes).split(/\s+/).map((s) => parseInt(s, 10) || 0));
  };

  async function candidates(domain) {
    const start = t.base ? t.base(domain) : `https://${domain}/`;
    const list = [];
    let pageUrl = new URL(start);
    try {
      const page = await get(start, LIMITS.html, 'text/html,application/xhtml+xml', true);
      pageUrl = page.url;
      let base = pageUrl;
      const html = page.body.toString('utf8');
      const bm = html.match(/<base\b[^>]*href\s*=\s*["']([^"']+)["']/i);
      if (bm) { try { base = new URL(decodeEntities(bm[1]), pageUrl); } catch {} }
      let manifest = null;
      for (const a of linkTags(html)) {
        const rel = (a.rel || '').toLowerCase().split(/\s+/);
        if (!a.href) continue;
        let href; try { href = new URL(decodeEntities(a.href), base); } catch { continue; }
        if (rel.includes('manifest')) { manifest = manifest || href; continue; }
        if (rel.includes('mask-icon')) continue; // single-colour outline, not the logo
        if (!rel.some((r) => r === 'icon' || r.startsWith('apple-touch-icon') || r === 'fluid-icon')) continue;
        const svg = /svg/i.test(a.type || '') || /\.svg(\?|$)/i.test(href.pathname);
        const apple = rel.some((r) => r.startsWith('apple-touch-icon'));
        list.push({ url: href, size: sizeOf(a.sizes) || (svg ? 512 : apple ? 180 : 0), svg, apple });
      }
      if (manifest) {
        try {
          const mf = await get(manifest.href, LIMITS.manifest, 'application/manifest+json,application/json');
          const j = JSON.parse(mf.body.toString('utf8'));
          for (const ic of Array.isArray(j.icons) ? j.icons : []) {
            if (!ic || !ic.src || /monochrome/i.test(ic.purpose || '')) continue;
            let href; try { href = new URL(ic.src, mf.url); } catch { continue; }
            const svg = /svg/i.test(ic.type || '') || /\.svg(\?|$)/i.test(href.pathname);
            list.push({ url: href, size: sizeOf(ic.sizes) || (svg ? 512 : 0), svg, maskable: /maskable/i.test(ic.purpose || '') && !/any/i.test(ic.purpose || '') });
          }
        } catch (e) { /* no usable manifest */ }
      }
    } catch (e) { /* the page itself failed: /favicon.ico may still work */ }
    list.push({ url: new URL('/favicon.ico', pageUrl), size: 0, ico: true });
    if (pageUrl.origin !== new URL(start).origin) list.push({ url: new URL('/favicon.ico', start), size: 0, ico: true });
    // Best first: big enough but not huge, full-colour; known sizes before guesses.
    const score = (c) => {
      const s = c.size || (c.ico ? 32 : 48);
      let v = s >= 64 ? 1000 - Math.abs(Math.min(s, 512) - 192) : s * 10;
      if (c.apple) v += 30;
      if (c.maskable) v -= 300; // padded for launchers
      if (c.svg) v += 20;
      return v;
    };
    const seen = new Set();
    return list.filter((c) => !seen.has(c.url.href) && seen.add(c.url.href)).sort((a, b) => score(b) - score(a)).slice(0, 8);
  }

  // ---------- decoding: an isolated hidden window turns any image into a plain PNG ----------
  let decoder = null; let decoderReady = null; let idleTimer = null; let nextId = 1;
  const pending = new Map();
  function decoderWin() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (decoder && !decoder.isDestroyed()) decoder.destroy(); decoder = null; decoderReady = null; }, 30000);
    if (decoder && !decoder.isDestroyed()) return decoderReady;
    // Its own in-memory session: no cookies, no cache shared with anything, and no network at all
    // (only Vault's own decoder page is served; its CSP also blocks everything else).
    const ses = security.serveApp(session.fromPartition('vault-logo-decoder'));
    decoder = new BrowserWindow({
      show: false, width: 200, height: 200,
      webPreferences: security.webPrefs({ preload: path.join(__dirname, 'preload-logo.js'), session: ses, devTools: false, backgroundThrottling: false }),
    });
    decoderReady = decoder.loadURL(security.pageUrl('logo-decoder.html')).then(() => decoder);
    return decoderReady;
  }
  security.makeGuard({ 'logo-decoder.html': () => decoder }).on('logo-decoder.html', 'logo:decoded', (e, id, result) => {
    const p = pending.get(id);
    if (p) { pending.delete(id); p(result); }
  });
  async function decode(bytes, mime) {
    const w = await decoderWin();
    const id = nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { pending.delete(id); resolve(null); }, 5000);
      pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
      w.webContents.send('logo:decode', id, new Uint8Array(bytes), mime, OUT);
    });
  }

  const sniff = (b, type, c) => {
    if (b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
    if (b.slice(0, 4).equals(Buffer.from([0, 0, 1, 0]))) return 'image/x-icon';
    if (b.slice(0, 4).toString() === 'GIF8') return 'image/gif';
    if (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') return 'image/webp';
    if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
    const head = b.slice(0, 1000).toString('utf8');
    if (/<svg[\s>]/i.test(head) || c.svg || /svg/.test(type)) return /<svg[\s>]/i.test(b.toString('utf8')) ? 'image/svg+xml' : null;
    return null;
  };

  // dash.cloudflare.com -> cloudflare.com, accounts.google.com -> google.com (keeps e.g. "example.co.uk" whole)
  function parentOf(d) {
    const p = d.split('.');
    const min = p.length > 2 && p[p.length - 1].length === 2 && p[p.length - 2].length <= 3 ? 3 : 2;
    return p.length > min ? p.slice(1).join('.') : null;
  }
  // A subdomain without a usable icon falls back to the site's main domain (still the site itself).
  async function fetchLogo(domain) {
    const r = await fetchFrom(domain);
    if (r.src) return r;
    const parent = parentOf(domain);
    if (!parent) return r;
    const r2 = await fetchFrom(parent);
    return r2.src || (!r.color && r2.color) ? r2 : r;
  }
  async function fetchFrom(domain) {
    let colorOnly = null;
    for (const c of await candidates(domain)) {
      try {
        let bytes; let type = '';
        if (c.url.protocol === 'data:') {
          const m = c.url.href.match(/^data:([^;,]*)(;base64)?,(.*)$/s);
          if (!m) continue;
          bytes = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
          type = m[1];
          if (bytes.length > LIMITS.image) continue;
        } else {
          const r = await get(c.url.href, LIMITS.image, 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8');
          bytes = r.body; type = r.type;
        }
        const mime = sniff(bytes, type, c);
        if (!mime) continue;
        const d = await decode(bytes, mime);
        if (!d || !d.png) continue;
        const natural = mime === 'image/svg+xml' ? 512 : Math.min(d.w, d.h);
        if (natural >= 32) return { src: d.png, color: d.color, bg: d.bg, size: natural };
        if (!colorOnly && d.color) colorOnly = { src: null, color: d.color, bg: null, size: natural };
      } catch { /* try the next one */ }
    }
    return colorOnly || { src: null, color: null, fail: true };
  }

  // ---------- queue ----------
  function pump() {
    while (running < 3 && queue.length) {
      const domain = queue.shift();
      const g = gen;
      running++;
      fetchLogo(domain).catch(() => ({ src: null, color: null, fail: true })).then((rec) => {
        running--;
        queued.delete(domain);
        if (g !== gen || !cache || !enabled()) return pump();
        const old = cache.get(domain);
        // offline or broken today: keep last week's logo rather than losing it
        const keep = rec.fail && old && (old.src || old.color);
        const next = keep ? { ...old, at: t.now() } : { ...rec, at: t.now() };
        cache.set(domain, next);
        save();
        const same = (x, y) => !!x && !!y && JSON.stringify({ ...x, at: 0 }) === JSON.stringify({ ...y, at: 0 });
        if (!same(old, next)) send('logos', { [domain]: next.fail ? null : next });
        pump();
      });
    }
  }
  const validDomain = (d) => typeof d === 'string' && d.length < 254 && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(d) && !/^\d+(\.\d+)+$/.test(d);

  handle('logos:get', (e, domains) => {
    if (!getKey()) return null;
    if (!enabled()) return { on: false, map: {} };
    load();
    const map = {};
    for (const d of Array.isArray(domains) ? domains.slice(0, 5000) : []) {
      if (!validDomain(d)) continue;
      const rec = cache.get(d);
      if (rec && !rec.fail) map[d] = rec;
      const stale = !rec || t.now() - (rec.at || 0) > (rec.fail ? RETRY_FAILED : WEEK);
      if (stale && !queued.has(d) && (!smoke || t.base)) { queued.add(d); queue.push(d); }
    }
    pump();
    return { on: true, map };
  });

  return {
    lock() { save(true); gen++; cache = null; queue.length = 0; queued.clear(); clearTimeout(saveTimer); },
    // master password changed: re-encrypt the cache with the new key
    rekey(oldKey) { if (!cache) load(oldKey); save(true); },
    setEnabled(on) {
      setPref('logos', !!on);
      if (!on) {
        gen++; queue.length = 0; queued.clear(); clearTimeout(saveTimer);
        cache = getKey() ? new Map() : null;
        try { fs.rmSync(file(), { force: true }); } catch {}
      }
    },
    // the vault was replaced by a backup: its logos came from a different key
    reset() { gen++; cache = null; queue.length = 0; queued.clear(); try { fs.rmSync(file(), { force: true }); } catch {} },
    // the cached logo for an account (for the quick-search panel), if logos are on
    peek(item) {
      if (!enabled() || !getKey()) return null;
      const l = links.loginLink(item);
      const rec = l && load().get(l.host);
      return rec && !rec.fail ? { src: rec.src, color: rec.color, bg: rec.bg, size: rec.size } : null;
    },
    file, _test: t, _cache: () => cache, _busy: () => running + queue.length,
  };
};
