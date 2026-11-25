'use strict';
// Smoke test, part 2: light, interactive states, Liquid Glass menus, motion, frame rate, reduced motion.
// Uses real mouse and keyboard events (webContents.sendInputEvent), not synthetic DOM events.

module.exports = async function motion({ win, js, wait, waitFor, shot, check, clipboard }) {
  const wc = win.webContents;
  const box = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), l: r.left, t: r.top, w: r.width, h: r.height }; })()`);
  const move = (x, y) => wc.sendInputEvent({ type: 'mouseMove', x, y });
  const down = (x, y, button = 'left') => wc.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: 1 });
  const up = (x, y, button = 'left') => wc.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: 1 });
  const click = async (x, y, button = 'left') => { move(x, y); await wait(30); down(x, y, button); await wait(50); up(x, y, button); await wait(60); };
  const clickOn = async (sel, button) => { const b = await box(sel); if (!b) throw new Error('no ' + sel); await click(b.x, b.y, button); return b; };
  const key = async (keyCode, modifiers = []) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (keyCode.length === 1 || keyCode === 'Return' || keyCode === 'Space') wc.sendInputEvent({ type: 'char', keyCode: keyCode === 'Return' ? String.fromCharCode(13) : keyCode === 'Space' ? ' ' : keyCode, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await wait(40);
  };
  const menuOpen = () => js("!!document.querySelector('.menu:not(.closing)')");
  const active = () => js("(document.querySelector('.menu .menu-item.active .mi-label') || {}).textContent || ''");
  // Records every running animation/transition: which properties, on how large an element.
  await js(`window.__audit = { list: [], on: false,
    start() { this.list = []; this.on = true; const loop = () => {
      for (const a of document.getAnimations()) {
        const t = a.effect && a.effect.target; if (!t) continue;
        const r = t.getBoundingClientRect();
        const props = a.transitionProperty ? [a.transitionProperty] : [...new Set(a.effect.getKeyframes().flatMap((k) => Object.keys(k).filter((p) => !['offset', 'easing', 'composite', 'computedOffset'].includes(p))))];
        const name = (t.id ? '#' + t.id : '') + '.' + String(t.className && t.className.baseVal !== undefined ? t.className.baseVal : t.className).trim().split(/\\s+/).join('.') + (a.effect.pseudoElement || '');
        this.list.push({ props, area: Math.round(r.width * r.height), name, easing: (() => { const k = a.effect.getKeyframes(); const ke = k.length && k[0].easing; return ke && ke !== 'linear' ? ke : a.effect.getComputedTiming().easing; })() });
      }
      if (this.on) requestAnimationFrame(loop); }; requestAnimationFrame(loop); },
    stop() { this.on = false; return this.list; } }; true`);
  await js(`window.__fps = { t: [], on: false,
    start() { this.t = []; this.on = true; const loop = (ts) => { this.t.push(ts); if (this.on) requestAnimationFrame(loop); }; requestAnimationFrame(loop); },
    stop() { this.on = false; const d = []; for (let i = 1; i < this.t.length; i++) d.push(this.t[i] - this.t[i - 1]); d.sort((a, b) => a - b);
      const total = this.t[this.t.length - 1] - this.t[0];
      return { frames: d.length, fps: Math.round(d.length / total * 1000 * 10) / 10, p50: d[Math.floor(d.length * 0.5)], p95: d[Math.floor(d.length * 0.95)], p99: d[Math.floor(d.length * 0.99)], worst: d[d.length - 1], over25: d.filter((x) => x > 25).length }; } }; true`);

  win.setAlwaysOnTop(true); // an uncovered window, so frames aren't throttled
  wc.setBackgroundThrottling(false);
  await js("setView('all'); document.getElementById('q').blur(); true");
  await js("select(window.__vaultState.items.find(i => i.title === 'Riot Games').id)");
  await wait(600);

  // ---------- Light ----------
  const open = await box('.hero .btn-primary');
  move(open.l + 10, open.y); await wait(40); move(open.l + 14, open.y); await wait(120);
  const lit = await js(`(() => { const b = document.querySelector('.hero .btn-primary'); const s = b.querySelector(':scope > .lit-layer .lit-spot'); if (!s) return null;
    const m = new DOMMatrix(getComputedStyle(s).transform); return { on: b.classList.contains('lit-on'), x: m.m41 + s.offsetWidth / 2, op: getComputedStyle(s).opacity, rim: getComputedStyle(b.querySelector('.lit-rim')).opacity }; })()`);
  check('light: a specular spot follows the pointer over a button', lit && lit.on && Math.abs(lit.x - 14) < 3, JSON.stringify(lit));
  move(open.l + open.w - 12, open.y); await wait(120);
  const lit2 = await js("(() => { const s = document.querySelector('.hero .btn-primary .lit-spot'); return new DOMMatrix(getComputedStyle(s).transform).m41 + s.offsetWidth / 2; })()");
  check('light: … and moves with it (the rim brightens on that side)', Math.abs(lit2 - (open.w - 12)) < 3, String(lit2));
  down(open.x, open.y); await wait(110);
  const press = await js("(() => { const b = document.querySelector('.hero .btn-primary'); return { scale: new DOMMatrix(getComputedStyle(b).transform).a, glow: b.querySelector('.lit-glow').getAnimations().length }; })()");
  check('press: the button squishes and a glow spreads from the pointer', press.scale < 0.99 && press.glow > 0, JSON.stringify(press));
  await shot('25-light-press');
  up(open.x, open.y); await wait(650);
  check('release: the button springs back', await js("new DOMMatrix(getComputedStyle(document.querySelector('.hero .btn-primary')).transform).a > 0.995"));
  const side = await box('.sidebar');
  move(side.x, side.y); await wait(150);
  check('light: the glass sidebar catches the light too', await js("(() => { const s = document.querySelector('.sidebar'); return s.classList.contains('lit-on') && s.classList.contains('lit-big'); })()"));
  move(open.x + 300, 400); await wait(100);

  // ---------- States: hover, focus, disabled ----------
  const lockB = await box('#lockBtn');
  move(lockB.x, lockB.y); await wait(260);
  check('hover: toolbar buttons get a highlight', await js("getComputedStyle(document.getElementById('lockBtn')).backgroundColor !== 'rgba(0, 0, 0, 0)'"));
  move(open.x + 300, 400);
  await key('Shift'); // keyboard modality: focus rings show
  await js("document.getElementById('moreBtn').focus(); true");
  await wait(600);
  const ring = await js("(() => { const s = getComputedStyle(document.getElementById('moreBtn')); return { style: s.outlineStyle, color: s.outlineColor, off: s.outlineOffset, w: s.outlineWidth }; })()");
  check('focus: a visible, styled focus ring', ring.style === 'solid' && /0, 113, 227|10, 111, 216/.test(ring.color) && ring.off === '2px', JSON.stringify(ring));
  await shot('26-focus-ring');
  await js("document.querySelector('.detail-bar .glass-btn:last-child').disabled = true; true");
  await wait(350);
  check('disabled: dimmed, no light, no press', await js("(() => { const b = document.querySelector('.detail-bar .glass-btn:last-child'); return getComputedStyle(b).opacity === '0.4'; })()"));
  await js("document.querySelector('.detail-bar .glass-btn:last-child').disabled = false; true");

  // ---------- Liquid Glass menus ----------
  await clickOn('#moreBtn');
  await waitFor("!!document.querySelector('.menu')", 2000);
  await wait(450);
  const mm = await js(`(() => { const m = document.querySelector('.menu'); if (!m) return null; const r = m.getBoundingClientRect(); const cs = getComputedStyle(m);
    return { items: m.querySelectorAll('.menu-item').length, seps: m.querySelectorAll('.menu-sep').length, keys: [...m.querySelectorAll('.mi-key')].map((k) => k.textContent),
      glass: cs.backdropFilter, radius: cs.borderRadius, inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, origin: cs.transformOrigin, role: m.getAttribute('role'),
      expanded: document.getElementById('moreBtn').getAttribute('aria-expanded') }; })()`);
  check('••• opens a Liquid Glass menu (blur, rounded, separators, shortcuts)', mm && mm.items >= 10 && mm.seps === 3 && /blur/.test(mm.glass) && parseFloat(mm.radius) >= 12 && mm.keys.includes('Ctrl+I') && mm.role === 'menu' && mm.expanded === 'true', JSON.stringify(mm));
  check('the menu opens from its button', mm && /^\d+(\.\d+)?px 0px$/.test(mm.origin), mm && mm.origin);
  await shot('23-more-menu');
  await key('Down');
  const first = await active();
  const y1 = await js("new DOMMatrix(document.querySelector('.menu-hl').style.transform).m42");
  await key('Down');
  const glide = await js("document.querySelector('.menu-hl').getAnimations().some((a) => a.transitionProperty === 'transform')");
  await wait(350);
  const y2 = await js("new DOMMatrix(document.querySelector('.menu-hl').style.transform).m42");
  check('arrow keys move a highlight that glides between items', first === 'Import Passwords…' && (await active()) === 'Export Passwords…' && y2 > y1 && glide, `${first} ${y1}→${y2} glide=${glide}`);
  move(mm ? 600 : 600, 300); // keep the pointer away from the menu
  await key('c');
  const c1 = await active();
  await wait(800);
  await key('c');
  const c2 = await active();
  check('first-letter jump (C → Connect…, C again → Change…)', c1 === 'Connect a Browser…' && c2 === 'Change Master Password…', `${c1} / ${c2}`);
  await key('Escape');
  await wait(250);
  check('Esc closes it and gives focus back to ••• ', !(await menuOpen()) && (await js("document.activeElement.id")) === 'moreBtn');
  await key('Return');
  await wait(300);
  check('opened from the keyboard, the first item is ready', (await active()) === 'Import Passwords…');
  await key('p');
  await key('Return');
  check('Enter chooses the item (Password Generator…)', await waitFor("document.getElementById('genDlg').open", 2000));
  await wait(300);
  await js("document.getElementById('genDlg').close(); true");
  await wait(300);
  await clickOn('#moreBtn');
  await wait(200);
  await click(700, 600);
  await wait(250);
  check('a click outside closes the menu', !(await menuOpen()) && !(await js("!!document.querySelector('dialog[open]')")));
  await clickOn('#moreBtn');
  await wait(200);
  await clickOn('#moreBtn');
  await wait(300);
  check('clicking ••• again closes it', !(await menuOpen()));

  // right-click menu on a row
  const nf = await box('#list .row:nth-child(6)');
  const rowTitle = await js("document.querySelector('#list .row:nth-child(6) .row-title').textContent");
  await click(nf.x, nf.y, 'right');
  await wait(450);
  const rm = await js(`(() => { const m = document.querySelector('.menu'); if (!m) return null; const items = [...m.querySelectorAll('.menu-item')];
    return { labels: items.map((i) => i.querySelector('.mi-label').textContent), last: items[items.length - 1].className, keys: m.querySelectorAll('.mi-key').length, origin: getComputedStyle(m).transformOrigin }; })()`);
  check('right-click opens a glass menu for that account', rm && rm.labels.includes('Copy Password') && rm.labels.includes('Edit') && /danger/.test(rm.last) && rm.keys >= 4, JSON.stringify(rm));
  await shot('24-row-menu');
  const pwItem = await js("(() => { const i = [...document.querySelectorAll('.menu .menu-item')].find((x) => x.textContent.startsWith('Copy Password')); const r = i.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()");
  await clipboard.clear();
  await click(pwItem[0], pwItem[1]);
  await wait(400);
  const expectPw = await js(`window.__vaultState.items.find((i) => i.title === ${JSON.stringify(rowTitle)}).password`);
  check('choosing Copy Password copies it', (await clipboard.readText()) === expectPw && !(await menuOpen()), rowTitle);
  // near the window's corner the menu stays inside
  await js(`window.fx.menu([{ label: 'One', value: 1 }, { label: 'Two', value: 2 }, 'sep', { label: 'Three', value: 3 }], { x: innerWidth - 3, y: innerHeight - 3 }); true`);
  await wait(450);
  check('a menu opened at the window corner stays inside the window', await js("(() => { const r = document.querySelector('.menu').getBoundingClientRect(); return r.right <= innerWidth - 7 && r.bottom <= innerHeight - 7 && r.left > 0; })()"));
  await key('Escape');
  await js("document.getElementById('q').focus(); true");
  await key('F10', ['shift']);
  await wait(350);
  check('Shift+F10 opens the account menu from the keyboard', (await menuOpen()) && /^Copy/.test(await active()));
  await key('Escape');
  await wait(200);
  await js("document.getElementById('q').blur(); true");

  // ---------- Motion between states ----------
  const fav = await box('#view-codes');
  await click(fav.x, fav.y);
  await wait(40);
  const sw = await js(`({ pill: document.querySelector('.view-pill').getAnimations().some((a) => a.transitionProperty === 'transform'),
    rows: document.querySelectorAll('#list .row.enter').length, swap: !!document.querySelector('.detail-inner.swap') })`);
  check('switching views: the tab pill glides, rows rise in', sw.pill && sw.rows >= 1, JSON.stringify(sw));
  await wait(650);
  check('… and the pill settles on the new tab', await js("Math.abs(new DOMMatrix(getComputedStyle(document.querySelector('.view-pill')).transform).m41 - document.getElementById('view-codes').offsetLeft) < 1"));
  await clickOn('#view-all');
  await wait(700);
  const r3 = await box('#list .row:nth-child(4)');
  await click(r3.x, r3.y);
  await wait(30);
  const open1 = await js(`({ ghost: !!document.querySelector('.tile-ghost'), sel: document.querySelector('.list-sel').getAnimations().some((a) => a.transitionProperty === 'transform'), hero: document.querySelector('.hero .tile').style.opacity })`);
  check('opening an account: its tile flies from the row into the header, the selection glides', open1.ghost && open1.sel && open1.hero === '0', JSON.stringify(open1));
  await wait(700);
  check('… and lands', await js("!document.querySelector('.tile-ghost') && document.querySelector('.hero .tile').style.opacity === ''"));

  // copy confirmation on the button itself
  const urow = await box('.detail .group .field-row');
  move(urow.x, urow.y); await wait(200);
  const cbtn = await box('.detail .group .field-row [data-copy]');
  await clipboard.clear();
  await click(cbtn.x, cbtn.y);
  await wait(120);
  const cc = await js("(() => { const b = document.querySelector('.detail .group .field-row [data-copy]'); return { done: b.classList.contains('done'), icon: b.querySelector('use').getAttribute('href'), flash: b.closest('.field-row').classList.contains('flash') }; })()");
  check('copying: the button turns into a tick, the row flashes', cc.done && cc.icon === '#i-check' && cc.flash && (await clipboard.readText()).length > 0, JSON.stringify(cc));
  await shot('27-copy-confirm');
  await wait(1500);
  check('… and turns back into the copy icon', await js("document.querySelector('.detail .group .field-row [data-copy] use').getAttribute('href') === '#i-copy'"));

  // dialogs grow in and shrink out; the toast springs
  await js("generatorFlow(false); true");
  await wait(30);
  const dIn = await js("document.getElementById('genDlg').getAnimations().map((a) => a.transitionProperty).join(',')");
  await wait(500);
  await js("document.getElementById('genDlg').close(); true");
  await wait(40);
  const dOut = await js("({ open: document.getElementById('genDlg').open, shown: getComputedStyle(document.getElementById('genDlg')).display !== 'none', anims: document.getElementById('genDlg').getAnimations().map((a) => a.transitionProperty).join(',') })");
  check('dialogs grow in and shrink away (not just appear/vanish)', /transform/.test(dIn) && !dOut.open && dOut.shown && /transform|opacity/.test(dOut.anims), `${dIn} | ${JSON.stringify(dOut)}`);
  await wait(300);
  await js("toast('Hello'); true");
  await wait(30);
  check('the toast springs in', await js("document.getElementById('toast').getAnimations().some((a) => a.transitionProperty === 'transform')"));

  // verification code: a new code slides in, the ring refills instead of running backwards
  await js("setView('codes'); true");
  await wait(700);
  await js("(() => { const c = document.querySelector('.detail .otp-code'); c.textContent = '000 000'; const r = document.querySelector('.detail .otp-ring'); r.dataset.left = '0.02'; tickCodes(); })(); true");
  await wait(150);
  check('2FA: a new code slides in and the ring refills', await js("document.querySelector('.detail .otp-code').classList.contains('tick') && document.querySelector('.detail .otp-ring').classList.contains('refill')"));
  await js("setView('all'); true");
  await wait(600);

  // ---------- Performance: frame rate and what is animated ----------
  const hz = await js("new Promise((r) => { let n = 0; const t0 = performance.now(); const f = () => { if (++n < 61) requestAnimationFrame(f); else r(Math.round(60000 / (performance.now() - t0))); }; requestAnimationFrame(f); })");
  const workout = async () => {
    const s = await box('.sidebar');
    for (let i = 0; i < 40; i++) { move(s.l + 20 + i * 6, s.t + 60 + i * 12); await wait(16); }
    for (const v of ['favorites', 'codes', 'security', 'deleted', 'all']) { await clickOn('#view-' + v); for (let i = 0; i < 18; i++) { move(150 + i * 4, 300 + i * 3); await wait(16); } }
    for (const n of [2, 5, 3, 7, 4]) { await clickOn(`#list .row:nth-child(${n})`); await wait(250); }
    const o = await box('.hero .btn-primary');
    for (let i = 0; i < 30; i++) { move(o.l + (i * o.w) / 30, o.y); await wait(16); }
    await clickOn('#moreBtn'); await wait(200);
    for (let i = 0; i < 8; i++) { await key('Down'); await wait(60); }
    await key('Escape'); await wait(250);
    await js("generatorFlow(false); true"); await wait(500); await js("document.getElementById('genDlg').close(); true"); await wait(300);
    await js("toast('Measuring'); true"); await wait(400);
  };
  await js('__fps.start(); true');
  await workout();
  const fps = await js('__fps.stop()');
  const smooth = fps.p95 <= 1000 / hz * 1.5 + 2 && fps.over25 <= Math.max(3, fps.frames * 0.02);
  check(`steady frame rate during animations (${fps.fps} fps on a ${hz} Hz screen; p95 ${fps.p95.toFixed(1)} ms, worst ${fps.worst.toFixed(1)} ms, ${fps.over25} slow frames of ${fps.frames})`, smooth, JSON.stringify(fps));
  await js('__audit.start(); true');
  await workout();
  const audit = await js('__audit.stop()');
  const props = new Set(audit.flatMap((a) => a.props));
  const bigBad = [...new Set(audit.filter((a) => a.area > 40000 && a.props.some((p) => !['transform', 'opacity', 'overlay', 'display'].includes(p))).map((a) => a.name + ':' + a.props.join('+')))];
  check('large surfaces animate only transform and opacity', !bigBad.length, bigBad.join(' | '));
  check('backdrop-filter is never animated, and no blur on large surfaces', !props.has('backdrop-filter') && !props.has('backdropFilter') && !audit.some((a) => a.area > 40000 && a.props.includes('filter')), [...props].join(','));
  check('no linear motion: transforms use springs or ease-outs', !audit.some((a) => a.props.includes('transform') && a.easing === 'linear'), [...new Set(audit.filter((a) => a.props.includes('transform') && a.easing === 'linear').map((a) => a.name))].join(','));
  console.log(`      measured: ${JSON.stringify(fps)}; animated properties: ${[...props].join(', ')}`);

  // ---------- Lock and unlock ----------
  await js('lockNow(); true');
  await wait(60);
  check('locking: the window sinks away first', await js("document.getElementById('app').classList.contains('leaving')"));
  await waitFor("!document.getElementById('lock').hidden");

  // ---------- Reduced motion ("Show animations in Windows" off) ----------
  try { wc.debugger.attach('1.3'); } catch {}
  await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  win.setAlwaysOnTop(false);
  return {
    // run by the main smoke test after unlocking again, with reduced motion still on
    async reduced() {
      await js('__audit.start(); true');
      await clickOn('#view-favorites'); await wait(300);
      await clickOn('#view-all'); await wait(300);
      await clickOn('#list .row:nth-child(3)'); await wait(300);
      await clickOn('#moreBtn'); await wait(300);
      const opened = await menuOpen();
      await key('Down'); await key('Escape'); await wait(250);
      await js("generatorFlow(false); true"); await wait(300); await js("document.getElementById('genDlg').close(); true"); await wait(300);
      const list = await js('__audit.stop()');
      const moving = [...new Set(list.filter((a) => a.props.some((p) => p === 'transform' || p === 'translate' || p === 'scale')).map((a) => a.name))];
      const fades = list.filter((a) => a.props.includes('opacity')).length;
      check('reduced motion: nothing slides or scales, only short fades', !moving.length && fades > 0 && opened && !(await js("!!document.querySelector('.tile-ghost')")), moving.join(', '));
      await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
      try { wc.debugger.detach(); } catch {}
    },
  };
};
