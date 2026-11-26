'use strict';
// Smoke test, piece 3 (Vault side): passkeys for websites, asked for through the extension's channel.
// The real end-to-end run on webauthn.io in Edge is in ext-e2e.js (VAULT_EXT_E2E=1).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const b64u = (b) => Buffer.from(b).toString('base64url');
// Tiny CBOR reader, enough for an attestation object.
function cborRead(buf) {
  let i = 0;
  const len = (ai) => { if (ai < 24) return ai; if (ai === 24) return buf[i++]; if (ai === 25) { const v = buf.readUInt16BE(i); i += 2; return v; } const v = buf.readUInt32BE(i); i += 4; return v; };
  const item = () => {
    const b = buf[i++]; const major = b >> 5; const ai = b & 31;
    if (major === 0) return len(ai);
    if (major === 1) return -1 - len(ai);
    if (major === 2) { const n = len(ai); const v = buf.subarray(i, i + n); i += n; return v; }
    if (major === 3) { const n = len(ai); const v = buf.subarray(i, i + n).toString('utf8'); i += n; return v; }
    if (major === 5) { const n = len(ai); const m = new Map(); for (let k = 0; k < n; k++) { const key = item(); m.set(key, item()); } return m; }
    throw new Error('cbor ' + major);
  };
  return item();
}

