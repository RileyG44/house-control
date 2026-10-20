// The pages of the editor's sheet. Each page renders from the document every time (a page
// is re-rendered after every committed change), reads through `ctx` and changes the plan
// only through `ctx.change`, so every edit is one undo step and one save.
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { isNative, isHub } from '../bridge.js';
import { isLinked, linkOf, SERVICES } from '../config.js';
import { footprint } from '../three/furniture.js';
import { thumbnail } from './glyphs.js';
import {
  group, row, tile, textRow, toggleRow, stepperRow, segmentedRow, segmented, chipGrid, swatches, button, note, quickActions,
} from './forms.js';
import * as M from './model.js';

const ACCENT = '#3d8bff';
const TINT = {
  room: '#8e7cff', light: '#ffb340', ac: '#5ac8fa', opening: '#a2845e', furniture: '#30b0c7', scene: '#ff9f0a',
  settings: '#8e8e93', add: ACCENT, network: '#34c759', danger: '#ff453a',
};
const FLOOR_SWATCH = Object.fromEntries(M.FLOORS.map((f) => [f.id, f.color]));
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const DEFAULT_Y = (type, H) => ({ ceiling: H - 0.14, pendant: 1.8, spots: H - 0.16, table: 0.5, strip: 1 }[type]);
const deg = (v) => `${Math.round(v)}°`;
const wrapDeg = (v) => ((Math.round(v) % 360) + 360) % 360;

function floorChip(floor, size = 28) {
  return h('span.ed-floor-chip', { vars: { '--sw': FLOOR_SWATCH[floor] || FLOOR_SWATCH.oak, '--size': `${size}px` } });
}

function glyphTile(item, size = 40) {
  return h('span.ed-tile.glyph', { vars: { '--tint': 'rgba(48,176,199,.22)', '--size': `${size}px` } }, thumbnail(item, Math.round(size * 0.86)));
}

function lightTile(ctx, light, size = 40) {
  const t = tile(light.type === 'strip' ? 'strip' : light.type, TINT.light, size);
  const live = ctx.live(light.id);
  if (live?.on) { t.classList.add('glow'); t.style.setProperty('--glow', live.color); }
  return t;
}

// "3.6 m × 2.2 m" for a rectangular room; a polygon room by its area.
const roomSize = (r, units) => (M.isPoly(r) ? M.fmtArea(M.area(r), units) : M.fmtSize(r.rect[2], r.rect[3], units));

// A catalog chip for a piece of furniture, drawn as it looks on the plan.
const furnitureChip = (t, px) => ({ value: t, label: M.furnitureName(t), glyph: thumbnail({ type: t, ...(t === 'rug' ? { color: '#5a6b8f' } : t === 'counter' ? { sink: 'single' } : {}) }, px) });

const linkName = (item) => {
  const l = linkOf(item);
  return l ? SERVICES[l.service]?.short || l.service : 'Simulated';
};

/* ---------- Home ---------- */

export function homePage(ctx) {
  return {
    key: 'home',
    short: 'Home',
    kind: 'root',
    render() {
      const doc = ctx.doc;
      const units = ctx.units;
      const n = { rooms: doc.rooms.length, lights: doc.lights.length, acs: doc.acs.length };
      const subtitle = [count(n.rooms, 'room'), count(n.lights, 'light'), count(n.acs, 'AC')].join(' · ');
      const fresh = ctx.links.unlinked(doc);
      const empty = doc.rooms.length === 1 && !doc.lights.length && !doc.acs.length && !doc.furniture.length;
      const extra = [];
      if (fresh.length) {
        extra.push(h('button.ed-found', { type: 'button', onclick: () => ctx.push(addPage(ctx, { scrollTo: 'network' }), { detent: 'large' }) },
          h('span.ed-found-dot'), h('span', `${count(fresh.length, 'new device')} found`), icon('next', 16, 2.4)));
      }
      if (empty) {
        const room = doc.rooms[0];
        extra.push(h('div.ed-empty',
          h('b', 'Add your first lamp'),
          h('span', `${room.name || 'Your room'} is ready. Put in what you want to control:`),
          quickActions([
            { icon: 'ceiling', label: 'Ceiling light', onClick: () => ctx.addLight('ceiling', room) },
            { icon: 'table', label: 'Table lamp', onClick: () => ctx.addLight('table', room) },
            { icon: 'ac', label: 'Air conditioner', onClick: () => ctx.addAC(room) },
          ])));
      }
      const rooms = [...doc.rooms].sort((a, b) => M.area(b) - M.area(a));
      return {
        head: {
          title: doc.name || 'Home',
          subtitle,
          accessory: h('button.ed-add-btn', { type: 'button', 'aria-label': 'Add to the home', onclick: () => ctx.push(addPage(ctx), { detent: 'large' }) }, icon('plus', 18, 2.6), h('span', 'Add')),
        },
        extra: extra.length ? extra : null,
        body: [
          group('Rooms', rooms.map((r) => {
            const c = M.contentsOf(doc, r);
            const devices = c.lights.length + c.acs.length;
            return row({
              lead: floorChip(r.floor), title: r.name || r.id, key: `room-${r.id}`,
              subtitle: `${roomSize(r, units)} · ${devices ? count(devices, 'device') : 'no devices'}`,
              chevron: true, onClick: () => ctx.select({ kind: 'room', id: r.id }, { reveal: true }),
            });
          })),
          group('Scenes', [
            ...doc.scenes.map((s) => row({
              icon: s.icon || 'sun', tint: TINT.scene, title: s.name || s.id, key: `scene-${s.id}`,
              subtitle: sceneSummary(doc, s), chevron: true, onClick: () => ctx.push(scenePage(ctx, s.id)),
            })),
            row({ icon: 'plus', tint: 'rgba(255,255,255,.14)', title: 'New scene', key: 'new-scene', cls: 'accent', onClick: () => ctx.addScene() }),
          ]),
          group(null, [
            row({ icon: 'link', tint: ACCENT, title: 'Connections', value: ctx.links.summary(), chevron: true, key: 'connections', onClick: () => ctx.push(ctx.links.overviewPage(ctx)) }),
            row({ icon: 'settings', tint: TINT.settings, title: 'Home settings', chevron: true, key: 'settings', onClick: () => ctx.push(settingsPage(ctx)) }),
          ], ctx.touch ? 'Drag rooms to move them. Touch and hold anything to pick it up. Pinch to zoom.'
            : 'Drag rooms and things to move them; drag a room’s edges to resize it. Scroll or pinch to zoom.'),
        ],
      };
    },
  };
}

function sceneSummary(doc, s) {
  const all = s.lights?.['*'];
  const rules = Object.keys(s.lights || {}).filter((k) => k !== '*').length;
  const parts = [];
  if (all?.on === true) parts.push(all.brightness != null ? `Lights on at ${Math.round(all.brightness * 100)}%` : 'Lights on');
  else if (all?.on === false) parts.push('Lights off');
  if (rules) parts.push(count(rules, 'light rule'));
  const ac = s.acs?.['*'];
  if (ac?.on === true) parts.push('ACs on'); else if (ac?.on === false) parts.push('ACs off');
  return parts.join(' · ') || 'Leaves everything as it is';
}

