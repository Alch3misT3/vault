'use strict';
// Automated end-to-end check: `npm run smoke`.
// Uses a throw-away vault in the temp folder, drives the real UI, writes
// screenshots to smoke-shots/ and prints PASS/FAIL lines.

const fs = require('fs');
const path = require('path');

module.exports = async function smoke({ app, win, nativeTheme, vaultPath, opened, smokeIO, clipboard, showQuick, getQuick, getBridge, getLogos }) {
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
      document.getElementById('addField').click();
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

    // Light, states, menus, motion, frame rate (ends locked, with reduced motion switched on)
    const motion = await require('./smoke-motion')({ win, js, wait, waitFor, shot, check, clipboard });
    await js(`(() => { const el = document.getElementById('pw1'); el.value = ${JSON.stringify(MASTER)}; el.dispatchEvent(new Event('input')); document.getElementById('unlockGo').click(); })()`);
    check('unlocking: the lock card lifts away as the window arrives', (await waitFor("!document.getElementById('app').hidden")) && (await js("document.getElementById('lock').classList.contains('leaving') || document.getElementById('lock').hidden")) && (await js("document.getElementById('app').classList.contains('arrive')")));
    await wait(400);
    await motion.reduced();

    // 10. Favorites
    const live = () => js('window.__vaultState.items.filter(i => !i.deletedAt).length');
    const byName = (n) => `window.__vaultState.items.find(i => i.title === ${JSON.stringify(n)})`;
    await js("setView('all')");
    await js(`toggleFavorite(${byName('Steam')})`);
    await waitFor(`${byName('Steam')}.favorite === true`);
    check('star pins Steam to the top of All', await js("/Steam/.test(document.querySelector('#list .row .row-title').textContent) && !!document.querySelector('#list .row .row-star')"));
    await js("setView('favorites')");
    check('Favorites view lists only starred accounts', await js("document.querySelectorAll('#list .row').length === 1 && document.getElementById('view-favorites').getAttribute('aria-selected') === 'true'"));

    // 11. Verification codes (2FA): GitHub came from Apple with an otpauth link
    const { otp } = require('../src/otp.js');
    const nodeHmac = (alg, key, msg) => new Uint8Array(require('crypto').createHmac(alg.toLowerCase(), Buffer.from(key)).update(Buffer.from(msg)).digest());
    await js("setView('codes')");
    check('Codes view lists GitHub', await js("document.querySelectorAll('#list .row').length === 1 && /GitHub/.test(document.querySelector('#list .row-title').textContent)"));
    await waitFor("/^\\d{3} \\d{3}$/.test((document.querySelector('.detail .otp-code') || {}).textContent || '')", 4000);
    const shown = await js("document.querySelector('.detail .otp-code').textContent.replace(' ', '')");
    const expected = await otp.code(otp.parse('otpauth://totp/GitHub:dev-user?secret=JBSWY3DPEHPK3PXP'), nodeHmac);
    const expected2 = await otp.code(otp.parse('JBSWY3DPEHPK3PXP'), nodeHmac, Date.now() - 1500);
    check('GitHub shows the right 6-digit code', shown === expected || shown === expected2, `${shown} vs ${expected}`);
    await shot('15-codes-view');

    // set one up by hand: wrong key is refused, right key works
    await js("setView('all')");
    await js(`select(${byName('Twitch')}.id)`);
    await js(`startEdit(${byName('Twitch')})`);
    await js("document.getElementById('otpSetup').click()");
    await waitFor("!!document.getElementById('f-otp')");
    await js(`(() => { const el = document.getElementById('f-otp'); el.value = 'not a key!'; el.dispatchEvent(new Event('input')); })()`);
    await js('saveEdit()');
    check('invalid setup key is refused', await js("state.mode === 'edit' && document.getElementById('f-otp').classList.contains('field-error')"));
    await js(`(() => { const el = document.getElementById('f-otp'); el.value = 'jbsw y3dp ehpk 3pxp'; el.dispatchEvent(new Event('input')); })()`);
    // 12. Password history: change Twitch's password in the same edit
    const oldTwitchPw = await js(`${byName('Twitch')}.password`);
    await js(`(() => { const el = document.getElementById('f-pw'); el.value = 'brand-new-Pass-42x'; el.dispatchEvent(new Event('input')); })()`);
    await shot('16-edit-otp-setup');
    await js('saveEdit()');
    await waitFor("state.mode === 'view'");
    const tw = JSON.parse(await js(`JSON.stringify(${byName('Twitch')})`));
    check('verification code saved on Twitch', tw.fields.some((f) => f.kind === 'otp' && f.value === 'jbsw y3dp ehpk 3pxp'));
    check('old password kept in history', tw.history && tw.history.length === 1 && tw.history[0].value === oldTwitchPw && tw.pwChangedAt > Date.now() - 60000, JSON.stringify(tw.history));
    await js("state.showHistory = true; renderDetail()");
    check('history shows in the account', await js("/1 previous password/.test(document.querySelector('.disclosure').textContent) && document.querySelectorAll('.disclosure ~ .field-row').length === 1"));
    await shot('17-history');

    // 13. Password health
    await js(`(async () => { const it = ${byName('Discord')}; it.password = 'Summer2024!'; const g = ${byName('Google')}; g.password = 'tvqmzk-Hrw4nb-pxcyad'; const n = window.__vaultState.items.find(i => /Netflix/.test(i.title)); n.password = 'tvqmzk-Hrw4nb-pxcyad'; window.__vaultState.items = window.__vaultState.items.slice(); await persist(); render(); })()`);
    await js("setView('security')");
    const sec = await js("[...document.querySelectorAll('#list .row')].map(r => r.textContent).join(' | ')");
    check('Security finds the weak and the reused passwords', /Discord.*Weak password/.test(sec) && /Google.*Reused on 2/.test(sec) && /Netflix.*Reused on 2/.test(sec), sec);
    check('Security badge counts the accounts', await js("+document.querySelector('#view-security .badge').textContent >= 3"));
    check('strong generated passwords are not flagged', !/Twitch/.test(sec), sec);
    await js(`select(${byName('Google')}.id)`);
    await shot('18-security');
    check('reused warning names the other account', await js("/Also used for Netflix/.test(document.querySelector('.notice.warn').textContent)"));

    // 14. Password generator options
    await js("localStorage.removeItem('vault.gen')");
    const gen = (style, extra = '') => js(`(() => { const s = { ...genSettings(), style: ${JSON.stringify(style)} ${extra} }; return generatePassword(s); })()`);
    const words = await gen('words', ', words: 5');
    check('word passwords: 5 words, a capital and a number', words.split('-').length === 5 && /[A-Z]/.test(words) && /\d/.test(words), words);
    const rand = await gen('random', ', length: 32, symbols: true');
    check('random passwords: length 32 with every kind of character', rand.length === 32 && /[a-z]/.test(rand) && /[A-Z]/.test(rand) && /\d/.test(rand) && /[^A-Za-z0-9]/.test(rand), rand);
    await js("generatorFlow(false); true");
    check("options dialog opens", await js("document.getElementById('genDlg').open"));
    await js(`(() => { const r = document.querySelector('#genForm input[value="words"]'); r.checked = true; r.dispatchEvent(new Event('change')); })()`);
    check('options dialog previews a word password', await js("document.getElementById('genOut').textContent.split('-').length === 5 && !document.getElementById('genLenRow').hidden && document.getElementById('genSymRow').hidden"));
    await shot('19-generator');
    await js("document.getElementById('genDlg').close()");
    check('closing it without choosing copies nothing', !(await js("/Password copied/.test(document.getElementById('toast').textContent) && document.getElementById('toast').classList.contains('show')")));

    // 15. Quick search panel (Ctrl+Shift+Space)
    showQuick();
    // The panel is a Windows acrylic window, which capturePage can't grab: photograph the real screen instead.
    const quickShot = async (name) => {
      try {
        const { screen } = require('electron');
        const q = getQuick(); const b = q.getBounds(); const f = screen.getDisplayMatching(b).scaleFactor;
        q.setAlwaysOnTop(true, 'screen-saver'); q.showInactive(); await wait(700);
        require('child_process').execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'screen-shot.ps1'), String(Math.round(b.x * f)), String(Math.round(b.y * f)), String(Math.round(b.width * f)), String(Math.round(b.height * f)), path.join(shots, name + '.png')]);
      } catch (e) { console.log('quick screenshot skipped:', e.message); }
    };
    const qjs = (code) => getQuick().webContents.executeJavaScript(code);
    const qWait = async (code, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await qjs(code)) return true; } catch {} await wait(80); } return false; };
    check('quick search opens with every account', await qWait(`window.__quick && window.__quick.items.length === ${await live()}`));
    check('quick search springs in', await qjs("document.querySelector('.q-panel').classList.contains('in')"));
    await qjs(`(() => { const el = document.getElementById('qq'); el.value = 'git'; el.dispatchEvent(new Event('input')); })()`);
    check('quick search finds GitHub', await qWait("/GitHub/.test(document.querySelector('.q-row[aria-selected=\"true\"]').textContent)"));
    await qWait("!!document.querySelector('.q-code-num')", 3000);
    await shot('20-quick-main-window');
    await quickShot('20-quick-search');
    await clipboard.clear();
    await qjs("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))");
    await wait(300);
    const c1 = await clipboard.readText();
    check('Enter copies the password', c1 === 'gh-Pa55-word', c1);
    await qjs("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true }))");
    await wait(300);
    const c2 = await clipboard.readText();
    check('Alt+Enter copies the 2FA code', /^\d{6}$/.test(c2), c2);
    await wait(1900);
    check('copied secrets are cleared from the clipboard afterwards', (await clipboard.readText()) === '');
    check('quick panel never receives secrets', await qjs("!JSON.stringify(window.__quick.items).includes('gh-Pa55-word') && !JSON.stringify(window.__quick.items).includes('JBSWY3DP')"));
    // locked: unlocking in the panel unlocks the window too
    await js('lockNow()');
    await waitFor("!document.getElementById('lock').hidden");
    showQuick(); showQuick(); // close and reopen
    check('quick search asks for the master password when locked', await qWait("!document.getElementById('qLock').hidden"));
    await quickShot('21-quick-locked');
    await qjs(`(() => { document.getElementById('qpw').value = ${JSON.stringify(MASTER)}; document.getElementById('qGo').click(); })()`);
    check('unlocking from quick search unlocks the window', (await waitFor("!document.getElementById('app').hidden")) && (await qWait("!document.getElementById('qSearch').hidden")));
    getQuick().hide();

    // 16. Browser extension: run the extension's own client code against Vault's bridge
    {
      const vm = require('vm');
      const bridge = getBridge();
      const store = {};
      const chromeMock = { storage: { local: {
        get: async (keys) => Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]])),
        set: async (o) => { Object.assign(store, o); },
        remove: async (keys) => { keys.forEach((k) => delete store[k]); },
      } } };
      // Only the test Vault's port answers (a real Vault running on this PC may hold another one).
      const testFetch = (u, o) => { const port = +new URL(u).port; return port === getBridge().state().port ? fetch(u, o) : Promise.reject(new TypeError('fetch failed')); };
      const ctx = vm.createContext({ chrome: chromeMock, crypto: globalThis.crypto, fetch: testFetch, AbortController, setTimeout, clearTimeout, TextEncoder, TextDecoder, btoa, atob, URL, console, navigator: { userAgent: 'Mozilla/5.0 Chrome/140.0 Safari/537.36 Edg/140.0' } });
      vm.runInContext(fs.readFileSync(path.join(root, 'browser-extension', 'vault-client.js'), 'utf8'), ctx);
      const VC = ctx.VaultClient;
      const err = (p) => p.then(() => 'no error', (e) => e.message);

      check('bridge is off until a browser is paired', !bridge.state().listening);
      check('extension’s links.js matches the app’s', fs.readFileSync(path.join(root, 'browser-extension', 'links.js'), 'utf8') === fs.readFileSync(path.join(root, 'src', 'links.js'), 'utf8'));
      await js("browserFlow()");
      await waitFor("document.getElementById('browserDlg').open && /^[A-Z2-7]{4}(-[A-Z2-7]{4}){7}$/.test(document.getElementById('brCode').textContent)");
      const code = await js("document.getElementById('brCode').textContent");
      check('Connect a Browser shows a one-time code', /^[A-Z2-7]{4}(-[A-Z2-7]{4}){7}$/.test(code), code);
      await wait(300);
      check('bridge listens on 127.0.0.1 while pairing', bridge.state().listening && bridge.state().pairing);
      const wrong = code.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'));
      { const m = await err(VC.pair(wrong)); check('a wrong code is refused', /doesn’t match/.test(m), m); }
      { const m = await err(VC.pair(code.toLowerCase())); check('the right code pairs the browser', m === 'no error', m); }
      check('Vault lists the browser as connected', await waitFor("/Microsoft Edge/.test(document.getElementById('brClients').textContent) && !document.getElementById('brAgain').hidden"));
      await shot('22-connect-browser');
      check('the code works only once', /Connect a Browser first|didn’t accept/.test(await err(VC.pair(code))));
      await js("document.getElementById('browserDlg').close()");

      const st = await VC.rpc('status');
      check('extension sees Vault unlocked', st.unlocked === true, JSON.stringify(st));
      const lst = await VC.rpc('list', { url: 'https://www.netflix.com/login?nextpage=x' });
      check('extension suggests Netflix on netflix.com', lst.items.length === 1 && lst.items[0].title === 'Netflix' && lst.items[0].match, JSON.stringify(lst.items.map((i) => i.title)));
      const gl = await VC.rpc('list', { url: 'https://accounts.google.com/signin' });
      check('google.com login matches on accounts.google.com', gl.items.some((i) => i.title === 'Google'), JSON.stringify(gl.items.map((i) => i.title)));
      const srch = await VC.rpc('list', { url: 'https://example.org/', query: 'git' });
      check('extension search finds GitHub', srch.items.length === 1 && srch.items[0].title === 'GitHub' && srch.items[0].hasCode && !srch.items[0].match);
      check('lists never include passwords', !JSON.stringify([lst, gl, srch]).includes('gh-Pa55-word'));
      const login = await VC.rpc('login', { id: srch.items[0].id });
      check('extension gets the login to fill', login.username === 'dev-user' && login.password === 'gh-Pa55-word');
      const cd = await VC.rpc('code', { id: srch.items[0].id });
      check('extension gets the current 2FA code', /^\d{6}$/.test(cd.code));
      await clipboard.clear();
      await VC.rpc('copy', { id: srch.items[0].id, what: 'password' });
      check('extension copy goes through Vault (auto-clears)', (await clipboard.readText()) === 'gh-Pa55-word');

      const port = bridge.state().port;
      const evil = await fetch(`http://127.0.0.1:${port}/hello`, { headers: { Origin: 'https://evil.example' } });
      check('web pages are refused', evil.status === 403);
      const forged = await fetch(`http://127.0.0.1:${port}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: store.clientId, iv: 'AAAAAAAAAAAAAAAA', ct: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAA' }) });
      check('messages without the key are refused', forged.status === 401);
      // capture one real request and send it again
      let captured = null;
      const realFetch = ctx.fetch;
      ctx.fetch = async (u, opts) => { if (/\/rpc$/.test(u)) captured = opts; return realFetch(u, opts); };
      await VC.rpc('status');
      ctx.fetch = realFetch;
      const replay = await fetch(`http://127.0.0.1:${port}/rpc`, captured);
      check('a replayed message is refused', replay.status === 401);

      await js('lockNow()');
      await waitFor("!document.getElementById('lock').hidden");
      check('locked Vault gives the extension nothing', (await VC.rpc('list', { url: 'https://www.netflix.com/' })).locked === true);
      check('wrong master password from the extension fails', (await VC.rpc('unlock', { password: 'nope nope' })).ok === false);
      check('unlocking from the extension unlocks Vault', (await VC.rpc('unlock', { password: MASTER })).ok === true && (await waitFor("!document.getElementById('app').hidden")));
      const settingsRaw = fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8');
      check('browser key is stored encrypted (Windows DPAPI)', /"key":"dpapi:/.test(settingsRaw) && !settingsRaw.includes(store.key));

      // Optional: the same in a real Edge window (VAULT_EXT_E2E=1 npm run smoke).
      if (process.env.VAULT_EXT_E2E) {
        const { code: code2 } = bridge.startPairing();
        await require('./ext-e2e')({ code: code2, check, shotsDir: shots, wait, master: MASTER });
        for (const c of bridge.clients()) if (c.id !== store.clientId) bridge.remove(c.id);
        bridge.cancelPairing();
      }

      bridge.remove(bridge.clients()[0].id);
      check('a removed browser is cut off', /no longer knows|isn’t running/.test(await err(VC.rpc('status'))));
      await wait(200);
      check('bridge stops when no browser is paired', !bridge.state().listening);
    }

    // 17. Site logos (local test websites only)
    await require('./smoke-logos')({ app, win, js, wait, waitFor, shot, check, getLogos, getQuick, showQuick, nativeTheme, MASTER });

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
    await waitFor("window.__vaultState.items.filter(i => !i.deletedAt).length === 10");
    check('delete moves the account to Recently Deleted', (await live()) === 10 && (await count()) === 11);
    await js("setView('deleted')");
    check('Recently Deleted lists it with days left', await js("/Twitch/.test(document.querySelector('#list .row').textContent) && /30 days left/.test(document.querySelector('#list .row').textContent)"));
    await shot('13b-recently-deleted');
    await js(`recoverItem(${byName('Twitch')})`);
    await waitFor(`!${byName('Twitch')}.deletedAt`);
    check('Recover brings it back', (await live()) === 11);
    await js(`updateItem(${byName('Twitch')}, { deletedAt: Date.now() - 31 * 86400000 })`);
    await js('lockNow()');
    await waitFor("!document.getElementById('lock').hidden");
    await js(`(() => { const el = document.getElementById('pw1'); el.value = ${JSON.stringify(MASTER)}; el.dispatchEvent(new Event('input')); document.getElementById('unlockGo').click(); })()`);
    await waitFor("!document.getElementById('app').hidden");
    check('accounts deleted over 30 days ago are removed for good', (await count()) === 10 && !(await js(`!!${byName('Twitch')}`)));
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
