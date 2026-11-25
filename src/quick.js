'use strict';
/* Quick search panel (Ctrl+Shift+Space). Lists accounts; copying happens in the main process. */

const $ = (s) => document.querySelector(s);
const q = window.quick;
const st = { items: [], results: [], sel: 0, locked: false, busy: false };

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}
const svgUse = (id, cls) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  if (cls) s.setAttribute('class', cls);
  s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  u.setAttribute('href', '#' + id);
  s.append(u);
  return s;
};

const TILE_COLORS = ['#0a6cff', '#5856d6', '#9b4dca', '#d6245a', '#d9352b', '#c25e00', '#1d8f47', '#11809a', '#3a5bd9', '#0f8a7a'];
function tileColor(item) {
  const brand = (item.logo && item.logo.color) || window.brandColor(item);
  if (brand) return brand;
  let x = 0;
  for (const ch of String(item.title || item.website || '').trim().toLowerCase()) x = (x * 31 + ch.codePointAt(0)) >>> 0;
  return TILE_COLORS[x % TILE_COLORS.length];
}
function tile(item) {
  const lg = item.logo;
  if (lg && lg.src) return h('div', { class: 'tile logo' + (lg.size < 48 ? ' inset' : ''), style: `--tile:${lg.bg || '#ffffff'}`, 'aria-hidden': 'true' }, h('img', { src: lg.src, alt: '' }));
  const name = (item.title || item.website || '?').trim();
  const letter = (name.match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase();
  return h('div', { class: 'tile', style: `--tile:${tileColor(item)}`, 'aria-hidden': 'true' }, letter);
}
const byTitle = (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true });

function search() {
  const query = $('#qq').value.trim().toLowerCase();
  if (!query) return st.items.slice().sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || byTitle(a, b));
  const terms = query.split(/\s+/);
  const out = [];
  for (const it of st.items) {
    const title = it.title.toLowerCase();
    const hay = [title, it.username, it.website].join('\n').toLowerCase();
    if (!terms.every((t) => hay.includes(t))) continue;
    let score = 3;
    if (title.startsWith(query)) score = 0;
    else if (title.split(/[\s.\-_@]+/).some((w) => w.startsWith(terms[0]))) score = 1;
    else if (title.includes(terms[0])) score = 2;
    out.push({ it, score });
  }
  return out.sort((a, b) => a.score - b.score || (b.it.favorite ? 1 : 0) - (a.it.favorite ? 1 : 0) || byTitle(a.it, b.it)).map((x) => x.it);
}

function renderList() {
  st.results = search();
  st.sel = Math.max(0, Math.min(st.sel, st.results.length - 1));
  const list = $('#qList');
  if (!st.results.length) {
    list.replaceChildren(h('li', { class: 'q-empty' }, st.items.length ? 'No matches' : 'Your vault is empty'));
  } else {
    list.replaceChildren(...st.results.map((it, i) => {
      const link = window.loginLink(it);
      return h('li', {
        class: 'q-row', role: 'option', id: 'q-' + i, 'aria-selected': String(i === st.sel),
        onmousemove: () => { if (st.sel !== i) { st.sel = i; paintSel(); } },
        onclick: () => act('password'),
      }, tile(it), h('div', { class: 'q-text' },
        h('div', { class: 'q-title' }, it.title, it.favorite ? svgUse('i-star-fill', 'q-star') : null),
        h('div', { class: 'q-sub' }, it.username || (link ? link.host : '') || 'No user name')),
      h('div', { class: 'q-code', 'data-code': it.id }));
    }));
  }
  paintSel();
}

function paintSel() {
  document.querySelectorAll('.q-row').forEach((r, i) => r.setAttribute('aria-selected', String(i === st.sel)));
  const row = document.getElementById('q-' + st.sel);
  $('#qq').setAttribute('aria-activedescendant', row ? row.id : '');
  if (row) {
    const list = $('#qList');
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop - 6;
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight + 6;
  }
  const it = st.results[st.sel];
  $('#qCodeHint').hidden = !(it && it.hasCode);
  refreshCode();
}

