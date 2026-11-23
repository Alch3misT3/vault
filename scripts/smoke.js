'use strict';
// Automated end-to-end check: `npm run smoke`.
// Uses a throw-away vault in the temp folder, drives the real UI, writes
// screenshots to smoke-shots/ and prints PASS/FAIL lines.

const fs = require('fs');
const path = require('path');

module.exports = async function smoke({ app, win, nativeTheme, vaultPath, opened, smokeIO }) {
  const root = path.join(__dirname, '..');
  const shots = path.join(root, 'smoke-shots');
  const fx = (n) => path.join(root, 'test-fixtures', n);
  fs.rmSync(shots, { recursive: true, force: true });
  fs.mkdirSync(shots, { recursive: true });
  smokeIO.exportDir = app.getPath('userData');

  const results = [];
  const check = (name, ok, extra) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => { await wait(350); const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(shots, name + '.png'), img.toPNG()); };
  const waitFor = async (code, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await js(code)) return true; await wait(80); } return false; };
  const screenShot = async (name) => { try { const { screen } = require('electron'); const b = win.getBounds(); const f = screen.getDisplayMatching(b).scaleFactor; win.setAlwaysOnTop(true); win.show(); await wait(700); require('child_process').execFileSync('powershell', ['-NoProfile','-ExecutionPolicy','Bypass','-File', path.join(__dirname,'screen-shot.ps1'), String(Math.round(b.x*f)), String(Math.round(b.y*f)), String(Math.round(b.width*f)), String(Math.round(b.height*f)), path.join(shots, name + '.png')]); win.setAlwaysOnTop(false); } catch (e) { console.log('screen shot skipped', e.message); } };
  const count = () => js('window.__vaultState.items.length');
  const MASTER = 'correct horse battery';

  win.webContents.on('console-message', (e) => { const m = e.message || ''; if (/error|uncaught/i.test(m)) console.log('RENDERER:', m); });
  try {
    await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', r) : r()));
    win.setBounds({ x: 40, y: 40, width: 1080, height: 720 });
    win.showInactive();
    nativeTheme.themeSource = 'light';
    await waitFor("!document.getElementById('lock').hidden");

    // 1. First run
    check('first run shows create screen', await js("document.getElementById('lockTitle').textContent === 'Create your vault'"));
    await js(`(() => { const a = document.getElementById('pw1'); a.value = 'short'; a.dispatchEvent(new Event('input')); })()`);
    check('create blocked for short password', await js("document.getElementById('createGo').disabled"));
    await js(`(() => { for (const id of ['pw1','pw2']) { const el = document.getElementById(id); el.value = ${JSON.stringify(MASTER)}; el.dispatchEvent(new Event('input')); } })()`);
    await shot('01-create-vault');
    await js("document.getElementById('createGo').click()");
    check('vault created and opened', await waitFor("!document.getElementById('app').hidden"));
    await shot('02-empty-vault');

    // 2. Imports from other apps
    const doImport = async (file) => {
      smokeIO.importPath = fx(file);
      await js("handleCommand('import')");
      await waitFor("document.getElementById('importDlg').open");
      const title = await js("document.getElementById('importTitle').textContent");
      const canImport = await js("!document.getElementById('importGo').hidden");
      if (canImport) await js("document.getElementById('importGo').click()");
      else await js("document.getElementById('importDlg').close()");
      await wait(250);
      return title;
    };
    let t = await doImport('apple.csv');
    check('import Apple Passwords CSV', (await count()) === 2, t);
    await shot('03-import-dialog-chrome').catch(() => {});
    t = await doImport('chrome.csv');
    check('import Chrome CSV (skips duplicate Netflix)', (await count()) === 4, t);
    t = await doImport('bitwarden.csv');
    check('import Bitwarden CSV with custom fields', (await count()) === 6, t);
    t = await doImport('onepassword.csv');
    check('import 1Password CSV (Cyrillic)', (await count()) === 7, t);
    t = await doImport('lastpass.csv');
    check('import LastPass CSV (quoted commas)', (await count()) === 8, t);
    t = await doImport('excel-semicolon.csv');
    check('import semicolon CSV', (await count()) === 9, t);
    t = await doImport('bitwarden.json');
    check('import Bitwarden JSON', (await count()) === 10, t);
    t = await doImport('bad.csv');
    check('bad CSV shows a clear error, imports nothing', (await count()) === 10 && /Can’t import/.test(t), t);

    const riot = await js("JSON.stringify(window.__vaultState.items.find(i => i.title === 'Riot Games'))");
    const r = JSON.parse(riot || '{}');
    check('Bitwarden fields kept (PIN secret, notes multiline)', r.fields && r.fields.some((f) => f.label === 'PIN' && f.value === '4821' && f.secret) && /EUW/.test(r.notes), JSON.stringify(r.fields));
    const pp = await js("window.__vaultState.items.find(i => i.title === 'PayPal').password");
    check('LastPass quoted password parsed', pp === 'pay,pal"pass', pp);
    const gh = await js("JSON.stringify(window.__vaultState.items.find(i => i.title === 'GitHub').fields)");
    check('Apple OTPAuth kept as secret field', /otpauth/.test(gh));

    // 3. Detail + search
    await js("select(window.__vaultState.items.find(i => i.title === 'Riot Games').id)");
    await shot('04-detail-riot');
    await screenShot('04-real-window');
    check('window content never shifts', await js("(window.__dbg = JSON.stringify([document.getElementById('app').getBoundingClientRect().top, document.querySelector('.sidebar').getBoundingClientRect().bottom, innerHeight, document.scrollingElement.scrollTop]), true) && document.getElementById('app').getBoundingClientRect().top === 0 && document.querySelector('.sidebar').getBoundingClientRect().bottom <= innerHeight + 1"));
    const titles = await js("window.__vaultState.items.map(i => i.title).join(', ')");
    check('imported titles tidied', /Netflix,/.test(titles) && /Google/.test(titles) && /Discord/.test(titles) && !/\(netflix/.test(titles), titles);
    await js(`(() => { const q = document.getElementById('q'); q.focus(); q.value = 'net'; q.dispatchEvent(new Event('input')); })()`);
    const firstHit = await js("document.querySelector('#list .row .row-title').textContent");
    check('search "net" puts Netflix first', /Netflix/.test(firstHit), firstHit);
    await shot('05-search-net');
    await js(`(() => { const q = document.getElementById('q'); q.value = 'example.bg'; q.dispatchEvent(new Event('input')); })()`);
    check('search by email finds Cyrillic account', await js("document.querySelectorAll('#list .row').length === 1 && /Спиди/.test(document.querySelector('#list .row-title').textContent)"));
    await js(`(() => { const q = document.getElementById('q'); q.value = 'zzzz'; q.dispatchEvent(new Event('input')); })()`);
    check('no-results state', await js("/No results/.test(document.getElementById('list').textContent)"));
    await js(`(() => { const q = document.getElementById('q'); q.value = ''; q.dispatchEvent(new Event('input')); })()`);

    // 4. Login link opens in default browser (captured, not really opened)
    await js("select(window.__vaultState.items.find(i => /Netflix/.test(i.title)).id)");
    await js("document.querySelector('.hero .btn-primary').click()");
    await wait(100);
    check('Netflix opens its login page', opened.includes('https://www.netflix.com/login'), opened.join(' '));

    // 5. New account by hand, with generated password and extra field
    await js("handleCommand('new')");
    await waitFor("!!document.getElementById('f-title')");
    await js(`(() => {
      const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input')); };
      set('f-title', 'Twitch'); set('f-user', 'streamer@example.com'); set('f-web', 'twitch.tv');
      document.querySelector('[aria-label="Suggest a strong password"]').click();
      document.querySelector('.add-row').click();
    })()`);
    await js(`(() => {
      const lab = document.querySelector('[data-field="0"]'); lab.value = 'Stream key'; lab.dispatchEvent(new Event('input'));
      const val = lab.parentElement.querySelectorAll('input')[1]; val.value = 'live_123_secret'; val.dispatchEvent(new Event('input'));
      const n = document.querySelector('.notes-edit textarea'); n.value = 'OBS uses this key'; n.dispatchEvent(new Event('input'));
    })()`);
    const hint = await js("document.getElementById('linkHint').textContent");
    check('login link generated while typing', /twitch\.tv\/login/.test(hint), hint);
    const genPw = await js("document.getElementById('f-pw').value");
    check('generated password looks Apple-style', /^[a-zA-Z0-9]{6}-[a-zA-Z0-9]{6}-[a-zA-Z0-9]{6}$/.test(genPw) && /[A-Z]/.test(genPw) && /\d/.test(genPw), genPw);
    await shot('06-new-account-edit');
    await js('saveEdit()');
    await wait(300);
    check('new account saved', (await count()) === 11);
    await shot('07-twitch-detail');

    // 6. Name-only account gets a link from its title
    await js("handleCommand('new')");
    await waitFor("!!document.getElementById('f-title')");
    await js(`(() => { const el = document.getElementById('f-title'); el.value = 'Instagram'; el.dispatchEvent(new Event('input')); })()`);
    const ih = await js("document.getElementById('linkHint').textContent");
    check('title "Instagram" alone makes a login link', /instagram\.com\/accounts\/login/.test(ih), ih);
    await js("document.querySelector('.detail-bar .glass-btn').click()"); // cancel -> discard prompt
    await wait(150);
    check('cancel with changes asks to discard', await js("document.getElementById('alert').open"));
    await shot('08-discard-alert');
    await js("document.getElementById('alertOk').click()");
    await wait(150);

    // 7. File on disk is encrypted
    const raw = fs.readFileSync(vaultPath(), 'utf8');
    check('vault file has no plaintext secrets', !/R1ot-pass|Twitch|streamer@example|live_123/.test(raw) && /aes-256-gcm/.test(raw));

    // 8. Export
    await js("handleCommand('export')");
    await js(`(() => { document.getElementById('exPw').value = 'wrong-password'; document.getElementById('exGo').click(); })()`);
    await waitFor("document.getElementById('exError').textContent.length > 0");
    check('export refuses wrong master password', await js("document.getElementById('exError').textContent === 'Wrong password.'"));
    await shot('09-export-dialog');
    await js(`(() => { document.getElementById('exPw').value = ${JSON.stringify(MASTER)}; document.getElementById('exGo').click(); })()`);
    await waitFor("!document.getElementById('exportDlg').open");
    const csvFile = fs.readdirSync(app.getPath('userData')).find((f) => f.endsWith('.csv'));
    const csv = csvFile ? fs.readFileSync(path.join(app.getPath('userData'), csvFile), 'utf8') : '';
    check('CSV export written with all accounts', csv.split(/\r\n/).filter(Boolean).length === 12 && /Stream key: live_123_secret/.test(csv), csvFile);
    // Round-trip: the exported CSV imports cleanly (all duplicates)
    smokeIO.importPath = path.join(app.getPath('userData'), csvFile);
    await js("handleCommand('import')");
    await waitFor("document.getElementById('importDlg').open");
    const rt = await js("document.getElementById('importTitle').textContent");
    check('re-importing own export finds nothing new', /Nothing new/.test(rt), rt);
    await js("document.getElementById('importDlg').close()");

    // 9. Lock / unlock
    await js('lockNow()');
    await waitFor("!document.getElementById('lock').hidden");
    check('lock clears data from memory', (await count()) === 0);
    await js(`(() => { const el = document.getElementById('pw1'); el.value = 'nope nope'; el.dispatchEvent(new Event('input')); document.getElementById('unlockGo').click(); })()`);
    await waitFor("document.getElementById('lockError').textContent.length > 0");
    check('wrong password rejected', await js("/Wrong password/.test(document.getElementById('lockError').textContent)"));
    await shot('10-wrong-password');
    await js(`(() => { const el = document.getElementById('pw1'); el.value = ${JSON.stringify(MASTER)}; el.dispatchEvent(new Event('input')); document.getElementById('unlockGo').click(); })()`);
    check('right password unlocks all 11 accounts', (await waitFor("!document.getElementById('app').hidden")) && (await count()) === 11);

    // Update banner
    await js("showUpdate({ status: 'ready', version: '1.0.1' })");
    check('update banner shows when an update is ready', await js("!document.getElementById('updateBar').hidden && /1.0.1/.test(document.getElementById('updateSub').textContent)"));
    await shot('10b-update-ready');
    await js("showUpdate({ status: 'latest' })");
    check('update banner hides when up to date', await js("document.getElementById('updateBar').hidden"));

    // 10. Dark mode
    nativeTheme.themeSource = 'dark';
    await js("select(window.__vaultState.items.find(i => i.title === 'Twitch').id)");
    await shot('11-dark-detail');
    await js("startEdit(window.__vaultState.items.find(i => i.title === 'Twitch'))");
    await shot('12-dark-edit');
    await js("cancelEdit()");
    await js("deleteItem(window.__vaultState.items.find(i => i.title === 'Twitch'))");
    await shot('13-dark-delete-alert');
    await js("document.getElementById('alertOk').click()");
    await wait(300);
    check('delete removes account', (await count()) === 10);
    nativeTheme.themeSource = 'light';
    await js("lockNow()");
    await waitFor("!document.getElementById('lock').hidden");
    await shot('14-locked');
  } catch (err) {
    check('smoke run crashed', false, err && err.stack);
  }
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${shots}`);
  try { fs.rmSync(app.getPath('userData'), { recursive: true, force: true }); } catch {}
  app.exit(failed ? 1 : 0);
};
