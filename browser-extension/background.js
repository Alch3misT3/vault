'use strict';
/* global chrome, VaultClient, importScripts */
// Chrome loads this as a service worker; Firefox loads vault-client.js first as a background script.
if (typeof VaultClient === 'undefined' && typeof importScripts === 'function') importScripts('vault-client.js');

function badge(text, color) {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
  if (text) setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2500);
}

// Ctrl+Shift+L: fill this site's login straight away when there's exactly one, otherwise open the popup.
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'fill-login') return;
  tab = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab || !/^https?:/.test(tab.url || '')) return;
  try {
    const r = await VaultClient.rpc('list', { url: tab.url });
    const matches = (r.items || []).filter((i) => i.match);
    if (r.locked || matches.length !== 1) { try { await chrome.action.openPopup(); } catch { badge(r.locked ? '🔒' : String(matches.length), '#0071e3'); } return; }
    const res = await VaultClient.fill(tab, matches[0]);
    badge(res && res.filled ? '✓' : '?', res && res.filled ? '#1d8f47' : '#c25e00');
  } catch (err) {
    try { await chrome.action.openPopup(); } catch { badge('!', '#d70015'); }
  }
});

// ---- Passkeys: requests from web pages (passkeys-page.js → passkeys-content.js → here → Vault) ----
// The site's origin is taken from the browser's own record of which tab and frame sent the request,
// never from the page. Anything Vault can't or shouldn't handle falls back to the browser's own flow.
const PASSKEY_WAIT_MS = 5 * 60 * 1000;
async function passkeyRequest(msg, sender) {
  if (sender.id !== chrome.runtime.id || !sender.tab || sender.frameId !== 0) return { fallback: true };
  let origin;
  try { origin = sender.origin || new URL(sender.url).origin; } catch { return { fallback: true }; }
  if (!/^https:\/\/[^/]+$/.test(origin)) return { fallback: true };
  if (!(await VaultClient.paired())) return { fallback: true };
  try {
    const r = await VaultClient.rpc('passkey', { op: msg.op, origin, options: msg.options, requestId: String(msg.requestId) }, PASSKEY_WAIT_MS);
    if (r && (r.fallback || r.error || r.credential)) return { fallback: !!r.fallback, error: r.error, message: r.message, credential: r.credential };
    return { fallback: true };
  } catch { return { fallback: true }; }
}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.type === 'vault-passkey' && (msg.op === 'create' || msg.op === 'get')) { passkeyRequest(msg, sender).then(sendResponse); return true; }
  if (msg.type === 'vault-passkey-cancel' && sender.tab) VaultClient.rpc('passkey-cancel', { requestId: String(msg.requestId) }).catch(() => {});
  return false;
});
