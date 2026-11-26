'use strict';
// Vault as a passkey provider for websites (WebAuthn authenticator in software).
//
// - Keys are ES256 (P-256). The private key is made here, stored encrypted in the vault, and never
//   leaves this process: the browser extension only receives the finished WebAuthn response.
// - The page's origin comes from the browser (the extension reads it from the browser's own
//   record of which tab sent the request), never from the page. It must be https, and the rpId must
//   be that host or a parent domain of it that isn't a public suffix (Public Suffix List).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------- Public Suffix List ----------
let PSL = null;
function psl() {
  if (PSL) return PSL;
  const rules = fs.readFileSync(path.join(__dirname, 'psl.txt'), 'utf8').split('\n').filter((l) => l && !l.startsWith('//'));
  PSL = { exact: new Set(), wild: new Set(), except: new Set() };
  for (const r of rules) {
    if (r.startsWith('!')) PSL.except.add(r.slice(1));
    else if (r.startsWith('*.')) PSL.wild.add(r.slice(2));
    else PSL.exact.add(r);
  }
  return PSL;
}
// The public suffix of a host (e.g. "co.uk", "github.io"), by the standard algorithm.
function publicSuffix(host) {
  const L = psl();
  const labels = host.split('.');
  let best = labels[labels.length - 1]; // default rule "*"
  for (let i = labels.length - 1; i >= 0; i--) {
    const cand = labels.slice(i).join('.');
    if (L.except.has(cand)) return labels.slice(i + 1).join('.');
    if (L.exact.has(cand)) best = cand;
    const parent = labels.slice(i + 1).join('.');
    if (i < labels.length - 1 && L.wild.has(parent)) best = cand;
  }
  return best;
}

const isIp = (h) => /^\d+(\.\d+){3}$/.test(h) || h.includes(':') || h.startsWith('[');
// Is `rpId` allowed for a page at `origin`? (WebAuthn's rule, made strict: https only, no IPs.)
function checkRp(origin, rpId) {
  let u;
  try { u = new URL(origin); } catch { return { ok: false, why: 'origin' }; }
  if (u.protocol !== 'https:' || u.origin !== origin) return { ok: false, why: 'https' };
  const host = u.hostname.toLowerCase();
  if (isIp(host) || !host.includes('.')) return { ok: false, why: 'host' };
  const rp = String(rpId == null ? host : rpId).toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(rp) || rp.startsWith('.') || rp.endsWith('.')) return { ok: false, why: 'rpid' };
  if (!(host === rp || host.endsWith('.' + rp))) return { ok: false, why: 'not-parent' };
  if (publicSuffix(rp) === rp) return { ok: false, why: 'public-suffix' };
  return { ok: true, host, rpId: rp };
}

// ---------- encoding helpers ----------
const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

// Minimal CBOR encoder (maps, ints, byte and text strings) for attestation objects and COSE keys.
function cbor(v) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
  };
  if (Number.isInteger(v)) return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, b.length), b]); }
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('cbor type');
}

// Flags: UP (user present), UV (user verified: Vault is unlocked and the user confirmed),
// BE + BS (backup eligible / backed up: the passkey lives in the vault file and its backups).
const FLAGS = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40 };
// Vault's own authenticator id (AAGUID). Not all zeros: sites read that as Apple's iCloud Keychain.
const AAGUID = Buffer.from('579acacd24d8439e91e2192c530972bb', 'hex');

function authData(rpId, flags, counter, attested) {
  const c = Buffer.alloc(4); c.writeUInt32BE(counter >>> 0);
  return Buffer.concat([sha256(Buffer.from(rpId)), Buffer.from([flags]), c, attested || Buffer.alloc(0)]);
}
// Same member order as browsers write it.
function clientData(type, challenge, origin) {
  return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), 'utf8');
}

const validChallenge = (c) => typeof c === 'string' && /^[A-Za-z0-9_-]{16,1400}$/.test(c);

