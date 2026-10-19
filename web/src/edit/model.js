// Pure helpers on the plan document (the JSON exactly as saved: rooms carry `rect`
// [x, z, width, depth], lamps and ACs `pos` [x, z], all in metres, x east, z south).
// Nothing here touches the DOM, so the editor, its pages and the plan share one truth.
import { normalize, linkOf } from '../config.js';
import { FURNITURE_TYPES, footprint } from '../three/furniture.js';

export const COLLECTIONS = { room: 'rooms', light: 'lights', ac: 'acs', furniture: 'furniture', opening: 'openings', scene: 'scenes' };
// Rooms, lamps, ACs and scenes are named by id; furniture and openings have none, so by index.
export const BY_ID = new Set(['room', 'light', 'ac', 'scene']);

export const EPS = 1e-3;
export const fix = (v) => Math.round(v * 1000) / 1000;
export const snap = (v, step = 0.05) => fix(Math.round(v / step) * step);
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const slug = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item';

export function ensureArrays(doc) {
  for (const key of Object.values(COLLECTIONS)) if (!Array.isArray(doc[key])) doc[key] = [];
  return doc;
}

/** The plan as the 3D view reads it, or the reason it cannot be. */
export function check(doc) {
  try {
    return { config: normalize(structuredClone(doc)), error: null };
  } catch (e) {
    return { config: null, error: e.message };
  }
}

/* ---------- finding things ---------- */

export const rectOf = (r) => ({ x: r.rect[0], z: r.rect[1], w: r.rect[2], d: r.rect[3] });
export const area = (r) => r.rect[2] * r.rect[3];
export const roomById = (doc, id) => doc.rooms.find((r) => r.id === id) || null;
export const roomName = (doc, id) => roomById(doc, id)?.name || '';

export function contains(room, [x, z], pad = EPS) {
  const [rx, rz, rw, rd] = room.rect;
  return x >= rx - pad && x <= rx + rw + pad && z >= rz - pad && z <= rz + rd + pad;
}

// The smallest room containing the point: a bathroom drawn inside a studio wins over the studio.
export function roomAt(doc, p, { except = null } = {}) {
  let best = null;
  for (const r of doc.rooms) {
    if (r.id === except || !contains(r, p)) continue;
    if (!best || area(r) < area(best)) best = r;
  }
  return best;
}

/** The item a selection points at, or null. */
export function itemOf(doc, sel) {
  if (!sel) return null;
  const list = doc[COLLECTIONS[sel.kind]];
  if (!list) return null;
  return BY_ID.has(sel.kind) ? list.find((x) => x.id === sel.id) || null : list[sel.index] || null;
}

export function selOf(doc, kind, item) {
  return BY_ID.has(kind) ? { kind, id: item.id } : { kind, index: doc[COLLECTIONS[kind]].indexOf(item) };
}

export const sameSel = (a, b) => Boolean(a && b && a.kind === b.kind && (BY_ID.has(a.kind) ? a.id === b.id : a.index === b.index));

/** Where an item stands (its centre), for rooms the middle of the floor. */
export function centerOf(kind, item) {
  if (kind === 'room') return [item.rect[0] + item.rect[2] / 2, item.rect[1] + item.rect[3] / 2];
  if (kind === 'opening') return [(item.from[0] + item.to[0]) / 2, (item.from[1] + item.to[1]) / 2];
  return item.pos ? [...item.pos] : null;
}

// The four corners of a piece of furniture on the floor ("rot" turns it like the 3D model does).
export function corners(pos, [w, d], rot = 0) {
  const a = (rot * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]
    .map(([x, z]) => [pos[0] + x * c + z * s, pos[1] - x * s + z * c]);
}

/** A point in a piece's own frame: x along its width, z towards its front. */
export function toLocal(pos, rot, [x, z]) {
  const a = (rot * Math.PI) / 180;
  const dx = x - pos[0];
  const dz = z - pos[1];
  return [dx * Math.cos(a) - dz * Math.sin(a), dx * Math.sin(a) + dz * Math.cos(a)];
}

export function fromLocal(pos, rot, [x, z]) {
  const a = (rot * Math.PI) / 180;
  return [pos[0] + x * Math.cos(a) + z * Math.sin(a), pos[1] - x * Math.sin(a) + z * Math.cos(a)];
}

