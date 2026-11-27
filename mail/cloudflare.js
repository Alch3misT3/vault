'use strict';
// Addresses on your own domain: Cloudflare Email Routing + a small Worker in your account
// (mail/worker.js). Vault uses your API token only for what the wizard asks you to allow:
//   Account: Workers Scripts Edit, Workers KV Storage Edit, Email Routing Addresses Read
//   Zone (your one domain): Email Routing Rules Edit, Zone Read, Zone Settings Read
// Endpoints: https://developers.cloudflare.com/api/ (zones, email_routing, workers scripts,
// subdomain, kv namespaces). The Worker is reached on its workers.dev address with a random secret.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ServiceError } = require('./providers');

const SCRIPT = 'vault-mail';
const KV_TITLE = 'vault-mail';
const COMPAT = '2025-09-01';

function client({ token, base = 'https://api.cloudflare.com/client/v4', timeout = 20000 }) {
  async function cf(method, p, body, extraHeaders) {
    let res;
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    try {
      res = await fetch(base + p, {
        method, signal: AbortSignal.timeout(timeout), redirect: 'error',
        headers: { Authorization: 'Bearer ' + token, ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}), ...(extraHeaders || {}) },
        body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
      });
    } catch (e) { throw new ServiceError(e && e.name === 'TimeoutError' ? 'timeout' : 'network', 0); }
    let j = null;
    try { j = await res.json(); } catch {}
    if (res.status === 401 || res.status === 403) throw new ServiceError('auth', res.status, cfMessage(j));
    if (res.status === 404) throw new ServiceError('gone', 404, cfMessage(j));
    if (!res.ok || (j && j.success === false)) throw new ServiceError('failed', res.status, cfMessage(j));
    return j ? j.result : null;
  }
  const cfMessage = (j) => (j && Array.isArray(j.errors) && j.errors[0] ? String(j.errors[0].message || '').slice(0, 200) : '');

  return {
    zones: async () => (await cf('GET', '/zones?per_page=50')).map((z) => ({ id: z.id, name: z.name, accountId: z.account && z.account.id, accountName: z.account && z.account.name })),
    routing: (zoneId) => cf('GET', `/zones/${zoneId}/email/routing`),
    addresses: (accountId) => cf('GET', `/accounts/${accountId}/email/routing/addresses?per_page=50`),
    async kvNamespace(accountId) {
      const list = await cf('GET', `/accounts/${accountId}/storage/kv/namespaces?per_page=100`);
      const found = (list || []).find((n) => n.title === KV_TITLE);
      if (found) return found.id;
      return (await cf('POST', `/accounts/${accountId}/storage/kv/namespaces`, { title: KV_TITLE })).id;
    },
    kvDelete: (accountId, id) => cf('DELETE', `/accounts/${accountId}/storage/kv/namespaces/${id}`),
    async putWorker(accountId, { kvId, publicJwk, secret, forwardTo }) {
      const code = fs.readFileSync(path.join(__dirname, 'worker.js'), 'utf8');
      const metadata = {
        main_module: 'worker.js', compatibility_date: COMPAT,
        bindings: [
          { type: 'kv_namespace', name: 'MAIL', namespace_id: kvId },
          { type: 'plain_text', name: 'PUBLIC_KEY', text: JSON.stringify(publicJwk) },
          { type: 'secret_text', name: 'FETCH_SECRET', text: secret },
          { type: 'plain_text', name: 'FORWARD_TO', text: forwardTo || '' },
        ],
      };
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
      form.append('worker.js', new Blob([code], { type: 'application/javascript+module' }), 'worker.js');
      await cf('PUT', `/accounts/${accountId}/workers/scripts/${SCRIPT}`, form);
      await cf('PUT', `/accounts/${accountId}/workers/scripts/${SCRIPT}/schedules`, [{ cron: '17 3 * * *' }]);
      await cf('POST', `/accounts/${accountId}/workers/scripts/${SCRIPT}/subdomain`, { enabled: true });
      const sub = await cf('GET', `/accounts/${accountId}/workers/subdomain`);
      if (!sub || !sub.subdomain) throw new ServiceError('no-subdomain', 0);
      return `https://${SCRIPT}.${sub.subdomain}.workers.dev`;
    },
    deleteWorker: (accountId) => cf('DELETE', `/accounts/${accountId}/workers/scripts/${SCRIPT}?force=true`),
    createRule: (zoneId, address) => cf('POST', `/zones/${zoneId}/email/routing/rules`, ruleBody(address, true)),
    setRule: (zoneId, ruleId, address, on) => cf('PUT', `/zones/${zoneId}/email/routing/rules/${ruleId}`, ruleBody(address, on)),
    deleteRule: (zoneId, ruleId) => cf('DELETE', `/zones/${zoneId}/email/routing/rules/${ruleId}`),
  };
}

// One rule per address: exactly that address, sent to the Worker. Never a catch-all.
const ruleBody = (address, enabled) => ({
  name: 'Vault: ' + address, enabled: !!enabled,
  matchers: [{ type: 'literal', field: 'to', value: address }],
  actions: [{ type: 'worker', value: [SCRIPT] }],
});

// ---- the Worker's own API (on its workers.dev address) ----
async function worker(url, secret, method, p, timeout = 20000) {
  let res;
  try { res = await fetch(url + p, { method, headers: { Authorization: 'Bearer ' + secret }, signal: AbortSignal.timeout(timeout), redirect: 'error' }); }
  catch (e) { throw new ServiceError(e && e.name === 'TimeoutError' ? 'timeout' : 'network', 0); }
  if (res.status === 401) throw new ServiceError('auth', 401);
  if (res.status === 404) throw new ServiceError('gone', 404);
  if (!res.ok) throw new ServiceError('failed', res.status);
  return res;
}

// ---- keys: the Worker gets the public key, Vault keeps the private one in the vault ----
function newKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pub = publicKey.export({ format: 'jwk' });
  return { publicJwk: { kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y }, privateJwk: privateKey.export({ format: 'jwk' }) };
}
const INFO = Buffer.from('vault-mail-v1');
// Box: [1][ephemeral public key 65][IV 12][ciphertext + tag 16] (see worker.js)
function openBox(privateJwk, box) {
  box = Buffer.from(box);
  if (box.length < 1 + 65 + 12 + 16 || box[0] !== 1) throw new Error('bad box');
  const epk = box.subarray(1, 66);
  const iv = box.subarray(66, 78);
  const ct = box.subarray(78, box.length - 16);
  const tag = box.subarray(box.length - 16);
  const ephPub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: epk.subarray(1, 33).toString('base64url'), y: epk.subarray(33, 65).toString('base64url') }, format: 'jwk' });
  const priv = crypto.createPrivateKey({ key: privateJwk, format: 'jwk' });
  const shared = crypto.diffieHellman({ privateKey: priv, publicKey: ephPub });
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, epk, INFO, 32));
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

module.exports = { client, worker, newKeys, openBox, SCRIPT, ruleBody };
