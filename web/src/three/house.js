// Turns the rooms + openings of a plan into floors, walls and windows.
import * as THREE from 'three';
import { box, cyl, mat, at, floorMesh } from './kit.js';
import { TOL, oriented, inPolygon, lineOf, lineDist, along, pointAt, segDist } from '../geom.js';

const EXT_T = 0.2;   // exterior wall thickness
const INT_T = 0.1;   // interior wall thickness
const CURB = 0.14;   // height of the cut-away walls on the camera side
const EPS = 1e-4;

const DOOR_OPEN = 30; // degrees a door leaf stands open, so its swing reads in 3D

const key = (v) => Math.round(v * 1000);
const tidy = (v) => Math.round(v * 1e6) / 1e6;

// Splits every room edge into wall segments, classifying each as exterior / interior
// and attaching the opening (door, window, ...) that covers it, if any. Edges are grouped
// by the infinite line they lie on, at any angle, so two rooms sharing a stretch of wall
// share one segment. The editor's 2D plan draws the same walls from it.
//
// A segment: { from, to (end points), dir (unit, from -> to), normal (outward: away from
// the room, or for an interior wall away from the room its edge came from), len, kind,
// opening, freeA/freeB (no wall carries on along the same line), extA/extB (lengthen the
// end by half an exterior wall so a right-angled corner closes), jointA/jointB (meets a
// wall at another angle there: a column fills the joint) }. Axis-aligned segments also
// carry the older `axis` ('x': runs along x at z = c, or 'z'), `c`, `a`, `b`.
export function wallSegments(config) {
  const rooms = config.rooms.map((r) => oriented(r.points || [[r.x, r.z], [r.x + r.w, r.z], [r.x + r.w, r.z + r.d], [r.x, r.z + r.d]]));
  const lines = [];
  const lineFor = (a, b) => {
    let l = lines.find((m) => lineDist(m, a) < TOL && lineDist(m, b) < TOL);
    if (!l) { l = { ...lineOf(a, b), edges: [], openings: [] }; lines.push(l); }
    return l;
  };

  for (const pts of rooms) {
    pts.forEach((a, i) => {
      const b = pts[(i + 1) % pts.length];
      const l = lineFor(a, b);
      const [ta, tb] = [along(l, a), along(l, b)];
      // The room lies on the right of its edges: on the line's normal side when they agree.
      l.edges.push({ a: Math.min(ta, tb), b: Math.max(ta, tb), inside: ta < tb ? 1 : -1 });
    });
  }
  for (const o of config.openings) {
    let best = null;
    for (const l of lines) {
      const d = Math.max(lineDist(l, o.from), lineDist(l, o.to));
      if (d <= 0.01 && (!best || d < best.d)) best = { l, d };
    }
    if (!best) continue; // opening that is not on any wall: ignore
    const p = [along(best.l, o.from), along(best.l, o.to)];
    if (Math.abs(p[0] - p[1]) < 0.01) continue;
    best.l.openings.push({ ...o, a: Math.min(...p), b: Math.max(...p) });
  }

  const segments = [];
  for (const l of lines) {
    const pts = [...new Set([...l.edges, ...l.openings].flatMap((e) => [key(e.a), key(e.b)]))]
      .sort((p, q) => p - q).map((p) => p / 1000);
    const run = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const mid = (pts[i] + pts[i + 1]) / 2;
      const covering = l.edges.filter((e) => e.a < mid && mid < e.b);
      if (!covering.length) continue;
      // Two rooms meeting here face each other across the wall. A room drawn inside
      // another (a bathroom carved out of a studio) shares the outer walls on the same
      // side, and its own walls stand inside the bigger room: both cases are decided
      // by whether there is room on each side of the wall, not by how many edges meet.
      const m = pointAt(l, mid);
      const side = (d) => rooms.some((r) => inPolygon(r, [m[0] + l.n[0] * d, m[1] + l.n[1] * d]));
      const plus = side(0.05);
      const minus = side(-0.05);
      const seg = {
        line: l, ta: pts[i], tb: pts[i + 1],
        kind: plus && minus ? 'interior' : 'exterior',
        inside: covering[0].inside,
        out: plus && !minus ? -1 : minus && !plus ? 1 : -covering[0].inside,
        opening: l.openings.find((o) => o.a < mid && mid < o.b) || null,
      };
      const prev = run[run.length - 1];
      if (prev && Math.abs(prev.tb - seg.ta) < EPS && prev.kind === seg.kind && prev.inside === seg.inside
        && prev.out === seg.out && prev.opening === seg.opening) prev.tb = seg.tb;
      else run.push(seg);
    }
    run.forEach((s, i) => {
      s.freeA = !(run[i - 1] && Math.abs(run[i - 1].tb - s.ta) < EPS);
      s.freeB = !(run[i + 1] && Math.abs(run[i + 1].ta - s.tb) < EPS);
    });
    segments.push(...run);
  }

  for (const s of segments) {
    const l = s.line;
    s.from = pointAt(l, s.ta).map(tidy);
    s.to = pointAt(l, s.tb).map(tidy);
    s.dir = l.dir;
    s.normal = [l.n[0] * s.out, l.n[1] * s.out];
    s.len = s.tb - s.ta;
    if (Math.abs(l.dir[1]) < 1e-9) Object.assign(s, { axis: 'x', c: s.from[1], a: s.from[0], b: s.to[0] });
    else if (Math.abs(l.dir[0]) < 1e-9) Object.assign(s, { axis: 'z', c: s.from[0], a: s.from[1], b: s.to[1] });
  }
  // How each free end meets the walls of other lines: a right angle closes by lengthening
  // the end (as a corner always has); any other angle gets a column, never a spike.
  for (const s of segments) {
    for (const end of ['A', 'B']) {
      s[`ext${end}`] = false;
      s[`joint${end}`] = false;
      if (!s[`free${end}`]) continue;
      const p = end === 'A' ? s.from : s.to;
      const others = segments.filter((o) => o.line !== s.line && segDist(p, o.from, o.to) < TOL);
      const square = others.some((o) => Math.abs(o.dir[0] * s.dir[0] + o.dir[1] * s.dir[1]) < 1e-3);
      s[`ext${end}`] = square || !others.length;
      s[`joint${end}`] = others.some((o) => Math.abs(o.dir[0] * s.dir[0] + o.dir[1] * s.dir[1]) >= 1e-3);
    }
    delete s.line;
  }
  return segments;
}

