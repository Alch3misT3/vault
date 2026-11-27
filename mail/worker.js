// Vault mail Worker: runs in YOUR Cloudflare account, deployed there by Vault.
//
// Cloudflare Email Routing sends every address Vault made on your domain to this Worker (one exact
// routing rule per address, never a catch-all). For each message it:
//   1. encrypts the raw message at once with Vault's PUBLIC key (ECDH P-256 + HKDF-SHA-256 +
//      AES-256-GCM); only Vault, holding the private key, can read it,
//   2. stores only that ciphertext in Workers KV, set to expire after 7 days,
//   3. if you asked for copies, also forwards the message to your own (verified) address.
// Vault fetches the ciphertexts with a random secret, decrypts them on your PC and deletes them here.
// A daily run deletes anything older than 7 days, in case KV's own expiry hasn't yet.
// Bindings: MAIL (KV namespace), PUBLIC_KEY (JWK, text), FETCH_SECRET (secret), FORWARD_TO (text, may be empty).

const KEEP_SECONDS = 7 * 24 * 3600;
const MAX_RAW = 25 * 1024 * 1024 - 4096; // KV values are at most 25 MiB, with room for the envelope
const INFO = new TextEncoder().encode('vault-mail-v1');
const ID = /^m:[0-9a-z]{9,12}-[0-9a-f]{16}$/;

// Box layout: [1][ephemeral public key, 65 bytes][IV, 12 bytes][AES-GCM ciphertext + 16-byte tag]
async function seal(publicJwk, plain) {
  const recipient = await crypto.subtle.importKey('jwk', JSON.parse(publicJwk), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: recipient }, eph.privateKey, 256);
  const epk = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const hk = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: epk, info: INFO }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  const box = new Uint8Array(1 + epk.length + iv.length + ct.length);
  box[0] = 1; box.set(epk, 1); box.set(iv, 66); box.set(ct, 78);
  return box;
}

function newId(now) {
  const rnd = crypto.getRandomValues(new Uint8Array(8));
  return 'm:' + now.toString(36).padStart(9, '0') + '-' + [...rnd].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function store(env, plain, now) {
  const box = await seal(env.PUBLIC_KEY, plain);
  await env.MAIL.put(newId(now), box, { expirationTtl: KEEP_SECONDS, metadata: { t: now } });
}

// Constant-time check of "Authorization: Bearer <secret>" (both sides hashed to the same length first).
async function authorized(request, env) {
  const got = (request.headers.get('Authorization') || '').replace(/^Bearer /, '');
  if (!got || !env.FETCH_SECRET) return false;
  const te = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', te.encode(got)), crypto.subtle.digest('SHA-256', te.encode(env.FETCH_SECRET))]);
  return crypto.subtle.timingSafeEqual(a, b);
}

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export default {
  async email(message, env) {
    const now = Date.now();
    const to = String(message.to).replace(/[\r\n]/g, '');
    // Vault learns which of its addresses a message was for from this first line (the envelope recipient).
    const head = new TextEncoder().encode('X-Vault-Envelope-To: ' + to + '\r\n');
    let raw;
    if (message.rawSize > MAX_RAW) {
      raw = new TextEncoder().encode(`Subject: A message was too large for Vault\r\nFrom: Vault <vault@localhost>\r\nTo: ${to}\r\nDate: ${new Date(now).toUTCString()}\r\nMessage-ID: <too-large-${now}@vault.localhost>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nA message from ${String(message.from).replace(/[\r\n]/g, '')} (${Math.round(message.rawSize / 1048576)} MB) arrived but was too large to keep.\r\n`);
    } else {
      raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
    }
    const all = new Uint8Array(head.length + raw.length);
    all.set(head); all.set(raw, head.length);
    await store(env, all, now);
    if (env.FORWARD_TO) {
      try { await message.forward(env.FORWARD_TO); } catch (e) { /* the copy failed; Vault still has the message */ }
    }
  },

  async fetch(request, env) {
    if (!(await authorized(request, env))) return json({ error: 'unauthorized' }, 401);
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/list') {
      const r = await env.MAIL.list({ prefix: 'm:', limit: 100 });
      return json({ ids: r.keys.map((k) => k.name), expires: r.keys.map((k) => k.expiration || null) });
    }
    const m = /^\/m\/(.+)$/.exec(url.pathname);
    if (m && ID.test(decodeURIComponent(m[1]))) {
      const id = decodeURIComponent(m[1]);
      if (request.method === 'GET') {
        const box = await env.MAIL.get(id, 'arrayBuffer');
        return box ? new Response(box, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' } }) : json({ error: 'gone' }, 404);
      }
      if (request.method === 'DELETE') { await env.MAIL.delete(id); return json({ ok: true }); }
    }
    if (request.method === 'POST' && url.pathname === '/selftest') {
      const now = Date.now();
      const nonce = url.searchParams.get('nonce') || '';
      if (!/^[a-f0-9]{16,64}$/.test(nonce)) return json({ error: 'nonce' }, 400);
      const msg = `Subject: Vault test ${nonce}\r\nFrom: Vault <vault@localhost>\r\nTo: test@vault.localhost\r\nDate: ${new Date(now).toUTCString()}\r\nMessage-ID: <test-${nonce}@vault.localhost>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nVault test ${nonce}\r\n`;
      await store(env, new TextEncoder().encode(msg), now);
      return json({ ok: true });
    }
    return json({ error: 'not found' }, 404);
  },

  // Daily: delete anything older than 7 days (KV's own expiry normally does this first).
  async scheduled(controller, env) {
    const cutoff = controller.scheduledTime - KEEP_SECONDS * 1000;
    let cursor;
    do {
      const r = await env.MAIL.list({ prefix: 'm:', cursor });
      for (const k of r.keys) if (!k.metadata || typeof k.metadata.t !== 'number' || k.metadata.t < cutoff) await env.MAIL.delete(k.name);
      cursor = r.list_complete ? undefined : r.cursor;
    } while (cursor);
  },
};
