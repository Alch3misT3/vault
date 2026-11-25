'use strict';
/* global chrome, VaultClient */
const $ = (s) => document.querySelector(s);
let tab = null;
let items = [];
let sel = 0;
let searchTimer;

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
const icon = (id) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  u.setAttribute('href', '#' + id);
  s.append(u);
  return s;
};
const COLORS = ['#0a6cff', '#5856d6', '#9b4dca', '#d6245a', '#d9352b', '#c25e00', '#1d8f47', '#11809a', '#3a5bd9', '#0f8a7a'];
function tile(it) {
  let x = 0;
  for (const ch of String(it.title).toLowerCase()) x = (x * 31 + ch.codePointAt(0)) >>> 0;
  const t = h('div', { class: 'tile', 'aria-hidden': 'true' }, ((it.title.match(/[\p{L}\p{N}]/u) || ['?'])[0]).toUpperCase());
  t.style.setProperty('--tile', window.brandColor({ title: it.title, website: it.host }) || COLORS[x % COLORS.length]); // same colours as the app
  return t;
}

function show(id) { for (const s of ['vPair', 'vOffline', 'vLocked', 'vList']) $('#' + s).hidden = s !== id; }
let statusTimer;
function status(msg, kind) {
  const s = $('#status');
  s.textContent = msg;
  s.className = 'status ' + (kind || '');
  clearTimeout(statusTimer);
  if (msg) statusTimer = setTimeout(() => { s.textContent = ''; }, 3000);
}
const host = () => { try { return new URL(tab.url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const isWeb = () => !!tab && /^https?:/.test(tab.url || '');

async function start() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!(await VaultClient.paired())) return show('vPair');
  try {
    const st = await VaultClient.rpc('status');
    if (!st.exists) { show('vOffline'); $('#vOffline h1').textContent = 'No vault yet'; $('#vOffline p').textContent = 'Open Vault and create your vault first.'; return; }
    if (!st.unlocked) { show('vLocked'); setTimeout(() => $('#pw').focus(), 30); return; }
    show('vList');
    await load('');
    $('#q').focus();
  } catch (err) {
    if (err.code === 'unpaired') { show('vPair'); $('#pairErr').textContent = err.message; return; }
    if (err.code === 'offline') return show('vOffline');
    show('vOffline'); $('#vOffline p').textContent = err.message;
  }
}

async function load(query) {
  const r = await VaultClient.rpc('list', { url: isWeb() ? tab.url : '', query });
  if (r.locked) { show('vLocked'); return; }
  items = r.items || [];
  sel = 0;
  const site = host();
  $('#siteLine').textContent = query ? `${items.length} ${items.length === 1 ? 'result' : 'results'}`
    : isWeb() ? (items.length ? `Logins for ${site}` : `No logins saved for ${site}`) : 'Search for an account';
  render(query);
}

function render(query) {
  const list = $('#list');
  if (!items.length) {
    list.replaceChildren(h('li', { class: 'empty' }, query ? 'Nothing matches.' : isWeb() ? 'Search above to fill a different account.' : 'Type to search your accounts.'));
    return;
  }
  list.replaceChildren(...items.map((it, i) => h('li', {
    class: 'row', role: 'option', 'aria-selected': String(i === sel), title: isWeb() ? 'Fill ' + it.title : it.title,
    onclick: () => fillItem(it), onmousemove: () => { if (sel !== i) { sel = i; paint(); } },
  }, tile(it),
  h('div', { class: 'text' }, h('div', { class: 'title' }, it.title), h('div', { class: 'sub' }, it.username || it.host || 'No user name')),
  h('div', { class: 'acts' },
    it.username ? h('button', { class: 'mini', title: 'Copy user name', 'aria-label': 'Copy user name', onclick: (e) => { e.stopPropagation(); copyItem(it, 'username'); } }, icon('i-user')) : null,
    it.hasPassword ? h('button', { class: 'mini', title: 'Copy password (clears in 30 s)', 'aria-label': 'Copy password', onclick: (e) => { e.stopPropagation(); copyItem(it, 'password'); } }, icon('i-key')) : null,
    it.hasCode ? h('button', { class: 'mini', title: 'Fill the 2FA code', 'aria-label': 'Fill verification code', onclick: (e) => { e.stopPropagation(); fillCodeItem(it); } }, icon('i-timer')) : null))));
}
function paint() { document.querySelectorAll('#list .row').forEach((r, i) => r.setAttribute('aria-selected', String(i === sel))); }

async function fillItem(it) {
  if (!isWeb()) return copyItem(it, 'password');
  if (!it.match && !confirm(`“${it.title}” isn’t saved for ${host()}. Fill it here anyway?`)) return;
  try {
    const res = await VaultClient.fill(tab, it);
    if (!res || !res.filled) return status('No login form found on this page', 'warn');
    window.close();
  } catch (err) { status(/Cannot access|cannot be scripted|Missing host/i.test(err.message) ? 'Vault can’t fill on this page' : err.message, 'warn'); }
}
async function fillCodeItem(it) {
  try {
    if (!isWeb()) return copyItem(it, 'code');
    const res = await VaultClient.fillCode(tab, it);
    if (!res || !res.filled) { await copyItem(it, 'code'); return; }
    window.close();
  } catch (err) { status(err.message, 'warn'); }
}
async function copyItem(it, what) {
  const r = await VaultClient.rpc('copy', { id: it.id, what });
  if (r.ok) status({ username: 'User name copied', password: 'Password copied · clears in 30 s', code: 'Code copied · clears in 30 s' }[what], 'ok');
  else status('Nothing to copy', 'warn');
}

// ---- wiring ----
$('#pairForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#pairErr').textContent = '';
  $('#pairGo').disabled = true;
  try {
    // Firefox asks for the 127.0.0.1 permission at this point; Chrome already has it.
    if (chrome.permissions && chrome.permissions.request) { try { await chrome.permissions.request({ origins: ['http://127.0.0.1/*'] }); } catch {} }
    await VaultClient.pair($('#pairCode').value);
    await start();
  } catch (err) { $('#pairErr').textContent = err.message; }
  $('#pairGo').disabled = false;
});
$('#unlockForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = $('#pw').value;
  if (!pw) return;
  $('#unlockGo').disabled = true;
  $('#unlockErr').textContent = '';
  const r = await VaultClient.rpc('unlock', { password: pw }).catch((err) => ({ error: err.message }));
  $('#pw').value = '';
  $('#unlockGo').disabled = false;
  if (!r.ok) { $('#unlockErr').textContent = r.error === 'wrong' ? 'Wrong password. Try again.' : (r.error || 'Couldn’t unlock.'); $('#pw').focus(); return; }
  start();
});
$('#retry').addEventListener('click', start);
$('#unpair').addEventListener('click', async () => {
  if (!confirm('Disconnect this browser from Vault? You’ll need a new code from Vault to connect again.')) return;
  await VaultClient.unpair();
  show('vPair');
});
$('#q').addEventListener('input', (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => load(e.target.value), 120); });
document.addEventListener('keydown', (e) => {
  if ($('#vList').hidden || !items.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; paint(); }
  if (e.key === 'Enter') { e.preventDefault(); fillItem(items[sel]); }
});

start();
