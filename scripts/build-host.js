'use strict';
// Builds native-host/relay.cs into build/native-host/vault-native-host.exe with the C# compiler that
// comes with Windows (.NET Framework 4). Run by `npm run dist` and by the smoke test.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

module.exports = function buildHost() {
  const root = path.join(__dirname, '..');
  const src = path.join(root, 'native-host', 'relay.cs');
  const out = path.join(root, 'build', 'native-host', 'vault-native-host.exe');
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs) return out;
  const csc = path.join(process.env.WINDIR || 'C:\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  execFileSync(csc, ['/nologo', '/optimize+', '/target:exe', '/platform:anycpu', '/out:' + out, src], { stdio: 'inherit' });
  return out;
};
if (require.main === module) console.log(module.exports());
