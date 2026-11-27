'use strict';
// A small, read-only IMAP client (RFC 9051 / 3501 subset) for the mailbox your alias service forwards to.
//
// - TLS only (port 993, certificate checked); never plain text, never STARTTLS downgrades.
// - The mailbox is opened with EXAMINE (read-only): nothing is marked read, moved or deleted.
// - The server itself searches for messages that carry one of Vault's alias addresses in the header
//   each alias service uses (SimpleLogin: X-SimpleLogin-Envelope-To; addy.io: Feedback-ID with the
//   alias id; Firefox Relay: the mask in From). Vault fetches those header lines first, checks the
//   match exactly, and only then downloads those messages (BODY.PEEK, so they stay unread).
//   Nothing else in the mailbox is downloaded or shown.

const tls = require('tls');
const net = require('net');

const TIMEOUT = 20000;
const MAX_MESSAGE = 25 * 1024 * 1024;

class ImapError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

// Quoted string, or null when it needs a literal (non-ASCII, quotes are fine, line breaks are not).
function quoted(s) {
  s = String(s);
  if (/[\r\n\0]/.test(s) || /[^\x20-\x7e]/.test(s)) return null;
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function connect({ host, port = 993, user, pass, tlsOptions = {}, timeout = TIMEOUT, log }) {
  return new Promise((resolve, reject) => {
    if (!host || !user || !pass) return reject(new ImapError('setup', 'Missing server, user or password'));
    // Certificates are checked against the usual public roots and this PC's own trusted roots (like a browser).
    const ca = typeof tls.getCACertificates === 'function' ? [...tls.getCACertificates('default'), ...tls.getCACertificates('system')] : undefined;
    const sock = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: true, minVersion: 'TLSv1.2', ...(ca ? { ca } : {}), ...tlsOptions });
    let buf = Buffer.alloc(0);
    let tagN = 0;
    let current = null;     // { tag, lines: [{ text, literals }], resolve, reject, cont }
    let pending = null;     // response being assembled: { text, literals, need }
    let greeted = false;
    let failed = null;
    const fail = (err) => {
      if (failed) return;
      failed = err;
      try { sock.destroy(); } catch {}
      if (!greeted) reject(err);
      if (current) { const c = current; current = null; c.reject(err); }
    };
    sock.setTimeout(timeout, () => fail(new ImapError('timeout', 'The mail server didn’t answer in time')));
    sock.on('error', (e) => fail(new ImapError(/certificate|self.signed|CERT|unable to verify/i.test(e.message + ' ' + e.code) ? 'tls' : 'connect', e.message)));
    sock.on('close', () => fail(new ImapError('closed', 'The mail server closed the connection')));

    function onResponse(r) {
      const text = r.text;
      if (!greeted) {
        greeted = true;
        if (/^\* (OK|PREAUTH)/i.test(text)) return resolve(api);
        return fail(new ImapError('connect', 'The server refused the connection'));
      }
      if (!current) return;
      if (text.startsWith('+')) { if (current.cont) current.cont(); return; }
      if (text.startsWith(current.tag + ' ')) {
        const c = current; current = null;
        const m = /^\S+ (OK|NO|BAD)\b\s*(.*)$/i.exec(text);
        if (m && m[1].toUpperCase() === 'OK') c.resolve({ lines: c.lines, status: m[2] });
        else c.reject(new ImapError(m && m[1].toUpperCase() === 'NO' ? 'no' : 'bad', (m && m[2]) || text));
        return;
      }
      current.lines.push(r);
    }

    sock.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (pending && pending.need > 0) {
          if (buf.length < pending.need) return;
          pending.literals.push(buf.subarray(0, pending.need));
          buf = buf.subarray(pending.need);
          pending.need = 0;
          pending.text += '\u0000'; // marks where a literal was
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) { if (buf.length > 1024 * 1024) fail(new ImapError('bad', 'Line too long')); return; }
        const line = buf.subarray(0, nl).toString('utf8');
        buf = buf.subarray(nl + 2);
        if (!pending) pending = { text: '', literals: [], need: 0 };
        pending.text += line;
        const lit = /\{(\d+)\}$/.exec(line);
        if (lit) {
          const n = +lit[1];
          if (n > MAX_MESSAGE + 1024 * 1024) return fail(new ImapError('bad', 'Message too large'));
          pending.text = pending.text.slice(0, -lit[0].length);
          pending.need = n;
          if (n === 0) { pending.literals.push(Buffer.alloc(0)); pending.text += '\u0000'; pending.need = 0; }
          continue;
        }
        const r = pending; pending = null;
        try { onResponse(r); } catch (e) { fail(e); }
      }
    });

    // command(['LOGIN', user, pass]) – strings are sent as atoms unless {q: value} (quoted or literal)
    function command(parts) {
      if (failed) return Promise.reject(failed);
      if (current) return Promise.reject(new ImapError('busy'));
      const tag = 'V' + (++tagN);
      const chunks = [tag + ' '];
      const literals = [];
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (i) chunks[chunks.length - 1] += ' ';
        if (p && typeof p === 'object' && 'q' in p) {
          const q = quoted(p.q);
          if (q) chunks[chunks.length - 1] += q;
          else { const b = Buffer.from(String(p.q), 'utf8'); chunks[chunks.length - 1] += `{${b.length}}`; literals.push(b); chunks.push(''); }
        } else chunks[chunks.length - 1] += p;
      }
      return new Promise((res, rej) => {
        current = { tag, lines: [], resolve: res, reject: rej, cont: null };
        let i = 0;
        const sendNext = () => {
          const head = chunks[i];
          if (i < literals.length) { current.cont = () => { sock.write(literals[i]); i++; sendNext(); }; sock.write(head + '\r\n'); }
          else { current.cont = null; sock.write(head + '\r\n'); }
        };
        if (log) log(tag + ' ' + parts[0]);
        sendNext();
      });
    }

    const api = {
      async capabilities() {
        const r = await command(['CAPABILITY']);
        const l = r.lines.find((x) => /^\* CAPABILITY /i.test(x.text));
        return l ? l.text.slice(13).toUpperCase().split(/\s+/) : [];
      },
      async login() {
        const caps = await api.capabilities();
        if (caps.includes('LOGINDISABLED')) throw new ImapError('login-disabled', 'This mailbox doesn’t accept a password login');
        try { await command(['LOGIN', { q: user }, { q: pass }]); } catch (e) {
          if (e.code === 'no') throw new ImapError('auth', e.message);
          throw e;
        }
      },
      // Read-only: EXAMINE. Returns { uidValidity, exists }.
      async examine(box = 'INBOX') {
        const r = await command(['EXAMINE', { q: box }]);
        let uidValidity = null; let exists = 0;
        for (const l of r.lines) {
          const v = /\[UIDVALIDITY (\d+)\]/i.exec(l.text); if (v) uidValidity = v[1];
          const e = /^\* (\d+) EXISTS/i.exec(l.text); if (e) exists = +e[1];
        }
        return { uidValidity, exists };
      },
      async search(criteria) {
        const r = await command(['UID SEARCH', criteria]);
        const out = [];
        for (const l of r.lines) { const m = /^\* SEARCH(.*)$/i.exec(l.text); if (m) for (const n of m[1].trim().split(/\s+/)) if (/^\d+$/.test(n)) out.push(+n); }
        return out;
      },
      // UID FETCH; returns [{ uid, size, data: Buffer }] (data is the first literal, e.g. the header lines or body)
      async fetch(uids, what) {
        if (!uids.length) return [];
        const r = await command(['UID FETCH', uids.join(','), `(UID RFC822.SIZE ${what})`]);
        const out = [];
        for (const l of r.lines) {
          if (!/^\* \d+ FETCH /i.test(l.text)) continue;
          const uid = /\bUID (\d+)/i.exec(l.text);
          const size = /\bRFC822\.SIZE (\d+)/i.exec(l.text);
          let data = l.literals[0];
          if (!data) { const q = /BODY\[[^\]]*\] "((?:[^"\\]|\\.)*)"/i.exec(l.text); data = q ? Buffer.from(q[1].replace(/\\(.)/g, '$1'), 'utf8') : Buffer.alloc(0); }
          if (uid) out.push({ uid: +uid[1], size: size ? +size[1] : 0, data });
        }
        return out;
      },
      async logout() { try { await command(['LOGOUT']); } catch {} try { sock.end(); } catch {} },
      close() { try { sock.destroy(); } catch {} },
    };
  });
}

