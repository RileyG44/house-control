// The editor's 2D plan: an SVG of the home seen from straight above (x east to the right,
// z south downwards, like the 3D view when it looks down). Two layers: the world layer is
// drawn in metres under one pan/zoom transform; the overlay (labels, lamp markers,
// selection, handles, guides) is laid out in screen pixels so it stays crisp at any zoom.
// Every pointer (mouse, pen, finger) goes through one hit test in metres.
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { haptic } from '../bridge.js';
import { wallSegments, wallJoints } from '../three/house.js';
import { footprint } from '../three/furniture.js';
import { edgeDist, labelPoint, along, lineOf } from '../geom.js';
import { MODE_COLORS } from '../three/ac.js';
import { isLinked } from '../config.js';
import { sv, glyph } from './glyphs.js';
import * as M from './model.js';

const FLOOR_FILL = { oak: '#4d3f30', walnut: '#3d3029', tile: '#3a434d', stone: '#31363e' };
const EXT_T = 0.2;
const INT_T = 0.1;
const AC_DIR = { north: 0, south: 180, west: -90, east: 90 }; // turns the unit's local +y into the room
const PAD = 26;          // air around the home when it is fitted
const SNAP_PX = 10;      // edges closer than this on screen snap together
const HOLD_MS = 300;     // touch and hold to pick something up
const ZOOM = [0.5, 8];   // relative to the fitted scale
const UNDER = new Set(['rug', 'shower']); // lie on the floor, under everything else

let uid = 0;

