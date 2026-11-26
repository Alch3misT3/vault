'use strict';
// Smoke test, piece 2: unlock with a passkey (WebAuthn PRF) and the vault file format.
// Uses Chromium's virtual authenticators (one with PRF, one without), so no phone or key is needed.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const VF = require('../vaultfile');

module.exports = async function passkeyChecks({ app, win, js, wait, waitFor, shot, check, vaultPath, relock, test, MASTER }) {
  const wc = win.webContents;
  const dbg = wc.debugger;
  const cdp = (m, p) => dbg.sendCommand(m, p || {});
  const attach = async () => {
    if (!dbg.isAttached()) dbg.attach('1.3');
    await cdp('Emulation.setFocusEmulationEnabled', { enabled: true }); // WebAuthn needs a focused page
    await cdp('WebAuthn.enable', { enableUI: false });
  };
  const authenticator = async (prf) => (await cdp('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'usb', hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, hasPrf: prf, hasHmacSecret: prf, automaticPresenceSimulation: true,
  } })).authenticatorId;
  const readFile = () => JSON.parse(fs.readFileSync(vaultPath(), 'utf8'));
  const typeIn = (id, v) => js(`(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input')); })()`);
  const unlockPw = async (pw) => { await typeIn('pw1', pw); await js("document.getElementById('unlockGo').click()"); return waitFor("!document.getElementById('app').hidden", 10000); };
  const status = () => js("document.getElementById('pkStatus').textContent");
  const listText = () => js("document.getElementById('pkList').textContent");
  const addVia = async (name, pw) => {
    await typeIn('pkName', name); await typeIn('pkPw', pw);
    await js("document.getElementById('pkAdd').click()");
    await waitFor("!document.getElementById('pkAdd').disabled", 15000);
  };
  const itemsBefore = await js('window.__vaultState.items.length');

  // ---------- the file format ----------
  const f0 = readFile();
  check('vault file v2: a random vault key, wrapped by the master password (scrypt 2^18)',
    f0.version === 2 && f0.keys && f0.keys.password && Buffer.from(f0.keys.password.tag, 'base64').length === 16 && f0.kdf.N === 2 ** 18 && Array.isArray(f0.keys.passkeys));
  {
    const pwKey = await VF.deriveKey(MASTER, Buffer.from(f0.kdf.salt, 'base64'), VF.kdfOf(f0));
    const K = VF.unwrapWithPassword(f0, pwKey);
    check('the vault key is not the password key, and it opens the data', K.length === 32 && !K.equals(pwKey) && Array.isArray(VF.readPayload(f0, K).items));
    let swapped = false; try { VF.open(K, f0.keys.password, VF.AAD.data); } catch { swapped = true; }
    check('boxes are bound to their role (a key box can’t pass as the data box)', swapped);
  }

  await attach();

  // ---------- a passkey without PRF is refused ----------
  const noPrf = await authenticator(false);
  await js('passkeysFlow()');
  await waitFor("document.getElementById('passkeysDlg').open");
  check('settings: no passkeys at first', /No passkeys yet/.test(await listText()));
  await addVia('Old key', MASTER);
  check('a passkey without PRF is refused with a plain message, nothing added', /doesn’t support PRF/.test(await status()) && /No passkeys yet/.test(await listText()) && readFile().keys.passkeys.length === 0, await status());
  await shot('42-passkey-no-prf');
  await cdp('WebAuthn.removeVirtualAuthenticator', { authenticatorId: noPrf });

  // ---------- add one (master password needed) ----------
  const auth = await authenticator(true);
  await addVia('Test key', 'wrong password');
  check('adding a passkey needs the master password', /Master password is wrong/.test(await status()) && readFile().keys.passkeys.length === 0);
  await addVia('Test key', MASTER);
  const f1 = readFile();
  const entry = f1.keys.passkeys[0];
  check('a PRF passkey is added: listed with its name and date', /Test key/.test(await listText()) && /Added /.test(await listText()) && f1.keys.passkeys.length === 1, await status());
  check('the passkey stores only a wrapped key (id, name, date, PRF salt, sealed box)', entry && entry.id && entry.salt && entry.iv && Buffer.from(entry.tag, 'base64').length === 16 && Object.keys(entry).sort().join() === 'added,data,id,iv,name,salt,tag,transports');
  check('the .bak is refreshed when the keys change', fs.readFileSync(vaultPath() + '.bak', 'utf8') === fs.readFileSync(vaultPath(), 'utf8'));
  await shot('40-passkeys-dialog');
  await addVia('Same key again', MASTER);
  check('the same passkey can’t be added twice', /already added/.test(await status()) && readFile().keys.passkeys.length === 1, await status());
  await js("document.getElementById('passkeysDlg').close()");

  // ---------- unlock with it ----------
  await relock();
  await attach();
  check('lock screen offers “Unlock with Passkey”', await waitFor("!document.getElementById('pkUnlock').hidden"));
  await shot('41-lock-passkey');
  await js("document.getElementById('pkUnlock').click()");
  check('the passkey unlocks the vault (data decrypted, not just a yes/no)', (await waitFor("!document.getElementById('app').hidden", 10000)) && (await js('window.__vaultState.items.length')) === itemsBefore && !!test.getSession());

  await relock();
  await attach();
  const forged = await js(`window.vault.unlockPasskey(${JSON.stringify(entry.id)}, ${JSON.stringify(crypto.randomBytes(32).toString('base64'))})`);
  const unknown = await js(`window.vault.unlockPasskey('AAAAAAAAAAAAAAAAAAAAAA', ${JSON.stringify(crypto.randomBytes(32).toString('base64'))})`);
  check('a made-up PRF value unlocks nothing', forged.ok === false && unknown.ok === false && !test.getSession());
  check('the master password still unlocks', await unlockPw(MASTER));

  // ---------- remove ----------
  await js('passkeysFlow()');
  await waitFor("document.getElementById('passkeysDlg').open");
  await js("document.querySelector('#pkList .pk-row .btn-plain').click()");
  await waitFor("document.getElementById('alert').open");
  await shot('43-passkey-remove');
  await js("document.getElementById('alertOk').click()");
  await waitFor("/No passkeys yet/.test(document.getElementById('pkList').textContent)");
  check('a passkey can be removed; it is gone from the file and its .bak', readFile().keys.passkeys.length === 0 && !fs.readFileSync(vaultPath() + '.bak', 'utf8').includes(entry.id));
  await js("document.getElementById('passkeysDlg').close()");
  await relock();
  check('with no passkeys the lock screen shows only the password', await js("document.getElementById('pkUnlock').hidden"));
  await unlockPw(MASTER);

  // ---------- a new master password removes passkeys and the old password opens nothing ----------
  await attach();
  await js('passkeysFlow()');
  await waitFor("document.getElementById('passkeysDlg').open");
  await addVia('Test key 2', MASTER);
  await js("document.getElementById('passkeysDlg').close()");
  await js('changePwFlow()');
  check('Change Master Password warns that passkeys must be added again', await waitFor("!document.getElementById('cpPasskeys').hidden"));
  await js("document.getElementById('changePw').close()");
  const NEW = 'brand new master pw';
  const kBefore = Buffer.from(test.getSession().key);
  const cp = await js(`window.vault.changePassword(${JSON.stringify(MASTER)}, ${JSON.stringify(NEW)}, window.__vaultState.items)`);
  const f2 = readFile();
  const bakF = JSON.parse(fs.readFileSync(vaultPath() + '.bak', 'utf8'));
  let oldOpensBak = true;
  try { VF.unwrapWithPassword(bakF, await VF.deriveKey(MASTER, Buffer.from(bakF.kdf.salt, 'base64'), VF.kdfOf(bakF))); } catch { oldOpensBak = false; }
  check('new master password: new vault key, passkeys removed, old password opens neither file nor .bak',
    cp.ok && cp.passkeysRemoved === 1 && f2.keys.passkeys.length === 0 && !test.getSession().key.equals(kBefore) && !oldOpensBak);
  await js(`window.vault.changePassword(${JSON.stringify(NEW)}, ${JSON.stringify(MASTER)}, window.__vaultState.items)`);

  // ---------- an old (version 1) vault still opens, is converted, and a backup is kept ----------
  await relock();
  const v2Text = fs.readFileSync(vaultPath(), 'utf8');
  const v2Bak = fs.readFileSync(vaultPath() + '.bak', 'utf8');
  const OLD_PW = 'my old vault pw';
  const salt = crypto.randomBytes(16);
  const v1Key = await VF.deriveKey(OLD_PW, salt, { N: 2 ** 17, r: 8, p: 1 });
  const oldItems = [{ id: 'old1', title: 'Old Site', username: 'olduser', password: 'old-Pa55', website: 'old.example', created: 1, updated: 1 },
    { id: 'old2', title: 'Second', username: 'two', password: 'two-Pa55', created: 1, updated: 1 }];
  // exactly what Vault 1.3 wrote
  const v1 = { app: 'vault', version: 1, kdf: { name: 'scrypt', N: 2 ** 17, r: 8, p: 1, salt: salt.toString('base64') }, cipher: 'aes-256-gcm', ...VF.sealJson(v1Key, { items: oldItems }, null) };
  const v1Text = JSON.stringify(v1);
  fs.writeFileSync(vaultPath(), v1Text);
  const backup = path.join(app.getPath('userData'), 'vault-v1-backup.json');
  check('an old-format vault: wrong password still refused', (await js(`window.vault.unlock('not it at all').then((r) => r.ok)`)) === false && fs.readFileSync(vaultPath(), 'utf8') === v1Text);
  const opened = await unlockPw(OLD_PW);
  const titles = await js("window.__vaultState.items.map((i) => i.title).sort().join()");
  const f3 = readFile();
  check('an old-format (Vault 1.3) vault opens with its password', opened && titles === 'Old Site,Second', titles);
  check('…and is converted: random vault key, scrypt raised to 2^18', f3.version === 2 && f3.kdf.N === 2 ** 18 && f3.kdf.salt !== v1.kdf.salt && !!f3.keys.password);
  check('…and the old file is kept as vault-v1-backup.json, still opening with the old password',
    fs.existsSync(backup) && fs.readFileSync(backup, 'utf8') === v1Text && VF.readV1(JSON.parse(fs.readFileSync(backup, 'utf8')), v1Key).items.length === 2);
  await relock();
  check('the converted vault opens again with the same password', await unlockPw(OLD_PW));
  // back to the test vault
  await relock();
  fs.writeFileSync(vaultPath(), v2Text);
  fs.writeFileSync(vaultPath() + '.bak', v2Bak);
  fs.rmSync(backup, { force: true });
  await unlockPw(MASTER);
  try { await cdp('WebAuthn.removeVirtualAuthenticator', { authenticatorId: auth }); } catch {}
  try { dbg.detach(); } catch {}
};
