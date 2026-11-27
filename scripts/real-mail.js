'use strict';
// Optional checks against the REAL services (never part of a normal smoke run):
//   VAULT_REAL_MAIL=1 npx electron . --smoke
// mail.tm needs nothing. The others run only when their keys are given:
//   VAULT_REAL_SIMPLELOGIN_KEY, VAULT_REAL_ADDY_KEY, VAULT_REAL_RELAY_KEY      make, switch off/on and delete one alias
//   VAULT_REAL_IMAP_HOST, VAULT_REAL_IMAP_USER, VAULT_REAL_IMAP_PASS           log in read-only and open the inbox
//   VAULT_REAL_CF_TOKEN (+ VAULT_REAL_CF_DEPLOY=1 to deploy, test and remove the Worker and one rule)
// Keys are read from the environment only and never printed.

const crypto = require('crypto');
const { mailTm, ALIAS_SERVICES } = require('../mail/providers');
const IMAP = require('../mail/imap');
const CF = require('../mail/cloudflare');

module.exports = async function realMail({ check }) {
  const env = process.env;
  const step = async (name, fn) => { try { const d = await fn(); check('REAL ' + name, true, d || ''); } catch (e) { check('REAL ' + name, false, (e && (e.code || e.message)) || 'failed'); } };

  await step('mail.tm: make an inbox, read it, delete it', async () => {
    const tm = mailTm();
    const a = await tm.create();
    const list = await tm.list(a);
    if (!(await tm.alive(a))) throw new Error('not alive');
    await tm.remove(a);
    if (await tm.alive(a)) throw new Error('still there after delete');
    return `${a.address.replace(/^[^@]+/, '…')} · ${list.length} messages`;
  });

  for (const [id, key] of [['simplelogin', env.VAULT_REAL_SIMPLELOGIN_KEY], ['addy', env.VAULT_REAL_ADDY_KEY], ['relay', env.VAULT_REAL_RELAY_KEY]]) {
    if (!key) continue;
    await step(`${id}: verify, make, switch off and on, delete an alias`, async () => {
      const s = ALIAS_SERVICES[id]({ key });
      await s.verify();
      const a = await s.create('Vault test', 'vault-test.example');
      try {
        if ((await s.setEnabled(a, false)) !== false) throw new Error('still on');
        if ((await s.setEnabled(a, true)) !== true) throw new Error('still off');
      } finally { await s.remove(a); }
      return a.address.replace(/^[^@]+/, '…');
    });
  }

  if (env.VAULT_REAL_IMAP_HOST && env.VAULT_REAL_IMAP_USER && env.VAULT_REAL_IMAP_PASS) {
    await step('IMAP: TLS login and read-only inbox', async () => {
      const r = await IMAP.testMailbox({ host: env.VAULT_REAL_IMAP_HOST, port: Number(env.VAULT_REAL_IMAP_PORT) || 993, user: env.VAULT_REAL_IMAP_USER, pass: env.VAULT_REAL_IMAP_PASS });
      return `${r.exists} messages in INBOX (none read)`;
    });
  }

  if (env.VAULT_REAL_CF_TOKEN) {
    const api = CF.client({ token: env.VAULT_REAL_CF_TOKEN });
    let zone = null;
    await step('Cloudflare: token sees a zone, Email Routing is on', async () => {
      const zones = await api.zones();
      zone = zones.find((z) => !env.VAULT_REAL_CF_ZONE || z.name === env.VAULT_REAL_CF_ZONE) || null;
      if (!zone) throw new Error('no zone');
      const r = await api.routing(zone.id);
      if (!r || !r.enabled) throw new Error('Email Routing is off');
      return zone.name;
    });
    if (zone && env.VAULT_REAL_CF_DEPLOY) {
      await step('Cloudflare: deploy the Worker, round trip, one rule, remove everything', async () => {
        const keys = CF.newKeys();
        const secret = crypto.randomBytes(32).toString('base64url');
        const kvId = await api.kvNamespace(zone.accountId);
        const url = await api.putWorker(zone.accountId, { kvId, publicJwk: keys.publicJwk, secret, forwardTo: '' });
        try {
          let ready = false;
          for (let i = 0; i < 30 && !ready; i++) { try { const r = await fetch(url + '/list'); ready = r.status === 401; } catch {} if (!ready) await new Promise((r) => setTimeout(r, 2000)); }
          if (!ready) throw new Error('Worker not reachable');
          const nonce = crypto.randomBytes(16).toString('hex');
          await CF.worker(url, secret, 'POST', '/selftest?nonce=' + nonce);
          const { ids } = await (await CF.worker(url, secret, 'GET', '/list')).json();
          const box = Buffer.from(await (await CF.worker(url, secret, 'GET', '/m/' + encodeURIComponent(ids[0]))).arrayBuffer());
          if (!CF.openBox(keys.privateJwk, box).toString('utf8').includes(nonce)) throw new Error('round trip');
          await CF.worker(url, secret, 'DELETE', '/m/' + encodeURIComponent(ids[0]));
          const rule = await api.createRule(zone.id, `vaulttest.${crypto.randomBytes(3).toString('hex')}@${zone.name}`);
          await api.deleteRule(zone.id, rule.id);
        } finally {
          await api.deleteWorker(zone.accountId).catch(() => {});
          await api.kvDelete(zone.accountId, kvId).catch(() => {});
        }
        return 'ok';
      });
    }
  }
};