/** The corners where walls meet at an angle other than 90°, with the segments meeting there. */
export function wallJoints(segments) {
  const joints = [];
  for (const s of segments) {
    for (const [flag, p] of [[s.jointA, s.from], [s.jointB, s.to]]) {
      if (!flag) continue;
      let j = joints.find((q) => Math.hypot(q.p[0] - p[0], q.p[1] - p[1]) < TOL);
      if (!j) { j = { p, segs: [] }; joints.push(j); }
      j.segs.push(s);
    }
  }
  for (const j of joints) {
    // Every wall running through the corner, also those it does not end on.
    for (const s of segments) if (!j.segs.includes(s) && segDist(j.p, s.from, s.to) < TOL) j.segs.push(s);
  }
  return joints;
}

/** Which side of a door's wall its leaf opens to: +1 along the segment's normal, -1 against. */
export function doorSide(config, s) {
  const o = s.opening;
  const mid = [(s.from[0] + s.to[0]) / 2, (s.from[1] + s.to[1]) / 2];
  const at = (sign) => [mid[0] + s.normal[0] * sign * 0.15, mid[1] + s.normal[1] * sign * 0.15];
  const roomOn = (sign) => {
    let best = null;
    for (const r of config.rooms) {
      const pts = r.points || [[r.x, r.z], [r.x + r.w, r.z], [r.x + r.w, r.z + r.d], [r.x, r.z + r.d]];
      const area = r.area ?? r.w * r.d;
      if (inPolygon(pts, at(sign)) && (!best || area < best.area)) best = { id: r.id, area };
    }
    return best;
  };
  const sides = [1, -1].map((sign) => ({ sign, room: roomOn(sign) }));
  if (o?.swing === 'out') return sides.find((x) => !x.room)?.sign ?? 1;
  const named = o?.swing && sides.find((x) => x.room?.id === o.swing);
  if (named) return named.sign;
  const rooms = sides.filter((x) => x.room).sort((p, q) => p.room.area - q.room.area);
  return rooms.length ? rooms[0].sign : -1;
}

