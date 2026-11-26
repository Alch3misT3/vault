'use strict';
/* A website asks Vault for a passkey (through the browser extension). The user confirms here;
   Vault signs in its main process. "Use Another Device" hands the request back to the browser. */

const $ = (s) => document.querySelector(s);
const P = window.vaultPrompt;
let st = null;
let sel = 0;
let busy = false;

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}
const svgUse = (id) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  u.setAttribute('href', '#' + id);
  s.append(u);
  return s;
};
const COLORS = ['#0a6cff', '#5856d6', '#9b4dca', '#d6245a', '#d9352b', '#c25e00', '#1d8f47', '#11809a', '#3a5bd9', '#0f8a7a'];
function siteColor(site) {
  let x = 0;
  for (const ch of String(site)) x = (x * 31 + ch.codePointAt(0)) >>> 0;
  return COLORS[x % COLORS.length];
}
const ago = (t) => {
  if (!t) return 'Never used';
  const d = Math.round((Date.now() - t) / 86400000);
  return d <= 0 ? 'Used today' : d === 1 ? 'Used yesterday' : `Used ${d} days ago`;
};

function render(next) {
  st = next;
  if (!st) return;
  const site = st.site;
  const tile = $('#pTile');
  tile.textContent = (site.replace(/^www\./, '').match(/[a-z0-9]/i) || ['?'])[0].toUpperCase();
  tile.style.setProperty('--tile', siteColor(st.rpId));
  const shown = (id, on) => { $(id).hidden = !on; };
  shown('#pLock', st.locked); shown('#pCreate', !st.locked && st.op === 'create'); shown('#pGet', !st.locked && st.op === 'get');
  const via = `${st.browser} is asking${st.rpId !== site ? ` (for ${st.rpId})` : ''}.`;

  if (st.locked) {
    $('#pTitle').textContent = st.op === 'create' ? `Save a passkey for ${site}` : `Sign in to ${site}`;
    $('#pSub').textContent = `${via} Unlock Vault to continue.`;
    $('#pPasskey').hidden = !(st.passkeys && st.passkeys.length);
    $('#pGo').hidden = true;
    setTimeout(() => $('#ppw').focus(), 30);
    return;
  }
  $('#pGo').hidden = false;
  $('#pErr').textContent = '';
  if (st.op === 'create') {
    $('#pTitle').textContent = `Save a passkey for ${site}?`;
    $('#pSub').textContent = via;
    $('#pAccount').textContent = st.account || 'Account';
    $('#pAccountSub').textContent = st.displayName && st.displayName !== st.account ? st.displayName : (st.rpName || st.rpId);
    $('#pExists').hidden = !st.exists;
    $('#pCreateNote').hidden = !!st.exists;
    $('#pGo').textContent = st.exists ? 'OK' : 'Save Passkey';
    $('#pGo').focus();
    return;
  }
  // sign in
  const list = st.accounts || [];
  $('#pTitle').textContent = `Sign in to ${site}`;
  $('#pSub').textContent = list.length ? `${via} Choose the account.` : via;
  $('#pNone').hidden = !!list.length;
  $('#pNone').textContent = `Vault has no passkey for ${site}. Use another device, such as your phone or a security key.`;
  $('#pGo').hidden = !list.length;
  sel = Math.min(sel, Math.max(0, list.length - 1));
  $('#pAccounts').replaceChildren(...list.map((a, i) => h('li', {
    class: 'q-row', role: 'option', 'aria-selected': String(i === sel), 'data-id': a.id,
    onclick: () => { sel = i; render(st); }, ondblclick: () => { sel = i; go(); },
  }, svgUse('i-person'), h('div', { class: 'q-text' }, h('div', { class: 'q-title' }, a.userName || a.displayName || 'Account'), h('div', { class: 'q-sub' }, ago(a.lastUsed))), null)));
  $('#pGo').textContent = 'Sign In';
  if (list.length) $('#pGo').focus(); else $('#pOther').focus();
}

async function answer(action) {
  if (busy || !st) return;
  busy = true;
  const acc = st.accounts && st.accounts[sel];
  const r = await P.answer(action, acc ? acc.id : '');
  busy = false;
  if (!r || !r.ok) render(await P.state());
}
const go = () => answer('confirm');

// ---- unlocking ----
function lockError(msg, info) { $('#pErr').textContent = msg; $('#pErr').classList.toggle('pk-info', !!info); }
async function afterUnlock(r) {
  if (!r || !r.ok) return lockError(r && r.error === 'wrong' ? 'Wrong password. Try again.' : 'Couldn’t unlock.');
  $('#ppw').value = '';
  render(r.state);
}
$('#pLock').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = $('#ppw').value;
  if (!pw || busy) return;
  busy = true; lockError('');
  const r = await P.unlock(pw);
  busy = false;
  if (r && !r.ok) $('#ppw').select();
  afterUnlock(r);
});
const bytesOf = (b64s) => Uint8Array.from(atob(b64s), (c) => c.charCodeAt(0));
const fromB64url = (s) => bytesOf(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
const b64of = (buf) => { let s = ''; for (const x of new Uint8Array(buf)) s += String.fromCharCode(x); return btoa(s); };
$('#pPasskey').addEventListener('click', async () => {
  if (busy || !st || !st.passkeys) return;
  busy = true; lockError('');
  try {
    const evalBy = {};
    for (const p of st.passkeys) evalBy[p.id] = { first: bytesOf(p.salt) };
    const cred = await navigator.credentials.get({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: location.hostname, userVerification: 'required', timeout: 120000,
      allowCredentials: st.passkeys.map((p) => ({ type: 'public-key', id: fromB64url(p.id), ...(p.transports.length ? { transports: p.transports } : {}) })),
      extensions: { prf: { evalByCredential: evalBy } },
    } });
    const p = cred.getClientExtensionResults().prf;
    const out = p && p.results && p.results.first;
    if (!out) { lockError('That passkey didn’t give Vault its unlock key. Use your master password.'); return; }
    await afterUnlock(await P.unlockPasskey(cred.id, b64of(out)));
  } catch (e) {
    lockError(e && (e.name === 'NotAllowedError' || e.name === 'AbortError') ? 'Cancelled or timed out.' : 'Something went wrong. Use your master password.', true);
  } finally { busy = false; }
});

// ---- buttons and keys ----
$('#pGo').addEventListener('click', go);
$('#pCancel').addEventListener('click', () => answer('cancel'));
$('#pOther').addEventListener('click', () => answer('other'));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); answer('cancel'); return; }
  if (!st || st.locked) return;
  const n = (st.accounts || []).length;
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && n) { e.preventDefault(); sel = (sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n; render(st); return; }
  if (e.key === 'Enter' && document.activeElement && document.activeElement.tagName !== 'BUTTON') { e.preventDefault(); go(); }
});

P.onUpdate((next) => {
  sel = 0;
  const panel = $('#panel');
  panel.classList.remove('opening'); void panel.offsetWidth; panel.classList.add('opening');
  render(next);
});
P.state().then((s) => { if (s) render(s); });
