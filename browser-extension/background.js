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