/* ---------- Add ---------- */

// filter: 'light' | 'ac' | 'door' | 'window' | 'furniture' | 'room' (from a room's chips)
export function addPage(ctx, { filter = null, scrollTo = null, room = null } = {}) {
  let target = room ? room.id : ctx.targetRoom()?.id;
  const want = (k) => !filter || filter === k || (filter === 'opening' && (k === 'door' || k === 'window'));
  const page = {
    key: `add${filter ? `:${filter}` : ''}`,
    short: 'Add',
    detent: 'large',
    render() {
      const doc = ctx.doc;
      const units = ctx.units;
      const into = M.roomById(doc, target) || ctx.targetRoom() || doc.rooms[0];
      target = into?.id;
      const fresh = ctx.links.unlinked(doc).filter((d) => !filter || (filter === 'light' && d.kind === 'light') || (filter === 'ac' && d.kind === 'ac'));
      const body = [];
      if ((fresh.length || isHub) && (!filter || filter === 'light' || filter === 'ac')) {
        const state = ctx.links.state;
        body.push(h('div', { 'data-anchor': 'network' }, group('On your network', [
          ...fresh.map((d) => row({
            lead: h(`span.ed-dot${d.online ? '.on' : ''}`), title: d.name, key: `net-${d.service}-${d.id}`,
            subtitle: [SERVICES[d.service]?.short || d.service, d.room, !d.online && 'offline'].filter(Boolean).join(' · '),
            accessory: button({ label: 'Add', style: 'tinted', small: true, onClick: (ev) => { ev.stopPropagation(); ctx.addDevice(d, into); } }),
          })),
          !fresh.length && state.devices && !state.loading ? row({ icon: 'ok', tint: TINT.network, title: 'Everything found is on the plan' }) : null,
          isHub ? row({
            icon: 'radar', tint: TINT.network, key: 'rescan',
            lead: state.rescanning || state.loading ? h('span.ed-tile.spin', { vars: { '--tint': TINT.network, '--size': '28px' } }, icon('spinner', 16, 2.4)) : null,
            title: state.rescanning ? 'Looking for new devices…' : 'Look for new devices',
            onClick: state.rescanning ? null : () => ctx.links.rescan(),
          }) : null,
        ])));
      }
      if (want('room')) {
        body.push(group('Rooms', [chipGrid({
          key: 'rooms', columns: 3,
          items: [...M.ROOM_PRESETS.map((p) => ({ value: p.name, label: p.name, icon: p.icon, sub: M.fmtSize(p.size[0], p.size[1], units) })),
            { value: '__draw', label: 'Draw a room', icon: 'draw', sub: 'Any size' }],
          onPick: (v) => {
            if (v === '__draw') ctx.startDrawing();
            else ctx.addRoom(M.ROOM_PRESETS.find((p) => p.name === v));
          },
        })]));
      }
      if (want('light')) {
        body.push(group('Lights', [chipGrid({
          key: 'lights', columns: 3,
          items: M.LIGHT_TYPES.map((t) => ({ value: t.type, label: t.name, icon: t.type === 'strip' ? 'strip' : t.type })),
          onPick: (v) => ctx.addLight(v, into),
        })]));
      }
      if (want('ac')) {
        body.push(group('Climate', [chipGrid({
          key: 'climate', columns: 3,
          items: [{ value: 'ac', label: 'Air conditioner', icon: 'ac', sub: M.unitsOf(doc) === 'imperial' ? '°F' : '°C' }],
          onPick: () => ctx.addAC(into),
        })]));
      }
      if (want('door') || want('window')) {
        body.push(group('Doors & windows', [chipGrid({
          key: 'openings', columns: 3,
          items: M.OPENING_TYPES.filter((t) => !filter || filter === 'opening' || filter === t.type || (filter === 'door' && t.type === 'open'))
            .map((t) => ({ value: t.type, label: t.name, icon: t.icon, sub: M.fmtLen(t.width, units) })),
          onPick: (v) => ctx.addOpening(v, into),
        })]));
      }
      if (want('furniture')) {
        M.FURNITURE_GROUPS.forEach((g, i) => body.push(group(i ? g.name : `Furniture · ${g.name}`, [chipGrid({
          key: i ? `furniture-${i}` : 'furniture', columns: 4, size: 'small',
          items: g.types.filter((t) => M.FURNITURE_ORDER.includes(t)).map((t) => furnitureChip(t, 40)),
          onPick: (v) => ctx.addFurniture(v, into),
        })])));
      }
      const chip = into ? h('button.ed-target', { type: 'button', onclick: () => ctx.push(roomPickerPage(ctx, {
        title: 'Add to', current: () => target, onPick: (id) => { target = id; ctx.pop(); },
      })) }, h('span', 'Adding to '), h('b', into.name || into.id), icon('next', 15, 2.4)) : null;
      return {
        head: { tile: tile('plus', ACCENT, 40), title: filter ? addTitle(filter) : 'Add', subtitle: 'Tap to put it on the plan' },
        extra: filter === 'room' ? null : chip,
        body,
      };
    },
  };
  if (scrollTo) {
    page.afterRender = (el) => {
      const anchor = el.querySelector(`[data-anchor="${scrollTo}"]`);
      const sc = el.querySelector('.ed-page-scroll');
      if (anchor && sc) sc.scrollTop = anchor.offsetTop - 8;
    };
  }
  return page;
}

const addTitle = (f) => ({ light: 'Add a light', ac: 'Add an AC', door: 'Add a door', window: 'Add a window', furniture: 'Add furniture', room: 'Add a room', opening: 'Add a door or window' }[f] || 'Add');

/* ---------- pickers ---------- */

export function roomPickerPage(ctx, { title = 'Room', current, onPick }) {
  return {
    key: 'room-picker',
    short: title,
    render() {
      const doc = ctx.doc;
      return {
        head: { tile: tile('home', TINT.room, 40), title, subtitle: 'Choose a room' },
        body: [group(null, doc.rooms.map((r) => row({
          lead: floorChip(r.floor), title: r.name || r.id, subtitle: roomSize(r, ctx.units),
          check: current() === r.id, key: `pick-${r.id}`, onClick: () => onPick(r.id),
        })))],
      };
    },
  };
}

/* ---------- Room ---------- */