// ---------- registration ----------
// options: the page's PublicKeyCredentialCreationOptions, with binary fields as base64url.
function parseCreate(options) {
  const o = options || {};
  if (!o.rp || !o.user || !validChallenge(o.challenge)) return { error: 'TypeError' };
  const userId = unb64u(o.user.id || '');
  if (!userId.length || userId.length > 64) return { error: 'TypeError' };
  const algs = Array.isArray(o.pubKeyCredParams) ? o.pubKeyCredParams.map((p) => p && p.alg) : [];
  return {
    rpId: o.rp.id, rpName: String(o.rp.name || '').slice(0, 120),
    user: { id: b64u(userId), name: String(o.user.name || '').slice(0, 200), displayName: String(o.user.displayName || '').slice(0, 200) },
    challenge: o.challenge,
    es256: algs.length === 0 || algs.includes(-7), // an empty list means "the defaults", which include ES256
    exclude: Array.isArray(o.excludeCredentials) ? o.excludeCredentials.map((c) => c && c.id).filter((x) => typeof x === 'string') : [],
    credProps: !!(o.extensions && o.extensions.credProps),
  };
}

function makeCredential({ rpId, origin, user, challenge, credProps }) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credId = crypto.randomBytes(32);
  const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
  const idLen = Buffer.alloc(2); idLen.writeUInt16BE(credId.length);
  const ad = authData(rpId, FLAGS.UP | FLAGS.UV | FLAGS.BE | FLAGS.BS | FLAGS.AT, 0, Buffer.concat([AAGUID, idLen, credId, cose]));
  const att = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', ad]]));
  const cd = clientData('webauthn.create', challenge, origin);
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const entry = {
    kind: 'passkey', id: crypto.randomUUID(), rpId, userName: user.name, displayName: user.displayName, userHandle: user.id,
    credentialId: b64u(credId), privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    alg: -7, signCount: 0, created: Date.now(), lastUsed: null, origin,
  };
  const response = {
    type: 'public-key', id: b64u(credId), rawId: b64u(credId), authenticatorAttachment: 'platform',
    response: {
      clientDataJSON: b64u(cd), attestationObject: b64u(att), authenticatorData: b64u(ad),
      publicKey: b64u(spki), publicKeyAlgorithm: -7, transports: ['internal', 'hybrid'],
    },
    clientExtensionResults: credProps ? { credProps: { rk: true } } : {},
  };
  return { entry, response };
}

// ---------- authentication ----------
function parseGet(options) {
  const o = options || {};
  if (!validChallenge(o.challenge)) return { error: 'TypeError' };
  return {
    rpId: o.rpId, challenge: o.challenge,
    allow: Array.isArray(o.allowCredentials) ? o.allowCredentials.map((c) => c && c.id).filter((x) => typeof x === 'string') : [],
  };
}

function getAssertion(entry, { origin, challenge }) {
  const counter = (entry.signCount || 0) + 1;
  const ad = authData(entry.rpId, FLAGS.UP | FLAGS.UV | FLAGS.BE | FLAGS.BS, counter);
  const cd = clientData('webauthn.get', challenge, origin);
  const key = crypto.createPrivateKey({ key: Buffer.from(entry.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  const signature = crypto.sign('sha256', Buffer.concat([ad, sha256(cd)]), key); // DER-encoded ECDSA, as WebAuthn wants
  return {
    counter,
    response: {
      type: 'public-key', id: entry.credentialId, rawId: entry.credentialId, authenticatorAttachment: 'platform',
      response: { clientDataJSON: b64u(cd), authenticatorData: b64u(ad), signature: b64u(signature), userHandle: entry.userHandle },
      clientExtensionResults: {},
    },
  };
}

module.exports = { checkRp, publicSuffix, parseCreate, makeCredential, parseGet, getAssertion, cbor, b64u, unb64u, FLAGS, AAGUID };