/** World-space box of one item, for fitting and bringing it into view. */
export function boxOf(kind, item) {
  if (kind === 'room') {
    const [x, z, w, d] = item.rect;
    return { minX: x, minZ: z, maxX: x + w, maxZ: z + d };
  }
  let pts;
  if (kind === 'furniture') pts = corners(item.pos, footprint(item), item.rot || 0);
  else if (kind === 'opening') pts = [item.from, item.to];
  else if (kind === 'light' && item.type === 'strip') {
    const half = (item.length || 1) / 2;
    pts = [fromLocal(item.pos, item.rot || 0, [-half, 0]), fromLocal(item.pos, item.rot || 0, [half, 0])];
  } else if (item.pos) {
    pts = [[item.pos[0] - 0.3, item.pos[1] - 0.3], [item.pos[0] + 0.3, item.pos[1] + 0.3]];
  } else return null;
  return {
    minX: Math.min(...pts.map((p) => p[0])), minZ: Math.min(...pts.map((p) => p[1])),
    maxX: Math.max(...pts.map((p) => p[0])), maxZ: Math.max(...pts.map((p) => p[1])),
  };
}

function union(boxes) {
  const list = boxes.filter(Boolean);
  if (!list.length) return null;
  return {
    minX: Math.min(...list.map((b) => b.minX)), minZ: Math.min(...list.map((b) => b.minZ)),
    maxX: Math.max(...list.map((b) => b.maxX)), maxZ: Math.max(...list.map((b) => b.maxZ)),
  };
}

export function roomBounds(doc) {
  return union(doc.rooms.map((r) => boxOf('room', r))) || { minX: 0, minZ: 0, maxX: 6, maxZ: 4 };
}

/** Rooms and everything else: furniture left outside the walls must stay reachable. */
export function bounds(doc) {
  return union([
    roomBounds(doc),
    ...doc.lights.map((l) => boxOf('light', l)),
    ...doc.acs.map((a) => boxOf('ac', a)),
    ...doc.furniture.filter((f) => Array.isArray(f.pos)).map((f) => boxOf('furniture', f)),
    ...doc.openings.filter((o) => o.from && o.to).map((o) => boxOf('opening', o)),
  ]);
}

/* ---------- names and ids ---------- */

export function uniqueId(doc, base) {
  const ids = new Set([...doc.rooms, ...doc.lights, ...doc.acs, ...doc.scenes].map((x) => x.id));
  const clean = base.replace(/\.+$/, '') || 'item';
  if (!ids.has(clean)) return clean;
  for (let i = 2; ; i++) if (!ids.has(`${clean}-${i}`)) return `${clean}-${i}`;
}

/** "Bedroom", then "Bedroom 2", "Bedroom 3"… */
export function uniqueName(taken, base) {
  const names = new Set(taken.map((n) => String(n).toLowerCase()));
  const stem = base.replace(/\s+\d+$/, '');
  if (!names.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!names.has(`${stem} ${i}`.toLowerCase())) return `${stem} ${i}`;
}

/* ---------- the catalog ---------- */

export const ROOM_PRESETS = [
  { name: 'Living room', icon: 'sofa', size: [4.5, 4], floor: 'oak' },
  { name: 'Bedroom', icon: 'bed', size: [3.6, 3.4], floor: 'oak' },
  { name: 'Kitchen', icon: 'kitchen', size: [3.2, 3], floor: 'tile' },
  { name: 'Bathroom', icon: 'bath', size: [2.4, 2.2], floor: 'tile' },
  { name: 'Office', icon: 'office', size: [3, 3], floor: 'oak' },
  { name: 'Dining room', icon: 'dining', size: [3.6, 3.2], floor: 'walnut' },
  { name: 'Hallway', icon: 'hallway', size: [1.4, 4], floor: 'stone' },
  { name: 'Closet', icon: 'closet', size: [1.6, 1.6], floor: 'oak' },
];

export const LIGHT_TYPES = [
  { type: 'ceiling', name: 'Ceiling', long: 'ceiling light' },
  { type: 'pendant', name: 'Pendant', long: 'pendant' },
  { type: 'spots', name: 'Spots', long: 'spots' },
  { type: 'floor', name: 'Floor lamp', long: 'floor lamp' },
  { type: 'table', name: 'Table lamp', long: 'table lamp' },
  { type: 'strip', name: 'Light strip', long: 'light strip' },
];
export const lightTypeName = (t) => LIGHT_TYPES.find((x) => x.type === t)?.name || t;

export const OPENING_TYPES = [
  { type: 'door', name: 'Door', icon: 'door', width: 0.9 },
  { type: 'window', name: 'Window', icon: 'window', width: 1.2 },
  { type: 'open', name: 'Open passage', icon: 'passage', width: 1.0 },
];
export const openingName = (t) => OPENING_TYPES.find((x) => x.type === (t || 'door'))?.name || 'Door';

