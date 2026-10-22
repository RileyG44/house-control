// Loads and normalises a floor plan ("riley.json"). Everything the 3D scene and the UI
// know about the apartment comes from this one document, so swapping the file swaps the home.
import { roomPoints, oriented, polyArea, polyBox, polyProblem } from './geom.js';

const LIGHT_TYPES = ['ceiling', 'pendant', 'spots', 'floor', 'table', 'strip'];
const WALLS = ['north', 'south', 'east', 'west'];

export class ConfigError extends Error {}

export const LIGHT_KINDS = LIGHT_TYPES;

// A lamp or an AC is real when it is linked to a device of a connected platform:
// `link: { service, id }` (Home Assistant, Philips Hue, Apple Home) or, for Smart Life,
// `tuya: { deviceId }`. An AC's `sensor: { service, id }` is a thermometer for its room.
export const LINK_FIELDS = ['tuya', 'link', 'sensor'];

export function linkOf(d) {
  if (d?.link?.service && d.link.id) return { service: d.link.service, id: d.link.id };
  if (d?.tuya?.deviceId) return { service: 'smartlife', id: d.tuya.deviceId };
  return null;
}

export const isLinked = (d) => Boolean(linkOf(d));

/** The platforms House Control can link to, in the order the editor lists them. */
export const SERVICES = {
  smartlife: { name: 'Smart Life', short: 'Smart Life' },
  homeassistant: { name: 'Home Assistant', short: 'Home Assistant' },
  hue: { name: 'Philips Hue', short: 'Hue' },
  homekit: { name: 'Apple Home', short: 'Apple Home' },
  wiz: { name: 'WiZ', short: 'WiZ' },
  aidot: { name: 'AiDot', short: 'AiDot' },
  mrcool: { name: 'MRCOOL SmartHVAC', short: 'MRCOOL' },
};
export const FLOOR_KINDS = ['oak', 'walnut', 'tile', 'stone'];
/** The plan a fresh install shows. */
export const DEFAULT_PLAN = 'riley';

// The plan exactly as written on disk (the editor works on this form).
export async function loadRawConfig() {
  const boot = window.__HOUSE_BOOT__;
  if (boot?.config) return boot.config;
  const plan = (boot?.plan !== 'custom' && boot?.plan) || new URLSearchParams(location.search).get('plan') || DEFAULT_PLAN;
  const res = await fetch(`./plans/${plan}.json`);
  if (!res.ok) throw new ConfigError(`Plan "${plan}" not found (HTTP ${res.status})`);
  try {
    return await res.json();
  } catch (e) {
    throw new ConfigError(`Plan "${plan}" is not valid JSON: ${e.message}`);
  }
}

export async function loadConfig() {
  return normalize(await loadRawConfig());
}

function need(cond, msg) {
  if (!cond) throw new ConfigError(msg);
}

/**
 * A plan's scenes as the panel uses them. Built in or made on a screen ("custom-<name>-<hex>"),
 * each is { id, name, icon, lights: { "<lamp id>" | "*": patch }, acs: { "<AC id>" | "*": patch } };
 * `acs` is left out of the plan when a scene sets no AC. One without an id is dropped.
 */
export function normalizeScenes(list) {
  return list.filter((s) => typeof s?.id === 'string' && s.id).map((s) => ({
    id: s.id, name: s.name || s.id, icon: s.icon || 'sun', lights: s.lights || {}, acs: s.acs || {}, tvs: s.tvs || {},
  }));
}

const isPoint = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);

