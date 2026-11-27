'use strict';
/* Vault — password changes, the change queue, the breach check and Change Email Everywhere.
   Loaded after app.js and uses its helpers (state, h, icon, persist, updateItem, toast, …).
   Vault never changes anything on a site by itself: it opens the site's own page, the extension can
   fill the fields when you click, and you press the site's save button. */

// ---------- change one password ----------
// The new password is saved on the account as "pending" (encrypted, on disk) before anything opens,
// so a crash or a closed window loses nothing. The current password stays in use until you confirm.
async function changePassword(it) {
  if (!it || it.deletedAt || it.passkey) return;
  if (state.mode !== 'view' && !(await cancelEdit())) return;
  let cur = state.items.find((x) => x.id === it.id);
  if (!cur) return;
  if (!cur.pending) {
    const pending = { value: generatePassword(genSettings()), createdAt: Date.now() };
    if (!(await updateItem(cur, { pending }))) return;
    cur = state.items.find((x) => x.id === it.id);
  }
  const r = await api.changePage(cur.id);
  if (!r) { toast('Couldn’t open the site'); return; }
  state.changeAwait = { id: cur.id, at: Date.now() };
  toast(r.how === 'home' ? 'Opened the site · find its password settings' : 'Opened the change-password page');
}

// The window is back after the change page was opened: ask how it went.
window.addEventListener('focus', () => {
  const a = state.changeAwait;
  if (!a || Date.now() - a.at < 1500 || $('#app').hidden || state.mode !== 'view' || document.querySelector('dialog[open]')) return;
  const it = state.items.find((x) => x.id === a.id && x.pending);
  if (!it) { state.changeAwait = null; return; }
  askChangeResult(it);
});

function askChangeResult(it) {
  const dlg = $('#changeDlg');
  const site = (window.siteOfItem(it) || {}).host || it.title;
  $('#changeTitle').textContent = `Did the change on ${site} work?`;
  $('#changeBody').textContent = 'If the site saved the new password, Vault uses it from now on and keeps the old one in the history. If not, Vault keeps the old one.';
  dlg.returnValue = '';
  dlg.showModal();
  $('#changeYes').focus();
  dlg.addEventListener('close', () => {
    const v = dlg.returnValue;
    if (v === 'yes' || v === 'no') answerChange(state.items.find((x) => x.id === it.id), v === 'yes');
    else if (state.changeAwait) state.changeAwait.at = Date.now(); // not yet: ask again next time
  }, { once: true });
}

async function answerChange(it, worked) {
  if (!it || !it.pending) return;
  const now = Date.now();
  const patch = worked
    ? { password: it.pending.value, pending: undefined, pwChangedAt: now, updatedAt: now, history: it.password ? addHistory(it.history, { value: it.password, changedAt: now }) : it.history }
    : { pending: undefined, updatedAt: now };
  state.reveal.clear();
  const ok = await updateItem(it, patch, worked ? 'New password saved · the old one is in the history' : 'Kept the old password');
  if (state.changeAwait && state.changeAwait.id === it.id) state.changeAwait = null;
  if (!ok) return;
  if (worked) refreshBreaches();
  queueAnswered(it.id, worked);
}

// ---------- the change queue (Security view) ----------
// Breached first, then reused, weak, and older than a year. The queue's progress is kept in the vault.
const queue = () => state.ui.changeQueue;
const queueCurrent = () => { const q = queue(); return q && q.pos < q.ids.length ? q.ids[q.pos] : null; };
async function saveQueue(q) {
  state.ui.changeQueue = q;
  const r = await api.saveUi('changeQueue', q);
  if (!r || !r.ok) toast('Couldn’t save the queue');
}

function startQueue() {
  const hm = health();
  const sev = (i) => Math.min(...hm.get(i.id).map((x) => SEVERITY[x.kind]));
  const ids = live().filter((i) => hm.has(i.id) && window.siteOfItem(i)).sort((a, b) => sev(a) - sev(b) || byTitle(a, b)).map((i) => i.id);
  if (!ids.length) { toast('Nothing to change'); return; }
  const q = { ids, pos: 0, done: [], skipped: [], startedAt: Date.now() };
  saveQueue(q).then(() => { skipResolved(); showQueueItem(); });
}
function continueQueue() { skipResolved(); showQueueItem(); }

