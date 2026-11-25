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
  view: 'all',       // 'all' | 'favorites' | 'codes' | 'security' | 'deleted'
  showHistory: false,
};
const BIN_DAYS = 30;
const DAY = 86400000;
const VIEWS = [
  { id: 'all', label: 'All', icon: 'i-list', empty: ['No accounts yet', 'Add one with the + button, or import from another app.'] },
  { id: 'favorites', label: 'Favorites', icon: 'i-star', empty: ['No favorites', 'Click the star on an account to keep it here and at the top of All.'] },
  { id: 'codes', label: 'Codes', icon: 'i-timer', empty: ['No verification codes', 'Edit an account and choose Set Up Verification Code to keep its 2FA codes here.'] },
  { id: 'security', label: 'Security', icon: 'i-shield', empty: ['All clear', 'No weak, reused or very old passwords.'] },
  { id: 'deleted', label: 'Deleted', icon: 'i-trash', empty: ['Nothing deleted', `Deleted accounts stay here for ${BIN_DAYS} days so you can recover them.`] },
];

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
// ---------- site logos ----------
// Fetched by the main process from each site itself and kept encrypted with the vault.
// domain -> { src: 'data:image/png…' | null, color, bg, size }
const logos = { on: true, map: new Map() };
const domainOf = (item) => { const l = item && window.loginLink(item); return l ? l.host : ''; };
const logoOf = (item) => (logos.on ? logos.map.get(domainOf(item)) : null) || null;