export const FURNITURE_NAMES = {
  sofa: 'Sofa', armchair: 'Armchair', coffeeTable: 'Coffee table', tv: 'TV', sideboard: 'Sideboard',
  diningSet: 'Dining table', island: 'Kitchen island', kitchen: 'Kitchen counter', fridge: 'Fridge', bed: 'Bed',
  nightstand: 'Nightstand', dresser: 'Dresser', plant: 'Plant', vanity: 'Vanity', bathtub: 'Bathtub', toilet: 'Toilet',
  desk: 'Desk', wardrobe: 'Wardrobe', bookshelf: 'Bookshelf', rug: 'Rug',
};
// In the catalog's order (FURNITURE_TYPES is the 3D library's order).
export const FURNITURE_ORDER = Object.keys(FURNITURE_NAMES).filter((t) => FURNITURE_TYPES.includes(t));
export const furnitureName = (t) => FURNITURE_NAMES[t] || t;
export const RESIZABLE = new Set(['sofa', 'coffeeTable', 'tv', 'sideboard', 'diningSet', 'island', 'kitchen', 'bed', 'dresser', 'vanity', 'desk', 'wardrobe', 'bookshelf']);
export const COLORABLE = new Set(['sofa', 'armchair', 'bed', 'rug']);
export const FURNITURE_COLORS = ['#8b93a7', '#3a3f4a', '#c28a5a', '#7a4a3a', '#7f8fb5', '#4f7a5c', '#b8a07a', '#a65b6b'];
// The width each resizable piece has when the plan does not say (furniture.js defaults).
export const DEFAULT_WIDTH = { sofa: 2.2, coffeeTable: 1.1, tv: 1.7, sideboard: 1.6, diningSet: 1.8, island: 2, kitchen: 3, bed: 1.6, dresser: 1.3, vanity: 1, desk: 1.4, wardrobe: 1.6, bookshelf: 1 };

export const SCENE_ICONS = ['sun', 'sofa', 'film', 'moon', 'door', 'table', 'bed', 'tv', 'sparkles', 'power'];
export const FLOORS = [
  { id: 'oak', name: 'Oak', color: '#8a6a48' },
  { id: 'walnut', name: 'Walnut', color: '#5e4636' },
  { id: 'tile', name: 'Tile', color: '#9aa4ae' },
  { id: 'stone', name: 'Stone', color: '#6d737c' },
];
export const WALLS = ['north', 'east', 'south', 'west'];
export const WALL_SHORT = { north: 'N', east: 'E', south: 'S', west: 'W' };

/* ---------- units ---------- */

export function unitsOf(doc) {
  if (doc.units === 'imperial' || doc.units === 'metric') return doc.units;
  return doc.acs.some((a) => a.unit === 'F') ? 'imperial' : 'metric';
}

const INCH = 0.0254;

export function fmtLen(m, units) {
  if (!Number.isFinite(m)) return '—';
  if (units === 'imperial') {
    const inches = Math.round(Math.abs(m) / INCH);
    const sign = m < 0 ? '−' : '';
    const ft = Math.floor(inches / 12);
    const rest = inches % 12;
    if (!ft) return `${sign}${rest}″`;
    return `${sign}${ft}′ ${rest}″`;
  }
  return `${m < 0 ? '−' : ''}${String(Math.round(Math.abs(m) * 100) / 100)} m`;
}

export const fmtSize = (w, d, units) => `${fmtLen(w, units)} × ${fmtLen(d, units)}`;

export function fmtArea(m2, units) {
  if (units === 'imperial') return `${Math.round(m2 * 10.7639)} ft²`;
  return `${(Math.round(m2 * 10) / 10).toFixed(1)} m²`;
}

/** Steps of the steppers: lengths by 10 cm or 3 in, heights by 5 cm or 2 in (in metres). */
export const lengthStep = (units) => (units === 'imperial' ? 3 * INCH : 0.1);
export const heightStep = (units) => (units === 'imperial' ? 2 * INCH : 0.05);

/** Moves a length one step and lands on the step's grid, so 3.81 m + 3 in reads 12′ 9″. */
export function stepLength(m, dir, step) {
  return fix((Math.round(m / step) + dir) * step);
}

export const cToF = (c) => (c * 9) / 5 + 32;
export const fToC = (f) => ((f - 32) * 5) / 9;

/* ---------- walls ---------- */

// Every room edge as a wall line: { axis: 'x' (runs along x at z = c) | 'z' (along z at x = c), c, a, b }.
// Edges on the same line that touch or overlap are merged, so a door can slide along a
// wall shared by two rooms from one end to the other.
export function wallLines(doc) {
  const lines = new Map();
  const add = (axis, c, a, b) => {
    const key = `${axis}:${Math.round(c * 1000)}`;
    if (!lines.has(key)) lines.set(key, { axis, c, spans: [] });
    lines.get(key).spans.push([a, b]);
  };
  for (const r of doc.rooms) {
    const [x, z, w, d] = r.rect;
    add('x', z, x, x + w);
    add('x', z + d, x, x + w);
    add('z', x, z, z + d);
    add('z', x + w, z, z + d);
  }
  const out = [];
  for (const { axis, c, spans } of lines.values()) {
    spans.sort((p, q) => p[0] - q[0]);
    let cur = null;
    for (const [a, b] of spans) {
      if (cur && a <= cur.b + EPS) cur.b = Math.max(cur.b, b);
      else { cur = { axis, c, a, b }; out.push(cur); }
    }
  }
  return out;
}