export function normalize(raw) {
  need(raw && typeof raw === 'object', 'Plan must be a JSON object');
  need(Array.isArray(raw.rooms) && raw.rooms.length > 0, 'Plan needs at least one room in "rooms"');

  const ids = new Set();
  const unique = (id, what) => {
    need(typeof id === 'string' && id, `${what} is missing an "id"`);
    need(!ids.has(id), `Duplicate id "${id}"`);
    ids.add(id);
  };

  // A room is a rectangle (`rect`) or any simple polygon (`poly`). Either way it gets its
  // corners (`points`, turning like a rect's), its area, and its bounding box as x/z/w/d for
  // the code that only needs a box.
  const rooms = raw.rooms.map((r) => {
    unique(r.id, 'A room');
    let points;
    if (r.poly != null) {
      need(Array.isArray(r.poly) && r.poly.every(isPoint), `Room "${r.id}" needs "poly": [[x, z], [x, z], [x, z], ...]`);
      points = r.poly.map((p) => [p[0], p[1]]);
      const [first, last] = [points[0], points[points.length - 1]];
      if (points.length > 3 && first[0] === last[0] && first[1] === last[1]) points.pop(); // a closed ring
      const problem = polyProblem(points);
      need(!problem, `Room "${r.id}": its polygon ${problem}`);
    } else {
      need(Array.isArray(r.rect) && r.rect.length === 4 && r.rect.every(Number.isFinite),
        `Room "${r.id}" needs "rect": [x, z, width, depth] or "poly": [[x, z], ...]`);
      need(r.rect[2] > 0 && r.rect[3] > 0, `Room "${r.id}" has an empty rect`);
      points = roomPoints(r);
    }
    points = oriented(points);
    const b = polyBox(points);
    return {
      id: r.id, name: r.name || r.id, x: b.minX, z: b.minZ, w: b.maxX - b.minX, d: b.maxZ - b.minZ,
      points, area: polyArea(points), poly: r.poly != null, floor: r.floor || 'oak',
    };
  });
  const roomIds = new Set(rooms.map((r) => r.id));

  // Openings lie on any wall line, straight or angled. A door opens into `swing` (a room id,
  // or "out" on an outside wall; by default the smaller room) and hangs on its `hinge` end.
  const openings = (raw.openings || []).map((o, i) => {
    need(isPoint(o.from) && isPoint(o.to), `Opening #${i + 1} needs "from" and "to" points`);
    const type = o.type || 'door';
    const out = { type, from: o.from, to: o.to, sill: o.sill ?? 0.85, head: o.head ?? 2.1 };
    if (type === 'door') {
      need(o.hinge == null || o.hinge === 'from' || o.hinge === 'to', `Opening #${i + 1}: "hinge" must be "from" or "to"`);
      need(o.swing == null || o.swing === 'out' || roomIds.has(o.swing), `Opening #${i + 1}: "swing" must be a room id or "out"`);
      out.hinge = o.hinge || 'from';
      if (o.swing) out.swing = o.swing;
    }
    if (type === 'open' && o.curtain) out.curtain = true;
    return out;
  });

  const lights = (raw.lights || []).map((l) => {
    unique(l.id, 'A light');
    need(roomIds.has(l.room), `Light "${l.id}" refers to unknown room "${l.room}"`);
    need(LIGHT_TYPES.includes(l.type), `Light "${l.id}" has unknown type "${l.type}" (use ${LIGHT_TYPES.join(', ')})`);
    need(isPoint(l.pos), `Light "${l.id}" needs "pos": [x, z]`);
    return {
      ...l,
      name: l.name || l.id,
      rot: l.rot || 0,
      capabilities: l.capabilities || [], // plain smart plugs: on/off only
    };
  });

  const acs = (raw.acs || []).map((a) => {
    unique(a.id, 'An AC');
    need(roomIds.has(a.room), `AC "${a.id}" refers to unknown room "${a.room}"`);
    need(isPoint(a.pos), `AC "${a.id}" needs "pos": [x, z]`);
    need(WALLS.includes(a.wall), `AC "${a.id}" needs "wall": one of ${WALLS.join(', ')}`);
    // "unit": "F" for an AC set in Fahrenheit (target, range and room temperature alike).
    const unit = a.unit === 'F' ? 'F' : 'C';
    const [min, max] = unit === 'F' ? [61, 86] : [16, 30];
    return { ...a, name: a.name || a.id, y: a.y ?? 2.2, unit, min: a.min ?? min, max: a.max ?? max };
  });

  for (const s of raw.scenes || []) need(typeof s?.id === 'string' && s.id, 'A scene is missing an "id"');
  const scenes = normalizeScenes(raw.scenes || []);

  // The device list's order, as the tiles were last dragged into it: lamp and AC ids, and
  // "tv:<id>" for a TV's tile. Tiles not listed follow, in the plan's order.
  const tileOrder = Array.isArray(raw.tileOrder) ? [...new Set(raw.tileOrder.filter((k) => typeof k === 'string' && k))] : [];

  const site = siteOf(raw.site);

  const minX = Math.min(...rooms.map((r) => r.x));
  const minZ = Math.min(...rooms.map((r) => r.z));
  const maxX = Math.max(...rooms.map((r) => r.x + r.w));
  const maxZ = Math.max(...rooms.map((r) => r.z + r.d));

  return {
    name: raw.name || 'Home',
    wallHeight: raw.wallHeight ?? 2.6,
    interiorWallHeight: raw.interiorWallHeight ?? 1.25,
    camera: { azimuth: raw.camera?.azimuth ?? 34, elevation: raw.camera?.elevation ?? 47 },
    outdoorTemp: raw.outdoorTemp ?? 27,
    rooms,
    openings,
    furniture: raw.furniture || [],
    lights,
    acs,
    scenes,
    tileOrder,
    site,
    bounds: { minX, minZ, maxX, maxZ },
  };
}

const SIDES = ['north', 'south', 'east', 'west'];

/**
 * Where the home is (docs/landscape-weather.md), or null: the stage then looks as it always
 * did. With one, the real sky and weather light it and a landscape is drawn around it.
 * `planUp` is the compass bearing of the plan's -z; `landscape` says on which side of the
 * plan the lake (`water`) and the field are, and how far from the walls they begin.
 */
function siteOf(site) {
  if (!site || typeof site !== 'object' || !Number.isFinite(site.lat) || !Number.isFinite(site.lon)) return null;
  if (Math.abs(site.lat) > 90 || Math.abs(site.lon) > 180) return null;
  const l = site.landscape && typeof site.landscape === 'object' ? site.landscape : {};
  const side = (v) => (SIDES.includes(v) ? v : null);
  const metres = (v, d) => (Number.isFinite(v) && v >= 0 ? Math.min(v, 200) : d);
  return {
    address: typeof site.address === 'string' ? site.address : '',
    lat: site.lat,
    lon: site.lon,
    planUp: Number.isFinite(site.planUp) ? site.planUp : 0,
    landscape: { water: side(l.water), field: side(l.field), shore: metres(l.shore, 7), fieldEdge: metres(l.fieldEdge, 9) },
  };
}
