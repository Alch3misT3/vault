'use strict';
// Native messaging: how the browser extension reaches the running Vault app.
//
// The browser starts vault-native-host.exe (native-host/relay.cs) when the extension connects. That
// small program passes the extension's messages, byte for byte, to Vault over a named pipe that only
// this Windows user can open, and Vault's replies back. Only the Vault extension may start it: its
// id is the only one listed in the host's manifest. Messages are also encrypted with the pairing key.
//
// (Vault.exe itself can't be the host: every Electron app writes a stray line to stdout when it
// starts, which would break the browser's message framing.)

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const HOST_NAME = 'local.vault.app';
const FIREFOX_ID = 'vault-extension@alch3mist3.github.io';
// Chrome/Edge/Brave registry locations (per user, no admin needed).
const BROWSER_KEYS = [
  'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
  'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
  'HKCU\\Software\\Chromium\\NativeMessagingHosts',
  'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts',
];
const FIREFOX_KEY = 'HKCU\\Software\\Mozilla\\NativeMessagingHosts';

const clean = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '_');
// Same rule as relay.cs.
const pipeName = () => 'vault-browser-' + clean(os.userInfo().username);
const pipePath = (name) => '\\\\.\\pipe\\' + name;

// The extension's id comes from the public key in its manifest ("key"), so it is the same everywhere.
function extensionId(manifestPath) {
  const key = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).key;
  const hash = crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return [...hash].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

const reg = (args) => new Promise((resolve) => execFile('reg.exe', args, { windowsHide: true }, (err, stdout) => resolve(err ? null : stdout)));
async function setDefault(key, value) {
  const now = await reg(['query', key, '/ve']);
  if (now && now.includes(value)) return true;
  return (await reg(['add', key, '/ve', '/t', 'REG_SZ', '/d', value, '/f'])) !== null;
}

// Write the host manifests into dir and register them for each browser.
// exe: the relay to start; extId: allowed Chrome-family extension.
async function register({ dir, exe, extId, name = HOST_NAME, browsers = 'all' }) {
  fs.mkdirSync(dir, { recursive: true });
  const chromeManifest = path.join(dir, name + '.json');
  const firefoxManifest = path.join(dir, name + '.firefox.json');
  const base = { name, description: 'Vault browser extension link', path: exe, type: 'stdio' };
  const write = (file, obj) => { const text = JSON.stringify(obj, null, 2); if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text); };
  write(chromeManifest, { ...base, allowed_origins: [`chrome-extension://${extId}/`] });
  write(firefoxManifest, { ...base, allowed_extensions: [FIREFOX_ID] });
  const keys = browsers === 'edge' ? [BROWSER_KEYS[1]] : BROWSER_KEYS;
  const ok = [];
  for (const k of keys) ok.push(await setDefault(k + '\\' + name, chromeManifest));
  if (browsers === 'all') ok.push(await setDefault(FIREFOX_KEY + '\\' + name, firefoxManifest));
  return ok.every(Boolean);
}

async function unregister({ name, browsers = 'all' }) {
  const keys = browsers === 'edge' ? [BROWSER_KEYS[1]] : [...BROWSER_KEYS, FIREFOX_KEY];
  for (const k of keys) await reg(['delete', k + '\\' + name, '/f']);
}

// ---- message framing (the browser's: 4-byte little-endian length + UTF-8 JSON) ----
const MAX_FRAME = 1024 * 1024;
function frameReader(onMessage, onBad) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const n = buf.readUInt32LE(0);
      if (n > MAX_FRAME) { buf = Buffer.alloc(0); onBad(); return; }
      if (buf.length < 4 + n) return;
      const body = buf.subarray(4, 4 + n);
      buf = buf.subarray(4 + n);
      let msg;
      try { msg = JSON.parse(body.toString('utf8')); } catch { onBad(); return; }
      onMessage(msg);
    }
  };
}
function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length);
  return Buffer.concat([head, body]);
}

module.exports = { HOST_NAME, FIREFOX_ID, pipeName, pipePath, extensionId, register, unregister, frameReader, frame, MAX_FRAME };
