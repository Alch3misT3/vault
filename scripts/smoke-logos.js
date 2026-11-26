'use strict';
// Smoke test, part 3: site logos. Every "website" here is a local test server (one per domain),
// so the test never touches the internet. Covers: icon discovery, size limits, SVG scripts never
// running, redirects, timeouts, colours, the encrypted cache, weekly refresh and the on/off setting.

const http = require('http');
const zlib = require('zlib');
const fs = require('fs');

// ---- tiny PNG / ICO encoder for the test icons ----
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
function png(n, paint) {
  const raw = Buffer.alloc((n * 4 + 1) * n);
  for (let y = 0; y < n; y++) { raw[y * (n * 4 + 1)] = 0; for (let x = 0; x < n; x++) { const p = paint(x / n, y / n); raw.set(p, y * (n * 4 + 1) + 1 + x * 4); } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function ico(n, paint) {
  const p = png(n, paint);
  const h = Buffer.alloc(22); h.writeUInt16LE(0, 0); h.writeUInt16LE(1, 2); h.writeUInt16LE(1, 4);
  h[6] = n >= 256 ? 0 : n; h[7] = n >= 256 ? 0 : n; h.writeUInt16LE(1, 10); h.writeUInt16LE(32, 12); h.writeUInt32LE(p.length, 14); h.writeUInt32LE(22, 18);
  return Buffer.concat([h, p]);
}
const rgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), 255];
const CLEAR = [0, 0, 0, 0];
const disc = (fg, bg = CLEAR, r = 0.42) => (x, y) => ((x - 0.5) ** 2 + (y - 0.5) ** 2 < r * r ? rgb(fg) : bg);
const square = (bg, fg, inner = 0.26) => (x, y) => (Math.abs(x - 0.5) < inner && Math.abs(y - 0.5) < inner ? rgb(fg) : rgb(bg));