export function roomPage(ctx, id) {
  const sel = { kind: 'room', id };
  const cut = { corner: 2, length: 0.6 };
  return {
    key: `item:room:${id}`,
    short: 'Room',
    kind: 'item',
    render() {
      const doc = ctx.doc;
      const units = ctx.units;
      const r = M.roomById(doc, id);
      if (!r) return gone();
      const c = M.contentsOf(doc, r);
      const step = M.lengthStep(units);
      const last = doc.rooms.length === 1;
      // Cut corner: which corner and how far along its walls, kept while the page is open.
      const names = M.cornerNames(r);
      cut.corner = Math.min(cut.corner, names.length - 1);
      const most = M.maxCut(r, cut.corner);
      ctx.markCorner?.(M.roomPoints(r)[cut.corner]);
      const cutGroup = () => group('Cut corner', [
        names.length <= 6 ? h('div.ed-row.ed-seg-full', segmented({
          key: `cut-at-${id}`, value: String(cut.corner), label: 'Corner',
          options: names.map((n, i) => ({ value: String(i), label: n })),
          onChange: (v) => { cut.corner = Number(v); ctx.refresh(); },
        })) : stepperRow({ title: 'Corner', key: `cut-at-${id}`, value: cut.corner + 1, format: (v) => String(v), min: 1, max: names.length, step: 1, onChange: (v) => { cut.corner = v - 1; ctx.refresh(); } }),
        stepperRow({ title: 'Cut', key: `cut-len-${id}`, value: Math.min(cut.length, Math.max(0.1, most)), format: (v) => M.fmtLen(v, units), min: 0.1, max: Math.max(0.1, most), step: (v, dir) => M.stepLength(v, dir, step), onChange: (v) => { cut.length = v; ctx.refresh(); } }),
        row({ icon: 'cut', tint: TINT.room, title: 'Cut corner', key: `cut-${id}`, disabled: most < 0.1,
          onClick: () => { if (!ctx.change((d) => M.cutCorner(M.roomById(d, id), cut.corner, cut.length))) ctx.toast('That corner is too short to cut'); } }),
      ], 'Turns the corner into a wall at an angle, like a bathroom with a door across its corner.');
      const inRoom = [
        ...c.lights.map((l) => row({ lead: tile(l.type === 'strip' ? 'strip' : l.type, TINT.light), title: l.name || l.id, subtitle: `${M.lightTypeName(l.type)} · ${linkName(l)}`, chevron: true, key: `in-${l.id}`, onClick: () => ctx.select({ kind: 'light', id: l.id }, { reveal: true }) })),
        ...c.acs.map((a) => row({ lead: tile('ac', TINT.ac), title: a.name || a.id, subtitle: `${a.wall} wall · ${linkName(a)}`, chevron: true, key: `in-${a.id}`, onClick: () => ctx.select({ kind: 'ac', id: a.id }, { reveal: true }) })),
        ...c.openings.map((o) => {
          const i = doc.openings.indexOf(o);
          return row({ lead: tile(M.OPENING_TYPES.find((t) => t.type === (o.type || 'door'))?.icon || 'door', TINT.opening), title: M.openingName(o.type), subtitle: `${M.fmtLen(M.openingSpan(o).w, units)} · ${M.openingRooms(doc, o).join(' / ')}`, chevron: true, key: `in-o${i}`, onClick: () => ctx.select({ kind: 'opening', index: i }, { reveal: true }) });
        }),
        ...c.furniture.map((f) => {
          const i = doc.furniture.indexOf(f);
          return row({ lead: glyphTile(f, 28), title: M.furnitureName(f.type), chevron: true, key: `in-f${i}`, onClick: () => ctx.select({ kind: 'furniture', index: i }, { reveal: true }) });
        }),
      ];
      return {
        head: { tile: floorChip(r.floor, 40), title: r.name || r.id, subtitle: M.isPoly(r) ? `${M.fmtArea(M.area(r), units)} · ${count(r.poly.length, 'corner')}` : `${M.fmtSize(r.rect[2], r.rect[3], units)} · ${M.fmtArea(M.area(r), units)}` },
        actions: quickActions([
          { icon: 'bulb', label: 'Add light', onClick: () => ctx.push(addPage(ctx, { filter: 'light', room: r })) },
          { icon: 'door', label: 'Add door', onClick: () => ctx.addOpening('door', r) },
          { icon: 'copy', label: 'Duplicate', onClick: () => ctx.duplicate(sel) },
          { icon: 'trash', label: 'Delete', destructive: true, disabled: last, onClick: () => ctx.remove(sel) },
        ]),
        body: [
          group('Name', [textRow({ value: r.name, placeholder: 'Room name', key: `name-room-${id}`, onInput: (v) => ctx.change((d) => { M.roomById(d, id).name = v; }, { key: `name-room-${id}`, light: true }) })]),
          group('Floor', [h('div.ed-row.ed-floor-row', M.FLOORS.map((f) => h(`button.ed-floor-opt${(r.floor || 'oak') === f.id ? '.on' : ''}`, {
            type: 'button', 'aria-pressed': String((r.floor || 'oak') === f.id),
            onclick: () => ctx.change((d) => { M.roomById(d, id).floor = f.id; }),
          }, floorChip(f.id, 30), h('span', f.name))))]),
          M.isPoly(r) ? group('Size', [
            row({ title: 'Area', value: M.fmtArea(M.area(r), units), key: `area-${id}` }),
            row({ title: 'Corners', value: String(r.poly.length), key: `corners-${id}` }),
          ], 'Drag its corners on the plan to reshape it. They snap to the grid, to other rooms and to 45°.')
            : group('Size', [
              stepperRow({ title: 'Width', value: r.rect[2], format: (v) => M.fmtLen(v, units), step: (v, dir) => M.stepLength(v, dir, step), min: 0.8, max: 40, key: `w-${id}`, onChange: (v) => ctx.change((d) => resizeRoom(d, id, v, null), { key: `w-${id}` }) }),
              stepperRow({ title: 'Depth', value: r.rect[3], format: (v) => M.fmtLen(v, units), step: (v, dir) => M.stepLength(v, dir, step), min: 0.8, max: 40, key: `d-${id}`, onChange: (v) => ctx.change((d) => resizeRoom(d, id, null, v), { key: `d-${id}` }) }),
            ], 'Drag the room’s edges on the plan to resize it from any side.'),
          cutGroup(),
          inRoom.length ? group('In this room', inRoom) : null,
          group('Add to this room', [chipGrid({
            key: 'add-to', columns: 5, size: 'mini',
            items: [
              { value: 'light', label: 'Light', icon: 'bulb' }, { value: 'ac', label: 'AC', icon: 'ac' },
              { value: 'door', label: 'Door', icon: 'door' }, { value: 'window', label: 'Window', icon: 'window' },
              { value: 'furniture', label: 'Furniture', icon: 'furniture' },
            ],
            onPick: (v) => (v === 'ac' ? ctx.addAC(r) : v === 'door' || v === 'window' ? ctx.addOpening(v, r) : ctx.push(addPage(ctx, { filter: v, room: r }))),
          })]),
          group(null, [row({ icon: 'trash', tint: TINT.danger, title: 'Delete room', destructive: true, disabled: last, onClick: () => ctx.remove(sel), key: 'delete' })],
            last ? 'A home needs at least one room.' : null),
        ],
      };
    },
  };
}