export function openingAxis(o) {
  return Math.abs(o.from[1] - o.to[1]) < EPS ? 'x' : 'z';
}

/** The opening as a span on a line: { axis, c, a, b, w }. */
export function openingSpan(o) {
  const axis = openingAxis(o);
  const [p, q] = axis === 'x' ? [o.from[0], o.to[0]] : [o.from[1], o.to[1]];
  return { axis, c: axis === 'x' ? o.from[1] : o.from[0], a: Math.min(p, q), b: Math.max(p, q), w: Math.abs(q - p) };
}

export function setOpeningSpan(o, { axis, c, a, b }) {
  if (axis === 'x') { o.from = [fix(a), fix(c)]; o.to = [fix(b), fix(c)]; } else { o.from = [fix(c), fix(a)]; o.to = [fix(c), fix(b)]; }
}

/** The wall the opening lies on, or null when it floats off every wall line. */
export function wallOf(doc, o, lines = wallLines(doc)) {
  const s = openingSpan(o);
  const mid = (s.a + s.b) / 2;
  return lines.find((l) => l.axis === s.axis && Math.abs(l.c - s.c) < EPS && mid >= l.a - EPS && mid <= l.b + EPS) || null;
}

/** The wall line nearest to a point: { line, dist, t (position along it) }. */
export function nearestWall(doc, [x, z], { axis = null, lines = wallLines(doc) } = {}) {
  let best = null;
  for (const l of lines) {
    if (axis && l.axis !== axis) continue;
    const along = l.axis === 'x' ? x : z;
    const across = l.axis === 'x' ? z : x;
    const t = clamp(along, l.a, l.b);
    const dist = Math.hypot(along - t, across - l.c);
    if (!best || dist < best.dist) best = { line: l, dist, t };
  }
  return best;
}

/** Centres a span of `w` near `t` on a wall line, clear of the line's ends. */
export function placeOnWall(line, t, w) {
  const half = w / 2;
  const lo = line.a + half;
  const hi = line.b - half;
  const mid = lo > hi ? (line.a + line.b) / 2 : clamp(t, lo, hi);
  return { axis: line.axis, c: line.c, a: mid - half, b: mid + half };
}

/** Which rooms an opening joins: "Studio / Bathroom", or "Studio" on an outside wall. */
export function openingRooms(doc, o) {
  const s = openingSpan(o);
  const mid = (s.a + s.b) / 2;
  const at = (d) => (s.axis === 'x' ? [mid, s.c + d] : [s.c + d, mid]);
  const names = [roomAt(doc, at(-0.06)), roomAt(doc, at(0.06))].filter(Boolean).map((r) => r.name || r.id);
  return [...new Set(names)];
}

/* ---------- placing things ---------- */

// The wall an AC hangs on and where along it, from a point near it.
export function placeAC(room, wall, along) {
  const [rx, rz, rw, rd] = room.rect;
  const m = 0.5; // half a unit, so it never hangs over a corner
  const x = rw > 2 * m ? clamp(along, rx + m, rx + rw - m) : rx + rw / 2;
  const z = rd > 2 * m ? clamp(along, rz + m, rz + rd - m) : rz + rd / 2;
  if (wall === 'north') return [fix(snap(x)), fix(rz)];
  if (wall === 'south') return [fix(snap(x)), fix(rz + rd)];
  if (wall === 'west') return [fix(rx), fix(snap(z))];
  return [fix(rx + rw), fix(snap(z))];
}

export const wallMiddle = (room, wall) => (wall === 'north' || wall === 'south' ? room.rect[0] + room.rect[2] / 2 : room.rect[1] + room.rect[3] / 2);
export const alongWall = (wall, pos) => (wall === 'north' || wall === 'south' ? pos[0] : pos[1]);

// Puts an AC on the nearest wall of the room under (or nearest to) the point.
export function snapAC(doc, ac, [x, z]) {
  const room = roomAt(doc, [x, z]) || roomById(doc, ac.room) || doc.rooms[0];
  if (!room) return;
  const [rx, rz, rw, rd] = room.rect;
  const wall = [
    ['north', Math.abs(z - rz)], ['south', Math.abs(z - (rz + rd))],
    ['west', Math.abs(x - rx)], ['east', Math.abs(x - (rx + rw))],
  ].sort((p, q) => p[1] - q[1])[0][0];
  ac.room = room.id;
  ac.wall = wall;
  ac.pos = placeAC(room, wall, wall === 'north' || wall === 'south' ? x : z);
}

