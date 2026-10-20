// Top-down drawings of every piece of furniture, in metres in the piece's own frame:
// centred, x along its width, +y towards its front (the side the 3D model faces).
// The plan draws them in place; the catalog draws the same ones as thumbnails.
import { footprint } from '../three/furniture.js';

const NS = 'http://www.w3.org/2000/svg';

export function sv(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid);
  return el;
}

// Shapes: `body` is filled and outlined, `line` only outlined, `soft` a lighter fill.
const rect = (x, y, w, h, r = 0.03, cls = 'body') => sv('rect', { x, y, width: Math.max(0.001, w), height: Math.max(0.001, h), rx: r, class: `g-${cls}` });
const line = (x1, y1, x2, y2, cls = 'line') => sv('line', { x1, y1, x2, y2, class: `g-${cls}` });
const circle = (cx, cy, r, cls = 'body') => sv('circle', { cx, cy, r, class: `g-${cls}` });
const ellipse = (cx, cy, rx, ry, cls = 'body') => sv('ellipse', { cx, cy, rx, ry, class: `g-${cls}` });

// Seams across the front edge of a cabinet: where its doors or drawers meet.
function doorTicks(w, d, n, depth = 0.08) {
  const out = [];
  for (let i = 1; i < n; i++) {
    const x = -w / 2 + (w / n) * i;
    out.push(line(x, d / 2 - depth, x, d / 2));
  }
  return out;
}

function seating(w, d, cushions) {
  const arm = Math.min(0.2, w * 0.18);
  const back = 0.24;
  const inner = w - arm * 2;
  const parts = [
    rect(-w / 2, -d / 2, w, d, 0.08),
    rect(-w / 2 + arm, -d / 2 + 0.02, inner, back, 0.06, 'soft'),
    rect(-w / 2, -d / 2, arm, d, 0.07, 'soft'),
    rect(w / 2 - arm, -d / 2, arm, d, 0.07, 'soft'),
  ];
  const cw = inner / cushions;
  for (let i = 0; i < cushions; i++) {
    parts.push(rect(-w / 2 + arm + cw * i + 0.02, -d / 2 + back + 0.04, cw - 0.04, d - back - 0.1, 0.05, 'soft'));
  }
  return parts;
}

function chair(x, y, facing) {
  // A seat with its back on the far side from the table.
  const s = 0.42;
  return [rect(x - s / 2, y - s / 2, s, s, 0.06), line(x - s / 2 + 0.05, y - facing * (s / 2 - 0.05), x + s / 2 - 0.05, y - facing * (s / 2 - 0.05), 'strong')];
}