// Accounts that no longer need a change (fixed meanwhile, deleted) are passed over.
function skipResolved() {
  const q = queue();
  if (!q) return;
  const hm = health();
  let moved = false;
  while (q.pos < q.ids.length) {
    const it = state.items.find((x) => x.id === q.ids[q.pos] && !x.deletedAt);
    if (it && (hm.has(it.id) || it.pending)) break;
    q.pos++; moved = true;
  }
  if (moved) saveQueue({ ...q });
}
function showQueueItem() {
  const id = queueCurrent();
  state.tool = id ? null : 'queue-done';
  if (id) { state.selectedId = id; state.reveal.clear(); }
  render();
}
async function queueStep(action) {
  const q = queue();
  if (!q) return;
  const id = queueCurrent();
  if (action === 'stop') { toast('Queue saved · continue any time from Security'); render(); return; }
  if (action === 'close') { await saveQueue(null); render(); return; }
  if (action === 'skip' && id) {
    const next = { ...q, pos: q.pos + 1, skipped: [...q.skipped, id] };
    await saveQueue(next);
    skipResolved(); showQueueItem();
  }
}
function queueAnswered(id, worked) {
  const q = queue();
  if (!q || queueCurrent() !== id || !worked) return;
  saveQueue({ ...q, pos: q.pos + 1, done: [...q.done, id] }).then(() => { skipResolved(); showQueueItem(); });
}

// The strip on top of the account the queue is on, or the summary once it's through.
function queueBar(it) {
  const q = queue();
  if (!q || !it || queueCurrent() !== it.id) return null;
  const n = q.ids.length;
  return h('div', { class: 'queue-bar', id: 'queueBar', role: 'group', 'aria-label': 'Change queue' },
    h('div', { class: 'queue-text' },
      h('strong', {}, `Changing passwords · ${q.pos + 1} of ${n}`),
      h('span', {}, `${q.done.length} changed${q.skipped.length ? ` · ${q.skipped.length} skipped` : ''}`)),
    h('div', { class: 'queue-track', 'aria-hidden': 'true' }, h('i', { style: `width:${Math.round((q.pos / n) * 100)}%` })),
    h('div', { class: 'queue-actions' },
      h('button', { class: 'btn-plain', id: 'queueSkip', onclick: () => queueStep('skip') }, 'Skip'),
      h('button', { class: 'btn-plain', id: 'queueStop', onclick: () => queueStep('stop') }, 'Stop')));
}
function queueDoneView() {
  const q = queue();
  return [h('div', { class: 'detail-bar drag' }), h('div', { class: 'blank', id: 'queueDone' }, h('div', {},
    h('div', { class: 'app-icon small glyph', 'aria-hidden': 'true' }, icon('i-check')),
    h('h2', {}, 'Queue finished'),
    h('p', {}, `${q.done.length} ${q.done.length === 1 ? 'password' : 'passwords'} changed${q.skipped.length ? `, ${q.skipped.length} skipped` : ''}.`),
    h('div', { class: 'blank-actions' }, h('button', { class: 'btn-primary', onclick: () => queueStep('close') }, 'Done'))))];
}

// The line above the Security list: start the queue, or pick it up where you left off.
function renderListTool() {
  const box = $('#listTool');
  if (!box) return;
  const q = queue();
  const show = state.view === 'security' && !state.query.trim();
  const count = live().filter((i) => health().has(i.id) && window.siteOfItem(i)).length;
  if (!show || (!q && !count)) { box.hidden = true; box.replaceChildren(); return; }
  box.hidden = false;
  if (q && q.pos < q.ids.length) {
    box.replaceChildren(h('div', { class: 'list-tool-text' }, h('strong', {}, 'Change queue'), h('span', {}, `${q.pos} of ${q.ids.length} done`)),
      h('button', { class: 'btn-primary small', id: 'queueGo', onclick: continueQueue }, 'Continue'));
  } else {
    box.replaceChildren(h('div', { class: 'list-tool-text' }, h('strong', {}, 'Fix them one by one'), h('span', {}, 'Vault opens each site’s change page')),
      h('button', { class: 'btn-primary small', id: 'queueGo', onclick: startQueue }, 'Start'));
  }
}