// ---- matching messages to Vault's aliases ----
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const imapDate = (t) => { const d = new Date(t); return `${d.getUTCDate()}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()}`; };
const HEADER_FIELDS = 'BODY.PEEK[HEADER.FIELDS (X-SIMPLELOGIN-ENVELOPE-TO FEEDBACK-ID FROM)]';

// One search key per alias, in the header its service uses.
function keyFor(a) {
  if (a.service === 'simplelogin') return `HEADER X-SimpleLogin-Envelope-To ${quoted(a.address)}`;
  if (a.service === 'addy') return `HEADER Feedback-ID ${quoted(`F:${a.aliasId}:anonaddy`)}`;
  if (a.service === 'relay') return `FROM ${quoted(a.address)}`;
  return null;
}
function orAll(keys) {
  if (keys.length === 1) return `(${keys[0]})`;
  return `OR (${keys[0]}) ${orAll(keys.slice(1))}`;
}

function headerMap(buf) {
  const text = buf.toString('utf8').replace(/\r?\n[ \t]+/g, ' ');
  const map = {};
  for (const line of text.split(/\r?\n/)) { const m = /^([^:\s]+):\s*(.*)$/.exec(line); if (m) (map[m[1].toLowerCase()] = map[m[1].toLowerCase()] || []).push(m[2].trim()); }
  return map;
}
const addrOf = (v) => { const m = /<([^>]+)>/.exec(v); return (m ? m[1] : v).trim().toLowerCase(); };

