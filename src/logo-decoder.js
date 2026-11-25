'use strict';
/* Turns a downloaded site icon (PNG, ICO, JPEG, GIF, WebP, SVG…) into a plain square PNG.
   SVGs are drawn through an <img>, where scripts and external resources never run.
   Also works out the logo's main colour and the background it should sit on. */

const hex = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

function analyse(data, n) {
  // background: the border's colour if the icon is full-bleed, else white (or dark for a white logo)
  let edgeA = 0; let edgeN = 0; const edge = [0, 0, 0];
  const px = (x, y) => (y * n + x) * 4;
  for (let i = 0; i < n; i++) {
    for (const [x, y] of [[i, 0], [i, n - 1], [0, i], [n - 1, i]]) {
      const p = px(x, y); edgeN++;
      if (data[p + 3] > 220) { edgeA++; edge[0] += data[p]; edge[1] += data[p + 1]; edge[2] += data[p + 2]; }
    }
  }
  const opaqueEdge = edgeA / edgeN > 0.9;

  // main colour: the biggest group of saturated pixels; failing that, the biggest non-white group
  const buckets = new Map(); let opaque = 0; let lightSum = 0;
  for (let p = 0; p < data.length; p += 4) {
    const a = data[p + 3];
    if (a < 160) continue;
    const r = data[p]; const g = data[p + 1]; const b = data[p + 2];
    opaque++;
    const mx = Math.max(r, g, b); const mn = Math.min(r, g, b);
    lightSum += (mx + mn) / 510;
    if (mn > 236) continue; // near white
    const sat = mx === 0 ? 0 : (mx - mn) / mx;
    const key = (r >> 5) << 6 | (g >> 5) << 3 | (b >> 5);
    const e = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0, sat: 0, v: 0 };
    e.n++; e.r += r; e.g += g; e.b += b; e.sat += sat; e.v += mx / 255;
    buckets.set(key, e);
  }
  const all = [...buckets.values()];
  const colourful = all.filter((e) => e.sat / e.n > 0.28 && (e.r + e.g + e.b) / e.n / 3 > 28);
  const colourfulShare = colourful.reduce((s, e) => s + e.n, 0) / Math.max(1, opaque);
  const pool = colourful.length && colourfulShare > 0.04 ? colourful : all;
  // the brand colour: plenty of pixels, saturated and bright (not the dark outline or shadow)
  const weight = (e) => e.n * (1 + e.sat / e.n) * (0.35 + e.v / e.n);
  pool.sort((a, b) => weight(b) - weight(a));
  const top = pool[0];
  const color = top ? hex(top.r / top.n, top.g / top.n, top.b / top.n) : null;
  let bg;
  if (opaqueEdge) bg = hex(edge[0] / edgeA, edge[1] / edgeA, edge[2] / edgeA);
  else bg = opaque && lightSum / opaque > 0.86 ? '#1c1c1f' : '#ffffff';
  return { color, bg, fullBleed: opaqueEdge };
}

window.decoder.onDecode(async (id, bytes, mime, size) => {
  let url = null;
  try {
    url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const svg = mime === 'image/svg+xml';
    const w = img.naturalWidth || (svg ? size : 0); const h = img.naturalHeight || (svg ? size : 0);
    if (!w || !h || w > 8192 || h > 8192) throw new Error('bad size');
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    const s = Math.min(size / w, size / h);
    const dw = w * s; const dh = h * s;
    ctx.drawImage(img, (size - dw) / 2, (size - dh) / 2, dw, dh);
    const { data } = ctx.getImageData(0, 0, size, size);
    let visible = 0;
    for (let p = 3; p < data.length; p += 4) if (data[p] > 16) visible++;
    if (visible < size * size * 0.02) throw new Error('empty');
    const a = analyse(data, size);
    window.decoder.done(id, { png: c.toDataURL('image/png'), w, h, color: a.color, bg: a.bg });
  } catch {
    window.decoder.done(id, null);
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
});
