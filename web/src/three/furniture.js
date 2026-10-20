// Procedural furniture library. Every builder returns a Group standing on y = 0,
// centred on its footprint and facing +z; the plan's "rot" turns it from there.
import * as THREE from 'three';
import { box, cyl, mat, at, rng } from './kit.js';

const WOOD = '#a98459';
const DARK_WOOD = '#5a4334';
const WHITE = '#eceae5';
const BLACK = '#1b1c21';
const METAL = '#9a9fa8';

const group = (...children) => {
  const g = new THREE.Group();
  const kids = children.flat().filter(Boolean);
  if (kids.length) g.add(...kids);
  return g;
};

const clampTo = (v, a, b) => Math.min(b, Math.max(a, v));

function darker(hex, k = 0.75) {
  return `#${new THREE.Color(hex).multiplyScalar(k).getHexString()}`;
}

function legs(w, d, h, material, inset = 0.06, r = 0.022) {
  const out = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    out.push(at(cyl(r, r * 0.8, h, material, 10), sx * (w / 2 - inset), 0, sz * (d / 2 - inset)));
  }
  return out;
}

function seating(width, depth, color, cushions) {
  const fabric = mat(color, { rough: 1 });
  const dark = mat(darker(color, 0.82), { rough: 1 });
  const arm = 0.2;
  const inner = width - arm * 2;
  const parts = [
    ...legs(width, depth, 0.1, mat(BLACK, { rough: 0.5 }), 0.08),
    at(box(width, 0.2, depth, dark, { r: 0.05 }), 0, 0.1, 0),
    at(box(inner, 0.52, 0.24, dark, { r: 0.09 }), 0, 0.3, -depth / 2 + 0.12),
  ];
  for (const sx of [-1, 1]) parts.push(at(box(arm, 0.36, depth, dark, { r: 0.08 }), sx * (width / 2 - arm / 2), 0.3, 0));
  const cw = inner / cushions;
  for (let i = 0; i < cushions; i++) {
    const x = -inner / 2 + cw * (i + 0.5);
    parts.push(at(box(cw - 0.02, 0.17, depth - 0.3, fabric, { r: 0.06 }), x, 0.3, 0.1));
    const back = at(box(cw - 0.04, 0.36, 0.16, fabric, { r: 0.07 }), x, 0.46, -depth / 2 + 0.3);
    back.rotation.x = -0.14;
    parts.push(back);
  }
  return group(parts);
}

function chair(color = BLACK) {
  const m = mat(color, { rough: 0.7 });
  const back = at(box(0.42, 0.4, 0.04, m, { r: 0.02 }), 0, 0.47, -0.2);
  back.rotation.x = -0.1;
  return group(...legs(0.42, 0.42, 0.44, m, 0.04, 0.015), at(box(0.44, 0.05, 0.44, m, { r: 0.02 }), 0, 0.42, 0), back);
}

// A TV's panel: glossy black until three/tv.js lights it with what the real TV shows.
// Its own material (never the shared cache), since each screen shows its own picture.
function tvScreen(w, h) {
  const screen = box(w, h, 0.01, new THREE.MeshStandardMaterial({ color: '#030406', roughness: 0.16, metalness: 0.3 }), { r: 0 });
  screen.userData.size = [w, h];
  return screen;
}

function doorLines(width, height, y, z, count, material) {
  const out = [];
  for (let i = 1; i < count; i++) out.push(at(box(0.008, height, 0.006, material, { r: 0 }), -width / 2 + (width / count) * i, y, z));
  return out;
}