// Width or depth from the steppers: the room grows to the east / south, its ACs and the
// doors on those walls go with the wall.
function resizeRoom(doc, id, w, d) {
  const r = M.roomById(doc, id);
  const [x, z, w0, d0] = r.rect;
  const acs = doc.acs.filter((a) => a.room === id && a.pos);
  const along = new Map(acs.map((a) => [a, M.alongWall(a.wall, a.pos)]));
  const east = x + w0;
  const south = z + d0;
  const onLine = (o, axis, c) => { const s = M.openingSpan(o); return s.axis === axis && Math.abs(s.c - c) < M.EPS; };
  const moveE = w != null ? doc.openings.filter((o) => o.from && onLine(o, 'z', east) && M.contains(r, o.from) && M.contains(r, o.to)) : [];
  const moveS = d != null ? doc.openings.filter((o) => o.from && onLine(o, 'x', south) && M.contains(r, o.from) && M.contains(r, o.to)) : [];
  r.rect = [x, z, M.fix(w ?? w0), M.fix(d ?? d0)];
  for (const a of acs) a.pos = M.placeAC(r, a.wall, along.get(a));
  for (const o of moveE) M.setOpeningSpan(o, { ...M.openingSpan(o), c: x + r.rect[2] });
  for (const o of moveS) M.setOpeningSpan(o, { ...M.openingSpan(o), c: z + r.rect[3] });
}

function gone() {
  return { head: { title: 'Not on the plan any more' }, body: [note('It was deleted or replaced by a change from another screen.', { icon: 'info' })] };
}

/* ---------- Light ---------- */

export function lightPage(ctx, id) {
  const sel = { kind: 'light', id };
  return {
    key: `item:light:${id}`,
    short: 'Light',
    kind: 'item',
    render() {
      const doc = ctx.doc;
      const units = ctx.units;
      const l = doc.lights.find((x) => x.id === id);
      if (!l) return gone();
      const caps = l.capabilities || [];
      const linked = isLinked(l);
      const H = doc.wallHeight ?? 2.6;
      const live = ctx.store?.lightCfg?.has(id) ? ctx.store.state.lights[id] : null;
      const set = (fn, key) => ctx.change((d) => fn(d.lights.find((x) => x.id === id), d), key ? { key } : undefined);
      const cap = (name) => toggleRow({
        title: { brightness: 'Dimming', temp: 'White temperature', color: 'Colour' }[name], key: `cap-${name}`,
        icon: { brightness: 'dim', temp: 'thermo', color: 'palette' }[name], tint: 'rgba(255,179,64,.75)',
        value: caps.includes(name),
        onChange: (on) => set((it) => { it.capabilities = (it.capabilities || []).filter((c) => c !== name); if (on) it.capabilities.push(name); }),
      });
      const standsIn = M.roomAt(doc, l.pos);
      const hint = standsIn && standsIn.id !== l.room && M.roomById(doc, l.room) && M.area(standsIn) < M.area(M.roomById(doc, l.room));
      const defY = DEFAULT_Y(l.type, H);
      return {
        head: { tile: lightTile(ctx, l), title: l.name || l.id, subtitle: [M.roomName(doc, l.room), M.lightTypeName(l.type), linkName(l)].filter(Boolean).join(' · ') },
        actions: quickActions([
          live ? { icon: 'power', label: live.on ? 'Turn off' : 'Turn on', on: live.on, glow: ctx.live(id)?.color, haptic: 'medium', onClick: () => { ctx.store.toggleLight(id); } } : null,
          { icon: 'copy', label: 'Duplicate', onClick: () => ctx.duplicate(sel) },
          { icon: 'trash', label: 'Delete', destructive: true, onClick: () => ctx.remove(sel) },
        ]),
        body: [
          hint ? h('div.ed-hint', icon('info', 16, 2.2), h('span', `It stands in ${standsIn.name}. Move it there?`),
            button({ label: 'Move', style: 'tinted', small: true, onClick: () => set((it) => { it.room = standsIn.id; }) })) : null,
          group('Name', [textRow({ value: l.name, placeholder: 'Light name', key: `name-light-${id}`, onInput: (v) => ctx.change((d) => { d.lights.find((x) => x.id === id).name = v; }, { key: `name-light-${id}`, light: true }) })]),
          group('Type', [chipGrid({
            key: 'type', columns: 3, size: 'compact', value: l.type,
            items: M.LIGHT_TYPES.map((t) => ({ value: t.type, label: t.name, icon: t.type === 'strip' ? 'strip' : t.type })),
            onPick: (v) => set((it) => {
              it.type = v;
              if (v === 'strip') { it.length ??= 1; it.rot ??= 0; }
            }),
          })]),
          group(null, [
            row({ icon: 'home', tint: TINT.room, title: 'Room', value: M.roomName(doc, l.room) || '—', chevron: true, key: 'room', onClick: () => ctx.push(roomPickerPage(ctx, {
              current: () => ctx.doc.lights.find((x) => x.id === id)?.room,
              onPick: (rid) => { ctx.change((d) => moveToRoom(d, d.lights.find((x) => x.id === id), rid)); ctx.pop(); },
            })) }),
            row({ icon: 'link', tint: ACCENT, title: 'Real device', value: ctx.links.deviceLabel(l, 'light'), chevron: true, key: 'device', onClick: () => ctx.push(ctx.links.pickerPage(ctx, sel, 'light')) }),
          ]),
          group('What it can do', [cap('brightness'), cap('temp'), cap('color')],
            linked ? 'Matched from the device. Change it only if the device does more (or less) than it says.' : 'Leave all three off for a lamp on a plain smart plug: it is then a simple switch.'),
          group('Placement', [
            l.type === 'floor' ? null : stepperRow({
              title: 'Height', key: 'y', value: l.y ?? null, format: (v) => M.fmtLen(v, units), min: 0.1, max: H,
              step: (v, dir) => M.stepLength(v, dir, M.heightStep(units)),
              auto: { label: `Auto · ${M.fmtLen(defY, units)}`, from: defY },
              onChange: (v) => set((it) => { it.y = v; }, `y-${id}`),
            }),
            l.type !== 'floor' && l.y != null ? row({ title: 'Back to the automatic height', icon: 'rotate', tint: 'rgba(255,255,255,.14)', key: 'auto-y', onClick: () => set((it) => { delete it.y; }) }) : null,
            l.type === 'strip' ? stepperRow({ title: 'Length', key: 'len', value: l.length || 1, format: (v) => M.fmtLen(v, units), min: 0.3, max: 12, step: (v, dir) => M.stepLength(v, dir, M.lengthStep(units)), onChange: (v) => set((it) => { it.length = v; }, `len-${id}`) }) : null,
            l.type === 'strip' ? stepperRow({ title: 'Rotation', key: 'rot', value: wrapDeg(l.rot || 0), format: deg, step: (v, dir) => wrapDeg(v + dir * 15), onChange: (v) => set((it) => { it.rot = v; }, `rot-${id}`) }) : null,
          ], l.type === 'strip' ? 'On the plan, drag the strip’s ends to change its length and the round knob to turn it.' : null),
          group(null, [row({ icon: 'trash', tint: TINT.danger, title: 'Delete light', destructive: true, key: 'delete', onClick: () => ctx.remove(sel) })]),
        ],
      };
    },
  };
}

