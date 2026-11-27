'use strict';
// Generated email addresses and their mail (main process only).
//
// Three ways to make an address, each set up separately and chosen per account:
//   temp   – a one-time inbox (mail.tm): Vault holds its password and reads it through the provider's API
//   alias  – a hidden address at SimpleLogin, addy.io or Firefox Relay (your own API key); its mail is
//            read from the mailbox the aliases forward to, over read-only IMAP (mail/imap.js)
//   domain – an address on your own domain: a Cloudflare Email Routing rule sends it to a Worker in your
//            account, which encrypts each message for Vault (mail/cloudflare.js, mail/worker.js)
// Keys, tokens and passwords for these services live only inside the encrypted vault (session.extra.mail).
// The window only ever gets the public part: addresses, states, settings without secrets.
// Mail is checked only while Vault is unlocked, and only as often as each provider allows.

const crypto = require('crypto');
const { mailTm, ALIAS_SERVICES, ServiceError, slug, rand } = require('./providers');
const CF = require('./cloudflare');
const IMAP = require('./imap');
const createStore = require('./store');
const { findMailCode } = require('../src/mailcode.js');

const SERVICE_NAMES = { mailtm: 'mail.tm', simplelogin: 'SimpleLogin', addy: 'addy.io', relay: 'Firefox Relay', cloudflare: 'Cloudflare' };
const MAX_TEXT = 1024 * 1024;
const MAX_HTML = 2 * 1024 * 1024;
const MAX_INLINE_IMAGES = 4 * 1024 * 1024;

let PostalMime = null;
const parser = () => { if (!PostalMime) { const m = require('postal-mime'); PostalMime = m.default || m.PostalMime || m; } return PostalMime; };

