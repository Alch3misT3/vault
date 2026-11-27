'use strict';
// Smoke test, password changes: the pending password (incl. a forced close of Vault before you answer),
// the change page (/.well-known/change-password, the hand-checked list, the home page), filling the
// change form from the extension, the breach check (Have I Been Pwned range API), the change queue and
// Change Email Everywhere. Every website and service here is a local test server.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

module.exports = async function changes({ app, win, js, wait, waitFor, shot, check, VC, test, relock, MASTER, opened, clipboard, vaultPath }) {
  const VF = require('../vaultfile');
  const PW = test.PW;
  const secrets = [];
  const log = [];
  const servers = [];
  const serve = (name, fn) => new Promise((resolve) => {
    const s = http.createServer((req, res) => { log.push({ site: name, path: req.url, cookie: req.headers.cookie || '', padding: req.headers['add-padding'] }); fn(req, res); });
    s.listen(0, '127.0.0.1', () => { servers.push(s); resolve('http://127.0.0.1:' + s.address().port); });
  });
  const send = (res, status, body = '', headers = {}) => { res.writeHead(status, { 'Content-Type': 'text/html', ...headers }); res.end(body); };
  // site A follows the standard; site B has no change page; site C answers 200 to everything
  const A = await serve('a', (req, res) => {
    if (req.url === '/.well-known/change-password') return send(res, 302, '', { Location: '/account/password' });
    if (req.url === '/account/password') return send(res, 200, '<form>change</form>');
    send(res, 404, 'not found');
  });
  const B = await serve('b', (req, res) => send(res, 404, 'not found'));
  const C = await serve('c', (req, res) => send(res, 200, 'anything goes'));
  const BREACHED = 'P@ssw0rd-breached-77';
  const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex').toUpperCase();
  const HIBP = await serve('hibp', (req, res) => {
    const m = /^\/range\/([0-9A-F]{5})$/.exec(req.url);
    if (!m) return send(res, 404);
    const lines = [];
    for (let i = 0; i < 820; i++) lines.push(crypto.randomBytes(18).toString('hex').toUpperCase().slice(0, 35) + ':0'); // padding
    const h = sha1(BREACHED);
    if (h.startsWith(m[1])) lines.splice(300, 0, h.slice(5) + ':4242');
    send(res, 200, lines.join('\r\n'), { 'Content-Type': 'text/plain' });
  });
  const hosts = { 'sitea.example': A, 'siteb.example': B, 'sitec.example': C, 'www.netflix.com': C, 'netflix.com': C };
  PW._test.base = (host) => hosts[host] || B; // never the real internet
  PW._test.hibp = HIBP;

  const byName = (n) => `window.__vaultState.items.find(i => i.title === ${JSON.stringify(n)})`;
  const item = async (n) => JSON.parse(await js(`JSON.stringify(${byName(n)} || null)`));
  const disk = () => VF.readPayload(JSON.parse(fs.readFileSync(vaultPath(), 'utf8')), test.getSession().key);
  const diskItem = (n, p = disk()) => (p.items || []).find((i) => i.title === n);
  const unlockUI = async () => {
    await js(`(() => { const el = document.getElementById('pw1'); el.value = ${JSON.stringify(MASTER)}; el.dispatchEvent(new Event('input')); document.getElementById('unlockGo').click(); })()`);
    return waitFor("!document.getElementById('app').hidden && window.__vaultState.items.length > 0");
  };
  const clearOpened = () => { opened.length = 0; };
  const waitOpened = async (url, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (opened.includes(url)) return true; await wait(60); } return false; };

  try {
    // Test accounts on the local test sites.
    await js(`(async () => {
      const mk = (title, website, username, password) => ({ id: window.transfer.uid(), title, website, username, password, fields: [], notes: '', createdAt: Date.now(), updatedAt: Date.now() });
      state.items = [...state.items, mk('Alpha Site', 'sitea.example', 'old.me@example.com', 'alpha-Old-pass-1x'), mk('Beta Site', 'siteb.example', 'old.me@example.com', 'beta-Old-pass-2y'),
        mk('Gamma Site', 'sitec.example', ' OLD.me@example.com', ${JSON.stringify(BREACHED)})].sort(byTitle);
      await persist(); setView('all'); render(); return true; })()`);

    // ---- 1. one change, start to finish (site with /.well-known/change-password) ----
    await js(`select(${byName('Alpha Site')}.id)`);
    check('accounts with a website have a Change Password button', await js("!!document.getElementById('changePwBtn')"));
    clearOpened();
    check('the change page can’t open without a pending password saved on disk', (await js(`api.changePage(${byName('Alpha Site')}.id)`)) === null && !opened.length);
    await js("document.getElementById('changePwBtn').click()");
    check('the standard change page opens (site supports /.well-known/change-password)', await waitOpened('https://sitea.example/.well-known/change-password'), opened.join(' '));
    const aLog = log.filter((x) => x.site === 'a').map((x) => x.path);
    check('Vault first checks the site doesn’t answer 200 to anything, then asks for the change page', aLog[0] === '/.well-known/resource-that-should-not-exist-whose-status-code-should-not-be-200' && aLog.includes('/.well-known/change-password') && log.every((x) => !x.cookie));
    let a = await item('Alpha Site');
    const pend1 = a.pending && a.pending.value;
    secrets.push(pend1);
    const gs = JSON.parse(await js('JSON.stringify(genSettings())'));
    const looks = gs.style === 'words' ? (pend1 || '').split('-').length === gs.words : gs.style === 'random' ? (pend1 || '').length === gs.length : /^[a-zA-Z0-9]{6}-[a-zA-Z0-9]{6}-[a-zA-Z0-9]{6}$/.test(pend1 || '');
    check('the new password is made with the current generator settings and kept as pending', looks && a.password === 'alpha-Old-pass-1x', gs.style + ': ' + pend1);
    check('the pending password is saved to disk (encrypted) at once', (diskItem('Alpha Site').pending || {}).value === pend1 && !fs.readFileSync(vaultPath(), 'utf8').includes(pend1));
    await waitFor("!!document.getElementById('pendingNotice')");
    check('the account shows the change in progress, with both passwords', await js("!!document.getElementById('pendingNotice') && [...document.querySelectorAll('.detail .f-label')].map(l => l.textContent).join('|').includes('Current password|New password')"));
    check('the list shows “Changing password” on the account', await js(`/Changing password/.test(document.getElementById('row-' + ${byName('Alpha Site')}.id).textContent)`));
    await shot('40-change-pending');
    await clipboard.clear();
    await js("[...document.querySelectorAll('.detail .field-row')].find(r => r.querySelector('.f-label').textContent === 'New password').querySelector('[data-copy]').click()");
    await wait(250);
    const c1 = await clipboard.readText();
    await js("[...document.querySelectorAll('.detail .field-row')].find(r => r.querySelector('.f-label').textContent === 'Current password').querySelector('[data-copy]').click()");
    await wait(250);
    const c2 = await clipboard.readText();
    check('both the new and the current password can be copied', c1 === pend1 && c2 === 'alpha-Old-pass-1x');
    await clipboard.clear();

    // back in Vault: it asks how it went ("Not Yet" keeps everything)
    await js("state.changeAwait.at = Date.now() - 5000; window.dispatchEvent(new Event('focus')); true");
    check('coming back to Vault asks whether the change worked', await waitFor("document.getElementById('changeDlg').open && /sitea\\.example/.test(document.getElementById('changeTitle').textContent)", 3000));
    await shot('41-change-ask');
    await js("document.getElementById('changeLater').click()");
    await wait(300);
    check('“Not Yet” keeps the pending password', ((await item('Alpha Site')).pending || {}).value === pend1 && !(await js("document.getElementById('changeDlg').open")));

    // the extension: list, the change login (own site only), and filling real change forms
    const lst = await VC.rpc('list', { url: 'https://sitea.example/account/password' });
    check('the extension sees the change in progress for this site', lst.items.some((i) => i.title === 'Alpha Site' && i.changing && i.match) && !JSON.stringify(lst).includes(pend1));
    const aid = (await item('Alpha Site')).id;
    const cl = await VC.rpc('change-login', { id: aid, url: 'https://sitea.example/account/password' });
    check('the extension gets the current and the new password on the account’s own site', cl.current === 'alpha-Old-pass-1x' && cl.next === pend1 && cl.site === 'sitea.example');
    const wrong = await VC.rpc('change-login', { id: aid, url: 'https://sitea.example.evil.test/' });
    const plain = await VC.rpc('change-login', { id: aid, url: 'http://sitea.example/' });
    check('…and nothing on another site or over plain http', wrong.error === 'site' && !wrong.next && plain.error === 'site' && !plain.next);
    check('filling the normal login still uses the current password', (await VC.rpc('login', { id: aid })).password === 'alpha-Old-pass-1x');
    {
      const { session, BrowserWindow } = require('electron');
      const ses = session.fromPartition('smoke-fill');
      const FORMS = {
        '/hints': '<form><label>Current password <input type="password" autocomplete="current-password"></label><label>New password <input type="password" autocomplete="new-password"></label><label>Confirm <input type="password" autocomplete="new-password"></label><button>Save</button></form>',
        '/plain3': '<form><input type="password" name="p1"><input type="password" name="p2"><input type="password" name="p3"></form>',
        '/newconfirm': '<form><label>New password <input type="password" name="a"></label><label>Confirm new password <input type="password" name="b"></label></form>',
        '/oldnew': '<form><input type="password" id="oldpw"><input type="password" id="x2"></form>',
      };
      ses.protocol.handle('https', (req) => new Response(FORMS[new URL(req.url).pathname] || '<p>none</p>', { headers: { 'Content-Type': 'text/html' } }));
      const w = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { session: ses, sandbox: true, contextIsolation: true } });
      const fn = VC.fillChangeInPage.toString();
      const run = async (url, site = 'sitea.example') => {
        await w.loadURL(url);
        const r = await w.webContents.executeJavaScript(`(${fn})(${JSON.stringify('alpha-Old-pass-1x')}, ${JSON.stringify(pend1)}, ${JSON.stringify(site)})`);
        const vals = await w.webContents.executeJavaScript("[...document.querySelectorAll('input[type=password]')].map(i => i.value)");
        return { r, vals: vals.map((v) => (v === pend1 ? 'new' : v === 'alpha-Old-pass-1x' ? 'cur' : v ? '?' : '')) };
      };
      let t = await run('https://sitea.example/hints');
      check('change form with autocomplete hints: current, new, confirm', t.vals.join() === 'cur,new,new', t.vals.join());
      t = await run('https://sitea.example/plain3');
      check('change form without hints: the first field gets the current password', t.vals.join() === 'cur,new,new', t.vals.join());
      t = await run('https://sitea.example/newconfirm');
      check('new + confirm form: both get the new password', t.vals.join() === 'new,new', t.vals.join());
      t = await run('https://sitea.example/oldnew');
      check('“old” field gets the current password, the other the new one', t.vals.join() === 'cur,new', t.vals.join());
      t = await run('https://evil.example/hints');
      check('the page filler refuses a page on another site', t.r.wrongSite === true && t.vals.join() === ',,', t.vals.join());
      w.destroy();
    }

    // "It Didn't Work": the pending password goes, the old one stays
    await js("document.getElementById('pendingNo').click()");
    await waitFor(`!${byName('Alpha Site')}.pending`);
    a = await item('Alpha Site');
    check('“It Didn’t Work” drops the new password and keeps the old one', !a.pending && a.password === 'alpha-Old-pass-1x' && !(a.history || []).length && !diskItem('Alpha Site').pending);

    // a second try, answered "It Worked" in the question that comes when Vault is back
    clearOpened();
    await js("document.getElementById('changePwBtn').click()");
    await waitOpened('https://sitea.example/.well-known/change-password');
    a = await item('Alpha Site');
    const pend2 = a.pending && a.pending.value;
    secrets.push(pend2);
    check('a new try makes a new password', pend2 && pend2 !== pend1);
    await js("state.changeAwait.at = Date.now() - 5000; window.dispatchEvent(new Event('focus')); true");
    await waitFor("document.getElementById('changeDlg').open", 3000);
    await js("document.getElementById('changeYes').click()");
    await waitFor(`!${byName('Alpha Site')}.pending`);
    a = await item('Alpha Site');
    check('“It Worked”: the new password is current, the old one in history, change date updated',
      a.password === pend2 && a.history && a.history[0].value === 'alpha-Old-pass-1x' && a.pwChangedAt > Date.now() - 60000 && diskItem('Alpha Site').password === pend2);
    await shot('42-change-done');

    // the hand-checked list (Netflix answers 200 to anything, so its /.well-known can't be trusted)
    clearOpened();
    const netflix = 'window.__vaultState.items.find(i => /Netflix/.test(i.title))';
    await js(`changePassword(${netflix}); true`);
    check('sites that answer 200 to anything get the hand-checked change page', await waitOpened('https://www.netflix.com/password'), opened.join(' '));
    await js(`answerChange(${netflix}, false); true`);
    await waitFor(`!${netflix}.pending`);

    // ---- 2. forced close before answering: a second Vault on a copy of this vault, killed mid-change ----
    {
      const dir = fs.mkdtempSync(path.join(app.getPath('temp'), 'vault-smoke-child-'));
      fs.copyFileSync(vaultPath(), path.join(dir, 'vault.json'));
      const child = spawn(process.execPath, [path.join(__dirname, '..'), '--smoke-child'], {
        env: { ...process.env, VAULT_SMOKE_DIR: dir, VAULT_SMOKE_MASTER: MASTER, VAULT_SMOKE_TITLE: 'Beta Site', VAULT_SMOKE_SITE_BASE: B, ELECTRON_ENABLE_LOGGING: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const said = await new Promise((resolve) => {
        let out = '';
        const done = (v) => { clearTimeout(timer); resolve(v); };
        const timer = setTimeout(() => done(out), 60000);
        child.stdout.on('data', (d) => { out += d; if (/OPENED |NOT-OPENED|CHILD-FAILED/.test(out)) done(out); });
        child.on('exit', () => done(out));
      });
      check('the second Vault opened Beta’s change page (no standard page, no known link: the home page)', /OPENED https:\/\/siteb\.example\//.test(said), said.trim().slice(-120));
      child.kill('SIGKILL'); // forced close, no chance to tidy up
      await new Promise((r) => { if (child.exitCode !== null) r(); else child.once('exit', r); setTimeout(r, 5000); });
      const after = VF.readPayload(JSON.parse(fs.readFileSync(path.join(dir, 'vault.json'), 'utf8')), test.getSession().key);
      const beta = diskItem('Beta Site', after);
      check('after a forced close the pending password is still in the vault file, the old one untouched', !!(beta && beta.pending && beta.pending.value) && beta.password === 'beta-Old-pass-2y');
      secrets.push(beta && beta.pending && beta.pending.value);
      // Open that vault here, as after a restart: the account still shows the change in progress.
      await relock();
      fs.copyFileSync(path.join(dir, 'vault.json'), vaultPath());
      await unlockUI();
      await js(`setView('all'); select(${byName('Beta Site')}.id); true`);
      check('after the restart the account still shows the change in progress', await waitFor("!!document.getElementById('pendingNotice')", 3000) && (await js(`/Changing password/.test(document.getElementById('row-' + ${byName('Beta Site')}.id).textContent)`)));
      await js("document.getElementById('pendingYes').click()");
      await waitFor(`!${byName('Beta Site')}.pending`);
      const b2 = await item('Beta Site');
      check('…and answering then still saves it', b2.password === beta.pending.value && b2.history[0].value === 'beta-Old-pass-2y');
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }

    // ---- 3. breach check: off by default, k-anonymity, padding ----
    const before = log.filter((x) => x.site === 'hibp').length;
    const off = await js('api.breachCheck()');
    check('breach check is off by default and sends nothing', off && off.on === false && before === 0 && !(await js('state.breachOn')));
    await js("setBreachCheck(true); true");
    await waitFor("document.getElementById('alert').open", 3000);
    check('turning it on explains in one line what is sent', await js("/first 5 characters/.test(document.getElementById('alertBody').textContent) && /Have I Been Pwned/.test(document.getElementById('alertBody').textContent)"));
    await shot('43-breach-on');
    await js("document.getElementById('alertOk').click()");
    await waitFor(`state.breach.get(${byName('Gamma Site')}.id) === 4242`, 8000);
    const hibp = log.filter((x) => x.site === 'hibp');
    check('only 5-character hash prefixes are sent, with the Add-Padding header', hibp.length > 0 && hibp.every((x) => /^\/range\/[0-9A-F]{5}$/.test(x.path) && x.padding === 'true'));
    check('padding lines (count 0) are ignored; the breached password is found', await js(`state.breach.size === 1 && state.breach.get(${byName('Gamma Site')}.id) === 4242`));
    await js(`setView('security'); select(${byName('Gamma Site')}.id); true`);
    check('the account says how often its password was found', await waitFor("/shows up 4,242 times/.test(document.querySelector('.notice.warn').textContent)", 3000));
    check('breached accounts come first in Security', await js("/Gamma Site/.test(document.querySelector('#list .row .row-title').textContent) && /data breach/.test(document.querySelector('#list .row').textContent)"));
    const n1 = hibp.length;
    await js('refreshBreaches()');
    await wait(500);
    check('results are kept in the vault, so the same passwords aren’t looked up again for a week', log.filter((x) => x.site === 'hibp').length === n1 && Object.keys(test.getExtra().breach || {}).length > 0);

    // ---- 4. the change queue ----
    await js("setView('security'); true");
    check('Security offers to fix the passwords one by one', await waitFor("!document.getElementById('listTool').hidden && /Start/.test(document.getElementById('listTool').textContent)", 3000));
    await js("document.getElementById('queueGo').click()");
    await waitFor("!!document.getElementById('queueBar')", 3000);
    const q1 = JSON.parse(await js('JSON.stringify(state.ui.changeQueue)'));
    check('the queue starts with the breached account', (await item('Gamma Site')).id === q1.ids[0] && (await js("state.selectedId === state.ui.changeQueue.ids[0]")) && (await js(`/1 of ${q1.ids.length}/.test(document.getElementById('queueBar').textContent)`)));
    await shot('44-queue');
    clearOpened();
    await js("document.getElementById('changePwBtn').click()");
    await waitOpened('https://sitec.example/');
    secrets.push((await item('Gamma Site')).pending.value);
    await js("document.getElementById('pendingYes').click()");
    check('“It Worked” moves the queue to the next account', await waitFor(`state.ui.changeQueue.pos === 1 && state.ui.changeQueue.done.includes(${JSON.stringify(q1.ids[0])}) && state.selectedId === state.ui.changeQueue.ids[1]`, 4000));
    await js("document.getElementById('queueSkip').click()");
    check('Skip moves on too', await waitFor("state.ui.changeQueue.pos === 2 && state.ui.changeQueue.skipped.length === 1", 3000) || (await js("state.ui.changeQueue.pos >= 2")));
    await js("document.getElementById('queueStop').click()");
    const saved = JSON.parse(await js('JSON.stringify(state.ui.changeQueue)'));
    await relock();
    await unlockUI();
    await js("setView('security'); true");
    check('the queue’s progress survives locking', await waitFor(`/Continue/.test(document.getElementById('listTool').textContent) && /${saved.pos} of ${saved.ids.length} done/.test(document.getElementById('listTool').textContent)`, 4000), await js("document.getElementById('listTool').textContent"));
    await js("document.getElementById('queueGo').click()");
    check('Continue picks up where it stopped', await waitFor(`state.selectedId === ${JSON.stringify(saved.ids[saved.pos])} && !!document.getElementById('queueBar')`, 3000) || saved.pos >= saved.ids.length);
    await js("queueStep('close')");
    await waitFor('!state.ui.changeQueue');

    // ---- 5. Change Email Everywhere ----
    await js("setView('all'); handleCommand('email-change'); true");
    await waitFor("!!document.getElementById('emOld')", 3000);
    await js(`(() => { const o = document.getElementById('emOld'); o.value = 'old.me@example.com'; o.dispatchEvent(new Event('input')); document.getElementById('emFind').click(); })()`);
    await waitFor("document.querySelectorAll('.em-row').length > 0", 3000);
    const rows = await js("[...document.querySelectorAll('.em-row .row-title')].map(e => e.textContent).join(',')");
    check('it lists every account on the old email (case and spaces don’t matter)', rows === 'Alpha Site,Beta Site,Gamma Site', rows);
    check('each has a link to the site (known email page, else the home page)', await js("[...document.querySelectorAll('.em-row .btn-plain')].every(b => /Open Site|Email Settings/.test(b.textContent))") && JSON.stringify(await js("window.accountEmailPage({ website: 'github.com' })")) === JSON.stringify({ url: 'https://github.com/settings/emails', known: true }));
    await js(`(() => { const n = document.getElementById('emNew'); n.value = 'new.me@example.com'; n.dispatchEvent(new Event('input')); n.dispatchEvent(new Event('change')); })()`);
    await wait(200);
    await js(`(() => { const c = document.querySelector('.em-row[data-id="' + ${byName('Alpha Site')}.id + '"] input[type=checkbox]'); c.checked = true; c.dispatchEvent(new Event('change')); })()`);
    await waitFor(`${byName('Alpha Site')}.username === 'new.me@example.com'`, 3000);
    a = await item('Alpha Site');
    check('ticking “done” puts the new email on the account and the old one in its history', a.username === 'new.me@example.com' && a.history.some((x) => x.kind === 'username' && x.value === 'old.me@example.com'));
    check('the checklist shows the progress', await waitFor("/1 of 3 done/.test(document.getElementById('emProgress').textContent)", 2000));
    await shot('45-email-everywhere');
    await relock();
    await unlockUI();
    await js("handleCommand('email-change'); true");
    check('its progress survives locking', await waitFor(`/1 of 3 done/.test(document.getElementById('emProgress').textContent) && document.getElementById('emNew').value === 'new.me@example.com' && document.querySelector('.em-row[data-id="' + ${byName('Alpha Site')}.id + '"] input').checked`, 4000));
    await js(`(() => { const c = document.querySelector('.em-row[data-id="' + ${byName('Alpha Site')}.id + '"] input[type=checkbox]'); c.checked = false; c.dispatchEvent(new Event('change')); })()`);
    await waitFor(`${byName('Alpha Site')}.username === 'old.me@example.com'`, 3000);
    a = await item('Alpha Site');
    check('unticking puts the old email back', a.username === 'old.me@example.com' && !a.history.some((x) => x.kind === 'username'));
    await js(`(() => { const c = document.querySelector('.em-row[data-id="' + ${byName('Alpha Site')}.id + '"] input[type=checkbox]'); c.checked = true; c.dispatchEvent(new Event('change')); })()`);
    await waitFor(`${byName('Alpha Site')}.username === 'new.me@example.com'`, 3000);
    await js(`select(${byName('Alpha Site')}.id)`);
    check('the account lists its previous user name', await waitFor("[...document.querySelectorAll('.section-label')].some(l => l.textContent === 'Previous User Names')", 2000));
    const settings = fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8');
    check('settings file has only the on/off switch, no results or progress', /"breachCheck":true/.test(settings) && !/old\.me|new\.me|changeQueue|sitea/.test(settings));
    await js("setBreachCheck(false); true");
    await wait(300);
    // leave the vault as the rest of the smoke test expects it
    await js(`(async () => { state.items = state.items.filter(i => !/^(Alpha|Beta|Gamma) Site$/.test(i.title)); state.selectedId = null; await persist(); setView('all'); render(); return true; })()`);
  } catch (err) {
    check('password-change tests crashed', false, err && err.stack);
  }
  for (const s of servers) s.close();
  PW._test.base = () => B;
  return { secrets: secrets.filter(Boolean) };
};