// The middle of the room, or the nearest place around it nothing else stands on.
export function freeSpot(doc, room, center, taken = doc.lights.map((l) => l.pos), gap = 0.45) {
  const [x, z, w, d] = room.rect;
  const busy = (p) => taken.some((q) => q && Math.hypot(q[0] - p[0], q[1] - p[1]) < gap);
  for (let ring = 0; ring < 6; ring++) {
    const n = Math.max(1, ring * 6);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const p = [snap(center[0] + Math.cos(a) * ring * 0.6), snap(center[1] + Math.sin(a) * ring * 0.6)];
      const inside = p[0] > x + 0.2 && p[0] < x + w - 0.2 && p[1] > z + 0.2 && p[1] < z + d - 0.2;
      if (inside && !busy(p) && roomAt(doc, p) === room) return p;
    }
  }
  return [snap(center[0]), snap(center[1])];
}

// A new room joins the home: beside it when the home is taller than wide, below it
// otherwise, on the same wall line so the walls meet.
export function presetRect(doc, [w, d], against = null) {
  if (!doc.rooms.length) return [0, 0, w, d];
  const b = against ? boxOf('room', against) : roomBounds(doc);
  const tall = b.maxZ - b.minZ > b.maxX - b.minX;
  const overlaps = (rect) => doc.rooms.some((r) => rect[0] < r.rect[0] + r.rect[2] - EPS && rect[0] + rect[2] > r.rect[0] + EPS
    && rect[1] < r.rect[1] + r.rect[3] - EPS && rect[1] + rect[3] > r.rect[1] + EPS);
  const right = [fix(b.maxX), fix(b.minZ), w, d];
  const below = [fix(b.minX), fix(b.maxZ), w, d];
  const order = tall ? [right, below] : [below, right];
  const free = order.find((r) => !overlaps(r));
  if (free) return free;
  const all = roomBounds(doc);
  return tall ? [fix(all.maxX), fix(all.minZ), w, d] : [fix(all.minX), fix(all.maxZ), w, d];
}

export function addRoom(doc, { name, size, floor = 'oak' }, { against = null, rect = null } = {}) {
  const room = {
    id: uniqueId(doc, slug(name)),
    name: uniqueName(doc.rooms.map((r) => r.name || r.id), name),
    floor,
    rect: rect ? rect.map(fix) : presetRect(doc, size, against),
  };
  doc.rooms.push(room);
  return room;
}

export function addLight(doc, type, room) {
  const kind = LIGHT_TYPES.find((t) => t.type === type) || LIGHT_TYPES[0];
  const name = uniqueName(doc.lights.map((l) => l.name || l.id), `${room.name || room.id} ${kind.long}`);
  const c = centerOf('room', room);
  const light = {
    id: uniqueId(doc, `${room.id}.${slug(kind.long)}`),
    name,
    room: room.id,
    type: kind.type,
    pos: freeSpot(doc, room, c),
    capabilities: ['brightness'],
  };
  if (type === 'strip') { light.length = Math.min(1.5, Math.max(0.6, fix(room.rect[2] / 2))); light.rot = 0; }
  doc.lights.push(light);
  return light;
}

export function addAC(doc, room) {
  const imperial = unitsOf(doc) === 'imperial';
  const used = new Set(doc.acs.filter((a) => a.room === room.id).map((a) => a.wall));
  const wall = WALLS.find((w) => !used.has(w)) || 'north';
  const ac = {
    id: uniqueId(doc, `${room.id}.ac`),
    name: uniqueName(doc.acs.map((a) => a.name || a.id), `${room.name || room.id} AC`),
    room: room.id,
    wall,
    pos: placeAC(room, wall, wallMiddle(room, wall)),
    y: 2.2,
    unit: imperial ? 'F' : 'C',
    min: imperial ? 61 : 16,
    max: imperial ? 86 : 30,
  };
  doc.acs.push(ac);
  return ac;
}

// Whether the floor just outside a room's edge belongs to another room, sampled along it.
function edgeRuns(doc, room, wall, wantInterior) {
  const [x, z, w, d] = room.rect;
  const horizontal = wall === 'north' || wall === 'south';
  const [a, b] = horizontal ? [x, x + w] : [z, z + d];
  const c = { north: z, south: z + d, west: x, east: x + w }[wall];
  const out = { north: -1, south: 1, west: -1, east: 1 }[wall];
  const runs = [];
  let cur = null;
  for (let t = a + 0.05; t < b; t += 0.1) {
    const p = horizontal ? [t, c + out * 0.06] : [c + out * 0.06, t];
    const interior = Boolean(roomAt(doc, p, { except: room.id }));
    if (interior === wantInterior) {
      if (cur && t - cur.b < 0.11) cur.b = t + 0.05; else { cur = { a: t - 0.05, b: t + 0.05 }; runs.push(cur); }
    } else cur = null;
  }
  return runs.map((r) => ({ wall, axis: horizontal ? 'x' : 'z', c, a: Math.max(a, r.a), b: Math.min(b, r.b) }));
}