// Live code for the selected account only.
async function refreshCode() {
  document.querySelectorAll('.q-code').forEach((el) => { if (el.dataset.code !== (st.results[st.sel] || {}).id) el.replaceChildren(); });
  const it = st.results[st.sel];
  if (!it || !it.hasCode) return;
  const r = await q.code(it.id);
  const el = document.querySelector(`.q-code[data-code="${it.id}"]`);
  if (r && el) el.replaceChildren(h('span', { class: 'q-code-num' + (r.left <= 5 ? ' ending' : '') }, r.code), h('span', { class: 'q-code-left' }, r.left + 's'));
}
setInterval(() => { if (!document.hidden && !st.locked) refreshCode(); }, 1000);

let statusTimer;
function status(msg, ok) {
  const s = $('#qStatus');
  s.replaceChildren(ok ? svgUse('i-check') : '', msg);
  s.classList.toggle('show', !!msg);
  $('#qHints').classList.toggle('dim', !!msg);
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { s.classList.remove('show'); $('#qHints').classList.remove('dim'); }, 1600);
}

async function act(what) {
  const it = st.results[st.sel];
  if (!it || st.busy) return;
  if (what === 'open') {
    const link = window.loginLink(it);
    if (!link) return status('No website for this account');
    if (it.hasPassword) await q.copy(it.id, 'password');
    q.open(link.url);
    status(it.hasPassword ? 'Opening site · password copied' : 'Opening site', true);
    return setTimeout(() => q.hide(), 650);
  }
  if (what === 'code' && !it.hasCode) return status('No verification code for this account');
  if (what === 'password' && !it.hasPassword) return status('No password saved for this account');
  if (what === 'username' && !it.username) return status('No user name saved for this account');
  st.busy = true;
  const r = await q.copy(it.id, what);
  st.busy = false;
  if (!r || !r.ok) return status('Couldn’t copy that');
  status({ password: 'Password copied · clears in 30 s', username: 'User name copied', code: 'Code copied · clears in 30 s' }[what], true);
  setTimeout(() => q.hide(), 650);
}

async function refresh() {
  const r = await q.list();
  st.locked = !r || r.locked;
  $('#qSearch').hidden = st.locked;
  $('#qLock').hidden = !st.locked;
  $('#qHints').hidden = st.locked;
  if (st.locked) {
    const exists = r ? r.exists !== false : true;
    $('#qLockTitle').textContent = exists ? 'Vault is locked' : 'No vault yet';
    $('#qLockHint').textContent = exists ? 'Enter your master password to search.' : 'Open Vault to create one first.';
    $('#qpw').disabled = !exists;
    $('#qpw').value = '';
    $('#qErr').textContent = '';
    setTimeout(() => $('#qpw').focus(), 30);
    return;
  }
  st.items = r.items;
  renderList();
  setTimeout(() => { $('#qq').focus(); $('#qq').select(); }, 30);
}

$('#qLock').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = $('#qpw').value;
  if (!pw || st.busy) return;
  st.busy = true;
  $('#qLock').classList.add('busy');
  const r = await q.unlock(pw);
  st.busy = false;
  $('#qLock').classList.remove('busy');
  if (!r.ok) {
    $('#qErr').textContent = r.error === 'missing' ? 'Vault file not found.' : 'Wrong password. Try again.';
    $('#qpw').select();
    return;
  }
  st.sel = 0;
  $('#qq').value = '';
  refresh();
});

$('#qq').addEventListener('input', () => { st.sel = 0; renderList(); });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); q.hide(); return; }
  if (st.locked) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!st.results.length) return;
    st.sel = (st.sel + (e.key === 'ArrowDown' ? 1 : -1) + st.results.length) % st.results.length;
    paintSel();
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    if (e.ctrlKey) act('open');
    else if (e.altKey) act('code');
    else if (e.shiftKey) act('username');
    else act('password');
  }
});

q.onShow(() => {
  st.sel = 0; $('#qq').value = ''; refresh();
  const p = $('.q-panel');
  p.classList.remove('in', 'out'); void p.offsetWidth; p.classList.add('in');
});
q.onHiding(() => $('.q-panel').classList.add('out'));
window.__quick = st; // smoke test only
