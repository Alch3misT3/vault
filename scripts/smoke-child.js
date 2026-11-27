'use strict';
// A second Vault the smoke test starts (npx electron . --smoke-child) on a copy of its test vault,
// to check that a forced close in the middle of a password change loses nothing. It unlocks, starts
// a change, says "OPENED" once the change page was opened, and then waits to be killed.

module.exports = async function smokeChild({ win, PW, opened }) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const waitFor = async (code, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await js(code)) return true; } catch {} await wait(80); } return false; };
  try {
    if (process.env.VAULT_SMOKE_SITE_BASE) PW._test.base = () => process.env.VAULT_SMOKE_SITE_BASE;
    await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', r) : r()));
    await waitFor("!document.getElementById('lock').hidden");
    await js(`(() => { const el = document.getElementById('pw1'); el.value = ${JSON.stringify(process.env.VAULT_SMOKE_MASTER)}; el.dispatchEvent(new Event('input')); document.getElementById('unlockGo').click(); })()`);
    if (!(await waitFor("!document.getElementById('app').hidden"))) throw new Error('unlock');
    await js(`changePassword(window.__vaultState.items.find(i => i.title === ${JSON.stringify(process.env.VAULT_SMOKE_TITLE)})); true`);
    const t = Date.now();
    while (!opened.length && Date.now() - t < 15000) await wait(50);
    console.log(opened.length ? 'OPENED ' + opened[0] : 'NOT-OPENED');
  } catch (err) { console.log('CHILD-FAILED ' + (err && err.message)); }
  // stays open until the test kills it
};