function hashColor(item) {
  let x = 0;
  for (const ch of String(item.title || item.website || '').trim().toLowerCase()) x = (x * 31 + ch.codePointAt(0)) >>> 0;
  return TILE_COLORS[x % TILE_COLORS.length];
}
// The site's real colour: from its logo, else the known brand colour, else a stable pick.
function tileColor(item) {
  const lg = logoOf(item);
  return (lg && lg.color) || window.brandColor(item) || hashColor(item);
}
const hexRgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const lum = (hex) => { const c = hexRgb(hex).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
function rgbHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b); const mn = Math.min(r, g, b); const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn; const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const hh = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [hh * 60, s, l];
}
const hsl = (hh, s, l) => `hsl(${Math.round(hh)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;
// Letter tiles: white letters need a dark-enough colour, otherwise the letter goes dark.
function tileStyle(color) {
  const light = lum(color) > 0.42;
  return { bg: color, ink: light ? '#1c1c1f' : '#fff' };
}
// The colour field behind the glass: the logo colour, kept in a range where text on the glass stays readable.
function tintColor(item) {
  const [hh, s, l] = rgbHsl(hexRgb(tileColor(item)));
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  return hsl(hh, Math.min(s, 0.85), Math.max(dark ? 0.22 : 0.3, Math.min(l, dark ? 0.5 : 0.6)));
}

function tile(item, big) {
  const name = (item.title || item.website || '?').trim();
  const domain = domainOf(item);
  const lg = logoOf(item);
  const cls = 'tile' + (big ? ' big' : '');
  if (lg && lg.src) {
    // a real logo; small icons sit inset on their own background instead of being blown up
    return h('div', { class: cls + ' logo' + (lg.size < (big ? 96 : 48) ? ' inset' : ''), style: `--tile:${lg.bg || '#ffffff'}`, 'data-domain': domain, 'aria-hidden': 'true' },
      h('img', { src: lg.src, alt: '', draggable: 'false' }));
  }
  const letter = (name.match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase();
  const t = tileStyle(tileColor(item));
  return h('div', { class: cls, style: `--tile:${t.bg};--ink:${t.ink}`, 'data-domain': domain, 'aria-hidden': 'true' }, letter);
}

// New logos arrived: swap the tiles in place (no re-render, so nothing jumps or loses its scroll).
function applyLogos(update) {
  for (const [d, v] of Object.entries(update || {})) { if (v) logos.map.set(d, v); else logos.map.delete(d); }
  for (const el of document.querySelectorAll('#app .tile[data-domain]')) {
    const d = el.dataset.domain;
    if (!update || !(d in update)) continue;
    const it = el.closest('.row') ? state.items.find((x) => x.id === el.closest('.row').dataset.id)
      : state.mode !== 'view' ? state.draft : current();
    if (!it) continue;
    const fresh = tile(it, el.classList.contains('big'));
    if (el.id) fresh.id = el.id;
    el.replaceWith(fresh);
  }
  const cur = state.mode !== 'view' ? state.draft : current();
  if (cur && update && domainOf(cur) in update) setTint(cur);
}
// Ask the main process for the logos of every account (it fetches missing or week-old ones in the background).
async function requestLogos() {
  const domains = [...new Set(state.items.map(domainOf).filter(Boolean))];
  const r = await api.logos(domains);
  if (!r) return;
  logos.on = r.on;
  logos.map = new Map(Object.entries(r.map || {}));
  applyLogos(r.map);
}
async function setLogos(on) {
  const r = await api.setPref('logos', on);
  logos.on = !!(r && r.logos);
  if (!logos.on) logos.map.clear();
  render();
  if (logos.on) requestLogos();
  toast(logos.on ? 'Site logos on' : 'Site logos off · nothing is downloaded');
}
api.onLogos(applyLogos);
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

async function copy(text, secret, what, btn, row) {
  if (!text) return;
  await api.copy(text, secret);
  confirmCopy(btn, row);
  toast(secret ? `${what} copied · clears in 30 s` : `${what} copied`);
}
// The copy button turns into a green tick for a moment; the row it belongs to flashes.
function confirmCopy(btn, row) {
  if (row) { row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash'); }
  const use = btn && btn.querySelector('use');
  if (!use) return;
  clearTimeout(btn._done);
  btn.classList.remove('done'); void btn.offsetWidth;
  use.setAttribute('href', '#i-check');
  btn.classList.add('done');
  btn._done = setTimeout(() => { use.setAttribute('href', '#i-copy'); btn.classList.remove('done'); }, 1400);
}

function openLink(url) {
  if (!url) return;
  api.open(url);
  toast('Opening in your browser…');
}

// ---------- password generator ----------
// Settings are a preference, not a secret, so they live in local storage.
const GEN_DEFAULT = { style: 'apple', length: 20, symbols: true, words: 5 };
function genSettings() {
  try { return { ...GEN_DEFAULT, ...JSON.parse(localStorage.getItem('vault.gen') || '{}') }; } catch { return { ...GEN_DEFAULT }; }
}
function saveGenSettings(s) { try { localStorage.setItem('vault.gen', JSON.stringify(s)); } catch {} }

const rnd = (n) => { const a = new Uint32Array(1); let v; do { crypto.getRandomValues(a); v = a[0]; } while (v >= Math.floor(2 ** 32 / n) * n); return v % n; };

function generatePassword(opts = genSettings()) {
  if (opts.style === 'words') {
    const n = Math.max(3, Math.min(10, opts.words | 0));
    const words = Array.from({ length: n }, () => window.WORDS[rnd(window.WORDS.length)]);
    const up = rnd(n);
    words[up] = words[up][0].toUpperCase() + words[up].slice(1);
    words[rnd(n)] += String(rnd(10));
    return words.join('-');
  }
  if (opts.style === 'random') {
    const len = Math.max(8, Math.min(64, opts.length | 0));
    const sets = ['abcdefghijkmnopqrstuvwxyz', 'ABCDEFGHJKLMNPQRSTUVWXYZ', '23456789'];
    if (opts.symbols) sets.push('!#$%&*+-=?@^_~');
    const all = sets.join('');
    const chars = Array.from({ length: len }, () => all[rnd(all.length)]);
    const pos = Array.from({ length: len }, (_, i) => i);
    for (const set of sets) chars[pos.splice(rnd(pos.length), 1)[0]] = set[rnd(set.length)]; // at least one of each kind
    return chars.join('');
  }
  // Apple-style strong password: "xkvbqe-Tmwz4h-pnrcdu"
  const letters = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
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

// ---------- password health ----------
const COMMON = /^(?:pass(?:word)?|qwerty(?:uiop)?|asdf(?:gh)?|letmein|welcome|admin|iloveyou|monkey|dragon|football|baseball|sunshine|princess|shadow|master|superman|abc|login|zaq1|1q2w3e|111111|123123|000000|1234\d*)/i;
function isWeak(pw) {
  if (!pw) return false;
  if (pw.length < 8 || strength(pw) <= 1) return true;
  if (pw.length < 14 && COMMON.test(pw)) return true;
  // a single word with a number on the end, e.g. "Summer2024!"
  if (pw.length < 14 && /^[A-Za-z]+[\d]{1,4}[^A-Za-z0-9]?$/.test(pw)) return true;
  return false;
}
const OLD_DAYS = 365;
const live = () => state.items.filter((i) => !i.deletedAt);

let healthCache = { items: null, map: new Map() };
// id -> [{ kind: 'reused'|'weak'|'old', text, others? }]
function health() {
  if (healthCache.items === state.items) return healthCache.map;
  const items = live();
  const byPw = new Map();
  for (const it of items) if (it.password) byPw.set(it.password, [...(byPw.get(it.password) || []), it]);
  const map = new Map();
  const now = Date.now();
  for (const it of items) {
    const out = [];
    const same = it.password ? byPw.get(it.password).filter((x) => x.id !== it.id) : [];
    if (same.length) out.push({ kind: 'reused', text: `Reused on ${same.length + 1} accounts`, others: same.map((x) => x.title) });
    if (isWeak(it.password)) out.push({ kind: 'weak', text: 'Weak password' });
    const changed = it.pwChangedAt || it.createdAt;
    if (it.password && changed && now - changed > OLD_DAYS * DAY) out.push({ kind: 'old', text: 'Not changed in over a year' });
    if (out.length) map.set(it.id, out);
  }
  healthCache = { items: state.items, map };
  return map;
}

// ---------- verification codes ----------
async function hmacWeb(alg, key, msg) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' }[alg] }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, msg));
}
const otpOf = (it) => { const f = window.otp.otpField(it); return f ? window.otp.parse(f.value) : null; };
const otpCode = (cfg) => window.otp.code(cfg, hmacWeb);

// Every second: refresh the visible codes and their countdown rings.
async function tickCodes() {
  const els = document.querySelectorAll('[data-otp]');
  for (const el of els) {
    const it = state.items.find((x) => x.id === el.dataset.otp);
    const cfg = it && otpOf(it);
    if (!cfg) continue;
    const left = window.otp.remaining(cfg);
    const code = window.otp.pretty(await otpCode(cfg));
    const txt = el.querySelector('.otp-code');
    if (txt && txt.textContent !== code) {
      const fresh = /\d/.test(txt.textContent); // a new code, not the first fill
      txt.textContent = code;
      if (fresh) { txt.classList.remove('tick'); void txt.offsetWidth; txt.classList.add('tick'); }
    }
    const ring = el.querySelector('.otp-ring');
    if (ring) {
      const frac = left / cfg.period;
      const prev = parseFloat(ring.dataset.left || '0');
      ring.dataset.left = String(frac);
      // a new period: the ring refills with a spring instead of sweeping backwards
      if (frac > prev + 0.02) { ring.classList.add('refill'); clearTimeout(ring._refill); ring._refill = setTimeout(() => ring.classList.remove('refill'), 700); }
      ring.style.setProperty('--left', String(frac));
      ring.classList.toggle('ending', left <= 5);
      ring.title = `New code in ${left} s`;
    }
  }
}
setInterval(tickCodes, 1000);
function otpRing() {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('class', 'otp-ring');
  s.setAttribute('viewBox', '0 0 20 20');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = '<circle cx="10" cy="10" r="8" class="track"/><circle cx="10" cy="10" r="8" class="left" pathLength="100"/>';
  return s;
}

// ---------- persistence ----------
async function persist() {
  const r = await api.save(state.items);
  if (!r.ok) { toast(r.error === 'locked' ? 'Vault is locked' : 'Couldn’t save. Try again.'); return false; }
  requestLogos(); // a new or changed website may need its logo
  return true;
}

// ---------- lock screen ----------
let lockSeq = 0; // the newest lock/unlock transition wins
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function showLock() {
  const seq = ++lockSeq;
  // Secrets leave memory at once; the window then sinks away before the lock card rises.
  state.items = []; state.selectedId = null; state.draft = null; state.mode = 'view'; state.reveal.clear(); state.query = ''; state.view = 'all'; state.showHistory = false;
  logos.map.clear();
  window.fx.closeMenu();
  const appEl = $('#app');
  if (!appEl.hidden) {
    appEl.classList.remove('arrive');
    appEl.classList.add('leaving');
    await pause(230);
    appEl.classList.remove('leaving');
    if (seq !== lockSeq) return;
  }
  const st = await api.status();
  if (seq !== lockSeq) return;
  state.firstRun = !st.exists;
  $('#lock').classList.remove('leaving');
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
  // Recently Deleted keeps accounts for BIN_DAYS, then they go for good.
  const keep = state.items.filter((i) => !i.deletedAt || Date.now() - i.deletedAt < BIN_DAYS * DAY);
  if (keep.length !== state.items.length) { state.items = keep; persist(); }
  // Older vaults and imports: mark 2FA setup-key fields so they show as live codes.
  for (const it of state.items) { const f = window.otp.otpField(it); if (f && !f.kind) { f.kind = 'otp'; f.label = 'Verification code'; } }
  // The lock card lifts away while the window arrives.
  const seq = ++lockSeq;
  const lockEl = $('#lock');
  if (!lockEl.hidden) {
    lockEl.classList.add('leaving');
    setTimeout(() => { if (seq !== lockSeq) return; lockEl.hidden = true; lockEl.classList.remove('leaving'); }, 300);
  }
  document.body.classList.remove('lock-mode');
  const app = $('#app');
  app.classList.remove('leaving');
  app.hidden = false;
  app.classList.remove('arrive'); void app.offsetWidth; app.classList.add('arrive');
  const first = matches()[0];
  state.selectedId = first ? first.it.id : null;
  state.animateRows = true;
  render();
  requestLogos();
  $('#q').focus();
  bumpIdle();
}

async function lockNow() {
  await api.lock();
  showLock();
}

// ---------- search ----------
const SEVERITY = { reused: 0, weak: 1, old: 2 };
function inView() {
  const v = state.view;
  if (v === 'deleted') return state.items.filter((i) => i.deletedAt).sort((a, b) => b.deletedAt - a.deletedAt);
  const items = live();
  if (v === 'favorites') return items.filter((i) => i.favorite);
  if (v === 'codes') return items.filter((i) => otpOf(i));
  if (v === 'security') {
    const hm = health();
    const sev = (i) => Math.min(...hm.get(i.id).map((x) => SEVERITY[x.kind]));
    return items.filter((i) => hm.has(i.id)).sort((a, b) => sev(a) - sev(b) || byTitle(a, b));
  }
  return items.slice().sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || byTitle(a, b)); // favorites first
}

function matches() {
  const q = state.query.trim().toLowerCase();
  if (!q) return inView().map((it) => ({ it, score: 0 }));
  // Search always looks through every account (or the whole bin, when that's open).
  const pool = state.view === 'deleted' ? inView() : live();
  const terms = q.split(/\s+/);
  const out = [];
  for (const it of pool) {
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

function renderViews() {
  const hm = health();
  const items = live();
  const counts = {
    all: items.length,
    favorites: items.filter((i) => i.favorite).length,
    codes: items.filter((i) => otpOf(i)).length,
    security: hm.size,
    deleted: state.items.length - items.length,
  };
  const views = $('#views');
  for (const t of [...views.querySelectorAll('.view-tab')]) t.remove(); // the pill stays, so it can glide
  views.append(...VIEWS.map((v) => h('button', {
    class: 'view-tab', role: 'tab', id: 'view-' + v.id, 'aria-selected': String(state.view === v.id),
    title: `${v.label} (${counts[v.id]})`, onclick: () => setView(v.id),
  }, h('span', { class: 'view-icon' }, icon(v.icon), v.id === 'security' && counts.security ? h('b', { class: 'badge' }, counts.security > 99 ? '99+' : String(counts.security)) : null),
  h('span', { class: 'view-label' }, v.label))));
  placePill(views, '.view-pill', document.getElementById('view-' + state.view), 'x');
  return counts;
}

// A pill that glides to the selected element (view tabs, list selection). It stays in the DOM
// between renders so the browser can transition its transform.
function placePill(parent, sel, target, axis) {
  let pill = parent.querySelector(':scope > ' + sel);
  const fresh = !pill;
  if (fresh) { pill = h(sel === '.view-pill' ? 'div' : 'li', { class: sel.slice(1), 'aria-hidden': 'true', role: 'presentation' }); parent.prepend(pill); }
  if (!target || !target.offsetWidth) { pill.style.opacity = '0'; pill.dataset.hidden = '1'; return pill; }
  const jump = fresh || pill.dataset.hidden === '1' || pill.dataset.jump === '1';
  pill.classList.toggle('jump', jump);
  if (axis === 'x') pill.style.width = target.offsetWidth + 'px';
  pill.style.transform = axis === 'x' ? `translateX(${target.offsetLeft}px)` : `translateY(${target.offsetTop}px)`;
  pill.style.opacity = '';
  delete pill.dataset.hidden; delete pill.dataset.jump;
  if (jump) { void pill.offsetWidth; pill.classList.remove('jump'); }
  return pill;
}

async function setView(id) {
  if (state.view === id) return;
  if (state.mode !== 'view' && !(await cancelEdit())) return;
  state.view = id;
  state.showHistory = false;
  state.selectedId = null;
  state.animateRows = true;
  render();
}

function rowSub(it) {
  if (state.view === 'deleted') {
    const days = Math.max(0, BIN_DAYS - Math.floor((Date.now() - it.deletedAt) / DAY));
    return `${days} ${days === 1 ? 'day' : 'days'} left`;
  }
  if (state.view === 'security') {
    const iss = health().get(it.id);
    if (iss) return h('span', { class: 'issue-sub ' + iss[0].kind }, iss.map((x) => x.text).join(' · '));
  }
  if (state.view === 'codes') return h('span', { class: 'row-otp', 'data-otp': it.id }, otpRing(), h('span', { class: 'otp-code' }, '··· ···'));
  return it.username || (window.loginLink(it) || {}).host || 'No user name';
}

function renderList() {
  const list = $('#list');
  const counts = renderViews();
  const res = matches();
  const q = state.query.trim();
  const v = VIEWS.find((x) => x.id === state.view);
  $('#qClear').hidden = !state.query;
  $('#listMeta').textContent = q ? `${res.length} ${res.length === 1 ? 'Result' : 'Results'}`
    : state.view === 'deleted' && counts.deleted ? `Recently Deleted · removed after ${BIN_DAYS} days`
    : `${v.id === 'all' ? '' : v.label + ' · '}${res.length} ${res.length === 1 ? 'Account' : 'Accounts'}`;

  if (state.mode === 'view') {
    if (res.length && !res.some((r) => r.it.id === state.selectedId)) state.selectedId = res[0].it.id;
    if (!res.length) state.selectedId = null;
  }
  const enter = state.animateRows;
  state.animateRows = false;
  const rows = res.map(({ it }, i) => h('li', {
    class: 'row' + (enter && i < 14 ? ' enter' : ''), role: 'option', id: 'row-' + it.id, 'data-id': it.id,
    style: enter && i < 14 ? `--i:${i}` : null,
    'aria-selected': String(it.id === state.selectedId),
    onclick: () => select(it.id, true),
    ondblclick: () => { if (it.deletedAt) return; const l = window.loginLink(it); if (l) openLink(l.url); },
    oncontextmenu: (e) => { e.preventDefault(); rowMenu(it, e); },
  }, tile(it), h('div', { class: 'row-text' },
    h('div', { class: 'row-title' }, highlight(it.title, q), it.favorite && state.view !== 'favorites' ? icon('i-star-fill', 'row-star') : null),
    h('div', { class: 'row-sub' }, rowSub(it)))));
  const pill = list.querySelector(':scope > .list-sel');
  for (const c of [...list.children]) if (c !== pill) c.remove(); // keep the selection pill so it can glide
  list.append(...rows);

  if (!res.length) {
    const [title, text] = v.empty;
    list.append(q
      ? h('li', { class: 'empty-list' }, h('strong', {}, 'No results'), `Nothing matches “${q}”.`)
      : h('li', { class: 'empty-list' }, h('strong', {}, title), text));
  }
  if (enter && pill) pill.dataset.jump = '1';
  const selPill = placePill(list, '.list-sel', document.getElementById('row-' + state.selectedId), 'y');
  if (enter && selPill.dataset.hidden !== '1' && !window.fx.reduced()) selPill.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 400, delay: 120, fill: 'backwards' });
  if (state.view === 'codes') tickCodes();
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
  const color = name ? tintColor(item) : '#0a6cff';
  document.documentElement.style.setProperty('--tint', color);
  const [a, b] = document.querySelectorAll('.backdrop .b1');
  const on = a.classList.contains('off') ? b : a;
  const off = on === a ? b : a;
  if (on.dataset.color === color) return;
  off.style.backgroundColor = color;
  off.dataset.color = color;
  off.classList.remove('off');
  on.classList.add('off');
}

function renderDetail() {
  const d = $('#detail');
  const it = current();
  setTint(state.mode !== 'view' ? state.draft : it);
  if (state.mode === 'edit' || state.mode === 'new') return d.replaceChildren(...editView());
  if (!it) return d.replaceChildren(h('div', { class: 'detail-bar drag' }), blankView());
  const fly = state.flyTile && lastShownId !== it.id;
  state.flyTile = false;
  d.replaceChildren(...detailView(it));
  if (fly) window.fx.flyTile(document.querySelector(`#row-${CSS.escape(it.id)} .tile`), d.querySelector('.hero .tile'));
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
    !empty ? h('button', { class: 'mini-btn', 'data-copy': '', title: 'Copy', 'aria-label': `Copy ${label}`, onclick: (e) => { e.stopPropagation(); copy(value, secret, copyName || label, e.currentTarget, e.currentTarget.closest('.field-row')); } }, icon('i-copy')) : null);

  return h('div', {
    class: 'field-row' + (empty || link ? '' : ' clickable'),
    onclick: empty || link ? null : (e) => copy(value, secret, copyName || label, e.currentTarget.querySelector('[data-copy]'), e.currentTarget),
  }, h('div', { class: 'f-label' }, label), valueEl, actions);
}

