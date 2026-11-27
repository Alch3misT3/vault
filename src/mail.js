'use strict';
/* Vault — generated email addresses and their mail. Loaded after app.js and changes.js.
   The window never gets API keys, tokens or mailbox passwords: only addresses, states and messages.
   HTML mail is cleaned here, then shown in a sandboxed frame Vault serves itself (no scripts, no
   remote pictures, no forms); every link shows its real address before it opens in your browser. */

const mailApi = (op, ...args) => api.mail(op, ...args);
const mail = { st: null, messages: [], openId: null, as: 'html', loading: false };
const MAIL_MODES = { temp: 'One-Time Inbox', alias: 'Hidden Address', domain: 'Your Domain' };
const badgeText = (a) => (a.mode === 'temp' ? 'One-time inbox' : a.mode === 'alias' ? 'Hidden · ' + a.serviceName : 'Your domain');
const MAIL_ERRORS = {
  auth: 'The service refused the key or password.', rate: 'The service is busy. Try again in a minute.', timeout: 'The service didn’t answer in time.',
  network: 'Couldn’t reach the service. Check the connection.', 'not-set-up': 'Set this up first in Email Addresses.', 'bad-key': 'That doesn’t look like an API key or token.',
  'routing-off': 'Email Routing is off for this domain. Turn it on in Cloudflare first (step 1).', 'no-subdomain': 'Your Cloudflare account has no workers.dev address yet: open Workers & Pages in the Cloudflare dashboard once, then try again.',
  'login-disabled': 'This mailbox doesn’t allow a password login (Outlook.com needs Microsoft’s own sign-in), so Vault can’t read it.',
  tls: 'Vault couldn’t verify the mail server’s certificate, so it didn’t connect. Check the server name. Some antivirus apps (for example Avast Mail Shield) put their own certificate on mail connections: allow Vault in their mail-scanning settings.',
  connect: 'Couldn’t connect to that mail server.', 'bad-dest': 'That copy address doesn’t look right.', 'no-zone': 'That domain isn’t in this token’s zones.',
};
const mailError = (e) => MAIL_ERRORS[(e && e.code) || e] || 'Something went wrong. Try again.';
const mailAddrOf = (id) => (mail.st ? mail.st.addresses.find((a) => a.id === id) : null);
const mailSetUp = () => !!mail.st && (mail.st.temp.on || Object.values(mail.st.alias.services).some((s) => s.on) || !!mail.st.domain);

async function loadMail() {
  const r = await mailApi('state');
  if (!r || r.error) return;
  mail.st = r;
  const list = await mailApi('list');
  mail.messages = Array.isArray(list) ? list : [];
  if (!$('#app').hidden) { renderList(); if (state.mode === 'view') renderDetail(); }
}
api.onMail(async (st) => {
  if ($('#app').hidden) return;
  const before = new Set(mail.messages.map((m) => m.id));
  mail.st = st;
  const list = await mailApi('list');
  mail.messages = Array.isArray(list) ? list : [];
  const fresh = mail.messages.filter((m) => !before.has(m.id));
  if (fresh.length) {
    const m = fresh[0];
    const it = state.items.find((x) => x.mailAddr && x.mailAddr.id === m.addrId);
    toast(m.code ? `Code ${m.code}${it ? ' for ' + it.title : ''}` : `New mail${it ? ' for ' + it.title : ''}`);
  }
  renderList();
  if (state.mode === 'view') renderDetail();
});
// A link clicked inside an HTML mail: Vault stopped it; show where it goes first (then show the mail again).
api.onMailLink(async (url) => { if (state.tool !== 'message') return; await confirmLink(url); if (state.tool === 'message') renderDetail(); });