// Assigning a lamp or an AC to another room puts it in that room.
function moveToRoom(doc, item, roomId) {
  const room = M.roomById(doc, roomId);
  if (!room || !item) return;
  item.room = roomId;
  if (doc.acs.includes(item)) {
    item.pos = M.placeAC(room, item.wall, M.wallMiddle(room, item.wall));
  } else if (M.roomAt(doc, item.pos) !== room) {
    item.pos = M.freeSpot(doc, room, M.centerOf('room', room));
  }
}

/* ---------- AC ---------- */

export function acPage(ctx, id) {
  const sel = { kind: 'ac', id };
  return {
    key: `item:ac:${id}`,
    short: 'AC',
    kind: 'item',
    render() {
      const doc = ctx.doc;
      const units = ctx.units;
      const a = doc.acs.find((x) => x.id === id);
      if (!a) return gone();
      const f = a.unit === 'F';
      const set = (fn, key) => ctx.change((d) => fn(d.acs.find((x) => x.id === id), d), key ? { key } : undefined);
      const lo = a.min ?? (f ? 61 : 16);
      const hi = a.max ?? (f ? 86 : 30);
      return {
        head: { tile: tile('ac', TINT.ac, 40), title: a.name || a.id, subtitle: [M.roomName(doc, a.room), `${a.wall} wall`, linkName(a)].filter(Boolean).join(' · ') },
        actions: quickActions([
          { icon: 'copy', label: 'Duplicate', onClick: () => ctx.duplicate(sel) },
          { icon: 'trash', label: 'Delete', destructive: true, onClick: () => ctx.remove(sel) },
        ]),
        body: [
          group('Name', [textRow({ value: a.name, placeholder: 'AC name', key: `name-ac-${id}`, onInput: (v) => ctx.change((d) => { d.acs.find((x) => x.id === id).name = v; }, { key: `name-ac-${id}`, light: true }) })]),
          group(null, [
            row({ icon: 'home', tint: TINT.room, title: 'Room', value: M.roomName(doc, a.room) || '—', chevron: true, key: 'room', onClick: () => ctx.push(roomPickerPage(ctx, {
              current: () => ctx.doc.acs.find((x) => x.id === id)?.room,
              onPick: (rid) => { ctx.change((d) => moveToRoom(d, d.acs.find((x) => x.id === id), rid)); ctx.pop(); },
            })) }),
            segmentedRow({ title: 'Wall', key: 'wall', value: a.wall, small: true,
              options: M.WALLS.map((w) => ({ value: w, label: M.WALL_SHORT[w], aria: `${w} wall` })),
              onChange: (w) => set((it, d) => { const r = M.roomById(d, it.room); it.wall = w; if (r) it.pos = M.placeAC(r, w, M.wallMiddle(r, w)); }) }),
            row({ icon: 'link', tint: ACCENT, title: 'Real device', value: ctx.links.deviceLabel(a, 'ac'), chevron: true, key: 'device', onClick: () => ctx.push(ctx.links.pickerPage(ctx, sel, 'ac')) }),
            row({ icon: 'thermo', tint: '#ff9f0a', title: 'Room temperature', value: ctx.links.deviceLabel(a, 'sensor'), chevron: true, key: 'sensor', onClick: () => ctx.push(ctx.links.pickerPage(ctx, sel, 'sensor')) }),
          ], 'On the plan, drag the AC along the walls: it snaps to the nearest one.'),
          group('Temperature', [
            segmentedRow({ title: 'Units', key: 'unit', value: f ? 'F' : 'C', small: true, options: [{ value: 'F', label: '°F' }, { value: 'C', label: '°C' }],
              onChange: (u) => set((it) => {
                const toF = u === 'F';
                const conv = (v) => Math.round(toF ? M.cToF(v) : M.fToC(v));
                it.min = conv(it.min ?? (toF ? 16 : 61));
                it.max = conv(it.max ?? (toF ? 30 : 86));
                it.unit = u;
              }) }),
            stepperRow({ title: 'Lowest', key: 'min', value: lo, format: (v) => `${v}°${f ? 'F' : 'C'}`, step: 1, min: f ? 50 : 10, max: hi - 2, onChange: (v) => set((it) => { it.min = v; }, `min-${id}`) }),
            stepperRow({ title: 'Highest', key: 'max', value: hi, format: (v) => `${v}°${f ? 'F' : 'C'}`, step: 1, min: lo + 2, max: f ? 95 : 35, onChange: (v) => set((it) => { it.max = v; }, `max-${id}`) }),
          ]),
          group('Placement', [stepperRow({ title: 'Mount height', key: 'y', value: a.y ?? 2.2, format: (v) => M.fmtLen(v, units), min: 1.2, max: (doc.wallHeight ?? 2.6) - 0.1, step: (v, dir) => M.stepLength(v, dir, M.heightStep(units)), onChange: (v) => set((it) => { it.y = v; }, `ay-${id}`) })]),
          group(null, [row({ icon: 'trash', tint: TINT.danger, title: 'Delete air conditioner', destructive: true, key: 'delete', onClick: () => ctx.remove(sel) })]),
        ],
      };
    },
  };
}

/* ---------- Furniture ---------- */

