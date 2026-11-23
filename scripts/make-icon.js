'use strict';
// Renders the app icon to build/icon.png (256 px): `npx electron . --make-icon`
const fs = require('fs');
const path = require('path');

module.exports = async function makeIcon(app, BrowserWindow) {
  const w = new BrowserWindow({ width: 256, height: 256, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  const html = `<html><body style="margin:0;background:transparent">
  <svg width="256" height="256" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4f8dff"/><stop offset="1" stop-color="#2b5fd9"/></linearGradient></defs>
    <rect x="2" y="2" width="60" height="60" rx="14" fill="url(#g)"/>
    <rect x="17" y="28" width="30" height="22" rx="5.5" fill="#fff"/>
    <path d="M23 28v-5a9 9 0 0 1 18 0v5" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round"/>
    <circle cx="32" cy="38" r="3.3" fill="#2b5fd9"/><rect x="30.5" y="38" width="3" height="6.5" rx="1.5" fill="#2b5fd9"/>
  </svg></body></html>`;
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 400));
  const img = await w.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 });
  fs.mkdirSync(path.join(__dirname, '..', 'build'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.png'), img.resize({ width: 256, height: 256 }).toPNG());
  console.log('icon written');
  app.exit(0);
};
