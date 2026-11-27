'use strict';
// Smoke test, generated email addresses and their mail. Every outside service is a local test server:
// mail.tm, SimpleLogin, addy.io, Firefox Relay, the Cloudflare API, the Worker (the real mail/worker.js,
// run here with an in-memory KV), and an IMAP server over TLS with a throw-away certificate.
// Real services only with VAULT_REAL_MAIL=1 (scripts/real-mail.js).

const http = require('http');
const tls = require('tls');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

module.exports = async function mailTest({ app, win, js, wait, waitFor, shot, check, test, relock, MASTER, opened, clipboard }) {
  const MAIL = test.getMail();
  const T = MAIL._test;
  const secrets = [];
  const servers = [];
  const log = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-mailtest-'));
  const readBody = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
  const serve = (name, fn) => new Promise((resolve) => {
    const s = http.createServer(async (req, res) => {
      const body = await readBody(req);
      const entry = { site: name, method: req.method, path: req.url, headers: req.headers, body: body.toString('utf8') };
      log.push(entry);
      let json = null; try { json = body.length && /json/.test(req.headers['content-type'] || '') ? JSON.parse(body.toString('utf8')) : null; } catch {}
      const out = await fn(req, json, body, entry);
      const [status, payload, headers] = Array.isArray(out) ? out : [200, out];
      res.writeHead(status, { 'Content-Type': typeof payload === 'string' || Buffer.isBuffer(payload) ? 'application/octet-stream' : 'application/json', ...(headers || {}) });
      res.end(payload == null ? '' : typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload));
    });
    s.listen(0, '127.0.0.1', () => { servers.push(s); resolve('http://127.0.0.1:' + s.address().port); });
  });
  const PWN = await serve('pwned', () => [404, '']);
  const byName = (n) => `window.__vaultState.items.find(i => i.title === ${JSON.stringify(n)})`;
  const item = async (n) => JSON.parse(await js(`JSON.stringify(${byName(n)} || null)`));
  const unlockUI = async () => {
    await js(`(() => { const el = document.getElementById('pw1'); el.value = ${JSON.stringify(MASTER)}; el.dispatchEvent(new Event('input')); document.getElementById('unlockGo').click(); })()`);
    return waitFor("!document.getElementById('app').hidden && window.__vaultState.items.length > 0");
  };
  const pickMenu = async (label) => {
    await waitFor("!!document.querySelector('.menu:not(.closing) .menu-item')", 3000);
    return js(`(() => { const i = [...document.querySelectorAll('.menu:not(.closing) .menu-item')].find(x => x.textContent.includes(${JSON.stringify(label)})); if (!i) return [...document.querySelectorAll('.menu .menu-item')].map(x => x.textContent).join('|'); i.click(); return true; })()`);
  };
  // A new account with a generated address, made through the edit view.
  const newAccountWithAddress = async (title, website, label) => {
    await js("handleCommand('new')");
    await waitFor("!!document.getElementById('f-title')");
    await js(`(() => { const s = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input')); }; s('f-title', ${JSON.stringify(title)}); s('f-web', ${JSON.stringify(website)}); document.getElementById('genEmail').click(); })()`);
    const picked = await pickMenu(label);
    const made = await waitFor("!!state.draft && !!state.draft.mailAddr", 8000);
    return { picked, made };
  };
  const save = async () => { await js('saveEdit()'); await waitFor("state.mode === 'view'", 4000); };
  const mailState = () => js("mailApi('state')");
  const renderer = () => js("JSON.stringify(window.__vaultState) + JSON.stringify(mail) + document.documentElement.outerHTML");

  try {
    // ---------- fake mail.tm ----------
    const tm = { accounts: new Map(), tokens: new Map(), deleted: new Set() };
    const tmAcct = (req) => { const t = (req.headers.authorization || '').replace(/^Bearer /, ''); const a = tm.tokens.get(t); return a && !tm.deleted.has(a.address) ? a : null; };
    const TM = await serve('mailtm', (req, j) => {
      const u = new URL(req.url, 'http://x');
      // like the real mail.tm: with Accept: application/json a list is a plain array (messages below stay JSON-LD)
      if (req.method === 'GET' && u.pathname === '/domains') return [200, [{ id: 'd1', domain: 'tempmail.test', isActive: true, isPrivate: false }]];
      // the first new inbox is "too many requests" once, as mail.tm does after a quick burst
      if (req.method === 'POST' && u.pathname === '/accounts' && !tm.limited) { tm.limited = true; return [429, { code: 429 }]; }
      if (req.method === 'POST' && u.pathname === '/accounts') { const id = 'acc' + (tm.accounts.size + 1); tm.accounts.set(j.address, { id, address: j.address, password: j.password, messages: [] }); return [201, { id, address: j.address }]; }
      if (req.method === 'POST' && u.pathname === '/token') { const a = tm.accounts.get(j.address); if (!a || a.password !== j.password || tm.deleted.has(a.address)) return [401, { code: 401 }]; const token = crypto.randomBytes(16).toString('hex'); tm.tokens.set(token, a); return { id: a.id, token }; }
      const a = tmAcct(req);
      if (!a) return [401, { code: 401 }];
      if (req.method === 'GET' && u.pathname === '/me') return { id: a.id, address: a.address };
      if (req.method === 'GET' && u.pathname === '/messages') return { 'hydra:member': a.messages.map((m) => ({ id: m.id, createdAt: new Date().toISOString() })) };
      const src = /^\/sources\/(.+)$/.exec(u.pathname);
      if (req.method === 'GET' && src) { const m = a.messages.find((x) => x.id === src[1]); return m ? { id: m.id, data: m.raw } : [404, {}]; }
      const del = /^\/accounts\/(.+)$/.exec(u.pathname);
      if (req.method === 'DELETE' && del && del[1] === a.id) { tm.deleted.add(a.address); return [204, null]; }
      return [404, {}];
    });
    // ---------- fake alias services ----------
    const KEYS = { simplelogin: 'sl-key-' + crypto.randomBytes(12).toString('hex'), addy: 'addy-key-' + crypto.randomBytes(12).toString('hex'), relay: 'relay-key-' + crypto.randomBytes(12).toString('hex') };
    secrets.push(...Object.values(KEYS));
    const sl = { aliases: new Map() };
    const SL = await serve('simplelogin', (req, j) => {
      if (req.headers.authentication !== KEYS.simplelogin) return [401, { error: 'Wrong api key' }];
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/api/user_info') return { email: 'me@sl.test', name: 'Me' };
      if (req.method === 'POST' && u.pathname === '/api/alias/random/new') { const id = 100 + sl.aliases.size + 1; const a = { id, email: `shop.${crypto.randomBytes(3).toString('hex')}@aleeas.test`, enabled: true, note: j && j.note, hostname: u.searchParams.get('hostname') }; sl.aliases.set(String(id), a); return [201, a]; }
      const m = /^\/api\/aliases\/(\d+)(\/toggle)?$/.exec(u.pathname);
      const a = m && sl.aliases.get(m[1]);
      if (!a) return [404, {}];
      if (req.method === 'GET') return a;
      if (req.method === 'POST' && m[2]) { a.enabled = !a.enabled; return { enabled: a.enabled }; }
      if (req.method === 'DELETE') { sl.aliases.delete(m[1]); return { deleted: true }; }
      return [404, {}];
    });
    const ad = { aliases: new Map() };
    const AD = await serve('addy', (req, j) => {
      if (req.headers.authorization !== 'Bearer ' + KEYS.addy) return [401, { message: 'Unauthenticated.' }];
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/api/v1/account-details') return { data: { username: 'me' } };
      if (u.pathname === '/api/v1/domain-options') return { data: ['anonaddy.me'], defaultAliasDomain: 'anonaddy.me' };
      if (req.method === 'POST' && u.pathname === '/api/v1/aliases') { const id = crypto.randomUUID(); const a = { id, email: crypto.randomBytes(4).toString('hex') + '@anonaddy.me', active: true, description: j.description, domain: j.domain, format: j.format }; ad.aliases.set(id, a); return [201, { data: a }]; }
      if (req.method === 'POST' && u.pathname === '/api/v1/active-aliases') { const a = ad.aliases.get(j.id); if (!a) return [404, {}]; a.active = true; return { data: a }; }
      const off = /^\/api\/v1\/active-aliases\/(.+)$/.exec(u.pathname);
      if (req.method === 'DELETE' && off) { const a = ad.aliases.get(off[1]); if (!a) return [404, {}]; a.active = false; return [204, null]; }
      const del = /^\/api\/v1\/aliases\/(.+)$/.exec(u.pathname);
      if (req.method === 'DELETE' && del) { ad.aliases.delete(del[1]); return [204, null]; }
      return [404, {}];
    });
    const rl = { masks: new Map() };
    const RL = await serve('relay', (req, j) => {
      if (req.headers.authorization !== 'Token ' + KEYS.relay) return [401, { detail: 'Invalid token.' }];
      const u = new URL(req.url, 'http://x');
      if (req.method === 'GET' && u.pathname === '/api/v1/relayaddresses/') return [200, [...rl.masks.values()]];
      if (req.method === 'POST' && u.pathname === '/api/v1/relayaddresses/') { const id = rl.masks.size + 7; const a = { id, full_address: crypto.randomBytes(4).toString('hex') + '@mozmail.com', enabled: true, description: j.description, generated_for: j.generated_for }; rl.masks.set(String(id), a); return [201, a]; }
      const m = /^\/api\/v1\/relayaddresses\/(\d+)\/$/.exec(u.pathname);
      const a = m && rl.masks.get(m[1]);
      if (!a) return [404, {}];
      if (req.method === 'PATCH') { a.enabled = !!j.enabled; return a; }
      if (req.method === 'DELETE') { rl.masks.delete(m[1]); return [204, null]; }
      return [404, {}];
    });
    T.base.mailtm = TM; T.base.simplelogin = SL; T.base.addy = AD; T.base.relay = RL;

    // ---------- fake Cloudflare API + the real Worker code behind a local endpoint ----------
    const CF_TOKEN = 'cf' + crypto.randomBytes(24).toString('hex');
    secrets.push(CF_TOKEN);
    const cf = { rules: new Map(), kv: [], script: null, schedules: null, subdomainOn: null, deletedScript: false };
    const ok = (result) => ({ success: true, errors: [], messages: [], result });
    const CFAPI = await serve('cloudflare', async (req, j, body) => {
      if (req.headers.authorization !== 'Bearer ' + CF_TOKEN) return [401, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] }];
      const u = new URL(req.url, 'http://x');
      const p = u.pathname;
      if (p === '/zones') return ok([{ id: 'zone1', name: 'example.com', account: { id: 'acc1', name: 'Me' } }]);
      if (p === '/zones/zone1/email/routing') return ok({ enabled: true, status: 'ready', name: 'example.com' });
      if (p === '/accounts/acc1/email/routing/addresses') return ok([{ email: 'me@inbox.test', verified: '2026-01-01T00:00:00Z' }]);
      if (p === '/accounts/acc1/storage/kv/namespaces' && req.method === 'GET') return ok(cf.kv);
      if (p === '/accounts/acc1/storage/kv/namespaces' && req.method === 'POST') { const n = { id: 'kv1', title: j.title }; cf.kv.push(n); return ok(n); }
      if (p === '/accounts/acc1/storage/kv/namespaces/kv1' && req.method === 'DELETE') { cf.kv = []; return ok({}); }
      if (p === '/accounts/acc1/workers/scripts/vault-mail' && req.method === 'PUT') {
        const form = await new Response(body, { headers: { 'content-type': req.headers['content-type'] } }).formData();
        const file = form.get('worker.js');
        cf.script = { metadata: JSON.parse(await form.get('metadata').text()), code: await file.text(), type: file.type };
        cf.deletedScript = false;
        return ok({ id: 'vault-mail' });
      }
      if (p === '/accounts/acc1/workers/scripts/vault-mail' && req.method === 'DELETE') { cf.deletedScript = true; cf.script = null; return ok(null); }
      if (p === '/accounts/acc1/workers/scripts/vault-mail/schedules') { cf.schedules = j; return ok({ schedules: j }); }
      if (p === '/accounts/acc1/workers/scripts/vault-mail/subdomain') { cf.subdomainOn = j; return ok({ enabled: true, previews_enabled: false }); }
      if (p === '/accounts/acc1/workers/subdomain') return ok({ subdomain: 'me-test' });
      if (p === '/zones/zone1/email/routing/rules' && req.method === 'POST') { const id = 'rule' + (cf.rules.size + 1); cf.rules.set(id, { id, ...j }); return ok({ id, ...j }); }
      const r = /^\/zones\/zone1\/email\/routing\/rules\/(.+)$/.exec(p);
      if (r && req.method === 'PUT') { if (!cf.rules.has(r[1])) return [404, { success: false, errors: [] }]; cf.rules.set(r[1], { id: r[1], ...j }); return ok({ id: r[1], ...j }); }
      if (r && req.method === 'DELETE') { cf.rules.delete(r[1]); return ok({ id: r[1] }); }
      return [404, { success: false, errors: [{ code: 7003, message: 'No route' }] }];
    });
    T.base.cloudflare = CFAPI;
    // The Worker exactly as uploaded, with an in-memory KV.
    const kvStore = new Map();
    const KV = {
      async put(k, v, o) { kvStore.set(k, { v: Buffer.from(v), exp: o && o.expirationTtl ? Math.floor(Date.now() / 1000) + o.expirationTtl : null, meta: o && o.metadata }); },
      async get(k) { const e = kvStore.get(k); return e ? e.v.buffer.slice(e.v.byteOffset, e.v.byteOffset + e.v.length) : null; },
      async delete(k) { kvStore.delete(k); },
      async list({ prefix = '' } = {}) { return { keys: [...kvStore.entries()].filter(([k]) => k.startsWith(prefix)).sort().map(([name, e]) => ({ name, expiration: e.exp, metadata: e.meta })), list_complete: true }; },
    };
    if (!crypto.webcrypto.subtle.timingSafeEqual) crypto.webcrypto.subtle.timingSafeEqual = (a, b) => crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); // a Workers extension
    let workerMod = null; let workerEnv = null; let loadedScript = null; const forwarded = [];
    const loadWorker = async () => {
      if (!cf.script) { workerMod = null; return; }
      if (loadedScript === cf.script) return;
      loadedScript = cf.script;
      const f = path.join(tmp, `worker-${Date.now()}-${crypto.randomInt(1e6)}.mjs`);
      fs.writeFileSync(f, cf.script.code);
      workerMod = (await import(pathToFileURL(f).href)).default;
      const b = Object.fromEntries(cf.script.metadata.bindings.map((x) => [x.name, x]));
      workerEnv = { MAIL: KV, PUBLIC_KEY: b.PUBLIC_KEY.text, FETCH_SECRET: b.FETCH_SECRET.text, FORWARD_TO: b.FORWARD_TO.text };
    };
    const WORKER = await serve('worker', async (req, j, body) => {
      await loadWorker(); // the Worker as last uploaded
      if (!workerMod) return [503, ''];
      const res = await workerMod.fetch(new Request('https://vault-mail.me-test.workers.dev' + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }), workerEnv);
      return [res.status, Buffer.from(await res.arrayBuffer()), { 'Content-Type': res.headers.get('content-type') || 'application/octet-stream' }];
    });
    T.workerUrl = WORKER;
    const deliver = async (to, raw) => { await loadWorker(); return workerMod.email({ from: 'shop@example.net', to, rawSize: Buffer.byteLength(raw), raw: new Response(raw).body, forward: async (dest) => { forwarded.push(dest); } }, workerEnv); };

    // ---------- IMAP over TLS, with a throw-away certificate ----------
    const keyFile = path.join(tmp, 'key.pem'); const certFile = path.join(tmp, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
    const CERT = fs.readFileSync(certFile);
    T.imapTls = {}; // first: Vault's normal certificate checking
    const IMAP_USER = 'aliases@inbox.test'; const IMAP_PASS = 'app-pass-' + crypto.randomBytes(8).toString('hex');
    secrets.push(IMAP_PASS);
    const imap = { mails: new Map(), commands: [], fetched: [] };
    const imapServer = tls.createServer({ key: fs.readFileSync(keyFile), cert: CERT }, (sock) => {
      let buf = '';
      sock.write('* OK IMAP4rev1 test server ready\r\n');
      const unq = (s) => (s && s.startsWith('"') ? s.slice(1, -1).replace(/\\(.)/g, '$1') : s);
      const tokens = (s) => s.match(/"(?:[^"\\]|\\.)*"|\(|\)|[^\s()]+/g) || [];
      const header = (raw, name) => { const top = raw.split(/\r\n\r\n/)[0].replace(/\r\n[ \t]+/g, ' '); return top.split(/\r\n/).filter((l) => l.toLowerCase().startsWith(name.toLowerCase() + ':')).map((l) => l.slice(name.length + 1).trim()); };
      const evalKeys = (toks, raw) => { // AND of keys
        let ok = true;
        while (toks.length && toks[0] !== ')') ok = evalOne(toks, raw) && ok;
        return ok;
      };
      const evalOne = (toks, raw) => {
        const t = toks.shift();
        if (t === '(') { const r = evalKeys(toks, raw); toks.shift(); return r; }
        const k = t.toUpperCase();
        if (k === 'OR') { const a = evalOne(toks, raw); const b = evalOne(toks, raw); return a || b; }
        if (k === 'SINCE') { toks.shift(); return true; }
        if (k === 'HEADER') { const f = unq(toks.shift()); const v = unq(toks.shift()).toLowerCase(); return header(raw, f).some((x) => x.toLowerCase().includes(v)); }
        if (k === 'FROM' || k === 'TO') { const v = unq(toks.shift()).toLowerCase(); return header(raw, k).some((x) => x.toLowerCase().includes(v)); }
        return false;
      };
      sock.on('data', (d) => {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 2);
          const [tag, ...rest] = line.split(' ');
          let cmd = (rest[0] || '').toUpperCase(); let args = rest.slice(1).join(' ');
          if (cmd === 'UID') { cmd = 'UID ' + (rest[1] || '').toUpperCase(); args = rest.slice(2).join(' '); }
          imap.commands.push(cmd + (cmd.startsWith('UID') ? ' ' + args : ''));
          const w = (s) => sock.write(s);
          if (cmd === 'CAPABILITY') w(`* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n${tag} OK done\r\n`);
          else if (cmd === 'LOGIN') { const [u, p] = tokens(args).map(unq); w(u === IMAP_USER && p === IMAP_PASS ? `${tag} OK logged in\r\n` : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`); }
          else if (cmd === 'EXAMINE') w(`* ${imap.mails.size} EXISTS\r\n* OK [UIDVALIDITY 42] ok\r\n${tag} OK [READ-ONLY] EXAMINE completed\r\n`);
          else if (cmd === 'UID SEARCH') { const hits = [...imap.mails.entries()].filter(([, raw]) => evalKeys(tokens(args), raw)).map(([u]) => u); w(`* SEARCH ${hits.join(' ')}\r\n${tag} OK search done\r\n`); }
          else if (cmd === 'UID FETCH') {
            const [set] = args.split(' ');
            const peekHead = /BODY\.PEEK\[HEADER\.FIELDS \(([^)]*)\)\]/i.exec(args);
            const peekAll = /BODY\.PEEK\[\]/i.test(args);
            let n = 0;
            for (const uid of set.split(',').map(Number)) {
              const raw = imap.mails.get(uid);
              if (!raw) continue;
              n++;
              imap.fetched.push({ uid, what: peekHead ? 'header' : peekAll ? 'body' : 'other:' + args });
              const data = peekHead ? peekHead[1].split(' ').map((f) => header(raw, f).map((v) => `${f}: ${v}\r\n`).join('')).join('') + '\r\n' : raw;
              const len = Buffer.byteLength(data);
              w(`* ${n} FETCH (UID ${uid} RFC822.SIZE ${Buffer.byteLength(raw)} BODY[${peekHead ? 'HEADER.FIELDS (' + peekHead[1] + ')' : ''}] {${len}}\r\n${data})\r\n`);
            }
            w(`${tag} OK fetch done\r\n`);
          } else if (cmd === 'LOGOUT') { w(`* BYE\r\n${tag} OK bye\r\n`); sock.end(); }
          else w(`${tag} BAD not here\r\n`);
        }
      });
      sock.on('error', () => {});
    });
    await new Promise((r) => imapServer.listen(0, '127.0.0.1', r));
    servers.push(imapServer);
    const IMAP_PORT = imapServer.address().port;
    const plainServer = require('net').createServer((s) => { s.write('* OK plain IMAP, no TLS\r\n'); s.on('error', () => {}); });
    await new Promise((r) => plainServer.listen(0, '127.0.0.1', r));
    servers.push(plainServer);

    const mime = ({ from, to, subject, html, text, headers = '' }) => `${headers}From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: <${crypto.randomUUID()}@test>\r\nMIME-Version: 1.0\r\n`
      + (html ? `Content-Type: multipart/alternative; boundary="b1"\r\n\r\n--b1\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text || ''}\r\n--b1\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n--b1--\r\n` : `Content-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n`);

    // ================= 0. nothing set up yet =================
    await js("setView('all'); true");
    const st0 = await mailState();
    check('generated email: nothing is set up or contacted by default', st0 && !st0.temp.on && !st0.domain && !Object.values(st0.alias.services).some((s) => s.on) && !log.some((x) => x.site !== 'pwned'));
    check('no Mail view until it’s set up', !(await js("!!document.getElementById('view-mail')")));
    await js("handleCommand('new')");
    await waitFor("!!document.getElementById('genEmail')");
    await js("document.getElementById('genEmail').click()");
    check('with nothing set up, Generate Email leads straight to setting it up', await waitFor("state.mode === 'view' || document.getElementById('mailDlg').open", 3000));
    await js("state.mode = 'view'; state.draft = null; document.getElementById('mailDlg').close(); render(); true");
    await wait(200);

    // ================= 1. one-time inbox (mail.tm) =================
    await js("mailSetupFlow('temp'); true");
    await waitFor("document.getElementById('mailDlg').open && !!document.getElementById('tempToggle')", 3000);
    await shot('50-mail-setup-temp');
    await js("document.getElementById('tempToggle').click()");
    await waitFor("mail.st && mail.st.temp.on", 3000);
    await js("document.getElementById('mailDlg').close()");
    const r1 = await newAccountWithAddress('Forum', 'forum.example', 'One-Time Inbox');
    const forumAddr = await js('state.draft.username');
    check('a one-time inbox is made at mail.tm and becomes the user name', r1.picked === true && r1.made && /^[a-z]{10}[2-9]{4}@tempmail\.test$/.test(forumAddr), forumAddr);
    check('the edit view shows which mode made it', await js("/One-time inbox/.test(document.querySelector('.user-edit .mail-badge').textContent)"));
    await shot('51-edit-generated');
    await save();
    const forum = await item('Forum');
    const recs = () => test.getExtra().mail.addrs;
    const tmRec = Object.values(recs()).find((r) => r.address === forumAddr);
    secrets.push(tmRec.secret.password, tmRec.secret.token);
    check('the account remembers the mode; the inbox password stays inside Vault', forum.mailAddr && forum.mailAddr.mode === 'temp' && tmRec.secret.password.length >= 20 && tm.accounts.get(forumAddr).password === tmRec.secret.password);
    check('the window never gets the inbox password or token', !(await renderer()).includes(tmRec.secret.password) && !(await renderer()).includes(tmRec.secret.token));
    // mail arrives: HTML with a script, remote pictures, a form, a frame, a link and a code
    const evilHtml = `<html><head><meta http-equiv="refresh" content="0;url=${PWN}/refresh"><link rel="stylesheet" href="${PWN}/css.css"><style>@import url(${PWN}/import.css); .x{background:url(${PWN}/bg.png)} p{color:#123}</style><script>fetch('${PWN}/script')</script></head>`
      + `<body><p style="font-size:40px;margin:0"><a id="lnk" href="https://phish.example/login?x=1">Open your account</a></p><p>Your verification code is <b>739204</b>.</p>`
      + `<img src="${PWN}/pixel.png" alt="tracker"><img src="x" onerror="fetch('${PWN}/onerror')"><div style="background-image:url(${PWN}/div.png)">box</div>`
      + `<form action="${PWN}/form"><input name="q"><button>go</button></form><iframe src="${PWN}/iframe"></iframe><svg onload="fetch('${PWN}/svg')"></svg>`
      + `<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" alt="inline"></body></html>`;
    tm.accounts.get(forumAddr).messages.push({ id: 'msg1', raw: mime({ from: 'Forum <noreply@forum.example>', to: forumAddr, subject: 'Confirm your email', html: evilHtml, text: 'Your verification code is 739204. Open https://phish.example/login?x=1 http://plain.example/x' }) });
    const c1 = await js("mailApi('check')");
    check('new mail is fetched from mail.tm', c1 && c1.added === 1, JSON.stringify(c1));
    await waitFor("mail.messages.length === 1", 3000);
    check('the Mail view appears, with a new-mail badge', await waitFor("!!document.getElementById('view-mail') && !!document.querySelector('#view-mail .badge')", 3000));
    const mstore = fs.readFileSync(path.join(app.getPath('userData'), 'mail.vault'), 'utf8');
    check('mail is stored encrypted (no subject, sender or code readable on disk)', !/Confirm your email|739204|forum\.example/.test(mstore) && /"app":"vault-mail"/.test(mstore));
    await js("setView('mail'); true");
    await waitFor("document.querySelectorAll('#list .mail-li').length === 1", 3000);
    await js("document.querySelector('#list .mail-li').click()");
    await waitFor("!!document.getElementById('mailCode')", 3000);
    check('the one-time code is found and shown big', await js("document.querySelector('.mail-code-value').textContent === '739204'"));
    await waitFor("!!document.getElementById('mailFrame') && /^https:\\/\\/vault\\.localhost\\/mail-frame\\/[a-f0-9]{32}$/.test(document.getElementById('mailFrame').src)", 4000);
    await wait(1500);
    await shot('52-mail-message');
    const frameHtml = [...test.mailFrames.values()].pop() || '';
    const fromMail = frameHtml.replace('<meta charset="utf-8">', ''); // (Vault's own page head)
    check('HTML mail is cleaned: no scripts, forms, frames, handlers, refresh or outside styles', !/<script|<form|<iframe|<meta|<link|onerror|onload|@import|<svg/i.test(fromMail) && /Open your account/.test(fromMail), fromMail.match(/<script|<form|<iframe|<meta|<link|onerror|onload|@import|<svg/i) + '');
    check('…and no remote pictures (only pictures sent inside the mail)', !frameHtml.includes(PWN) && /data:image\/png;base64/.test(frameHtml) && (await js("/remote pictures were blocked/.test(document.querySelector('.mail-blocked').textContent)")));
    check('the frame is sandboxed (no scripts) and Vault serves it with a no-scripts, nothing-from-outside policy',
      (await js("document.getElementById('mailFrame').getAttribute('sandbox') === ''")) && /sandbox/.test(require('../security').CSP_MAIL) && /default-src 'none'/.test(require('../security').CSP_MAIL) && /img-src data:/.test(require('../security').CSP_MAIL));
    const mf = win.webContents.mainFrame.framesInSubtree.find((f) => f.url.includes('/mail-frame/'));
    const ran = await Promise.race([mf.executeJavaScript('1 + 1').then(() => true, () => false), wait(2000).then(() => false)]);
    check('no script can run inside the mail frame, not even one Vault itself tries to inject', mf && ran === false);
    const ses = require('electron').session.fromPartition('vault-ui');
    const fr = await ses.fetch(await js("document.getElementById('mailFrame').src"));
    check('the mail frame comes with that policy as a header', /sandbox/.test(fr.headers.get('content-security-policy') || '') && /default-src 'none'/.test(fr.headers.get('content-security-policy') || ''));
    check('nothing in the mail reached the outside (no script, picture, refresh or form request)', !log.some((x) => x.site === 'pwned'), log.filter((x) => x.site === 'pwned').map((x) => x.path).join(' '));
    // a link clicked in the mail: Vault shows the real address first
    const rect = JSON.parse(await js("JSON.stringify(document.getElementById('mailFrame').getBoundingClientRect())"));
    if (process.env.VAULT_DEBUG_FRAMES) {
      win.webContents.on('will-frame-navigate', (e) => console.log('WFN', e.url, e.isMainFrame, e.frame && e.frame.url, e.frame && e.frame.parent && e.frame.parent.url));
      win.webContents.on('did-start-navigation', (e) => console.log('DSN', e.url, e.isMainFrame));
      win.webContents.on('did-fail-provisional-load', (...a) => { const f = require('electron').webFrameMain.fromId(a[5], a[6]); console.log('DFPL', a.slice(1, 7).join(' '), 'frame:', f && f.url); });
      win.webContents.on('console-message', (e) => console.log('CONSOLE', e.message));
      console.log('FRAMES', win.webContents.mainFrame.framesInSubtree.map((f) => f.url).join(' | '), JSON.stringify(rect));
      const mf = win.webContents.mainFrame.framesInSubtree.find((f) => f.url.includes('/mail-frame/'));
      try { console.log('FRAMEJS', await Promise.race([mf.executeJavaScript('JSON.stringify(document.querySelector("a").getBoundingClientRect())'), wait(2000).then(() => 'timeout')])); } catch (e) { console.log('FRAMEJS-ERR', e.message); }
      win.capturePage().then((img) => fs.writeFileSync(path.join(__dirname, '..', 'smoke-shots', 'dbg-frame.png'), img.toPNG()));
    }
    win.focus();
    { // a real click, through Chromium's own input routing (DevTools protocol), on the link inside the frame
      const x = Math.round(rect.left + 60); const y = Math.round(rect.top + 34); const dbg = win.webContents.debugger;
      dbg.attach('1.3');
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) { await dbg.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); await wait(60); }
      dbg.detach(); }
    check('clicking a link in a mail shows its real address before anything opens', await waitFor("document.getElementById('alert').open && /phish\\.example\\/login\\?x=1/.test(document.getElementById('alertBody').textContent)", 4000));
    await shot('53-mail-link');
    opened.length = 0;
    await js("document.getElementById('alertOk').click()");
    await wait(300);
    check('…and opens it in the browser only when you say so', opened.includes('https://phish.example/login?x=1'), opened.join(' '));
    await clipboard.clear();
    await js("document.getElementById('mailCodeCopy').click()");
    await wait(250);
    const cc = await clipboard.readText();
    await wait(1700);
    check('Copy puts the code on the clipboard, and it clears itself', cc === '739204' && (await clipboard.readText()) === '', cc);
    await js("document.querySelector('.mail-seg input[value=text]').click()");
    await waitFor("!!document.getElementById('mailPlain')", 2000);
    check('plain-text view shows the text, links as buttons', await js("document.querySelectorAll('#mailPlain .mail-link').length === 2"));
    await js("[...document.querySelectorAll('#mailPlain .mail-link')].find(a => a.textContent.startsWith('http:')).click()");
    check('a plain http link is not opened, only offered to copy', await waitFor("document.getElementById('alert').open && /only opens https/.test(document.getElementById('alertBody').textContent)", 2000));
    await js("document.getElementById('alert').close()");
    const codes = await js(`[findMailCode('Your code', 'Use 482 913 to sign in'), findMailCode('Order #48291367 shipped', 'Tracking 123456789'), findMailCode('Welcome', 'Thanks for joining in 2026'), findMailCode('Код за вход', 'Вашият код е 5521')]`);
    check('codes are found in common wordings, not in order numbers or years', JSON.stringify(codes) === JSON.stringify(['482913', null, null, '5521']), JSON.stringify(codes));
    // the account shows its inbox
    await js(`setView('all'); select(${byName('Forum')}.id); true`);
    check('the account shows its address, a warning for one-time inboxes, and its inbox', await waitFor("[...document.querySelectorAll('.section-label')].some(l => /^Inbox/.test(l.textContent)) && /Only for things that don’t matter/.test(document.querySelector('.temp-warn').textContent) && document.querySelectorAll('.detail .mail-row').length === 1", 3000));
    await shot('54-account-inbox');
    // the provider's expiry: the inbox is gone at mail.tm
    tm.deleted.add(forumAddr);
    await js("mailApi('check')");
    check('an inbox gone at mail.tm is marked expired', await waitFor("mail.st && mail.st.addresses.some(a => a.state === 'expired')", 3000) || Object.values(recs()).some((r) => r.address === forumAddr && r.state === 'expired'));
    // removing an account deletes its inbox at mail.tm
    const r2 = await newAccountWithAddress('Coupons', 'coupons.example', 'One-Time Inbox');
    await save();
    const couponsAddr = (await item('Coupons')).username;
    await js(`updateItem(${byName('Coupons')}, { deletedAt: Date.now() }); true`);
    await waitFor(`!!${byName('Coupons')}.deletedAt`, 2000);
    await js(`purgeItem(${byName('Coupons')}); true`);
    await waitFor("document.getElementById('alert').open", 2000);
    check('deleting the account says its address goes too', r2.made && (await js("/generated email address is deleted too/.test(document.getElementById('alertBody').textContent)")));
    await js("document.getElementById('alertOk').click()");
    check('…and the inbox is deleted at mail.tm', await waitFor(`!${byName('Coupons')}`, 3000) && (await (async () => { for (let i = 0; i < 30 && !tm.deleted.has(couponsAddr); i++) await wait(100); return tm.deleted.has(couponsAddr); })()));

    // ================= 2. alias services + IMAP =================
    await js("mailSetupFlow('alias'); true");
    await waitFor("!!document.getElementById('key-simplelogin')", 3000);
    await js(`(() => { document.getElementById('key-simplelogin').value = 'wrong-key-123456'; document.getElementById('keyGo-simplelogin').click(); })()`);
    check('a wrong API key is refused with a clear message', await waitFor("/refused the key/.test(document.getElementById('aliasStatus').textContent)", 3000));
    for (const k of ['simplelogin', 'addy', 'relay']) {
      await js(`(() => { document.getElementById('key-${k}').value = ${JSON.stringify(KEYS[k])}; document.getElementById('keyGo-${k}').click(); })()`);
      await waitFor(`mail.st.alias.services.${k}.on`, 3000);
    }
    check('SimpleLogin, addy.io and Firefox Relay connect with your own keys', await js("['simplelogin','addy','relay'].every(k => mail.st.alias.services[k].on)"));
    // the mailbox: TLS only, read-only; wrong password and plain-text servers are refused clearly
    await js(`(() => { document.getElementById('imapPreset').value = 'other'; document.getElementById('imapHost').value = '127.0.0.1'; })()`);
    const tryBox = async (port, pass) => {
      await js(`(() => { mailApi('mailbox', { host: '127.0.0.1', port: ${port}, user: ${JSON.stringify(IMAP_USER)}, pass: ${JSON.stringify(pass)} }).then(r => { window.__box = r; }); window.__box = undefined; })()`);
      await waitFor('window.__box !== undefined', 15000);
      return js('window.__box');
    };
    const untrusted = await tryBox(IMAP_PORT, IMAP_PASS);
    check('certificate checking is on: a mail server whose certificate can’t be verified is refused', untrusted && untrusted.error === 'tls', JSON.stringify(untrusted));
    // Does something on this PC (e.g. an antivirus mail shield) re-sign TLS connections? Then the test
    // certificate never arrives as it is, and the IMAP checks below run with checking relaxed (tests only).
    const probe = await new Promise((res) => { const c = tls.connect({ host: '127.0.0.1', port: IMAP_PORT, ca: CERT }, () => { res(true); c.end(); }); c.on('error', () => res(false)); });
    T.imapTls = probe ? { ca: CERT } : { rejectUnauthorized: false };
    if (!probe) console.log('NOTE  TLS on this PC is re-signed by another program (e.g. antivirus); IMAP protocol checks run without certificate checking');
    const plainTry = await tryBox(plainServer.address().port, IMAP_PASS);
    check('a mail server without TLS is refused', plainTry && (plainTry.error === 'tls' || plainTry.error === 'connect' || plainTry.error === 'closed'), JSON.stringify(plainTry));
    const wrongTry = await tryBox(IMAP_PORT, 'nope');
    check('a wrong mailbox password gives a clear error', wrongTry && wrongTry.error === 'auth', JSON.stringify(wrongTry));
    const goodTry = await tryBox(IMAP_PORT, IMAP_PASS);
    check('the mailbox connects over TLS and opens read-only (EXAMINE)', goodTry && !goodTry.error && imap.commands.includes('EXAMINE') && !imap.commands.some((c) => /^SELECT/.test(c)), JSON.stringify(goodTry && goodTry.error));
    await js("mail.st = window.__box; renderMailSetup(); true");
    await shot('55-mail-setup-alias');
    await js("document.getElementById('mailDlg').close()");
    const made = {};
    for (const [title, label, k] of [['Shop One', 'SimpleLogin', 'simplelogin'], ['Shop Two', 'addy.io', 'addy'], ['Shop Three', 'Firefox Relay', 'relay']]) {
      const r = await newAccountWithAddress(title, title.toLowerCase().replace(' ', '') + '.example', 'Hidden Address · ' + label);
      await save();
      check(`an alias is made at ${label}`, r.picked === true && r.made, String(r.picked) + ' ' + (r.made ? '' : (() => { try { return fs.readFileSync(path.join(app.getPath('userData'), 'update.log'), 'utf8').split(String.fromCharCode(10)).filter((l) => l.includes('[mail]')).slice(-3).join(' / '); } catch { return 'no log'; } })()));
      made[k] = { title, address: (await item(title)).username };
    }
    const recOf = (address) => Object.values(recs()).find((x) => x.address === address);
    check('aliases are made with the site name as the note', [...sl.aliases.values()].some((a) => a.note === 'Shop One' && a.hostname === 'shopone.example') && [...ad.aliases.values()].some((a) => a.description === 'Shop Two') && [...rl.masks.values()].some((a) => a.description === 'Shop Three' && a.generated_for === 'shopthree.example'));
    check('each account shows which service made its address', (await item('Shop One')).mailAddr.service === 'simplelogin' && (await item('Shop Two')).mailAddr.service === 'addy' && (await item('Shop Three')).mailAddr.service === 'relay');
    // the mailbox: alias mail, look-alikes, and private mail that must never be touched
    const slA = made.simplelogin.address; const adR = recOf(made.addy.address); const rlA = made.relay.address;
    imap.mails.set(1, mime({ headers: `X-SimpleLogin-Envelope-To: ${slA}\r\nX-SimpleLogin-Type: Forward\r\n`, from: '"Shop" <ra+x@simplelogin.co>', to: slA, subject: 'Welcome from Shop One', text: 'Your login code is 551177' }));
    imap.mails.set(2, mime({ headers: `Feedback-ID: F:${adR.secret.aliasId}:anonaddy\r\n`, from: `"Shop" <${made.addy.address.split('@')[0]}+shop=two.example@anonaddy.me>`, to: 'me@inbox.test', subject: 'Shop Two order', text: 'Thanks' }));
    imap.mails.set(3, mime({ from: `"news@three.example [via Relay]" <${rlA}>`, to: 'me@inbox.test', subject: 'Shop Three news', text: 'Hello' }));
    imap.mails.set(4, mime({ from: 'Mum <mum@family.test>', to: IMAP_USER, subject: 'PRIVATE family photos', text: 'private' }));
    imap.mails.set(5, mime({ headers: `X-SimpleLogin-Envelope-To: zz${slA}\r\n`, from: 'x <x@simplelogin.co>', to: 'zz' + slA, subject: 'PRIVATE look-alike alias', text: 'private' }));
    imap.mails.set(6, mime({ from: `"x" <x${rlA}>`, to: IMAP_USER, subject: 'PRIVATE look-alike sender', text: 'private' }));
    imap.mails.set(7, mime({ from: 'Bank <bank@bank.test>', to: IMAP_USER, subject: 'PRIVATE statement for ' + slA, text: 'private ' + slA }));
    imap.fetched.length = 0;
    const c2 = await js("mailApi('check')");
    check('alias mail is read from the mailbox (SimpleLogin, addy.io and Relay)', c2 && c2.added === 3, JSON.stringify(c2));
    const bodies = imap.fetched.filter((f) => f.what === 'body').map((f) => f.uid).sort().join();
    const touched = [...new Set(imap.fetched.map((f) => f.uid))];
    check('only alias mail is downloaded; nothing else in the mailbox is', bodies === '1,2,3' && !touched.includes(4) && !touched.includes(7), `bodies ${bodies}, touched ${touched.join()}`);
    check('look-alikes are checked by their header line only, never downloaded', !imap.fetched.some((f) => f.what === 'body' && [5, 6].includes(f.uid)) && imap.fetched.every((f) => f.what === 'header' || f.what === 'body'));
    check('the server does the searching (UID SEARCH), Vault never marks or changes anything', imap.commands.some((c) => /^UID SEARCH .*HEADER X-SimpleLogin-Envelope-To/.test(c)) && !imap.commands.some((c) => /STORE|COPY|MOVE|EXPUNGE|^SELECT|BODY\[/.test(c.replace(/BODY\.PEEK\[/g, ''))));
    await waitFor('mail.messages.length >= 4', 3000);
    check('no private mail shows in Vault', !(await js("JSON.stringify(mail.messages)")).includes('PRIVATE'));
    const again = (await js("mailApi('check')")) || {};
    check('mail already read isn’t fetched again', again.added === 0 && imap.fetched.filter((f) => f.what === 'body').length === 3);
    // switch off / on / delete at the services
    await js(`select(${byName('Shop One')}.id); true`);
    await waitFor("!!document.getElementById('addrToggle')", 2000);
    await js("document.getElementById('addrToggle').click()");
    check('Switch Off turns the alias off at SimpleLogin', await waitFor("mail.st.addresses.some(a => a.service === 'simplelogin' && a.state === 'off')", 3000) && [...sl.aliases.values()][0].enabled === false);
    await js("document.getElementById('addrToggle').click()");
    await waitFor("mail.st.addresses.some(a => a.service === 'simplelogin' && a.state === 'on')", 3000);
    await js(`mailApi('set-state', mail.st.addresses.find(a => a.service === 'relay').id, false)`);
    await js(`mailApi('set-state', mail.st.addresses.find(a => a.service === 'addy').id, false)`);
    check('…at Firefox Relay and addy.io too', [...rl.masks.values()][0].enabled === false && [...ad.aliases.values()][0].active === false && [...sl.aliases.values()][0].enabled === true);
    await js(`select(${byName('Shop Three')}.id); true`);
    await waitFor("!!document.getElementById('addrDelete')", 2000);
    await js("document.getElementById('addrDelete').click()");
    await waitFor("document.getElementById('alert').open", 2000);
    await js("document.getElementById('alertOk').click()");
    check('Delete removes the alias at the service and from the account', await waitFor(`!${byName('Shop Three')}.mailAddr`, 3000) && rl.masks.size === 0);

    // ================= 3. your own domain (Cloudflare) =================
    await js("mailSetupFlow('domain'); true");
    await waitFor("!!document.getElementById('cfToken')", 3000);
    await shot('56-mail-setup-domain');
    check('the wizard lists exactly the token permissions needed', await js("[...document.querySelectorAll('.perm-list li')].map(l => l.textContent).join('|') === 'Account · Workers Scripts · Edit|Account · Workers KV Storage · Edit|Account · Email Routing Addresses · Read|Zone · Email Routing Rules · Edit|Zone · Zone · Read|Zone · Zone Settings · Read'"));
    await js(`(() => { document.getElementById('cfToken').value = ${JSON.stringify(CF_TOKEN)}; document.getElementById('cfCheck').click(); })()`);
    await waitFor("!document.getElementById('cfZone').hidden && document.getElementById('cfZone').value === 'zone1'", 4000);
    await js(`(() => { document.getElementById('cfCopies').checked = true; document.getElementById('cfDest').value = 'me@inbox.test'; document.getElementById('cfDeploy').click(); })()`);
    for (let i = 0; i < 100 && !cf.script; i++) await wait(100);
    check('Vault deploys the Worker itself (module, KV, secret, public key, daily cleanup, workers.dev)',
      !!cf.script && cf.script.type === 'application/javascript+module' && cf.script.code === fs.readFileSync(path.join(__dirname, '..', 'mail', 'worker.js'), 'utf8') && cf.kv.length === 1
      && JSON.stringify(cf.schedules) === JSON.stringify([{ cron: '17 3 * * *' }]) && cf.subdomainOn && cf.subdomainOn.enabled === true);
    const binds = cf.script ? Object.fromEntries(cf.script.metadata.bindings.map((b) => [b.name, b])) : {};
    const dRec = () => test.getExtra().mail.domain;
    check('the Worker gets only the public key and the secret (as a Worker secret), never the private key',
      binds.FETCH_SECRET && binds.FETCH_SECRET.type === 'secret_text' && binds.PUBLIC_KEY && !('d' in JSON.parse(binds.PUBLIC_KEY.text)) && binds.MAIL.type === 'kv_namespace' && dRec() && dRec().privateJwk.d && !JSON.stringify(cf.script.metadata).includes(dRec().privateJwk.d));
    if (dRec()) secrets.push(dRec().secret, dRec().privateJwk.d);
    check('the Test button checks the whole chain, step by step', await waitFor("document.querySelectorAll('#cfTest li.ok').length === 5", 15000), await js("document.getElementById('cfTest').textContent + ' / ' + document.getElementById('cfStatus').textContent"));
    await shot('57-mail-domain-tested');
    await js("document.getElementById('mailDlg').close()");
    const r3 = await newAccountWithAddress('Streaming', 'streaming.example', 'Address on example.com');
    const dAddr = await js('state.draft.username');
    await save();
    check('domain addresses: short site name + random part, nothing personal', r3.made && /^streaming\.[a-z0-9]{6}@example\.com$/.test(dAddr), dAddr);
    const rule = [...cf.rules.values()].find((r) => r.matchers[0].value === dAddr);
    check('each address gets its own exact rule to the Worker; never a catch-all', rule && rule.matchers.length === 1 && rule.matchers[0].type === 'literal' && rule.matchers[0].field === 'to' && rule.actions[0].type === 'worker' && rule.actions[0].value[0] === 'vault-mail' && ![...cf.rules.values()].some((r) => r.matchers.some((m) => m.type === 'all')));
    await deliver(dAddr, mime({ from: 'Streaming <hello@streaming.example>', to: dAddr, subject: 'Your sign-in code', text: 'Enter 604218 to sign in.' }));
    check('with copies on, the Worker also forwards the message to you', forwarded.includes('me@inbox.test'));
    const kvRaw = [...kvStore.values()].map((e) => e.v.toString('latin1')).join('');
    check('Cloudflare storage holds only ciphertext', kvStore.size === 1 && !/sign-in code|604218|streaming/.test(kvRaw));
    const c3 = await js("mailApi('check')");
    check('Vault fetches it, opens it with its private key, and it is deleted at Cloudflare', c3 && c3.added === 1 && kvStore.size === 0 && (await waitFor("mail.messages.some(m => m.code === '604218')", 3000)));
    await js(`select(${byName('Streaming')}.id); true`);
    await waitFor("!!document.getElementById('addrToggle')", 2000);
    await js("document.getElementById('addrToggle').click()");
    check('Switch Off disables that address’s rule', await waitFor("mail.st.addresses.some(a => a.mode === 'domain' && a.state === 'off')", 3000) && rule && cf.rules.get(rule.id).enabled === false);
    await js("document.getElementById('addrToggle').click()");
    await waitFor("mail.st.addresses.some(a => a.mode === 'domain' && a.state === 'on')", 3000);
    // update and remove the Worker
    await js("mailSetupFlow('domain'); true");
    await waitFor("!!document.getElementById('cfUpdate')", 3000);
    const before = cf.script && cf.script.metadata;
    await js("document.getElementById('cfCopies').checked = false; document.getElementById('cfUpdate').click(); true");
    await waitFor("document.querySelectorAll('#cfTest li').length > 0", 15000);
    check('Update Worker re-deploys it with the same keys (copies now off)', cf.script && JSON.parse(cf.script.metadata.bindings.find((b) => b.name === 'PUBLIC_KEY').text).x === JSON.parse(before.bindings.find((b) => b.name === 'PUBLIC_KEY').text).x && cf.script.metadata.bindings.find((b) => b.name === 'FORWARD_TO').text === '');
    await js("document.getElementById('cfRemove').click()");
    await waitFor("document.getElementById('alert').open", 2000);
    await js("document.getElementById('alertOk').click()");
    check('Remove deletes the Worker, its stored mail (KV) and the routing rules', await waitFor('!mail.st.domain', 6000) && cf.deletedScript && cf.kv.length === 0 && cf.rules.size === 0);
    await js("document.getElementById('mailDlg').close()");

    // ================= 4. secrets, and checking only while unlocked =================
    const r = await renderer();
    check('no API key, token, mailbox password, Worker secret or private key ever reaches the window', secrets.every((s) => !r.includes(s)));
    const prefsFile = path.join(app.getPath('userData'), 'settings.json');
    const prefsText = fs.existsSync(prefsFile) ? fs.readFileSync(prefsFile, 'utf8') : '';
    const logText = fs.existsSync(path.join(app.getPath('userData'), 'update.log')) ? fs.readFileSync(path.join(app.getPath('userData'), 'update.log'), 'utf8') : '';
    check('…nor the settings file or the log', secrets.every((s) => !prefsText.includes(s) && !logText.includes(s)));
    T.every = { temp: 300, alias: 300, domain: 300 }; // (used from the next unlock)
    await relock();
    const n0 = log.length + imap.commands.length;
    await wait(1500);
    check('nothing is checked while Vault is locked', log.length + imap.commands.length === n0);
    await unlockUI();
    await wait(1500);
    check('…and checking starts again after unlocking', log.length + imap.commands.length > n0);
    T.every = { temp: 60000, alias: 180000, domain: 120000 };
    MAIL.restart();
    check('mail stays after locking (encrypted in the vault)', await waitFor('mail.messages.length >= 4', 4000));
    await js("setView('mail'); true");
    await wait(300);
    await shot('58-mail-view');
    await js("setView('all'); true");
  } catch (err) {
    check('mail tests crashed', false, err && err.stack);
  }
  // leave the vault as the rest of the smoke test expects it: test accounts out, nothing set up
  try {
    await js(`(async () => { state.items = state.items.filter(i => !['Forum', 'Coupons', 'Shop One', 'Shop Two', 'Shop Three', 'Streaming'].includes(i.title)); state.selectedId = null; await persist(); setView('all'); render(); return true; })()`);
    for (const k of ['simplelogin', 'addy', 'relay']) await js(`mailApi('alias-key', '${k}', null)`);
    await js("mailApi('mailbox', null)"); await js("mailApi('set-temp', false)");
    MAIL.restart();
  } catch {}
  for (const s of servers) s.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  return { secrets: secrets.filter(Boolean) };
};