export function furniturePage(ctx, index) {
  const sel = { kind: 'furniture', index };
  return {
    key: `item:furniture:${index}`,
    short: 'Furniture',
    kind: 'item',
    render() {
      const doc = ctx.doc;
      const units = ctx.units;
      const f = doc.furniture[index];
      if (!f) return gone();
      const room = Array.isArray(f.pos) ? M.roomAt(doc, f.pos) : null;
      const set = (fn, key) => ctx.change((d) => fn(d.furniture[index], d), key ? { key } : undefined);
      const rotate = (by) => set((it) => { it.rot = wrapDeg((it.rot || 0) + by); });
      const step = M.lengthStep(units);
      const [fw] = footprint(f);
      return {
        head: { tile: glyphTile(f), title: M.furnitureName(f.type), subtitle: room ? room.name || room.id : 'Outside the home' },
        actions: quickActions([
          { icon: 'rotate90', label: 'Rotate 90°', onClick: () => rotate(-90) },
          { icon: 'copy', label: 'Duplicate', onClick: () => ctx.duplicate(sel) },
          { icon: 'trash', label: 'Delete', destructive: true, onClick: () => ctx.remove(sel) },
        ]),
        body: [
          group('Type', [chipGrid({
            key: 'ftype', columns: 4, size: 'small', value: f.type,
            items: M.FURNITURE_ORDER.map((t) => furnitureChip(t, 36)),
            onPick: (t) => set((it) => changeType(it, t)),
          })]),
          group('Size', [
            M.RESIZABLE.has(f.type) ? stepperRow({ title: 'Width', key: 'fw', value: f.width ?? M.DEFAULT_WIDTH[f.type] ?? fw, format: (v) => M.fmtLen(v, units), min: 0.3, max: 8, step: (v, dir) => M.stepLength(v, dir, step), onChange: (v) => set((it) => { it.width = v; }, `fw-${index}`) }) : null,
            M.SIZED.has(f.type) ? stepperRow({ title: 'Width', key: 'rw', value: (f.size || M.DEFAULT_SIZE[f.type])[0], format: (v) => M.fmtLen(v, units), min: 0.4, max: 8, step: (v, dir) => M.stepLength(v, dir, step), onChange: (v) => set((it) => { it.size = [v, (it.size || M.DEFAULT_SIZE[it.type])[1]]; }, `rw-${index}`) }) : null,
            M.SIZED.has(f.type) ? stepperRow({ title: 'Depth', key: 'rd', value: (f.size || M.DEFAULT_SIZE[f.type])[1], format: (v) => M.fmtLen(v, units), min: 0.4, max: 8, step: (v, dir) => M.stepLength(v, dir, step), onChange: (v) => set((it) => { it.size = [(it.size || M.DEFAULT_SIZE[it.type])[0], v]; }, `rd-${index}`) }) : null,
            f.type === 'counter' ? stepperRow({ title: 'Depth', key: 'cd', value: f.depth ?? 0.62, format: (v) => M.fmtLen(v, units), min: 0.3, max: 1.2, step: (v, dir) => M.stepLength(v, dir, step), onChange: (v) => set((it) => { it.depth = v; }, `cd-${index}`) }) : null,
            f.type === 'waterHeater' ? stepperRow({ title: 'Diameter', key: 'dia', value: f.diameter ?? 0.55, format: (v) => M.fmtLen(v, units), min: 0.3, max: 1, step: (v, dir) => M.stepLength(v, dir, M.heightStep(units)), onChange: (v) => set((it) => { it.diameter = v; }, `dia-${index}`) }) : null,
            HEIGHTS[f.type] ? stepperRow({ title: 'Height', key: 'fh', value: f.height ?? HEIGHTS[f.type], format: (v) => M.fmtLen(v, units), min: 0.5, max: 2.6, step: (v, dir) => M.stepLength(v, dir, M.heightStep(units)), onChange: (v) => set((it) => { it.height = v; }, `fh-${index}`) }) : null,
            f.type === 'tvCabinet' ? stepperRow({ title: 'TV size', key: 'tvw', value: f.tv ?? (f.width ?? 0.95) - 0.05, format: (v) => M.fmtLen(v, units), min: 0.4, max: 2.4, step: (v, dir) => M.stepLength(v, dir, step), onChange: (v) => set((it) => { it.tv = v; }, `tvw-${index}`) }) : null,
            f.type === 'storageBins' ? stepperRow({ title: 'Stacked', key: 'stack', value: f.stack ?? 2, format: (v) => String(v), min: 1, max: 6, step: 1, onChange: (v) => set((it) => { it.stack = v; }, `stack-${index}`) }) : null,
            LIFTED[f.type] ? stepperRow({ title: f.type === 'closetRod' ? 'Rod height' : 'Above the floor', key: 'fy', value: f.y ?? LIFTED[f.type], format: (v) => M.fmtLen(v, units), min: 0, max: (doc.wallHeight ?? 2.6) - 0.3, step: (v, dir) => M.stepLength(v, dir, M.heightStep(units)), onChange: (v) => set((it) => { it.y = v; }, `fy-${index}`) }) : null,
            f.type === 'closetRod' ? toggleRow({ title: 'Clothes', key: 'clothes', value: f.clothes !== false, onChange: (on) => set((it) => { if (on) delete it.clothes; else it.clothes = false; }) }) : null,
            f.type === 'diningSet' ? stepperRow({ title: 'Chairs', key: 'chairs', value: f.chairs ?? 6, format: (v) => String(v), min: 2, max: 8, step: 1, onChange: (v) => set((it) => { it.chairs = v; }, `ch-${index}`) }) : null,
            f.type === 'island' ? stepperRow({ title: 'Stools', key: 'stools', value: f.stools ?? 3, format: (v) => String(v), min: 0, max: 4, step: 1, onChange: (v) => set((it) => { it.stools = v; }, `st-${index}`) }) : null,
            f.type === 'kitchen' ? toggleRow({ title: 'Upper cabinets', key: 'upper', value: f.upper !== false, onChange: (on) => set((it) => { it.upper = on; }) }) : null,
          ]),
          f.type === 'counter' ? group('Sink', [
            h('div.ed-row.ed-seg-full', segmented({
              key: 'sink', value: f.sink || 'none', label: 'Sink',
              options: [{ value: 'none', label: 'None' }, { value: 'single', label: 'Single' }, { value: 'double', label: 'Double' }],
              onChange: (v) => set((it) => { it.sink = v; }),
            })),
            (f.sink || 'none') !== 'none' ? stepperRow({ title: 'From the middle', key: 'sinkat', value: f.sinkAt ?? 0, format: (v) => M.fmtLen(v, units), min: -4, max: 4, step: (v, dir) => M.stepLength(v, dir, step), onChange: (v) => set((it) => { it.sinkAt = v; }, `sinkat-${index}`) }) : null,
          ]) : null,
          f.type === 'counter' ? group('Countertop', [h('div.ed-row.ed-swatch-row', swatches({ key: 'top', colors: M.COUNTER_TOPS, value: f.top, onPick: (c) => set((it) => { if (c) it.top = c; else delete it.top; }) }))]) : null,
          group('Rotation', [
            h('div.ed-row.ed-stepper-row', h('span.ed-row-text', h('span.ed-row-title', 'Angle')),
              h('span.ed-rot-btns',
                h('button.ed-mini', { type: 'button', 'aria-label': 'Turn left 90°', onclick: () => rotate(90) }, icon('rotate', 16, 2.2)),
                h('button.ed-mini', { type: 'button', 'aria-label': 'Turn right 90°', onclick: () => rotate(-90) }, icon('rotate90', 16, 2.2))),
            ),
            stepperRow({ title: 'Fine', key: 'frot', value: wrapDeg(f.rot || 0), format: deg, step: (v, dir) => wrapDeg(v - dir * 15), onChange: (v) => set((it) => { it.rot = v; }, `frot-${index}`) }),
          ], 'Or drag the round knob in front of it on the plan.'),
          M.COLORABLE.has(f.type) ? group('Colour', [h('div.ed-row.ed-swatch-row', swatches({ key: 'colour', colors: M.FURNITURE_COLORS, value: f.color, onPick: (c) => set((it) => { if (c) it.color = c; else delete it.color; }) }))]) : null,
          group(null, [row({ icon: 'trash', tint: TINT.danger, title: `Delete ${M.furnitureName(f.type).toLowerCase()}`, destructive: true, key: 'delete', onClick: () => ctx.remove(sel) })]),
        ],
      };
    },
  };
}

// Pieces with a height of their own, and their default.
const HEIGHTS = { wardrobe: 2.1, bookshelf: 1.8, dresser: 0.84, waterHeater: 1.5 };
// Pieces that stand above the floor: the default `y`.
const LIFTED = { microwave: 0.9, closetRod: 1.75 };

