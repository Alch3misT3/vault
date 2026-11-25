'use strict';
// Verification codes (TOTP, RFC 6238): the 6-digit codes authenticator apps show.
// Shared by the window (Web Crypto) and the main process (Node crypto), which pass in their own HMAC.
(function (root) {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  function base32(text) {
    const s = String(text).toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
    if (s.length < 8 || /[^A-Z2-7]/.test(s)) return null;
    const out = [];
    let bits = 0, acc = 0;
    for (const ch of s) {
      acc = (acc << 5) | B32.indexOf(ch);
      bits += 5;
      if (bits >= 8) { bits -= 8; out.push((acc >>> bits) & 255); }
    }
    return out.length >= 5 ? new Uint8Array(out) : null;
  }

  // Accepts a bare setup key ("JBSW Y3DP EHPK 3PXP") or an otpauth://totp/… link.
  function parse(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    let cfg = { secret: null, algorithm: 'SHA1', digits: 6, period: 30, issuer: '', account: '' };
    if (/^otpauth:\/\//i.test(raw)) {
      let u;
      try { u = new URL(raw); } catch { return null; }
      if (u.host.toLowerCase() !== 'totp') return null;
      const p = u.searchParams;
      const label = decodeURIComponent(u.pathname.replace(/^\//, ''));
      const [iss, acct] = label.includes(':') ? label.split(/:(.*)/s) : ['', label];
      cfg.secret = base32(p.get('secret') || '');
      cfg.algorithm = String(p.get('algorithm') || 'SHA1').toUpperCase().replace('-', '');
      cfg.digits = Number(p.get('digits')) || 6;
      cfg.period = Number(p.get('period')) || 30;
      cfg.issuer = (p.get('issuer') || iss || '').trim();
      cfg.account = (acct || '').trim();
    } else {
      cfg.secret = base32(raw);
    }
    if (!cfg.secret || !['SHA1', 'SHA256', 'SHA512'].includes(cfg.algorithm)) return null;
    if (![6, 7, 8].includes(cfg.digits) || cfg.period < 10 || cfg.period > 300) return null;
    return cfg;
  }

  // hmac(algorithm 'SHA1'|'SHA256'|'SHA512', key Uint8Array, message Uint8Array) -> Promise<Uint8Array> or Uint8Array
  async function code(cfg, hmac, now = Date.now()) {
    const counter = Math.floor(now / 1000 / cfg.period);
    const msg = new Uint8Array(8);
    let c = counter;
    for (let i = 7; i >= 0; i--) { msg[i] = c & 255; c = Math.floor(c / 256); }
    const mac = await hmac(cfg.algorithm, cfg.secret, msg);
    const o = mac[mac.length - 1] & 15;
    const bin = ((mac[o] & 127) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3];
    return String(bin % 10 ** cfg.digits).padStart(cfg.digits, '0');
  }

  const remaining = (cfg, now = Date.now()) => cfg.period - (Math.floor(now / 1000) % cfg.period);
  const pretty = (c) => (c.length === 6 ? c.slice(0, 3) + ' ' + c.slice(3) : c.length === 8 ? c.slice(0, 4) + ' ' + c.slice(4) : c);

  // A field holds a verification-code setup key if marked so, or if an imported 2FA field parses.
  const isOtpField = (f) => !!f && (f.kind === 'otp' || (/otp|2fa|one-time|authenticator|verification/i.test(f.label || '') && !!parse(f.value)));
  const otpField = (item) => (item && item.fields || []).find(isOtpField) || null;

  root.otp = { parse, code, remaining, pretty, isOtpField, otpField };
})(typeof window !== 'undefined' ? window : module.exports);
