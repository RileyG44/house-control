// Plane geometry of the floor plan: rooms are polygons (a `rect` is just four corners),
// points are [x, z] in metres seen from above, x east, z south. Pure functions, shared by
// the loader, the 3D walls, the editor and the AI's plan edits.

export const TOL = 1e-3; // 1 mm: points this close are the same point, lines this close the same line

/** The corners of a room as written on disk: its `poly`, or the four corners of its `rect`. */
export function roomPoints(r) {
  if (Array.isArray(r?.poly)) return r.poly.map((p) => [p[0], p[1]]);
  const [x, z, w, d] = r.rect;
  return [[x, z], [x + w, z], [x + w, z + d], [x, z + d]];
}

/** Twice the signed area: positive when the corners turn like a rect's (clockwise on screen). */
function signed(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, z1] = pts[i];
    const [x2, z2] = pts[(i + 1) % pts.length];
    s += x1 * z2 - x2 * z1;
  }
  return s;
}

export const polyArea = (pts) => Math.abs(signed(pts)) / 2;

/** The corners turning the same way as a rect's, so an edge's room is always on its right. */
export function oriented(pts) {
  return signed(pts) < 0 ? [...pts].reverse() : pts;
}

export function polyBox(pts) {
  const xs = pts.map((p) => p[0]);
  const zs = pts.map((p) => p[1]);
  const minX = Math.min(...xs);
  const minZ = Math.min(...zs);
  return { minX, minZ, maxX: Math.max(...xs), maxZ: Math.max(...zs) };
}

/** Distance from a point to the segment a–b. */
export function segDist([px, pz], [ax, az], [bx, bz]) {
  const dx = bx - ax;
  const dz = bz - az;
  const len = dx * dx + dz * dz;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

/** Distance from a point to the outline of a polygon. */
export function edgeDist(pts, p) {
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) best = Math.min(best, segDist(p, pts[i], pts[(i + 1) % pts.length]));
  return best;
}

/** Strictly inside (even-odd rule); points on the outline may go either way. */
export function inPolygon(pts, [x, z]) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i];
    const [xj, zj] = pts[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Inside, or within `pad` of the outline (so a lamp on the wall still belongs to the room). */
export function containsPoint(pts, p, pad = TOL) {
  return inPolygon(pts, p) || edgeDist(pts, p) <= pad;
}

/** Strictly inside and at least `pad` away from the outline. */
export function insidePoint(pts, p, pad = TOL) {
  return inPolygon(pts, p) && edgeDist(pts, p) > pad;
}

function cross(o, a, b) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

// Whether segments p1–p2 and q1–q2 touch (touching ends and overlaps included).
function segmentsMeet(p1, p2, q1, q2) {
  const d1 = cross(q1, q2, p1);
  const d2 = cross(q1, q2, p2);
  const d3 = cross(p1, p2, q1);
  const d4 = cross(p1, p2, q2);
  const e = 1e-12;
  if (((d1 > e && d2 < -e) || (d1 < -e && d2 > e)) && ((d3 > e && d4 < -e) || (d3 < -e && d4 > e))) return true;
  const on = (a, b, c, d) => Math.abs(d) <= e && Math.min(a[0], b[0]) - e <= c[0] && c[0] <= Math.max(a[0], b[0]) + e
    && Math.min(a[1], b[1]) - e <= c[1] && c[1] <= Math.max(a[1], b[1]) + e;
  return on(q1, q2, p1, d1) || on(q1, q2, p2, d2) || on(p1, p2, q1, d3) || on(p1, p2, q2, d4);
}

/** Why a polygon cannot be a room, or null when it can. */
export function polyProblem(pts) {
  if (pts.length < 3) return 'needs at least 3 corners';
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < TOL) return `has two corners in the same place (corner ${i + 1})`;
  }
  if (polyArea(pts) < 0.01) return 'has no area';
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const next = (j === i + 1) || (i === 0 && j === n - 1);
      const [a1, a2, b1, b2] = [pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n]];
      if (next) {
        // Neighbouring edges share a corner; they must not fold back over each other.
        const shared = j === i + 1 ? a2 : a1;
        const p = j === i + 1 ? a1 : a2;
        const q = j === i + 1 ? b2 : b1;
        const u = [p[0] - shared[0], p[1] - shared[1]];
        const v = [q[0] - shared[0], q[1] - shared[1]];
        const lu = Math.hypot(...u);
        const lv = Math.hypot(...v);
        if (Math.abs(u[0] * v[1] - u[1] * v[0]) < 1e-9 * lu * lv + 1e-12 && u[0] * v[0] + u[1] * v[1] > 0) return `folds back on itself at corner ${pts.indexOf(shared) + 1}`;
        continue;
      }
      if (segmentsMeet(a1, a2, b1, b2)) return `crosses itself (edges ${i + 1} and ${j + 1})`;
    }
  }
  return null;
}

/**
 * A good place for a label: the point inside the polygon farthest from its outline
 * (the middle of a rectangle, the wide part of an L), found on a coarse grid then refined.
 */
export function labelPoint(pts) {
  const b = polyBox(pts);
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  if (pts.length === 4 && insidePoint(pts, [cx, cz], 0) && Math.abs(polyArea(pts) - (b.maxX - b.minX) * (b.maxZ - b.minZ)) < 1e-6) return [cx, cz];
  let best = null;
  const score = (p) => {
    if (!inPolygon(pts, p)) return -Infinity;
    // A little pull towards the middle keeps symmetric shapes centred.
    return edgeDist(pts, p) - 0.02 * Math.hypot(p[0] - cx, p[1] - cz);
  };
  let step = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) / 24;
  for (let x = b.minX + step / 2; x < b.maxX; x += step) {
    for (let z = b.minZ + step / 2; z < b.maxZ; z += step) {
      const s = score([x, z]);
      if (!best || s > best.s) best = { p: [x, z], s };
    }
  }
  if (!best || best.s === -Infinity) return [cx, cz];
  for (let k = 0; k < 4; k++) {
    step /= 2;
    for (const [dx, dz] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
      const p = [best.p[0] + dx, best.p[1] + dz];
      const s = score(p);
      if (s > best.s) best = { p, s };
    }
  }
  return best.p;
}

/** The line through two points: its direction (pointing east, or south when it runs north–south), normal and offset. */
export function lineOf(a, b) {
  let ux = b[0] - a[0];
  let uz = b[1] - a[1];
  const len = Math.hypot(ux, uz) || 1;
  ux /= len;
  uz /= len;
  if (ux < -1e-9 || (Math.abs(ux) <= 1e-9 && uz < 0)) { ux = -ux; uz = -uz; }
  const n = [-uz, ux];
  return { dir: [ux, uz], n, c: n[0] * a[0] + n[1] * a[1] };
}

/** Distance of a point from an infinite line ({ n, c } of lineOf). */
export const lineDist = (line, p) => Math.abs(line.n[0] * p[0] + line.n[1] * p[1] - line.c);

/** Position of a point along a line ({ dir } of lineOf), in metres. */
export const along = (line, p) => line.dir[0] * p[0] + line.dir[1] * p[1];

/** The point at `t` metres along a line. */
export const pointAt = (line, t) => [line.dir[0] * t + line.n[0] * line.c, line.dir[1] * t + line.n[1] * line.c];