// Does this message's header really belong to the alias? (the server's search is a substring match)
function matches(a, hm) {
  if (a.service === 'simplelogin') return (hm['x-simplelogin-envelope-to'] || []).some((v) => v.trim().toLowerCase() === a.address.toLowerCase());
  if (a.service === 'addy') return (hm['feedback-id'] || []).some((v) => v.trim() === `F:${a.aliasId}:anonaddy`);
  if (a.service === 'relay') return (hm.from || []).some((v) => addrOf(v) === a.address.toLowerCase());
  return false;
}

// aliases: [{ id, service, address, aliasId, created }]; seen: { uidValidity, uids: [] }
// Returns { messages: [{ addrId, uid, raw: Buffer }], seen }.
async function fetchAliasMail({ host, port, user, pass, tlsOptions, timeout, log }, aliases, seen = {}) {
  const usable = aliases.filter((a) => keyFor(a));
  const c = await connect({ host, port, user, pass, tlsOptions, timeout, log });
  try {
    await c.login();
    const box = await c.examine('INBOX');
    let known = seen.uidValidity === box.uidValidity ? new Set(seen.uids || []) : new Set();
    const found = new Map(); // uid -> candidate aliases
    for (let i = 0; i < usable.length; i += 20) {
      const group = usable.slice(i, i + 20);
      const since = Math.min(...group.map((a) => a.created || Date.now())) - 2 * 86400000;
      const uids = await c.search(`SINCE ${imapDate(since)} ${orAll(group.map(keyFor))}`);
      for (const u of uids) if (!known.has(u)) found.set(u, [...(found.get(u) || []), ...group]);
    }
    const messages = [];
    const uids = [...found.keys()].sort((a, b) => a - b).slice(-200);
    for (let i = 0; i < uids.length; i += 50) {
      const heads = await c.fetch(uids.slice(i, i + 50), HEADER_FIELDS);
      const ok = [];
      for (const hd of heads) {
        const hm = headerMap(hd.data);
        const a = (found.get(hd.uid) || []).find((x) => matches(x, hm));
        known.add(hd.uid); // looked at: don't look again
        if (a && hd.size <= MAX_MESSAGE) ok.push({ uid: hd.uid, addrId: a.id });
      }
      for (const m of ok) {
        const [body] = await c.fetch([m.uid], 'BODY.PEEK[]');
        if (body && body.data.length) messages.push({ addrId: m.addrId, uid: m.uid, raw: body.data });
      }
    }
    known = [...known].sort((a, b) => a - b).slice(-5000);
    await c.logout();
    return { messages, seen: { uidValidity: box.uidValidity, uids: known } };
  } catch (e) { c.close(); throw e; }
}

// Just log in and open the inbox (the wizard's Test button).
async function testMailbox(opts) {
  const c = await connect(opts);
  try { await c.login(); const b = await c.examine('INBOX'); await c.logout(); return { ok: true, exists: b.exists }; } catch (e) { c.close(); throw e; }
}

module.exports = { connect, fetchAliasMail, testMailbox, ImapError, _test: { keyFor, matches, orAll, quoted, imapDate } };