// ---------- breach check (Have I Been Pwned, off unless you turn it on) ----------
const BREACH_TEXT = 'Vault sends only the first 5 characters of each password’s SHA-1 hash to Have I Been Pwned (haveibeenpwned.com). Your passwords never leave this PC.';
async function refreshBreaches(announce) {
  if (!state.breachOn) { if (state.breach.size) { state.breach = new Map(); render(); } return; }
  const r = await api.breachCheck();
  if (!r || $('#app').hidden) return;
  state.breach = new Map(Object.entries(r.counts || {}));
  if (state.mode === 'view') render(); else renderList();
  if (announce) {
    const n = state.breach.size;
    toast(r.failed ? 'Couldn’t reach Have I Been Pwned for some passwords' : n ? `${n} ${n === 1 ? 'password was' : 'passwords were'} found in breaches` : 'No breached passwords found');
  }
}
async function setBreachCheck(on) {
  if (on && !(await confirmAlert('Check for breached passwords?', BREACH_TEXT, 'Turn On', false))) return;
  const p = await api.setPref('breachCheck', on);
  state.breachOn = !!(p && p.breachCheck);
  if (!state.breachOn) { state.breach = new Map(); render(); toast('Breach check off · nothing is sent'); return; }
  toast('Checking…');
  refreshBreaches(true);
}
// After unlocking: the saved progress, and the breach check if it's on.
async function loadVaultExtras() {
  const ui = await api.ui();
  if (ui) state.ui = { changeQueue: ui.changeQueue || null, emailChange: ui.emailChange || null };
  const p = await api.appPrefs();
  state.breachOn = !!(p && p.breachCheck);
  if ($('#app').hidden) return;
  renderList();
  refreshBreaches();
}

// ---------- Change Email Everywhere ----------
// Every account that uses an old email, each with a direct link to the site's email settings and a
// "done" tick that puts the new email on the account (the old one goes into its history).
const emDraft = { from: '', to: '' }; // what's typed before the checklist exists
const emailNorm = (s) => String(s || '').trim().toLowerCase();
const looksLikeEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
function openEmailTool() {
  if (state.mode !== 'view') { toast('Finish editing first'); return; }
  state.tool = 'email';
  render();
  setTimeout(() => { const el = $(state.ui.emailChange ? '#emNew' : '#emOld'); if (el) el.focus(); }, 30);
}
async function saveEmailChange(v) {
  state.ui.emailChange = v;
  const r = await api.saveUi('emailChange', v);
  if (!r || !r.ok) toast('Couldn’t save the checklist');
}
function emailFind() {
  const from = $('#emOld').value.trim();
  const to = $('#emNew').value.trim();
  if (!looksLikeEmail(from)) { $('#emOld').focus(); toast('Type the old email first'); return; }
  const ids = live().filter((i) => emailNorm(i.username) === emailNorm(from)).sort(byTitle).map((i) => i.id);
  emDraft.from = ''; emDraft.to = '';
  saveEmailChange({ from, to, ids, done: [], at: Date.now() }).then(renderDetail);
}
async function emailTick(id, on) {
  const ec = state.ui.emailChange;
  const it = state.items.find((x) => x.id === id);
  if (!ec || !it) return;
  const to = $('#emNew').value.trim();
  if (on) {
    if (!looksLikeEmail(to)) { toast('Type or pick the new email first'); renderDetail(); $('#emNew').focus(); return; }
    if (emailNorm(to) === emailNorm(ec.from)) { toast('The new email is the same as the old one'); renderDetail(); return; }
    const now = Date.now();
    const ok = await updateItem(it, { username: to, history: addHistory(it.history, { kind: 'username', value: it.username, changedAt: now }), updatedAt: now });
    if (!ok) return renderDetail();
    await saveEmailChange({ ...ec, to, done: [...new Set([...ec.done, id])] });
    toast(`${it.title} now uses ${to}`);
  } else {
    // Undo: put the old email back (and take it out of the history again).
    const hist = it.history || [];
    const k = hist.findIndex((x) => isNameHist(x) && emailNorm(x.value) === emailNorm(ec.from));
    const ok = await updateItem(it, { username: k >= 0 ? hist[k].value : ec.from, history: k >= 0 ? hist.filter((_, i) => i !== k) : hist, updatedAt: Date.now() });
    if (!ok) return renderDetail();
    await saveEmailChange({ ...ec, done: ec.done.filter((x) => x !== id) });
  }
  state.tool = 'email';
  renderDetail();
}