// Doors go on a wall shared with another room, windows on an outside wall, each centred on
// the longest such stretch and moved along until it clears the openings already there.
export function addOpening(doc, type, room) {
  const kind = OPENING_TYPES.find((t) => t.type === type) || OPENING_TYPES[0];
  const width = kind.width;
  const prefer = type !== 'window';
  const longest = (runs) => runs.sort((p, q) => (q.b - q.a) - (p.b - p.a));
  const candidates = [...longest(WALLS.flatMap((w) => edgeRuns(doc, room, w, prefer))),
    ...longest(WALLS.flatMap((w) => edgeRuns(doc, room, w, !prefer)))];
  const spans = doc.openings.filter((o) => o.from && o.to).map(openingSpan);
  const clear = (axis, c, a, b) => !spans.some((s) => s.axis === axis && Math.abs(s.c - c) < EPS && a < s.b + 0.1 && b > s.a - 0.1);
  let placed = null;
  for (const run of candidates) {
    if (run.b - run.a < width) continue;
    const mid = (run.a + run.b) / 2;
    for (let k = 0; k < 60 && !placed; k++) {
      const off = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.1;
      const a = mid + off - width / 2;
      const b = a + width;
      if (a < run.a - EPS || b > run.b + EPS) continue;
      if (clear(run.axis, run.c, a, b)) placed = { axis: run.axis, c: run.c, a: snap(a), b: snap(a) + width };
    }
    if (placed) break;
  }
  if (!placed) {
    const [x, z, w] = room.rect;
    placed = { axis: 'x', c: z, a: x + w / 2 - width / 2, b: x + w / 2 + width / 2 };
  }
  const opening = { type: kind.type };
  setOpeningSpan(opening, placed);
  if (type === 'window') { opening.sill = 0.85; opening.head = 2.1; }
  doc.openings.push(opening);
  return opening;
}

export function addFurniture(doc, type, room) {
  const c = room ? centerOf('room', room) : [0, 0];
  const pos = room ? freeSpot(doc, room, c, doc.furniture.map((f) => f.pos), 0.6) : c;
  const item = { type, pos, rot: 0 };
  if (type === 'rug') item.size = [2, 1.4];
  if (type === 'diningSet') item.chairs = 4;
  if (type === 'island') item.stools = 3;
  doc.furniture.push(item);
  return item;
}

export function addScene(doc) {
  const scene = { id: uniqueId(doc, 'scene'), name: uniqueName(doc.scenes.map((s) => s.name || s.id), 'New scene'), icon: 'sparkles', lights: {}, acs: {} };
  doc.scenes.push(scene);
  return scene;
}

/* ---------- the room under or around things ---------- */

// What stands in a room, as the Room page lists it.
export function contentsOf(doc, room) {
  const mine = (p) => roomAt(doc, p) === room;
  return {
    lights: doc.lights.filter((l) => l.room === room.id),
    acs: doc.acs.filter((a) => a.room === room.id),
    openings: doc.openings.filter((o) => o.from && o.to && openingRooms(doc, o).includes(room.name || room.id)
      && contains(room, o.from) && contains(room, o.to)),
    furniture: doc.furniture.filter((f) => Array.isArray(f.pos) && mine(f.pos)),
  };
}

const inside = (outer, inner) => outer !== inner && inner.rect[0] >= outer.rect[0] - EPS && inner.rect[1] >= outer.rect[1] - EPS
  && inner.rect[0] + inner.rect[2] <= outer.rect[0] + outer.rect[2] + EPS && inner.rect[1] + inner.rect[3] <= outer.rect[1] + outer.rect[3] + EPS
  && area(inner) < area(outer);

/**
 * What travels with a room that is moved: rooms drawn inside it, lamps and furniture
 * standing in any of them, their ACs, and the doors and windows on or inside its walls.
 */
export function riders(doc, room) {
  const rooms = [room, ...doc.rooms.filter((r) => inside(room, r))];
  const ids = new Set(rooms.map((r) => r.id));
  const moving = new Set(rooms);
  const stands = (p, assigned) => {
    const at = roomAt(doc, p);
    return at ? moving.has(at) : ids.has(assigned);
  };
  return {
    rooms: rooms.slice(1),
    lights: doc.lights.filter((l) => stands(l.pos, l.room)),
    acs: doc.acs.filter((a) => ids.has(a.room)),
    furniture: doc.furniture.filter((f) => Array.isArray(f.pos) && roomAt(doc, f.pos) && moving.has(roomAt(doc, f.pos))),
    openings: doc.openings.filter((o) => o.from && o.to && contains(room, o.from) && contains(room, o.to)),
  };
}

/* ---------- removing ---------- */

