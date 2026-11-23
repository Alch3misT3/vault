'use strict';
/* Vault — renderer. All decrypted data lives only in memory here while unlocked. */

const $ = (s) => document.querySelector(s);
const api = window.vault;
const AUTO_LOCK_MS = 5 * 60 * 1000;

const state = {
  items: [],
  selectedId: null,
  query: '',
  mode: 'view',      // 'view' | 'edit' | 'new'
  draft: null,
  reveal: new Set(), // ids of values shown in clear text (view mode)
  firstRun: false,
};

// ---------- tiny DOM helper ----------
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}
const icon = (id, cls) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  if (cls) s.setAttribute('class', cls);
  s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  u.setAttribute('href', '#' + id);
  s.append(u);
  return s;
};

// ---------- helpers ----------
const TILE_COLORS = ['#0a6cff', '#5856d6', '#9b4dca', '#d6245a', '#d9352b', '#c25e00', '#1d8f47', '#11809a', '#3a5bd9', '#0f8a7a'];
function tileColor(item) {
  const brand = window.brandColor(item);
  if (brand) return brand;
  let x = 0;
  for (const ch of String(item.title || item.website || '').trim().toLowerCase()) x = (x * 31 + ch.codePointAt(0)) >>> 0;
  return TILE_COLORS[x % TILE_COLORS.length];
}
function tile(item, big) {
  const name = (item.title || item.website || '?').trim();
  const letter = (name.match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase();
  return h('div', { class: 'tile' + (big ? ' big' : ''), style: `--tile:${tileColor(item)}`, 'aria-hidden': 'true' }, letter);
}
const byTitle = (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true });
const current = () => state.items.find((x) => x.id === state.selectedId) || null;
const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1900);
}

async function copy(text, secret, what) {
  if (!text) return;
  await api.copy(text, secret);
  toast(secret ? `${what} copied · clears in 30 s` : `${what} copied`);
}

function openLink(url) {
  if (!url) return;
  api.open(url);
  toast('Opening in your browser…');
}

// Apple-style strong password: "xkvbqe-Tmwz4h-pnrcdu"
function generatePassword() {
  const letters = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const rnd = (n) => { const a = new Uint32Array(1); let v; do { crypto.getRandomValues(a); v = a[0]; } while (v >= Math.floor(2 ** 32 / n) * n); return v % n; };
  const chars = Array.from({ length: 18 }, () => letters[rnd(letters.length)]);
  const pos = Array.from({ length: 18 }, (_, i) => i);
  const take = () => pos.splice(rnd(pos.length), 1)[0];
  chars[take()] = digits[rnd(digits.length)];
  const up = take();
  chars[up] = chars[up].toUpperCase();
  return [chars.slice(0, 6), chars.slice(6, 12), chars.slice(12)].map((g) => g.join('')).join('-');
}

function strength(pw) {
  if (!pw) return 0;
  let classes = 0;
  if (/[a-z]/.test(pw)) classes++;
  if (/[A-Z]/.test(pw)) classes++;
  if (/\d/.test(pw)) classes++;
  if (/[^A-Za-z0-9]/.test(pw)) classes++;
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (pw.length >= 16) s++;
  if (classes >= 3) s++;
  if (/^(.)\1+$/.test(pw) || /^(password|12345678|qwerty)/i.test(pw)) s = 0;
  return Math.min(4, s);
}

// ---------- persistence ----------
async function persist() {
  const r = await api.save(state.items);
  if (!r.ok) { toast(r.error === 'locked' ? 'Vault is locked' : 'Couldn’t save. Try again.'); return false; }
  return true;
}

// ---------- lock screen ----------
async function showLock() {
  const st = await api.status();
  state.firstRun = !st.exists;
  state.items = []; state.selectedId = null; state.draft = null; state.mode = 'view'; state.reveal.clear(); state.query = '';
  $('#q').value = '';
  $('#detail').replaceChildren();
  $('#list').replaceChildren();
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  $('#app').hidden = true;
  $('#lock').hidden = false;
  document.body.classList.add('lock-mode');
  lastShownId = null;
  setTint(null);

  const first = state.firstRun;
  $('#lockTitle').textContent = first ? 'Create your vault' : 'Vault is locked';
  $('#lockHint').textContent = first ? 'Pick one master password. It unlocks everything else.' : 'Enter your master password to unlock.';
  $('#pw2Wrap').hidden = !first;
  $('#strength').hidden = !first;
  $('#createGo').hidden = !first;
  $('#lockNote').hidden = !first;
  $('#unlockGo').hidden = first;
  $('#pw1').placeholder = first ? 'New master password' : 'Master password';
  $('#pw1').value = ''; $('#pw2').value = '';
  $('#lockError').textContent = '';
  updateLockUI();
  setTimeout(() => $('#pw1').focus(), 30);
}

