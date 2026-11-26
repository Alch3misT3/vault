'use strict';
/* global chrome */
// The extension's side of the page (isolated from the page's scripts): passes passkey requests from
// passkeys-page.js to the background worker, which checks where they came from and asks Vault.
window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || typeof e.data !== 'object') return;
  const d = e.data;
  if (d.__vaultPasskey === 'request' && typeof d.requestId === 'string' && (d.op === 'create' || d.op === 'get')) {
    const reply = (result) => window.postMessage({ __vaultPasskey: 'reply', requestId: d.requestId, result }, location.origin);
    chrome.runtime.sendMessage({ type: 'vault-passkey', op: d.op, options: d.options, requestId: d.requestId })
      .then((r) => reply(r || { fallback: true }), () => reply({ fallback: true }));
  } else if (d.__vaultPasskey === 'cancel' && typeof d.requestId === 'string') {
    chrome.runtime.sendMessage({ type: 'vault-passkey-cancel', requestId: d.requestId }).catch(() => {});
  }
});