// Removing lamps or ACs takes them out of every scene too.
function pruneScenes(doc) {
  const ids = new Set([...doc.lights, ...doc.acs].map((d) => d.id));
  for (const sc of doc.scenes) {
    for (const map of [sc.lights, sc.acs]) for (const id of Object.keys(map || {})) if (id !== '*' && !ids.has(id)) delete map[id];
  }
}

/** What deleting a room would do, in words and as lists, for the confirmation. */
export function roomDeletion(doc, room) {
  const moves = [];
  const removes = [];
  for (const d of [...doc.lights.filter((l) => l.room === room.id), ...doc.acs.filter((a) => a.room === room.id)]) {
    const to = roomAt(doc, d.pos, { except: room.id });
    if (to) moves.push({ item: d, to }); else removes.push(d);
  }
  const others = doc.rooms.filter((r) => r !== room);
  const onOtherWall = (o) => {
    const rest = { ...doc, rooms: others };
    return Boolean(wallOf(rest, o));
  };
  const furniture = doc.furniture.filter((f) => Array.isArray(f.pos) && contains(room, f.pos) && !others.some((r) => contains(r, f.pos)));
  const openings = doc.openings.filter((o) => o.from && o.to && contains(room, o.from) && contains(room, o.to) && !onOtherWall(o));
  const lines = [];
  const byRoom = new Map();
  for (const m of moves) {
    const key = m.to.name || m.to.id;
    const kind = doc.acs.includes(m.item) ? 'ac' : 'light';
    const e = byRoom.get(key) || { light: 0, ac: 0 };
    e[kind]++;
    byRoom.set(key, e);
  }
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  for (const [to, e] of byRoom) {
    const parts = [e.light && count(e.light, 'light', 'lights'), e.ac && count(e.ac, 'AC', 'ACs')].filter(Boolean).join(' and ');
    lines.push(`${parts} move${e.light + e.ac === 1 ? 's' : ''} to ${to}`);
  }
  const gone = [];
  const lightsGone = removes.filter((d) => doc.lights.includes(d)).length;
  const acsGone = removes.length - lightsGone;
  if (lightsGone) gone.push(count(lightsGone, 'light', 'lights'));
  if (acsGone) gone.push(count(acsGone, 'AC', 'ACs'));
  if (furniture.length) gone.push(count(furniture.length, 'piece of furniture', 'pieces of furniture'));
  if (openings.length) gone.push(count(openings.length, 'door or window', 'doors and windows'));
  const total = removes.length + furniture.length + openings.length;
  if (gone.length) lines.push(`${gone.join(', ')} ${total === 1 ? 'is' : 'are'} removed with it`);
  return { moves, removes, furniture, openings, lines, empty: !moves.length && !removes.length && !furniture.length && !openings.length };
}

export function deleteRoom(doc, room) {
  const plan = roomDeletion(doc, room);
  for (const { item, to } of plan.moves) {
    item.room = to.id;
    if (doc.acs.includes(item)) snapAC(doc, item, item.pos);
  }
  const gone = new Set([...plan.removes, ...plan.furniture, ...plan.openings, room]);
  doc.rooms = doc.rooms.filter((r) => !gone.has(r));
  doc.lights = doc.lights.filter((l) => !gone.has(l));
  doc.acs = doc.acs.filter((a) => !gone.has(a));
  doc.furniture = doc.furniture.filter((f) => !gone.has(f));
  doc.openings = doc.openings.filter((o) => !gone.has(o));
  // A room re-snapped above may have moved an AC onto the deleted room's wall: snap again.
  for (const a of doc.acs) if (!roomById(doc, a.room)) a.room = doc.rooms[0]?.id;
  pruneScenes(doc);
  return plan;
}

export function removeItem(doc, sel) {
  const item = itemOf(doc, sel);
  if (!item) return null;
  if (sel.kind === 'room') return deleteRoom(doc, item);
  const key = COLLECTIONS[sel.kind];
  doc[key] = doc[key].filter((x) => x !== item);
  pruneScenes(doc);
  return item;
}

/* ---------- duplicating ---------- */

