'use strict';
// Vault file format and crypto (pure Node; used by main.js).
//
// Version 2 (current):
//   A random 256-bit vault key K encrypts the data (AES-256-GCM). K itself is stored wrapped:
//   - once by the master-password key: scrypt(password, salt) -> 256-bit key -> AES-256-GCM(K)
//   - once per enrolled passkey: HKDF-SHA256(WebAuthn PRF output, salt) -> 256-bit key -> AES-256-GCM(K)
//   Every box has a fresh random 96-bit nonce, a full 128-bit tag, and associated data that ties it
//   to its role, so boxes can't be swapped around.
//
// Version 1 (Vault 1.0–1.3): the scrypt key encrypted the data directly. Still opened; on the
// first password unlock it is converted to version 2 (the old file is kept as a backup).

const crypto = require('crypto');

const KDF = { N: 2 ** 18, r: 8, p: 1 };        // 256 MiB: twice OWASP's minimum for scrypt
const MAXMEM = 600 * 1024 * 1024;
const MIN_KDF = { N: 2 ** 14, r: 8, p: 1 };     // refuse files that claim a uselessly weak setting
const AAD = {
  data: 'vault:data:v2',
  password: 'vault:key:v2:password',
  passkey: (id) => 'vault:key:v2:passkey:' + id,
};
const PRF_INFO = Buffer.from('vault-passkey-unlock-v1');

const b64 = (b) => Buffer.from(b).toString('base64');
const unb64 = (s) => Buffer.from(String(s), 'base64');

function deriveKey(password, salt, params = KDF) {
  if (!(params.N >= MIN_KDF.N && params.r >= 1 && params.p >= 1 && params.N <= 2 ** 20 && params.r <= 32 && params.p <= 4)) {
    return Promise.reject(new Error('bad kdf'));
  }
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password).normalize('NFKC'), salt, 32, { N: params.N, r: params.r, p: params.p, maxmem: MAXMEM },
      (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function seal(key, plain, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  if (aad) c.setAAD(Buffer.from(aad));
  const data = Buffer.concat([c.update(plain), c.final()]);
  return { iv: b64(iv), tag: b64(c.getAuthTag()), data: b64(data) };
}

function open(key, box, aad) {
  const iv = unb64(box.iv);
  const tag = unb64(box.tag);
  // A full 16-byte tag, always: a shortened tag would be easier to forge.
  if (iv.length !== 12 || tag.length !== 16) throw new Error('bad box');
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  if (aad) d.setAAD(Buffer.from(aad));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(unb64(box.data)), d.final()]);
}

const sealJson = (key, obj, aad) => seal(key, Buffer.from(JSON.stringify(obj), 'utf8'), aad);
const openJson = (key, box, aad) => JSON.parse(open(key, box, aad).toString('utf8'));

const kdfOf = (file) => ({ N: file.kdf.N, r: file.kdf.r, p: file.kdf.p });

// ---- version 2 ----------------------------------------------------------------
// keys: { K, pwKey, salt, kdf } -> a fresh file around `payload`, keeping the passkey wraps in `passkeys`.
function buildV2({ K, pwKey, salt, kdf, passkeys, payload, passwordBox }) {
  return {
    app: 'vault', version: 2,
    kdf: { name: 'scrypt', N: kdf.N, r: kdf.r, p: kdf.p, salt: b64(salt) },
    keys: {
      password: passwordBox || seal(pwKey, K, AAD.password),
      passkeys: passkeys || [],
    },
    cipher: 'aes-256-gcm',
    ...sealJson(K, payload, AAD.data),
  };
}

// Unwrap K with the password key; throws if the password is wrong (GCM tag).
const unwrapWithPassword = (file, pwKey) => open(pwKey, file.keys.password, AAD.password);

const prfKek = (prf, salt) => Buffer.from(crypto.hkdfSync('sha256', prf, salt, PRF_INFO, 32));

function passkeyEntry({ id, name, transports, salt, prf, K }) {
  const kek = prfKek(prf, salt);
  try {
    return { id, name, added: Date.now(), transports: transports || [], salt: b64(salt), ...seal(kek, K, AAD.passkey(id)) };
  } finally { kek.fill(0); }
}
function unwrapWithPasskey(entry, prf) {
  const kek = prfKek(prf, unb64(entry.salt));
  try { return open(kek, entry, AAD.passkey(entry.id)); } finally { kek.fill(0); }
}

const readPayload = (file, K) => openJson(K, file, AAD.data);

// ---- version 1 ----------------------------------------------------------------
const readV1 = (file, key) => openJson(key, file, null);

module.exports = {
  KDF, deriveKey, seal, open, sealJson, openJson, kdfOf, buildV2, unwrapWithPassword, passkeyEntry, unwrapWithPasskey,
  readPayload, readV1, prfKek, AAD, b64, unb64,
};
