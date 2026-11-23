'use strict';
// Import from / export to other password managers.
// CSV: Apple Passwords, Chrome / Edge / Google, Firefox, Bitwarden, 1Password,
// LastPass, Proton Pass, KeePass / KeePassXC, Dashlane, NordPass and most others.
// JSON: Bitwarden (unencrypted export) and Vault's own JSON export.

function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  // Excel in many European locales saves with ";" — detect from the header line.
  const firstLine = text.split(/\r?\n/, 1)[0];
  const delim = (firstLine.split(';').length > firstLine.split(',').length) ? ';' : ',';
  const rows = [];
  let row = [], field = '', i = 0, quoted = false;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { quoted = true; i++; continue; }
    if (c === delim) { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

// Header synonyms used by the common apps (lower-cased, spaces/underscores removed).
const COLS = {
  title: ['title', 'name', 'account', 'itemname', 'entry', 'site', 'sitename'],
  website: ['url', 'website', 'loginuri', 'weburl', 'website', 'websites', 'webaddress', 'hostname', 'origin', 'loginurl', 'urls'],
  username: ['username', 'loginusername', 'login', 'loginname', 'user', 'email', 'emailaddress', 'username1', 'userid'],
  password: ['password', 'loginpassword', 'pass', 'pwd'],
  notes: ['notes', 'note', 'comments', 'comment', 'extra', 'notesplain'],
  totp: ['otpauth', 'totp', 'logintotp', 'onetimepassword', 'otp', 'otpsecret', 'otpurl', 'twofactorsecret', 'authenticator'],
  fields: ['fields'], // Bitwarden "label: value" lines
};
// Columns that are bookkeeping, not worth keeping as fields.
const IGNORE = new Set(['folder', 'favorite', 'fav', 'favoritestatus', 'archivedstatus', 'type', 'reprompt', 'grouping', 'group',
  'httprealm', 'formactionorigin', 'guid', 'timecreated', 'timelastused', 'timepasswordchanged', 'createtime', 'modifytime',
  'vault', 'category', 'tags', 'lastmodified', 'created', 'lastmodificationtime', 'creationtime', 'icon', 'id', 'uuid', 'collections',
  'passwordhistory', 'expires', 'expirytime', 'path']);

const norm = (h) => String(h).toLowerCase().replace(/[\s_\-().]/g, '');

function uid() {
  const a = new Uint8Array(9); crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 14);
}

// "Netflix (netflix.com)" -> "Netflix"; "accounts.google.com" -> "Google".
function tidyTitle(title) {
  const m = title.match(/^(.+?)\s*\(([^()\s]+\.[^()\s]+)\)$/);
  if (m) title = m[1].trim();
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(title) && !/^\d+(\.\d+)+$/.test(title)) {
    const parts = title.toLowerCase().split('.');
    const sld = parts.length > 2 && /^(co|com|org|net|gov|ac)$/.test(parts[parts.length - 2]) ? parts[parts.length - 3] : parts[parts.length - 2];
    if (sld) title = sld.charAt(0).toUpperCase() + sld.slice(1);
  }
  return title;
}

function makeItem(p) {
  const now = Date.now();
  let title = tidyTitle((p.title || '').trim());
  const website = (p.website || '').trim();
  if (!title && website) { const u = window.hostOf(website); title = u ? tidyTitle(u.hostname) : website; }
  if (!title) title = (p.username || '').trim() || 'Untitled';
  return {
    id: uid(), title, website, username: (p.username || '').trim(), password: p.password || '',
    fields: (p.fields || []).filter((f) => f.value !== '' && f.value != null),
    notes: (p.notes || '').trim(), createdAt: now, updatedAt: now,
  };
}

function looksSecret(label) {
  return /pass|secret|token|key|pin|otp|totp|code|cvv|recovery|seed/i.test(label);
}