// ---------- the "Generate email" menu (edit view) ----------
function mailMenuItems() {
  const s = mail.st;
  if (!mailSetUp()) return [{ label: 'Set Up Email Addresses…', value: 'setup' }];
  return [
    s.temp.on && { label: 'One-Time Inbox (mail.tm)', value: 'temp' },
    ...Object.entries(s.alias.services).filter(([, v]) => v.on).map(([k, v]) => ({ label: 'Hidden Address · ' + v.name, value: 'alias:' + k })),
    s.domain && { label: 'Address on ' + s.domain.zone, value: 'domain' },
    'sep', { label: 'Email Addresses…', value: 'setup' },
  ];
}
async function generateEmail(d, btn) {
  if (!mail.st) await loadMail();
  if (!mailSetUp()) { mailSetupFlow(); return; } // nothing to choose yet: straight to setting it up
  const pick = await window.fx.menu(mailMenuItems(), { anchor: btn, align: 'end', label: 'Generate email' });
  if (!pick) return;
  if (pick === 'setup') { mailSetupFlow(); return; }
  const saved = state.items.find((x) => x.id === d.id);
  if (d.mailAddr && saved && saved.mailAddr && saved.mailAddr.id === d.mailAddr.id
    && !(await confirmAlert('Replace the generated address?', 'When you save, the old address is switched off. Its mail stays in Vault.', 'Replace', false))) return;
  const [mode, service] = pick.split(':');
  const site = (d.title || '').trim() || (window.siteOfItem(d) || {}).host || '';
  btn.disabled = true;
  toast('Making an address…');
  try {
    const r = await mailApi('create', { mode, service, site, host: (window.siteOfItem(d) || {}).host || '', entryId: d.id });
    if (!r || r.error) { toast(mailError(r && r.error)); return; }
    if (d.mailAddr && !(saved && saved.mailAddr && saved.mailAddr.id === d.mailAddr.id)) mailApi('remove', d.mailAddr.id); // an unsaved one made a moment ago
    d.mailAddr = { id: r.address.id, mode: r.address.mode, service: r.address.service };
    d.username = r.address.address;
    mail.st = r.state;
    const el = $('#f-user'); if (el) el.value = d.username;
    renderDetail();
    toast('Address made: ' + d.username);
  } finally { btn.disabled = false; }
}
// Edit cancelled: an address made during this edit isn't needed any more.
function dropUnsavedAddress(d) {
  if (!d || !d.mailAddr) return;
  const saved = state.items.find((x) => x.id === d.id);
  if (!(saved && saved.mailAddr && saved.mailAddr.id === d.mailAddr.id)) mailApi('remove', d.mailAddr.id).then(loadMail);
}
// Saved with a different generated address: switch the old one off (alias, domain) and unlink it.
function afterAddressSaved(old, d) {
  if (old && old.mailAddr && (!d.mailAddr || d.mailAddr.id !== old.mailAddr.id)) {
    mailApi('link', old.mailAddr.id, null);
    if (old.mailAddr.mode !== 'temp') mailApi('set-state', old.mailAddr.id, false).then(loadMail);
  }
}
function mailBadge(a) { return a ? h('span', { class: 'mail-badge ' + a.mode, title: badgeText(a) }, icon('i-mail'), badgeText(a)) : null; }

// ---------- the address on an account (view mode) ----------
function addressSection(it) {
  if (!it.mailAddr) return [];
  const a = mailAddrOf(it.mailAddr.id);
  if (!a) return [];
  const inbox = mail.messages.filter((m) => m.addrId === a.id);
  const stateText = a.state === 'expired' ? 'Gone at mail.tm' : a.state === 'off' ? 'Switched off' : 'Receiving mail';
  const act = async (fn, okMsg) => { const r = await fn(); if (!r || r.error) toast(mailError(r && r.error)); else { if (okMsg) toast(okMsg); await loadMail(); } };
  const rows = [
    h('div', { class: 'field-row' }, h('div', { class: 'f-label' }, 'Address'),
      h('div', { class: 'f-value mail-addr' }, a.address, mailBadge(a)),
      h('div', { class: 'row-actions' }, h('button', { class: 'mini-btn', 'data-copy': '', title: 'Copy', 'aria-label': 'Copy address', onclick: (e) => copy(a.address, false, 'Address', e.currentTarget, e.currentTarget.closest('.field-row')) }, icon('i-copy')))),
    h('div', { class: 'field-row' }, h('div', { class: 'f-label' }, 'Status'), h('div', { class: 'f-value' + (a.state === 'on' ? '' : ' muted') }, stateText),
      h('div', { class: 'addr-actions' },
        a.mode !== 'temp' && a.state !== 'expired' ? h('button', { class: 'btn-plain', id: 'addrToggle', onclick: () => act(() => mailApi('set-state', a.id, a.state !== 'on'), a.state === 'on' ? 'Address switched off' : 'Address switched on') }, a.state === 'on' ? 'Switch Off' : 'Switch On') : null,
        h('button', { class: 'btn-plain danger-text', id: 'addrDelete', onclick: async () => {
          if (!(await confirmAlert('Delete this address?', a.mode === 'temp' ? 'The inbox is deleted at mail.tm and its mail here too. This can’t be undone.' : `The address is deleted at ${a.serviceName} and its mail here too. Mail sent to it won’t arrive any more.`, 'Delete', true))) return;
          const r = await mailApi('remove', a.id);
          if (!r || r.error) { toast(mailError(r && r.error)); return; }
          await updateItem(it, { mailAddr: undefined }, 'Address deleted');
          loadMail();
        } }, a.mode === 'temp' ? 'Delete Inbox' : 'Delete'))),
  ];
  const warn = a.mode === 'temp' ? h('div', { class: 'notice temp-warn' }, icon('i-shield'), h('div', {},
    h('strong', {}, a.state === 'expired' ? 'This inbox is gone' : 'Only for things that don’t matter'),
    h('span', {}, a.state === 'expired' ? 'mail.tm no longer has this inbox, so nothing new arrives. Mail already here stays.'
      : 'A one-time inbox at mail.tm. It keeps messages for 7 days, and anyone who gets its password reads them. Never use it for an account you need to recover.'),
    h('a', { href: '#', class: 'mail-credit', onclick: (e) => { e.preventDefault(); openLink('https://mail.tm'); } }, 'Inboxes by mail.tm'))) : null;
  const list = inbox.length ? h('div', { class: 'group' }, inbox.slice(0, 8).map((m) => mailRow(m, true))) : h('p', { class: 'tool-note' }, a.state === 'on' ? 'No mail yet. Vault checks while it’s unlocked.' : 'No mail.');
  return [h('div', { class: 'section-label' }, 'Email Address'), h('div', { class: 'group' }, rows), warn,
    h('div', { class: 'section-label' }, `Inbox${inbox.length ? ' · ' + inbox.length : ''}`), list];
}

