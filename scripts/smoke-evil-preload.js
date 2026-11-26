'use strict';
// Smoke test only: a window that tries to call Vault's IPC channels it has no right to.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('evil', { invoke: (ch, ...a) => ipcRenderer.invoke(ch, ...a) });