module.exports = function createMail({ app, getKey, getExtra, saveExtra, send, log }) {
  // test hooks (smoke test only): where each service lives, the IMAP server's test certificate, how often to check
  const t = {
    base: { mailtm: undefined, simplelogin: undefined, addy: undefined, relay: undefined, cloudflare: undefined },
    imapTls: {}, every: { temp: 60000, alias: 180000, domain: 120000 }, workerUrl: null,
  };
  const store = createStore({ dir: () => app.getPath('userData'), getKey });
  let timers = [];
  let cfPending = null;   // a token being set up (kept in memory until the Worker is deployed)
  const busy = {};

  // ---- settings and records (inside the encrypted vault) ----
  const cfg = () => { const e = getExtra(); return e && e.mail ? e.mail : {}; };
  const unlocked = () => !!getExtra();
  function save(patch) {
    if (!unlocked()) throw new ServiceError('locked', 0);
    const next = { ...cfg(), ...patch };
    if (!saveExtra({ mail: next })) throw new ServiceError('save', 0);
    return next;
  }
  const addrs = () => cfg().addrs || {};
  function saveAddr(rec) { save({ addrs: { ...addrs(), [rec.id]: rec } }); }
  function dropAddr(id) { const a = { ...addrs() }; delete a[id]; save({ addrs: a }); }

  const temp = () => mailTm({ base: t.base.mailtm });
  const aliasSvc = (id) => { const key = ((cfg().alias || {}).keys || {})[id]; return key && ALIAS_SERVICES[id] ? ALIAS_SERVICES[id]({ key, base: t.base[id] }) : null; };
  const cf = (token) => CF.client({ token, base: t.base.cloudflare });

  const pub = (r) => ({ id: r.id, mode: r.mode, service: r.service, serviceName: SERVICE_NAMES[r.service] || r.service, address: r.address, entryId: r.entryId || null, state: r.state, created: r.created, site: r.site || '' });

  function publicState() {
    const c = cfg();
    const al = c.alias || {};
    const d = c.domain || null;
    const msgs = unlocked() ? store.list() : [];
    return {
      temp: { on: !!(c.temp && c.temp.on), provider: 'mail.tm', site: 'https://mail.tm', keepsDays: 7 },
      alias: {
        services: Object.fromEntries(Object.keys(ALIAS_SERVICES).map((k) => [k, { on: !!(al.keys && al.keys[k]), name: SERVICE_NAMES[k], account: (al.accounts || {})[k] || '' }])),
        imap: al.imap ? { host: al.imap.host, port: al.imap.port, user: al.imap.user } : null,
      },
      domain: d ? { zone: d.zoneName, account: d.accountName || '', url: d.url, dest: d.dest || '', copies: !!d.copies, deployedAt: d.deployedAt } : null,
      addresses: Object.values(addrs()).map(pub),
      unread: msgs.filter((m) => !m.seen).length,
    };
  }
  const modesReady = () => {
    const s = publicState();
    return { temp: s.temp.on, alias: Object.entries(s.alias.services).filter(([, v]) => v.on).map(([k]) => k), domain: !!s.domain };
  };

  // ---- settings: one-time inboxes ----
  function setTemp(on) { save({ temp: { on: !!on } }); return publicState(); }

  // ---- settings: alias services and the mailbox they forward to ----
  async function setAliasKey(service, key) {
    if (!ALIAS_SERVICES[service]) throw new ServiceError('bad', 0);
    const al = { ...(cfg().alias || {}) };
    al.keys = { ...(al.keys || {}) }; al.accounts = { ...(al.accounts || {}) };
    if (!key) { delete al.keys[service]; delete al.accounts[service]; save({ alias: al }); return publicState(); }
    key = String(key).trim();
    if (!/^[\x21-\x7e]{8,512}$/.test(key)) throw new ServiceError('bad-key', 0);
    const v = await ALIAS_SERVICES[service]({ key, base: t.base[service] }).verify();
    al.keys[service] = key; al.accounts[service] = v.account || '';
    save({ alias: al });
    return publicState();
  }
  async function setMailbox(box) {
    const al = { ...(cfg().alias || {}) };
    if (!box) { delete al.imap; delete al.seen; save({ alias: al }); return publicState(); }
    const imap = { host: String(box.host || '').trim().toLowerCase(), port: Number(box.port) || 993, user: String(box.user || '').trim(), pass: String(box.pass || '') };
    if (!/^[a-z0-9.-]+$/.test(imap.host) || !imap.user || !imap.pass || imap.port < 1 || imap.port > 65535) throw new ServiceError('bad', 0);
    await IMAP.testMailbox({ ...imap, tlsOptions: t.imapTls });
    al.imap = imap; al.seen = null;
    save({ alias: al });
    return publicState();
  }

  // ---- settings: your own domain (Cloudflare) ----
  async function cfZones(token) {
    token = String(token || '').trim();
    if (!/^[A-Za-z0-9_-]{30,200}$/.test(token)) throw new ServiceError('bad-key', 0);
    const zones = await cf(token).zones();
    cfPending = { token, zones };
    return zones.map((z) => ({ id: z.id, name: z.name, account: z.accountName || '' }));
  }
  async function cfDeploy({ zoneId, dest, copies }) {
    const c = cfg().domain;
    const token = cfPending ? cfPending.token : c && c.token;
    if (!token) throw new ServiceError('no-token', 0);
    const api = cf(token);
    const zones = cfPending ? cfPending.zones : await api.zones();
    const zone = zones.find((z) => z.id === (zoneId || (c && c.zoneId)));
    if (!zone) throw new ServiceError('no-zone', 0);
    const routing = await api.routing(zone.id);
    if (!routing || !routing.enabled) throw new ServiceError('routing-off', 0);
    const forward = copies && dest ? String(dest).trim() : '';
    if (forward && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(forward)) throw new ServiceError('bad-dest', 0);
    const keys = c && c.privateJwk && c.zoneId === zone.id ? { publicJwk: c.publicJwk, privateJwk: c.privateJwk } : CF.newKeys();
    const secret = c && c.secret && c.zoneId === zone.id ? c.secret : crypto.randomBytes(32).toString('base64url');
    const kvId = await api.kvNamespace(zone.accountId);
    const deployed = await api.putWorker(zone.accountId, { kvId, publicJwk: keys.publicJwk, secret, forwardTo: forward });
    const url = t.workerUrl || deployed; // (the smoke test points it at a local copy of the Worker)
    save({ domain: { token, accountId: zone.accountId, accountName: zone.accountName || '', zoneId: zone.id, zoneName: zone.name, kvId, url, secret, publicJwk: keys.publicJwk, privateJwk: keys.privateJwk, dest: dest ? String(dest).trim() : '', copies: !!forward, deployedAt: Date.now() } });
    cfPending = null;
    return publicState();
  }
  // The Test button: every link of the chain, one line each.
  async function cfTest() {
    const d = cfg().domain;
    if (!d) throw new ServiceError('no-setup', 0);
    const api = cf(d.token);
    const steps = [];
    const step = async (name, fn) => { try { const detail = await fn(); steps.push({ name, ok: true, detail: detail || '' }); return true; } catch (e) { steps.push({ name, ok: false, detail: e.code || 'failed' }); return false; } };
    await step('token', async () => { if (!(await api.zones()).some((z) => z.id === d.zoneId)) throw new ServiceError('no-zone', 0); });
    await step('routing', async () => { const r = await api.routing(d.zoneId); if (!r || !r.enabled) throw new ServiceError('routing-off', 0); return r.status || ''; });
    await step('secret', async () => {
      const res = await fetch(d.url + '/list', { signal: AbortSignal.timeout(15000), redirect: 'error' });
      if (res.status !== 401) throw new ServiceError('open', res.status);
    });
    await step('roundtrip', async () => {
      const nonce = crypto.randomBytes(16).toString('hex');
      await CF.worker(d.url, d.secret, 'POST', '/selftest?nonce=' + nonce);
      for (let i = 0; i < 8; i++) {
        const { ids } = await (await CF.worker(d.url, d.secret, 'GET', '/list')).json();
        for (const id of ids) {
          const box = Buffer.from(await (await CF.worker(d.url, d.secret, 'GET', '/m/' + encodeURIComponent(id))).arrayBuffer());
          const raw = CF.openBox(d.privateJwk, box).toString('utf8');
          if (raw.includes('Vault test ' + nonce)) { await CF.worker(d.url, d.secret, 'DELETE', '/m/' + encodeURIComponent(id)); return ''; }
        }
        await new Promise((r) => setTimeout(r, i < 3 ? 1000 : 4000));
      }
      throw new ServiceError('no-roundtrip', 0);
    });
    if (d.copies) await step('dest', async () => { const list = await api.addresses(d.accountId); const a = (list || []).find((x) => String(x.email).toLowerCase() === d.dest.toLowerCase()); if (!a) throw new ServiceError('dest-missing', 0); if (!a.verified) throw new ServiceError('dest-unverified', 0); });
    return steps;
  }
  async function cfRemove() {
    const d = cfg().domain;
    if (!d) return publicState();
    const api = cf(d.token);
    const next = { ...addrs() };
    for (const r of Object.values(next)) {
      if (r.mode !== 'domain') continue;
      try { await api.deleteRule(d.zoneId, r.secret.ruleId); } catch (e) { if (e.code !== 'gone') throw e; }
      next[r.id] = { ...r, state: 'off', secret: {} };
    }
    try { await api.deleteWorker(d.accountId); } catch (e) { if (e.code !== 'gone') throw e; }
    try { await api.kvDelete(d.accountId, d.kvId); } catch (e) { if (e.code !== 'gone') throw e; }
    save({ addrs: next, domain: null });
    return publicState();
  }

  // ---- addresses ----
  async function create({ mode, service, site, host, entryId }) {
    const ready = modesReady();
    const id = 'ad_' + crypto.randomBytes(9).toString('hex');
    const name = String(site || '').slice(0, 60);
    let rec;
    if (mode === 'temp') {
      if (!ready.temp) throw new ServiceError('not-set-up', 0);
      const a = await temp().create();
      rec = { id, mode, service: 'mailtm', address: a.address, secret: { password: a.password, accountId: a.accountId, token: a.token } };
    } else if (mode === 'alias') {
      if (!ready.alias.includes(service)) throw new ServiceError('not-set-up', 0);
      const a = await aliasSvc(service).create(name || 'Vault', host ? String(host).slice(0, 120) : '');
      rec = { id, mode, service, address: a.address, secret: { aliasId: a.aliasId } };
    } else if (mode === 'domain') {
      const d = cfg().domain;
      if (!d) throw new ServiceError('not-set-up', 0);
      const address = `${slug(name || host)}.${rand(6)}@${d.zoneName}`;
      const r = await cf(d.token).createRule(d.zoneId, address);
      rec = { id, mode, service: 'cloudflare', address, secret: { ruleId: r.id || r.tag } };
    } else throw new ServiceError('bad', 0);
    rec = { ...rec, entryId: entryId ? String(entryId) : null, state: 'on', created: Date.now(), site: name };
    try { saveAddr(rec); } catch (e) { await removeAt(rec).catch(() => {}); throw e; }
    return pub(rec);
  }

  async function removeAt(r) {
    if (r.mode === 'temp') await temp().remove({ address: r.address, ...r.secret });
    else if (r.mode === 'alias') { const s = aliasSvc(r.service); if (s) await s.remove({ aliasId: r.secret.aliasId }); }
    else if (r.mode === 'domain') { const d = cfg().domain; if (d && r.secret.ruleId) { try { await cf(d.token).deleteRule(d.zoneId, r.secret.ruleId); } catch (e) { if (e.code !== 'gone') throw e; } } }
  }
  async function remove(id) {
    const r = addrs()[id];
    if (!r) return true;
    await removeAt(r);
    dropAddr(id);
    store.remove((m) => m.addrId === id);
    return true;
  }
  async function setState(id, on) {
    const r = addrs()[id];
    if (!r) throw new ServiceError('gone', 404);
    if (r.mode === 'temp') throw new ServiceError('bad', 0); // mail.tm can't pause an inbox: delete it instead
    if (r.mode === 'alias') { const s = aliasSvc(r.service); if (!s) throw new ServiceError('not-set-up', 0); await s.setEnabled({ aliasId: r.secret.aliasId }, !!on); }
    if (r.mode === 'domain') { const d = cfg().domain; if (!d || !r.secret.ruleId) throw new ServiceError('not-set-up', 0); await cf(d.token).setRule(d.zoneId, r.secret.ruleId, r.address, !!on); }
    saveAddr({ ...r, state: on ? 'on' : 'off' });
    return pub(addrs()[id]);
  }
  function link(id, entryId) { const r = addrs()[id]; if (!r) return false; saveAddr({ ...r, entryId: entryId ? String(entryId) : null }); return true; }

  // ---- reading mail ----
  const msgId = (addrId, providerId) => 'm_' + crypto.createHash('sha256').update(addrId + '\n' + providerId).digest('hex').slice(0, 24);
  const htmlText = (html) => String(html || '').replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();

  async function parse(raw, addrId, providerId) {
    const e = await parser().parse(raw);
    let html = typeof e.html === 'string' ? e.html : '';
    // Pictures sent inside the message (cid:) are shown from the message itself; nothing is fetched.
    let budget = MAX_INLINE_IMAGES;
    for (const a of e.attachments || []) {
      if (!a.contentId || !/^image\/(png|jpe?g|gif|webp)$/i.test(a.mimeType || '')) continue;
      const buf = Buffer.from(a.content instanceof ArrayBuffer ? new Uint8Array(a.content) : a.content || []);
      if (!buf.length || buf.length > budget) continue;
      budget -= buf.length;
      const cid = String(a.contentId).replace(/^<|>$/g, '');
      html = html.split('cid:' + cid).join(`data:${a.mimeType.toLowerCase()};base64,${buf.toString('base64')}`);
    }
    if (html.length > MAX_HTML) html = '';
    const text = String(e.text || '').slice(0, MAX_TEXT);
    const subject = String(e.subject || '').slice(0, 500);
    const plain = text || htmlText(html);
    const from = e.from ? { name: String(e.from.name || '').slice(0, 200), address: String(e.from.address || '').slice(0, 320) } : { name: '', address: '' };
    return {
      id: msgId(addrId, providerId), addrId, from, subject,
      to: (e.to || []).map((x) => String(x.address || '')).filter(Boolean).slice(0, 20),
      date: Date.parse(e.date || '') || Date.now(), receivedAt: Date.now(),
      text, html, code: findMailCode(subject, plain), snippet: plain.replace(/\s+/g, ' ').slice(0, 160), seen: false,
      attachments: (e.attachments || []).filter((a) => !a.contentId || a.disposition === 'attachment').map((a) => String(a.filename || 'attachment')).slice(0, 20),
    };
  }

  async function checkTemp() {
    let added = 0;
    for (const r of Object.values(addrs())) {
      if (r.mode !== 'temp' || r.state !== 'on' || !unlocked()) continue;
      const acct = { address: r.address, ...r.secret };
      let list;
      try { list = await temp().list(acct); } catch (e) {
        if ((e.code === 'auth' || e.code === 'gone') && !(await temp().alive(acct).catch(() => true))) { saveAddr({ ...r, state: 'expired' }); notify(); }
        continue;
      }
      if (acct.token !== r.secret.token) saveAddr({ ...r, secret: { ...r.secret, token: acct.token } });
      const fresh = [];
      for (const m of list.slice(0, 30)) {
        const id = msgId(r.id, m.id);
        if (store.has(id)) continue;
        try { fresh.push(await parse(await temp().raw(acct, m.id), r.id, m.id)); } catch (e) { log('temp message failed: ' + (e.code || e.name)); }
        await new Promise((res) => setTimeout(res, 150)); // well under mail.tm's 8 requests a second
      }
      added += store.add(fresh).length;
    }
    return added;
  }

  async function checkAlias() {
    const al = cfg().alias || {};
    if (!al.imap) return 0;
    const list = Object.values(addrs()).filter((r) => r.mode === 'alias').map((r) => ({ id: r.id, service: r.service, address: r.address, aliasId: r.secret.aliasId, created: r.created }));
    if (!list.length) return 0;
    const res = await IMAP.fetchAliasMail({ ...al.imap, tlsOptions: t.imapTls }, list, al.seen || {});
    const fresh = [];
    for (const m of res.messages) { try { fresh.push(await parse(m.raw, m.addrId, 'imap:' + res.seen.uidValidity + ':' + m.uid)); } catch (e) { log('alias message failed: ' + e.name); } }
    if (unlocked()) save({ alias: { ...(cfg().alias || {}), seen: res.seen } });
    return store.add(fresh).length;
  }

  async function checkDomain() {
    const d = cfg().domain;
    if (!d) return 0;
    const { ids } = await (await CF.worker(d.url, d.secret, 'GET', '/list')).json();
    const byAddress = new Map(Object.values(addrs()).filter((r) => r.mode === 'domain').map((r) => [r.address.toLowerCase(), r.id]));
    let added = 0;
    for (const id of (ids || []).slice(0, 50)) {
      if (!unlocked()) break;
      let box;
      try { box = Buffer.from(await (await CF.worker(d.url, d.secret, 'GET', '/m/' + encodeURIComponent(id))).arrayBuffer()); } catch (e) { if (e.code === 'gone') continue; throw e; }
      const raw = CF.openBox(d.privateJwk, box);
      const env = /^X-Vault-Envelope-To: ([^\r\n]*)\r\n/.exec(raw.subarray(0, 400).toString('latin1'));
      if (env && /^Subject: Vault test [a-f0-9]+\r\n/.test(raw.subarray(env[0].length, env[0].length + 80).toString('latin1'))) continue; // the Test button's own message
      const addrId = (env && byAddress.get(env[1].trim().toLowerCase())) || 'domain:' + (env ? env[1].trim().toLowerCase() : 'unknown');
      const m = await parse(env ? raw.subarray(env[0].length) : raw, addrId, 'cf:' + id);
      added += store.add([m]).length;
      // Only once it's saved here (encrypted) is it deleted from Cloudflare.
      if (store.has(m.id)) await CF.worker(d.url, d.secret, 'DELETE', '/m/' + encodeURIComponent(id));
    }
    return added;
  }

  const notify = () => send('mail', publicState());
  async function check(which = 'all') {
    if (!unlocked()) return { added: 0 };
    let added = 0; const errors = {};
    for (const [k, fn] of [['temp', checkTemp], ['alias', checkAlias], ['domain', checkDomain]]) {
      if (which !== 'all' && which !== k) continue;
      if (busy[k]) continue;
      busy[k] = true;
      try { added += await fn(); } catch (e) { errors[k] = e.code || e.name || 'failed'; log(k + ' check failed: ' + (e.code || e.name)); } finally { busy[k] = false; }
    }
    if (added) notify();
    return { added, errors };
  }

  function start() {
    stop();
    const s = cfg();
    if (Object.values(addrs()).some((r) => r.mode === 'temp' && r.state === 'on')) timers.push(setInterval(() => check('temp'), t.every.temp));
    if (s.alias && s.alias.imap) timers.push(setInterval(() => check('alias'), t.every.alias));
    if (s.domain) timers.push(setInterval(() => check('domain'), t.every.domain));
    timers.push(setTimeout(() => check('all'), 4000));
  }
  function stop() { for (const x of timers) { clearInterval(x); clearTimeout(x); } timers = []; }

  const summary = (m) => ({ id: m.id, addrId: m.addrId, from: m.from, subject: m.subject, date: m.date, receivedAt: m.receivedAt, code: m.code, snippet: m.snippet, seen: !!m.seen, hasHtml: !!m.html, attachments: m.attachments || [] });

  return {
    publicState, modesReady, setTemp, setAliasKey, setMailbox, cfZones, cfDeploy, cfTest, cfRemove,
    create, remove, setState, link, check,
    messages: () => (unlocked() ? store.list().slice().sort((a, b) => b.receivedAt - a.receivedAt).map(summary) : []),
    message: (id) => { const m = unlocked() && store.get(id); return m ? { ...summary(m), to: m.to, text: m.text, html: m.html } : null; },
    markSeen: (id) => (unlocked() ? store.update(id, { seen: true }) : false),
    deleteMessage: (id) => { if (unlocked()) store.remove((m) => m.id === id); return true; },
    // lifecycle
    onUnlock() { try { store.load(); } catch (e) { log('mail store unreadable: ' + e.name); } start(); },
    onLock() { stop(); store.lock(); cfPending = null; },
    rekey: (oldKey) => store.rekey(oldKey),
    reset: () => store.reset(),
    restart: start,
    _test: t, _store: store,
  };
};