// Another kind of piece in the same place, facing the same way.
function changeType(it, t) {
  const keep = { type: t, pos: it.pos, rot: it.rot || 0 };
  if (M.RESIZABLE.has(t) && M.RESIZABLE.has(it.type) && it.width) keep.width = it.width;
  if (M.COLORABLE.has(t) && it.color) keep.color = it.color;
  if (M.SIZED.has(t)) keep.size = M.SIZED.has(it.type) && it.size ? it.size : [...M.DEFAULT_SIZE[t]];
  if (t === 'counter') keep.sink = 'none';
  if (t === 'diningSet') keep.chairs = it.chairs ?? 4;
  if (t === 'island') keep.stools = it.stools ?? 3;
  if (t === 'kitchen' && 'upper' in it) keep.upper = it.upper;
  if (it.y != null && LIFTED[t] && LIFTED[it.type]) keep.y = it.y;
  for (const k of Object.keys(it)) delete it[k];
  Object.assign(it, keep);
}

/* ---------- Door / window / opening ---------- */

export function openingPage(ctx, index) {
  const sel = { kind: 'opening', index };
  return {
    key: `item:opening:${index}`,
    short: 'Opening',
    kind: 'item',
    render() {
      const doc = ctx.doc;
      const units = ctx.units;
      const o = doc.openings[index];
      if (!o?.from || !o?.to) return gone();
      const s = M.openingSpan(o);
      const type = o.type || 'door';
      const kind = M.OPENING_TYPES.find((t) => t.type === type) || M.OPENING_TYPES[0];
      const onWall = M.wallOf(doc, o);
      const set = (fn, key) => ctx.change((d) => fn(d.openings[index], d), key ? { key } : undefined);
      const H = doc.wallHeight ?? 2.6;
      return {
        head: { tile: tile(kind.icon, TINT.opening, 40), title: kind.name, subtitle: [M.fmtLen(s.w, units), M.openingRooms(doc, o).join(' / ')].filter(Boolean).join(' · ') },
        actions: quickActions([
          { icon: 'copy', label: 'Duplicate', onClick: () => ctx.duplicate(sel) },
          { icon: 'trash', label: 'Delete', destructive: true, onClick: () => ctx.remove(sel) },
        ]),
        body: [
          onWall ? null : h('div.ed-hint.warn', icon('warning', 16, 2.2), h('span', 'Not on a wall. The 3D view leaves it out.'),
            button({ label: 'Snap to nearest wall', style: 'tinted', small: true, onClick: () => set((it, d) => snapOpening(d, it)) })),
          group('Type', [h('div.ed-row.ed-seg-full', segmented({
            key: 'otype', value: type, label: 'Type',
            options: M.OPENING_TYPES.map((t) => ({ value: t.type, label: t.type === 'open' ? 'Open' : t.name })),
            onChange: (v) => set((it) => {
              it.type = v;
              if (v === 'window') { it.sill ??= 0.85; it.head ??= 2.1; }
              if (v !== 'door') { delete it.hinge; delete it.swing; }
              if (v !== 'open') delete it.curtain;
            }),
          }))]),
          type === 'door' ? group('Door', [
            segmentedRow({
              title: 'Hinge', key: 'hinge', value: M.hingeSide(doc, o), small: true,
              options: [{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }],
              onChange: (v) => set((it, d) => M.setHingeSide(d, it, v)),
            }),
            segmentedRow({
              title: 'Opens into', key: 'swing', value: M.swingOf(doc, o), small: true,
              options: M.swingChoices(doc, o),
              onChange: (v) => set((it) => { it.swing = v; }),
            }),
          ], 'Left or right as seen from the room it opens into.') : null,
          type === 'open' ? group('Passage', [toggleRow({ title: 'Curtain', key: 'curtain', value: Boolean(o.curtain), onChange: (on) => set((it) => { if (on) it.curtain = true; else delete it.curtain; }) })],
            'A shower or closet curtain on a rod, gathered at one end.') : null,
          group('Size', [
            stepperRow({ title: 'Width', key: 'ow', value: s.w, format: (v) => M.fmtLen(v, units), min: 0.4, max: onWall ? onWall.b - onWall.a : 6, step: (v, dir) => M.stepLength(v, dir, M.lengthStep(units)),
              onChange: (v) => set((it, d) => {
                const cur = M.openingSpan(it);
                const line = M.wallOf(d, it) || { ...cur, a: -Infinity, b: Infinity };
                M.setOpeningSpan(it, M.placeOnWall(line, (cur.a + cur.b) / 2, v));
              }, `ow-${index}`) }),
            type === 'window' ? stepperRow({ title: 'Sill', key: 'sill', value: o.sill ?? 0.85, format: (v) => M.fmtLen(v, units), min: 0, max: (o.head ?? 2.1) - 0.3, step: (v, dir) => M.stepLength(v, dir, M.heightStep(units)), onChange: (v) => set((it) => { it.sill = v; }, `sill-${index}`) }) : null,
            type === 'window' ? stepperRow({ title: 'Top', key: 'head', value: o.head ?? 2.1, format: (v) => M.fmtLen(v, units), min: (o.sill ?? 0.85) + 0.3, max: H, step: (v, dir) => M.stepLength(v, dir, M.heightStep(units)), onChange: (v) => set((it) => { it.head = v; }, `head-${index}`) }) : null,
          ], 'On the plan, drag it along its wall, or onto another wall; drag its ends to widen it.'),
          group(null, [row({ icon: 'trash', tint: TINT.danger, title: `Delete ${kind.name.toLowerCase()}`, destructive: true, key: 'delete', onClick: () => ctx.remove(sel) })]),
        ],
      };
    },
  };
}

export function snapOpening(doc, o) {
  const s = M.openingSpan(o);
  const c = M.centerOf('opening', o);
  const near = M.nearestWall(doc, c, { dir: s.dir }) || M.nearestWall(doc, c);
  if (!near) return;
  M.setOpeningSpan(o, M.placeOnWall(near.line, M.snap(near.t), s.w));
}

/* ---------- Scene ---------- */

