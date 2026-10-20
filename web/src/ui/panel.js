// The control panel that lives in the menu bar popover: header, scenes, rooms,
// device tiles and the detail sheets for a light, an AC or the TV.
import * as THREE from 'three';
import { h, clamp, createSlider, createColorPad, openMenu } from './dom.js';
import { icon } from './icons.js';
import { lightColor } from '../three/lights.js';
import { MODE_COLORS } from '../three/ac.js';
import { AC_SWINGS } from '../store.js';
import { haptic, isPhone, isHub } from '../bridge.js';
import { containsPoint } from '../geom.js';
import { tv, tvLinks } from '../tv/client.js';
import { APPS, appInfo, statusOf, glowOf, logoSVG } from '../tv/apps.js';
import { createPad, createVolume, createSearch } from '../tv/remote.js';

const MODE_LABEL = { cool: 'Cool', heat: 'Heat', dry: 'Dry', fan: 'Fan', auto: 'Auto' };
const FAN_LABEL = { auto: 'Auto', low: 'Low', medium: 'Medium', high: 'High', turbo: 'Turbo' };
const SWING_LABEL = { swing: 'Swing', l1: 'L1', l2: 'L2', l3: 'L3', l4: 'L4', l5: 'L5', off: 'Off' };
const SWATCHES = ['#ff5a4f', '#ff9a3c', '#ffd84a', '#5fe08a', '#42d6e8', '#4f8dff', '#8b5cff', '#ff5fc4'];

const TEMP_GRADIENT = 'linear-gradient(90deg, #2f7df6 0%, #58b4f5 34%, #f3e2c0 62%, #f6a54a 82%, #f0762c 100%)';
const DIM_GRADIENT = 'linear-gradient(90deg, #4a4f5e 0%, #b9a98c 45%, #ffe2b0 100%)';
const KELVIN_GRADIENT = 'linear-gradient(90deg, #ff9438 0%, #ffbd7a 30%, #ffe2c2 62%, #dfe9ff 100%)';

const NAVY = new THREE.Color('#17274f');
const tmp = new THREE.Color();
const css = (c) => `#${c.getHexString()}`;

function lightStatus(cfg, s) {
  if (!s.on) return 'Off';
  return cfg.capabilities.includes('brightness') ? `${Math.round(s.brightness * 100)}%` : 'On';
}

function acTemperatureColor(target, cfg) {
  const t = clamp((target - cfg.min) / (cfg.max - cfg.min), 0, 1);
  return tmp.set('#1c4fc0').lerp(new THREE.Color('#8a3d12'), t).clone();
}