function fromCSV(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error('No accounts found in this file.');
  const header = rows[0].map(norm);
  const pick = {};
  for (const [key, names] of Object.entries(COLS)) {
    // first column matching the most specific synonym order
    for (const n of names) { const i = header.indexOf(n); if (i >= 0 && !Object.values(pick).includes(i)) { pick[key] = i; break; } }
  }
  if (pick.password == null && pick.username == null) {
    throw new Error('This CSV has no username or password column. Export again as “CSV” from your other app.');
  }
  const used = new Set(Object.values(pick));
  const items = [];
  for (const r of rows.slice(1)) {
    const get = (k) => (pick[k] != null ? (r[pick[k]] || '') : '');
    const fields = [];
    if (get('totp')) fields.push({ id: uid(), label: 'One-time code (2FA) secret', value: get('totp'), secret: true });
    if (get('fields')) {
      for (const line of get('fields').split(/\r?\n/)) {
        const m = line.match(/^([^:]+):\s?(.*)$/);
        if (m && m[2]) fields.push({ id: uid(), label: m[1].trim(), value: m[2], secret: looksSecret(m[1]) });
      }
    }
    header.forEach((h, i) => {
      if (used.has(i) || IGNORE.has(h) || !r[i] || !r[i].trim()) return;
      const label = rows[0][i].trim();
      fields.push({ id: uid(), label, value: r[i], secret: looksSecret(label) });
    });
    const it = makeItem({ title: get('title'), website: get('website'), username: get('username'), password: get('password'), notes: get('notes'), fields });
    if (it.username || it.password || it.fields.length || it.notes) items.push(it);
  }
  return items;
}

function fromJSON(text) {
  const data = JSON.parse(text.replace(/^﻿/, ''));
  if (data.encrypted) throw new Error('This Bitwarden export is encrypted. Export again and choose “.json” (not “.json (Encrypted)”).');
  // Vault's own export
  if (data.app === 'vault' && Array.isArray(data.items)) {
    return data.items.map((x) => makeItem({ ...x, fields: (x.fields || []).map((f) => ({ ...f, id: uid() })) }));
  }
  // Bitwarden
  if (Array.isArray(data.items)) {
    return data.items.filter((x) => x.type === 1 || x.login || x.notes).map((x) => {
      const login = x.login || {};
      const fields = [];
      if (login.totp) fields.push({ id: uid(), label: 'One-time code (2FA) secret', value: login.totp, secret: true });
      for (const f of x.fields || []) if (f.value) fields.push({ id: uid(), label: f.name || 'Field', value: String(f.value), secret: f.type === 1 || looksSecret(f.name || '') });
      return makeItem({
        title: x.name, website: (login.uris && login.uris[0] && login.uris[0].uri) || '',
        username: login.username || '', password: login.password || '', notes: x.notes || '', fields,
      });
    });
  }
  throw new Error('This JSON file isn’t a format Vault knows. Use a CSV export instead.');
}

function parseImport(name, text) {
  const isJSON = /\.json$/i.test(name) || /^\s*[{[]/.test(text);
  return isJSON ? fromJSON(text) : fromCSV(text);
}

// ---- Export ---------------------------------------------------------------
const csvCell = (v) => {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

// Column names chosen so Apple Passwords, Chrome/Edge, Bitwarden, 1Password,
// Proton Pass and Firefox all recognise them. Extra fields are folded into notes
// so nothing is lost in apps that have no custom fields.
function toCSV(items) {
  const head = ['Title', 'URL', 'Username', 'Password', 'Notes', 'OTPAuth'];
  const lines = [head.join(',')];
  for (const it of items) {
    const otp = (it.fields || []).find((f) => /otp|2fa|one-time/i.test(f.label));
    const extra = (it.fields || []).filter((f) => f !== otp).map((f) => `${f.label}: ${f.value}`);
    const notes = [it.notes, ...extra].filter(Boolean).join('\n');
    const url = it.website ? (window.hostOf(it.website) ? window.hostOf(it.website).href : it.website) : '';
    lines.push([it.title, url, it.username, it.password, notes, otp ? otp.value : ''].map(csvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

function toJSON(items) {
  return JSON.stringify({ app: 'vault', version: 1, exportedAt: new Date().toISOString(), items }, null, 2);
}

function dedupe(existing, incoming) {
  const key = (x) => [(window.hostOf(x.website) || { hostname: x.title }).hostname.replace(/^www\./, '').toLowerCase(), x.username.toLowerCase(), x.password].join('\u0000');
  const seen = new Set(existing.map(key));
  const fresh = [];
  let skipped = 0;
  for (const it of incoming) { const k = key(it); if (seen.has(k)) skipped++; else { seen.add(k); fresh.push(it); } }
  return { fresh, skipped };
}

window.transfer = { parseImport, toCSV, toJSON, dedupe, uid };