const builders = {
  rug({ size = [2, 1.4], color = '#3b4a66' }) {
    const g = group(
      at(box(size[0], 0.016, size[1], mat(color, { rough: 1 }), { r: 0.006 }), 0, 0, 0),
      at(box(size[0] - 0.24, 0.018, size[1] - 0.24, mat(darker(color, 1.18), { rough: 1 }), { r: 0.006 }), 0, 0, 0),
    );
    g.userData.flat = true;
    return g;
  },

  sofa({ width = 2.2, color = '#8b93a7' }) {
    const g = seating(width, 0.95, color, width > 2 ? 3 : 2);
    // throw pillow
    const pillow = at(box(0.36, 0.36, 0.12, mat('#d9b98a', { rough: 1 }), { r: 0.05 }), -width / 2 + 0.42, 0.46, -0.1);
    pillow.rotation.set(-0.25, 0.3, 0.1);
    g.add(pillow);
    return g;
  },

  armchair({ color = '#c28a5a' }) {
    return seating(0.92, 0.88, color, 1);
  },

  coffeeTable({ width = 1.1 }) {
    const wood = mat(WOOD, { rough: 0.6 });
    return group(
      at(box(width, 0.04, 0.58, wood, { r: 0.015 }), 0, 0.36, 0),
      at(box(width - 0.16, 0.02, 0.44, mat(BLACK, { rough: 0.5 }), { r: 0.008 }), 0, 0.14, 0),
      ...legs(width, 0.58, 0.36, mat(BLACK, { rough: 0.5 }), 0.07, 0.015),
      at(box(0.24, 0.035, 0.17, mat('#c9553f', { rough: 0.9 }), { r: 0.006 }), 0.22, 0.4, 0.05),
      at(cyl(0.05, 0.04, 0.09, mat(WHITE, { rough: 0.4 })), -0.3, 0.4, -0.08),
    );
  },

  tv({ width = 1.7 }) {
    const sw = width * 0.84;
    const sh = sw * 0.5625;
    const screen = tvScreen(sw - 0.02, sh - 0.02);
    const g = group(
      at(box(width, 0.36, 0.4, mat(DARK_WOOD, { rough: 0.6 }), { r: 0.015 }), 0, 0.1, 0),
      ...legs(width, 0.4, 0.1, mat(BLACK), 0.08, 0.015),
      ...doorLines(width, 0.3, 0.13, 0.2, 3, mat(BLACK)),
      at(box(sw + 0.03, sh + 0.03, 0.035, mat(BLACK, { rough: 0.4 }), { r: 0.008 }), 0, 0.72, -0.15),
      at(screen, 0, 0.745, -0.129),
      at(box(0.5, 0.07, 0.09, mat('#2a2c33', { rough: 0.7 }), { r: 0.02 }), 0, 0.46, 0.05),
    );
    g.userData.screen = screen;
    return g;
  },

  sideboard({ width = 1.6 }) {
    return group(
      ...legs(width, 0.42, 0.16, mat(BLACK), 0.07, 0.015),
      at(box(width, 0.6, 0.42, mat(WOOD, { rough: 0.6 }), { r: 0.015 }), 0, 0.16, 0),
      ...doorLines(width, 0.54, 0.19, 0.21, 4, mat(DARK_WOOD)),
      at(cyl(0.07, 0.05, 0.26, mat('#3d6b8c', { rough: 0.35 })), -width / 2 + 0.3, 0.76, 0),
      at(box(0.3, 0.05, 0.2, mat('#d8c9a8', { rough: 0.9 }), { r: 0.006 }), width / 2 - 0.35, 0.76, 0),
    );
  },

  diningSet({ width = 1.8, chairs = 6 }) {
    const depth = 0.95;
    const wood = mat('#b48d63', { rough: 0.55 });
    const g = group(
      at(box(width, 0.05, depth, wood, { r: 0.02 }), 0, 0.71, 0),
      ...legs(width, depth, 0.71, mat(BLACK, { rough: 0.5 }), 0.1, 0.028),
      at(cyl(0.16, 0.1, 0.07, mat(WHITE, { rough: 0.4 })), 0, 0.76, 0),
    );
    const perSide = Math.ceil(chairs / 2);
    for (let i = 0; i < chairs; i++) {
      const side = i < perSide ? 1 : -1;
      const k = i < perSide ? i : i - perSide;
      const n = i < perSide ? perSide : chairs - perSide;
      const c = chair('#2b2e37');
      c.position.set(-width / 2 + (width / n) * (k + 0.5), 0, side * (depth / 2 + 0.12));
      c.rotation.y = side > 0 ? Math.PI : 0;
      g.add(c);
    }
    return g;
  },

  island({ width = 2.0, stools = 3 }) {
    const g = group(
      at(box(width - 0.12, 0.88, 0.62, mat('#39424f', { rough: 0.7 }), { r: 0.015 }), 0, 0, -0.04),
      at(box(width, 0.05, 0.86, mat('#e9e7e2', { rough: 0.3 }), { r: 0.015 }), 0, 0.88, 0),
    );
    for (let i = 0; i < stools; i++) {
      const x = -width / 2 + (width / stools) * (i + 0.5);
      g.add(group(
        at(cyl(0.16, 0.16, 0.012, mat(BLACK, { rough: 0.4 })), x, 0, 0.62),
        at(cyl(0.015, 0.015, 0.64, mat(METAL, { rough: 0.3, metal: 0.8 }), 10), x, 0, 0.62),
        at(cyl(0.17, 0.15, 0.05, mat('#c28a5a', { rough: 0.9 })), x, 0.64, 0.62),
      ));
    }
    return g;
  },

  kitchen({ width = 3, upper = true }) {
    const front = mat('#e4e1da', { rough: 0.6 });
    const seam = mat('#b9b6ae');
    const n = Math.max(2, Math.round(width / 0.6));
    const g = group(
      at(box(width, 0.86, 0.6, front, { r: 0.008 }), 0, 0, 0),
      ...doorLines(width, 0.78, 0.06, 0.3, n, seam),
      at(box(width + 0.02, 0.04, 0.63, mat('#33363d', { rough: 0.35 }), { r: 0.008 }), 0, 0.86, 0.005),
      at(box(0.58, 0.012, 0.5, mat('#0c0d10', { rough: 0.15 }), { r: 0 }), -width / 4, 0.9, 0),
      at(box(0.5, 0.012, 0.38, mat(METAL, { rough: 0.3, metal: 0.9 }), { r: 0 }), width / 4, 0.9, 0.02),
      at(cyl(0.015, 0.015, 0.24, mat(METAL, { rough: 0.25, metal: 0.9 }), 10), width / 4, 0.9, -0.22),
    );
    if (upper) {
      g.add(
        at(box(width, 0.72, 0.35, front, { r: 0.008 }), 0, 1.48, -0.125),
        ...doorLines(width, 0.66, 1.51, 0.05, n, seam),
        at(box(0.7, 0.1, 0.42, mat('#2f3239', { rough: 0.4, metal: 0.4 }), { r: 0.008 }), -width / 4, 1.42, -0.09),
      );
    }
    return g;
  },

  fridge() {
    const body = mat('#c5c9d0', { rough: 0.35, metal: 0.5 });
    return group(
      at(box(0.7, 1.92, 0.68, body, { r: 0.025 }), 0, 0, 0),
      at(box(0.66, 0.008, 0.005, mat('#7c8088'), { r: 0 }), 0, 1.25, 0.34),
      at(box(0.02, 0.5, 0.03, mat('#70747c', { metal: 0.7, rough: 0.3 }), { r: 0.008 }), -0.26, 1.34, 0.35),
      at(box(0.02, 0.4, 0.03, mat('#70747c', { metal: 0.7, rough: 0.3 }), { r: 0.008 }), -0.26, 0.76, 0.35),
    );
  },

  bed({ width = 1.6, color = '#7f8fb5' }) {
    const depth = 2.1;
    const linen = mat('#f1efea', { rough: 1 });
    const g = group(
      at(box(width + 0.1, 0.26, depth + 0.04, mat(DARK_WOOD, { rough: 0.7 }), { r: 0.03 }), 0, 0.04, 0),
      at(box(width + 0.16, 1.02, 0.1, mat(darker(color, 0.6), { rough: 1 }), { r: 0.04 }), 0, 0, -depth / 2),
      at(box(width, 0.2, depth - 0.06, linen, { r: 0.07 }), 0, 0.28, 0.02),
      at(box(width + 0.05, 0.13, depth * 0.63, mat(color, { rough: 1 }), { r: 0.06 }), 0, 0.4, depth * 0.17),
      at(box(width + 0.06, 0.05, 0.3, mat(darker(color, 0.8), { rough: 1 }), { r: 0.02 }), 0, 0.5, depth * 0.36),
    );
    for (const sx of [-1, 1]) {
      const pillow = at(box(width / 2 - 0.14, 0.13, 0.42, linen, { r: 0.06 }), sx * width / 4, 0.46, -depth / 2 + 0.36);
      pillow.rotation.x = -0.18;
      g.add(pillow);
    }
    return g;
  },

  nightstand() {
    return group(
      at(box(0.46, 0.44, 0.4, mat(WOOD, { rough: 0.6 }), { r: 0.015 }), 0, 0.06, 0),
      ...legs(0.46, 0.4, 0.06, mat(BLACK), 0.06, 0.014),
      at(box(0.4, 0.006, 0.005, mat(DARK_WOOD), { r: 0 }), 0, 0.28, 0.2),
    );
  },

  dresser({ width = 1.3, height = 0.84 }) {
    // A tall chest of drawers is the same piece with more drawers.
    const body = Math.max(0.3, height - 0.1);
    const drawers = Math.max(3, Math.round(body / 0.25));
    const g = group(
      ...legs(width, 0.45, 0.1, mat(BLACK), 0.06, 0.015),
      at(box(width, body, 0.45, mat(WHITE, { rough: 0.6 }), { r: 0.015 }), 0, 0.1, 0),
      at(cyl(0.09, 0.07, 0.18, mat('#c9a15e', { rough: 0.4 })), width / 2 - 0.3, height, 0),
    );
    for (let i = 1; i < drawers; i++) g.add(at(box(width - 0.06, 0.006, 0.005, mat('#b9b6ae'), { r: 0 }), 0, 0.1 + (body / drawers) * i, 0.226));
    return g;
  },

  plant({ height = 1.2 }) {
    const rand = rng(Math.round(height * 1000));
    const leaves = [mat('#3f7d52', { rough: 0.9 }), mat('#4f9462', { rough: 0.9 }), mat('#35694a', { rough: 0.9 })];
    const g = group(
      at(cyl(0.17, 0.12, 0.3, mat('#d7d0c4', { rough: 0.8 })), 0, 0, 0),
      at(cyl(0.15, 0.15, 0.02, mat('#3a2c22', { rough: 1 })), 0, 0.285, 0),
      at(cyl(0.015, 0.02, height * 0.55, mat('#6b4a33', { rough: 1 }), 8), 0, 0.3, 0),
    );
    const count = Math.round(6 + height * 5);
    for (let i = 0; i < count; i++) {
      const t = i / (count - 1);
      const y = 0.5 + t * (height - 0.62);
      const spread = 0.28 * Math.sin(Math.PI * (0.25 + t * 0.7));
      const a = rand() * Math.PI * 2;
      const blob = new THREE.Mesh(new THREE.IcosahedronGeometry(0.13 + rand() * 0.1, 1), leaves[i % 3]);
      blob.position.set(Math.cos(a) * spread * rand(), y, Math.sin(a) * spread * rand());
      blob.scale.y = 0.75 + rand() * 0.3;
      g.add(blob);
    }
    return g;
  },

  vanity({ width = 1.0 }) {
    const mirror = new THREE.MeshStandardMaterial({ color: '#b9c7dc', roughness: 0.12, metalness: 0.9 });
    return group(
      at(box(width, 0.62, 0.48, mat(WOOD, { rough: 0.6 }), { r: 0.012 }), 0, 0.2, 0),
      ...doorLines(width, 0.56, 0.23, 0.24, 2, mat(DARK_WOOD)),
      at(box(width + 0.03, 0.04, 0.5, mat(WHITE, { rough: 0.25 }), { r: 0.012 }), 0, 0.82, 0),
      at(cyl(0.19, 0.15, 0.1, mat(WHITE, { rough: 0.2 })), 0, 0.86, 0.02),
      at(cyl(0.012, 0.012, 0.2, mat(METAL, { rough: 0.2, metal: 0.9 }), 10), 0, 0.86, -0.18),
      at(box(width * 0.82, 0.8, 0.025, mirror, { r: 0.01 }), 0, 1.08, -0.225),
    );
  },

  bathtub() {
    return group(
      at(box(1.7, 0.56, 0.78, mat(WHITE, { rough: 0.25 }), { r: 0.1 }), 0, 0, 0),
      at(box(1.5, 0.02, 0.58, mat('#9fd3ec', { rough: 0.1, emissive: '#1d4f6b', emissiveIntensity: 0.25 }), { r: 0.009 }), 0, 0.545, 0),
      at(cyl(0.014, 0.014, 0.2, mat(METAL, { rough: 0.2, metal: 0.9 }), 10), -0.74, 0.56, 0),
    );
  },

  toilet() {
    const c = mat(WHITE, { rough: 0.25 });
    const bowl = at(cyl(0.19, 0.13, 0.4, c), 0, 0, 0.1);
    bowl.scale.z = 1.25;
    const lid = at(cyl(0.2, 0.2, 0.03, c), 0, 0.4, 0.1);
    lid.scale.z = 1.25;
    return group(at(box(0.38, 0.78, 0.17, c, { r: 0.03 }), 0, 0, -0.24), bowl, lid);
  },

  desk({ width = 1.4 }) {
    const c = chair('#2b2e37');
    c.position.z = 0.5;
    c.rotation.y = Math.PI;
    return group(
      at(box(width, 0.04, 0.65, mat(WOOD, { rough: 0.55 }), { r: 0.012 }), 0, 0.72, 0),
      ...legs(width, 0.65, 0.72, mat(BLACK), 0.06, 0.02),
      at(box(0.56, 0.34, 0.025, mat(BLACK, { rough: 0.3 }), { r: 0.008 }), 0, 0.86, -0.18),
      at(box(0.2, 0.1, 0.12, mat(BLACK), { r: 0.008 }), 0, 0.76, -0.18),
      c,
    );
  },

  wardrobe({ width = 1.6, height = 2.1 }) {
    return group(
      at(box(width, height, 0.6, mat(WHITE, { rough: 0.6 }), { r: 0.015 }), 0, 0, 0),
      ...doorLines(width, height - 0.08, 0.04, 0.3, Math.max(2, Math.round(width / 0.55)), mat('#b9b6ae')),
    );
  },

  bookshelf({ width = 1.0, height = 1.8 }) {
    const rand = rng(Math.round(width * 100 + height * 7));
    const wood = mat(WOOD, { rough: 0.6 });
    const g = group(at(box(width, height, 0.04, wood, { r: 0 }), 0, 0, -0.14));
    for (const sx of [-1, 1]) g.add(at(box(0.03, height, 0.32, wood, { r: 0 }), sx * (width / 2 - 0.015), 0, 0));
    const shelves = Math.round(height / 0.38);
    const colors = ['#c9553f', '#3d6b8c', '#d8c9a8', '#4f9462', '#8b93a7', '#d9b98a'];
    for (let i = 0; i <= shelves; i++) {
      const y = (height - 0.03) * (i / shelves);
      g.add(at(box(width, 0.03, 0.32, wood, { r: 0 }), 0, y, 0));
      if (i === shelves) break;
      let x = -width / 2 + 0.06;
      while (x < width / 2 - 0.12) {
        const bw = 0.03 + rand() * 0.04;
        const bh = 0.2 + rand() * 0.1;
        g.add(at(box(bw, bh, 0.2, mat(colors[Math.floor(rand() * colors.length)], { rough: 0.9 }), { r: 0 }), x + bw / 2, y + 0.03, 0));
        x += bw + 0.004;
        if (rand() < 0.12) x += 0.12;
      }
    }
    return g;
  },

  // A run of base cabinets with a countertop (no hob), with an optional single or double sink.
  counter({ width = 1.2, depth = 0.62, sink = 'none', sinkAt = 0, top = '#cfcbc3' }) {
    const front = mat(WHITE, { rough: 0.6 });
    const seam = mat('#b9b6ae');
    const doors = Math.max(1, Math.round(width / 0.5));
    const face = depth / 2 - 0.02;
    const g = group(
      at(box(width - 0.04, 0.1, depth - 0.1, mat('#2a2c33', { rough: 0.9 }), { r: 0 }), 0, 0, -0.05),
      at(box(width, 0.76, depth - 0.04, front, { r: 0.008 }), 0, 0.1, -0.02),
      ...doorLines(width, 0.56, 0.12, face + 0.003, doors, seam),
      at(box(width - 0.03, 0.006, 0.005, seam, { r: 0 }), 0, 0.69, face + 0.003),
      at(box(width + 0.01, 0.04, depth, mat(top, { rough: 0.4 }), { r: 0.008 }), 0, 0.86, 0),
    );
    if (sink === 'single' || sink === 'double') {
      const double = sink === 'double';
      const sw = Math.min(double ? 0.8 : 0.5, width - 0.1);
      const x = clampTo(sinkAt, -(width - sw) / 2, (width - sw) / 2);
      const steel = mat(METAL, { rough: 0.3, metal: 0.9 });
      const basin = mat('#6f747c', { rough: 0.35, metal: 0.7 });
      g.add(at(box(sw, 0.006, 0.44, steel, { r: 0 }), x, 0.9, 0.02));
      const bw = double ? (sw - 0.07) / 2 : sw - 0.06;
      for (const bx of double ? [x - (bw + 0.02) / 2, x + (bw + 0.02) / 2] : [x]) g.add(at(box(bw, 0.006, 0.36, basin, { r: 0.004 }), bx, 0.903, 0.03));
      g.add(at(cyl(0.015, 0.015, 0.26, steel, 10), x, 0.9, -0.2));
      const spout = at(cyl(0.012, 0.012, 0.16, steel, 10), x, 1.15, -0.13);
      spout.rotation.x = Math.PI / 2;
      g.add(spout);
    }
    return g;
  },

  // A freestanding white range: four coil burners, a back panel with knobs, the oven door.
  stove({ width = 0.76 }) {
    const d = 0.66;
    const white = mat('#f1efe9', { rough: 0.45 });
    const dark = mat(BLACK, { rough: 0.45 });
    const g = group(
      at(box(width, 0.9, d, white, { r: 0.012 }), 0, 0, 0),
      at(box(width - 0.02, 0.006, d - 0.12, mat('#e2dfd8', { rough: 0.5 }), { r: 0 }), 0, 0.9, 0.04),
      at(box(width, 0.2, 0.07, white, { r: 0.012 }), 0, 0.9, -d / 2 + 0.035),
      at(box(width - 0.2, 0.26, 0.008, mat('#14161b', { rough: 0.15 }), { r: 0.006 }), 0, 0.3, d / 2),
      at(box(width - 0.06, 0.006, 0.005, mat('#b9b6ae'), { r: 0 }), 0, 0.12, d / 2 + 0.001),
      at(box(width - 0.06, 0.006, 0.005, mat('#b9b6ae'), { r: 0 }), 0, 0.7, d / 2 + 0.001),
      at(box(width - 0.16, 0.022, 0.03, mat(METAL, { rough: 0.3, metal: 0.8 }), { r: 0.008 }), 0, 0.64, d / 2 + 0.03),
    );
    const bx = Math.min(0.17, width / 4.4);
    for (const [x, z, r] of [[-bx, -0.12, 0.1], [bx, -0.12, 0.08], [-bx, 0.14, 0.08], [bx, 0.14, 0.1]]) {
      g.add(at(cyl(r + 0.02, r + 0.02, 0.006, mat('#9da1a8', { rough: 0.4, metal: 0.6 }), 24), x, 0.903, z));
      for (const k of [1, 0.62, 0.3]) {
        const coil = new THREE.Mesh(new THREE.TorusGeometry(r * k, 0.008, 6, 28), dark);
        coil.rotation.x = -Math.PI / 2;
        coil.position.set(x, 0.915, z);
        g.add(coil);
      }
    }
    for (let i = 0; i < 4; i++) {
      const knob = at(cyl(0.022, 0.022, 0.03, dark, 14), -width / 2 + 0.12 + ((width - 0.24) / 3) * i, 1.0, -d / 2 + 0.07);
      knob.rotation.x = Math.PI / 2;
      g.add(knob);
    }
    return g;
  },

  // Countertop microwave; `y` (in the plan) lifts it onto a counter.
  microwave() {
    const black = mat('#18191d', { rough: 0.4 });
    return group(
      ...legs(0.48, 0.36, 0.012, black, 0.05, 0.012),
      at(box(0.5, 0.29, 0.38, black, { r: 0.012 }), 0, 0.012, 0),
      at(box(0.32, 0.2, 0.006, mat('#2c3340', { rough: 0.1, emissive: '#0e1626', emissiveIntensity: 0.4 }), { r: 0.004 }), -0.07, 0.07, 0.19),
      at(box(0.09, 0.22, 0.006, mat('#2a2d34', { rough: 0.5 }), { r: 0.004 }), 0.18, 0.05, 0.19),
      at(box(0.06, 0.025, 0.004, mat('#5fd3a3', { emissive: '#3fbf8a', emissiveIntensity: 0.8 }), { r: 0 }), 0.18, 0.225, 0.194),
      at(box(0.012, 0.18, 0.02, mat(METAL, { rough: 0.3, metal: 0.8 }), { r: 0.004 }), 0.105, 0.07, 0.2),
    );
  },

  // A wooden media cabinet (drawers and a door) with a dark granite top, the TV on a stand on it.
  tvCabinet({ width = 0.95, tv }) {
    const d = 0.52;
    const wood = mat('#7a5236', { rough: 0.65 });
    const seam = mat('#3d2a1d');
    const sw = Math.max(0.4, tv ?? width - 0.05);
    const sh = sw * 0.5625;
    const screen = tvScreen(sw - 0.02, sh - 0.02);
    const g = group(
      at(box(width, 0.76, d, wood, { r: 0.012 }), 0, 0, 0),
      at(box(0.006, 0.66, 0.005, seam, { r: 0 }), 0, 0.06, d / 2 + 0.001),
      at(box(width + 0.02, 0.035, d + 0.02, mat('#2b2d31', { rough: 0.25 }), { r: 0.008 }), 0, 0.76, 0),
      at(box(0.05, 0.05, 0.012, mat('#c9a15e', { rough: 0.4, metal: 0.5 }), { r: 0.005 }), width / 4 - 0.18, 0.45, d / 2 + 0.006),
      at(box(0.24, 0.015, 0.16, mat(BLACK, { rough: 0.4 }), { r: 0.005 }), 0, 0.795, -0.06),
      at(box(0.05, 0.1, 0.03, mat(BLACK, { rough: 0.4 }), { r: 0.005 }), 0, 0.81, -0.08),
      at(box(sw + 0.02, sh + 0.02, 0.04, mat(BLACK, { rough: 0.4 }), { r: 0.008 }), 0, 0.88, -0.08),
      at(screen, 0, 0.89, -0.055),
    );
    for (let i = 1; i < 3; i++) g.add(at(box(width / 2 - 0.04, 0.006, 0.005, seam, { r: 0 }), -width / 4, 0.06 + (0.66 / 3) * i, d / 2 + 0.001));
    g.userData.screen = screen;
    return g;
  },

  // A squashed, slumped blob: a sphere flattened on top, spread at the bottom, a little lumpy.
  beanBag({ size = [1.5, 0.9], color = '#d79aa6' }) {
    const [w, d] = size;
    const h = Math.min(0.62, 0.3 + Math.min(w, d) * 0.22);
    const geo = new THREE.SphereGeometry(1, 40, 24);
    const rand = rng(Math.round(w * 100 + d * 37));
    const bumps = Array.from({ length: 5 }, () => [rand() * Math.PI * 2, 0.04 + rand() * 0.05]);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const a = Math.atan2(z, x);
      // Bulge low down, a dip in the middle of the top where someone sat.
      const spread = 1 + 0.12 * (1 - (y + 1) / 2) ** 2 + bumps.reduce((sum, [b, k]) => sum + k * Math.cos(a - b) ** 8, 0);
      const ny = y < 0 ? y * 0.25 : y * (1 - 0.45 * Math.exp(-((x * x + z * z) / 0.25)));
      pos.setXYZ(i, (x * spread * w) / 2.24, ((ny + 0.25) / 1.25) * h, (z * spread * d) / 2.24);
    }
    geo.computeVertexNormals();
    return group(new THREE.Mesh(geo, mat(color, { rough: 1 })));
  },

  // A white tank water heater with its pipes and the burner control at the bottom front.
  waterHeater({ diameter = 0.55, height = 1.5 }) {
    const r = diameter / 2;
    const white = mat('#f0eee8', { rough: 0.4 });
    const copper = mat('#b87346', { rough: 0.35, metal: 0.7 });
    const top = new THREE.Mesh(new THREE.SphereGeometry(r, 28, 10, 0, Math.PI * 2, 0, Math.PI / 2), white);
    top.scale.y = 0.18;
    top.position.y = height - 0.06;
    const g = group(
      at(cyl(r, r, height - 0.06, white, 32), 0, 0, 0),
      top,
      at(cyl(r + 0.004, r + 0.004, 0.05, mat('#c9c6bf', { rough: 0.5 }), 32), 0, 0, 0),
      at(box(0.12, 0.12, 0.07, mat('#3a3d45', { rough: 0.5 }), { r: 0.01 }), 0, 0.3, r + 0.01),
      at(cyl(0.035, 0.035, 0.32, mat('#7f848c', { rough: 0.4, metal: 0.6 }), 12), 0, height - 0.02, 0),
    );
    for (const x of [-r * 0.5, r * 0.5]) g.add(at(cyl(0.016, 0.016, 0.45, copper, 10), x, height - 0.04, -r * 0.3));
    return g;
  },

  // One dining chair: wooden frame, dark seat and back rest.
  chair({ color = '#2b2e37' }) {
    const wood = mat(WOOD, { rough: 0.6 });
    const seat = mat(color, { rough: 0.8 });
    const g = group(
      ...legs(0.42, 0.42, 0.45, wood, 0.03, 0.017),
      at(box(0.44, 0.04, 0.44, wood, { r: 0.012 }), 0, 0.43, 0),
      at(box(0.4, 0.04, 0.4, seat, { r: 0.015 }), 0, 0.47, 0.01),
      at(box(0.4, 0.2, 0.025, seat, { r: 0.012 }), 0, 0.68, -0.2),
    );
    for (const sx of [-1, 1]) g.add(at(box(0.035, 0.5, 0.035, wood, { r: 0.008 }), sx * 0.19, 0.45, -0.2));
    return g;
  },

  // A hanging rod from closet wall to closet wall, the plan's `y` high, with hangers and clothes.
  closetRod({ width = 1.5, clothes = true }) {
    const steel = mat('#c9ccd2', { rough: 0.3, metal: 0.8 });
    const rod = at(cyl(0.014, 0.014, width, steel, 12), -width / 2, 0, 0);
    rod.rotation.z = -Math.PI / 2;
    const g = group(rod);
    for (const sx of [-1, 1]) g.add(at(box(0.03, 0.08, 0.06, mat(WHITE, { rough: 0.6 }), { r: 0.005 }), sx * (width / 2 - 0.015), -0.05, 0));
    const rand = rng(Math.round(width * 1000));
    const colors = ['#3d4f6b', '#c9553f', '#e9e6df', '#4f7a5c', '#1f2229', '#8b93a7', '#b8a07a', '#6a4a5e'];
    const count = Math.max(3, Math.floor(width / (clothes ? 0.075 : 0.18)));
    for (let i = 0; i < count; i++) {
      const x = -width / 2 + 0.08 + ((width - 0.16) / Math.max(1, count - 1)) * i + (rand() - 0.5) * 0.02;
      const hook = at(box(0.004, 0.06, 0.004, steel, { r: 0 }), x, -0.04, 0);
      const bar = at(box(0.006, 0.012, 0.4, steel, { r: 0 }), x, -0.1, 0);
      g.add(hook, bar);
      if (!clothes) continue;
      const len = 0.55 + rand() * 0.35;
      const piece = at(box(0.035, len, 0.42 + rand() * 0.06, mat(colors[Math.floor(rand() * colors.length)], { rough: 1 }), { r: 0.015 }), x, -0.1 - len, 0);
      piece.rotation.y = (rand() - 0.5) * 0.25;
      g.add(piece);
    }
    return g;
  },

  // A stack of lidded storage totes (red with black lids and corners, like a tool-box system).
  storageBins({ width = 0.6, stack = 2, color = '#c8372d' }) {
    const d = 0.42;
    const body = mat(color, { rough: 0.55 });
    const black = mat('#1e1f23', { rough: 0.6 });
    const g = group();
    const n = Math.max(1, Math.min(6, Math.round(stack)));
    for (let i = 0; i < n; i++) {
      const y = i * 0.31;
      g.add(
        at(box(width - 0.03, 0.25, d - 0.03, body, { r: 0.02 }), 0, y, 0),
        at(box(width, 0.05, d, black, { r: 0.015 }), 0, y + 0.25, 0),
        at(box(width * 0.4, 0.025, 0.04, black, { r: 0.008 }), 0, y + 0.18, d / 2 - 0.01),
      );
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(at(box(0.05, 0.25, 0.05, black, { r: 0.01 }), sx * (width / 2 - 0.035), y, sz * (d / 2 - 0.035)));
    }
    return g;
  },

  // The floor of a shower stall: a low tray with its drain (the stall's walls come from the room).
  shower({ size = [0.9, 0.9] }) {
    const [w, d] = size;
    const g = group(
      at(box(w, 0.05, d, mat(WHITE, { rough: 0.3 }), { r: 0.012 }), 0, 0, 0),
      at(box(w - 0.1, 0.01, d - 0.1, mat('#dfe6ec', { rough: 0.2 }), { r: 0.02 }), 0, 0.046, 0),
      at(cyl(0.045, 0.045, 0.008, mat(METAL, { rough: 0.3, metal: 0.8 }), 20), 0, 0.05, 0),
    );
    g.userData.flat = true;
    return g;
  },
};