export function createPanel(root, config, store, { onFocus, onMenu, onEdit, onEditPrefetch, editing = false, grown = false }) {
  const { state } = store;
  const ui = { room: 'all', sheet: null };
  let world = null;
  const roomName = new Map(config.rooms.map((r) => [r.id, r.name]));

  /* ---------- skeleton ---------- */

  const canvas = h('canvas', { tabindex: -1 });
  const tooltip = h('div.tooltip');
  const homeSub = h('div.home-sub');
  const power = h('button.round.power', { title: 'Everything on / off', 'aria-label': 'Toggle everything', onclick: toggleEverything }, icon('power', 21, 2.2));
  // The hub has nothing else to put in the menu: the editor finds new devices itself.
  const gear = isHub ? null : h('button.round', { title: 'Floor plan', 'aria-label': 'Floor plan menu', onclick: () => onMenu(gear) }, icon('settings', 17));
  // Starting to load the editor on press means it is ready when the camera lands.
  const pencil = h('button.round.edit', { title: 'Edit home', 'aria-label': 'Edit home', onpointerdown: () => onEditPrefetch?.(), onclick: () => onEdit?.() }, icon('pencil', 17, 2));
  // Shown while an AI assistant has a link to this home (AI Access on the Mac).
  const aiBadge = h('button.ai-badge', { hidden: true, title: 'An AI assistant has access — click to manage', 'aria-label': 'AI access',
    onclick: () => onMenu(aiBadge, 'agent') }, icon('sparkles', 13, 2.2), h('span', 'AI'));

  const scenes = h('div.scenes');
  const rooms = h('div.rooms');
  const listTitle = h('span.title');
  const grid = h('div.grid');
  const panel = h('section.panel',
    scenes, rooms,
    h('div.list-head', listTitle,
      h('button.pill', { onclick: () => bulk(true) }, 'All on'),
      h('button.pill', { onclick: () => bulk(false) }, 'All off')),
    h('div.devices', grid));
  const sheet = h('section.sheet.hidden');
  sheet.inert = true;
  const toastEl = h('div.panel-toast');

  const clip = h('div.card-clip',
    h('div.stage', canvas),
    h('div.tint'),
    h('header.top',
      h('div.home', h('div.home-badge', icon('home', 17)),
        h('div', h('div.home-name', config.name), homeSub)),
      aiBadge, gear, pencil, power),
    tooltip, panel, sheet, toastEl);
  // Built under an open editor: already in its editing shape, so nothing animates into it.
  const card = h(`div.card.booting${editing ? '.editing.faded' : ''}${grown ? '.grow' : ''}`, h('div.notch'), clip);
  // Appended: while the plan is swapped, the new card fades in over the old one.
  root.append(card);

  /* ---------- scenes ---------- */

  const sceneButtons = new Map();
  for (const s of config.scenes) {
    const b = h('button.scene', { onclick: () => { haptic('medium'); store.applyScene(s.id); } }, icon(s.icon, 19), s.name);
    sceneButtons.set(s.id, b);
    scenes.append(b);
  }
  if (!config.scenes.length) scenes.style.display = 'none';

  /* ---------- rooms ---------- */

  const roomButtons = new Map();
  for (const r of [{ id: 'all', name: 'All' }, ...config.rooms]) {
    const count = h('span.count.zero', '0');
    const b = h('button.room', { onclick: () => { haptic('tick'); selectRoom(r.id); } }, r.name, count);
    roomButtons.set(r.id, { b, count });
    rooms.append(b);
  }

  function selectRoom(id) {
    if (ui.room === id) id = 'all';
    ui.room = id;
    layoutTiles();
    update();
    roomButtons.get(id).b.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    onFocus(id === 'all' ? null : { kind: 'room', id });
  }

  function inScope(cfg) {
    return ui.room === 'all' || cfg.room === ui.room;
  }

  function bulk(on) {
    haptic('medium');
    if (ui.room === 'all') { store.setAllLights(on); return; }
    for (const l of config.lights) if (l.room === ui.room) store.setLight(l.id, { on });
  }

  function toggleEverything() {
    haptic('heavy');
    const anyOn = Object.values(state.lights).some((l) => l.on) || Object.values(state.acs).some((a) => a.on);
    if (anyOn) {
      store.setAllLights(false);
      for (const id of Object.keys(state.acs)) store.setAC(id, { on: false });
    } else {
      store.setAllLights(true);
    }
  }

  /* ---------- tiles ---------- */

  const tiles = new Map();

  function lightTile(cfg) {
    const dimmable = cfg.capabilities.includes('brightness');
    const hasSheet = cfg.capabilities.length > 0;
    const sub = h('div.tile-sub');
    // A phone has no room for the button: touching and holding the tile opens the sheet there.
    const more = hasSheet && !isPhone
      ? h('button.tile-more', { 'aria-label': `${cfg.name} settings`, onclick: (e) => { e.stopPropagation(); openSheet({ kind: 'light', id: cfg.id }); } }, icon('sliders', 15))
      : null;
    const el = h(`div.tile${dimmable ? '.dimmable' : ''}`, { role: 'button', tabindex: 0, 'aria-label': cfg.name },
      h('div.bubble', icon(cfg.capabilities.length ? cfg.type : 'plug', 19)),
      h('div.tile-text', h('div.tile-name', cfg.name), sub),
      more,
      h('div.tile-level'));

    // Tap toggles; dragging sideways dims (HomeKit-style).
    let gesture = null;
    el.addEventListener('pointerdown', (ev) => {
      if (ev.target.closest('.tile-more') || ev.button !== 0) return;
      el.setPointerCapture(ev.pointerId);
      const s = state.lights[cfg.id];
      gesture = { x: ev.clientX, y: ev.clientY, start: s.on ? s.brightness : 0, moved: false, step: null };
      el.classList.add('pressed');
      if (isPhone && hasSheet) {
        gesture.hold = setTimeout(() => {
          if (!gesture || gesture.moved) return;
          gesture = null;
          el.classList.remove('pressed');
          haptic('medium');
          openSheet({ kind: 'light', id: cfg.id });
        }, 420);
      }
    });
    el.addEventListener('pointermove', (ev) => {
      if (!gesture) return;
      const dx = ev.clientX - gesture.x;
      if (Math.hypot(dx, ev.clientY - gesture.y) > 8) clearTimeout(gesture.hold);
      // A mostly vertical move is the list being scrolled, not a dim.
      if (!gesture.moved && dimmable && Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(ev.clientY - gesture.y)) {
        gesture.moved = true;
        el.classList.add('dragging');
      }
      if (gesture.moved) {
        const b = clamp(gesture.start + dx / el.clientWidth, 0, 1);
        const step = Math.round(b * 20);
        if (step !== gesture.step) { if (gesture.step !== null) haptic('tick'); gesture.step = step; }
        store.setLight(cfg.id, b < 0.04 ? { on: false } : { on: true, brightness: b });
      }
    });
    const finish = (ev) => {
      if (!gesture) return;
      const tapped = !gesture.moved && ev.type === 'pointerup';
      clearTimeout(gesture.hold);
      gesture = null;
      el.classList.remove('pressed', 'dragging');
      if (tapped) toggleLight(cfg.id);
    };
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', finish);
    el.addEventListener('keydown', (ev) => {
      if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); toggleLight(cfg.id); }
    });

    return {
      el, cfg, kind: 'light',
      update() {
        const s = state.lights[cfg.id];
        el.classList.toggle('on', s.on);
        el.style.setProperty('--c', css(lightColor(s, tmp)));
        el.style.setProperty('--level', s.on ? String(s.brightness) : '0');
        // On a phone the group heading above the tile already names the room.
        sub.textContent = ui.room === 'all' && !isPhone ? `${lightStatus(cfg, s)} · ${roomName.get(cfg.room)}` : lightStatus(cfg, s);
      },
    };
  }

  function acTile(cfg) {
    const sub = h('div.tile-sub');
    const value = h('div.value');
    const bubble = h('div.bubble');
    const step = (d) => (e) => {
      e.stopPropagation();
      haptic('tick');
      const s = state.acs[cfg.id];
      store.setAC(cfg.id, { on: true, target: s.target + d });
    };
    const el = h('div.tile.ac', { role: 'button', tabindex: 0, 'aria-label': cfg.name, onclick: () => openSheet({ kind: 'ac', id: cfg.id }) },
      bubble,
      h('div.tile-text', h('div.tile-name', cfg.name), sub),
      h('div.stepper',
        h('button', { 'aria-label': 'Cooler', onclick: step(-1) }, icon('minus', 15, 2.2)),
        value,
        h('button', { 'aria-label': 'Warmer', onclick: step(1) }, icon('plus', 15, 2.2))),
      h('button.mini-power', { 'aria-label': `${cfg.name} power`, onclick: (e) => { e.stopPropagation(); haptic('medium'); store.setAC(cfg.id, { on: !state.acs[cfg.id].on }); } }, icon('power', 16, 2.2)));
    el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') openSheet({ kind: 'ac', id: cfg.id }); });
    let shownMode = null;
    return {
      el, cfg, kind: 'ac',
      update() {
        const s = state.acs[cfg.id];
        el.classList.toggle('on', s.on);
        el.style.setProperty('--c', MODE_COLORS[s.mode]);
        if (shownMode !== s.mode) { bubble.replaceChildren(icon(s.mode, 19)); shownMode = s.mode; }
        value.textContent = `${s.target}°`;
        sub.textContent = `${s.on ? MODE_LABEL[s.mode] : 'Off'} · Room ${s.roomTemp.toFixed(isPhone ? 0 : 1)}°`;
      },
    };
  }

  for (const cfg of config.acs) tiles.set(cfg.id, acTile(cfg));
  for (const cfg of config.lights) tiles.set(cfg.id, lightTile(cfg));

  /* ---------- the TV ---------- */

  // The real TVs the plan's TV pieces show (tv/client.js), each with the room it stands in.
  const tvTiles = new Map();
  let tvShown = '';

  function roomAt(pos) {
    if (!Array.isArray(pos)) return null;
    const inside = config.rooms.filter((r) => containsPoint(r.points, pos));
    return inside.sort((a, b) => a.area - b.area)[0]?.id ?? null;
  }

  function linkedTvs() {
    const out = [];
    for (const l of tvLinks(config.furniture, tv.state)) {
      if (l.id && !out.some((t) => t.id === l.id)) out.push({ id: l.id, room: roomAt(l.item.pos) });
    }
    return out;
  }

  const tvDevice = (id) => tv.device(id);
  const tvName = (id) => tvDevice(id)?.name || 'TV';
  const tvStatus = (id) => statusOf(tvDevice(id), tv.state.available);

  // Off: wake it. On: put it to sleep.
  function tvPower(id) {
    const d = tvDevice(id);
    if (!tv.state.available || !d?.online) { toast(tv.state.error || `${tvName(id)} can’t be reached.`); haptic('error'); return; }
    haptic('medium');
    tv.act(id, { action: d.on ? 'sleep' : 'wake' });
  }

  function tvTile(t) {
    const sub = h('div.tile-sub');
    const name = h('div.tile-name');
    const bubble = h('div.bubble');
    const powerBtn = h('button.mini-power', { 'aria-label': 'TV power', onclick: (e) => { e.stopPropagation(); tvPower(t.id); } }, icon('power', 16, 2.2));
    const el = h('div.tile.tv', { role: 'button', tabindex: 0, onclick: () => openSheet({ kind: 'tv', id: t.id }) },
      bubble, h('div.tile-text', name, sub), powerBtn);
    el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') openSheet({ kind: 'tv', id: t.id }); });
    let shownApp;
    return {
      el, cfg: { id: t.id, room: t.room }, kind: 'tv',
      update() {
        const d = tvDevice(t.id);
        const on = Boolean(d?.on);
        el.classList.toggle('on', on);
        el.style.setProperty('--c', on ? glowOf(d.app) : 'var(--warm)');
        name.textContent = tvName(t.id);
        el.setAttribute('aria-label', tvName(t.id));
        sub.textContent = tvStatus(t.id);
        const app = on && d.app && d.app.id !== 'other' ? d.app.id : null;
        if (shownApp !== app) {
          bubble.replaceChildren(app ? logoSVG(d.app, 42) : icon('tv', 19));
          bubble.classList.toggle('logo', Boolean(app));
          shownApp = app;
        }
        powerBtn.disabled = !tv.state.available;
      },
    };
  }

  // A TV that turns up (or goes) changes the list: lay it out again.
  function syncTvTiles() {
    const list = linkedTvs();
    const key = JSON.stringify(list);
    if (key === tvShown) return false;
    tvShown = key;
    tvTiles.clear();
    for (const t of list) tvTiles.set(t.id, tvTile(t));
    return true;
  }
  syncTvTiles();

  function toggleLight(id) {
    haptic('light');
    world?.lights.get(id)?.bump();
    store.toggleLight(id);
  }

  function layoutTiles() {
    const nodes = [];
    let i = 0;
    const add = (t) => { t.el.style.setProperty('--i', i++); nodes.push(t.el); };
    for (const room of config.rooms) {
      if (ui.room !== 'all' && room.id !== ui.room) continue;
      const devices = [...tiles.values(), ...tvTiles.values()].filter((t) => t.cfg.room === room.id);
      if (!devices.length) continue;
      if (ui.room === 'all') nodes.push(h('div.group-label', room.name));
      devices.filter((t) => t.kind === 'ac').forEach(add);
      devices.filter((t) => t.kind === 'tv').forEach(add);
      devices.filter((t) => t.kind === 'light').forEach(add);
    }
    if (!nodes.length) nodes.push(h('div.group-label', 'No devices in this room yet'));
    else if (isPhone && config.lights.some((l) => l.capabilities.length && inScope(l))) {
      nodes.push(h('div.grid-hint', 'Touch and hold a light for brightness and colour'));
    }
    grid.replaceChildren(...nodes);
    grid.parentElement.scrollTop = 0;
  }

  /* ---------- sheets ---------- */

  let sheetView = null;

  function openSheet(target) {
    sheetView?.dispose?.();
    ui.sheet = target;
    sheetView = target.kind === 'ac' ? acSheet(target.id) : target.kind === 'tv' ? tvSheet(target.id) : lightSheet(target.id);
    sheet.replaceChildren(...sheetView.nodes);
    sheet.classList.toggle('tv', target.kind === 'tv');
    panel.classList.add('hidden');
    sheet.classList.remove('hidden');
    panel.inert = true;
    sheet.inert = false;
    card.classList.add('detail');
    hideTooltip();
    onFocus(target.kind === 'ac' || target.kind === 'tv' ? target : { kind: 'room', id: store.lightCfg.get(target.id).room });
    update();
  }

  function closeSheet() {
    if (!ui.sheet) return false;
    ui.sheet = null;
    sheetView?.dispose?.();
    sheetView = null;
    sheet.classList.add('hidden');
    panel.classList.remove('hidden');
    panel.inert = false;
    sheet.inert = true;
    card.classList.remove('detail');
    onFocus(ui.room === 'all' ? null : { kind: 'room', id: ui.room });
    update();
    return true;
  }

  function sheetHead(name, sub, powerBtn) {
    return h('div.sheet-head',
      h('button.round', { 'aria-label': 'Back', onclick: closeSheet }, icon('back', 19, 2.2)),
      h('div.sheet-title', h('div.sheet-name', name), sub),
      powerBtn);
  }

  function bigNumber(unit) {
    const num = h('span.num');
    const el = h('div.big', num, h('small', unit));
    let shown = null;
    return {
      el,
      set(value, off) {
        el.classList.toggle('off', off);
        if (value === shown) return;
        if (shown !== null) {
          num.classList.remove('tick-up', 'tick-down');
          void num.offsetWidth;
          num.classList.add(value > shown ? 'tick-up' : 'tick-down');
        }
        num.textContent = value;
        shown = value;
      },
    };
  }

  function acSheet(id) {
    const cfg = store.acCfg.get(id);
    const s = () => state.acs[id];
    const set = (patch) => store.setAC(id, patch);
    const sub = h('div.sheet-sub');
    const powerBtn = h('button.round.power', { 'aria-label': 'Power', onclick: () => { haptic('medium'); set({ on: !s().on }); } }, icon('power', 21, 2.2));
    const big = bigNumber(`°${cfg.unit}`);
    const eco = h('button.toggle-chip', { onclick: () => { haptic('light'); set({ eco: !s().eco }); } }, icon('leaf', 17), 'Eco Mode', h('span.switch'));
    const slider = createSlider({
      min: cfg.min, max: cfg.max, value: s().target, gradient: TEMP_GRADIENT,
      labels: [`${cfg.min}°`, `${cfg.max}°`],
      onInput: (v) => set({ on: true, target: v }),
    });

    const features = () => store.acFeatures(id);
    const option = (key, label, labels, values, iconName) => {
      const value = h('div.option-value');
      let holder = h('span');
      const el = h('button.option', { onclick: () => {
        el.classList.add('open');
        openMenu(clip, el, values().map((v) => ({
          label: labels[v], selected: s()[key] === v, icon: s()[key] === v ? icon('check', 16, 2.4) : null,
          action: () => { haptic('light'); set(key === 'mode' ? { on: true, mode: v } : { [key]: v }); },
        })), { onClose: () => el.classList.remove('open') });
      } }, holder, h('span.corner', icon('down', 15, 2.2)), h('div.option-label', label), value);
      let shown = null;
      return {
        el,
        update() {
          value.textContent = labels[s()[key]];
          const ic = iconName || s().mode;
          if (shown !== ic) {
            const next = icon(ic, 24, 1.6);
            holder.replaceWith(next);
            holder = next;
            shown = ic;
          }
        },
      };
    };

    const mode = option('mode', 'Mode', MODE_LABEL, () => features().modes, null);
    const fan = option('fan', isPhone ? 'Fan' : 'Fan speed', FAN_LABEL, () => features().fans, 'fan');
    const swing = option('swing', 'Airflow', SWING_LABEL, () => AC_SWINGS, 'wind');
    const sleepValue = h('div.option-value');
    const sleep = h('button.option', { onclick: () => { haptic('light'); set({ sleep: !s().sleep }); } },
      icon('moon', 24, 1.6), h('span.corner.dot'), h('div.option-label', 'Sleep'), sleepValue);
    const options = h('div.options', mode.el, fan.el, sleep, swing.el);

    return {
      nodes: [
        sheetHead(cfg.name, sub, powerBtn),
        h('div.readout', big.el, eco),
        h('div.slider-row',
          h('button.round', { 'aria-label': 'Cooler', onclick: () => { haptic('tick'); set({ on: true, target: s().target - 1 }); } }, icon('minus', 18, 2.2)),
          slider.el,
          h('button.round', { 'aria-label': 'Warmer', onclick: () => { haptic('tick'); set({ on: true, target: s().target + 1 }); } }, icon('plus', 18, 2.2))),
        options,
      ],
      update() {
        const a = s();
        // A real AC only shows the controls it has a function for.
        const f = features();
        const shown = [[mode.el, f.modes.length > 0], [fan.el, f.fans.length > 0], [sleep, f.sleep], [swing.el, f.swing]];
        for (const [el, on] of shown) el.hidden = !on;
        eco.hidden = !f.eco;
        options.style.gridTemplateColumns = `repeat(${shown.filter(([, on]) => on).length || 1}, 1fr)`;
        powerBtn.classList.toggle('on', a.on);
        sub.replaceChildren(icon('thermo', 14), 'Room ', h('b', `${a.roomTemp.toFixed(cfg.unit === 'F' ? 0 : 1)}°${cfg.unit}`),
          h('span.live', { style: { background: a.on ? MODE_COLORS[a.mode] : 'rgba(255,255,255,.25)', boxShadow: a.on ? `0 0 8px ${MODE_COLORS[a.mode]}` : 'none' } }));
        big.set(a.target, !a.on);
        slider.set(a.target);
        eco.classList.toggle('on', a.eco);
        mode.update(); fan.update(); swing.update();
        sleep.classList.toggle('active', a.sleep);
        sleepValue.textContent = a.sleep ? 'On' : 'Off';
      },
    };
  }

  function lightSheet(id) {
    const cfg = store.lightCfg.get(id);
    const s = () => state.lights[id];
    const set = (patch) => store.setLight(id, patch);
    const caps = cfg.capabilities;
    const sub = h('div.sheet-sub');
    const powerBtn = h('button.round.power', { 'aria-label': 'Power', onclick: () => toggleLight(id) }, icon('power', 21, 2.2));
    const big = bigNumber('%');
    const nodes = [sheetHead(cfg.name, sub, powerBtn), h('div.readout', big.el)];
    const sliders = {};

    if (caps.includes('brightness')) {
      sliders.brightness = createSlider({
        min: 5, max: 100, value: Math.round(s().brightness * 100), gradient: DIM_GRADIENT, detent: 5,
        onInput: (v) => set({ on: true, brightness: v / 100 }),
      });
      nodes.push(h('div.slider-row',
        h('button.round', { 'aria-label': 'Dimmer', onclick: () => { haptic('tick'); set({ on: true, brightness: s().brightness - 0.1 }); } }, icon('dim', 18)),
        sliders.brightness.el,
        h('button.round', { 'aria-label': 'Brighter', onclick: () => { haptic('tick'); set({ on: true, brightness: s().brightness + 0.1 }); } }, icon('bright', 18))));
    }
    let kelvinLabel = null;
    if (caps.includes('temp')) {
      kelvinLabel = h('span');
      sliders.temp = createSlider({
        min: 2200, max: 6500, step: 100, value: s().temp, gradient: KELVIN_GRADIENT, compact: true, detent: 500,
        onInput: (v) => set({ on: true, temp: v }),
      });
      nodes.push(h('div.field-label', h('span', 'Colour temperature'), kelvinLabel), h('div.slider-row', sliders.temp.el));
    }
    let swatches = [];
    let pad = null;
    let colorLabel = null;
    if (caps.includes('color')) {
      colorLabel = h('span');
      pad = createColorPad({ value: s().color, onInput: (c) => set({ on: true, color: c }) });
      swatches = SWATCHES.map((c) => h('button.swatch', { 'aria-label': `Colour ${c}`, vars: { '--sw': c }, onclick: () => { haptic('light'); set({ on: true, color: c }); } }));
      nodes.push(h('div.field-label', h('span', 'Colour'), colorLabel), pad.el, h('div.swatches', swatches));
    } else {
      nodes.push(h('div.sheet-note', icon(cfg.type, 20),
        `${roomName.get(cfg.room)} · drag across a light tile to dim it, or ${isPhone ? 'tap' : 'click'} the lamp in the 3D view to toggle.`));
    }

    return {
      nodes,
      update() {
        const l = s();
        powerBtn.classList.toggle('on', l.on);
        sub.replaceChildren(roomName.get(cfg.room), ' · ', h('b', l.on ? 'On' : 'Off'));
        big.set(caps.includes('brightness') ? Math.round(l.brightness * 100) : l.on ? 100 : 0, !l.on);
        sliders.brightness?.set(Math.round(l.brightness * 100));
        sliders.temp?.set(l.temp);
        if (kelvinLabel) kelvinLabel.textContent = l.color ? '—' : `${l.temp} K`;
        swatches.forEach((el, i) => el.classList.toggle('selected', l.color?.toLowerCase() === SWATCHES[i]));
        pad?.set(l.color);
        if (colorLabel) colorLabel.textContent = l.color ? l.color.toUpperCase() : 'White';
      },
    };
  }

  // The TV's launcher and remote: its apps, the pad, the volume and a title search.
  function tvSheet(id) {
    const d = () => tvDevice(id);
    const sub = h('div.sheet-sub');
    const name = h('span');
    const powerBtn = h('button.round.power', { 'aria-label': 'TV power', onclick: () => tvPower(id) }, icon('power', 21, 2.2));
    let opening = null; // { app, until }: asked for, not yet on the screen
    const key = (action) => tv.act(id, { action });

    function open(app, play = null) {
      if (!tv.state.available) { toast(tv.state.error || 'The TV can’t be reached.'); haptic('error'); return; }
      haptic('light');
      opening = { app, until: Date.now() + 8000 };
      update();
      const body = play ? { action: 'play', app: app.id, link: play.link, name: app.name } : { action: 'open', app: app.id, name: app.name };
      tv.act(id, body).then((ok) => { if (!ok) { opening = null; update(); } });
    }

    const nowLogo = h('span.tv-now-logo');
    const nowName = h('b');
    const now = h('div.tv-now', nowLogo, h('div.tv-now-text', h('span', 'Now on'), nowName),
      h('button.tv-now-home', { 'aria-label': 'Home screen', title: 'Home screen', onclick: () => { haptic('light'); key('home'); } }, icon('home', 16, 2)));

    const appButtons = new Map(APPS.map((a) => [a.id, h('button.tv-app', { 'aria-label': `Open ${a.name}`, title: a.name, onclick: () => open(a) },
      h('span.tv-app-icon', logoSVG(a, 58), h('i.tv-app-dot')), h('span.tv-app-name', a.name))]));
    const apps = h('div.tv-apps', [...appButtons.values()]);

    const pad = createPad({ onKey: key });
    const side = (label, name, action, extra = null) => h('button.round.tv-key', { 'aria-label': label, title: label, onclick: () => { haptic('light'); key(action); } }, icon(name, 19, 2.1), extra);
    const muteBtn = side('Mute', 'mute', 'mute');
    const remote = h('div.tv-remote',
      h('div.tv-keys', side('Back', 'undo', 'back'), side('Home', 'home', 'home')),
      pad.el,
      h('div.tv-keys', h('button.round.tv-key.tv-playpause', { 'aria-label': 'Play or pause', title: 'Play / pause', onclick: () => { haptic('light'); key('playpause'); } },
        icon('play', 14, 2.4), icon('pause', 14, 2.4)), muteBtn));

    const volume = createVolume({
      onStep: (dir) => key(dir > 0 ? 'volup' : 'voldown'),
      onLevel: (level) => tv.act(id, { action: 'volume', level }),
    });
    const volumeRow = h('div.tv-volume-row', volume.el);

    const search = createSearch({
      search: (q) => tv.search(q),
      onPlay: (r, offer) => open(appInfo({ id: offer.app }) || { id: offer.app, name: offer.name }, offer),
      onTvSearch: (q) => tv.act(id, { action: 'search', text: q }).then((ok) => ok && toast(`Searching the TV for “${q}”`, null, { note: true })),
      onType: (q) => tv.act(id, { action: 'text', text: q }).then((ok) => ok && toast(`Typed “${q}” on the TV`, null, { note: true })),
    });

    const problemText = h('span');
    const problem = h('div.sheet-note.tv-problem', { hidden: true }, icon('offline', 18, 2), problemText);
    const scroll = h('div.tv-scroll', problem, now, h('div.tv-label', 'Apps'), apps, remote, volumeRow, h('div.tv-label', 'Search'), search.el);

    return {
      nodes: [sheetHead(name, sub, powerBtn), scroll],
      // Desktop and the Mac: the keyboard drives the pad while the sheet is open (not
      // while typing in the search field, and a focused button keeps Enter and Space).
      key(ev) {
        const t = ev.target;
        if (t?.closest?.('input, textarea, select, [contenteditable]')) return false;
        if (t?.closest?.('button, [role=button], [role=slider]') && ['Enter', ' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(ev.key)) return false;
        return pad.key(ev);
      },
      dispose() { pad.stop(); volume.stop(); search.stop(); },
      search, // for screenshots and tests: search.show('the')
      update() {
        const dev = d();
        const available = tv.state.available && Boolean(dev?.online);
        const on = Boolean(dev?.on);
        const app = on ? dev.app : null;
        if (opening && (Date.now() > opening.until || app?.id === opening.app.id)) opening = null;
        name.textContent = tvName(id);
        powerBtn.classList.toggle('on', on);
        powerBtn.disabled = !tv.state.available || !dev?.online;
        powerBtn.title = powerBtn.disabled ? (tv.state.error || 'The TV can’t be reached') : on ? 'Turn the TV off' : 'Turn the TV on';
        const glow = on ? glowOf(app) : null;
        sub.replaceChildren(
          opening ? `Opening ${opening.app.name}…` : h('b', tv.ready ? tvStatus(id) : 'Connecting…'),
          h('span.live', { style: { background: on ? glow : 'rgba(255,255,255,.25)', boxShadow: on ? `0 0 8px ${glow}` : 'none' } }));
        problem.hidden = !(tv.ready && !available);
        problemText.textContent = !tv.state.available ? tv.state.error || 'The TV can’t be reached.'
          : `${tvName(id)} isn’t answering. Is it plugged in and on the Wi-Fi?`;
        // Now on: the app on the screen (not the home screen).
        const showing = on && app && app.id !== 'home';
        now.hidden = !showing;
        if (showing && nowLogo.dataset.app !== `${app.id}:${app.name}`) {
          nowLogo.replaceChildren(logoSVG(app, 34));
          nowLogo.dataset.app = `${app.id}:${app.name}`;
        }
        if (showing) nowName.textContent = app.name;
        for (const [aid, b] of appButtons) {
          b.classList.toggle('current', on && app?.id === aid);
          b.classList.toggle('opening', opening?.app.id === aid);
        }
        remote.classList.toggle('asleep', !on);
        remote.classList.toggle('unreachable', !available);
        volumeRow.hidden = !on || dev.volume == null;
        if (on) volume.set(dev.volume, dev.volumeMax, dev.muted);
        muteBtn.classList.toggle('active', Boolean(on && dev.muted));
      },
    };
  }

  /** `ai`: something an AI assistant did (who, what), instead of an error. `note`: news, not an error. */
  function toast(text, ai = null, { note = false } = {}) {
    toastEl.replaceChildren(...(ai ? [h('span.toast-ai', icon('sparkles', 13, 2.2), ai), h('span', text)] : [text]));
    toastEl.classList.toggle('ai', Boolean(ai));
    toastEl.classList.toggle('note', note && !ai);
    toastEl.classList.add('show');
    clearTimeout(toastEl.timer);
    toastEl.timer = setTimeout(() => toastEl.classList.remove('show'), 3200);
  }

  /* ---------- tooltip ---------- */

  function hideTooltip() { tooltip.classList.remove('show'); }

  function showTooltip(hit) {
    if (!hit) { hideTooltip(); return; }
    let name;
    let status;
    let on;
    let color;
    if (hit.kind === 'light') {
      const cfg = store.lightCfg.get(hit.id);
      const s = state.lights[hit.id];
      name = cfg.name; status = lightStatus(cfg, s); on = s.on; color = css(lightColor(s, tmp));
    } else if (hit.kind === 'tv') {
      const d = tvDevice(hit.id);
      name = tvName(hit.id); status = tvStatus(hit.id); on = Boolean(d?.on); color = glowOf(d?.app);
    } else {
      const cfg = store.acCfg.get(hit.id);
      const s = state.acs[hit.id];
      name = cfg.name; status = s.on ? `${MODE_LABEL[s.mode]} ${s.target}°` : 'Off'; on = s.on; color = MODE_COLORS[s.mode];
    }
    tooltip.replaceChildren(h('i.dot'), name, h('span', status));
    tooltip.classList.toggle('on', on);
    tooltip.style.setProperty('--dot', color);
    tooltip.style.left = `${clamp(hit.x, 70, card.clientWidth - 70)}px`;
    tooltip.style.top = `${Math.max(64, hit.y)}px`;
    tooltip.classList.add('show');
  }

  /* ---------- derived state ---------- */

  function mood() {
    if (ui.sheet?.kind === 'tv') {
      const d = tvDevice(ui.sheet.id);
      return d?.on ? new THREE.Color(glowOf(d.app)).multiplyScalar(0.32).lerp(NAVY, 0.45) : NAVY.clone().multiplyScalar(0.8);
    }
    if (ui.sheet?.kind === 'ac') {
      const a = state.acs[ui.sheet.id];
      if (!a.on) return NAVY.clone().multiplyScalar(0.8);
      if (a.mode === 'cool' || a.mode === 'heat' || a.mode === 'auto') return acTemperatureColor(a.target, store.acCfg.get(ui.sheet.id));
      return new THREE.Color(MODE_COLORS[a.mode]).multiplyScalar(0.38);
    }
    const sum = new THREE.Color(0, 0, 0);
    let weight = 0;
    for (const cfg of config.lights) {
      const s = state.lights[cfg.id];
      if (!s.on) continue;
      const w = cfg.capabilities.includes('brightness') ? s.brightness : 1;
      lightColor(s, tmp);
      sum.r += tmp.r * w; sum.g += tmp.g * w; sum.b += tmp.b * w;
      weight += w;
    }
    if (!weight) return NAVY.clone();
    sum.multiplyScalar(0.42 / weight);
    return NAVY.clone().lerp(sum, clamp(weight / 3.5, 0.25, 0.8));
  }

  function update() {
    const lights = Object.values(state.lights);
    const onCount = lights.filter((l) => l.on).length;
    const acsOn = Object.values(state.acs).filter((a) => a.on);
    const anyOn = onCount > 0 || acsOn.length > 0;

    homeSub.replaceChildren(
      h('span.live', { style: anyOn ? {} : { background: 'rgba(255,255,255,.25)', boxShadow: 'none' } }),
      h('b', onCount ? `${onCount} of ${lights.length}` : 'No'), ' lights on',
      acsOn.length ? ` · AC ${acsOn[0].target}°` : '');
    power.classList.toggle('on', anyOn);

    for (const [id, b] of sceneButtons) b.classList.toggle('active', state.scene === id);

    for (const [id, { b, count }] of roomButtons) {
      b.classList.toggle('active', ui.room === id);
      const n = config.lights.filter((l) => (id === 'all' || l.room === id) && state.lights[l.id].on).length;
      count.textContent = n;
      count.classList.toggle('zero', n === 0 || id === 'all');
    }

    const scoped = config.lights.filter(inScope);
    const scopedOn = scoped.filter((l) => state.lights[l.id].on).length;
    listTitle.replaceChildren(h('b', ui.room === 'all' ? 'Whole home' : roomName.get(ui.room)), ` · ${scopedOn} of ${scoped.length} on`);

    for (const t of tiles.values()) t.update();
    for (const t of tvTiles.values()) t.update();
    sheetView?.update();
    const m = css(mood());
    card.style.setProperty('--mood', m);
  }

  const unsubscribe = store.on(() => update());
  // The TV reports on its own: its tiles, its sheet and the list when a TV turns up or goes.
  const unsubscribeTv = tv.subscribe(() => {
    if (syncTvTiles()) layoutTiles();
    if (ui.sheet?.kind === 'tv') {
      // Still in the plan? A TV that went away closes its sheet.
      if (!tvTiles.has(ui.sheet.id) && tv.ready && !tvDevice(ui.sheet.id)) closeSheet();
    }
    update();
  });
  const onKey = (ev) => {
    // While the home is being edited, Esc belongs to the editor.
    if (card.classList.contains('editing')) return;
    if (ui.sheet?.kind === 'tv' && sheetView?.key(ev)) return;
    if (ev.key !== 'Escape') return;
    if (!closeSheet()) onMenu(null, 'escape');
  };
  window.addEventListener('keydown', onKey);

  layoutTiles();
  update();

  return {
    canvas,
    card,
    attach(w) { world = w; card.classList.remove('booting'); },
    showTooltip,
    openSheet,
    closeSheet,
    selectRoom,
    toggleLight,
    get room() { return ui.room; },
    setNotch(x) { card.style.setProperty('--notch-x', `${x}px`); },
    setAgentLive(live) { aiBadge.hidden = !live; },
    toast,
    /** Opens the TV's sheet when `id` is a TV the plan shows; false otherwise. */
    openTv(id) {
      if (!id || !tvTiles.has(id)) return false;
      openSheet({ kind: 'tv', id });
      return true;
    },
    get sheetView() { return sheetView; },
    anchorMenu: clip,
    clip,
    /** Stops listening; the card is removed by whoever replaces it. */
    dispose() {
      window.removeEventListener('keydown', onKey);
      unsubscribe();
      unsubscribeTv();
      sheetView?.dispose?.();
      clearTimeout(toastEl.timer);
    },
  };
}