module.exports = async function sitePasskeys({ app, win, js, wait, waitFor, shot, check, VC, test, relock, MASTER }) {
  const prompt = () => test.getPrompt();
  const pjs = (code) => prompt().webContents.executeJavaScript(code);
  const pWait = async (code, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (prompt() && prompt().isVisible() && (await pjs(code))) return true; } catch {} await wait(80); } return false; };
  // The prompt is an acrylic window, which capturePage can't see: grab it from the screen instead.
  const pShot = async (name) => {
    const w = prompt();
    w.setAlwaysOnTop(true, 'screen-saver'); w.moveTop(); w.webContents.invalidate();
    await wait(1200);
    try {
      const { screen } = require('electron');
      const b = w.getBounds(); const f = screen.getDisplayMatching(b).scaleFactor;
      require('child_process').execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'screen-shot.ps1'),
        '-x:' + Math.round(b.x * f), '-y:' + Math.round(b.y * f), '-w:' + Math.round(b.width * f), '-h:' + Math.round(b.height * f), '-out:' + path.join(__dirname, '..', 'smoke-shots', name + '.png')]);
    } catch (e) { console.log('prompt screenshot skipped', e.message); }
  };
  const ORIGIN = 'https://login.example.com';
  const challenge = () => b64u(crypto.randomBytes(32));
  let rid = 0;
  const ask = (op, options, origin = ORIGIN) => VC.rpc('passkey', { op, origin, options, requestId: 'r' + (++rid) }, 60000);
  const createOpts = (extra) => ({
    rp: { id: 'example.com', name: 'Example' }, user: { id: b64u(Buffer.from('user-42')), name: 'alice@example.com', displayName: 'Alice' },
    challenge: challenge(), pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }], excludeCredentials: [], extensions: { credProps: true }, ...extra,
  });

  // ---------- strict origin / rpId ----------
  const r1 = await ask('create', createOpts({ rp: { id: 'example.com', name: 'x' } }), 'https://evil.example');
  const r2 = await ask('create', createOpts(), 'http://login.example.com');
  const r3 = await ask('create', createOpts({ rp: { id: 'github.io', name: 'x' } }), 'https://someone.github.io');
  const r4 = await ask('get', { challenge: challenge(), rpId: 'example.com' }, 'https://example.com.evil.net');
  check('strict origin and rpId: another domain, http, a public suffix (github.io) are all refused',
    [r1, r2, r3, r4].every((r) => r.error === 'SecurityError') && !(prompt() && prompt().isVisible()), JSON.stringify([r1, r2, r3, r4].map((r) => r.error)));
  const rsa = await ask('create', createOpts({ pubKeyCredParams: [{ type: 'public-key', alg: -257 }] }));
  check('a site that doesn’t accept ES256 keys goes to the browser’s own flow', rsa.fallback === true);
  const none = await ask('get', { challenge: challenge(), rpId: 'nothing-saved.example' }, 'https://nothing-saved.example');
  check('signing in where Vault has no passkey goes straight to the browser (no prompt)', none.fallback === true && !(prompt() && prompt().isVisible()));

  // ---------- save a passkey ----------
  const cOpts = createOpts();
  const pCreate = ask('create', cOpts);
  check('Vault shows its confirmation: site and account', await pWait("document.getElementById('pTitle').textContent.includes('login.example.com') && document.getElementById('pAccount').textContent === 'alice@example.com' && !document.getElementById('pOther').hidden"));
  check('the prompt panel fills its window', await pjs("getComputedStyle(document.getElementById('panel')).height === innerHeight + 'px' && innerHeight > 300"),
    await pjs("(() => { const p = document.getElementById('panel'); const cs = getComputedStyle(p); return JSON.stringify({ h: p.getBoundingClientRect().height, vh: innerHeight, cls: p.className, pos: cs.position, height: cs.height, inset: cs.inset, top: cs.top, bottom: cs.bottom, sheets: [...document.styleSheets].map((x) => x.href) }); })()"));
  await pShot('44-passkey-save');
  await pjs("document.getElementById('pGo').click()");
  const made = await pCreate;
  const cred = made.credential;
  const cd = JSON.parse(Buffer.from(cred.response.clientDataJSON, 'base64url'));
  const att = cborRead(Buffer.from(cred.response.attestationObject, 'base64url'));
  const ad = att.get('authData');
  const rpHash = crypto.createHash('sha256').update('example.com').digest();
  check('the new passkey: clientData has the browser-given origin and the challenge; fmt none; rpId hash; flags UP UV AT',
    cd.type === 'webauthn.create' && cd.origin === ORIGIN && cd.challenge === cOpts.challenge && att.get('fmt') === 'none' && ad.subarray(0, 32).equals(rpHash) && (ad[32] & 0x45) === 0x45,
    JSON.stringify(cd));
  const credIdLen = ad.readUInt16BE(53);
  const cose = cborRead(ad.subarray(55 + credIdLen));
  check('Vault’s own AAGUID is in the attested data (not all zeros)', ad.subarray(37, 53).toString('hex') === '579acacd24d8439e91e2192c530972bb');
  check('the public key is ES256 (COSE P-256) and matches the SPKI copy', cose.get(3) === -7 && cose.get(1) === 2 && cose.get(-1) === 1 && cred.response.publicKeyAlgorithm === -7 &&
    crypto.createPublicKey({ key: Buffer.from(cred.response.publicKey, 'base64url'), format: 'der', type: 'spki' }).export({ format: 'jwk' }).x === b64u(cose.get(-2)));
  const saved = test.sitePasskeys();
  check('saved in the vault as kind "passkey": site, account, user handle, credential id, private key, counter, date',
    saved.length === 1 && ['kind', 'rpId', 'userName', 'userHandle', 'credentialId', 'privateKey', 'signCount', 'created'].every((k) => k in saved[0]) && saved[0].kind === 'passkey' && saved[0].credentialId === cred.id);
  const fileText = fs.readFileSync(path.join(app.getPath('userData'), 'vault.json'), 'utf8');
  check('the private key is stored encrypted only, and never sent to the browser', !fileText.includes(saved[0].privateKey) && !fileText.includes('example.com') && !JSON.stringify(made).includes(saved[0].privateKey) && !('privateKey' in cred));
  check('credProps reports a discoverable passkey', cred.clientExtensionResults.credProps && cred.clientExtensionResults.credProps.rk === true);

  // the Passkeys view in the main window
  await waitFor("window.__vaultState.sitePasskeys.length === 1");
  await js("setView('passkeys')");
  check('Passkeys view lists it (site and account)', await waitFor("/example\\.com/.test(document.getElementById('list').textContent) && /alice@example\\.com/.test(document.getElementById('list').textContent)"));
  await js("select(window.__vaultState.sitePasskeys[0].id)");
  await waitFor("/Last used/.test(document.getElementById('detail').textContent)");
  await shot('45-passkeys-view');
  check('the window never gets the private key', await js("!JSON.stringify(window.__vaultState.sitePasskeys).includes('privateKey')"));

  // ---------- sign in with it ----------
  const pub = crypto.createPublicKey({ key: Buffer.from(cred.response.publicKey, 'base64url'), format: 'der', type: 'spki' });
  const verify = (r, ch) => {
    const a = Buffer.from(r.response.authenticatorData, 'base64url'); const c = Buffer.from(r.response.clientDataJSON, 'base64url');
    const ok = crypto.verify('sha256', Buffer.concat([a, crypto.createHash('sha256').update(c).digest()]), pub, Buffer.from(r.response.signature, 'base64url'));
    const j = JSON.parse(c);
    return { ok: ok && j.type === 'webauthn.get' && j.challenge === ch && j.origin === ORIGIN && a.subarray(0, 32).equals(rpHash), counter: a.readUInt32BE(33), user: r.response.userHandle };
  };
  let ch = challenge();
  const pGet = ask('get', { challenge: ch, rpId: 'example.com', allowCredentials: [] });
  check('sign in: Vault lists the account to confirm', await pWait("document.querySelectorAll('#pAccounts .q-row').length === 1 && /alice@example.com/.test(document.getElementById('pAccounts').textContent)"));
  await pShot('46-passkey-signin');
  await pjs("document.getElementById('pGo').click()");
  const g1 = verify((await pGet).credential, ch);
  check('the signature verifies with the saved public key; counter 1; user handle returned', g1.ok && g1.counter === 1 && g1.user === b64u(Buffer.from('user-42')), JSON.stringify(g1));

  // "Use another device" and Cancel
  const pOther = ask('get', { challenge: challenge(), rpId: 'example.com' });
  await pWait("!document.getElementById('pOther').hidden && document.querySelectorAll('#pAccounts .q-row').length === 1");
  await pjs("document.getElementById('pOther').click()");
  check('“Use Another Device” hands the request back to the browser', (await pOther).fallback === true);
  const pCancel = ask('get', { challenge: challenge(), rpId: 'example.com' });
  await pWait("document.querySelectorAll('#pAccounts .q-row').length === 1");
  await pjs("document.getElementById('pCancel').click()");
  check('Cancel gives the site NotAllowedError', (await pCancel).error === 'NotAllowedError');

  // already saved
  const pEx = ask('create', createOpts({ excludeCredentials: [{ type: 'public-key', id: cred.id }] }));
  check('an account that already has a Vault passkey is recognised', await pWait("!document.getElementById('pExists').hidden"));
  await pjs("document.getElementById('pGo').click()");
  check('…and the site is told (InvalidStateError), nothing new saved', (await pEx).error === 'InvalidStateError' && test.sitePasskeys().length === 1);

  // the page gives up (AbortSignal)
  const pAbort = ask('get', { challenge: challenge(), rpId: 'example.com' });
  await pWait("document.querySelectorAll('#pAccounts .q-row').length === 1");
  await VC.rpc('passkey-cancel', { requestId: 'r' + rid });
  check('when the page aborts, Vault’s prompt closes', (await pAbort).error === 'AbortError' && (await (async () => { for (let i = 0; i < 20 && prompt().isVisible(); i++) await wait(50); return !prompt().isVisible(); })()));

  // ---------- locked: unlock first ----------
  await relock();
  ch = challenge();
  const pLocked = ask('get', { challenge: ch, rpId: 'example.com' });
  check('locked Vault: the prompt asks to unlock first, without showing accounts', await pWait("!document.getElementById('pLock').hidden && document.getElementById('pGet').hidden && !/alice/.test(document.body.textContent)"));
  await pShot('47-passkey-locked');
  await pjs("document.getElementById('ppw').value = 'wrong one'; document.getElementById('pLock').requestSubmit(); true");
  check('a wrong master password in the prompt is refused', await pWait("/Wrong password/.test(document.getElementById('pErr').textContent)"));
  await pjs(`document.getElementById('ppw').value = ${JSON.stringify(MASTER)}; document.getElementById('pLock').requestSubmit(); true`);
  check('after unlocking in the prompt the account is offered', await pWait("document.querySelectorAll('#pAccounts .q-row').length === 1", 10000));
  await pjs("document.getElementById('pGo').click()");
  const g2 = verify((await pLocked).credential, ch);
  check('signing in after unlocking works; counter 2', g2.ok && g2.counter === 2, JSON.stringify(g2));
  check('unlocking in the prompt also unlocks the window', await waitFor("!document.getElementById('app').hidden"));

  // locking while the prompt shows accounts: it starts over and asks to unlock
  const pMid = ask('get', { challenge: challenge(), rpId: 'example.com' });
  await pWait("document.querySelectorAll('#pAccounts .q-row').length === 1");
  const fresh = new Promise((r) => win.webContents.once('did-finish-load', r));
  test.lockVault();
  await Promise.race([fresh, wait(6000)]);
  check('locking Vault clears the prompt and it asks to unlock again', await pWait("!document.getElementById('pLock').hidden && !/alice/.test(document.body.textContent)", 8000));
  await pjs("document.getElementById('pCancel').click()");
  await pMid;
  await waitFor("window.__vaultState && !document.getElementById('lock').hidden");
  await js(`(() => { const el = document.getElementById('pw1'); el.value = ${JSON.stringify(MASTER)}; el.dispatchEvent(new Event('input')); document.getElementById('unlockGo').click(); })()`);
  await waitFor("!document.getElementById('app').hidden");

  // ---------- delete from the Passkeys view ----------
  await waitFor("window.__vaultState.sitePasskeys.length === 1");
  // (don't wait on deleteItem's promise: it settles only when the dialog closes)
  await js("setView('passkeys'); select(window.__vaultState.sitePasskeys[0].id); deleteItem(window.__vaultState.sitePasskeys[0]); true");
  await waitFor("document.getElementById('alert').open");
  await js("document.getElementById('alertOk').click()");
  const gone = await waitFor("window.__vaultState.sitePasskeys.length === 0");
  check('a passkey can be deleted from the Passkeys view', gone && test.sitePasskeys().length === 0,
    JSON.stringify({ gone, main: test.sitePasskeys().length, page: await js("[window.__vaultState.sitePasskeys.length, document.getElementById('alert').open, document.getElementById('toast').textContent, state.view, state.selectedId]") }));
  await js("setView('all')");
};