function mailRow(m, compact) {
  const it = state.items.find((x) => x.mailAddr && x.mailAddr.id === m.addrId);
  return h('button', { class: 'mail-row' + (m.seen ? '' : ' unread'), 'data-mail': m.id, onclick: () => openMessage(m.id) },
    h('span', { class: 'mail-dot', 'aria-hidden': 'true' }),
    h('div', { class: 'mail-text' },
      h('div', { class: 'mail-subject' }, m.subject || '(no subject)'),
      h('div', { class: 'mail-from' }, [m.from.name || m.from.address, !compact && it ? it.title : null].filter(Boolean).join(' · '))),
    m.code ? h('span', { class: 'mail-code-chip' }, m.code) : null,
    h('span', { class: 'mail-date' }, fmtMailDate(m.receivedAt)));
}
const fmtMailDate = (t) => (Date.now() - t < DAY && new Date(t).getDate() === new Date().getDate()
  ? new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  : new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }));

// ---------- reading a message (detail pane) ----------
async function openMessage(id) {
  if (state.mode !== 'view' && !(await cancelEdit())) return;
  mail.openId = id;
  state.tool = 'message';
  const m = await mailApi('get', id);
  if (!m) { state.tool = null; render(); return; }
  mail.current = m;
  mail.as = m.html ? 'html' : 'text';
  if (!m.seen) { mailApi('seen', id); const s = mail.messages.find((x) => x.id === id); if (s) s.seen = true; }
  render();
}
function closeMessage() { mail.openId = null; mail.current = null; state.tool = null; render(); }

function messageView() {
  const m = mail.current;
  if (!m) return [h('div', { class: 'detail-bar drag' }), blankView()];
  const it = state.items.find((x) => x.mailAddr && x.mailAddr.id === m.addrId);
  const bar = h('div', { class: 'detail-bar drag' },
    m.html ? h('div', { class: 'segmented mail-seg', role: 'radiogroup', 'aria-label': 'Show as' },
      ['html', 'text'].map((k) => h('label', {}, h('input', { type: 'radio', name: 'mailAs', value: k, checked: mail.as === k, onchange: () => { mail.as = k; renderDetail(); } }), h('span', {}, k === 'html' ? 'Formatted' : 'Plain Text')))) : null,
    h('button', { class: 'glass-btn glass danger-text', id: 'mailDelete', onclick: async () => { await mailApi('delete', m.id); mail.messages = mail.messages.filter((x) => x.id !== m.id); closeMessage(); toast('Message deleted'); } }, 'Delete'),
    h('button', { class: 'glass-btn glass', onclick: closeMessage }, 'Close'));
  const head = h('div', { class: 'mail-head' },
    h('h1', {}, m.subject || '(no subject)'),
    h('div', { class: 'mail-meta' },
      h('div', {}, h('span', { class: 'mail-k' }, 'From'), `${m.from.name ? m.from.name + ' ' : ''}<${m.from.address}>`),
      h('div', {}, h('span', { class: 'mail-k' }, 'To'), (m.to || []).join(', ') || (mailAddrOf(m.addrId) || {}).address || ''),
      h('div', {}, h('span', { class: 'mail-k' }, 'Date'), new Date(m.date).toLocaleString()),
      it ? h('div', {}, h('span', { class: 'mail-k' }, 'Account'), h('a', { href: '#', onclick: (e) => { e.preventDefault(); select(it.id); } }, it.title)) : null));
  const code = m.code ? h('div', { class: 'mail-code', id: 'mailCode' },
    h('div', {}, h('div', { class: 'mail-code-label' }, 'Code in this message'), h('div', { class: 'mail-code-value' }, m.code)),
    h('button', { class: 'btn-primary', id: 'mailCodeCopy', onclick: (e) => copy(m.code, true, 'Code', null, null) }, icon('i-copy'), 'Copy')) : null;
  let body;
  if (mail.as === 'html' && m.html) {
    const clean = sanitizeMail(m.html);
    body = h('div', { class: 'mail-frame-wrap' },
      clean.blocked ? h('div', { class: 'mail-blocked' }, `${clean.blocked} remote ${clean.blocked === 1 ? 'picture was' : 'pictures were'} blocked, so the sender can’t tell you opened this.`) : null,
      h('iframe', { class: 'mail-frame', id: 'mailFrame', sandbox: '', referrerpolicy: 'no-referrer', title: 'Message' }));
    mailApi('frame', clean.html).then((url) => { const f = document.getElementById('mailFrame'); if (f && url) f.src = url; });
  } else {
    const text = m.text || htmlToPlain(m.html || '');
    body = h('div', { class: 'group mail-plain', id: 'mailPlain' }, linkify(text));
  }
  const files = (m.attachments || []).length ? h('p', { class: 'tool-note' }, 'Attachments (not opened by Vault): ' + m.attachments.join(', ')) : null;
  return [bar, h('div', { class: 'detail-scroll' }, h('div', { class: 'detail-inner mail-inner' }, head, code, body, files))];
}