const DRAW = {
  bed(item, [w, d]) {
    const frame = rect(-w / 2, -d / 2, w, d, 0.05);
    const head = rect(-w / 2 - 0.03, -d / 2 - 0.03, w + 0.06, 0.12, 0.03, 'strong');
    const pw = w / 2 - 0.16;
    const pillows = [-1, 1].map((sx) => rect(sx * w / 4 - pw / 2, -d / 2 + 0.16, pw, 0.36, 0.08, 'soft'));
    const duvet = rect(-w / 2 + 0.02, -d / 2 + d * 0.36, w - 0.04, d * 0.62, 0.06, 'soft');
    return [frame, head, ...pillows, duvet, line(-w / 2 + 0.04, -d / 2 + d * 0.47, w / 2 - 0.04, -d / 2 + d * 0.47)];
  },
  sofa(item, [w, d]) { return seating(w, d, w > 2 ? 3 : 2); },
  armchair(item, [w, d]) { return seating(w, d, 1); },
  coffeeTable(item, [w, d]) {
    return [rect(-w / 2, -d / 2, w, d, 0.1), rect(-w / 2 + 0.08, -d / 2 + 0.07, w - 0.16, d - 0.14, 0.06, 'line')];
  },
  tv(item, [w, d]) {
    return [rect(-w / 2, -d / 2, w, d, 0.03), line(-w * 0.42, -d / 2 + 0.07, w * 0.42, -d / 2 + 0.07, 'strong'), ...doorTicks(w, d, 3)];
  },
  sideboard(item, [w, d]) { return [rect(-w / 2, -d / 2, w, d, 0.03), ...doorTicks(w, d, 4)]; },
  dresser(item, [w, d]) { return [rect(-w / 2, -d / 2, w, d, 0.03), ...doorTicks(w, d, 3)]; },
  diningSet(item) {
    const w = item.width || 1.8;
    const td = 0.95;
    const chairs = Math.max(0, Math.round(item.chairs ?? 6));
    const per = Math.ceil(chairs / 2);
    const parts = [];
    for (let i = 0; i < chairs; i++) {
      const side = i < per ? 1 : -1;
      const k = i < per ? i : i - per;
      const n = i < per ? per : chairs - per;
      parts.push(...chair(-w / 2 + (w / n) * (k + 0.5), side * (td / 2 + 0.16), side));
    }
    parts.push(rect(-w / 2, -td / 2, w, td, 0.05));
    return parts;
  },
  island(item) {
    const w = item.width || 2;
    const stools = Math.max(0, Math.round(item.stools ?? 3));
    const parts = [rect(-w / 2, -0.43, w, 0.86, 0.04)];
    for (let i = 0; i < stools; i++) parts.push(circle(-w / 2 + (w / stools) * (i + 0.5), 0.62, 0.16, 'soft'));
    return parts;
  },
  kitchen(item, [w, d]) {
    const parts = [rect(-w / 2, -d / 2, w, d, 0.02)];
    if (w >= 1.1) {
      parts.push(rect(-w / 4 - 0.27, -0.2, 0.54, 0.4, 0.06, 'line'), circle(-w / 4, -0.24, 0.025, 'strong'));
      const hx = w / 4;
      for (const [dx, dy, r] of [[-0.13, -0.11, 0.08], [0.13, -0.11, 0.065], [-0.13, 0.12, 0.065], [0.13, 0.12, 0.08]]) parts.push(circle(hx + dx, dy, r, 'line'));
    } else {
      parts.push(rect(-w / 2 + 0.1, -0.2, w - 0.2, 0.4, 0.06, 'line'));
    }
    return parts;
  },
  fridge(item, [w, d]) {
    return [rect(-w / 2, -d / 2, w, d, 0.04), line(-w / 2 + 0.04, d / 2 - 0.08, w / 2 - 0.04, d / 2 - 0.08), line(-w / 2 + 0.1, d / 2 - 0.02, -w / 2 + 0.1, d / 2 + 0.03, 'strong')];
  },
  nightstand(item, [w, d]) { return [rect(-w / 2, -d / 2, w, d, 0.04), circle(0, -0.02, 0.09, 'soft')]; },
  plant() {
    const parts = [circle(0, 0, 0.22, 'soft')];
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      parts.push(ellipse(Math.cos(a) * 0.12, Math.sin(a) * 0.12, 0.1, 0.06, 'leaf'));
      parts[parts.length - 1].setAttribute('transform', `rotate(${(a * 180) / Math.PI} ${Math.cos(a) * 0.12} ${Math.sin(a) * 0.12})`);
    }
    parts.push(circle(0, 0, 0.05, 'strong'));
    return parts;
  },
  vanity(item, [w, d]) {
    return [rect(-w / 2, -d / 2, w, d, 0.03), ellipse(0, 0.02, Math.min(0.2, w / 3), 0.15, 'line'), circle(0, -0.16, 0.02, 'strong')];
  },
  bathtub(item, [w, d]) {
    return [rect(-w / 2, -d / 2, w, d, 0.14), rect(-w / 2 + 0.09, -d / 2 + 0.09, w - 0.18, d - 0.18, 0.12, 'soft'), circle(-w / 2 + 0.24, 0, 0.035, 'strong')];
  },
  toilet(item, [w, d]) {
    return [rect(-0.19, -d / 2, 0.38, 0.17, 0.04), ellipse(0, -d / 2 + 0.38, 0.17, 0.23), ellipse(0, -d / 2 + 0.4, 0.1, 0.15, 'line')];
  },
  desk(item, [w, d]) {
    return [rect(-w / 2, -d / 2, w, d, 0.03), line(-0.28, -d / 2 + 0.12, 0.28, -d / 2 + 0.12, 'strong'), ...chair(0, d / 2 + 0.2, -1)];
  },
  wardrobe(item, [w, d]) {
    return [rect(-w / 2, -d / 2, w, d, 0.02), line(-w / 2 + 0.06, 0, w / 2 - 0.06, 0, 'dash'), ...doorTicks(w, d, Math.max(2, Math.round(w / 0.55)), 0.1)];
  },
  bookshelf(item, [w, d]) {
    const parts = [rect(-w / 2, -d / 2, w, d, 0.015)];
    for (let x = -w / 2 + 0.07; x < w / 2 - 0.05; x += 0.055) parts.push(line(x, -d / 2 + 0.05, x, d / 2 - 0.03));
    return parts;
  },
  counter(item, [w, d]) {
    const parts = [rect(-w / 2, -d / 2, w, d, 0.02), line(-w / 2 + 0.02, d / 2 - 0.05, w / 2 - 0.02, d / 2 - 0.05), ...doorTicks(w, d, Math.max(1, Math.round(w / 0.5)), 0.05)];
    if (item.sink === 'single' || item.sink === 'double') {
      const double = item.sink === 'double';
      const sw = Math.min(double ? 0.8 : 0.5, w - 0.1);
      const x = Math.min((w - sw) / 2, Math.max(-(w - sw) / 2, item.sinkAt || 0));
      const bw = double ? (sw - 0.07) / 2 : sw - 0.06;
      for (const bx of double ? [x - (bw + 0.02) / 2, x + (bw + 0.02) / 2] : [x]) parts.push(rect(bx - bw / 2, -0.15, bw, 0.36, 0.05, 'line'));
      parts.push(circle(x, -d / 2 + 0.1, 0.022, 'strong'));
    }
    return parts;
  },
  stove(item, [w, d]) {
    const bx = Math.min(0.17, w / 4.4);
    const parts = [rect(-w / 2, -d / 2, w, d, 0.03), line(-w / 2 + 0.02, -d / 2 + 0.08, w / 2 - 0.02, -d / 2 + 0.08, 'strong')];
    for (const [x, y, r] of [[-bx, -0.1, 0.1], [bx, -0.1, 0.08], [-bx, 0.16, 0.08], [bx, 0.16, 0.1]]) parts.push(circle(x, y, r, 'line'), circle(x, y, r * 0.45, 'line'));
    return parts;
  },
  microwave(item, [w, d]) {
    return [rect(-w / 2, -d / 2, w, d, 0.02), line(-w / 2 + 0.04, d / 2 - 0.05, w / 2 - 0.14, d / 2 - 0.05, 'strong'), line(w / 2 - 0.1, -d / 2 + 0.05, w / 2 - 0.1, d / 2 - 0.02)];
  },
  tvCabinet(item, [w, d]) {
    const sw = Math.max(0.4, item.tv ?? (item.width || 0.95) - 0.05);
    return [rect(-w / 2, -d / 2, w, d, 0.03), rect(-sw / 2, -0.12, sw, 0.05, 0.01, 'strong'), ...doorTicks(w, d, 2)];
  },
  beanBag(item, [w, d]) { return [ellipse(0, 0, w / 2, d / 2), ellipse(0, -d * 0.05, w * 0.28, d * 0.22, 'dash')]; },
  waterHeater(item, [w]) { return [circle(0, 0, w / 2), circle(0, 0, w / 2 - 0.05, 'line'), circle(-w * 0.25, -w * 0.15, 0.025, 'strong'), circle(w * 0.25, -w * 0.15, 0.025, 'strong')]; },
  chair(item, [w, d]) {
    return [rect(-w / 2 + 0.02, -d / 2 + 0.02, w - 0.04, d - 0.04, 0.05), line(-w / 2 + 0.04, -d / 2 + 0.04, w / 2 - 0.04, -d / 2 + 0.04, 'strong')];
  },
  closetRod(item, [w, d]) {
    const parts = item.clothes === false ? [] : [rect(-w / 2 + 0.04, -d / 2, w - 0.08, d, 0.04, 'soft')];
    parts.push(line(-w / 2, 0, w / 2, 0, 'dash'));
    for (let x = -w / 2 + 0.12; x < w / 2 - 0.08; x += 0.18) parts.push(line(x, -0.18, x, 0.18));
    return parts;
  },
  storageBins(item, [w, d]) {
    return [rect(-w / 2, -d / 2, w, d, 0.04), rect(-w / 2 + 0.05, -d / 2 + 0.05, w - 0.1, d - 0.1, 0.02, 'line'), line(-w * 0.2, d / 2 - 0.02, w * 0.2, d / 2 - 0.02, 'strong')];
  },
  shower(item, [w, d]) {
    return [rect(-w / 2, -d / 2, w, d, 0.03, 'soft'), rect(-w / 2 + 0.05, -d / 2 + 0.05, w - 0.1, d - 0.1, 0.04, 'line'), circle(0, 0, 0.04, 'strong')];
  },
  rug(item, [w, d]) {
    return [rect(-w / 2, -d / 2, w, d, 0.02, 'rug'), rect(-w / 2 + 0.12, -d / 2 + 0.12, w - 0.24, d - 0.24, 0.01, 'dash')];
  },
};

