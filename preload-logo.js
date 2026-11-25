'use strict';
// Logo decoder window: receives image bytes, sends back a plain PNG and its colours. Nothing else.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('decoder', {
  onDecode: (fn) => ipcRenderer.on('logo:decode', (_e, id, bytes, mime, size) => fn(id, bytes, mime, size)),
  done: (id, result) => ipcRenderer.send('logo:decoded', id, result),
});