function updateLockUI() {
  const pw = $('#pw1').value;
  $('#unlockGo').disabled = !pw;
  if (state.firstRun) {
    const s = strength(pw);
    const bar = $('#strength span');
    bar.style.width = pw ? `${Math.max(12, s * 25)}%` : '0';
    bar.style.backgroundColor = ['#d70015', '#d70015', '#c25e00', '#1d8f47', '#1d8f47'][s];
    $('#createGo').disabled = pw.length < 8 || $('#pw2').value !== pw;
  }
}

function lockFail(msg) {
  const card = $('#lockForm');
  $('#lockError').textContent = msg;
  card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
  $('#pw1').select();
}

async function submitLock(e) {
  e.preventDefault();
  const pw = $('#pw1').value;
  const form = $('#lockForm');
  if (form.classList.contains('busy')) return;
  if (state.firstRun) {
    if (pw.length < 8) return lockFail('Use at least 8 characters.');
    if ($('#pw2').value !== pw) return lockFail('The two passwords don’t match.');
    form.classList.add('busy');
    const r = await api.create(pw);
    form.classList.remove('busy');
    if (!r.ok) return lockFail('Couldn’t create the vault.');
    return unlocked(r.items);
  }
  if (!pw) return;
  form.classList.add('busy');
  $('#lockError').textContent = '';
  const r = await api.unlock(pw);
  form.classList.remove('busy');
  if (!r.ok) return lockFail(r.error === 'missing' ? 'Vault file not found.' : 'Wrong password. Try again.');
  unlocked(r.items);
}

function unlocked(items) {
  $('#pw1').value = ''; $('#pw2').value = '';
  state.items = (items || []).slice().sort(byTitle);
  $('#lock').hidden = true;
  document.body.classList.remove('lock-mode');
  const app = $('#app');
  app.hidden = false;
  app.classList.remove('arrive'); void app.offsetWidth; app.classList.add('arrive');
  state.selectedId = state.items[0] ? state.items[0].id : null;
  render();
  $('#q').focus();
  bumpIdle();
}

async function lockNow() {
  await api.lock();
  showLock();
}

// ---------- search ----------
function matches() {
  const q = state.query.trim().toLowerCase();
  if (!q) return state.items.map((it) => ({ it, score: 0 }));
  const terms = q.split(/\s+/);
  const out = [];
  for (const it of state.items) {
    const title = it.title.toLowerCase();
    const hay = [title, it.username, it.website, it.notes, ...(it.fields || []).map((f) => f.label + ' ' + (f.secret ? '' : f.value))]
      .join('\n').toLowerCase();
    if (!terms.every((t) => hay.includes(t))) continue;
    let score = 3;
    if (title.startsWith(q)) score = 0;
    else if (title.split(/[\s.\-_@]+/).some((w) => w.startsWith(terms[0]))) score = 1;
    else if (title.includes(terms[0])) score = 2;
    out.push({ it, score });
  }
  return out.sort((a, b) => a.score - b.score || byTitle(a.it, b.it));
}

function highlight(text, q) {
  const t = q.trim().split(/\s+/)[0];
  if (!t) return [text];
  const i = text.toLowerCase().indexOf(t.toLowerCase());
  if (i < 0) return [text];
  return [text.slice(0, i), h('mark', {}, text.slice(i, i + t.length)), text.slice(i + t.length)];
}

// ---------- render ----------
function render() {
  renderList();
  renderDetail();
}