export function scenePage(ctx, id) {
  const sel = { kind: 'scene', id };
  return {
    key: `scene:${id}`,
    short: 'Scene',
    close: false,
    render() {
      const doc = ctx.doc;
      const s = doc.scenes.find((x) => x.id === id);
      if (!s) return gone();
      const set = (fn, key) => ctx.change((d) => fn(d.scenes.find((x) => x.id === id), d), key ? { key } : undefined);
      const tri = (rule) => (rule?.on === true ? 'on' : rule?.on === false ? 'off' : 'leave');
      const OPTS = [{ value: 'leave', label: 'Leave' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }];
      const setRule = (map, key, v) => set((sc) => {
        sc[map] ||= {};
        if (v === 'leave') delete sc[map][key];
        else sc[map][key] = { ...(sc[map][key] || {}), on: v === 'on' };
      });
      const detail = (rule) => {
        if (!rule || rule.on !== true) return null;
        const parts = [];
        if (rule.brightness != null) parts.push(`${Math.round(rule.brightness * 100)}%`);
        if (rule.color) parts.push(rule.color.toUpperCase());
        else if (rule.temp) parts.push(`${rule.temp} K`);
        return parts.join(' · ') || null;
      };
      const canCapture = ctx.mode === 'overlay' && ctx.store;
      return {
        head: { tile: tile(s.icon || 'sun', TINT.scene, 40), title: s.name || s.id, subtitle: sceneSummary(doc, s) },
        body: [
          group('Name', [textRow({ value: s.name, placeholder: 'Scene name', key: `name-scene-${id}`, onInput: (v) => ctx.change((d) => { d.scenes.find((x) => x.id === id).name = v; }, { key: `name-scene-${id}`, light: true }) })]),
          group('Icon', [chipGrid({ key: 'sicon', columns: 5, size: 'mini', value: s.icon || 'sun', items: M.SCENE_ICONS.map((n) => ({ value: n, label: '', aria: n, icon: n })), onPick: (v) => set((sc) => { sc.icon = v; }) })]),
          canCapture ? group(null, [row({ icon: 'wand', tint: TINT.scene, title: 'Use the lights as they are now', subtitle: 'Copies what every light is doing into this scene', key: 'capture', onClick: () => capture(ctx, id) })]) : null,
          group('Lights', [
            segmentedRow({ title: 'All lights', key: 'all', value: tri(s.lights?.['*']), small: true, options: OPTS, onChange: (v) => setRule('lights', '*', v) }),
            ...doc.lights.map((l) => segmentedRow({
              title: l.name || l.id, subtitle: detail(s.lights?.[l.id]) || M.roomName(doc, l.room), key: `l-${l.id}`, small: true,
              value: tri(s.lights?.[l.id]), options: OPTS, onChange: (v) => setRule('lights', l.id, v),
            })),
          ], 'A light’s own rule wins over “All lights”. Brightness and colour stay as they were captured.'),
          doc.acs.length ? group('Air conditioners', [segmentedRow({ title: 'All ACs', key: 'acs', value: tri(s.acs?.['*']), small: true, options: OPTS, onChange: (v) => setRule('acs', '*', v) })]) : null,
          group(null, [row({ icon: 'trash', tint: TINT.danger, title: 'Delete scene', destructive: true, key: 'delete', onClick: () => { ctx.pop(); ctx.remove(sel); } })]),
        ],
      };
    },
  };
}

function capture(ctx, id) {
  const { store } = ctx;
  ctx.change((d) => {
    const sc = d.scenes.find((x) => x.id === id);
    sc.lights = {};
    for (const l of d.lights) {
      const s = store.state.lights[l.id];
      if (!s) continue;
      const caps = l.capabilities || [];
      const rule = { on: Boolean(s.on) };
      if (s.on && caps.includes('brightness')) rule.brightness = Math.round(s.brightness * 100) / 100;
      if (s.on && s.color && caps.includes('color')) rule.color = s.color;
      else if (s.on && caps.includes('temp')) rule.temp = s.temp;
      sc.lights[l.id] = rule;
    }
  });
  ctx.toast('Captured how every light is now');
}

/* ---------- Home settings ---------- */

export function settingsPage(ctx) {
  return {
    key: 'settings',
    short: 'Settings',
    render() {
      const doc = ctx.doc;
      const units = ctx.units;
      const imperial = units === 'imperial';
      const outdoor = doc.outdoorTemp ?? 27;
      const H = doc.wallHeight ?? 2.6;
      return {
        head: { tile: tile('settings', TINT.settings, 40), title: 'Home settings', subtitle: doc.name || 'Home' },
        body: [
          group('Name', [textRow({ value: doc.name, placeholder: 'Home name', key: 'home-name', onInput: (v) => ctx.change((d) => { d.name = v; }, { key: 'home-name', light: true }) })]),
          group('Units', [h('div.ed-row.ed-seg-full', segmented({ key: 'units', value: units, label: 'Units', options: [{ value: 'imperial', label: 'Feet' }, { value: 'metric', label: 'Metres' }], onChange: (v) => ctx.change((d) => { d.units = v; }) }))]),
          group('Building', [
            stepperRow({ title: 'Wall height', key: 'wh', value: H, format: (v) => M.fmtLen(v, units), min: 2, max: 4.5, step: (v, dir) => M.stepLength(v, dir, M.heightStep(units)), onChange: (v) => ctx.change((d) => { d.wallHeight = v; }, { key: 'wh' }) }),
            stepperRow({ title: 'Inner walls shown', key: 'iwh', value: doc.interiorWallHeight ?? 1.25, format: (v) => M.fmtLen(v, units), min: 0.2, max: H, step: (v, dir) => M.stepLength(v, dir, M.heightStep(units)), onChange: (v) => ctx.change((d) => { d.interiorWallHeight = v; }, { key: 'iwh' }) }),
            stepperRow({ title: 'Outdoor temperature', key: 'out',
              value: imperial ? Math.round(M.cToF(outdoor)) : Math.round(outdoor), format: (v) => `${v}°${imperial ? 'F' : 'C'}`, step: 1, min: imperial ? -4 : -20, max: imperial ? 113 : 45,
              onChange: (v) => ctx.change((d) => { d.outdoorTemp = imperial ? Math.round(M.fToC(v) * 10) / 10 : v; }, { key: 'out' }) }),
          ], 'Inner walls are drawn cut low so you can see into the rooms. Without real sensors the outdoor temperature drives the simulated rooms.'),
          group('View', [
            stepperRow({ title: 'View angle', key: 'az', value: Math.round(doc.camera?.azimuth ?? 34), format: deg, step: (v, dir) => { const n = Math.round((v + dir * 15) / 15) * 15; return n > 180 ? n - 360 : n < -180 ? n + 360 : n; },
              onChange: (v) => ctx.change((d) => { d.camera = { azimuth: v, elevation: d.camera?.elevation ?? 47 }; }, { key: 'az' }) }),
          ], 'Walls facing the camera are cut away, so the angle decides which side of the home is open.'),
          group('Plan file', [
            row({ icon: 'download', tint: ACCENT, title: 'Download plan', subtitle: 'The plan as a JSON file', key: 'export', onClick: () => ctx.exportPlan() }),
            row({ icon: 'upload', tint: ACCENT, title: 'Import plan…', subtitle: 'Replace this home with a plan file', key: 'import', onClick: () => ctx.importPlan() }),
          ], isNative ? null : 'An imported plan can be undone like any other change.'),
        ],
      };
    },
  };
}

/** The page of a selected item. */
export function itemPage(ctx, sel) {
  if (!sel) return null;
  if (sel.kind === 'room') return roomPage(ctx, sel.id);
  if (sel.kind === 'light') return lightPage(ctx, sel.id);
  if (sel.kind === 'ac') return acPage(ctx, sel.id);
  if (sel.kind === 'furniture') return furniturePage(ctx, sel.index);
  if (sel.kind === 'opening') return openingPage(ctx, sel.index);
  if (sel.kind === 'scene') return scenePage(ctx, sel.id);
  return null;
}