// The copy sits 0.3 m away, gets a new id and "… 2" for a name, and is not linked: one
// real bulb drives one lamp on the plan.
export function duplicate(doc, sel) {
  const item = itemOf(doc, sel);
  if (!item) return null;
  const copy = structuredClone(item);
  const shift = (p) => [fix(p[0] + 0.3), fix(p[1] + 0.3)];
  if (sel.kind === 'room') {
    copy.id = uniqueId(doc, item.id);
    copy.name = uniqueName(doc.rooms.map((r) => r.name || r.id), item.name || item.id);
    copy.rect = presetRect(doc, [item.rect[2], item.rect[3]], item);
    doc.rooms.push(copy);
    return { kind: 'room', id: copy.id };
  }
  if (sel.kind === 'light' || sel.kind === 'ac') {
    copy.id = uniqueId(doc, item.id);
    copy.name = uniqueName(doc[COLLECTIONS[sel.kind]].map((x) => x.name || x.id), item.name || item.id);
    delete copy.link;
    delete copy.tuya;
    delete copy.sensor;
    if (sel.kind === 'ac') {
      const room = roomById(doc, item.room);
      copy.pos = room ? placeAC(room, item.wall, alongWall(item.wall, item.pos) + 1.1) : shift(item.pos);
      doc.acs.push(copy);
    } else {
      copy.pos = shift(item.pos);
      copy.room = roomAt(doc, copy.pos)?.id || item.room;
      doc.lights.push(copy);
    }
    return { kind: sel.kind, id: copy.id };
  }
  if (sel.kind === 'furniture') {
    copy.pos = shift(item.pos);
    doc.furniture.push(copy);
    return { kind: 'furniture', index: doc.furniture.length - 1 };
  }
  if (sel.kind === 'opening') {
    const s = openingSpan(item);
    const line = wallOf(doc, item);
    const spans = doc.openings.map(openingSpan);
    const free = (a) => !spans.some((o) => o.axis === s.axis && Math.abs(o.c - s.c) < EPS && a < o.b + 0.1 && a + s.w > o.a - 0.1);
    let a = s.b + 0.3;
    for (const cand of [s.b + 0.3, s.a - 0.3 - s.w]) if ((!line || (cand >= line.a - EPS && cand + s.w <= line.b + EPS)) && free(cand)) { a = cand; break; }
    setOpeningSpan(copy, { ...s, a, b: a + s.w });
    doc.openings.push(copy);
    return { kind: 'opening', index: doc.openings.length - 1 };
  }
  if (sel.kind === 'scene') {
    copy.id = uniqueId(doc, item.id);
    copy.name = uniqueName(doc.scenes.map((x) => x.name || x.id), item.name || item.id);
    doc.scenes.push(copy);
    return { kind: 'scene', id: copy.id };
  }
  return null;
}

/* ---------- devices ---------- */

/** "service|id" of every device the plan links, with the name of the item using it. */
export function usedDevices(doc) {
  const out = new Map();
  for (const d of [...doc.lights, ...doc.acs]) {
    const l = linkOf(d);
    if (l) out.set(`${l.service}|${l.id}`, d.name || d.id);
    if (d.sensor?.id) out.set(`${d.sensor.service}|${d.sensor.id}`, d.name || d.id);
    if (d.tuya?.sensorId) out.set(`smartlife|${d.tuya.sensorId}`, d.name || d.id);
  }
  return out;
}

/** Links an item to a device of the catalog (or unlinks it with null), adapting it. */
export function linkDevice(item, kind, device) {
  delete item.link;
  if (item.tuya) { delete item.tuya.deviceId; if (!Object.keys(item.tuya).length) delete item.tuya; }
  if (!device) return null;
  if (device.service === 'smartlife') item.tuya = { ...(item.tuya || {}), deviceId: device.id };
  else {
    item.link = { service: device.service, id: device.id };
    // Smart Life sensors only work beside a Smart Life AC.
    if (item.tuya) delete item.tuya;
  }
  if (kind === 'light' && Array.isArray(device.capabilities)) {
    item.capabilities = [...device.capabilities];
    return device.capabilities.length ? `Matched: ${capabilityWords(device.capabilities)}` : 'Matched: an on/off switch';
  }
  if (kind === 'ac' && device.min != null && device.max != null) {
    item.min = Math.round(device.min);
    item.max = Math.round(device.max);
    if (/°F/.test(device.detail || '') || device.unit === 'F') item.unit = 'F';
    else if (/°C/.test(device.detail || '') || device.unit === 'C') item.unit = 'C';
    return `Matched: ${item.min}–${item.max}°${item.unit === 'F' ? 'F' : 'C'}`;
  }
  return null;
}

export function capabilityWords(caps) {
  const words = { brightness: 'dimming', temp: 'white temperature', color: 'colour' };
  return caps.map((c) => words[c] || c).join(', ');
}

/** A new lamp or AC for a device found on the network, in the room it says it is in. */
export function addFromDevice(doc, device, fallbackRoom) {
  const room = doc.rooms.find((r) => (r.name || '').toLowerCase() === String(device.room || '').toLowerCase()) || fallbackRoom || doc.rooms[0];
  if (device.kind === 'ac') {
    const ac = addAC(doc, room);
    ac.name = uniqueName(doc.acs.filter((a) => a !== ac).map((a) => a.name || a.id), device.name || ac.name);
    linkDevice(ac, 'ac', device);
    return { kind: 'ac', id: ac.id };
  }
  const light = addLight(doc, device.detail && /strip/i.test(device.detail) ? 'strip' : 'table', room);
  light.name = uniqueName(doc.lights.filter((l) => l !== light).map((l) => l.name || l.id), device.name || light.name);
  linkDevice(light, 'light', device);
  return { kind: 'light', id: light.id };
}