function renderList() {
  const list = $('#list');
  const res = matches();
  const q = state.query.trim();
  $('#qClear').hidden = !state.query;
  $('#listMeta').textContent = q ? `${res.length} ${res.length === 1 ? 'Result' : 'Results'}` : `${state.items.length} ${state.items.length === 1 ? 'Account' : 'Accounts'}`;

  if (q && res.length && !res.some((r) => r.it.id === state.selectedId) && state.mode === 'view') {
    state.selectedId = res[0].it.id;
  }
  list.replaceChildren(...res.map(({ it }) => {
    const sub = it.username || (window.loginLink(it) || {}).host || 'No user name';
    return h('li', {
      class: 'row', role: 'option', id: 'row-' + it.id, 'data-id': it.id,
      'aria-selected': String(it.id === state.selectedId),
      onclick: () => select(it.id),
      ondblclick: () => { const l = window.loginLink(it); if (l) openLink(l.url); },
      oncontextmenu: (e) => { e.preventDefault(); rowMenu(it); },
    }, tile(it), h('div', { class: 'row-text' },
      h('div', { class: 'row-title' }, highlight(it.title, q)),
      h('div', { class: 'row-sub' }, sub)));
  }));

  if (!res.length) {
    list.replaceChildren(q
      ? h('li', { class: 'empty-list' }, h('strong', {}, 'No results'), `Nothing matches “${q}”.`)
      : h('li', { class: 'empty-list' }, h('strong', {}, 'No accounts yet'), 'Add one with the + button, or import from another app.'));
  }
  const sel = document.getElementById('row-' + state.selectedId);
  if (sel) {
    // Scroll only the list (scrollIntoView would also nudge the window itself).
    const top = sel.offsetTop - list.offsetTop;
    if (top < list.scrollTop) list.scrollTop = top - 4;
    else if (top + sel.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + sel.offsetHeight - list.clientHeight + 4;
  }
  $('#list').setAttribute('aria-activedescendant', sel ? sel.id : '');
}

// The colour field behind the glass takes on the selected account's colour.
let lastShownId = null;
function setTint(item) {
  const name = item ? (item.title || item.website || '').trim() : '';
  document.documentElement.style.setProperty('--tint', name ? tileColor(item) : '#0a6cff');
}

function renderDetail() {
  const d = $('#detail');
  const it = current();
  setTint(state.mode !== 'view' ? state.draft : it);
  if (state.mode === 'edit' || state.mode === 'new') return d.replaceChildren(...editView());
  if (!it) return d.replaceChildren(h('div', { class: 'detail-bar drag' }), blankView());
  d.replaceChildren(...detailView(it));
}

function blankView() {
  if (state.items.length) {
    return h('div', { class: 'blank' }, h('div', {},
      h('h2', {}, 'No account selected'),
      h('p', {}, 'Pick one from the list, or start typing to search.')));
  }
  return h('div', { class: 'blank' }, h('div', {},
    h('div', { class: 'app-icon small', 'aria-hidden': 'true' }, icon('i-vault')),
    h('h2', {}, 'Your vault is empty'),
    h('p', {}, 'Add your first account, or bring everything over from Apple Passwords, Chrome, Bitwarden, 1Password and others.'),
    h('div', { class: 'blank-actions' },
      h('button', { class: 'btn-secondary', onclick: importFlow }, icon('i-import'), 'Import…'),
      h('button', { class: 'btn-primary', onclick: startNew }, 'New Account')),
    h('div', { class: 'kbd' }, h('kbd', {}, 'Ctrl'), ' ', h('kbd', {}, 'N'), ' new account  ·  ', h('kbd', {}, 'Ctrl'), ' ', h('kbd', {}, 'I'), ' import')));
}

function valueRow({ label, value, secret, id, link, copyName }) {
  const shown = !secret || state.reveal.has(id);
  const empty = !value;
  let valueEl;
  if (empty) valueEl = h('div', { class: 'f-value muted' }, 'None');
  else if (link) valueEl = h('a', { class: 'f-value link', href: '#', onclick: (e) => { e.preventDefault(); e.stopPropagation(); openLink(link); } }, value);
  else valueEl = h('div', { class: 'f-value' + (secret ? (shown ? ' secret' : ' dots') : ''), title: secret && !shown ? 'Click to copy' : null }, shown ? value : '•'.repeat(Math.min(14, Math.max(8, value.length))));

  const actions = h('div', { class: 'row-actions' },
    secret && !empty ? h('button', {
      class: 'mini-btn', title: shown ? 'Hide' : 'Show', 'aria-label': shown ? `Hide ${label}` : `Show ${label}`,
      onclick: (e) => { e.stopPropagation(); shown ? state.reveal.delete(id) : state.reveal.add(id); renderDetail(); },
    }, icon(shown ? 'i-eye-off' : 'i-eye')) : null,
    !empty ? h('button', { class: 'mini-btn', title: 'Copy', 'aria-label': `Copy ${label}`, onclick: (e) => { e.stopPropagation(); copy(value, secret, copyName || label); } }, icon('i-copy')) : null);

  return h('div', {
    class: 'field-row' + (empty || link ? '' : ' clickable'),
    onclick: empty || link ? null : () => copy(value, secret, copyName || label),
  }, h('div', { class: 'f-label' }, label), valueEl, actions);
}

function detailView(it) {
  const link = window.loginLink(it);
  const bar = h('div', { class: 'detail-bar drag' },
    h('button', { class: 'glass-btn glass', onclick: () => startEdit(it), title: 'Edit (Ctrl+E)' }, 'Edit'));

  const hero = h('div', { class: 'hero' }, tile(it, true),
    h('div', { class: 'hero-text' },
      h('h1', {}, it.title),
      h('div', { class: 'hero-sub' }, link ? link.host : (it.username || ''))),
    link ? h('button', { class: 'btn-primary', onclick: () => openLink(link.url), title: link.url + '  (Ctrl+O)' }, icon('i-open'), 'Open Login Page') : null);

  const main = h('div', { class: 'group' },
    valueRow({ label: 'User name', value: it.username, id: 'u', copyName: 'User name' }),
    valueRow({ label: 'Password', value: it.password, secret: true, id: 'pw', copyName: 'Password' }),
    link ? valueRow({ label: 'Website', value: link.url.replace(/^https:\/\//, '').replace(/\/$/, ''), link: link.url }) : null);

  const extras = (it.fields || []).length ? [
    h('div', { class: 'section-label' }, 'Other Fields'),
    h('div', { class: 'group' }, it.fields.map((f) => valueRow({ label: f.label || 'Field', value: f.value, secret: f.secret, id: f.id, copyName: f.label || 'Field' }))),
  ] : [];

  const notes = it.notes ? [
    h('div', { class: 'section-label' }, 'Notes'),
    h('div', { class: 'group' }, h('div', { class: 'notes-view' }, it.notes)),
  ] : [];

  const meta = h('div', { class: 'meta' }, `Edited ${fmtDate(it.updatedAt)} · Created ${fmtDate(it.createdAt)}`);
  const swap = lastShownId !== it.id;
  lastShownId = it.id;
  return [bar, h('div', { class: 'detail-scroll' }, h('div', { class: 'detail-inner' + (swap ? ' swap' : '') }, hero, main, ...extras, ...notes, meta))];
}

// ---------- edit ----------
function blankDraft() {
  return { id: window.transfer.uid(), title: '', website: '', username: '', password: '', fields: [], notes: '', createdAt: Date.now(), updatedAt: Date.now() };
}
function startNew() {
  state.mode = 'new';
  state.draft = blankDraft();
  state.draft._showPw = false;
  render();
  setTimeout(() => $('#f-title') && $('#f-title').focus(), 20);
}
function startEdit(it) {
  if (!it) return;
  state.mode = 'edit';
  state.draft = JSON.parse(JSON.stringify(it));
  state.draft._showPw = false;
  renderDetail();
  setTimeout(() => $('#f-title') && $('#f-title').focus(), 20);
}
function isDirty() {
  if (state.mode === 'view' || !state.draft) return false;
  const clean = (x) => JSON.stringify({ ...x, _showPw: undefined });
  if (state.mode === 'new') return clean(state.draft) !== clean({ ...blankDraft(), id: state.draft.id, createdAt: state.draft.createdAt, updatedAt: state.draft.updatedAt });
  return clean(state.draft) !== clean(current());
}
async function cancelEdit() {
  if (isDirty() && !(await confirmAlert('Discard changes?', 'Your edits to this account will be lost.', 'Discard', true))) return false;
  state.mode = 'view'; state.draft = null;
  render();
  return true;
}
async function saveEdit() {
  const d = state.draft;
  d.title = d.title.trim(); d.website = d.website.trim(); d.username = d.username.trim();
  if (!d.title && d.website) { const u = window.hostOf(d.website); if (u) d.title = u.hostname.replace(/^www\./, ''); }
  if (!d.title) { const el = $('#f-title'); el.focus(); el.placeholder = 'Give it a name, e.g. Netflix'; el.classList.add('field-error'); toast('Add a name first'); return; }
  d.fields = d.fields.filter((f) => f.label.trim() || f.value).map((f) => ({ ...f, label: f.label.trim() || 'Field' }));
  d.notes = d.notes.replace(/\s+$/, '');
  d.updatedAt = Date.now();
  delete d._showPw;
  const before = state.items;
  state.items = (state.mode === 'new' ? [...before, d] : before.map((x) => (x.id === d.id ? d : x))).sort(byTitle);
  if (!(await persist())) { state.items = before; return; }
  state.selectedId = d.id; state.mode = 'view'; state.draft = null; state.reveal.clear();
  render();
  toast('Saved');
}

function editView() {
  const d = state.draft;
  const set = (k) => (e) => { d[k] = e.target.value; if (k === 'title' || k === 'website') { updateLinkHint(); updateHeroTile(); } };

  const bar = h('div', { class: 'detail-bar drag' },
    h('button', { class: 'glass-btn glass', onclick: cancelEdit }, 'Cancel'),
    h('button', { class: 'btn-primary', onclick: saveEdit, title: 'Save (Ctrl+S)' }, 'Done'));

  const hero = h('div', { class: 'hero' }, h('div', { id: 'heroTile' }, tile(d, true)),
    h('div', { class: 'hero-text' },
      h('input', { id: 'f-title', class: 'in title-in', placeholder: 'Name, e.g. Netflix', value: d.title, oninput: set('title'), 'aria-label': 'Account name', spellcheck: 'false' })));

  const pwInput = h('input', {
    id: 'f-pw', class: 'in secret', type: d._showPw ? 'text' : 'password', value: d.password,
    placeholder: 'Password', oninput: set('password'), 'aria-label': 'Password', spellcheck: 'false', autocomplete: 'off',
  });
  const main = h('div', { class: 'group' },
    h('div', { class: 'field-row' }, h('label', { class: 'f-label', for: 'f-user' }, 'User name'),
      h('input', { id: 'f-user', class: 'in', value: d.username, placeholder: 'Email or user name', oninput: set('username'), spellcheck: 'false', autocomplete: 'off' }), h('span')),
    h('div', { class: 'field-row' }, h('label', { class: 'f-label', for: 'f-pw' }, 'Password'), pwInput,
      h('div', { class: 'edit-tools' },
        h('button', { class: 'mini-btn', title: d._showPw ? 'Hide' : 'Show', 'aria-label': d._showPw ? 'Hide password' : 'Show password', onclick: () => { d._showPw = !d._showPw; pwInput.type = d._showPw ? 'text' : 'password'; } }, icon('i-eye')),
        h('button', { class: 'mini-btn', title: 'Suggest a strong password', 'aria-label': 'Suggest a strong password', onclick: () => { d.password = generatePassword(); d._showPw = true; pwInput.value = d.password; pwInput.type = 'text'; toast('Strong password suggested'); } }, icon('i-key')))),
    h('div', { class: 'field-row' }, h('label', { class: 'f-label', for: 'f-web' }, 'Website'),
      h('input', { id: 'f-web', class: 'in', value: d.website, placeholder: 'netflix.com', oninput: set('website'), spellcheck: 'false', autocomplete: 'off' }), h('span')));

  const hint = h('div', { class: 'hint', id: 'linkHint' });
  updateLinkHint(hint);

  const fieldRows = d.fields.map((f, i) => {
    const val = h('input', { class: 'in' + (f.secret ? ' secret' : ''), type: f.secret ? 'password' : 'text', value: f.value, placeholder: 'Value', 'aria-label': (f.label || 'Field') + ' value', spellcheck: 'false', autocomplete: 'off', oninput: (e) => { f.value = e.target.value; } });
    return h('div', { class: 'field-row' },
      h('input', { class: 'in label-in', value: f.label, placeholder: 'Label', 'aria-label': 'Field label', 'data-field': i, spellcheck: 'false', oninput: (e) => { f.label = e.target.value; } }),
      val,
      h('div', { class: 'edit-tools' },
        h('button', {
          class: 'toggle-secret', 'aria-pressed': String(!!f.secret), title: 'Hide this value like a password',
          onclick: (e) => { f.secret = !f.secret; val.type = f.secret ? 'password' : 'text'; val.classList.toggle('secret', f.secret); e.currentTarget.setAttribute('aria-pressed', String(f.secret)); },
        }, icon('i-lock'), 'Secret'),
        h('button', { class: 'remove-btn', title: 'Remove field', 'aria-label': `Remove ${f.label || 'field'}`, onclick: () => { d.fields.splice(i, 1); renderDetail(); } }, icon('i-minus'))));
  });
  const addBtn = h('button', {
    class: 'add-row', onclick: () => {
      d.fields.push({ id: window.transfer.uid(), label: '', value: '', secret: true });
      renderDetail();
      const inputs = document.querySelectorAll('[data-field]');
      inputs[inputs.length - 1].focus();
    },
  }, icon('i-add-circle'), 'Add Field (token, PIN, recovery code…)');

  const notes = h('div', { class: 'group notes-edit' },
    h('textarea', { class: 'in', placeholder: 'Notes', 'aria-label': 'Notes', oninput: (e) => { d.notes = e.target.value; }, spellcheck: 'true' }, d.notes));

  const danger = state.mode === 'edit' ? h('div', { class: 'group danger-zone' },
    h('button', { class: 'delete-row', onclick: () => deleteItem(current()) }, 'Delete Account')) : null;

  const scroll = h('div', { class: 'detail-scroll edit' }, h('div', { class: 'detail-inner' },
    hero, main, hint,
    h('div', { class: 'section-label' }, 'Other Fields'),
    h('div', { class: 'group' }, ...fieldRows, addBtn),
    h('div', { class: 'section-label' }, 'Notes'),
    notes, danger));

  return [bar, scroll];
}

function updateLinkHint(target) {
  const el = target || $('#linkHint');
  if (!el || !state.draft) return;
  const l = window.loginLink(state.draft);
  if (l) el.replaceChildren('Login link: ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); openLink(l.url); } }, l.url));
  else el.textContent = state.draft.website ? 'That doesn’t look like a web address yet.' : 'Type the site (e.g. netflix.com) and a login link is made for you.';
}
function updateHeroTile() {
  const t = $('#heroTile');
  if (t && state.draft) { t.replaceChildren(tile(state.draft, true)); setTint(state.draft); }
}

// ---------- actions ----------
async function select(id) {
  if (id === state.selectedId && state.mode === 'view') return;
  if (state.mode !== 'view' && !(await cancelEdit())) return;
  state.selectedId = id;
  state.reveal.clear();
  render();
}

async function deleteItem(it) {
  if (!it) return;
  const ok = await confirmAlert(`Delete “${it.title}”?`, 'This removes the account and its password from your vault. You can’t undo this.', 'Delete', true);
  if (!ok) return;
  const before = state.items;
  const idx = matches().findIndex((r) => r.it.id === it.id);
  state.items = before.filter((x) => x.id !== it.id);
  if (!(await persist())) { state.items = before; return; }
  state.mode = 'view'; state.draft = null;
  const res = matches();
  state.selectedId = res.length ? res[Math.min(idx, res.length - 1)].it.id : null;
  render();
  toast('Deleted');
}

async function rowMenu(it) {
  if (state.mode === 'view' && state.selectedId !== it.id) await select(it.id);
  const link = window.loginLink(it);
  const pick = await api.rowMenu({ hasUser: !!it.username, hasPassword: !!it.password, hasLink: !!link });
  if (pick === 'copy-user') copy(it.username, false, 'User name');
  if (pick === 'copy-password') copy(it.password, true, 'Password');
  if (pick === 'open' && link) openLink(link.url);
  if (pick === 'edit') { await select(it.id); startEdit(it); }
  if (pick === 'delete') deleteItem(it);
}

function confirmAlert(title, body, okLabel, danger) {
  const dlg = $('#alert');
  $('#alertTitle').textContent = title;
  $('#alertBody').textContent = body;
  const ok = $('#alertOk');
  ok.textContent = okLabel;
  ok.className = danger ? 'btn-danger' : 'btn-primary';
  dlg.returnValue = '';
  dlg.showModal();
  dlg.querySelector('.btn-secondary').focus();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}

// ---------- import / export ----------
async function importFlow() {
  if (state.mode !== 'view' && !(await cancelEdit())) return;
  const file = await api.pickImport();
  if (!file) return;
  if (file.error) return toast(file.error);
  let incoming;
  try { incoming = window.transfer.parseImport(file.name, file.text); }
  catch (err) { return confirmInfo('Can’t import this file', err.message || 'The file couldn’t be read.'); }
  const { fresh, skipped } = window.transfer.dedupe(state.items, incoming);
  if (!fresh.length) return confirmInfo('Nothing new to import', skipped ? `All ${skipped} accounts in “${file.name}” are already in your vault.` : `No accounts were found in “${file.name}”.`);

  const dlg = $('#importDlg');
  $('#importTitle').textContent = `Import ${fresh.length} ${fresh.length === 1 ? 'account' : 'accounts'}?`;
  $('#importBody').textContent = `From “${file.name}”.` + (skipped ? ` ${skipped} already in your vault will be skipped.` : '') +
    ' Afterwards, delete the export file: it isn’t encrypted.';
  $('#importGo').hidden = false;
  dlg.querySelector('.btn-secondary').textContent = 'Cancel';
  dlg.returnValue = '';
  dlg.showModal();
  $('#importGo').focus();
  const ok = await new Promise((r) => dlg.addEventListener('close', () => r(dlg.returnValue === 'ok'), { once: true }));
  if (!ok) return;
  const before = state.items;
  state.items = [...before, ...fresh].sort(byTitle);
  if (!(await persist())) { state.items = before; return; }
  state.selectedId = fresh.slice().sort(byTitle)[0].id;
  state.query = ''; $('#q').value = '';
  render();
  toast(`Imported ${fresh.length} ${fresh.length === 1 ? 'account' : 'accounts'}`);
}

function confirmInfo(title, body) {
  const dlg = $('#importDlg');
  $('#importTitle').textContent = title;
  $('#importBody').textContent = body;
  $('#importGo').hidden = true;
  dlg.querySelector('.btn-secondary').textContent = 'OK';
  dlg.showModal();
}

const EXPORT_TEXT = {
  csv: 'Works with Apple Passwords, Chrome, Edge, Firefox, Bitwarden, 1Password, Proton Pass and most others. Extra fields go into notes. The file is NOT encrypted: delete it once you’ve imported it.',
  json: 'Keeps every extra field separate. Bitwarden, Proton Pass and Vault itself can import it. The file is NOT encrypted.',
  backup: 'An encrypted copy of your vault, locked with your current master password. Keep it on a USB stick or cloud drive; restore it from the ••• menu.',
};
function exportFlow() {
  if (state.mode !== 'view') return toast('Finish editing first');
  const dlg = $('#exportDlg');
  const form = $('#exportForm');
  const fmt = () => form.querySelector('input[name="fmt"]:checked').value;
  const sync = () => {
    $('#exportBody').textContent = EXPORT_TEXT[fmt()];
    $('#exportBody').classList.toggle('warn', fmt() !== 'backup');
  };
  form.querySelectorAll('input[name="fmt"]').forEach((r) => { r.onchange = sync; });
  sync();
  $('#exPw').value = ''; $('#exError').textContent = '';
  dlg.showModal();
  $('#exPw').focus();
}
async function exportSubmit(e) {
  const dlg = $('#exportDlg');
  const submitter = e.submitter;
  if (submitter && submitter.value === 'cancel') return;
  e.preventDefault();
  const kind = $('#exportForm').querySelector('input[name="fmt"]:checked').value;
  const pw = $('#exPw').value;
  if (!pw) { $('#exError').textContent = 'Enter your master password to export.'; return; }
  const contents = kind === 'csv' ? window.transfer.toCSV(state.items) : kind === 'json' ? window.transfer.toJSON(state.items) : '';
  $('#exGo').disabled = true;
  const r = await api.exportFile(kind, contents, pw);
  $('#exGo').disabled = false;
  if (!r.ok) {
    if (r.error === 'wrong') { $('#exError').textContent = 'Wrong password.'; $('#exPw').select(); }
    else if (r.error !== 'canceled') $('#exError').textContent = 'Couldn’t write the file.';
    return;
  }
  dlg.close();
  toast(kind === 'backup' ? 'Backup saved' : 'Exported · delete the file after use');
}

async function restoreFlow() {
  const ok = await confirmAlert('Restore from a backup?', 'This replaces everything in your vault with the backup. You’ll unlock it with the master password it was made with.', 'Choose Backup…', true);
  if (!ok) return;
  const r = await api.restore();
  if (r.ok) { showLock(); setTimeout(() => toast('Backup restored · unlock to continue'), 100); }
  else if (r.error !== 'canceled') toast(r.error);
}

async function backupFlow() {
  exportFlow();
  const r = $('#exportForm').querySelector('input[value="backup"]');
  r.checked = true; r.dispatchEvent(new Event('change'));
}

async function moreMenu() {
  const pick = await api.moreMenu();
  handleCommand(pick);
}

function handleCommand(cmd) {
  if ($('#app').hidden) return;
  if (cmd === 'new') $('#addBtn').click();
  if (cmd === 'find') { $('#q').focus(); $('#q').select(); }
  if (cmd === 'import') importFlow();
  if (cmd === 'export') exportFlow();
  if (cmd === 'backup') backupFlow();
  if (cmd === 'restore') restoreFlow();
  if (cmd === 'change-password') changePwFlow();
  if (cmd === 'check-updates') manualUpdateCheck();
}

// ---------- updates ----------
function showUpdate(st) {
  const bar = $('#updateBar');
  if (st.status === 'ready') {
    $('#updateTitle').textContent = 'Update ready';
    $('#updateSub').textContent = `Vault ${st.version} · installs in seconds`;
    $('#updateGo').textContent = 'Restart';
    bar.hidden = false;
  } else if (st.status === 'available') {
    $('#updateTitle').textContent = `Vault ${st.version} is out`;
    $('#updateSub').textContent = 'Download the new portable version';
    $('#updateGo').textContent = 'Download';
    bar.hidden = false;
  } else bar.hidden = true;
}

async function manualUpdateCheck() {
  toast('Checking for updates…');
  const st = await api.checkUpdates();
  showUpdate(st);
  const msg = {
    latest: 'Vault is up to date',
    downloading: `Downloading Vault ${st.version}…`,
    ready: `Vault ${st.version} is ready: click Restart`,
    available: `Vault ${st.version} is available`,
    error: 'Couldn’t reach GitHub. Try again later.',
    unavailable: 'Updates work in the installed app',
  }[st.status];
  if (msg) toast(msg);
}

async function installUpdate() {
  const st = await api.updateState();
  if (st.status === 'ready') {
    if (state.mode !== 'view' && !(await cancelEdit())) return;
    toast('Restarting to update…');
  }
  api.installUpdate();
}

// ---------- change master password ----------
function changePwFlow() {
  ['#cpOld', '#cpNew', '#cpNew2'].forEach((s) => { $(s).value = ''; });
  $('#cpError').textContent = '';
  $('#changePw').showModal();
  $('#cpOld').focus();
}
async function changePwSubmit(e) {
  if (e.submitter && e.submitter.value === 'cancel') return;
  e.preventDefault();
  const [o, n, n2] = ['#cpOld', '#cpNew', '#cpNew2'].map((s) => $(s).value);
  if (n.length < 8) return void ($('#cpError').textContent = 'Use at least 8 characters.');
  if (n !== n2) return void ($('#cpError').textContent = 'The new passwords don’t match.');
  $('#cpGo').disabled = true;
  const r = await api.changePassword(o, n, state.items);
  $('#cpGo').disabled = false;
  if (!r.ok) return void ($('#cpError').textContent = r.error === 'wrong' ? 'Current password is wrong.' : 'Couldn’t change it.');
  $('#changePw').close();
  toast('Master password changed');
}

// ---------- keyboard ----------
function moveSelection(delta) {
  const res = matches();
  if (!res.length) return;
  let i = res.findIndex((r) => r.it.id === state.selectedId);
  i = Math.max(0, Math.min(res.length - 1, (i < 0 ? -1 : i) + delta));
  select(res[i].it.id);
}

document.addEventListener('keydown', (e) => {
  if ($('#app').hidden || document.querySelector('dialog[open]')) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const inField = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
  const editing = state.mode !== 'view';
  const it = current();

  if (ctrl && e.key.toLowerCase() === 's' && editing) { e.preventDefault(); saveEdit(); return; }
  if (e.key === 'Escape') {
    if (editing) { e.preventDefault(); cancelEdit(); return; }
    if (state.query) { $('#q').value = ''; state.query = ''; renderList(); renderDetail(); $('#q').focus(); return; }
  }
  if (editing) return;
  if (ctrl && e.key.toLowerCase() === 'e' && it) { e.preventDefault(); startEdit(it); return; }
  if (ctrl && e.key.toLowerCase() === 'o' && it) { e.preventDefault(); const l = window.loginLink(it); if (l) openLink(l.url); return; }
  if (ctrl && e.shiftKey && e.key.toLowerCase() === 'c' && it) { e.preventDefault(); copy(it.password, true, 'Password'); return; }
  if (ctrl && e.shiftKey && e.key.toLowerCase() === 'u' && it) { e.preventDefault(); copy(it.username, false, 'User name'); return; }

  const inSearch = document.activeElement === $('#q');
  if ((inSearch || !inField) && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); moveSelection(e.key === 'ArrowDown' ? 1 : -1); return; }
  if (inSearch && e.key === 'Enter' && it) { e.preventDefault(); const l = window.loginLink(it); if (l) openLink(l.url); return; }
  if ((e.key === 'Delete') && !inField && it) { e.preventDefault(); deleteItem(it); return; }
  // Typing anywhere jumps into search.
  if (!inField && !ctrl && !e.altKey && e.key.length === 1) { $('#q').focus(); }
});

// ---------- auto-lock ----------
let idleTimer;
function bumpIdle() {
  clearTimeout(idleTimer);
  if ($('#app').hidden) return;
  idleTimer = setTimeout(() => { if (!$('#app').hidden) lockNow(); }, AUTO_LOCK_MS);
}
['mousemove', 'keydown', 'mousedown', 'wheel'].forEach((ev) => document.addEventListener(ev, bumpIdle, { passive: true }));

// ---------- wire up ----------
$('#lockForm').addEventListener('submit', submitLock);
$('#pw1').addEventListener('input', updateLockUI);
$('#pw2').addEventListener('input', updateLockUI);
$('#q').addEventListener('input', (e) => { state.query = e.target.value; renderList(); if (state.mode === 'view') renderDetail(); });
$('#qClear').addEventListener('click', () => { $('#q').value = ''; state.query = ''; render(); $('#q').focus(); });
$('#addBtn').addEventListener('click', async () => { if (state.mode === 'view' || (await cancelEdit())) startNew(); });
$('#lockBtn').addEventListener('click', lockNow);
$('#moreBtn').addEventListener('click', moreMenu);
$('#exportForm').addEventListener('submit', exportSubmit);
$('#changePwForm').addEventListener('submit', changePwSubmit);
$('#q').addEventListener('focus', () => document.querySelector('.sidebar').classList.add('list-active'));
$('#q').addEventListener('blur', () => document.querySelector('.sidebar').classList.remove('list-active'));
api.onMenu(handleCommand);
api.onUpdate(showUpdate);
$('#updateGo').addEventListener('click', installUpdate);
api.onLocked(showLock);

window.__vaultState = state; // read by the automated smoke test only
showLock();
