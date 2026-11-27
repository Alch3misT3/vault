'use strict';
// Loaded before app.js (which may ask for the tour right away); it uses app.js helpers only when called.
// First run (no vault file yet): a short tour of what Vault does, then the Create Vault card.
// People updating Vault already have a vault file, so they never see it.

const WELCOME = [
  {
    hero: true,
    title: 'Welcome to Vault',
    text: 'Your passwords, codes and passkeys in one place. Everything stays on this PC, locked with one master password that only you know.',
  },
  {
    title: 'Everything you sign in with',
    rows: [
      ['i-lock', '#2f6fec', 'Passwords, kept on this PC', 'Encrypted with your master password. Bring them over from Chrome, Apple Passwords, Bitwarden, 1Password and others.'],
      ['i-timer', '#1d8f47', 'Verification codes', 'Keep each site’s 2FA codes next to its password, so you don’t need a separate app.'],
      ['i-key', '#5a4fd6', 'Passkeys', 'Save passkeys for websites, and unlock Vault with your phone, Windows Hello or a security key.'],
      ['i-search', '#5b6270', 'Quick Search', 'Press Ctrl+Shift+Space anywhere to find an account and copy its password.'],
    ],
  },
  {
    title: 'Safer, with less effort',
    rows: [
      ['i-shield', '#d23a2f', 'Security check', 'Finds weak, reused and old passwords, and walks you through changing them one site at a time.'],
      ['i-globe', '#d9730d', 'Fill in your browser', 'Connect Chrome, Edge, Brave or Firefox to fill in sign-in forms and use your passkeys.'],
      ['i-mail', '#0b8aa0', 'Private email addresses', 'Give each site its own address. Sign-in codes and links sent to it show up in Vault.'],
      ['i-trash', '#7a7f8a', 'Nothing lost by accident', 'Deleted accounts wait 30 days, and every account keeps its old passwords in its history.'],
    ],
  },
];

let welcomePage = 0;
let welcomeDone = false;
let welcomeAfter = null;

function buildWelcome() {
  const pages = WELCOME.map((p, i) => h('section', {
    class: 'welcome-page' + (p.hero ? ' hero-page' : ''), id: 'welcome-' + i, role: 'tabpanel', 'aria-label': p.title,
  },
  p.hero ? h('div', { class: 'app-icon', 'aria-hidden': 'true' }, icon('i-vault')) : null,
  h(p.hero ? 'h1' : 'h2', {}, p.title),
  p.text ? h('p', { class: 'welcome-lead' }, p.text) : null,
  p.rows ? h('ul', { class: 'feature-list' }, p.rows.map(([ic, color, name, text]) => h('li', { class: 'feature' },
    h('span', { class: 'feature-glyph', style: `--glyph:${color}` }, icon(ic)),
    h('div', {}, h('strong', {}, name), h('p', {}, text))))) : null));
  $('#welcomePages').replaceChildren(...pages);
  $('#welcomeDots').replaceChildren(...WELCOME.map((p, i) => h('button', {
    class: 'welcome-dot', type: 'button', role: 'tab', 'aria-label': `Page ${i + 1}: ${p.title}`, onclick: () => welcomeGo(i),
  })));
}

function welcomeGo(i) {
  const n = WELCOME.length;
  i = Math.max(0, Math.min(n - 1, i));
  const back = i < welcomePage;
  welcomePage = i;
  document.querySelectorAll('.welcome-page').forEach((el, k) => {
    el.classList.toggle('current', k === i);
    el.classList.toggle('before', k < i);
    el.toggleAttribute('inert', k !== i);
  });
  document.querySelectorAll('.welcome-dot').forEach((el, k) => el.setAttribute('aria-selected', String(k === i)));
  $('#welcome').classList.toggle('going-back', back);
  $('#welcomeBack').style.visibility = i ? '' : 'hidden';
  $('#welcomeNext').textContent = i === n - 1 ? 'Create Your Vault' : 'Continue';
}

// Shows the tour; `after` runs once it is finished (the Create Vault card takes over).
function showWelcome(after) {
  if (welcomeDone) return false;
  wireWelcome();
  welcomeAfter = after;
  buildWelcome();
  welcomeGo(0);
  $('#lockForm').hidden = true;
  $('#welcome').hidden = false;
  setTimeout(() => $('#welcomeNext').focus(), 30);
  return true;
}

function finishWelcome() {
  welcomeDone = true;
  const w = $('#welcome');
  const done = () => {
    w.hidden = true;
    w.classList.remove('leaving');
    $('#lockForm').hidden = false;
    if (welcomeAfter) welcomeAfter();
  };
  if (window.fx.reduced()) return done();
  w.classList.add('leaving');
  setTimeout(done, 260);
}

let welcomeWired = false;
function wireWelcome() {
  if (welcomeWired) return;
  welcomeWired = true;
  $('#welcomeNext').addEventListener('click', () => (welcomePage === WELCOME.length - 1 ? finishWelcome() : welcomeGo(welcomePage + 1)));
  $('#welcomeBack').addEventListener('click', () => welcomeGo(welcomePage - 1));
  $('#welcome').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' && welcomePage < WELCOME.length - 1) { e.preventDefault(); welcomeGo(welcomePage + 1); }
    if (e.key === 'ArrowLeft' && welcomePage > 0) { e.preventDefault(); welcomeGo(welcomePage - 1); }
  });
}