function tint(hex, alpha) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  if (Number.isNaN(n)) return null;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** The drawing of a piece of furniture as an SVG group in its own frame. */
export function glyph(item) {
  const size = footprint(item);
  const draw = DRAW[item.type];
  const g = sv('g', { class: `glyph g-${item.type}` }, draw ? draw(item, size) : rect(-size[0] / 2, -size[1] / 2, size[0], size[1]));
  // A coloured piece shows its colour (a rug is mostly colour).
  if (item.color) g.style.setProperty('--g-fill', tint(item.color, item.type === 'rug' ? 0.55 : 0.42));
  return g;
}

/** The extent of the drawing (some reach past the footprint: chairs, stools). */
export function glyphBox(item) {
  const [w, d] = footprint(item);
  if (item.type === 'diningSet') return [w, 1.9];
  if (item.type === 'island') return [w, 1.6];
  if (item.type === 'desk') return [w, d + 0.85];
  return [w, d];
}

/** A catalog thumbnail: the piece drawn to fit a square, front down. */
export function thumbnail(item, px = 44) {
  const [w, d] = glyphBox(item);
  const s = Math.max(w, d) * 1.12;
  const offY = item.type === 'island' ? 0.25 : item.type === 'desk' ? 0.42 : 0;
  return sv('svg', { class: 'glyph-thumb', width: px, height: px, viewBox: `${-s / 2} ${-s / 2 + offY} ${s} ${s}`, 'aria-hidden': 'true' }, glyph(item));
}