module.exports = async function logos({ app, win, js, wait, waitFor, relock, shot, check, getLogos, getQuick, showQuick, nativeTheme, MASTER }) {
  const L = getLogos();
  const log = []; // every request the "websites" received
  const servers = [];
  const ports = {};
  let pwnedPort = 0;
  const site = (name, routes) => new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      log.push({ site: name, path: req.url, cookie: req.headers.cookie || '', referer: req.headers.referer || '', ua: req.headers['user-agent'] || '' });
      const r = routes[req.url.split('?')[0]];
      if (r === 'hang') return; // never answers
      if (!r) { res.writeHead(404); return res.end('not found'); }
      if (r.redirect) { res.writeHead(302, { Location: r.redirect }); return res.end(); }
      res.writeHead(200, { 'Content-Type': r.type });
      res.end(r.body);
    });
    s.listen(0, '127.0.0.1', () => { servers.push(s); ports[name] = s.address().port; resolve(); });
  });
  const html = (head) => ({ type: 'text/html; charset=utf-8', body: `<!doctype html><html><head><title>t</title>${head}</head><body>hi</body></html>` });
  const pngR = (n, p) => ({ type: 'image/png', body: png(n, p) });
  const icoR = (n, p) => ({ type: 'image/x-icon', body: ico(n, p) });

  await site('pwned', {});
  pwnedPort = ports.pwned;
  const evilSvg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 64 64" onload="fetch('http://127.0.0.1:${pwnedPort}/onload')">
    <script>fetch('http://127.0.0.1:${pwnedPort}/script'); document.title = 'pwned';</script>
    <image href="http://127.0.0.1:${pwnedPort}/image.png" width="64" height="64"/>
    <circle cx="32" cy="32" r="28" fill="#5865f2"/><rect x="20" y="24" width="24" height="14" rx="6" fill="#ffffff"/></svg>`;
  await site('github.com', {
    '/': html('<link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="apple-touch-icon" href="/apple-touch-icon.png">'),
    '/apple-touch-icon.png': pngR(180, disc('#ffffff', rgb('#24292f'), 0.33)),
    '/favicon.svg': { type: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#000"/></svg>' },
  });
  await site('discord.com', { '/': html('<link rel="icon" href="/assets/icon.svg">'), '/assets/icon.svg': { type: 'image/svg+xml', body: evilSvg } });
  await site('netflix.com', {
    '/': html('<link rel="manifest" href="/manifest.json">'),
    '/manifest.json': { type: 'application/json', body: JSON.stringify({ icons: [{ src: '/icon-512-maskable.png', sizes: '512x512', purpose: 'maskable' }, { src: '/icon-192.png', sizes: '192x192', type: 'image/png' }] }) },
    '/icon-192.png': pngR(192, square('#000000', '#e50914', 0.3)),
    '/icon-512-maskable.png': pngR(64, square('#00ff00', '#00ff00')),
  });
  await site('abv.bg', { '/': html(''), '/favicon.ico': icoR(64, square('#2e9a3e', '#ffffff', 0.18)) });
  await site('paypal.com', { '/': html(''), '/favicon.ico': icoR(16, disc('#003087')) });
  await site('google.com', {
    '/': html('<link rel="icon" sizes="192x192" href="/huge.png">'),
    '/huge.png': { type: 'image/png', body: Buffer.concat([png(8, disc('#ff0000')), Buffer.alloc(2 * 1024 * 1024)]) },
    '/favicon.ico': icoR(48, disc('#4285f4')),
  });
  ports['accounts.google.com'] = ports['google.com'];
  await site('cloudflare.com', { '/': { redirect: '/home/' }, '/home/': html('<link rel="shortcut icon" href="icon.png">'), '/home/icon.png': pngR(64, disc('#f38020')) });
  await site('supabase.com', { '/': { redirect: 'http://example.invalid/' } });
  await site('twitch.tv', { '/': 'hang', '/favicon.ico': 'hang' });
  await site('_none', {});

  const T = L._test;
  T.timeout = 1500;
  T.base = (d) => `http://127.0.0.1:${ports[d] || ports._none}/`;

  // an account for ABV (green and white logo)
  await js("handleCommand('new')");
  await waitFor("!!document.getElementById('f-title')");
  await js(`(() => { const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input')); }; set('f-title', 'ABV'); set('f-user', 'me@abv.bg'); set('f-web', 'abv.bg'); })()`);
  await js('saveEdit()');
  await waitFor("state.mode === 'view'");
  await js("setView('all'); requestLogos(); true");

  const tileOf = (title) => `(() => { const r = [...document.querySelectorAll('#list .row')].find((x) => x.querySelector('.row-title').textContent.startsWith(${JSON.stringify(title)})); return r && r.querySelector('.tile'); })()`;
  const isLogo = (title) => `(${tileOf(title)} || { classList: { contains: () => false } }).classList.contains('logo')`;
  const withLogos = ['GitHub', 'Discord', 'Netflix', 'Google', 'Cloudflare', 'ABV'];
  const got = await waitFor(`[${withLogos.map((t) => JSON.stringify(t)).join(',')}].every((t) => ${isLogo('X').replace('"X"', 't')})`, 20000);
  check('real logos replace the letter tiles (icon link, apple-touch-icon, manifest, favicon.ico, redirect)', got, JSON.stringify(await js(`[${withLogos.map((t) => JSON.stringify(t)).join(',')}].map((t) => t + ':' + ${isLogo('X').replace('"X"', 't')})`)));
  await wait(2500); // let the slow/broken ones time out
  const rec = (d) => L._cache() && L._cache().get({ 'google.com': 'accounts.google.com', 'cloudflare.com': 'dash.cloudflare.com' }[d] || d);
  check('the largest good icon is picked (apple-touch-icon 180 px over a tiny SVG)', rec('github.com') && rec('github.com').size === 180 && log.some((r) => r.site === 'github.com' && r.path === '/apple-touch-icon.png'), JSON.stringify({ size: rec('github.com') && rec('github.com').size }));
  check('web app manifest icons are used (192 px, not the padded "maskable" one)', rec('netflix.com') && rec('netflix.com').size === 192 && !log.some((r) => r.path === '/icon-512-maskable.png'));
  check('a subdomain without an icon falls back to the main site (dash.cloudflare.com → cloudflare.com, after a redirect)', rec('cloudflare.com') && !!rec('cloudflare.com').src && log.some((r) => r.site === '_none') && log.some((r) => r.site === 'cloudflare.com' && r.path === '/home/icon.png'));
  check('oversized icons are refused (2 MB), the next one is used', rec('google.com') && rec('google.com').size === 48 && log.some((r) => r.path === '/huge.png'));
  const pwned = log.filter((r) => r.site === 'pwned');
  check('SVG logos are drawn as a plain image: their scripts and links never run', rec('discord.com') && rec('discord.com').src && !pwned.length && /^data:image\/png;base64,/.test(rec('discord.com').src), JSON.stringify(pwned));
  const near = (hex, target, tol = 40) => { const a = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)); const b = [1, 3, 5].map((i) => parseInt(target.slice(i, i + 2), 16)); return a.every((v, i) => Math.abs(v - b[i]) <= tol); };
  check('the logo’s main colour is found (ABV green, Discord blurple, Netflix red)', near(rec('abv.bg').color, '#2e9a3e') && near(rec('discord.com').color, '#5865f2') && near(rec('netflix.com').color, '#e50914'), [rec('abv.bg').color, rec('discord.com').color, rec('netflix.com').color].join(' '));
  check('full-bleed icons keep their own background, transparent ones sit on white', near(rec('github.com').bg, '#24292f', 12) && rec('discord.com').bg === '#ffffff', rec('github.com').bg + ' ' + rec('discord.com').bg);
  const pp = await js(`(() => { const t = ${tileOf('PayPal')}; return { logo: t.classList.contains('logo'), tile: t.style.getPropertyValue('--tile') }; })()`);
  check('too small to show (16 px): letter tile in the site’s real colour', !pp.logo && near(pp.tile, '#003087', 30), JSON.stringify(pp));
  const tw = await js(`(() => { const t = ${tileOf('Twitch')}; return { logo: t.classList.contains('logo'), tile: t.style.getPropertyValue('--tile') }; })()`);
  const sb = await js(`(() => { const t = ${tileOf('Supabase')}; return { logo: t.classList.contains('logo'), tile: t.style.getPropertyValue('--tile') }; })()`);
  check('offline/slow site and a redirect to plain http: letter tile in brand colour', !tw.logo && tw.tile === '#8a43f5' && !sb.logo && sb.tile === '#23a06b', JSON.stringify([tw, sb]));
  check('only the site itself is asked, with no cookies, no referrer, no account data', log.length > 0 && log.every((r) => !r.cookie && !r.referer && !/@|example\.com|dev-user|family/.test(r.path) && !/Electron|Vault/i.test(r.ua)), JSON.stringify(log.filter((r) => r.cookie || r.referer || /@/.test(r.path))));

  // the colour field behind the opened account follows the logo
  await js(`select(window.__vaultState.items.find((i) => i.title === 'ABV').id)`);
  await wait(1200);
  const tint = await js("(() => { const b = [...document.querySelectorAll('.backdrop .b1')].find((x) => !x.classList.contains('off')); return getComputedStyle(b).backgroundColor; })()");
  const [tr, tg, tb] = tint.match(/\d+/g).map(Number);
  check('opening ABV tints the background green, from its real logo', tg > tr + 40 && tg > tb + 20, tint);
  check('the header shows the logo too', await js("document.querySelector('.hero .tile').classList.contains('logo')"));
  await shot('28-logos-light');
  await js(`select(window.__vaultState.items.find((i) => i.title === 'Google').id)`);
  await wait(900);
  const hero = await js("(() => { const t = document.querySelector('.hero .tile'); const r = t.getBoundingClientRect(); const i = t.querySelector('img').getBoundingClientRect(); return { cls: t.className, w: r.width, h: r.height, img: Math.round(i.width) }; })()");
  check('small icons sit inset in a normal-size tile (header stays 72 px)', /inset/.test(hero.cls) && hero.w === 72 && hero.h === 72 && hero.img > 30 && hero.img < 72, JSON.stringify(hero));
  await js(`select(window.__vaultState.items.find((i) => i.title === 'GitHub').id)`);
  nativeTheme.themeSource = 'dark';
  await wait(900);
  await shot('29-logos-dark');
  nativeTheme.themeSource = 'light';

  // stored encrypted with the vault
  const box = JSON.parse(fs.readFileSync(L.file(), 'utf8'));
  const sealed = Buffer.from(box.data, 'base64');
  check('the logo cache is encrypted (no site names, no images readable)', box.app === 'vault-logos' && Object.keys(box).sort().join() === 'app,data,iv,tag' && !/github|discord|abv.bg|netflix|iVBOR|data:image|PNG/.test(sealed.toString('latin1')) && sealed.length > 1000);

  // lock + unlock: shown again straight from the encrypted cache, no network
  const before = log.length;
  await relock();
  check('locking drops the logos from memory', !L._cache());
  await js(`(() => { const el = document.getElementById('pw1'); el.value = ${JSON.stringify(MASTER)}; el.dispatchEvent(new Event('input')); document.getElementById('unlockGo').click(); })()`);
  await waitFor("!document.getElementById('app').hidden");
  check('after unlocking, logos come from the encrypted cache without asking the sites again', (await waitFor(isLogo('GitHub'), 4000)) && log.length === before, `${log.length - before} new requests`);

  // weekly refresh
  rec('github.com').at = Date.now() - 8 * 24 * 3600 * 1000;
  const n0 = log.filter((r) => r.site === 'github.com').length;
  await js('requestLogos(); true');
  await wait(1500);
  check('logos older than a week are refreshed in the background', log.filter((r) => r.site === 'github.com').length > n0 && Date.now() - rec('github.com').at < 60000);

  // quick search shows them too
  showQuick();
  const qOk = await (async () => { for (let i = 0; i < 60; i++) { try { if (await getQuick().webContents.executeJavaScript("[...document.querySelectorAll('.q-row')].some((r) => /GitHub/.test(r.textContent) && r.querySelector('.tile.logo img'))")) return true; } catch {} await wait(100); } return false; })();
  check('quick search shows the logos', qOk);
  getQuick().hide();

  // the setting
  await js('setLogos(false)');
  await wait(300);
  const nOff = log.length;
  await js('requestLogos(); true');
  await wait(800);
  check('"Download Site Logos" off: letter tiles only, cache deleted, nothing fetched', !(await js("!!document.querySelector('#app .tile.logo')")) && !fs.existsSync(L.file()) && log.length === nOff && (await js('window.vault ? true : true')));
  check('… and the setting shows unchecked in the ••• menu', (await js("window.vault.appPrefs().then((p) => p.logos)")) === false);
  await js('setLogos(true)');
  check('switched back on, the logos return', await waitFor(isLogo('GitHub'), 8000));
  await wait(800);

  // a new master password re-encrypts the cache
  for (let i = 0; i < 80 && L._busy(); i++) await wait(100);
  const NEW = 'another horse battery';
  const cp = await js(`window.vault.changePassword(${JSON.stringify(MASTER)}, ${JSON.stringify(NEW)}, window.__vaultState.items)`);
  await relock();
  const nCp = log.length;
  await js(`(() => { const el = document.getElementById('pw1'); el.value = ${JSON.stringify(NEW)}; el.dispatchEvent(new Event('input')); document.getElementById('unlockGo').click(); })()`);
  await waitFor("!document.getElementById('app').hidden");
  check('after changing the master password the logos still open from the cache', cp.ok && (await waitFor(isLogo('GitHub'), 4000)) && log.length === nCp, JSON.stringify(log.slice(nCp)));
  await js(`window.vault.changePassword(${JSON.stringify(NEW)}, ${JSON.stringify(MASTER)}, window.__vaultState.items)`);

  // remove the ABV test account again so the rest of the run sees the usual 11
  await js(`(async () => { window.__vaultState.items = window.__vaultState.items.filter((i) => i.title !== 'ABV'); await persist(); render(); })()`);
  T.base = null;
  for (const s of servers) { try { s.closeAllConnections(); s.close(); } catch {} }
};