function emailToolView() {
  const ec = state.ui.emailChange;
  const known = [...new Set(live().map((i) => (i.username || '').trim()).filter(looksLikeEmail))].sort();
  const bar = h('div', { class: 'detail-bar drag' },
    ec ? h('button', { class: 'glass-btn glass', id: 'emReset', onclick: async () => {
      if (ec.done.length < ec.ids.length && !(await confirmAlert('Start over?', 'The checklist is cleared. Accounts you already ticked keep their new email.', 'Start Over', false))) return;
      await saveEmailChange(null); renderDetail();
    } }, 'Start Over') : null,
    h('button', { class: 'glass-btn glass', id: 'emClose', onclick: () => { state.tool = null; render(); } }, 'Close'));
  const hero = h('div', { class: 'hero' },
    h('div', { class: 'tile big tool-tile', 'aria-hidden': 'true' }, icon('i-mail')),
    h('div', { class: 'hero-text' }, h('h1', {}, 'Change Email Everywhere'),
      h('div', { class: 'hero-sub' }, 'Every account on an old email, with a link to each site’s settings')));
  const input = (id, label, value, ph, key) => h('div', { class: 'field-row' }, h('label', { class: 'f-label', for: id }, label),
    h('input', { id, class: 'in', type: 'email', value: value || '', placeholder: ph, spellcheck: 'false', autocomplete: 'off', list: 'emKnown',
      oninput: (e) => { if (ec) { if (key === 'to') ec.to = e.target.value.trim(); } else emDraft[key] = e.target.value; },
      onchange: (e) => { if (ec && key === 'to') saveEmailChange({ ...ec, to: e.target.value.trim() }); },
      onkeydown: (e) => { if (e.key === 'Enter' && !ec) { e.preventDefault(); emailFind(); } } }), h('span'));
  const form = h('div', { class: 'group' },
    input('emOld', 'Old email', ec ? ec.from : emDraft.from, 'old@example.com', 'from'),
    input('emNew', 'New email', ec ? ec.to : emDraft.to, 'Type it, or pick one you use', 'to'));
  const datalist = h('datalist', { id: 'emKnown' }, known.map((e) => h('option', { value: e })));
  if (ec) form.querySelector('#emOld').readOnly = true;
  const find = !ec ? h('div', { class: 'tool-actions' }, h('button', { class: 'btn-primary', id: 'emFind', onclick: emailFind }, 'Find Accounts')) : null;
  let list = [];
  if (ec) {
    const rows = ec.ids.map((id) => state.items.find((x) => x.id === id)).filter(Boolean);
    const done = ec.done.filter((id) => rows.some((r) => r.id === id)).length;
    list = [
      h('div', { class: 'section-label', id: 'emProgress' }, rows.length ? `${done} of ${rows.length} done` : 'No accounts use that email'),
      rows.length ? h('div', { class: 'group' }, rows.map((it) => {
        const page = window.accountEmailPage(it);
        const isDone = ec.done.includes(it.id);
        return h('div', { class: 'field-row em-row' + (isDone ? ' done' : ''), 'data-id': it.id },
          h('label', { class: 'em-check' },
            h('input', { type: 'checkbox', checked: isDone, 'aria-label': `${it.title}: email changed`, onchange: (e) => emailTick(it.id, e.target.checked) }),
            h('span', { class: 'em-box', 'aria-hidden': 'true' }, icon('i-check'))),
          h('div', { class: 'em-text' }, tile(it), h('div', { class: 'row-text' },
            h('div', { class: 'row-title' }, it.title), h('div', { class: 'row-sub' }, isDone ? `Now ${it.username}` : it.username))),
          page ? h('button', { class: 'btn-plain', title: page.url, onclick: () => openLink(page.url) }, page.known ? 'Email Settings' : 'Open Site', icon('i-open')) : h('span'));
      })) : null,
      rows.length ? h('p', { class: 'tool-note' }, 'Change the email on each site first, then tick it here: Vault puts the new email on the account and keeps the old one in its history.') : null,
    ];
  }
  return [bar, h('div', { class: 'detail-scroll' }, h('div', { class: 'detail-inner' }, hero, form, datalist, find, ...list))];
}
