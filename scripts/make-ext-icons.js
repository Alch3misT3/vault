'use strict';
// One-off: `npx electron scripts/make-ext-icons.js` writes the extension's toolbar icons from build/icon.png.
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
app.whenReady().then(() => {
  const src = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png'));
  for (const s of [16, 32, 48, 128]) fs.writeFileSync(path.join(__dirname, '..', 'browser-extension', 'icons', s + '.png'), src.resize({ width: s, height: s, quality: 'best' }).toPNG());
  app.exit(0);
});
