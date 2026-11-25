'use strict';
/* Vault — light and motion helpers for the window:
   - Liquid Glass light: a specular spot and a brighter rim follow the pointer, a press sends out a glow
   - Liquid Glass menus (••• and right-click), fully usable from the keyboard
   - a "ghost" morph used when an account opens
   Everything that moves uses transform and opacity only. */
(function () {
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  let springCache = null;
  const spring = () => springCache || (springCache = cssVar('--spring') || 'cubic-bezier(.16, 1, .3, 1)');

  // ---------------- light ----------------
  const LIT = '.glass:not(.toast), .btn-primary, .btn-danger, .btn-secondary, .glass-btn';
  let host = null; let rect = null; let layer = null; let px = 0; let py = 0; let raf = 0;

  function ensureLayer(el) {
    let l = el.querySelector(':scope > .lit-layer');
    if (!l) {
      l = document.createElement('span');
      l.className = 'lit-layer';
      l.setAttribute('aria-hidden', 'true');
      l.innerHTML = '<i class="lit-spot"></i><span class="lit-rim"><i></i></span><i class="lit-glow"></i>';
      el.prepend(l);
    }
    return l;
  }
  function setHost(el) {
    if (el === host) return;
    if (host) host.classList.remove('lit-on');
    host = null; layer = null;
    if (!el || el.matches(':disabled')) return;
    host = el;
    layer = ensureLayer(el);
    rect = el.getBoundingClientRect();
    const big = rect.width * rect.height > 40000;
    el.classList.toggle('lit-big', big);
    const d = big ? 360 : Math.max(rect.width, rect.height) * 1.25;
    layer.style.setProperty('--lit-d', d + 'px');
    layer.style.setProperty('--lit-rd', (big ? 300 : d * 1.4) + 'px');
    place();
    el.classList.add('lit-on');
  }
  function place() {
    raf = 0;
    if (!host || !host.isConnected) { if (host) setHost(null); return; }
    rect = host.getBoundingClientRect();
    const x = px - rect.left; const y = py - rect.top;
    const spot = layer.firstChild; const rimDot = layer.children[1].firstChild;
    const d = spot.offsetWidth || 1; const rd = rimDot.offsetWidth || 1;
    spot.style.transform = `translate3d(${x - d / 2}px, ${y - d / 2}px, 0)`;
    rimDot.style.transform = `translate3d(${x - rd / 2}px, ${y - rd / 2}px, 0)`;
  }
  document.addEventListener('pointermove', (e) => {
    px = e.clientX; py = e.clientY;
    const el = e.target.closest ? e.target.closest(LIT) : null;
    if (el !== host) setHost(el);
    if (host && !raf) raf = requestAnimationFrame(place);
  }, { passive: true });
  document.addEventListener('pointerout', (e) => { if (!e.relatedTarget) setHost(null); }, { passive: true });
  document.addEventListener('pointerdown', (e) => {
    const el = e.target.closest ? e.target.closest(LIT) : null;
    if (!el || el.matches(':disabled')) return;
    px = e.clientX; py = e.clientY;
    setHost(el);
    const r = el.getBoundingClientRect();
    const glow = layer.children[2];
    const d = Math.max(r.width, r.height) * (r.width * r.height > 40000 ? 0.9 : 2.2);
    glow.style.setProperty('--lit-d', d + 'px');
    const at = `translate3d(${px - r.left - d / 2}px, ${py - r.top - d / 2}px, 0)`;
    if (reduced()) { glow.style.transform = at; glow.animate([{ opacity: 0.8 }, { opacity: 0 }], { duration: 300, easing: 'ease-out' }); return; }
    glow.style.transform = '';
    glow.animate([
      { transform: at + ' scale(.25)', opacity: 1 },
      { transform: at + ' scale(1)', opacity: 0.9, offset: 0.35 },
      { transform: at + ' scale(1.15)', opacity: 0 },
    ], { duration: 700, easing: 'cubic-bezier(.2, .8, .2, 1)' });
  }, { passive: true });

  // ---------------- menus ----------------
  let openMenu = null;
  let lastOutside = null; // a click outside that closed a menu (so its own button doesn't reopen it)
  const svgUse = (id, cls) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('class', cls); s.setAttribute('aria-hidden', 'true');
    const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    u.setAttribute('href', '#' + id);
    s.append(u);
    return s;
  };

  /**
   * Show a glass menu. items: [{ label, value, key, danger, checked, disabled } | 'sep'].
   * at: { anchor: element, align: 'start'|'end' } or { x, y } (pointer position).
   * Resolves with the chosen value, or null when dismissed.
   */
  function menu(items, at = {}) {
    if (openMenu) openMenu.close(null, true);
    const opener = at.opener || document.activeElement;
    const hasChecks = items.some((i) => i && typeof i === 'object' && 'checked' in i);
    const m = document.createElement('div');
    m.className = 'menu glass';
    m.setAttribute('role', 'menu');
    m.tabIndex = -1;
    if (at.label) m.setAttribute('aria-label', at.label);
    const hl = document.createElement('div');
    hl.className = 'menu-hl';
    m.append(hl);
    const els = [];
    for (const it of items) {
      if (!it) continue;
      if (it === 'sep') {
        // no doubled or leading separators
        if (!els.length || m.lastChild.className === 'menu-sep') continue;
        const s = document.createElement('div'); s.className = 'menu-sep'; s.setAttribute('role', 'separator'); m.append(s);
        continue;
      }
      const b = document.createElement('div');
      b.className = 'menu-item' + (it.danger ? ' danger' : '');
      b.tabIndex = -1;
      b.setAttribute('role', 'checked' in it ? 'menuitemcheckbox' : 'menuitem');
      if ('checked' in it) b.setAttribute('aria-checked', String(!!it.checked));
      if (it.disabled) b.setAttribute('aria-disabled', 'true');
      if (hasChecks) { const c = svgUse('i-check', 'mi-check'); c.style.visibility = it.checked ? 'visible' : 'hidden'; b.append(c); }
      const l = document.createElement('span'); l.className = 'mi-label'; l.textContent = it.label; b.append(l);
      if (it.key) { const k = document.createElement('span'); k.className = 'mi-key'; k.textContent = it.key; b.append(k); }
      b._item = it;
      els.push(b);
      m.append(b);
    }
    if (m.lastChild.className === 'menu-sep') m.lastChild.remove();

    m.style.visibility = 'hidden';
    document.body.append(m);
    const w = m.offsetWidth; let hgt = m.offsetHeight;
    const W = innerWidth; const H = innerHeight; const pad = 8;
    if (hgt > H - pad * 2) { m.style.maxHeight = (H - pad * 2) + 'px'; m.style.overflowY = 'auto'; hgt = H - pad * 2; }
    let left; let top; let ox; let oy;
    if (at.anchor) {
      const r = at.anchor.getBoundingClientRect();
      left = at.align === 'end' ? r.right - w : r.left;
      top = r.bottom + 6;
      if (top + hgt > H - pad && r.top - 6 - hgt >= pad) top = r.top - 6 - hgt;
      left = Math.max(pad, Math.min(left, W - w - pad));
      top = Math.max(pad, Math.min(top, H - hgt - pad));
      ox = r.left + r.width / 2 - left;
      oy = top >= r.bottom ? 0 : top + hgt <= r.top ? hgt : r.top + r.height / 2 - top;
    } else {
      const x = at.x || 0; const y = at.y || 0;
      left = x + w > W - pad ? x - w : x;
      top = y + hgt > H - pad ? y - hgt : y;
      left = Math.max(pad, Math.min(left, W - w - pad));
      top = Math.max(pad, Math.min(top, H - hgt - pad));
      ox = x - left; oy = y - top;
    }
    m.style.left = Math.round(left) + 'px';
    m.style.top = Math.round(top) + 'px';
    m.style.setProperty('--ox', Math.round(Math.max(0, Math.min(w, ox))) + 'px');
    m.style.setProperty('--oy', Math.round(Math.max(0, Math.min(hgt, oy))) + 'px');
    m.style.visibility = '';
    if (at.anchor) at.anchor.setAttribute('aria-expanded', 'true');

    let active = -1;
    const enabled = (i) => els[i] && !els[i]._item.disabled;
    function setActive(i, jump) {
      if (active >= 0 && els[active]) els[active].classList.remove('active');
      active = i;
      if (i < 0) { hl.classList.remove('show'); m.focus({ preventScroll: true }); return; }
      const el = els[i];
      el.classList.add('active');
      hl.classList.toggle('jump', !!jump || !hl.classList.contains('show') || reduced());
      hl.classList.toggle('danger', !!el._item.danger);
      hl.style.transform = `translateY(${el.offsetTop}px)`;
      hl.style.height = el.offsetHeight + 'px';
      hl.classList.add('show');
      el.focus({ preventScroll: true });
      if (m.scrollHeight > m.clientHeight) el.scrollIntoView({ block: 'nearest' });
    }
    function step(from, dir) {
      for (let n = 1; n <= els.length; n++) {
        const i = (from + dir * n + els.length * 2) % els.length;
        if (enabled(i)) return i;
      }
      return -1;
    }

    let done = false;
    let resolve;
    const result = new Promise((r) => { resolve = r; });
    function close(value, instant) {
      if (done) return;
      done = true;
      openMenu = null;
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('contextmenu', outside, true);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('resize', dismiss);
      if (at.anchor) at.anchor.removeAttribute('aria-expanded');
      if (instant || reduced()) m.remove();
      else {
        m.classList.add('closing');
        setTimeout(() => m.remove(), 180);
      }
      if (value == null && opener && opener.isConnected && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
      resolve(value == null ? null : value);
    }
    function choose(i) {
      if (!enabled(i) || done) return;
      const it = els[i]._item;
      if (reduced()) return close(it.value);
      // a short blink of the highlight, as on the Mac, then close
      hl.animate([{ opacity: 1 }, { opacity: 0.35 }, { opacity: 1 }], { duration: 110 });
      done = true; // ignore further input during the blink
      setTimeout(() => { done = false; close(it.value); }, 110);
    }
    const outside = (e) => { if (!m.contains(e.target)) { lastOutside = { target: e.target, t: Date.now() }; close(null, e.type === 'contextmenu'); } };
    const dismiss = () => close(null);
    let typed = ''; let typedAt = 0;

    m.addEventListener('pointermove', (e) => {
      const el = e.target.closest('.menu-item');
      const i = el ? els.indexOf(el) : -1;
      if (i !== active) setActive(enabled(i) ? i : -1);
    });
    m.addEventListener('pointerleave', () => setActive(-1));
    m.addEventListener('click', (e) => { const el = e.target.closest('.menu-item'); if (el) choose(els.indexOf(el)); });
    m.addEventListener('contextmenu', (e) => e.preventDefault());
    m.addEventListener('keydown', (e) => {
      e.stopPropagation();
      const k = e.key;
      if (k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); const i = step(active < 0 ? (k === 'ArrowDown' ? -1 : els.length) : active, k === 'ArrowDown' ? 1 : -1); if (i >= 0) setActive(i); return; }
      if (k === 'Home' || k === 'PageUp') { e.preventDefault(); setActive(step(-1, 1)); return; }
      if (k === 'End' || k === 'PageDown') { e.preventDefault(); setActive(step(els.length, -1)); return; }
      if (k === 'Enter' || k === ' ') { e.preventDefault(); if (active >= 0) choose(active); return; }
      if (k === 'Escape') { e.preventDefault(); close(null); return; }
      if (k === 'Tab') { e.preventDefault(); close(null); return; }
      if (k.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && /\S/.test(k)) {
        // first-letter jump; typing quickly matches more letters
        const now = Date.now();
        typed = now - typedAt < 700 ? typed + k.toLowerCase() : k.toLowerCase();
        typedAt = now;
        const start = typed.length > 1 ? active - 1 : active;
        for (let n = 1; n <= els.length; n++) {
          const i = (start + n + els.length) % els.length;
          if (enabled(i) && els[i]._item.label.toLowerCase().startsWith(typed)) { setActive(i); break; }
        }
      }
    });
    setTimeout(() => {
      if (done) return;
      document.addEventListener('pointerdown', outside, true);
      document.addEventListener('contextmenu', outside, true);
      window.addEventListener('blur', dismiss);
      window.addEventListener('resize', dismiss);
    }, 0);

    openMenu = { close, el: m };
    if (at.keyboard) setActive(step(-1, 1), true); else m.focus({ preventScroll: true });
    return result;
  }

  // ---------------- morph: a tile flies from the list row into the account header ----------------
  let ghost = null;
  function flyTile(fromEl, toEl) {
    if (ghost) { ghost.remove(); ghost = null; }
    if (!fromEl || !toEl || reduced()) return;
    const a = fromEl.getBoundingClientRect(); const b = toEl.getBoundingClientRect();
    if (!a.width || !b.width || a.bottom < 0 || a.top > innerHeight) return;
    const g = toEl.cloneNode(true);
    g.removeAttribute('id');
    g.classList.add('tile-ghost');
    Object.assign(g.style, { position: 'fixed', left: b.left + 'px', top: b.top + 'px', margin: '0', zIndex: '50', pointerEvents: 'none', transformOrigin: '0 0' });
    document.body.append(g);
    ghost = g;
    toEl.style.opacity = '0';
    const s = a.width / b.width;
    const anim = g.animate([
      { transform: `translate(${a.left - b.left}px, ${a.top - b.top}px) scale(${s})` },
      { transform: 'none' },
    ], { duration: 560, easing: spring() });
    const end = () => { toEl.style.opacity = ''; g.remove(); if (ghost === g) ghost = null; };
    anim.onfinish = end; anim.oncancel = end;
  }

  window.fx = { menu, flyTile, reduced, spring, closedBy: (el) => !!lastOutside && Date.now() - lastOutside.t < 500 && el.contains(lastOutside.target), closeMenu: () => openMenu && openMenu.close(null, true), get menuOpen() { return !!openMenu; } };
})();