function htmlToPlain(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html'); // inert: nothing in it runs or loads
  doc.querySelectorAll('script,style,head').forEach((e) => e.remove());
  doc.querySelectorAll('br').forEach((e) => e.replaceWith('\n'));
  doc.querySelectorAll('p,div,tr,li,h1,h2,h3,h4').forEach((e) => e.append('\n'));
  return (doc.body ? doc.body.textContent : '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}
// Plain text with web addresses as buttons that show the address before opening it.
function linkify(text) {
  const out = [];
  const re = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
  let last = 0; let mm;
  while ((mm = re.exec(text))) {
    out.push(text.slice(last, mm.index));
    const url = mm[0].replace(/[.,;:!?]+$/, '');
    out.push(h('a', { href: '#', class: 'mail-link', title: url, onclick: (e) => { e.preventDefault(); confirmLink(url); } }, url));
    last = mm.index + url.length;
  }
  out.push(text.slice(last));
  return out;
}
async function confirmLink(url) {
  let u = null;
  try { u = new URL(url); } catch {}
  if (!u || !/^https?:$/.test(u.protocol)) { toast('Vault only opens web links'); return; }
  if (u.protocol !== 'https:') {
    if (await confirmAlert('Not a secure link', `${u.href}\n\nVault only opens https links. You can copy it and decide yourself.`, 'Copy Link', false)) api.copy(u.href, false).then(() => toast('Link copied'));
    return;
  }
  const look = u.username || u.password || /xn--/.test(u.hostname) ? ' Careful: this address hides where it really goes.' : '';
  if (await confirmAlert('Open this link?', `Goes to: ${u.hostname}\n\n${u.href}${look ? '\n\n' + look.trim() : ''}`, 'Open in Browser', false)) openLink(u.href);
}

// ---------- cleaning HTML mail ----------
// Keeps layout and text; drops scripts, forms, frames, styles that load things, event handlers and every
// remote picture. (The frame it's shown in also runs no scripts and may load nothing from outside.)
const MAIL_KEEP = new Set(['a', 'abbr', 'address', 'article', 'b', 'big', 'blockquote', 'br', 'caption', 'center', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'font', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'img', 'ins', 'kbd', 'label', 'li', 'main', 'mark', 'ol', 'p', 'pre', 'q', 's', 'section', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'tt', 'u', 'ul', 'wbr']);
const MAIL_DROP = new Set(['script', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'input', 'button', 'select', 'option', 'textarea', 'link', 'meta', 'base', 'audio', 'video', 'source', 'track', 'picture', 'canvas', 'svg', 'math', 'template', 'title', 'head', 'portal', 'dialog', 'slot']);
const MAIL_ATTRS = new Set(['align', 'alt', 'bgcolor', 'border', 'cellpadding', 'cellspacing', 'class', 'color', 'colspan', 'dir', 'face', 'height', 'href', 'lang', 'rowspan', 'size', 'span', 'src', 'style', 'title', 'valign', 'width']);
const SAFE_IMG = /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;
function cleanCss(css) {
  let blocked = 0;
  const out = String(css)
    .replace(/@import[^;]*;?/gi, () => { blocked++; return ''; })
    .replace(/expression\s*\(|behavior\s*:|-moz-binding|javascript:/gi, '')
    .replace(/url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi, (all, q, u) => (SAFE_IMG.test(u.trim()) ? all : (blocked++, 'none')));
  return { css: out, blocked };
}
function sanitizeMail(html) {
  const doc = new DOMParser().parseFromString(String(html), 'text/html'); // inert: scripts don't run, pictures don't load
  let blocked = 0;
  const styles = [...doc.querySelectorAll('style')].map((s) => { const c = cleanCss(s.textContent); blocked += c.blocked; s.remove(); return c.css; });
  const walk = (el) => {
    for (const child of [...el.children]) {
      const tag = child.tagName.toLowerCase();
      if (MAIL_DROP.has(tag)) { child.remove(); continue; }
      walk(child);
      if (!MAIL_KEEP.has(tag)) { child.replaceWith(...child.childNodes); continue; }
      for (const at of [...child.attributes]) {
        const n = at.name.toLowerCase();
        if (!MAIL_ATTRS.has(n)) { child.removeAttribute(at.name); continue; }
        if (n === 'href') { if (!/^(https?:|mailto:)/i.test(at.value.trim())) child.removeAttribute(at.name); }
        else if (n === 'src') { if (tag !== 'img' || !SAFE_IMG.test(at.value.trim())) { child.removeAttribute(at.name); if (tag === 'img') blocked++; } }
        else if (n === 'style') { const c = cleanCss(at.value); blocked += c.blocked; child.setAttribute('style', c.css); }
      }
      if (tag === 'img' && !child.getAttribute('src')) child.replaceWith(doc.createTextNode(child.getAttribute('alt') ? `[${child.getAttribute('alt')}]` : ''));
    }
  };
  if (doc.body) walk(doc.body);
  const body = doc.body ? doc.body.innerHTML : '';
  const page = '<!doctype html><html><head><meta charset="utf-8">'
    + '<style>html{color-scheme:light}body{margin:0;padding:18px 20px;font:14px/1.5 -apple-system,"Segoe UI",system-ui,sans-serif;color:#1d1d1f;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}a{color:#0060cc}</style>'
    + (styles.length ? `<style>${styles.join('\n').replace(/<\/style/gi, '')}</style>` : '')
    + `</head><body>${body}</body></html>`;
  return { html: page, blocked };
}

// ---------- the Mail view (list of all messages) ----------
function mailListRows() {
  const q = state.query.trim().toLowerCase();
  return mail.messages.filter((m) => !q || [m.subject, m.from.name, m.from.address, m.snippet].join(' ').toLowerCase().includes(q));
}
function mailHasView() { return mailSetUp() || mail.messages.length > 0; }
function renderMailList(list) {
  const rows = mailListRows();
  const q = state.query.trim();
  const unread = mail.messages.filter((m) => !m.seen).length;
  $('#listMeta').textContent = q ? `${rows.length} ${rows.length === 1 ? 'Result' : 'Results'}` : `Mail · ${mail.messages.length} ${mail.messages.length === 1 ? 'message' : 'messages'}${unread ? ` · ${unread} new` : ''}`;
  const pill = list.querySelector(':scope > .list-sel');
  for (const c of [...list.children]) if (c !== pill) c.remove();
  list.append(...rows.map((m) => {
    const it = state.items.find((x) => x.mailAddr && x.mailAddr.id === m.addrId);
    const a = mailAddrOf(m.addrId);
    return h('li', { class: 'row mail-li' + (m.seen ? '' : ' unread'), role: 'option', id: 'row-' + m.id, 'data-id': m.id, 'aria-selected': String(mail.openId === m.id), onclick: () => openMessage(m.id) },
      it ? tile(it) : h('div', { class: 'tile tool-tile small-tool', 'aria-hidden': 'true' }, icon('i-mail')),
      h('div', { class: 'row-text' },
        h('div', { class: 'row-title' }, m.seen ? null : h('span', { class: 'mail-dot', 'aria-hidden': 'true' }), m.subject || '(no subject)'),
        h('div', { class: 'row-sub' }, m.code ? h('span', { class: 'mail-code-chip' }, m.code) : null, [m.from.name || m.from.address, it ? it.title : a ? a.address : null].filter(Boolean).join(' · '))));
  }));
  if (!rows.length) list.append(h('li', { class: 'empty-list' }, h('strong', {}, q ? 'No results' : 'No mail yet'),
    q ? `Nothing matches “${q}”.` : mailSetUp() ? 'Mail to your generated addresses shows up here while Vault is unlocked.' : 'Set up generated email addresses in ••• → Email Addresses.'));
  placePill(list, '.list-sel', mail.openId ? document.getElementById('row-' + mail.openId) : null, 'y');
}
function mailBlankView() {
  return [h('div', { class: 'detail-bar drag' },
    h('button', { class: 'glass-btn glass', id: 'mailCheck', onclick: async () => { toast('Checking for mail…'); const r = await mailApi('check'); toast(r && r.added ? `${r.added} new` : 'No new mail'); } }, 'Check Now'),
    h('button', { class: 'glass-btn glass', onclick: () => mailSetupFlow() }, 'Email Addresses…')),
    h('div', { class: 'blank' }, h('div', {},
      h('div', { class: 'app-icon small glyph', 'aria-hidden': 'true' }, icon('i-mail')),
      h('h2', {}, mailSetUp() ? 'No message selected' : 'Private email addresses'),
      h('p', {}, mailSetUp() ? 'Pick a message from the list.' : 'Give each account its own address: a one-time inbox, a hidden alias, or an address on your own domain. Their mail shows up here.'),
      mailSetUp() ? null : h('div', { class: 'blank-actions' }, h('button', { class: 'btn-primary', onclick: () => mailSetupFlow() }, 'Set Up…'))))];
}

// ---------- setup: Email Addresses ----------
const IMAP_PRESETS = [
  ['gmail', 'Gmail', 'imap.gmail.com'], ['yahoo', 'Yahoo Mail', 'imap.mail.yahoo.com'], ['icloud', 'iCloud Mail', 'imap.mail.me.com'],
  ['fastmail', 'Fastmail', 'imap.fastmail.com'], ['gmx', 'GMX', 'imap.gmx.com'], ['zoho', 'Zoho Mail', 'imap.zoho.com'], ['other', 'Other', ''],
];
const KEY_HELP = {
  simplelogin: ['SimpleLogin', 'In SimpleLogin, open API Keys and create a key.', 'https://app.simplelogin.io/dashboard/api_key'],
  addy: ['addy.io', 'In addy.io, open Settings → API and create a key.', 'https://app.addy.io/settings/api'],
  relay: ['Firefox Relay', 'In Firefox Relay, open Settings and copy your API key.', 'https://relay.firefox.com/accounts/settings/'],
};
const CF_STEPS = ['token', 'routing', 'secret', 'roundtrip', 'dest'];
const CF_STEP_TEXT = {
  token: 'The token can see your domain', routing: 'Email Routing is on', secret: 'The Worker refuses requests without the secret',
  roundtrip: 'A test message went through: encrypted, stored, fetched, opened and deleted', dest: 'The copy address is verified',
};

async function mailSetupFlow(pane) {
  await loadMail();
  const dlg = $('#mailDlg');
  mail.pane = pane || mail.pane || 'temp';
  renderMailSetup();
  if (!dlg.open) dlg.showModal();
}
function renderMailSetup() {
  const s = mail.st;
  const box = $('#mailSetup');
  const seg = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Kind of address' },
    [['temp', 'One-Time Inbox'], ['alias', 'Alias Service'], ['domain', 'Your Domain']].map(([k, l]) => h('label', {},
      h('input', { type: 'radio', name: 'mailPane', value: k, checked: mail.pane === k, onchange: () => { mail.pane = k; renderMailSetup(); } }), h('span', {}, l))));
  const pane = mail.pane === 'temp' ? tempPane(s) : mail.pane === 'alias' ? aliasPane(s) : domainPane(s);
  box.replaceChildren(seg, ...pane);
}
const statusLine = (id) => h('p', { class: 'lock-error setup-status', id, role: 'alert' });
function setStatus(id, msg, ok) { const el = document.getElementById(id); if (el) { el.textContent = msg; el.classList.toggle('ok', !!ok); } }

function tempPane(s) {
  return [
    h('p', {}, 'A throwaway inbox for sign-ups that don’t matter. Vault makes the address and its password at mail.tm and shows the mail here. mail.tm keeps messages for 7 days.'),
    h('div', { class: 'notice temp-warn' }, icon('i-shield'), h('div', {}, h('strong', {}, 'Only for things that don’t matter'),
      h('span', {}, 'Never use one for an account you care about: anyone who gets an inbox’s password reads its mail and can reset the account.'))),
    h('div', { class: 'setup-row' },
      h('span', {}, s.temp.on ? 'On' : 'Off'),
      h('button', { type: 'button', class: s.temp.on ? 'btn-secondary' : 'btn-primary', id: 'tempToggle', onclick: async () => {
        const r = await mailApi('set-temp', !s.temp.on);
        if (r && !r.error) { mail.st = r; renderMailSetup(); toast(r.temp.on ? 'One-time inboxes on' : 'One-time inboxes off'); }
      } }, s.temp.on ? 'Turn Off' : 'Turn On')),
    h('a', { href: '#', class: 'mail-credit', onclick: (e) => { e.preventDefault(); openLink('https://mail.tm'); } }, 'Inboxes by mail.tm'),
  ];
}

function aliasPane(s) {
  const svc = Object.entries(s.alias.services).map(([k, v]) => {
    const [name, help, url] = KEY_HELP[k];
    return h('div', { class: 'svc' },
      h('div', { class: 'svc-head' }, h('strong', {}, name), h('span', { class: v.on ? 'svc-on' : 'svc-off' }, v.on ? 'Connected' + (v.account ? ' · ' + v.account : '') : 'Not connected')),
      v.on ? h('button', { type: 'button', class: 'btn-plain danger-text', onclick: async () => { const r = await mailApi('alias-key', k, null); if (r && !r.error) { mail.st = r; renderMailSetup(); } } }, 'Disconnect')
        : h('div', { class: 'svc-key' },
          h('input', { class: 'alert-input', type: 'password', id: 'key-' + k, placeholder: name + ' API key', 'aria-label': name + ' API key', autocomplete: 'off', spellcheck: 'false' }),
          h('button', { type: 'button', class: 'btn-primary small', id: 'keyGo-' + k, onclick: async (e) => {
            const input = document.getElementById('key-' + k);
            const btn = e.currentTarget; btn.disabled = true;
            const r = await mailApi('alias-key', k, input.value);
            btn.disabled = false;
            input.value = '';
            if (!r || r.error) { setStatus('aliasStatus', mailError(r && r.error)); return; }
            mail.st = r; renderMailSetup(); toast(name + ' connected');
          } }, 'Connect')),
      v.on ? null : h('span', { class: 'svc-help' }, help + ' ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); openLink(url); } }, 'Open')));
  });
  const im = s.alias.imap;
  const mailbox = h('div', { class: 'svc' },
    h('div', { class: 'svc-head' }, h('strong', {}, 'Mailbox your aliases forward to'), h('span', { class: im ? 'svc-on' : 'svc-off' }, im ? im.user : 'Not set')),
    h('p', {}, 'Vault reads only the mail sent to its aliases, read-only, over a secure connection. Best: a separate mailbox just for aliases.'),
    h('p', { class: 'svc-help' }, 'Works: Gmail, Yahoo, iCloud Mail and Fastmail with an app password; GMX and Zoho after you turn on IMAP. Doesn’t work: Outlook.com and Hotmail (need Microsoft’s own sign-in), Proton Mail (only through its paid Bridge app), Tuta (no IMAP).'),
    im ? h('button', { type: 'button', class: 'btn-plain danger-text', onclick: async () => { const r = await mailApi('mailbox', null); if (r && !r.error) { mail.st = r; renderMailSetup(); } } }, 'Remove Mailbox')
      : h('div', { class: 'imap-form' },
        h('select', { class: 'alert-input', id: 'imapPreset', 'aria-label': 'Mail provider', onchange: (e) => { const p = IMAP_PRESETS.find((x) => x[0] === e.target.value); $('#imapHost').value = p ? p[2] : ''; } },
          IMAP_PRESETS.map(([k, n]) => h('option', { value: k }, n))),
        h('input', { class: 'alert-input', id: 'imapHost', placeholder: 'IMAP server, e.g. imap.gmail.com', value: 'imap.gmail.com', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'IMAP server' }),
        h('input', { class: 'alert-input', id: 'imapUser', placeholder: 'Email address', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Mailbox user name' }),
        h('input', { class: 'alert-input', id: 'imapPass', type: 'password', placeholder: 'App password', autocomplete: 'off', 'aria-label': 'App password' }),
        h('button', { type: 'button', class: 'btn-primary small', id: 'imapGo', onclick: async (e) => {
          e.currentTarget.disabled = true;
          setStatus('aliasStatus', 'Connecting…', true);
          const r = await mailApi('mailbox', { host: $('#imapHost').value, port: 993, user: $('#imapUser').value, pass: $('#imapPass').value });
          const b = document.getElementById('imapGo'); if (b) b.disabled = false;
          $('#imapPass').value = '';
          if (!r || r.error) { setStatus('aliasStatus', r && r.error === 'auth' ? 'The mailbox refused the user name or password. Most providers need an app password, not your normal one.' : mailError(r && r.error)); return; }
          mail.st = r; renderMailSetup(); toast('Mailbox connected (read-only)');
        } }, 'Connect and Test')));
  return [h('p', {}, 'A hidden address from your own SimpleLogin, addy.io or Firefox Relay account, with the site’s name as its note. You can switch it off or delete it from Vault.'), ...svc, mailbox, statusLine('aliasStatus')];
}

function domainPane(s) {
  const d = s.domain;
  if (d) {
    return [
      h('p', {}, `Addresses on ${d.zone} go to the Vault Worker in your Cloudflare account, which encrypts each message for Vault and keeps it at most 7 days.`),
      h('div', { class: 'group setup-group' },
        h('div', { class: 'field-row' }, h('div', { class: 'f-label' }, 'Domain'), h('div', { class: 'f-value' }, d.zone), h('span')),
        h('div', { class: 'field-row' }, h('div', { class: 'f-label' }, 'Worker'), h('div', { class: 'f-value small' }, d.url), h('span')),
        h('div', { class: 'field-row' }, h('div', { class: 'f-label' }, 'Copies to'), h('div', { class: 'f-value' + (d.copies ? '' : ' muted') }, d.copies ? d.dest : 'Off'), h('span'))),
      h('label', { class: 'gen-row gen-check' }, h('input', { type: 'checkbox', id: 'cfCopies', checked: d.copies }), h('span', {}, 'Also forward a copy to')),
      h('input', { class: 'alert-input', id: 'cfDest', type: 'email', value: d.dest, placeholder: 'you@example.com', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Copy address' }),
      h('ul', { class: 'cf-test', id: 'cfTest' }),
      statusLine('cfStatus'),
      h('div', { class: 'setup-actions' },
        h('button', { type: 'button', class: 'btn-secondary small', id: 'cfTestGo', onclick: runCfTest }, 'Test'),
        h('button', { type: 'button', class: 'btn-secondary small', id: 'cfUpdate', onclick: () => cfDeploy({}) }, 'Update Worker'),
        h('button', { type: 'button', class: 'btn-plain danger-text', id: 'cfRemove', onclick: async () => {
          if (!(await confirmAlert('Remove the Worker?', 'Vault deletes the Worker, its stored mail and the routing rules of your addresses at Cloudflare. Your addresses stop receiving mail.', 'Remove', true))) { mailSetupFlow('domain'); return; }
          mailSetupFlow('domain');
          setStatus('cfStatus', 'Removing…', true);
          const r = await mailApi('cf-remove');
          if (!r || r.error) { setStatus('cfStatus', mailError(r && r.error)); return; }
          mail.st = r; renderMailSetup(); toast('Worker removed');
        } }, 'Remove…')),
    ];
  }
  const link = (label, url) => h('a', { href: '#', onclick: (e) => { e.preventDefault(); openLink(url); } }, label);
  return [
    h('p', {}, 'Addresses on your own domain, like netflix.k3x9qa@yourdomain.com. Your domain must be on Cloudflare. Vault puts a small Worker in your account that encrypts each message for Vault; only Vault can read it.'),
    h('ol', { class: 'steps' },
      h('li', {}, h('strong', {}, 'Turn on Email Routing'), h('span', {}, 'In Cloudflare: Compute → Email Service → Email Routing, for your domain. ', link('Open Cloudflare', 'https://dash.cloudflare.com/?to=/:account/email-service/routing'))),
      h('li', {}, h('strong', {}, 'Make an API token for Vault'),
        h('span', {}, 'My Profile → API Tokens → Create Token → Custom token. Give it only these permissions, for your account and this one domain: ', link('Open API Tokens', 'https://dash.cloudflare.com/profile/api-tokens')),
        h('ul', { class: 'perm-list' },
          h('li', {}, 'Account · Workers Scripts · Edit'), h('li', {}, 'Account · Workers KV Storage · Edit'), h('li', {}, 'Account · Email Routing Addresses · Read'),
          h('li', {}, 'Zone · Email Routing Rules · Edit'), h('li', {}, 'Zone · Zone · Read'), h('li', {}, 'Zone · Zone Settings · Read'))),
      h('li', {}, h('strong', {}, 'Paste it and pick the domain'),
        h('div', { class: 'svc-key' },
          h('input', { class: 'alert-input', type: 'password', id: 'cfToken', placeholder: 'API token', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Cloudflare API token', 'aria-describedby': 'cfTokenNote' }),
          h('button', { type: 'button', class: 'btn-secondary small', id: 'cfCheck', onclick: async () => {
            setStatus('cfStatus', 'Checking…', true);
            const r = await mailApi('cf-zones', $('#cfToken').value);
            if (!r || r.error) { setStatus('cfStatus', mailError(r && r.error)); return; }
            if (!r.length) { setStatus('cfStatus', 'This token can’t see any domain. Check its zone permissions.'); return; }
            $('#cfToken').value = '';
            const sel = $('#cfZone'); sel.replaceChildren(...r.map((z) => h('option', { value: z.id }, z.name))); sel.hidden = false;
            $('#cfDeploy').disabled = false;
            setStatus('cfStatus', 'Token works. Pick the domain, then deploy.', true);
          } }, 'Check')),
        h('span', { id: 'cfTokenNote' }, 'Kept encrypted in your vault. Vault sends it only to Cloudflare.'),
        h('select', { class: 'alert-input', id: 'cfZone', hidden: true, 'aria-label': 'Domain' })),
      h('li', {}, h('strong', {}, 'Copies (optional)'),
        h('span', {}, 'Vault can also forward each message to your normal inbox. Add that address once in Cloudflare under Email Routing → Destination addresses and open the link Cloudflare emails you.'),
        h('label', { class: 'gen-row gen-check' }, h('input', { type: 'checkbox', id: 'cfCopies' }), h('span', {}, 'Forward a copy to')),
        h('input', { class: 'alert-input', id: 'cfDest', type: 'email', placeholder: 'you@example.com', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Copy address' })),
      h('li', {}, h('strong', {}, 'Deploy'), h('span', {}, 'Vault makes a key pair (the private key stays in your vault), deploys the Worker and tests the whole chain.'),
        h('button', { type: 'button', class: 'btn-primary small', id: 'cfDeploy', disabled: true, onclick: () => cfDeploy({ zoneId: $('#cfZone').value }) }, 'Deploy Worker'))),
    h('ul', { class: 'cf-test', id: 'cfTest' }),
    statusLine('cfStatus'),
  ];
}
async function cfDeploy({ zoneId }) {
  const copies = !!($('#cfCopies') && $('#cfCopies').checked);
  const dest = $('#cfDest') ? $('#cfDest').value.trim() : '';
  setStatus('cfStatus', 'Deploying the Worker…', true);
  document.querySelectorAll('#mailSetup button').forEach((b) => { b.disabled = true; });
  const r = await mailApi('cf-deploy', { zoneId, copies, dest });
  document.querySelectorAll('#mailSetup button').forEach((b) => { b.disabled = false; });
  if (!r || r.error) { setStatus('cfStatus', mailError(r && r.error)); return; }
  mail.st = r;
  renderMailSetup();
  runCfTest();
}
async function runCfTest() {
  setStatus('cfStatus', 'Testing…', true);
  const steps = await mailApi('cf-test');
  const ul = $('#cfTest');
  if (!steps || steps.error) { setStatus('cfStatus', mailError(steps && steps.error)); return; }
  ul.replaceChildren(...steps.map((x) => h('li', { class: x.ok ? 'ok' : 'bad' }, icon(x.ok ? 'i-check' : 'i-clear'), CF_STEP_TEXT[x.name] || x.name, x.ok ? null : h('span', {}, ' · ' + mailError(x.detail)))));
  const ok = steps.every((x) => x.ok);
  setStatus('cfStatus', ok ? 'Everything works.' : 'Something isn’t right yet (see above).', ok);
}