export function createPlan(ctl) {
  const id = `ed${++uid}`;
  const svg = sv('svg', { class: 'ed-svg', tabindex: 0, role: 'application', 'aria-label': 'Floor plan. Tab moves between rooms and devices, arrow keys move the selected one.' });
  const defs = sv('defs');
  const world = sv('g', { class: 'ed-world' });
  const overlay = sv('g', { class: 'ed-overlay' });
  svg.append(defs, world, overlay);
  const hint = h('div.ed-draw-hint', { hidden: true },
    h('span', icon('draw', 16, 2), 'Drag to draw the room'),
    h('button.ed-chip-btn', { type: 'button', onclick: () => ctl.onDrawCancel() }, 'Cancel'));
  const el = h('div.ed-plan', svg, hint);

  let view = { s: 40, tx: 0, ty: 0 };
  let fitS = 40;
  let userMoved = false;
  let anim = 0;
  let size = { w: 0, h: 0 };

  // What the overlay draws on top of the doc: guides and pills of a gesture, the hovered
  // item, a lifted item, freshly added ones dropping in.
  const fx = { guides: [], pills: [], hover: null, lifted: null, drops: new Map(), drawing: null };
  let handles = [];

  /* ---------- patterns ---------- */

  defs.append(
    sv('pattern', { id: `${id}-dots`, width: 0.5, height: 0.5, patternUnits: 'userSpaceOnUse' },
      sv('circle', { cx: 0, cy: 0, r: 0.02, class: 'ed-dot' }), sv('circle', { cx: 0.5, cy: 0, r: 0.02, class: 'ed-dot' }),
      sv('circle', { cx: 0, cy: 0.5, r: 0.02, class: 'ed-dot' }), sv('circle', { cx: 0.5, cy: 0.5, r: 0.02, class: 'ed-dot' })),
    sv('pattern', { id: `${id}-dots1`, width: 1, height: 1, patternUnits: 'userSpaceOnUse' },
      ...[[0, 0], [1, 0], [0, 1], [1, 1]].map(([cx, cy]) => sv('circle', { cx, cy, r: 0.03, class: 'ed-dot strong' }))),
    sv('pattern', { id: `${id}-planks`, width: 1.2, height: 0.36, patternUnits: 'userSpaceOnUse' },
      sv('path', { d: 'M0 0.18H1.2M0 0.36H1.2M0 0V0.18M0.6 0.18V0.36', class: 'ed-pat' })),
    sv('pattern', { id: `${id}-tile`, width: 0.3, height: 0.3, patternUnits: 'userSpaceOnUse' },
      sv('path', { d: 'M0 0H0.3M0 0V0.3', class: 'ed-pat light' })),
    sv('pattern', { id: `${id}-stone`, width: 0.6, height: 0.6, patternUnits: 'userSpaceOnUse' },
      sv('path', { d: 'M0 0H0.6M0 0V0.6', class: 'ed-pat light' })),
  );
  const PATTERN = { oak: 'planks', walnut: 'planks', tile: 'tile', stone: 'stone' };

  /* ---------- coordinates ---------- */

  const toScreen = ([x, z]) => [x * view.s + view.tx, z * view.s + view.ty];
  const toWorld = (sx, sy) => [(sx - view.tx) / view.s, (sy - view.ty) / view.s];
  const local = (ev) => {
    const r = svg.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
  };

  // The part of the plan not covered by the top bar, the sheet or the docked card.
  function visibleArea() {
    const ins = ctl.insets();
    return { left: ins.left, top: ins.top, right: size.w - ins.right, bottom: size.h - ins.bottom };
  }

  function fitTarget(box = M.bounds(ctl.doc()), pad = PAD) {
    const a = visibleArea();
    const aw = Math.max(80, a.right - a.left - pad * 2);
    const ah = Math.max(80, a.bottom - a.top - pad * 2);
    const bw = Math.max(1, box.maxX - box.minX);
    const bh = Math.max(1, box.maxZ - box.minZ);
    const s = Math.min(aw / bw, ah / bh);
    return {
      s,
      tx: (a.left + a.right) / 2 - ((box.minX + box.maxX) / 2) * s,
      ty: (a.top + a.bottom) / 2 - ((box.minZ + box.maxZ) / 2) * s,
    };
  }

  function applyView() {
    world.setAttribute('transform', `matrix(${view.s} 0 0 ${view.s} ${view.tx} ${view.ty})`);
    // The dot grid fades away when zoomed far out, and its dots stay a pixel or two wide.
    const fade = Math.max(0, Math.min(1, (view.s - 14) / 22));
    grid.style.opacity = String(fade);
    for (const c of defs.querySelectorAll('.ed-dot')) c.setAttribute('r', String((c.classList.contains('strong') ? 1.5 : 1) / view.s));
    renderOverlay();
    ctl.onView?.();
  }

  let settle = null; // resolves the move in progress, also when another one replaces it
  function setView(next, { animate = 0 } = {}) {
    cancelAnimationFrame(anim);
    anim = 0;
    settle?.();
    settle = null;
    if (!next) return Promise.resolve();
    if (!animate) { view = { ...next }; applyView(); return Promise.resolve(); }
    const from = { ...view };
    const t0 = performance.now();
    // The world point at the middle of the plan travels in a straight line while the
    // scale changes geometrically, so a zoom and a pan read as one movement.
    const mx = size.w / 2;
    const my = size.h / 2;
    const c0 = [(mx - from.tx) / from.s, (my - from.ty) / from.s];
    const c1 = [(mx - next.tx) / next.s, (my - next.ty) / next.s];
    return new Promise((resolve) => {
      settle = resolve;
      const step = (now) => {
        const p = Math.min(1, (now - t0) / animate);
        const e = 1 - (1 - p) ** 3;
        const s = from.s * (next.s / from.s) ** e;
        const cx = c0[0] + (c1[0] - c0[0]) * e;
        const cy = c0[1] + (c1[1] - c0[1]) * e;
        view = p >= 1 ? { ...next } : { s, tx: mx - cx * s, ty: my - cy * s };
        applyView();
        if (p < 1) anim = requestAnimationFrame(step); else { anim = 0; settle = null; resolve(); }
      };
      anim = requestAnimationFrame(step);
    });
  }

  function clampScale(s) {
    return Math.min(fitS * ZOOM[1], Math.max(fitS * ZOOM[0], s));
  }

  function zoomAt(sx, sy, factor) {
    const s = clampScale(view.s * factor);
    const k = s / view.s;
    view = { s, tx: sx - (sx - view.tx) * k, ty: sy - (sy - view.ty) * k };
    userMoved = true;
    applyView();
  }

  function fit({ animate = 320 } = {}) {
    const t = fitTarget();
    fitS = t.s;
    userMoved = false;
    return setView(t, { animate });
  }

  // Brings something into the visible part (above the sheet), moving as little as possible.
  function reveal(box, { animate = 320, margin = 28 } = {}) {
    if (!box) return Promise.resolve();
    const a = visibleArea();
    // Hardly any plan shows (the sheet is up): moving it now would only shrink it.
    if (a.bottom - a.top < 140 || a.right - a.left < 140) return Promise.resolve();
    const [x0, y0] = toScreen([box.minX, box.minZ]);
    const [x1, y1] = toScreen([box.maxX, box.maxZ]);
    const aw = a.right - a.left - margin * 2;
    const ah = a.bottom - a.top - margin * 2;
    let { s, tx, ty } = view;
    if (x1 - x0 > aw || y1 - y0 > ah) {
      // Too big at this zoom: zoom out until it fits.
      const t = fitTarget(box, margin);
      s = Math.min(view.s, t.s);
      tx = (a.left + a.right) / 2 - ((box.minX + box.maxX) / 2) * s;
      ty = (a.top + a.bottom) / 2 - ((box.minZ + box.maxZ) / 2) * s;
    } else {
      if (x0 < a.left + margin) tx += a.left + margin - x0;
      else if (x1 > a.right - margin) tx -= x1 - (a.right - margin);
      if (y0 < a.top + margin) ty += a.top + margin - y0;
      else if (y1 > a.bottom - margin) ty -= y1 - (a.bottom - margin);
    }
    if (Math.abs(s - view.s) < 1e-6 && Math.abs(tx - view.tx) < 0.5 && Math.abs(ty - view.ty) < 0.5) return Promise.resolve();
    userMoved = true;
    return setView({ s, tx, ty }, { animate });
  }

  /* ---------- world layer ---------- */

  const grid = sv('g', { class: 'ed-grid' });

  function adapter(doc) {
    return {
      rooms: doc.rooms.map((r) => ({ id: r.id, points: M.pointsOf(r), area: M.area(r) })),
      openings: doc.openings.filter((o) => o.from && o.to)
        .map((o) => ({ ...o, type: o.type || 'door', sill: o.sill ?? 0.85, head: o.head ?? 2.1, src: o })),
    };
  }

  // A band `t` wide along a..b metres of a segment (from its `from` end), as polygon corners.
  function band(s, a, b, t) {
    const [ux, uz] = s.dir;
    const [nx, nz] = [-uz, ux];
    const p = (d, k) => `${s.from[0] + ux * d + nx * k},${s.from[1] + uz * d + nz * k}`;
    return [p(a, -t / 2), p(b, -t / 2), p(b, t / 2), p(a, t / 2)].join(' ');
  }

  const wrap = (key, cls, attrs, ...kids) => sv('g', { 'data-k': key, class: `ed-item ${cls}`, ...attrs }, sv('g', { class: 'ed-body' }, ...kids));

  function renderWorld() {
    const doc = ctl.doc();
    const sel = ctl.sel();
    const b = M.bounds(doc);
    const far = 40;
    grid.replaceChildren(
      sv('rect', { x: b.minX - far, y: b.minZ - far, width: b.maxX - b.minX + far * 2, height: b.maxZ - b.minZ + far * 2, fill: `url(#${id}-dots)` }),
      sv('rect', { x: b.minX - far, y: b.minZ - far, width: b.maxX - b.minX + far * 2, height: b.maxZ - b.minZ + far * 2, fill: `url(#${id}-dots1)` }));

    // Larger rooms first, so a room drawn inside another sits on top of it.
    const floors = sv('g', { class: 'ed-floors' });
    const order = doc.rooms.map((r, i) => [r, i]).sort((p, q) => M.area(q[0]) - M.area(p[0]));
    for (const [r] of order) {
      const kind = FLOOR_FILL[r.floor] ? r.floor : 'oak';
      const shape = (attrs) => {
        if (M.isPoly(r)) return sv('polygon', { points: r.poly.map((p) => p.join(',')).join(' '), ...attrs });
        const [x, z, w, d] = r.rect;
        return sv('rect', { x, y: z, width: w, height: d, ...attrs });
      };
      floors.append(wrap(`room:${r.id}`, `ed-floor${M.sameSel(sel, { kind: 'room', id: r.id }) ? ' sel' : ''}`, {},
        shape({ fill: FLOOR_FILL[kind] }),
        shape({ fill: `url(#${id}-${PATTERN[kind]})`, class: 'ed-floor-pat' })));
    }

    const walls = sv('g', { class: 'ed-walls' });
    const glass = sv('g', { class: 'ed-windows' });
    const conf = adapter(doc);
    const segments = wallSegments(conf);
    const solid = new Set();
    for (const s of segments) {
      const ext = s.kind === 'exterior';
      const t = ext ? EXT_T : INT_T;
      const a = s.extA ? -EXT_T / 2 : 0;
      const bb = s.len + (s.extB ? EXT_T / 2 : 0);
      const type = s.opening?.type;
      if (type === 'door') continue;
      if (type === 'open') {
        if (s.opening.curtain) glass.append(sv('line', { x1: s.from[0], y1: s.from[1], x2: s.to[0], y2: s.to[1], class: 'ed-curtain' }));
        continue;
      }
      if (type === 'window') {
        glass.append(windowGlyph(s, t));
        continue;
      }
      solid.add(s);
      walls.append(sv('polygon', { points: band(s, a, bb, t), class: ext ? 'ext' : 'int' }));
    }
    // Walls meeting at an angle: a round joint, like the 3D view's column.
    for (const j of wallJoints(segments)) {
      const meet = j.segs.filter((s) => solid.has(s));
      if (!meet.length) continue;
      const ext = meet.some((s) => s.kind === 'exterior');
      walls.append(sv('circle', { cx: j.p[0], cy: j.p[1], r: (ext ? EXT_T : INT_T) / 2, class: ext ? 'ext' : 'int' }));
    }

    const openings = sv('g', { class: 'ed-openings' });
    const lines = M.wallLines(doc);
    doc.openings.forEach((o, i) => {
      if (!o.from || !o.to) return;
      const on = M.wallOf(doc, o, lines);
      const key = `opening:${i}`;
      const kids = [];
      if (!on) {
        // Off every wall line: drawn where it is, outlined so it reads as out of place.
        const len = Math.hypot(o.to[0] - o.from[0], o.to[1] - o.from[1]);
        const s = { from: o.from, dir: len ? [(o.to[0] - o.from[0]) / len, (o.to[1] - o.from[1]) / len] : [1, 0], len };
        if ((o.type || 'door') === 'window') kids.push(windowGlyph(s, EXT_T));
        kids.push(sv('polygon', { points: band(s, 0, len, 0.24), class: 'ed-astray' }));
      }
      if ((o.type || 'door') === 'door') kids.push(...doorGlyph(doc, o));
      // A wide invisible stroke makes the gap itself a target for the pointer.
      kids.push(sv('line', { x1: o.from[0], y1: o.from[1], x2: o.to[0], y2: o.to[1], class: 'ed-open-hit' }));
      openings.append(wrap(key, `ed-opening ${o.type || 'door'}`, {}, ...kids));
    });

    const furniture = sv('g', { class: 'ed-furniture' });
    doc.furniture.forEach((f, i) => {
      if (!Array.isArray(f.pos)) return;
      const [w, d] = footprint(f);
      const outside = !M.roomAt(doc, f.pos);
      furniture.append(wrap(`furniture:${i}`, `ed-furn${UNDER.has(f.type) ? ' rug' : ''}`, { transform: `translate(${f.pos[0]} ${f.pos[1]}) rotate(${-(f.rot || 0)})` },
        glyph(f),
        outside ? sv('rect', { x: -w / 2 - 0.06, y: -d / 2 - 0.06, width: w + 0.12, height: d + 0.12, rx: 0.06, class: 'ed-astray' }) : null));
    });
    // Rugs and shower trays lie under everything else.
    for (const rug of [...furniture.querySelectorAll('.rug')]) furniture.prepend(rug);

    const acs = sv('g', { class: 'ed-acs' });
    for (const a of doc.acs) {
      if (!a.pos) continue;
      acs.append(wrap(`ac:${a.id}`, 'ed-ac', { transform: `translate(${a.pos[0]} ${a.pos[1]}) rotate(${AC_DIR[a.wall] ?? 0})` },
        sv('rect', { x: -0.45, y: 0.1, width: 0.9, height: 0.22, rx: 0.06, class: 'ed-ac-body' }),
        sv('line', { x1: -0.38, y1: 0.27, x2: 0.38, y2: 0.27, class: 'ed-ac-vent' })));
    }

    const strips = sv('g', { class: 'ed-strips' });
    for (const l of doc.lights) {
      if (l.type !== 'strip' || !l.pos) continue;
      const len = l.length || 1;
      const live = ctl.live(l.id);
      const g = wrap(`strip:${l.id}`, `ed-strip${live?.on ? ' on' : ''}`, { transform: `translate(${l.pos[0]} ${l.pos[1]}) rotate(${-(l.rot || 0)})` },
        sv('rect', { x: -len / 2, y: -0.05, width: len, height: 0.1, rx: 0.05 }));
      if (live?.on) g.style.setProperty('--c', live.color);
      strips.append(g);
    }

    world.replaceChildren(grid, floors, furniture, walls, glass, openings, acs, strips);
    for (const [key] of fx.drops) world.querySelector(`[data-k="${CSS.escape(key)}"]`)?.classList.add('drop');
    if (fx.lifted) world.querySelector(`[data-k="${CSS.escape(fx.lifted)}"]`)?.classList.add('lifted');
  }

  // Two pale lines in the gap of the wall, closed at the ends: a window, at any angle.
  function windowGlyph(s, t) {
    const [ux, uz] = s.dir;
    const [nx, nz] = [-uz, ux];
    const p = (d, k) => [s.from[0] + ux * d + nx * k, s.from[1] + uz * d + nz * k];
    const off = t / 4;
    const lines = [[p(0, -off), p(s.len, -off)], [p(0, off), p(s.len, off)], [p(0, -t / 2), p(0, t / 2)], [p(s.len, -t / 2), p(s.len, t / 2)]];
    return sv('g', { class: 'ed-window' }, lines.map(([[x1, y1], [x2, y2]]) => sv('line', { x1, y1, x2, y2 })));
  }

  // The leaf on its hinge and its quarter-circle swing, into the room it opens into
  // (`swing`, by default the smaller of the two rooms it joins).
  function doorGlyph(doc, o) {
    const len = Math.hypot(o.to[0] - o.from[0], o.to[1] - o.from[1]) || 1;
    const n = [-(o.to[1] - o.from[1]) / len, (o.to[0] - o.from[0]) / len];
    const mid = [(o.from[0] + o.to[0]) / 2, (o.from[1] + o.to[1]) / 2];
    const swing = M.swingOf(doc, o);
    const at = (sign) => [mid[0] + n[0] * sign * 0.15, mid[1] + n[1] * sign * 0.15];
    const sideOf = (sign) => M.roomAt(doc, at(sign));
    const side = swing === 'out' ? (sideOf(1) ? -1 : 1) : (sideOf(1)?.id === swing ? 1 : -1);
    const [hinge, other] = o.hinge === 'to' ? [o.to, o.from] : [o.from, o.to];
    const w = len;
    const leaf = [hinge[0] + n[0] * side * w, hinge[1] + n[1] * side * w];
    // Sweep direction: whichever way turns from the leaf to the other jamb.
    const cross = (leaf[0] - hinge[0]) * (other[1] - hinge[1]) - (leaf[1] - hinge[1]) * (other[0] - hinge[0]);
    const sweep = cross > 0 ? 1 : 0;
    return [
      sv('path', { d: `M${hinge[0]} ${hinge[1]}L${leaf[0]} ${leaf[1]}A${w} ${w} 0 0 ${sweep} ${other[0]} ${other[1]}Z`, class: 'ed-door-swing' }),
      sv('line', { x1: hinge[0], y1: hinge[1], x2: leaf[0], y2: leaf[1], class: 'ed-door-leaf' }),
    ];
  }

  /* ---------- overlay ---------- */

  const NSX = 'http://www.w3.org/2000/svg';
  function svgIcon(name, px, x, y, stroke = 2) {
    const ic = icon(name, px, stroke);
    ic.setAttribute('x', x);
    ic.setAttribute('y', y);
    return ic;
  }

  function text(x, y, str, cls) {
    const t = document.createElementNS(NSX, 'text');
    t.setAttribute('x', x);
    t.setAttribute('y', y);
    t.setAttribute('class', cls);
    t.textContent = str;
    return t;
  }

  function pill(x, y, str, cls = '') {
    const w = Math.max(30, str.length * 6.7 + 16);
    return sv('g', { class: `ed-pill ${cls}`, transform: `translate(${x} ${y})` },
      sv('rect', { x: -w / 2, y: -11, width: w, height: 22, rx: 11 }),
      text(0, 4, str, 'ed-pill-text'));
  }

  function knob(x, y, extra = {}) {
    return sv('circle', { cx: x, cy: y, r: 7, class: 'ed-knob', ...extra });
  }

  function renderOverlay() {
    const doc = ctl.doc();
    const sel = ctl.sel();
    const units = ctl.units();
    const item = M.itemOf(doc, sel);
    handles = [];
    const labels = sv('g', { class: 'ed-labels' });
    const marks = sv('g', { class: 'ed-marks' });
    const selection = sv('g', { class: 'ed-selection' });
    const hs = sv('g', { class: 'ed-handles' });
    const guides = sv('g', { class: 'ed-guides' });
    const pills = sv('g', { class: 'ed-pills' });

    // Room names, hidden when the room is too small on screen to hold them.
    const spots = [...doc.lights.filter((l) => l.pos).map((l) => toScreen(l.pos)), ...doc.acs.filter((a) => a.pos).map((a) => toScreen(acBadge(a)))];
    for (const r of doc.rooms) {
      const { w, d } = M.rectOf(r);
      let at = M.centerOf('room', r);
      let sw = w * view.s;
      let sh = d * view.s;
      if (M.isPoly(r)) {
        // The room is only as roomy as the widest place inside it: about twice the
        // distance from the label to the nearest wall, and wider than tall when it can be.
        at = labelPoint(r.poly);
        const free = edgeDist(r.poly, at) * 2 * view.s;
        sw = Math.min(sw, free * 1.6);
        sh = Math.min(sh, free);
      }
      const [cx, cy] = toScreen(at);
      const name = r.name || r.id;
      // Keep the label clear of the lamps standing at the room's centre.
      if (sw < name.length * 7.4 + 12 || sh < 26) continue;
      const showSize = sh >= 44 && sw >= 74;
      const sizeText = sw >= 112 && !M.isPoly(r) ? M.fmtSize(w, d, units) : M.fmtArea(M.area(r), units);
      // A lamp at the middle of the room would sit on the label: it steps aside, up or down.
      const half = [Math.max(name.length * 7.4, showSize ? sizeText.length * 6.2 : 0) / 2 + 4, showSize ? 19 : 11];
      const room = Math.max(0, sh / 2 - half[1] - 4);
      const shift = [0, 30, -30, 46, -46].filter((dy) => Math.abs(dy) <= room || !dy)
        .find((dy) => !spots.some(([mx, my]) => Math.abs(mx - cx) < half[0] + 13 && Math.abs(my - (cy + 5 + dy)) < half[1] + 13)) ?? 0;
      labels.append(text(cx, (showSize ? cy - 2 : cy + 4) + shift, name, 'ed-room-name'));
      if (showSize) labels.append(text(cx, cy + 13 + shift, sizeText, 'ed-room-size'));
    }

    // Lamps and ACs as markers in screen pixels.
    for (const l of doc.lights) {
      if (!l.pos) continue;
      const [x, y] = toScreen(l.pos);
      const live = ctl.live(l.id);
      const selected = M.sameSel(sel, { kind: 'light', id: l.id });
      const key = `light:${l.id}`;
      const g = sv('g', { 'data-k': key, class: `ed-marker${live?.on ? ' on' : ''}${isLinked(l) ? '' : ' sim'}${selected ? ' sel' : ''}${fx.hover === key ? ' hover' : ''}${fx.lifted === key ? ' lifted' : ''}`, transform: `translate(${x} ${y})` },
        sv('g', { class: 'ed-body' },
          sv('circle', { r: 12, class: 'ed-marker-bg' }),
          sv('circle', { r: 12, class: 'ed-marker-ring' }),
          svgIcon(l.type === 'strip' ? 'strip' : l.type, 14, -7, -7)));
      if (live?.on) g.style.setProperty('--c', live.color);
      if (fx.drops.has(key)) g.classList.add('drop');
      marks.append(g);
    }
    for (const a of doc.acs) {
      if (!a.pos) continue;
      const [x, y] = toScreen(acBadge(a));
      const live = ctl.liveAC?.(a.id);
      const key = `ac:${a.id}`;
      const g = sv('g', { 'data-k': key, class: `ed-badge${live?.on ? ' on' : ''}${isLinked(a) ? '' : ' sim'}${M.sameSel(sel, { kind: 'ac', id: a.id }) ? ' sel' : ''}${fx.hover === key ? ' hover' : ''}`, transform: `translate(${x} ${y})` },
        sv('g', { class: 'ed-body' },
          sv('rect', { x: -13, y: -11, width: 26, height: 22, rx: 8, class: 'ed-marker-bg' }),
          sv('rect', { x: -13, y: -11, width: 26, height: 22, rx: 8, class: 'ed-marker-ring' }),
          svgIcon('ac', 14, -7, -7)));
      if (live?.on) g.style.setProperty('--c', MODE_COLORS[live.mode] || '#5db2ff');
      if (fx.drops.has(key)) g.classList.add('drop');
      marks.append(g);
    }

    // Hover outline (mouse) for things without a marker.
    if (fx.hover && !fx.hover.startsWith('light:') && !fx.hover.startsWith('ac:') && !M.sameSel(sel, keySel(fx.hover))) {
      const shape = outline(doc, keySel(fx.hover));
      if (shape) { shape.classList.add('hover'); selection.append(shape); }
    }

    if (item) {
      const shape = outline(doc, sel);
      if (shape) selection.append(shape);
      addHandles(doc, sel, item, hs);
    }

    for (const g of fx.guides) {
      if (g.axis === 'x') { const [sx] = toScreen([g.at, 0]); guides.append(sv('line', { x1: sx, y1: -10, x2: sx, y2: size.h + 10 })); } else { const [, sy] = toScreen([0, g.at]); guides.append(sv('line', { x1: -10, y1: sy, x2: size.w + 10, y2: sy })); }
    }
    if (fx.angle) {
      const [x1, y1] = toScreen(fx.angle.from);
      const [x2, y2] = toScreen(fx.angle.to);
      guides.append(sv('line', { x1, y1, x2, y2 }));
    }
    if (fx.corner && sel?.kind === 'room') {
      const [x, y] = toScreen(fx.corner);
      selection.append(sv('circle', { cx: x, cy: y, r: 11, class: 'ed-corner-mark' }));
    }
    for (const p of fx.pills) {
      const [x, y] = toScreen(p.at);
      pills.append(pill(x + (p.dx || 0), y + (p.dy || 0), p.text, p.cls));
    }
    if (fx.drawing?.rect) {
      const { rect } = fx.drawing;
      const [x0, y0] = toScreen([rect[0], rect[1]]);
      const [x1, y1] = toScreen([rect[0] + rect[2], rect[1] + rect[3]]);
      selection.append(sv('rect', { x: x0, y: y0, width: x1 - x0, height: y1 - y0, class: `ed-draw-rect${rect[2] < 0.8 || rect[3] < 0.8 ? ' small' : ''}` }));
      if (rect[2] > 0.05 && rect[3] > 0.05) pills.append(pill((x0 + x1) / 2, (y0 + y1) / 2, M.fmtSize(rect[2], rect[3], units)));
    }
    // Rings that spread from something just added.
    for (const [key, d] of fx.drops) {
      const s = keySel(key);
      const it = M.itemOf(doc, s);
      if (!it) continue;
      const c = M.centerOf(s.kind, it);
      if (!c) continue;
      const [x, y] = toScreen(c);
      const box = M.boxOf(s.kind, it);
      const r = Math.max(18, Math.min(120, (Math.max(box.maxX - box.minX, box.maxZ - box.minZ) * view.s) / 2 + 8));
      selection.append(sv('circle', { cx: x, cy: y, r, class: 'ed-drop-ring', style: `animation-delay:${-Math.min(300, performance.now() - d)}ms` }));
    }

    overlay.replaceChildren(labels, selection, marks, guides, hs, pills);
  }

  const keySel = (key) => {
    const [kind, rest] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    if (kind === 'strip') return { kind: 'light', id: rest };
    return M.BY_ID.has(kind) ? { kind, id: rest } : { kind, index: Number(rest) };
  };
  const selKey = (s) => (s ? `${s.kind}:${M.BY_ID.has(s.kind) ? s.id : s.index}` : null);

  // An AC's marker sits on its unit, a little into the room.
  function acBadge(a) {
    const n = { north: [0, 1], south: [0, -1], west: [1, 0], east: [-1, 0] }[a.wall] || [0, 1];
    return [a.pos[0] + n[0] * 0.21, a.pos[1] + n[1] * 0.21];
  }

  function polygon(points, cls) {
    return sv('polygon', { points: points.map((p) => toScreen(p).join(',')).join(' '), class: cls });
  }

  function outline(doc, s) {
    const it = M.itemOf(doc, s);
    if (!it) return null;
    if (s.kind === 'room') {
      if (M.isPoly(it)) return polygon(it.poly, 'ed-sel-shape');
      const [x, z, w, d] = it.rect;
      const [x0, y0] = toScreen([x, z]);
      return sv('rect', { x: x0, y: y0, width: w * view.s, height: d * view.s, rx: 2, class: 'ed-sel-shape' });
    }
    if (s.kind === 'furniture') {
      const [w, d] = footprint(it);
      return polygon(M.corners(it.pos, [w + 0.08, d + 0.08], it.rot || 0), 'ed-sel-shape');
    }
    if (s.kind === 'opening') {
      const [x1, y1] = toScreen(it.from);
      const [x2, y2] = toScreen(it.to);
      return sv('line', { x1, y1, x2, y2, class: 'ed-sel-line' });
    }
    if (s.kind === 'light' && it.type === 'strip') {
      return polygon(M.corners(it.pos, [(it.length || 1) + 0.12, 0.22], it.rot || 0), 'ed-sel-shape');
    }
    if (s.kind === 'light') {
      const [x, y] = toScreen(it.pos);
      return sv('circle', { cx: x, cy: y, r: 17, class: 'ed-sel-ring' });
    }
    if (s.kind === 'ac') {
      const [x, y] = toScreen(acBadge(it));
      return sv('rect', { x: x - 18, y: y - 16, width: 36, height: 32, rx: 11, class: 'ed-sel-ring' });
    }
    return null;
  }

  function addHandles(doc, s, it, layer) {
    const push = (hd, node) => { handles.push(hd); layer.append(node); };
    if (s.kind === 'room' && M.isPoly(it)) {
      // A polygon room: a knob on every corner.
      it.poly.forEach((p, index) => {
        const [hx, hy] = toScreen(p);
        push({ type: 'vertex', index, sx: hx, sy: hy, cursor: 'move' }, knob(hx, hy, { r: 6 }));
      });
      return;
    }
    if (s.kind === 'room') {
      const [x, z, w, d] = it.rect;
      const [x0, y0] = toScreen([x, z]);
      const [x1, y1] = toScreen([x + w, z + d]);
      const mx = (x0 + x1) / 2;
      const my = (y0 + y1) / 2;
      const small = x1 - x0 < 70 || y1 - y0 < 70;
      for (const [edge, hx, hy, horiz] of [['n', mx, y0, true], ['s', mx, y1, true], ['w', x0, my, false], ['e', x1, my, false]]) {
        push({ type: 'edge', edge, sx: hx, sy: hy, cursor: horiz ? 'ns-resize' : 'ew-resize' },
          sv('rect', { x: hx - (horiz ? 13 : 4), y: hy - (horiz ? 4 : 13), width: horiz ? 26 : 8, height: horiz ? 8 : 26, rx: 4, class: 'ed-knob edge' }));
      }
      if (!small) {
        for (const [edge, hx, hy, cur] of [['nw', x0, y0, 'nwse-resize'], ['ne', x1, y0, 'nesw-resize'], ['sw', x0, y1, 'nesw-resize'], ['se', x1, y1, 'nwse-resize']]) {
          push({ type: 'corner', edge, sx: hx, sy: hy, cursor: cur }, knob(hx, hy, { r: 6 }));
        }
      }
      return;
    }
    if (s.kind === 'furniture' || (s.kind === 'light' && it.type === 'strip')) {
      const strip = s.kind === 'light';
      const [w, d] = strip ? [it.length || 1, 0.1] : footprint(it);
      const rot = it.rot || 0;
      // Rotate: a knob on a short stem off the front edge.
      const front = toScreen(M.fromLocal(it.pos, rot, [0, d / 2 + (strip ? 0.05 : 0.04)]));
      const c = toScreen(it.pos);
      const len = Math.hypot(front[0] - c[0], front[1] - c[1]) || 1;
      const dir = [(front[0] - c[0]) / len, (front[1] - c[1]) / len];
      const knobAt = [front[0] + dir[0] * 26, front[1] + dir[1] * 26];
      layer.append(sv('line', { x1: front[0], y1: front[1], x2: knobAt[0], y2: knobAt[1], class: 'ed-stem' }));
      push({ type: 'rotate', sx: knobAt[0], sy: knobAt[1], cursor: 'grab' },
        sv('g', { transform: `translate(${knobAt[0]} ${knobAt[1]})`, class: 'ed-rot-knob' }, sv('circle', { r: 10 }), svgIcon('rotate90', 12, -6, -6, 2.4)));
      if (strip || M.RESIZABLE.has(it.type)) {
        for (const side of [-1, 1]) {
          const [hx, hy] = toScreen(M.fromLocal(it.pos, rot, [side * w / 2, 0]));
          push({ type: 'width', side, sx: hx, sy: hy, cursor: 'ew-resize' }, knob(hx, hy));
        }
      }
      if (M.SIZED.has(it.type)) {
        const [hx, hy] = toScreen(M.fromLocal(it.pos, rot, [w / 2, d / 2]));
        push({ type: 'rugsize', sx: hx, sy: hy, cursor: 'nwse-resize' }, knob(hx, hy));
      }
      return;
    }
    if (s.kind === 'opening') {
      for (const end of ['from', 'to']) {
        const [hx, hy] = toScreen(it[end]);
        const axis = M.openingAxis(it);
        push({ type: 'end', end, sx: hx, sy: hy, cursor: axis === 'x' ? 'ew-resize' : axis === 'z' ? 'ns-resize' : 'move' }, knob(hx, hy));
      }
    }
  }

  /* ---------- hit testing ---------- */

  function hitTest(sx, sy, { touch = false } = {}) {
    const doc = ctl.doc();
    const reach = touch ? 22 : 12;
    let best = null;
    for (const hd of handles) {
      const dd = Math.hypot(hd.sx - sx, hd.sy - sy);
      if (dd <= reach && (!best || dd < best.d)) best = { d: dd, hd };
    }
    if (best) return { handle: best.hd };
    const p = toWorld(sx, sy);
    // Lamp markers (18 px), then AC badges.
    let near = null;
    for (const l of doc.lights) {
      if (!l.pos) continue;
      const [x, y] = toScreen(l.pos);
      const dd = Math.hypot(x - sx, y - sy);
      if (dd <= 18 && (!near || dd < near.d)) near = { d: dd, sel: { kind: 'light', id: l.id } };
    }
    if (near) return { sel: near.sel };
    for (const a of doc.acs) {
      if (!a.pos) continue;
      const [x, y] = toScreen(acBadge(a));
      if (Math.abs(x - sx) <= 18 && Math.abs(y - sy) <= 16) return { sel: { kind: 'ac', id: a.id } };
    }
    // Strips along their whole length.
    for (const l of doc.lights) {
      if (l.type !== 'strip' || !l.pos) continue;
      const [lx, lz] = M.toLocal(l.pos, l.rot || 0, p);
      if (Math.abs(lx) <= (l.length || 1) / 2 + 6 / view.s && Math.abs(lz) <= 12 / view.s) return { sel: { kind: 'light', id: l.id } };
    }
    // Openings within 10 px of their segment.
    let open = null;
    doc.openings.forEach((o, i) => {
      if (!o.from || !o.to) return;
      const [x1, y1] = toScreen(o.from);
      const [x2, y2] = toScreen(o.to);
      const dd = segDist(sx, sy, x1, y1, x2, y2);
      if (dd <= 10 && (!open || dd < open.d)) open = { d: dd, sel: { kind: 'opening', index: i } };
    });
    if (open) return { sel: open.sel };
    // Furniture under the point, smallest first.
    const pieces = doc.furniture.map((f, i) => [f, i]).filter(([f]) => Array.isArray(f.pos))
      .map(([f, i]) => [f, i, footprint(f)])
      .filter(([f, , [w, d]]) => { const [lx, lz] = M.toLocal(f.pos, f.rot || 0, p); return Math.abs(lx) <= w / 2 && Math.abs(lz) <= d / 2; })
      .sort((a, b) => a[2][0] * a[2][1] - b[2][0] * b[2][1]);
    // A rug (or a shower tray) lies under the rest: anything else standing on it wins.
    pieces.sort((a, b) => UNDER.has(a[0].type) - UNDER.has(b[0].type));
    if (pieces.length) return { sel: { kind: 'furniture', index: pieces[0][1] } };
    const room = M.roomAt(doc, p, {});
    if (room) return { sel: { kind: 'room', id: room.id } };
    return {};
  }

  function segDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  /* ---------- editing gestures ---------- */

  // Snaps one coordinate to the nearest of `targets` within SNAP_PX on screen.
  function snapTo(value, targets) {
    const thr = SNAP_PX / view.s;
    let best = null;
    for (const t of targets) {
      const dd = Math.abs(t - value);
      if (dd <= thr && (!best || dd < Math.abs(best - value))) best = t;
    }
    return best;
  }

  const angleSnap = (deg) => {
    const n90 = Math.round(deg / 90) * 90;
    if (Math.abs(deg - n90) <= 7) return ((n90 % 360) + 360) % 360;
    return ((Math.round(deg / 15) * 15) % 360 + 360) % 360;
  };

  let lastGuideKey = '';
  function setGuides(list) {
    fx.guides = list;
    const key = list.map((g) => `${g.axis}${g.at}`).join('|');
    if (key && key !== lastGuideKey) haptic('tick');
    lastGuideKey = key;
  }

  function roomMove(room, start) {
    const doc = ctl.doc();
    const ride = M.riders(doc, room);
    const moving = new Set([room, ...ride.rooms]);
    const others = doc.rooms.filter((r) => !moving.has(r)).map(M.rectOf);
    const xs = others.flatMap((r) => [r.x, r.x + r.w]);
    const zs = others.flatMap((r) => [r.z, r.z + r.d]);
    const box = M.rectOf(room);
    const r0 = [box.x, box.z, box.w, box.d];
    const shape0 = M.shapeOf(room);
    const keep = {
      rooms: ride.rooms.map((r) => [r, M.shapeOf(r)]),
      pts: [...ride.lights, ...ride.acs, ...ride.furniture].map((o) => [o, [...o.pos]]),
      openings: ride.openings.map((o) => [o, [...o.from], [...o.to]]),
    };
    const axis = (lo, hi, delta, targets) => {
      let best = null;
      for (const edge of [lo, hi]) {
        const t = snapTo(edge + delta, targets);
        if (t != null && (!best || Math.abs(t - edge - delta) < Math.abs(best.adj))) best = { adj: t - edge - delta, at: t };
      }
      return best ? { d: delta + best.adj, guide: best.at } : { d: M.snap(delta), guide: null };
    };
    return {
      move(p) {
        const sx = axis(r0[0], r0[0] + r0[2], p[0] - start[0], xs);
        const sz = axis(r0[1], r0[1] + r0[3], p[1] - start[1], zs);
        const dx = M.fix(sx.d);
        const dz = M.fix(sz.d);
        M.placeShape(room, shape0, dx, dz);
        for (const [r, shape] of keep.rooms) M.placeShape(r, shape, dx, dz);
        for (const [o, pos] of keep.pts) o.pos = [M.fix(pos[0] + dx), M.fix(pos[1] + dz)];
        for (const [o, from, to] of keep.openings) { o.from = [M.fix(from[0] + dx), M.fix(from[1] + dz)]; o.to = [M.fix(to[0] + dx), M.fix(to[1] + dz)]; }
        setGuides([sx.guide != null && { axis: 'x', at: sx.guide }, sz.guide != null && { axis: 'z', at: sz.guide }].filter(Boolean));
      },
    };
  }

  function roomResize(room, edge, start) {
    const doc = ctl.doc();
    const others = doc.rooms.filter((r) => r !== room).map(M.rectOf);
    const xs = others.flatMap((r) => [r.x, r.x + r.w]);
    const zs = others.flatMap((r) => [r.z, r.z + r.d]);
    const [x0, z0, w0, d0] = room.rect;
    const e0 = { w: x0, e: x0 + w0, n: z0, s: z0 + d0 };
    const units = ctl.units();
    // ACs stay on their wall; doors and windows on a moving edge go with it.
    const acs = doc.acs.filter((a) => a.room === room.id && a.pos).map((a) => [a, M.alongWall(a.wall, a.pos)]);
    const onEdge = (o, side) => {
      const horiz = side === 'n' || side === 's';
      const [c, lo, hi] = horiz ? [1, x0, x0 + w0] : [0, z0, z0 + d0];
      const k = 1 - c;
      return [o.from, o.to].every((p) => Math.abs(p[c] - e0[side]) < M.EPS && p[k] >= lo - M.EPS && p[k] <= hi + M.EPS);
    };
    const opens = Object.fromEntries(['n', 's', 'w', 'e'].map((side) => [side, doc.openings.filter((o) => o.from && o.to && onEdge(o, side)).map((o) => [o, [...o.from], [...o.to]])]));
    return {
      move(p) {
        const next = { ...e0 };
        const guides = [];
        for (const side of edge) {
          const horiz = side === 'n' || side === 's';
          const raw = e0[side] + (horiz ? p[1] - start[1] : p[0] - start[0]);
          const snapped = snapTo(raw, horiz ? zs : xs);
          let v = snapped ?? M.snap(raw);
          if (side === 'w') v = Math.min(v, next.e - 0.8);
          if (side === 'e') v = Math.max(v, next.w + 0.8);
          if (side === 'n') v = Math.min(v, next.s - 0.8);
          if (side === 's') v = Math.max(v, next.n + 0.8);
          next[side] = M.fix(v);
          if (snapped != null && Math.abs(v - snapped) < 1e-9) guides.push({ axis: horiz ? 'z' : 'x', at: snapped });
        }
        room.rect = [next.w, next.n, M.fix(next.e - next.w), M.fix(next.s - next.n)];
        for (const [a, along] of acs) a.pos = M.placeAC(room, a.wall, along);
        for (const side of ['n', 's', 'w', 'e']) {
          const c = side === 'n' || side === 's' ? 1 : 0;
          for (const [o, from, to] of opens[side]) {
            o.from = c ? [from[0], next[side]] : [next[side], from[1]];
            o.to = c ? [to[0], next[side]] : [next[side], to[1]];
          }
        }
        setGuides(guides);
        // Live sizes just inside the edges that move.
        const [x, z, w, d] = room.rect;
        fx.pills = [];
        if (/[we]/.test(edge)) fx.pills.push({ at: [x + w / 2, edge.includes('s') ? z + d : z], text: M.fmtLen(w, units), dy: edge.includes('s') ? -20 : 20 });
        if (/[ns]/.test(edge)) fx.pills.push({ at: [edge.includes('e') ? x + w : x, z + d / 2], text: M.fmtLen(d, units), dx: edge.includes('e') ? -42 : 42 });
      },
    };
  }

  function pointMove(it, start, after) {
    const p0 = [...it.pos];
    return {
      move(p) {
        it.pos = [M.snap(p0[0] + p[0] - start[0]), M.snap(p0[1] + p[1] - start[1])];
        after?.(it);
      },
    };
  }

  function rotateOp(it) {
    return {
      move(p) {
        const deg = (Math.atan2(p[1] - it.pos[1], p[0] - it.pos[0]) * 180) / Math.PI;
        const rot = angleSnap(90 - deg);
        if (rot !== (it.rot || 0)) haptic('tick');
        it.rot = rot;
      },
    };
  }

  function widthOp(it, side, strip) {
    const rot = it.rot || 0;
    const [w0] = strip ? [it.length || 1] : footprint(it);
    const param0 = strip ? w0 : it.width ?? M.DEFAULT_WIDTH[it.type] ?? w0;
    const extra = w0 - param0; // a bed's frame is a little wider than its mattress
    const fixed = M.fromLocal(it.pos, rot, [-side * w0 / 2, 0]);
    const units = ctl.units();
    return {
      move(p) {
        const [lx] = M.toLocal(fixed, rot, p);
        const total = Math.max(0.3 + extra, side * lx);
        const param = Math.max(0.3, M.snap(total - extra));
        const wNew = param + extra;
        it.pos = M.fromLocal(fixed, rot, [side * wNew / 2, 0]).map(M.fix);
        if (strip) it.length = param; else it.width = param;
        fx.pills = [{ at: it.pos, text: M.fmtLen(param, units), dy: -24 }];
      },
    };
  }

  function rugOp(it) {
    const rot = it.rot || 0;
    const [w0, d0] = it.size || M.DEFAULT_SIZE[it.type] || [2, 1.4];
    const fixed = M.fromLocal(it.pos, rot, [-w0 / 2, -d0 / 2]);
    const units = ctl.units();
    return {
      move(p) {
        const [lx, lz] = M.toLocal(fixed, rot, p);
        const w = Math.max(0.5, M.snap(lx));
        const d = Math.max(0.5, M.snap(lz));
        it.size = [w, d];
        it.pos = M.fromLocal(fixed, rot, [w / 2, d / 2]).map(M.fix);
        fx.pills = [{ at: it.pos, text: M.fmtSize(w, d, units) }];
      },
    };
  }

  function openingMove(o, start) {
    const doc = ctl.doc();
    const s0 = M.openingSpan(o);
    let line = M.wallOf(doc, o);
    const mid0 = line ? (along(line, o.from) + along(line, o.to)) / 2 : 0;
    let offset = line ? mid0 - along(line, start) : 0;
    return {
      move(p) {
        const across = line ? Math.abs(line.n[0] * p[0] + line.n[1] * p[1] - line.c) : Infinity;
        if (!line || across > 0.6) {
          // Off its wall: onto the nearest other wall under the pointer, turned to fit.
          const near = M.nearestWall(doc, p);
          if (!near || near.dist > 1.2) return;
          if (near.line !== line) { line = near.line; offset = 0; haptic('tick'); }
        }
        // Slides along the wall, straight or angled; on a straight one it keeps to the 5 cm grid.
        const t = along(line, p) + offset;
        const straight = Math.abs(line.dir[0]) < 1e-9 || Math.abs(line.dir[1]) < 1e-9;
        M.setOpeningSpan(o, M.placeOnWall(line, straight ? M.snap(t) : M.fix(t), s0.w));
      },
    };
  }

  function openingEnd(o, end) {
    const doc = ctl.doc();
    const s0 = M.openingSpan(o);
    const line = M.wallOf(doc, o) || { ...s0, a: -Infinity, b: Infinity };
    const units = ctl.units();
    const fixedEnd = end === 'from' ? 'to' : 'from';
    const fixedT = along(line, o[fixedEnd]);
    const movingT = along(line, o[end]);
    const dir = Math.sign(movingT - fixedT) || 1;
    const straight = Math.abs(line.dir[0]) < 1e-9 || Math.abs(line.dir[1]) < 1e-9;
    return {
      move(p) {
        const t = along(line, p);
        let w = Math.max(0.4, straight ? M.snap((t - fixedT) * dir) : M.fix((t - fixedT) * dir));
        const limit = dir > 0 ? line.b - fixedT : fixedT - line.a;
        w = Math.min(w, Math.max(0.4, limit));
        const at = (v) => [M.fix(line.dir[0] * v + line.n[0] * line.c), M.fix(line.dir[1] * v + line.n[1] * line.c)];
        o[fixedEnd] = at(fixedT);
        o[end] = at(fixedT + dir * w);
        fx.pills = [{ at: M.centerOf('opening', o), text: M.fmtLen(w, units), dy: -22 }];
      },
    };
  }

  // A corner of a polygon room: snaps to the grid, to other rooms' corners and edges, and
  // to 45° steps from the corners either side of it.
  function vertexOp(room, index) {
    const doc = ctl.doc();
    const others = doc.rooms.filter((r) => r !== room);
    const corners = others.flatMap((r) => M.pointsOf(r));
    const edges = others.flatMap((r) => { const pts = M.pointsOf(r); return pts.map((p, i) => [p, pts[(i + 1) % pts.length]]); });
    const units = ctl.units();
    return {
      move(p) {
        const thr = SNAP_PX / view.s;
        const n = room.poly.length;
        const prev = room.poly[(index + n - 1) % n];
        const next = room.poly[(index + 1) % n];
        let q = [M.snap(p[0]), M.snap(p[1])];
        let guide = null;
        const corner = corners.find((c) => Math.hypot(c[0] - p[0], c[1] - p[1]) <= thr);
        if (corner) q = [...corner];
        else {
          // 45° from a neighbour: project onto the nearest such ray.
          let best = null;
          for (const nb of [prev, next]) {
            for (let k = 0; k < 8; k++) {
              const a = (k * Math.PI) / 4;
              const d = [Math.cos(a), Math.sin(a)];
              const t = (p[0] - nb[0]) * d[0] + (p[1] - nb[1]) * d[1];
              if (t <= 0) continue;
              const r = [nb[0] + d[0] * t, nb[1] + d[1] * t];
              const dist = Math.hypot(r[0] - p[0], r[1] - p[1]);
              if (dist <= thr && (!best || dist < best.dist)) best = { dist, r, from: nb, d };
            }
          }
          let edge = null;
          for (const [a, b] of edges) {
            const l = lineOf(a, b);
            const dist = Math.abs(l.n[0] * p[0] + l.n[1] * p[1] - l.c);
            const t = along(l, p);
            const [ta, tb] = [along(l, a), along(l, b)].sort((x, y) => x - y);
            if (dist <= thr && t >= ta - thr && t <= tb + thr && (!edge || dist < edge.dist)) edge = { dist, l, t };
          }
          if (best && (!edge || best.dist <= edge.dist)) {
            // Along the ray, the grid still applies to the distance from the neighbour.
            const t = M.snap(Math.hypot(best.r[0] - best.from[0], best.r[1] - best.from[1]));
            q = [best.from[0] + best.d[0] * t, best.from[1] + best.d[1] * t];
            guide = best;
          } else if (edge) {
            const t = M.snap(edge.t);
            q = [edge.l.dir[0] * t + edge.l.n[0] * edge.l.c, edge.l.dir[1] * t + edge.l.n[1] * edge.l.c];
          }
        }
        if (M.moveCorner(room, index, q)) {
          const len = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
          const c = room.poly[index];
          fx.pills = [{ at: c, text: `${M.fmtLen(len(prev, c), units)} · ${M.fmtLen(len(c, next), units)}`, dy: -26 }];
          fx.angle = guide ? { from: guide.from, to: c } : null;
        }
      },
    };
  }

  // The operation a press starts: on a handle, or on the item itself.
  function opFor(target, start) {
    const doc = ctl.doc();
    const sel = ctl.sel();
    if (target.handle) {
      const it = M.itemOf(doc, sel);
      if (!it) return null;
      const hd = target.handle;
      if (hd.type === 'edge' || hd.type === 'corner') return roomResize(it, hd.edge, start);
      if (hd.type === 'rotate') return rotateOp(it);
      if (hd.type === 'width') return widthOp(it, hd.side, sel.kind === 'light');
      if (hd.type === 'rugsize') return rugOp(it);
      if (hd.type === 'vertex') return vertexOp(it, hd.index);
      if (hd.type === 'end') return openingEnd(it, hd.end);
      return null;
    }
    const it = M.itemOf(doc, target.sel);
    if (!it) return null;
    switch (target.sel.kind) {
      case 'room': return roomMove(it, start);
      case 'light': return pointMove(it, start, (l) => { const r = M.roomAt(doc, l.pos); if (r) l.room = r.id; });
      case 'ac': return { move(p) { M.snapAC(doc, it, p); } };
      case 'furniture': return pointMove(it, start);
      case 'opening': return openingMove(it, start);
      default: return null;
    }
  }

  /* ---------- pointers ---------- */

  const pointers = new Map();
  let g = null; // the gesture of the first pointer
  let pinch = null;
  let lastTap = null;
  let autoPan = 0;

  const isTouch = (ev) => ev.pointerType === 'touch';

  svg.addEventListener('contextmenu', (ev) => ev.preventDefault());

  svg.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 && ev.pointerType === 'mouse') return;
    svg.focus({ preventScroll: true });
    try { svg.setPointerCapture(ev.pointerId); } catch { /* synthetic events */ }
    const pt = local(ev);
    pointers.set(ev.pointerId, pt);
    if (anim) { cancelAnimationFrame(anim); anim = 0; settle?.(); settle = null; }
    if (pointers.size === 2 && isTouch(ev)) {
      // A second finger ends an item drag (kept) and starts a pinch.
      if (g?.mode === 'drag') finishDrag();
      clearTimeout(g?.hold);
      g = null;
      startPinch();
      return;
    }
    if (pointers.size > 1) return;
    const touch = isTouch(ev);
    const hit = fx.drawing === 'armed' || fx.drawing ? {} : hitTest(pt[0], pt[1], { touch });
    g = { id: ev.pointerId, x: pt[0], y: pt[1], touch, hit, mode: 'press', moved: false, v0: { ...view }, start: toWorld(...pt) };
    if (fx.drawing) { g.mode = 'draw'; startDraw(g.start); return; }
    const sel = ctl.sel();
    if (hit.handle) { g.target = hit; return; }
    if (!touch) {
      // Mouse and pen: pressing an item selects it, and moving drags it.
      if (hit.sel) {
        if (!M.sameSel(hit.sel, sel)) ctl.select(hit.sel, { via: 'plan' });
        g.target = { sel: hit.sel };
      }
      return;
    }
    // A finger drags what is selected at once (in a selected room, the room itself unless a
    // lamp or an AC is under the finger); elsewhere it pans, or picks up after a hold.
    const inSelRoom = sel?.kind === 'room' && hit.sel && hit.sel.kind !== 'light' && hit.sel.kind !== 'ac'
      && M.contains(M.itemOf(ctl.doc(), sel) || { rect: [0, 0, 0, 0] }, g.start, 0);
    if (hit.sel && (M.sameSel(hit.sel, sel) || inSelRoom)) { g.target = { sel: inSelRoom ? sel : hit.sel }; return; }
    g.mode = 'pan';
    g.panning = false;
    if (hit.sel) {
      g.hold = setTimeout(() => {
        if (!g || g.moved) return;
        haptic('medium');
        if (!M.sameSel(hit.sel, ctl.sel())) ctl.select(hit.sel, { via: 'plan', quiet: true });
        g.target = { sel: hit.sel };
        g.mode = 'press';
        g.lifted = true;
        fx.lifted = selKey(hit.sel);
        g.x = (pointers.get(g.id) || pt)[0];
        g.y = (pointers.get(g.id) || pt)[1];
        g.start = toWorld(g.x, g.y);
        invalidate(true);
      }, HOLD_MS);
    }
  });

  svg.addEventListener('pointermove', (ev) => {
    const pt = local(ev);
    if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, pt);
    if (pinch) { if (pointers.size >= 2) movePinch(); return; }
    if (!g || ev.pointerId !== g.id) {
      if (!pointers.size && ev.pointerType === 'mouse') hover(pt);
      return;
    }
    const dist = Math.hypot(pt[0] - g.x, pt[1] - g.y);
    if (g.mode === 'draw') { moveDraw(toWorld(...pt)); return; }
    if (g.mode === 'press') {
      if (!g.target) { if (dist > 3) { g.mode = 'pan'; g.panning = true; g.moved = true; } return; }
      if (!g.lifted && dist <= 3) return;
      if (g.lifted && dist <= 1) return;
      g.op = opFor(g.target, g.start);
      if (!g.op) { g.mode = 'pan'; return; }
      g.mode = 'drag';
      g.moved = true;
      ctl.begin();
      fx.lifted = selKey(g.target.handle ? ctl.sel() : g.target.sel);
      el.classList.add('dragging');
    }
    if (g.mode === 'drag') {
      g.last = pt;
      dragTo(pt);
      startAutoPan();
      return;
    }
    if (g.mode === 'pan') {
      if (!g.panning && dist < (g.touch ? 8 : 3)) return;
      if (!g.panning) { g.panning = true; g.x = pt[0]; g.y = pt[1]; g.v0 = { ...view }; }
      g.moved = true;
      clearTimeout(g.hold);
      userMoved = true;
      view = { ...g.v0, tx: g.v0.tx + pt[0] - g.x, ty: g.v0.ty + pt[1] - g.y };
      applyView();
      svg.style.cursor = 'grabbing';
    }
  });

  function dragTo(pt) {
    g.op.move(toWorld(...pt));
    ctl.preview();
  }

  // Dragging near the edge of what is visible moves the plan along, gently.
  function startAutoPan() {
    if (autoPan) return;
    const step = () => {
      autoPan = 0;
      if (!g || g.mode !== 'drag' || !g.last) return;
      const a = visibleArea();
      const [x, y] = g.last;
      const edge = 34;
      const vx = x < a.left + edge ? 1 : x > a.right - edge ? -1 : 0;
      const vy = y < a.top + edge ? 1 : y > a.bottom - edge ? -1 : 0;
      if (!vx && !vy) return;
      view = { ...view, tx: view.tx + vx * 5, ty: view.ty + vy * 5 };
      userMoved = true;
      applyView();
      dragTo(g.last);
      autoPan = requestAnimationFrame(step);
    };
    autoPan = requestAnimationFrame(step);
  }

  function finishDrag() {
    cancelAnimationFrame(autoPan);
    autoPan = 0;
    fx.guides = [];
    fx.pills = [];
    fx.angle = null;
    fx.lifted = null;
    lastGuideKey = '';
    el.classList.remove('dragging');
    ctl.commit();
  }

  const release = (ev) => {
    const pt = pointers.get(ev.pointerId) || local(ev);
    pointers.delete(ev.pointerId);
    if (pinch) {
      if (pointers.size < 2) {
        pinch = null;
        // One finger stays: it carries on panning from here.
        const [rest] = [...pointers.entries()];
        g = rest ? { id: rest[0], x: rest[1][0], y: rest[1][1], touch: true, hit: {}, mode: 'pan', panning: true, moved: true, v0: { ...view } } : null;
      }
      return;
    }
    if (!g || ev.pointerId !== g.id) return;
    clearTimeout(g.hold);
    const cancelled = ev.type === 'pointercancel';
    const done = g;
    g = null;
    svg.style.cursor = '';
    if (done.mode === 'draw') { endDraw(cancelled); return; }
    if (done.mode === 'drag') { finishDrag(); return; }
    if (done.lifted) { fx.lifted = null; invalidate(true); }
    if (cancelled || done.moved) return;
    // A tap.
    const target = done.hit;
    if (target.handle) return;
    if (target.sel) {
      if (!done.touch) { ctl.select(target.sel, { via: 'plan', tap: true }); return; }
      haptic('light');
      ctl.select(target.sel, { via: 'plan', tap: true });
      lastTap = null;
      return;
    }
    // Empty space: deselect; tapped twice, fit the whole home.
    const now = performance.now();
    if (lastTap && now - lastTap.t < 320 && Math.hypot(pt[0] - lastTap.x, pt[1] - lastTap.y) < 24) {
      lastTap = null;
      fit();
      return;
    }
    lastTap = { t: now, x: pt[0], y: pt[1] };
    ctl.select(null, { via: 'plan', tap: true });
  };
  const endPointer = (ev) => {
    release(ev);
    if (!pointers.size) ctl.idle?.();
  };
  svg.addEventListener('pointerup', endPointer);
  svg.addEventListener('pointercancel', endPointer);
  svg.addEventListener('pointerleave', (ev) => { if (ev.pointerType === 'mouse' && !pointers.size) hover(null); });

  function startPinch() {
    const [a, b] = [...pointers.values()];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    pinch = { d0: Math.max(1, Math.hypot(a[0] - b[0], a[1] - b[1])), s0: view.s, at: toWorld(...mid) };
  }

  function movePinch() {
    const [a, b] = [...pointers.values()];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const s = clampScale(pinch.s0 * Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.d0);
    view = { s, tx: mid[0] - pinch.at[0] * s, ty: mid[1] - pinch.at[1] * s };
    userMoved = true;
    applyView();
  }

  function hover(pt) {
    if (fx.drawing) { svg.style.cursor = 'crosshair'; return; }
    const hit = pt ? hitTest(pt[0], pt[1]) : {};
    const key = hit.sel ? selKey(hit.sel) : null;
    svg.style.cursor = hit.handle ? hit.handle.cursor : hit.sel ? (M.sameSel(hit.sel, ctl.sel()) ? 'move' : 'pointer') : '';
    if (key !== fx.hover) { fx.hover = key; renderOverlay(); }
  }

  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const [x, y] = local(ev);
    const notch = !ev.deltaX && (ev.deltaMode === 1 || Math.abs(ev.deltaY) >= 40);
    if (ev.ctrlKey) zoomAt(x, y, Math.exp(-ev.deltaY * 0.01));
    else if (notch) zoomAt(x, y, Math.exp(-Math.sign(ev.deltaY) * Math.min(Math.abs(ev.deltaY), 120) * (ev.deltaMode === 1 ? 0.06 : 0.0022)));
    else {
      view = { ...view, tx: view.tx - ev.deltaX, ty: view.ty - ev.deltaY };
      userMoved = true;
      applyView();
    }
  }, { passive: false });

  svg.addEventListener('dblclick', (ev) => {
    const [x, y] = local(ev);
    if (!hitTest(x, y).sel) fit();
  });

  // Keyboard path: Tab walks through the rooms and devices while the plan has focus.
  svg.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Tab' || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ctl.cycle(ev.shiftKey ? -1 : 1)) ev.preventDefault();
  });

  /* ---------- drawing a room ---------- */

  function startDraw(p) {
    const doc = ctl.doc();
    const boxes = doc.rooms.map(M.rectOf);
    const xs = boxes.flatMap((r) => [r.x, r.x + r.w]);
    const zs = boxes.flatMap((r) => [r.z, r.z + r.d]);
    const sp = (v, targets) => snapTo(v, targets) ?? M.snap(v);
    const origin = [sp(p[0], xs), sp(p[1], zs)];
    fx.drawing = { origin, rect: [origin[0], origin[1], 0, 0], xs, zs, sp };
    renderOverlay();
  }

  function moveDraw(p) {
    const d = fx.drawing;
    if (!d || d === 'armed') return;
    const x = d.sp(p[0], d.xs);
    const z = d.sp(p[1], d.zs);
    d.rect = [Math.min(x, d.origin[0]), Math.min(z, d.origin[1]), M.fix(Math.abs(x - d.origin[0])), M.fix(Math.abs(z - d.origin[1]))];
    setGuides([d.xs.includes(x) && { axis: 'x', at: x }, d.zs.includes(z) && { axis: 'z', at: z }].filter(Boolean));
    renderOverlay();
  }

  function endDraw(cancelled) {
    const d = fx.drawing;
    fx.guides = [];
    if (!d || d === 'armed') return;
    fx.drawing = 'armed';
    renderOverlay();
    if (cancelled) return;
    if (d.rect[2] >= 0.8 && d.rect[3] >= 0.8) {
      stopDrawing();
      ctl.onDrawn(d.rect.map(M.fix));
    } else if (d.rect[2] > 0.05 || d.rect[3] > 0.05) {
      ctl.toast('A room needs at least 80 cm on each side');
    }
  }

  function stopDrawing() {
    fx.drawing = null;
    hint.hidden = true;
    el.classList.remove('drawing');
    svg.style.cursor = '';
    renderOverlay();
  }

  /* ---------- rendering ---------- */

  let raf = 0;
  let dirtyWorld = false;
  function invalidate(worldToo = false) {
    dirtyWorld = dirtyWorld || worldToo;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (dirtyWorld) renderWorld();
      dirtyWorld = false;
      renderOverlay();
    });
  }

  const ro = new ResizeObserver(() => {
    const r = svg.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const was = size;
    size = { w: r.width, h: r.height };
    if (!was.w) return;
    fitS = fitTarget().s;
    if (!userMoved && !anim) fit({ animate: 0 });
    else applyView();
  });
  ro.observe(svg);

  return {
    el,
    svg,
    get view() { return { ...view }; },
    get userMoved() { return userMoved; },
    get busy() { return Boolean(g && (g.mode === 'drag' || g.mode === 'draw')) || Boolean(pinch); },
    /** A finger or a button is down on the plan: the view must not move under it. */
    get pressed() { return Boolean(g) || pointers.size > 0; },
    toScreen,
    toWorld,
    render() { invalidate(true); },
    renderNow() { cancelAnimationFrame(raf); raf = 0; renderWorld(); renderOverlay(); },
    overlay() { invalidate(false); },
    measure() {
      const r = svg.getBoundingClientRect();
      size = { w: r.width, h: r.height };
      if (size.w) fitS = fitTarget().s;
      return size;
    },
    setView,
    fitTarget: () => fitTarget(),
    /** Fits the whole home in the visible part. */
    fit,
    /** The visible part changed (the sheet moved): follow it unless the user took over. */
    insetsChanged({ animate = 380, keep = null } = {}) {
      if (!userMoved) return fit({ animate });
      if (keep) return reveal(keep, { animate });
      return Promise.resolve();
    },
    reveal(sel, opts) {
      const it = M.itemOf(ctl.doc(), sel);
      return reveal(it ? M.boxOf(sel.kind, it) : null, opts);
    },
    revealBox: reveal,
    /** Something just added: it drops in with a spreading ring. */
    drop(sel) {
      const key = sel.kind === 'light' && M.itemOf(ctl.doc(), sel)?.type === 'strip' ? [`light:${sel.id}`, `strip:${sel.id}`] : [selKey(sel)];
      for (const k of key) fx.drops.set(k, performance.now());
      invalidate(true);
      setTimeout(() => { for (const k of key) fx.drops.delete(k); invalidate(true); }, 700);
    },
    startDrawing() {
      fx.drawing = 'armed';
      hint.hidden = false;
      el.classList.add('drawing');
      svg.style.cursor = 'crosshair';
      renderOverlay();
    },
    stopDrawing,
    /** Marks a corner of a room (the one "Cut corner" would cut), or nothing. */
    markCorner(p) {
      const same = (a, b) => (a && b ? a[0] === b[0] && a[1] === b[1] : a === b);
      if (same(fx.corner, p)) return;
      fx.corner = p ? [...p] : null;
      invalidate(false);
    },
    get drawing() { return Boolean(fx.drawing); },
    /** Ends a gesture in progress (the editor is closing or the plan was replaced). */
    cancelGesture() {
      if (g?.mode === 'drag') finishDrag();
      g = null;
      pinch = null;
      pointers.clear();
    },
    destroy() {
      settle?.();
      ro.disconnect();
      cancelAnimationFrame(raf);
      cancelAnimationFrame(anim);
      cancelAnimationFrame(autoPan);
    },
  };
}