export const FURNITURE_TYPES = Object.keys(builders);

// Approximate [width, depth] of each piece, for the 2D plan editor.
export function footprint(item) {
  const w = item.width;
  switch (item.type) {
    case 'rug': return item.size || [2, 1.4];
    case 'sofa': return [w || 2.2, 0.95];
    case 'armchair': return [0.92, 0.88];
    case 'coffeeTable': return [w || 1.1, 0.58];
    case 'tv': return [w || 1.7, 0.4];
    case 'sideboard': return [w || 1.6, 0.42];
    case 'diningSet': return [w || 1.8, 1.9];
    case 'island': return [w || 2, 1.1];
    case 'kitchen': return [w || 3, 0.62];
    case 'fridge': return [0.7, 0.68];
    case 'bed': return [(w || 1.6) + 0.1, 2.14];
    case 'nightstand': return [0.46, 0.4];
    case 'dresser': return [w || 1.3, 0.45];
    case 'plant': return [0.45, 0.45];
    case 'vanity': return [w || 1, 0.5];
    case 'bathtub': return [1.7, 0.78];
    case 'toilet': return [0.4, 0.66];
    case 'desk': return [w || 1.4, 0.65];
    case 'wardrobe': return [w || 1.6, 0.6];
    case 'bookshelf': return [w || 1, 0.32];
    case 'counter': return [w || 1.2, item.depth || 0.62];
    case 'stove': return [w || 0.76, 0.66];
    case 'microwave': return [0.5, 0.38];
    case 'tvCabinet': return [(w || 0.95) + 0.02, 0.54];
    case 'beanBag': return item.size || [1.5, 0.9];
    case 'waterHeater': return [item.diameter || 0.55, item.diameter || 0.55];
    case 'chair': return [0.46, 0.46];
    case 'closetRod': return [w || 1.5, item.clothes === false ? 0.4 : 0.48];
    case 'storageBins': return [w || 0.6, 0.42];
    case 'shower': return item.size || [0.9, 0.9];
    default: return [0.6, 0.6];
  }
}

// Pieces that do not stand on the floor unless the plan's `y` says so.
export const BASE_Y = { microwave: 0.9, closetRod: 1.75 };

// The root's userData.tvs lists every TV piece: { index (in the plan), item, group, screen, box }.
export function buildFurniture(items) {
  const root = new THREE.Group();
  root.userData.tvs = [];
  for (const [index, item] of items.entries()) {
    const make = builders[item.type];
    if (!make || !Array.isArray(item.pos)) {
      console.warn(`[plan] skipping furniture of unknown type "${item.type}"`);
      continue;
    }
    const g = make(item);
    if (g.userData.screen) root.userData.tvs.push({ index, item, group: g, screen: g.userData.screen, box: new THREE.Box3().setFromObject(g) });
    g.position.set(item.pos[0], item.y ?? BASE_Y[item.type] ?? 0, item.pos[1]);
    g.rotation.y = THREE.MathUtils.degToRad(item.rot || 0);
    const flat = g.userData.flat;
    g.traverse((o) => {
      if (o.isMesh) { o.castShadow = !flat; o.receiveShadow = true; }
    });
    root.add(g);
  }
  return root;
}
