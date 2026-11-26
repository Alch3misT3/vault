'use strict';
// Passkey confirmation window: sees which site asks and the account names to choose from, never keys.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vaultPrompt', {
  state: () => ipcRenderer.invoke('prompt:state'),
  answer: (action, accountId) => ipcRenderer.invoke('prompt:answer', action, accountId),
  unlock: (pw) => ipcRenderer.invoke('prompt:unlock', pw),
  unlockPasskey: (id, prf) => ipcRenderer.invoke('prompt:unlock-passkey', id, prf),
  onUpdate: (fn) => ipcRenderer.on('prompt:update', (_e, st) => fn(st)),
});
