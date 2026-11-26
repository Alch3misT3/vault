'use strict';
// Runs in the web page itself (MAIN world), before the page's own scripts.
// Hands navigator.credentials.create()/get() for passkeys to Vault, which asks the user and signs
// inside the app. If the user picks "Use Another Device" (or Vault has nothing for this site, or isn't
// running), the browser's own passkey flow runs exactly as if Vault weren't here.
(() => {
  if (!window.isSecureContext || window !== window.top || !window.PublicKeyCredential || !navigator.credentials) return;
  const C = navigator.credentials;
  const realCreate = C.create.bind(C);
  const realGet = C.get.bind(C);

  const bytes = (x) => (x instanceof ArrayBuffer ? new Uint8Array(x) : new Uint8Array(x.buffer, x.byteOffset, x.byteLength));
  const b64u = (x) => { let s = ''; for (const c of bytes(x)) s += String.fromCharCode(c); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  const unb64u = (s) => {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  };
  const creds = (list) => (Array.isArray(list) ? list.map((c) => ({ type: c.type, id: b64u(c.id), transports: c.transports })) : []);

  function createJSON(pk) {
    return {
      rp: { id: pk.rp.id, name: pk.rp.name },
      user: { id: b64u(pk.user.id), name: pk.user.name, displayName: pk.user.displayName },
      challenge: b64u(pk.challenge),
      pubKeyCredParams: (pk.pubKeyCredParams || []).map((p) => ({ type: p.type, alg: p.alg })),
      excludeCredentials: creds(pk.excludeCredentials),
      authenticatorSelection: pk.authenticatorSelection ? { ...pk.authenticatorSelection } : undefined,
      attestation: pk.attestation,
      extensions: pk.extensions ? { credProps: !!pk.extensions.credProps } : undefined,
    };
  }
  function getJSON(pk) {
    return { challenge: b64u(pk.challenge), rpId: pk.rpId, allowCredentials: creds(pk.allowCredentials), userVerification: pk.userVerification };
  }

  // A response object that behaves like the browser's own PublicKeyCredential.
  function credential(j, op) {
    const r = j.response;
    let resp;
    if (op === 'create') {
      resp = Object.create(AuthenticatorAttestationResponse.prototype);
      const cd = unb64u(r.clientDataJSON); const att = unb64u(r.attestationObject); const ad = unb64u(r.authenticatorData); const pub = unb64u(r.publicKey);
      Object.defineProperties(resp, {
        clientDataJSON: { value: cd, enumerable: true }, attestationObject: { value: att, enumerable: true },
        getTransports: { value: () => r.transports.slice() }, getAuthenticatorData: { value: () => ad.slice(0) },
        getPublicKey: { value: () => pub.slice(0) }, getPublicKeyAlgorithm: { value: () => r.publicKeyAlgorithm },
      });
    } else {
      resp = Object.create(AuthenticatorAssertionResponse.prototype);
      Object.defineProperties(resp, {
        clientDataJSON: { value: unb64u(r.clientDataJSON), enumerable: true }, authenticatorData: { value: unb64u(r.authenticatorData), enumerable: true },
        signature: { value: unb64u(r.signature), enumerable: true }, userHandle: { value: r.userHandle ? unb64u(r.userHandle) : null, enumerable: true },
      });
    }
    const json = () => ({
      id: j.id, rawId: j.rawId, type: 'public-key', authenticatorAttachment: j.authenticatorAttachment,
      response: { ...r }, clientExtensionResults: JSON.parse(JSON.stringify(j.clientExtensionResults || {})),
    });
    const cred = Object.create(PublicKeyCredential.prototype);
    Object.defineProperties(cred, {
      id: { value: j.id, enumerable: true }, rawId: { value: unb64u(j.rawId), enumerable: true }, type: { value: 'public-key', enumerable: true },
      response: { value: resp, enumerable: true }, authenticatorAttachment: { value: j.authenticatorAttachment, enumerable: true },
      getClientExtensionResults: { value: () => JSON.parse(JSON.stringify(j.clientExtensionResults || {})) },
      toJSON: { value: json },
    });
    return cred;
  }

  let seq = 0;
  function askVault(op, options, signal) {
    return new Promise((resolve) => {
      const requestId = Date.now().toString(36) + Math.random().toString(36).slice(2) + (++seq);
      const done = (result) => { window.removeEventListener('message', onReply); resolve(result); };
      const onReply = (e) => {
        if (e.source !== window || !e.data || e.data.__vaultPasskey !== 'reply' || e.data.requestId !== requestId) return;
        done(e.data.result);
      };
      window.addEventListener('message', onReply);
      if (signal) signal.addEventListener('abort', () => { window.postMessage({ __vaultPasskey: 'cancel', requestId }, location.origin); done({ error: 'AbortError', message: 'The operation was aborted.' }); }, { once: true });
      window.postMessage({ __vaultPasskey: 'request', requestId, op, options }, location.origin);
    });
  }

  // The browser's own flow needs the page focused again (Vault's window had it). Windows usually hands
  // focus back when Vault's window closes; otherwise it starts as soon as you click the page.
  const focused = () => new Promise((resolve) => {
    if (document.hasFocus()) return resolve();
    const done = () => { clearInterval(poll); clearTimeout(give); window.removeEventListener('focus', done); resolve(); };
    const poll = setInterval(() => { if (document.hasFocus()) done(); }, 250);
    const give = setTimeout(done, 120000);
    window.addEventListener('focus', done);
  });

  async function run(op, options) {
    const real = op === 'create' ? realCreate : realGet;
    const pk = options.publicKey;
    if (options.signal && options.signal.aborted) return real(options);
    if (op === 'get' && options.mediation === 'conditional') return real(options); // the browser's autofill list
    let json;
    try { json = op === 'create' ? createJSON(pk) : getJSON(pk); } catch { return real(options); }
    const res = await askVault(op, json, options.signal);
    if (!res || res.fallback) { await focused(); return real(options); }
    if (res.error) throw new DOMException(res.message || 'The operation either timed out or was not allowed.', res.error);
    return credential(res.credential, op);
  }

  const create = function create(options) { return options && options.publicKey ? run('create', options) : realCreate(options); };
  const get = function get(options) { return options && options.publicKey ? run('get', options) : realGet(options); };
  Object.defineProperty(C, 'create', { value: create, configurable: true, writable: true });
  Object.defineProperty(C, 'get', { value: get, configurable: true, writable: true });
})();
