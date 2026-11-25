'use strict';
// Quick-search panel: can list accounts and ask for things to be copied, never read secrets.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('quick', {
  list: () => ipcRenderer.invoke('quick:list'),
  unlock: (pw) => ipcRenderer.invoke('quick:unlock', pw),
  copy: (id, what) => ipcRenderer.invoke('quick:copy', id, what),
  code: (id) => ipcRenderer.invoke('quick:code', id),
  open: (url) => ipcRenderer.invoke('quick:open', url),
  hide: () => ipcRenderer.invoke('quick:hide'),
  showMain: () => ipcRenderer.invoke('quick:main'),
  onShow: (fn) => ipcRenderer.on('quick:show', () => fn()),
  onHiding: (fn) => ipcRenderer.on('quick:hiding', () => fn()),
});