function detailView(it) {
  const link = window.loginLink(it);
  const deleted = !!it.deletedAt;
  const bar = deleted
    ? h('div', { class: 'detail-bar drag' },
      h('button', { class: 'glass-btn glass danger-text', onclick: () => purgeItem(it) }, 'Delete Now'),
      h('button', { class: 'btn-primary', onclick: () => recoverItem(it) }, 'Recover'))
    : h('div', { class: 'detail-bar drag' },
      h('button', {
        class: 'glass-btn glass star-btn' + (it.favorite ? ' on' : ''), onclick: () => toggleFavorite(it),
        'aria-pressed': String(!!it.favorite), 'aria-label': it.favorite ? 'Remove from Favorites' : 'Add to Favorites',
        title: (it.favorite ? 'Remove from Favorites' : 'Add to Favorites') + ' (Ctrl+D)',
      }, icon(it.favorite ? 'i-star-fill' : 'i-star')),
      h('button', { class: 'glass-btn glass', onclick: () => startEdit(it), title: 'Edit (Ctrl+E)' }, 'Edit'));

  const hero = h('div', { class: 'hero' }, tile(it, true),
    h('div', { class: 'hero-text' },
      h('h1', {}, it.title),
      h('div', { class: 'hero-sub' }, link ? link.host : (it.username || ''))),
    link && !deleted ? h('button', { class: 'btn-primary', onclick: () => openLink(link.url), title: link.url + '  (Ctrl+O)' }, icon('i-open'), 'Open Login Page') : null);

  const notice = deleted ? h('div', { class: 'notice' }, icon('i-trash'), h('div', {},
    h('strong', {}, 'In Recently Deleted'),
    h('span', {}, `Deleted ${fmtDate(it.deletedAt)}. It’s removed for good on ${fmtDate(it.deletedAt + BIN_DAYS * DAY)}.`))) : null;

  const issues = deleted ? null : health().get(it.id);
  const security = issues ? h('div', { class: 'notice warn' }, icon('i-shield'), h('div', {},
    ...issues.map((x) => h('div', { class: 'issue' }, h('strong', {}, x.text), x.kind === 'reused'
      ? h('span', {}, `Also used for ${x.others.slice(0, 3).join(', ')}${x.others.length > 3 ? ` and ${x.others.length - 3} more` : ''}. If one site leaks it, the others are open too.`)
      : x.kind === 'weak' ? h('span', {}, 'It’s short or easy to guess.')
      : h('span', {}, `Last changed ${fmtDate(it.pwChangedAt || it.createdAt)}.`))),
    link ? h('button', { class: 'btn-plain notice-btn', onclick: () => { openLink(link.url); } }, 'Change Password on Website', icon('i-open')) : null)) : null;

  const cfg = otpOf(it);
  const otpF = window.otp.otpField(it);
  const codeRow = cfg ? h('div', {
    class: 'field-row clickable', 'data-otp': it.id, title: 'Click to copy',
    onclick: async (e) => { const row = e.currentTarget; copy(await otpCode(cfg), true, 'Code', row.querySelector('[data-copy]'), row); },
  }, h('div', { class: 'f-label' }, 'Verification code'),
  h('div', { class: 'f-value otp-value' }, otpRing(), h('span', { class: 'otp-code' }, '··· ···')),
  h('div', { class: 'row-actions' }, h('button', { class: 'mini-btn', 'data-copy': '', title: 'Copy', 'aria-label': 'Copy verification code', onclick: async (e) => { e.stopPropagation(); const b = e.currentTarget; copy(await otpCode(cfg), true, 'Code', b, b.closest('.field-row')); } }, icon('i-copy')))) : null;

  const main = h('div', { class: 'group' },
    valueRow({ label: 'User name', value: it.username, id: 'u', copyName: 'User name' }),
    valueRow({ label: 'Password', value: it.password, secret: true, id: 'pw', copyName: 'Password' }),
    codeRow,
    link ? valueRow({ label: 'Website', value: link.url.replace(/^https:\/\//, '').replace(/\/$/, ''), link: deleted ? null : link.url }) : null);

  const otherFields = (it.fields || []).filter((f) => !(cfg && f === otpF));
  const extras = otherFields.length ? [
    h('div', { class: 'section-label' }, 'Other Fields'),
    h('div', { class: 'group' }, otherFields.map((f) => valueRow({ label: f.label || 'Field', value: f.value, secret: f.secret, id: f.id, copyName: f.label || 'Field' }))),
  ] : [];

  const hist = it.history || [];
  const history = hist.length ? [
    h('div', { class: 'section-label' }, 'Password History'),
    h('div', { class: 'group' },
      h('button', {
        class: 'disclosure', 'aria-expanded': String(state.showHistory),
        onclick: () => { state.showHistory = !state.showHistory; renderDetail(); },
      }, h('span', {}, `${hist.length} previous ${hist.length === 1 ? 'password' : 'passwords'}`), icon('i-chevron')),
      state.showHistory ? hist.map((p, i) => valueRow({ label: 'Until ' + fmtDate(p.changedAt), value: p.value, secret: true, id: 'h' + i, copyName: 'Old password' })) : null),
  ] : [];

  const notes = it.notes ? [
    h('div', { class: 'section-label' }, 'Notes'),
    h('div', { class: 'group' }, h('div', { class: 'notes-view' }, it.notes)),
  ] : [];

  const meta = h('div', { class: 'meta' }, `Edited ${fmtDate(it.updatedAt)} · Created ${fmtDate(it.createdAt)}`);
  const swap = lastShownId !== it.id;
  lastShownId = it.id;
  setTimeout(tickCodes, 0);
  return [bar, h('div', { class: 'detail-scroll' }, h('div', { class: 'detail-inner' + (swap ? ' swap' : '') }, hero, notice, security, main, ...extras, ...history, ...notes, meta))];
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
  // Check the 2FA key before touching the draft, so the user can fix it and save again.
  const of = d.fields.find((f) => f.kind === 'otp');
  if (of && of.value.trim() && !window.otp.parse(of.value)) {
    toast('That setup key isn’t valid');
    const el = $('#f-otp'); if (el) { el.focus(); el.classList.add('field-error'); }
    return;
  }
  d.fields = d.fields
    .filter((f) => (f.kind === 'otp' ? f.value.trim() : f.label.trim() || f.value))
    .map((f) => ({ ...f, label: f.label.trim() || 'Field', ...(f.kind === 'otp' ? { value: f.value.trim() } : {}) }));
  const old = state.mode === 'edit' ? current() : null;
  if (!old || old.password !== d.password) d.pwChangedAt = Date.now();
  if (old && old.password && old.password !== d.password) {
    d.history = [{ value: old.password, changedAt: Date.now() }, ...(old.history || [])].slice(0, 10);
  }
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
        h('button', { class: 'mini-btn', title: 'Suggest a strong password', 'aria-label': 'Suggest a strong password', onclick: () => { d.password = generatePassword(); d._showPw = true; pwInput.value = d.password; pwInput.type = 'text'; toast('Strong password suggested'); } }, icon('i-key')),
        h('button', { class: 'mini-btn', title: 'Password options', 'aria-label': 'Password options', onclick: async () => { const pw = await generatorFlow(true); if (pw) { d.password = pw; d._showPw = true; pwInput.value = pw; pwInput.type = 'text'; } } }, icon('i-sliders')))),
    otpEditRow(d),
    h('div', { class: 'field-row' }, h('label', { class: 'f-label', for: 'f-web' }, 'Website'),
      h('input', { id: 'f-web', class: 'in', value: d.website, placeholder: 'netflix.com', oninput: set('website'), spellcheck: 'false', autocomplete: 'off' }), h('span')));

  const hint = h('div', { class: 'hint', id: 'linkHint' });
  updateLinkHint(hint);

  const fieldRows = d.fields.map((f, i) => {
    if (f.kind === 'otp') return null; // shown in the main group
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
    class: 'add-row', id: 'addField', onclick: () => {
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

// Verification code (2FA) setup inside the edit view.
function otpEditRow(d) {
  const f = d.fields.find((x) => x.kind === 'otp');
  if (!f) {
    return h('button', {
      class: 'add-row', id: 'otpSetup', onclick: () => {
        d.fields.push({ id: window.transfer.uid(), label: 'Verification code', value: '', secret: true, kind: 'otp' });
        renderDetail();
        setTimeout(() => $('#f-otp') && $('#f-otp').focus(), 20);
      },
    }, icon('i-timer'), 'Set Up Verification Code…');
  }
  const note = h('div', { class: 'otp-note' });
  const check = () => {
    const ok = !f.value.trim() || !!window.otp.parse(f.value);
    input.classList.toggle('field-error', !ok);
    note.textContent = !f.value.trim()
      ? 'On the site’s 2FA page, choose “Can’t scan the QR code?” and paste the setup key or otpauth:// link here.'
      : ok ? 'Codes will show on this account and in Codes.' : 'That doesn’t look like a setup key yet.';
  };
  const input = h('input', {
    id: 'f-otp', class: 'in secret', type: 'text', value: f.value, placeholder: 'Setup key, e.g. JBSW Y3DP EHPK 3PXP',
    'aria-label': 'Verification code setup key', spellcheck: 'false', autocomplete: 'off',
    oninput: (e) => { f.value = e.target.value; check(); },
  });
  check();
  return h('div', { class: 'field-row otp-edit' },
    h('label', { class: 'f-label', for: 'f-otp' }, 'Verification code'),
    h('div', { class: 'otp-edit-main' }, input, note),
    h('div', { class: 'edit-tools' },
      h('button', { class: 'remove-btn', title: 'Remove verification code', 'aria-label': 'Remove verification code', onclick: () => { d.fields = d.fields.filter((x) => x !== f); renderDetail(); } }, icon('i-minus'))));
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
async function select(id, fly) {
  if (id === state.selectedId && state.mode === 'view') return;
  if (state.mode !== 'view' && !(await cancelEdit())) return;
  state.selectedId = id;
  state.reveal.clear();
  state.flyTile = !!fly; // clicked in the list: the tile flies from the row into the header
  render();
}

// Replace one account, save, and keep the selection sensible if it leaves the current list.
async function updateItem(it, patch, msg) {
  const before = state.items;
  const idx = matches().findIndex((r) => r.it.id === it.id);
  const next = { ...it, ...patch };
  for (const k of Object.keys(patch)) if (patch[k] === undefined) delete next[k];
  state.items = before.map((x) => (x.id === it.id ? next : x));
  if (!(await persist())) { state.items = before; return false; }
  state.mode = 'view'; state.draft = null;
  const res = matches();
  if (!res.some((r) => r.it.id === it.id)) state.selectedId = res.length ? res[Math.min(Math.max(idx, 0), res.length - 1)].it.id : null;
  render();
  if (msg) toast(msg);
  return true;
}

async function deleteItem(it) {
  if (!it || it.deletedAt) return it && purgeItem(it);
  const ok = await confirmAlert(`Delete “${it.title}”?`, `It moves to Recently Deleted, where you can recover it for ${BIN_DAYS} days.`, 'Delete', true);
  if (!ok) return;
  await updateItem(it, { deletedAt: Date.now() }, 'Moved to Recently Deleted');
}

function recoverItem(it) {
  return updateItem(it, { deletedAt: undefined }, `“${it.title}” recovered`);
}

async function purgeItem(it) {
  const ok = await confirmAlert(`Delete “${it.title}” now?`, 'It’s removed from your vault for good. You can’t undo this.', 'Delete', true);
  if (!ok) return;
  const before = state.items;
  const idx = matches().findIndex((r) => r.it.id === it.id);
  state.items = before.filter((x) => x.id !== it.id);
  if (!(await persist())) { state.items = before; return; }
  const res = matches();
  state.selectedId = res.length ? res[Math.min(idx, res.length - 1)].it.id : null;
  render();
  toast('Deleted for good');
}

function toggleFavorite(it) {
  if (!it || it.deletedAt) return;
  return updateItem(it, { favorite: it.favorite ? undefined : true }, it.favorite ? 'Removed from Favorites' : 'Added to Favorites');
}

// Right-click (or the Menu key / Shift+F10) on an account. Items that can't be used are left out.
async function rowMenu(it, e) {
  if (state.mode === 'view' && state.selectedId !== it.id) await select(it.id);
  const link = window.loginLink(it);
  const cfg = otpOf(it);
  const keyboard = !e || (e.clientX === 0 && e.clientY === 0);
  const row = document.getElementById('row-' + it.id);
  const items = it.deletedAt ? [
    it.username && { label: 'Copy User Name', value: 'copy-user' },
    it.password && { label: 'Copy Password', value: 'copy-password' },
    'sep',
    { label: 'Recover', value: 'recover' },
    { label: 'Delete Now…', value: 'purge', danger: true },
  ] : [
    it.username && { label: 'Copy User Name', value: 'copy-user', key: 'Ctrl+Shift+U' },
    it.password && { label: 'Copy Password', value: 'copy-password', key: 'Ctrl+Shift+C' },
    cfg && { label: 'Copy Verification Code', value: 'copy-code' },
    link && { label: 'Open Login Page', value: 'open', key: 'Ctrl+O' },
    'sep',
    { label: it.favorite ? 'Remove from Favorites' : 'Add to Favorites', value: 'favorite', key: 'Ctrl+D' },
    { label: 'Edit', value: 'edit', key: 'Ctrl+E' },
    'sep',
    { label: 'Delete…', value: 'delete', key: 'Del', danger: true },
  ];
  const at = keyboard && row ? { anchor: row, align: 'start', keyboard: true } : { x: e.clientX, y: e.clientY };
  const pick = await window.fx.menu(items, { ...at, label: it.title, opener: $('#q') === document.activeElement ? $('#q') : null });
  if (pick === 'copy-user') copy(it.username, false, 'User name');
  if (pick === 'copy-password') copy(it.password, true, 'Password');
  if (pick === 'copy-code' && cfg) copy(await otpCode(cfg), true, 'Code');
  if (pick === 'open' && link) openLink(link.url);
  if (pick === 'favorite') toggleFavorite(it);
  if (pick === 'edit') { await select(it.id); startEdit(it); }
  if (pick === 'delete') deleteItem(it);
  if (pick === 'recover') recoverItem(it);
  if (pick === 'purge') purgeItem(it);
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
  const { fresh, skipped } = window.transfer.dedupe(live(), incoming);
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
  state.query = ''; $('#q').value = ''; state.view = 'all';
  state.animateRows = true;
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
  const contents = kind === 'csv' ? window.transfer.toCSV(live()) : kind === 'json' ? window.transfer.toJSON(live()) : '';
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

async function moreMenu(e) {
  const btn = $('#moreBtn');
  if (window.fx.closedBy(btn)) return; // this click closed the open menu
  const p = await api.appPrefs();
  const pick = await window.fx.menu([
    { label: 'Import Passwords…', value: 'import', key: 'Ctrl+I' },
    { label: 'Export Passwords…', value: 'export', key: 'Ctrl+Shift+E' },
    'sep',
    { label: 'Back Up Vault…', value: 'backup' },
    { label: 'Restore From Backup…', value: 'restore' },
    'sep',
    { label: 'Password Generator…', value: 'generator', key: 'Ctrl+G' },
    { label: 'Connect a Browser…', value: 'browser' },
    { label: 'Change Master Password…', value: 'change-password' },
    'sep',
    { label: 'Quick Search', value: 'quick', key: 'Ctrl+Shift+Space' },
    p.openAtLogin != null ? { label: 'Open Vault When Windows Starts', value: 'login-item', checked: p.openAtLogin } : null,
    { label: 'Download Site Logos', value: 'logos', checked: p.logos },
    { label: 'Check for Updates…', value: 'check-updates' },
    { label: 'Show Vault File', value: 'show-file' },
  ], { anchor: btn, align: 'start', keyboard: !!e && e.detail === 0, label: 'More', opener: btn });
  if (pick === 'quick') api.showQuick();
  else if (pick === 'login-item') api.setPref('openAtLogin', !p.openAtLogin);
  else if (pick === 'logos') setLogos(!p.logos);
  else if (pick === 'show-file') api.showVaultFile();
  else handleCommand(pick);
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
  if (cmd === 'generator') generatorFlow(false);
  if (cmd === 'browser') browserFlow();
  if (cmd && cmd.startsWith('view:')) setView(cmd.slice(5));
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

// ---------- password options ----------
const GEN_TEXT = {
  apple: 'Like Apple’s suggestions: 20 characters, easy to type on a phone, and accepted by almost every site.',
  random: 'Fully random characters. The strongest per character, but hard to type by hand.',
  words: 'Random words you can read and type easily, e.g. for a Wi-Fi or a TV login.',
};
// forEdit: resolves with the chosen password; from the menu it copies it instead.
function generatorFlow(forEdit) {
  const dlg = $('#genDlg');
  const form = $('#genForm');
  const s = genSettings();
  const radios = form.querySelectorAll('input[name="gstyle"]');
  radios.forEach((r) => { r.checked = r.value === s.style; });
  const sync = (regen = true) => {
    s.style = form.querySelector('input[name="gstyle"]:checked').value;
    const words = s.style === 'words';
    $('#genLenRow').hidden = s.style === 'apple';
    $('#genSymRow').hidden = s.style !== 'random';
    const len = $('#genLen');
    len.min = words ? 3 : 8; len.max = words ? 10 : 64;
    len.value = words ? s.words : s.length;
    $('#genLenLabel').textContent = words ? 'Words' : 'Length';
    $('#genLenVal').textContent = len.value;
    $('#genSym').checked = !!s.symbols;
    $('#genDesc').textContent = GEN_TEXT[s.style];
    if (regen) $('#genOut').textContent = generatePassword(s);
    saveGenSettings(s);
  };
  radios.forEach((r) => { r.onchange = () => sync(); });
  $('#genLen').oninput = (e) => { if (s.style === 'words') s.words = +e.target.value; else s.length = +e.target.value; sync(); };
  $('#genSym').onchange = (e) => { s.symbols = e.target.checked; sync(); };
  $('#genAgain').onclick = () => sync();
  $('#genGo').textContent = forEdit ? 'Use Password' : 'Copy';
  sync();
  dlg.returnValue = '';
  dlg.showModal();
  $('#genGo').focus();
  return new Promise((resolve) => dlg.addEventListener('close', () => {
    const pw = dlg.returnValue === 'ok' ? $('#genOut').textContent : null;
    if (pw && !forEdit) copy(pw, true, 'Password');
    resolve(forEdit ? pw : null);
  }, { once: true }));
}

// ---------- connect a browser ----------
let brKnown = 0;
function renderBrowsers(st) {
  const list = (st && st.clients) || [];
  const box = $('#brClients');
  box.replaceChildren(...(list.length ? [
    h('div', { class: 'section-label' }, 'Connected'),
    h('div', { class: 'group' }, list.map((c) => h('div', { class: 'field-row br-row' },
      h('div', { class: 'f-label' }, c.name),
      h('div', { class: 'f-value muted' }, 'Since ' + fmtDate(c.added)),
      h('button', { type: 'button', class: 'btn-plain danger-text', onclick: async () => {
        if (!(await confirmAlert(`Disconnect ${c.name}?`, 'It can’t fill logins any more until you pair it again.', 'Disconnect', true))) return;
        renderBrowsers(await api.bridgeRemove(c.id));
        browserFlow(true);
      } }, 'Remove')))),
  ] : []));
  // A browser just paired while the dialog is open.
  if (list.length > brKnown && $('#browserDlg').open) {
    $('#brCodeRow').hidden = true;
    $('#brAgain').hidden = false;
    $('#brPairText').textContent = `${list[list.length - 1].name} is connected. Click the Vault icon there to fill logins.`;
    toast('Browser connected');
  }
  brKnown = list.length;
}
async function newPairCode() {
  const r = await api.bridgePair();
  $('#brCode').textContent = r ? r.code : 'Unavailable';
  $('#brCodeRow').hidden = false;
  $('#brAgain').hidden = true;
  $('#brPairText').textContent = 'Click the Vault icon in the browser’s toolbar and paste this code. It works once, for 10 minutes.';
}
async function browserFlow(reopen) {
  const dlg = $('#browserDlg');
  const st = await api.bridgeState();
  brKnown = st.clients.length;
  renderBrowsers(st);
  if (reopen) return;
  await newPairCode();
  $('#brFolder').onclick = async () => { const dir = await api.bridgeFolder(); toast(dir ? 'Extension folder opened' : 'Couldn’t open the folder'); };
  $('#brCopy').onclick = () => api.copy($('#brCode').textContent, false).then(() => toast('Code copied'));
  $('#brAgain').onclick = newPairCode;
  dlg.showModal();
  dlg.addEventListener('close', () => api.bridgeCancel(), { once: true });
}
api.onBridge(renderBrowsers);

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
  if (ctrl && !e.shiftKey && /^[1-5]$/.test(e.key)) { e.preventDefault(); setView(VIEWS[+e.key - 1].id); return; }
  if (ctrl && e.key.toLowerCase() === 'd' && it) { e.preventDefault(); toggleFavorite(it); return; }
  if (ctrl && e.key.toLowerCase() === 'e' && it && !it.deletedAt) { e.preventDefault(); startEdit(it); return; }
  if (ctrl && e.key.toLowerCase() === 'o' && it) { e.preventDefault(); const l = window.loginLink(it); if (l) openLink(l.url); return; }
  if (ctrl && e.shiftKey && e.key.toLowerCase() === 'c' && it) { e.preventDefault(); copy(it.password, true, 'Password'); return; }
  if (ctrl && e.shiftKey && e.key.toLowerCase() === 'u' && it) { e.preventDefault(); copy(it.username, false, 'User name'); return; }

  const inSearch = document.activeElement === $('#q');
  if ((inSearch || !inField) && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); moveSelection(e.key === 'ArrowDown' ? 1 : -1); return; }
  if (inSearch && e.key === 'Enter' && it) { e.preventDefault(); const l = window.loginLink(it); if (l) openLink(l.url); return; }
  if ((e.key === 'Delete') && !inField && it) { e.preventDefault(); deleteItem(it); return; }
  if ((e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) && (inSearch || !inField) && it) { e.preventDefault(); rowMenu(it, null); return; }
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
$('#moreBtn').addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); moreMenu({ detail: 0 }); } });
$('#exportForm').addEventListener('submit', exportSubmit);
$('#changePwForm').addEventListener('submit', changePwSubmit);
$('#q').addEventListener('focus', () => document.querySelector('.sidebar').classList.add('list-active'));
$('#q').addEventListener('blur', () => document.querySelector('.sidebar').classList.remove('list-active'));
api.onMenu(handleCommand);
api.onUpdate(showUpdate);
$('#updateGo').addEventListener('click', installUpdate);
api.onLocked(showLock);
// Unlocked from the quick-search panel: open the main window too.
api.onUnlocked((items) => { if (!$('#app').hidden) return; unlocked(items); });
// Quick search changed nothing, but keep the window from auto-locking while it's in use.
api.onActivity(bumpIdle);

window.__vaultState = state; // read by the automated smoke test only
showLock();