export function buildHouse(config, camDir) {
  const group = new THREE.Group();
  const floors = [];
  const H = config.wallHeight;
  const Hi = Math.min(config.interiorWallHeight, H);
  const { minX, minZ, maxX, maxZ } = config.bounds;

  // Plinth the model stands on.
  const plinth = box(maxX - minX + 0.7, 0.3, maxZ - minZ + 0.7, mat('#141927', { rough: 0.9 }), { r: 0.12 });
  at(plinth, (minX + maxX) / 2, -0.305, (minZ + maxZ) / 2);
  plinth.receiveShadow = true;
  group.add(plinth);

  // Rooms may overlap (a bathroom drawn inside a studio). Floors in the same plane
  // fight over the same pixels, so the smaller room's floor is laid on top: lifted a
  // hair and pulled forward in the depth buffer, which keeps it stable at any zoom.
  const bySize = [...config.rooms].sort((p, q) => q.area - p.area);
  for (const room of config.rooms) {
    const floor = floorMesh(room, room.floor);
    const layer = bySize.indexOf(room);
    if (layer > 0) {
      floor.position.y = layer * 0.002;
      floor.material = floor.material.clone();
      Object.assign(floor.material, { polygonOffset: true, polygonOffsetFactor: -layer, polygonOffsetUnits: -layer * 4 });
    }
    floor.userData = { kind: 'room', id: room.id };
    floors.push(floor);
    group.add(floor);
  }

  const wallBody = mat('#e7e3db', { rough: 0.95 });
  const wallCap = mat('#262b3a', { rough: 0.8 });
  const wallMats = [wallBody, wallBody, wallCap, wallBody, wallBody, wallBody];
  const blocker = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
  const glass = new THREE.MeshStandardMaterial({
    color: '#9cc0ff', roughness: 0.08, transparent: true, opacity: 0.22,
    emissive: '#3d5fae', emissiveIntensity: 0.5,
  });
  const frame = mat('#2c3142', { rough: 0.6 });
  const doorMat = mat('#d8d0c2', { rough: 0.7 });
  const handle = mat('#9a9fa8', { rough: 0.3, metal: 0.8 });
  const rodMat = mat('#c9ccd2', { rough: 0.3, metal: 0.8 });
  const cloth = new THREE.MeshStandardMaterial({ color: '#e9eef4', roughness: 0.9, transparent: true, opacity: 0.62, side: THREE.DoubleSide });

  // A wall piece running a..b metres along a segment (from its `from` end), between heights y0..y1.
  const piece = (s, a, b, y0, y1, t, materials = wallMats) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(b - a, y1 - y0, t), materials);
    const mid = (a + b) / 2;
    m.position.set(s.from[0] + s.dir[0] * mid, (y0 + y1) / 2, s.from[1] + s.dir[1] * mid);
    m.rotation.y = Math.atan2(-s.dir[1], s.dir[0]);
    m.castShadow = m.receiveShadow = true;
    group.add(m);
    return m;
  };

  const segments = wallSegments(config);
  const drawn = new Map(); // segment -> height its wall is drawn to, for the corner columns
  for (const s of segments) {
    const exterior = s.kind === 'exterior';
    const t = exterior ? EXT_T : INT_T;
    // The cut-away side faces the camera, at whatever angle the wall stands.
    const near = exterior && s.normal[0] * camDir.x + s.normal[1] * camDir.z > 0.15;
    const a = s.extA ? -EXT_T / 2 : 0;
    const b = s.len + (s.extB ? EXT_T / 2 : 0);
    const type = s.opening?.type;
    const height = exterior ? H : Hi;

    if (type === 'door') {
      // On a cut-away wall the leaf would stand alone in front of the room: left out.
      if (!near) doorLeaf(s, Math.min(s.opening.head ?? 2.1, height));
      continue;
    }
    if (near) {
      piece(s, a, b, 0, CURB, t);
      drawn.set(s, CURB);
      continue;
    }
    if (type === 'open') {
      if (s.opening.curtain) curtain(s, Math.min(s.opening.head ?? 2.1, height));
      continue;
    }

    if (type === 'window' && exterior) {
      const { sill, head } = s.opening;
      piece(s, a, b, 0, sill, t);
      piece(s, a, b, Math.min(head, H), H, t);
      const pane = piece(s, a, b, sill, head, 0.03, glass);
      pane.castShadow = false;
      const fw = 0.05;
      const bars = [[a, a + fw, sill, head], [b - fw, b, sill, head], [a, b, sill, sill + fw], [a, b, head - fw, head]];
      if (b - a > 1.2) bars.push([(a + b) / 2 - fw / 2, (a + b) / 2 + fw / 2, sill, head]);
      for (const [fa, fb, y0, y1] of bars) piece(s, fa, fb, y0, y1, 0.07, frame);
      drawn.set(s, H);
      continue;
    }
    if (type === 'window') continue; // a window in an interior wall is just a gap

    piece(s, a, b, 0, height, t);
    drawn.set(s, height);
    // Interior walls are drawn cut low, but lamps should still be contained by the
    // real, full-height wall: an invisible shadow caster fills in the missing part.
    if (!exterior && Hi < H) piece(s, a, b, Hi, H, 0.04, blocker).receiveShadow = false;
  }

  // Where walls meet at an angle, a column as thick as the thicker wall closes the joint.
  const columnMats = [wallBody, wallCap, wallBody];
  for (const j of wallJoints(segments)) {
    const heights = j.segs.map((s) => drawn.get(s)).filter((v) => v != null);
    if (!heights.length) continue;
    const t = j.segs.some((s) => s.kind === 'exterior' && drawn.has(s)) ? EXT_T : INT_T;
    const column = new THREE.Mesh(new THREE.CylinderGeometry(t / 2, t / 2, Math.max(...heights), 20), columnMats);
    column.geometry.translate(0, Math.max(...heights) / 2, 0);
    column.position.set(j.p[0], 0, j.p[1]);
    column.castShadow = column.receiveShadow = true;
    group.add(column);
  }

  // A door leaf on its hinge, standing open towards the room it opens into.
  function doorLeaf(s, height) {
    const o = s.opening;
    const side = doorSide(config, s);
    const hingeAtTo = o.hinge === 'to' ? along2(s, o.to) > s.len / 2 : along2(s, o.from) > s.len / 2;
    const hinge = hingeAtTo ? s.to : s.from;
    const closed = hingeAtTo ? [-s.dir[0], -s.dir[1]] : s.dir;
    const n = [s.normal[0] * side, s.normal[1] * side];
    const k = THREE.MathUtils.degToRad(DOOR_OPEN);
    const d = [closed[0] * Math.cos(k) + n[0] * Math.sin(k), closed[1] * Math.cos(k) + n[1] * Math.sin(k)];
    const w = s.len - 0.03;
    const leaf = new THREE.Group();
    leaf.add(at(box(w, height - 0.02, 0.04, doorMat, { r: 0.01 }), w / 2, 0.01, 0));
    if (height > 0.9) for (const z of [-0.035, 0.035]) leaf.add(at(cyl(0.022, 0.022, 0.02, handle, 12), w - 0.08, 0.95, z));
    leaf.position.set(hinge[0] + n[0] * 0.02, 0, hinge[1] + n[1] * 0.02);
    leaf.rotation.y = Math.atan2(-d[1], d[0]);
    leaf.traverse((m) => { if (m.isMesh) m.castShadow = m.receiveShadow = true; });
    group.add(leaf);
  }

  // A shower or closet curtain: a rod across the opening, the cloth gathered at its `from` end.
  function curtain(s, height) {
    const rodY = height - 0.06;
    const rod = piece(s, 0.02, s.len - 0.02, rodY - 0.012, rodY + 0.012, 0.024, [rodMat]);
    rod.castShadow = false;
    const atFrom = along2(s, s.opening.from) < s.len / 2;
    const span = Math.min(0.45, s.len * 0.35);
    const folds = 7;
    for (let i = 0; i < folds; i++) {
      const t = (span / folds) * (i + 0.5);
      const pos = atFrom ? 0.04 + t : s.len - 0.04 - t;
      const off = (i % 2 ? 1 : -1) * 0.025;
      const fold = new THREE.Mesh(new THREE.BoxGeometry(span / folds * 1.25, rodY - 0.12, 0.012), cloth);
      fold.position.set(s.from[0] + s.dir[0] * pos + s.normal[0] * off, 0.1 + (rodY - 0.12) / 2, s.from[1] + s.dir[1] * pos + s.normal[1] * off);
      fold.rotation.y = Math.atan2(-s.dir[1], s.dir[0]) + (i % 2 ? 0.5 : -0.5);
      group.add(fold);
    }
  }

  return { group, floors };
}

// How far along a segment a point lies, in metres from its `from` end.
function along2(s, p) {
  return (p[0] - s.from[0]) * s.dir[0] + (p[1] - s.from[1]) * s.dir[1];
}
