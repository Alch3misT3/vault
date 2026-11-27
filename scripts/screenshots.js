'use strict';
// Renders the README screenshots with made-up demo accounts: `npm run screenshots`.
// Uses a throw-away vault in the temp folder; output goes to docs/screenshots/.

const fs = require('fs');
const path = require('path');

const DEMO = [
  { title: 'Netflix', website: 'netflix.com', username: 'alex.morgan@example.com', password: 'tvqmzk-Hrw4nb-pxcyad', notes: 'Family plan · renews on the 3rd' },
  { title: 'Spotify', website: 'spotify.com', username: 'alex.morgan@example.com', password: 'gfkwse-qa7Npl-dmruvo', notes: 'Duo plan, shared with Sam' },
  { title: 'Discord', website: 'discord.com', username: 'alexm', password: 'nbxeut-pRmcz2-hwqifa', notes: '',
    fields: [{ label: 'Backup codes', value: '4821-9934 · 1107-6620 · 8853-0471', secret: true }] },
  { title: 'Twitch', website: 'twitch.tv', username: 'alexplays', password: 'ycrnfo-wmzLt8-ekbvqa',
    fields: [{ label: 'Stream key', value: 'live_8213_x9QpLmT4vZr2', secret: true }, { label: 'Channel', value: 'twitch.tv/alexplays', secret: false }],
    notes: 'OBS uses the stream key. Rotate it after every collab stream.' },
  { title: 'GitHub', website: 'github.com', username: 'alex-morgan', password: 'zjqupd-Ebnw6s-ylvtko',
    fields: [{ label: 'Personal access token', value: 'ghp_demoTokenOnly0000000000000000', secret: true }], notes: '' },
  { title: 'Google', website: 'google.com', username: 'alex.morgan@example.com', password: 'kwhsva-cDrj3e-nfmtpz', notes: 'Recovery phone ends in 42' },
  { title: 'Steam', website: 'store.steampowered.com', username: 'alex_m', password: 'qpvdyc-sKtu9m-rzbhaw', notes: '' },
  { title: 'PayPal', website: 'paypal.com', username: 'alex.morgan@example.com', password: 'mxtrbe-Vzqo5k-cgwnly', notes: '' },
  { title: 'Riot Games', website: 'riotgames.com', username: 'alexm#EUW', password: 'hdfsow-pYbk7r-tqzvxe', fields: [{ label: 'PIN', value: '4821', secret: true }], notes: 'Main account, EUW server' },
  { title: 'Instagram', website: 'instagram.com', username: '@alex.morgan', password: 'ruzgmc-bWyt2h-kpsxne', notes: '' },
  { title: 'Home Wi-Fi', website: '', username: 'Morgan-5G', password: 'leafy-garden-4071', notes: 'Router admin is on the sticker under the box.' },
];

module.exports = async function screenshots({ testWorkArea, app, win, nativeTheme }) {
  const out = path.join(__dirname, '..', 'docs', 'screenshots');
  fs.mkdirSync(out, { recursive: true });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const waitFor = async (code, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await js(code)) return true; await wait(80); } return false; };
  const shot = async (name) => {
    await js("document.getElementById('toast').classList.remove('show')");
    await wait(1400); // let the glass and colour transitions settle
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(out, name + '.png'), img.toPNG());
    console.log('saved', name);
  };
  const select = (title) => js(`select(window.__vaultState.items.find(i => i.title === ${JSON.stringify(title)}).id)`);

  try {
    await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', r) : r()));
    win.setContentSize(1200, 760);
    const area = testWorkArea(); // a second screen if there is one
    win.setPosition(area.x + 40, area.y + 40);
    win.showInactive();
    nativeTheme.themeSource = 'light';
    await waitFor("!document.getElementById('lock').hidden");

    // Create a demo vault and fill it.
    await js(`(() => { for (const id of ['pw1','pw2']) { const el = document.getElementById(id); el.value = 'demo-password-123'; el.dispatchEvent(new Event('input')); } document.getElementById('createGo').click(); })()`);
    await waitFor("!document.getElementById('app').hidden");
    const now = Date.now();
    const items = DEMO.map((d, i) => ({ id: 'demo' + i, fields: [], notes: '', ...d, fields: (d.fields || []).map((f, j) => ({ id: `f${i}${j}`, ...f })), createdAt: now - 86400000 * (40 - i), updatedAt: now - 86400000 * (i % 9) }));
    await js(`(async () => { window.__vaultState.items = ${JSON.stringify(items)}.sort(byTitle); await persist(); render(); })()`);
    await js("document.querySelector('.sidebar').classList.add('list-active')");

    // 1. Main view (light)
    await select('Twitch');
    await shot('main-light');

    // 2. Search
    await js(`(() => { const q = document.getElementById('q'); q.value = 'alex.morgan'; q.dispatchEvent(new Event('input')); })()`);
    await select('Netflix');
    await js("document.querySelector('.sidebar').classList.add('list-active')");
    await shot('search');
    await js(`(() => { const q = document.getElementById('q'); q.value = ''; q.dispatchEvent(new Event('input')); q.blur(); })()`);
    await js("document.querySelector('.sidebar').classList.add('list-active')");

    // 3. Editing: suggested password, extra fields, live login link
    await select('Spotify');
    await js("startEdit(current())");
    await waitFor("!!document.getElementById('f-title')");
    await js(`(() => {
      document.querySelector('[aria-label="Suggest a strong password"]').click();
      document.activeElement && document.activeElement.blur();
    })()`);
    await shot('edit');
    await js("state.mode = 'view'; state.draft = null; render();");

    // 4. Dark mode
    nativeTheme.themeSource = 'dark';
    await select('Discord');
    await js("document.querySelector('.sidebar').classList.add('list-active')");
    await shot('main-dark');

    // 5. Import dialog (dark)
    await js(`(() => {
      const dlg = document.getElementById('importDlg');
      document.getElementById('importTitle').textContent = 'Import 48 accounts?';
      document.getElementById('importBody').textContent = 'From “Bitwarden export.csv”. 3 already in your vault will be skipped. Afterwards, delete the export file: it isn’t encrypted.';
      document.getElementById('importGo').hidden = false;
      dlg.querySelector('.btn-secondary').textContent = 'Cancel';
      dlg.showModal(); document.activeElement.blur();
    })()`);
    await shot('import');
    await js("document.getElementById('importDlg').close()");

    // 6. Lock screen (dark)
    await js('lockNow()');
    await waitFor("!document.getElementById('lock').hidden");
    await js(`(() => { const el = document.getElementById('pw1'); el.value = 'demo-password'; el.dispatchEvent(new Event('input')); el.blur(); })()`);
    await shot('lock');
  } catch (err) {
    console.error('screenshots failed', err && err.stack);
  }
  try { fs.rmSync(app.getPath('userData'), { recursive: true, force: true }); } catch {}
  app.exit(0);
};
