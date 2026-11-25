'use strict';
// Dev check (not part of the smoke test): a throw-away vault with real accounts, logos fetched from the real sites.
// Run: VAULT_REAL_LOGOS=1 npx electron . --smoke
const fs = require('fs');
const path = require('path');
module.exports = async function ({ win, nativeTheme, getLogos }) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (c) => win.webContents.executeJavaScript(c);
  const shots = path.join(__dirname, '..', 'smoke-shots');
  fs.mkdirSync(shots, { recursive: true });
  const shot = async (n) => { await wait(400); fs.writeFileSync(path.join(shots, n + '.png'), (await win.webContents.capturePage()).toPNG()); };
  await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', r) : r()));
  win.setBounds({ x: 40, y: 40, width: 1080, height: 720 }); win.showInactive(); nativeTheme.themeSource = 'light';
  await wait(800);
  await js(`(() => { for (const id of ['pw1','pw2']) { const el = document.getElementById(id); el.value = 'real logos test'; el.dispatchEvent(new Event('input')); } document.getElementById('createGo').click(); })()`);
  await wait(1500);
  const sites = [['ABV', 'abv.bg'], ['GitHub', 'github.com'], ['Netflix', 'netflix.com'], ['Google', 'accounts.google.com'], ['Discord', 'discord.com'], ['Twitch', 'twitch.tv'], ['PayPal', 'paypal.com'], ['Steam', 'store.steampowered.com'], ['Spotify', 'spotify.com'], ['YouTube', 'youtube.com'], ['Reddit', 'reddit.com'], ['Cloudflare', 'dash.cloudflare.com'], ['Revolut', 'revolut.com'], ['eMAG', 'emag.bg']];
  await js(`(async () => { window.__vaultState.items = ${JSON.stringify(sites)}.map(([t, w]) => ({ id: window.transfer.uid(), title: t, website: w, username: 'me@example.com', password: 'x', fields: [], notes: '', createdAt: Date.now(), updatedAt: Date.now() })).sort((a, b) => a.title.localeCompare(b.title)); await persist(); render(); })()`);
  const L = getLogos();
  L._test.base = (d) => `https://${d}/`;
  await js('requestLogos(); true');
  for (let i = 0; i < 60 && L._busy(); i++) await wait(500);
  await wait(800);
  const out = [];
  for (const [t, w] of sites) {
    const rec = [...L._cache().entries()].find(([d]) => d === w.replace(/^www\./, ''));
    out.push(`${t.padEnd(10)} ${rec ? (rec[1].src ? 'LOGO ' + rec[1].size + 'px' : rec[1].fail ? 'FAILED' : 'colour only') + ' colour=' + rec[1].color + ' bg=' + rec[1].bg : 'none'}`);
  }
  console.log(out.join('\n'));
  await js(`select(window.__vaultState.items.find(i => i.title === 'ABV').id)`);
  await wait(1200);
  console.log('hero tile:', await js("(() => { const t = document.querySelector('.hero .tile'); const r = t.getBoundingClientRect(); const i = t.querySelector('img'); return JSON.stringify({ cls: t.className, w: r.width, h: r.height, img: i && [i.naturalWidth, i.getBoundingClientRect().width], ghost: !!document.querySelector('.tile-ghost') }); })()"));
  await shot('40-real-logos');
  await js(`select(window.__vaultState.items.find(i => i.title === 'GitHub').id)`);
  nativeTheme.themeSource = 'dark'; await wait(1200);
  await shot('41-real-logos-dark');
  try { fs.rmSync(require('electron').app.getPath('userData'), { recursive: true, force: true }); } catch {}
  require('electron').app.exit(0);
};
