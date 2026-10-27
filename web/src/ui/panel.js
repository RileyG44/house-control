// The control panel that lives in the menu bar popover (and fills the iPhone's screen): the
// 3D view, and over it one card holding everything else — the home's header, scenes, rooms,
// device tiles (in the order they were dragged into) and the detail sheets for a light, an
// AC or the TV. The card is a sheet with two detents (ui/deck.js): pulled up, the model
// shrinks into the strip above it.
import * as THREE from 'three';
import { h, clamp, createSlider, createColorPad, openMenu } from './dom.js';
import { normalizeScenes } from '../config.js';
import { icon } from './icons.js';
import { lightColor } from '../three/lights.js';
import { MODE_COLORS } from '../three/ac.js';
import { AC_SWINGS } from '../store.js';
import { haptic, isPhone, isHub } from '../bridge.js';
import { containsPoint } from '../geom.js';
import { tv, tvLinks } from '../tv/client.js';
import { APPS, appInfo, statusOf, glowOf, logoSVG } from '../tv/apps.js';
import { createPad, createVolume, createSearch } from '../tv/remote.js';
import { createNowPlaying } from '../tv/nowplaying.js';
import { spotify, createSpotifyRemote } from '../media/spotify.js';
import { createReorder, flip } from './reorder.js';
import { createDeck } from './deck.js';
import { cycleTheme, themeChoice, resolved, onTheme } from './theme.js';
import { createVoice, voiceAvailable } from './voice.js';

const MODE_LABEL = { cool: 'Cool', heat: 'Heat', dry: 'Dry', fan: 'Fan', auto: 'Auto' };
const FAN_LABEL = { auto: 'Auto', low: 'Low', medium: 'Medium', high: 'High', turbo: 'Turbo' };
const SWING_LABEL = { swing: 'Swing', l1: 'L1', l2: 'L2', l3: 'L3', l4: 'L4', l5: 'L5', off: 'Off' };
// The icons a scene can have (the iPhone app offers the same).
const SCENE_ICONS = ['sun', 'bright', 'dim', 'sofa', 'film', 'tv', 'moon', 'bed', 'sparkles', 'leaf', 'kitchen', 'dining', 'bath', 'office', 'heat', 'cool', 'power'];
const SCENE_ICON_NAMES = { sun: 'Sun', bright: 'Bright', dim: 'Dim', sofa: 'Sofa', film: 'Film', tv: 'TV', moon: 'Moon', bed: 'Bed',
  sparkles: 'Sparkles', leaf: 'Leaf', kitchen: 'Kitchen', dining: 'Dining', bath: 'Bath', office: 'Office', heat: 'Warm', cool: 'Cool', power: 'Off' };
const SWATCHES = ['#ff5a4f', '#ff9a3c', '#ffd84a', '#5fe08a', '#42d6e8', '#4f8dff', '#8b5cff', '#ff5fc4'];

const TEMP_GRADIENT = 'linear-gradient(90deg, #2f7df6 0%, #58b4f5 34%, #f3e2c0 62%, #f6a54a 82%, #f0762c 100%)';
const DIM_GRADIENT = 'linear-gradient(90deg, #4a4f5e 0%, #b9a98c 45%, #ffe2b0 100%)';
const KELVIN_GRADIENT = 'linear-gradient(90deg, #ff9438 0%, #ffbd7a 30%, #ffe2c2 62%, #dfe9ff 100%)';

const NAVY = new THREE.Color('#17274f');
const THEME_ICON = { auto: 'themeAuto', light: 'sun', dark: 'moon' };
const THEME_NAME = { auto: 'Automatic', light: 'Light', dark: 'Dark' };
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

/**
 * `onOrder(tileOrder)`: the tiles were dragged into a new order (the plan's `tileOrder`:
 * every tile's key, room by room), for the caller to keep. `onLayout(metrics)`: where the
 * card rests and stops when pulled up changed (the window was resized). `onRoomOrder(ids)`: the
 * rooms were dragged into a new order (the plan's `rooms`, in that order). `onScenes(scenes)`:
 * a scene was made, edited or deleted (the plan's `scenes`, every one, in the plan's form).
 */
export function createPanel(root, config, store, { onFocus, onMenu, onEdit, onEditPrefetch, onOrder, onRoomOrder, onScenes, onLayout, editing = false, grown = false }) {
  const { state } = store;
  const ui = { room: 'all', sheet: null };
  let homeDetent = 'rest'; // where the card was on the home page, for when a sheet closes
  let order = config.tileOrder.slice();
  let world = null;
  const roomName = new Map(config.rooms.map((r) => [r.id, r.name]));
  const AXIS = 8; // px before a press on a tile or a scene is a slide or a scroll, not a tap or a hold
  let lastPointer = 'mouse'; // the last press's pointerType: a right click opens a page, a held finger doesn't

  /* ---------- skeleton ---------- */

  const canvas = h('canvas', { tabindex: -1 });
  const tooltip = h('div.tooltip');
  const homeSub = h('div.home-sub');
  const power = h('button.round.power', { title: 'Everything on / off', 'aria-label': 'Toggle everything', onclick: toggleEverything }, icon('power', isPhone ? 23 : 21, 2.2));
  // Light, dark, or the system's (Auto): the next one in turn, named for a moment.
  const themeBtn = h('button.round.theme', { onclick: () => { haptic('light'); cycleTheme(); } });
  const themeHint = h('div.theme-hint', { 'aria-live': 'polite' });
  let themeShown = null;
  function showTheme(look, choice, announce) {
    themeBtn.dataset.choice = choice;
    if (themeShown !== choice) themeBtn.replaceChildren(icon(THEME_ICON[choice], 18, 2));
    themeBtn.title = `Appearance: ${THEME_NAME[choice]}`;
    themeBtn.setAttribute('aria-label', `Appearance: ${THEME_NAME[choice]}. Change`);
    if (announce && themeShown !== null && themeShown !== choice) {
      themeHint.replaceChildren(icon(THEME_ICON[choice], 14, 2.2),
        choice === 'auto' ? h('span', 'Automatic', h('small', ` · ${look === 'light' ? 'light' : 'dark'} now`)) : h('span', `${THEME_NAME[choice]} appearance`));
      themeHint.classList.add('show');
      clearTimeout(themeHint.timer);
      themeHint.timer = setTimeout(() => themeHint.classList.remove('show'), 1500);
    }
    themeShown = choice;
  }
  showTheme(resolved(), themeChoice(), false);
  const offTheme = onTheme((look, choice) => showTheme(look, choice, true));
  // The hub has nothing else to put in the menu: the editor finds new devices itself.
  const gear = isHub ? null : h('button.round', { title: 'Floor plan', 'aria-label': 'Floor plan menu', onclick: () => onMenu(gear) }, icon('settings', 17));
  // Starting to load the editor on press means it is ready when the camera lands.
  const pencil = h('button.round.edit', { title: 'Edit home', 'aria-label': 'Edit home', onpointerdown: () => onEditPrefetch?.(), onclick: () => onEdit?.() }, icon('pencil', 17, 2));
  // Shown while an AI assistant has a link to this home (AI Access on the Mac).
  const aiBadge = h('button.ai-badge', { hidden: true, title: 'An AI assistant has access — click to manage', 'aria-label': 'AI access',
    onclick: () => onMenu(aiBadge, 'agent') }, icon('sparkles', 13, 2.2), h('span', 'AI'));
  // Say or type what you want, for the hub's agent (ui/voice.js): only where a hub runs it.
  const voice = voiceAvailable ? createVoice() : null;

  const sceneTrack = h('div.scene-track');
  const scenes = h('div.scenes', sceneTrack);
  const rooms = h('div.rooms');
  const listTitle = h('span.title');
  const grid = h('div.grid');
  const said = h('div.sr-only', { 'aria-live': 'polite' }); // a tile moved with the keyboard
  // The home's header is the top of the card: name and lights on the left, then the voice
  // button, the look, the editor and everything off. The voice card opens under it.
  const head = h('header.deck-head.deck-grab',
    h('div.home', h('div.home-name', config.name), homeSub),
    aiBadge, voice?.button, themeBtn, gear, pencil, power);
  const panel = h('section.panel',
    head, voice?.card, scenes, rooms,
    h('div.list-head', listTitle,
      h('button.pill.bulk', { onclick: () => bulk(true) }, 'All on'),
      h('button.pill.bulk', { onclick: () => bulk(false) }, 'All off'),
      h('button.pill.done', { onclick: () => arrangeRooms(false) }, 'Done')),
    h('div.devices', grid), said);
  const sheet = h('section.sheet.hidden');
  sheet.inert = true;
  const toastEl = h('div.panel-toast');
  const grabber = h('button.grabber.deck-grab', { 'aria-label': 'Show more controls', onclick: () => { haptic('tick'); deck.toggle(); } }, h('span'));
  const deckEl = h('div.deck', grabber, h('div.deck-pages', panel, sheet));
  const safeProbe = h('div.safe-probe');

  const clip = h('div.card-clip',
    h('div.stage', canvas),
    h('div.tint'),
    // Only the Windows widget shows it: the strip its frameless window is dragged by.
    h('header.top'),
    safeProbe, tooltip, deckEl, themeHint, toastEl);
  // Built under an open editor: already in its editing shape, so nothing animates into it.
  const card = h(`div.card.booting${editing ? '.editing.faded' : ''}${grown ? '.grow' : ''}`, h('div.notch'), clip);
  // Appended: while the plan is swapped, the new card fades in over the old one.
  root.append(card);

  /* ---------- the card as a sheet ---------- */

  const deck = createDeck({
    el: deckEl,
    scrollers: '.devices, .sheet-scroll',
    handles: '.deck-grab',
    canDrag: () => !reorder.busy && !sceneReorder.busy && !card.classList.contains('editing'),
    onGrab: () => { reorder.cancel(); sceneReorder.cancel(); hideTooltip(); },
    onProgress: (p) => world?.setSheetProgress(p),
    onDetent: (d) => {
      if (!ui.sheet) homeDetent = d;
      grabber.setAttribute('aria-label', d === 'expanded' ? 'Show the home' : 'Show more controls');
    },
    // The 3D view's frame loop moves the card, so both move in the same frame.
    ticker: () => (world?.running ? (world.wake(), true) : false),
  });

  // Where the card rests (the panel started there before it became a sheet) and where it
  // stops pulled up: about an inch below the top on a phone, past its status bar and island.
  const metrics = { rest: 400, expanded: 150, safeTop: 0, height: 800 };
  function measure() {
    const height = clip.clientHeight;
    if (!height) return;
    const safeTop = isPhone ? safeProbe.offsetHeight : 0;
    const rest = Math.round(Math.min(isPhone ? 470 : 408, height * 0.52) - 34);
    const expanded = Math.min(rest, isPhone ? safeTop + 92 : 96);
    if (rest === metrics.rest && expanded === metrics.expanded && height === metrics.height && safeTop === metrics.safeTop) return;
    Object.assign(metrics, { rest, expanded, safeTop, height });
    card.style.setProperty('--rest-top', `${rest}px`);
    card.style.setProperty('--exp-top', `${expanded}px`);
    deck.layout(metrics);
    onLayout?.({ ...metrics });
  }
  const layoutRO = new ResizeObserver(measure);
  layoutRO.observe(clip);

  /* ---------- scenes ---------- */

  // A tap sets the scene; held, a scene can be edited or deleted. The + chip at the end makes
  // a new one from the lights as they are (ui.sheet { kind: 'scene' }, sceneSheet).
  const sceneButtons = new Map();
  const sceneReorder = createReorder({
    grid: sceneTrack, scroller: scenes, selector: '.scene[data-key]', axis: 'x', hold: 450,
    announce: (text) => { said.textContent = text; },
    onOrder: (keys) => {
      const byID = new Map(config.scenes.map((s) => [s.id, s]));
      commitScenes(keys.map((id) => byID.get(id)).filter(Boolean));
    },
  });
  const addScene = h('button.scene.scene-add', { title: 'New scene', 'aria-label': 'New scene', onclick: () => { haptic('light'); openSheet({ kind: 'scene', id: null }); } },
    icon('plus', 19, 2.2), h('span.scene-name', 'New'));

  function sceneChip(s) {
    const b = h('button.scene', { title: s.name, 'aria-label': s.name, 'data-key': s.id,
      'aria-keyshortcuts': 'Shift+F10 Alt+ArrowLeft Alt+ArrowRight' }, icon(s.icon, 19), h('span.scene-name', s.name));
    b.addEventListener('pointerdown', (ev) => { lastPointer = ev.pointerType; });
    sceneReorder.attach(b, { onHold: () => sceneMenu(s, b) });
    b.addEventListener('click', () => {
      if (sceneReorder.lifted(b)) return;
      haptic('medium');
      store.applyScene(s.id);
    });
    b.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      if (lastPointer === 'mouse' && !sceneReorder.busy) sceneMenu(s, b);
    });
    b.addEventListener('keydown', (ev) => {
      if (ev.key === 'ContextMenu' || (ev.shiftKey && ev.key === 'F10')) { ev.preventDefault(); sceneMenu(s, b); }
    });
    return b;
  }

  function sceneMenu(s, b) {
    haptic('medium');
    b.classList.add('menu-open');
    openMenu(clip, b, [
      { label: 'Edit', icon: icon('pencil', 16, 2), action: () => openSheet({ kind: 'scene', id: s.id }) },
      { label: `Delete “${s.name}”`, icon: icon('trash', 16, 2), action: () => deleteScene(s.id) },
    ], { onClose: () => b.classList.remove('menu-open') });
  }

  function renderScenes() {
    sceneReorder.cancel();
    sceneButtons.clear();
    const chips = config.scenes.map((s) => {
      const b = sceneChip(s);
      sceneButtons.set(s.id, b);
      return b;
    });
    sceneTrack.replaceChildren(...chips, addScene);
  }
  renderScenes();

  // The plan's form of a scene: `acs` only when it sets an AC.
  const planScene = (s) => {
    const out = { id: s.id, name: s.name, icon: s.icon, lights: s.lights };
    if (s.acs && Object.keys(s.acs).length) out.acs = s.acs;
    if (s.tvs && Object.keys(s.tvs).length) out.tvs = s.tvs;
    if (s.spotify) out.spotify = s.spotify;
    return out;
  };

  // The scenes changed here: shown at once, then kept by the caller (the plan's `scenes`).
  function commitScenes(list) {
    config.scenes.splice(0, config.scenes.length, ...list);
    renderScenes();
    update();
    onScenes?.(config.scenes.map(planScene));
  }

  function deleteScene(id) {
    const s = config.scenes.find((x) => x.id === id);
    if (!s) return;
    haptic('medium');
    commitScenes(config.scenes.filter((x) => x.id !== id));
    if (state.scene === id) store.markScene(null);
    toast(`Deleted “${s.name}”`, null, { note: true });
  }

  // Scenes that came from elsewhere (another screen saved them).
  function setScenes(list) {
    config.scenes.splice(0, config.scenes.length, ...normalizeScenes(Array.isArray(list) ? list : []));
    renderScenes();
    if (ui.sheet?.kind === 'scene' && ui.sheet.id && !config.scenes.some((x) => x.id === ui.sheet.id)) closeSheet();
    update();
  }

  // Every lamp as it is now, in a scene's form; an off lamp is just off.
  function captureLights() {
    const out = {};
    for (const cfg of config.lights) {
      const s = state.lights[cfg.id];
      if (!s.on) { out[cfg.id] = { on: false }; continue; }
      const caps = cfg.capabilities;
      const l = { on: true };
      if (caps.includes('brightness')) l.brightness = Math.round(s.brightness * 100) / 100;
      if (caps.includes('color') && s.color) l.color = s.color;
      else if (caps.includes('temp')) l.temp = s.temp;
      out[cfg.id] = l;
    }
    return out;
  }

  function captureAcs() {
    return Object.fromEntries(config.acs.map((a) => {
      const s = state.acs[a.id];
      return [a.id, { on: s.on, mode: s.mode, target: s.target, fan: s.fan }];
    }));
  }

  // "custom-movie-night-3fa1": the name, and four random hex digits.
  function newSceneId(name) {
    const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '') || 'scene';
    for (;;) {
      const hex = [...crypto.getRandomValues(new Uint8Array(2))].map((n) => n.toString(16).padStart(2, '0')).join('');
      const id = `custom-${slug}-${hex}`;
      if (!config.scenes.some((x) => x.id === id)) return id;
    }
  }

  /* ---------- rooms ---------- */

  const roomButtons = new Map();
  for (const r of [{ id: 'all', name: 'All' }, ...config.rooms]) {
    const count = h('span.count.zero', { 'aria-hidden': 'true' }, '0');
    const b = h('button.room', { onclick: () => { haptic('tick'); selectRoom(r.id); } }, r.name, count);
    roomButtons.set(r.id, { b, count });
    rooms.append(b);
  }

  // The chips follow the rooms' order (it can be changed: see arrangeRooms).
  function orderChips() {
    rooms.replaceChildren(...['all', ...config.rooms.map((r) => r.id)].map((id) => roomButtons.get(id).b));
  }

  function selectRoom(id) {
    if (arranging) arrangeRooms(false);
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
  // Long press a tile and drag it to another place in its room (reorder.js).
  // Held a little longer than a room's heading: a finger that rests before it slides still dims.
  const reorder = createReorder({
    grid,
    scroller: grid.parentElement,
    hold: 450,
    announce: (text) => { said.textContent = text; },
    onOrder: (keys) => {
      order = reordered(keys);
      onOrder?.(order.slice());
    },
  });
  // A tile's name in `tileOrder`: a lamp's or an AC's id, "tv:<id>" for a TV.
  const keyOf = (t) => (t.kind === 'tv' ? `tv:${t.cfg.id}` : t.cfg.id);
  function draggable(t, opts) {
    t.el.dataset.key = keyOf(t);
    t.el.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
    reorder.attach(t.el, opts);
    return t;
  }

  // A tile under a finger or the mouse: a tap switches it, a slide sideways sets its level
  // (a lamp's brightness, an AC's temperature), and held still it lifts (reorder.js): let go
  // where it was, the device's page opens; dragged, the tile moves. Which it is, is decided
  // after AXIS px: sideways is a slide; up or down belongs to the list and the card (deck.js)
  // and is neither a tap nor a slide. A press on a button in the tile is that button's.
  function gestures(el, { tap, open = null, slide = null }) {
    let g = null; // { id, x, y, mode: null | 'slide' | 'away' }
    el.addEventListener('pointerdown', (ev) => {
      lastPointer = ev.pointerType;
      if (g || ev.button !== 0 || !ev.isPrimary || ev.target.closest('button')) return;
      try { el.setPointerCapture(ev.pointerId); } catch { /* gone already */ }
      g = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, mode: null };
      el.classList.add('pressed');
    });
    el.addEventListener('pointermove', (ev) => {
      if (!g || ev.pointerId !== g.id || reorder.lifted(el)) return;
      if (!g.mode) {
        const dx = ev.clientX - g.x;
        const dy = ev.clientY - g.y;
        if (Math.hypot(dx, dy) < AXIS) return;
        g.mode = slide && Math.abs(dx) > Math.abs(dy) ? 'slide' : 'away';
        el.classList.remove('pressed');
        if (g.mode !== 'slide') return;
        // From here, so the level does not jump by the few px it took to tell.
        g.x = ev.clientX;
        slide.begin();
        el.classList.add('sliding');
      }
      if (g.mode === 'slide') slide.move(ev.clientX - g.x);
    });
    const finish = (ev) => {
      if (!g || ev.pointerId !== g.id) return;
      const d = g;
      g = null;
      el.classList.remove('pressed', 'sliding');
      if (d.mode === 'slide') { slide.end(); return; }
      // Lifted, it was a hold (reorder.js opens the page or moves the tile), never a tap.
      if (ev.type === 'pointerup' && !d.mode && !reorder.lifted(el)) tap();
    };
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', finish);
    // The card took the finger (it is being pulled up or down): not a tap.
    el.addEventListener('lostpointercapture', finish);
    // While sliding, a finger moves the level, not the page.
    el.addEventListener('touchmove', (ev) => { if (g?.mode === 'slide' && ev.cancelable) ev.preventDefault(); }, { passive: false });
    // A right click opens the page too (a touch and hold is the reorder's).
    el.addEventListener('contextmenu', (ev) => {
      if (lastPointer !== 'mouse' || !open) return;
      ev.preventDefault();
      open();
    });
    // Space switches, Enter opens the page, ← and → step the level (Alt + arrows move the tile).
    el.addEventListener('keydown', (ev) => {
      if (ev.altKey || ev.metaKey || ev.ctrlKey || ev.target !== el) return;
      if (ev.key === ' ' || (ev.key === 'Enter' && !open)) { ev.preventDefault(); tap(); }
      else if (ev.key === 'Enter') { ev.preventDefault(); open(); }
      else if (slide?.step && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) { ev.preventDefault(); slide.step(ev.key === 'ArrowRight' ? 1 : -1); }
    });
    return { get busy() { return Boolean(g?.mode); } };
  }

  // A slide's level shown on the tile: a fill from the left, and the value in big type.
  function showLevel(el, readout, fraction, text) {
    el.style.setProperty('--fill', String(clamp(fraction, 0, 1)));
    readout.textContent = text;
  }

  // Sliding across the whole tile goes from off to full; a tick every 5 %. Under 5 % is off.
  // The store gets at most one change a frame (and sends the lamp fewer still: store.js).
  function lampSlide(cfg, el, readout) {
    let start = 0;
    let value = 0;
    let step = 0;
    let raf = 0;
    const patch = () => (value < 0.05 ? { on: false } : { on: true, brightness: value });
    const apply = () => { raf = 0; store.setLight(cfg.id, patch()); };
    const show = () => showLevel(el, readout, value, value < 0.05 ? 'Off' : `${Math.round(value * 100)}%`);
    return {
      begin() {
        const s = state.lights[cfg.id];
        start = value = s.on ? s.brightness : 0;
        step = Math.round(value * 20);
        show();
      },
      move(dx) {
        value = clamp(start + dx / el.clientWidth, 0, 1);
        const at = Math.round(value * 20);
        if (at !== step) { step = at; haptic('tick'); }
        show();
        if (!raf) raf = requestAnimationFrame(apply);
      },
      end() { if (raf) { cancelAnimationFrame(raf); apply(); } },
      step(dir) {
        const s = state.lights[cfg.id];
        const next = Math.round(((s.on ? s.brightness : 0) + dir * 0.1) * 10) / 10;
        haptic('tick');
        store.setLight(cfg.id, next < 0.05 ? { on: false } : { on: true, brightness: Math.min(1, next) });
      },
    };
  }

  // A degree for every 24 px; a tick at each. Sliding a sleeping AC wakes it.
  function acSlide(cfg, el, readout) {
    let start = 0;
    let value = 0;
    let raf = 0;
    const apply = () => { raf = 0; store.setAC(cfg.id, { on: true, target: value }); };
    const show = () => showLevel(el, readout, (value - cfg.min) / (cfg.max - cfg.min), `${value}°`);
    return {
      begin() { start = value = state.acs[cfg.id].target; show(); },
      move(dx) {
        const next = clamp(start + Math.round(dx / 24), cfg.min, cfg.max);
        if (next === value) return;
        value = next;
        haptic('tick');
        show();
        if (!raf) raf = requestAnimationFrame(apply);
      },
      end() { if (raf) { cancelAnimationFrame(raf); apply(); } },
      step(dir) { haptic('tick'); store.setAC(cfg.id, { on: true, target: state.acs[cfg.id].target + dir }); },
    };
  }

  function lightTile(cfg) {
    const dimmable = cfg.capabilities.includes('brightness');
    const hasSheet = cfg.capabilities.length > 0;
    const sub = h('div.tile-sub');
    const readout = h('div.tile-readout', { 'aria-hidden': 'true' });
    const open = hasSheet ? () => openSheet({ kind: 'light', id: cfg.id }) : null;
    // A phone has no room for the button (nor a pointer to show it): holding the tile opens the sheet.
    const more = hasSheet && !isPhone
      ? h('button.tile-more', { 'aria-label': `${cfg.name} settings`, onclick: (e) => { e.stopPropagation(); open(); } }, icon('sliders', 15))
      : null;
    const el = h(`div.tile.light${dimmable ? '.dimmable' : ''}`, { role: 'button', tabindex: 0, 'aria-label': cfg.name },
      h('div.tile-fill'),
      h('div.bubble', icon(cfg.capabilities.length ? cfg.type : 'plug', 19)),
      h('div.tile-text', h('div.tile-name', cfg.name), sub),
      more, readout,
      h('div.tile-level'));
    const touch = gestures(el, { tap: () => toggleLight(cfg.id), open, slide: dimmable ? lampSlide(cfg, el, readout) : null });

    return draggable({
      el, cfg, kind: 'light',
      update() {
        const s = state.lights[cfg.id];
        el.classList.toggle('on', s.on);
        el.style.setProperty('--c', css(lightColor(s, tmp)));
        el.style.setProperty('--level', s.on ? String(s.brightness) : '0');
        // On a phone the group heading above the tile already names the room.
        sub.textContent = ui.room === 'all' && !isPhone ? `${lightStatus(cfg, s)} · ${roomName.get(cfg.room)}` : lightStatus(cfg, s);
      },
    }, {
      canLift: () => !touch.busy, // being dimmed
      onHold: open,
    });
  }

  function acTile(cfg) {
    const sub = h('div.tile-sub');
    const value = h('div.value');
    const bubble = h('div.bubble');
    const readout = h('div.tile-readout', { 'aria-hidden': 'true' });
    const open = () => openSheet({ kind: 'ac', id: cfg.id });
    const step = (d) => (e) => {
      e.stopPropagation();
      haptic('tick');
      const s = state.acs[cfg.id];
      store.setAC(cfg.id, { on: true, target: s.target + d });
    };
    const power = () => { haptic('medium'); store.setAC(cfg.id, { on: !state.acs[cfg.id].on }); };
    const el = h('div.tile.ac', { role: 'button', tabindex: 0, 'aria-label': cfg.name },
      h('div.tile-fill'),
      bubble,
      h('div.tile-text', h('div.tile-name', cfg.name), sub),
      h('div.stepper',
        h('button', { 'aria-label': 'Cooler', onclick: step(-1) }, icon('minus', 15, 2.2)),
        value,
        h('button', { 'aria-label': 'Warmer', onclick: step(1) }, icon('plus', 15, 2.2))),
      h('button.mini-power', { 'aria-label': `${cfg.name} power`, onclick: (e) => { e.stopPropagation(); power(); } }, icon('power', 16, 2.2)),
      readout);
    const touch = gestures(el, { tap: open, open, slide: acSlide(cfg, el, readout) });
    let shownMode = null;
    return draggable({
      el, cfg, kind: 'ac',
      update() {
        const s = state.acs[cfg.id];
        el.classList.toggle('on', s.on);
        el.style.setProperty('--c', MODE_COLORS[s.mode]);
        if (shownMode !== s.mode) { bubble.replaceChildren(icon(s.mode, 19)); shownMode = s.mode; }
        value.textContent = `${s.target}°`;
        sub.textContent = `${s.on ? MODE_LABEL[s.mode] : 'Off'} · Room ${s.roomTemp.toFixed(isPhone ? 0 : 1)}°`;
      },
    }, { canLift: () => !touch.busy, onHold: open });
  }

  for (const cfg of config.acs) tiles.set(cfg.id, acTile(cfg));
  for (const cfg of config.lights) tiles.set(cfg.id, lightTile(cfg));
  for (const item of config.furniture.filter((f) => f.type === 'speaker')) {
    const id = item.device || 'spotify';
    const key = `speaker:${id}`;
    if (tiles.has(key)) continue;
    const open = () => openSheet({ kind: 'speaker', id });
    const sub = h('div.tile-sub', 'Spotify');
    const el = h('div.tile.speaker', { role: 'button', tabindex: 0, 'aria-label': item.name || 'Studio speaker' },
      h('div.bubble', icon('speaker', 20)), h('div.tile-text', h('div.tile-name', item.name || 'Speaker'), sub),
      icon('next', 17));
    gestures(el, { tap: open, open });
    tiles.set(key, draggable({ el, kind: 'speaker', cfg: { id: key, room: roomAt(item.pos) || config.rooms[0].id }, update() {
      el.classList.toggle('on', Boolean(spotify.state.playing));
      el.style.setProperty('--c', '#85d7b3');
      sub.textContent = spotify.state.track?.title || (spotify.state.available ? 'Spotify · Ready' : 'Spotify');
    } }, { onHold: open }));
  }

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
    const open = () => openSheet({ kind: 'tv', id: t.id });
    const readout = h('div.tile-readout', { 'aria-hidden': 'true' });
    const el = h('div.tile.tv', { role: 'button', tabindex: 0 },
      h('div.tile-fill'), bubble, h('div.tile-text', name, sub), powerBtn, readout, h('div.tile-level'));
    let start, value, max, pending = null, sending = false;
    async function sendVolume() {
      if (sending) return;
      sending = true;
      try {
        while (pending !== null) {
          const level = pending; pending = null;
          await tv.act(t.id, { action: 'volume', level });
        }
      } finally { sending = false; }
    }
    const slide = {
      begin() { const d = tvDevice(t.id); max = d?.volumeMax ?? 100; start = value = d?.volume; },
      move(dx) {
        if (!tvDevice(t.id)?.on || !Number.isFinite(start)) return;
        const next = clamp(Math.round(start + dx / Math.max(40, el.clientWidth) * max), 0, max);
        if (next === value) return;
        value = next; haptic('tick');
        showLevel(el, readout, value / max, `${Math.round(value / max * 100)}%`);
        pending = value; sendVolume();
      },
      end() {},
      step(dir) { if (tvDevice(t.id)?.on) tv.act(t.id, { action: dir > 0 ? 'volup' : 'voldown' }); },
    };
    const touch = gestures(el, { tap: open, open, slide });
    let shownApp;
    return draggable({
      el, cfg: { id: t.id, room: t.room }, kind: 'tv',
      update() {
        const d = tvDevice(t.id);
        const on = Boolean(d?.on);
        el.classList.toggle('on', on);
        el.style.setProperty('--level', String((d?.volume ?? 0) / (d?.volumeMax || 100)));
        el.style.setProperty('--c', on ? glowOf(d.app) : 'var(--warm)');
        name.textContent = tvName(t.id);
        el.setAttribute('aria-label', tvName(t.id));
        // Playing something: "YouTube · Bretz in the Scablands".
        const title = on ? d.nowPlaying?.title : null;
        sub.textContent = title ? `${tvStatus(t.id)} · ${title}` : tvStatus(t.id);
        const app = on && d.app && d.app.id !== 'other' ? d.app.id : null;
        if (shownApp !== app) {
          bubble.replaceChildren(app ? logoSVG(d.app, 42) : icon('tv', 19));
          bubble.classList.toggle('logo', Boolean(app));
          shownApp = app;
        }
        powerBtn.disabled = !tv.state.available;
      },
    }, { canLift: () => !touch.busy, onHold: open });
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

  // A room's tiles: first those in `order`, as they were dragged; the others after them,
  // as the plan has them (its ACs, its TV, then its lamps).
  function roomTiles(roomId) {
    const devices = [...tiles.values(), ...tvTiles.values()].filter((t) => t.cfg.room === roomId);
    const plain = ['ac', 'tv', 'speaker', 'light'].flatMap((kind) => devices.filter((t) => t.kind === kind));
    const rank = new Map(order.map((k, i) => [k, i]));
    return plain.map((t, i) => ({ t, i, r: rank.get(keyOf(t)) ?? Infinity }))
      .sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.t);
  }

  // The whole order after one room's group was rearranged into `keys`. A tile that isn't
  // shown just now (a TV that is away) keeps its place after the tile it followed.
  function reordered(keys) {
    const moved = new Set(keys);
    let i = 0;
    const next = config.rooms.flatMap((r) => roomTiles(r.id).map(keyOf)).map((k) => (moved.has(k) ? keys[i++] : k));
    order.forEach((k, at) => {
      if (next.includes(k)) return;
      const before = order.slice(0, at).reverse().find((p) => next.includes(p));
      next.splice(before ? next.indexOf(before) + 1 : 0, 0, k);
    });
    return next;
  }

  /* ---------- rooms in the list: folded away, and put in order ---------- */

  // Rooms folded to their heading, on this screen (another screen keeps its own).
  const FOLD_KEY = `house.folded:${config.name}`;
  const folded = new Set((() => { try { return JSON.parse(localStorage.getItem(FOLD_KEY)) || []; } catch { return []; } })());
  const heads = new Map();
  let arranging = false;

  // A room's heading in the whole-home list: its name, what is on in it while it is folded,
  // and a chevron. A click folds or unfolds it; held still, it starts putting rooms in order.
  function roomHead(room) {
    const sum = h('span.room-sum');
    const el = h('div.group-label.room-head', { role: 'button', tabindex: 0, 'aria-expanded': 'true' },
      h('span.room-head-name', room.name), sum, h('span.room-chevron', icon('down', 14, 2.4)));
    let press = null;
    el.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || arranging) return;
      press = { x: ev.clientX, y: ev.clientY, top: grid.parentElement.scrollTop,
        timer: setTimeout(() => { press = null; el.classList.remove('pressed'); arrangeRooms(true); }, 420) };
      el.classList.add('pressed');
    });
    const let_go = () => { if (press) clearTimeout(press.timer); press = null; el.classList.remove('pressed'); };
    el.addEventListener('pointermove', (ev) => { if (press && Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > 8) let_go(); });
    el.addEventListener('pointerup', () => {
      const tapped = press && Math.abs(grid.parentElement.scrollTop - press.top) < 3;
      let_go();
      if (tapped) fold(room.id);
    });
    el.addEventListener('pointercancel', let_go);
    el.addEventListener('pointerleave', (ev) => { if (ev.pointerType === 'mouse') let_go(); });
    el.addEventListener('contextmenu', (ev) => ev.preventDefault());
    el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); fold(room.id); } });
    const head = { el, update() {
      const shut = folded.has(room.id);
      el.classList.toggle('folded', shut);
      el.setAttribute('aria-expanded', String(!shut));
      const lights = config.lights.filter((l) => l.room === room.id);
      const on = lights.filter((l) => state.lights[l.id].on).length;
      const devices = roomTiles(room.id).length;
      sum.textContent = shut ? (on ? `${on} on` : `${devices} ${devices === 1 ? 'device' : 'devices'}`) : '';
    } };
    heads.set(room.id, head);
    return head;
  }

  function fold(id) {
    haptic('light');
    if (folded.has(id)) folded.delete(id); else folded.add(id);
    try { localStorage.setItem(FOLD_KEY, JSON.stringify([...folded])); } catch { /* private browsing */ }
    const shown = [...grid.children].filter((c) => !c.classList.contains('grid-hint'));
    flip(shown, () => layoutTiles({ still: true }));
    for (const t of grid.querySelectorAll('.tile')) {
      if (!shown.includes(t)) t.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 240, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
    heads.get(id)?.update();
  }

  // Putting rooms in order: the list becomes one row per room, held and dragged like tiles.
  const roomRows = new Map();
  const roomSort = createReorder({
    grid, scroller: grid.parentElement, hold: 90,
    announce: (text) => { said.textContent = text; },
    onOrder: (ids) => {
      const rank = new Map(ids.map((id, i) => [id, i]));
      config.rooms.sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
      orderChips();
      onRoomOrder?.(config.rooms.map((r) => r.id));
    },
  });
  function roomRow(room) {
    if (roomRows.has(room.id)) return roomRows.get(room.id);
    const el = h('div.tile.room-row', { tabindex: 0, 'aria-label': room.name, 'data-key': room.id, 'aria-keyshortcuts': 'Alt+ArrowUp Alt+ArrowDown' },
      h('span.room-grip', icon('grip', 18, 2)), h('div.tile-name', room.name));
    roomSort.attach(el);
    roomRows.set(room.id, el);
    return el;
  }

  function arrangeRooms(on) {
    if (on === arranging) return;
    if (on && ui.room !== 'all') { ui.room = 'all'; update(); }
    arranging = on;
    haptic(on ? 'medium' : 'light');
    card.classList.toggle('arranging', on);
    const shown = [...grid.children];
    flip(shown.filter((c) => c.classList.contains('group-label') || c.classList.contains('room-row')), () => layoutTiles({ still: true }));
    if (on) said.textContent = 'Drag the rooms into the order you want, then Done';
  }
  window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && arranging && !roomSort.busy) arrangeRooms(false); });

  /** `still`: the same tiles in a new order, sliding there (no entrance, scroll kept). */
  function layoutTiles({ still = false } = {}) {
    reorder.cancel();
    roomSort.cancel();
    const nodes = [];
    let i = 0;
    const add = (t) => { t.el.style.setProperty('--i', i++); nodes.push(t.el); };
    if (arranging) {
      for (const room of config.rooms) {
        const row = roomRow(room);
        row.style.setProperty('--i', i++);
        nodes.push(row);
      }
      nodes.push(h('div.grid-hint', 'Hold and drag a room to move it'));
      grid.classList.toggle('still', still);
      grid.replaceChildren(...nodes);
      return;
    }
    for (const room of config.rooms) {
      if (ui.room !== 'all' && room.id !== ui.room) continue;
      const devices = roomTiles(room.id);
      if (!devices.length) continue;
      if (ui.room === 'all') {
        const head = heads.get(room.id) || roomHead(room);
        head.update();
        nodes.push(head.el);
        if (folded.has(room.id)) continue;
      }
      devices.forEach(add);
    }
    if (!nodes.length) nodes.push(h('div.group-label', 'No devices in this room yet'));
    else if (isPhone && config.lights.some((l) => l.capabilities.length && inScope(l))) {
      nodes.push(h('div.grid-hint', 'Tap lights to switch; tap AC, TV or speaker for controls. Slide to dim, set temperature or volume. Hold and drag devices or presets to reorder; hold a preset to edit or delete.'));
    }
    grid.classList.toggle('still', still);
    grid.replaceChildren(...nodes);
    if (!still) grid.parentElement.scrollTop = 0;
  }

  // An order that came from elsewhere (another screen saved it): the tiles slide into it.
  function setOrder(next) {
    next = Array.isArray(next) ? next.filter((k) => typeof k === 'string') : [];
    if (next.join('\n') === order.join('\n')) return;
    order = next;
    const shown = [...grid.querySelectorAll('.tile')];
    flip(shown, () => layoutTiles({ still: true }));
  }

  /* ---------- sheets ---------- */

  let sheetView = null;

  // A device's sheet takes the card's place. The TV's remote opens pulled up, its screen in
  // the strip above; a light's or an AC's opens at rest, under its room or the AC in the
  // model. Back returns the card to where it was on the home page.
  function openSheet(target, { detent } = {}) {
    const from = ui.sheet;
    sheetView?.dispose?.();
    ui.sheet = target;
    sheetView = { ac: acSheet, tv: tvSheet, scene: sceneSheet, speaker: speakerSheet }[target.kind]?.(target.id) || lightSheet(target.id);
    sheet.replaceChildren(...sheetView.nodes);
    sheet.classList.toggle('tv', target.kind === 'tv');
    panel.classList.add('hidden');
    sheet.classList.remove('hidden');
    panel.inert = true;
    sheet.inert = false;
    card.classList.add('detail');
    hideTooltip();
    if (target.kind === 'speaker') {
      const item = config.furniture.find((f) => f.type === 'speaker' && (f.device || 'spotify') === target.id);
      onFocus({ kind: 'room', id: roomAt(item?.pos) || config.rooms[0].id });
    }
    else if (target.kind === 'scene') onFocus(ui.room === 'all' ? null : { kind: 'room', id: ui.room });
    else onFocus(target.kind === 'ac' || target.kind === 'tv' ? target : { kind: 'room', id: store.lightCfg.get(target.id).room });
    if (!from) homeDetent = deck.detent;
    // The TV's remote and a scene's name and icons want the room; a lamp or the AC sits under its model.
    deck.set(detent || (['tv', 'scene', 'speaker'].includes(target.kind) ? 'expanded' : 'rest'));
    sheetView.opened?.();
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
    deck.set(homeDetent);
    update();
    return true;
  }

  function sheetHead(name, sub, powerBtn) {
    return h('div.sheet-head.deck-grab',
      h('button.round', { 'aria-label': 'Back', onclick: closeSheet }, icon('back', 19, 2.2)),
      h('div.sheet-title', h('div.sheet-name', name), sub),
      powerBtn);
  }

  function speakerSheet() {
    const remote = createSpotifyRemote();
    return { nodes: [sheetHead('Spotify', h('div.sheet-sub', 'Studio speaker')), remote.el], dispose: remote.stop };
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
        h('div.sheet-scroll',
          h('div.readout', big.el, eco),
          h('div.slider-row',
            h('button.round', { 'aria-label': 'Cooler', onclick: () => { haptic('tick'); set({ on: true, target: s().target - 1 }); } }, icon('minus', 18, 2.2)),
            slider.el,
            h('button.round', { 'aria-label': 'Warmer', onclick: () => { haptic('tick'); set({ on: true, target: s().target + 1 }); } }, icon('plus', 18, 2.2))),
          options),
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
          h(`span.live${a.on ? '' : '.idle'}`, { style: a.on ? { background: MODE_COLORS[a.mode], boxShadow: `0 0 8px ${MODE_COLORS[a.mode]}` } : {} }));
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
    const body = [h('div.readout', big.el)];
    const sliders = {};

    if (caps.includes('brightness')) {
      sliders.brightness = createSlider({
        min: 5, max: 100, value: Math.round(s().brightness * 100), gradient: DIM_GRADIENT, detent: 5,
        onInput: (v) => set({ on: true, brightness: v / 100 }),
      });
      body.push(h('div.slider-row',
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
      body.push(h('div.field-label', h('span', 'Colour temperature'), kelvinLabel), h('div.slider-row', sliders.temp.el));
    }
    let swatches = [];
    let pad = null;
    let colorLabel = null;
    if (caps.includes('color')) {
      colorLabel = h('span');
      pad = createColorPad({ value: s().color, onInput: (c) => set({ on: true, color: c }) });
      swatches = SWATCHES.map((c) => h('button.swatch', { 'aria-label': `Colour ${c}`, vars: { '--sw': c }, onclick: () => { haptic('light'); set({ on: true, color: c }); } }));
      body.push(h('div.field-label', h('span', 'Colour'), colorLabel), pad.el, h('div.swatches', swatches));
    } else {
      body.push(h('div.sheet-note', icon(cfg.type, 20),
        `${roomName.get(cfg.room)} · drag across a light tile to dim it, or ${isPhone ? 'tap' : 'click'} the lamp in the 3D view to toggle.`));
    }

    return {
      nodes: [sheetHead(cfg.name, sub, powerBtn), h('div.sheet-scroll', body)],
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

  // Makes a scene of the lights as they are now (`id` null), or edits one: its name, its
  // icon, whether it sets the AC too, and (editing) whether to take the lights as they are now.
  function sceneSheet(id) {
    const existing = id ? config.scenes.find((x) => x.id === id) : null;
    const hadAC = Boolean(existing && Object.keys(existing.acs || {}).length);
    let iconName = existing?.icon || 'sparkles';
    let withAC = hadAC;
    let retake = !existing;
    const tvActions = structuredClone(existing?.tvs || {});
    const tvIDs = [...new Set([...linkedTvs().map((t) => t.id), ...Object.keys(tvActions)])];
    const tvOptions = tvIDs.map((deviceID) => {
      const selected = tvActions[deviceID]?.app || '';
      const apps = APPS.slice();
      if (selected && !apps.some((a) => a.id === selected)) apps.push({ id: selected, name: tvActions[deviceID].name || selected });
      const select = h('select.scene-input', { 'aria-label': `${tvName(deviceID)} app` },
        h('option', { value: '' }, 'Leave TV unchanged'),
        apps.map((app) => h('option', { value: app.id }, app.name)));
      select.value = selected;
      select.addEventListener('change', () => {
        const app = apps.find((a) => a.id === select.value);
        if (app) tvActions[deviceID] = { app: app.id, name: app.name };
        else delete tvActions[deviceID];
        sync();
      });
      return h('div.scene-tv-choice', h('label', tvName(deviceID)), select);
    });
    // A playlist to start, and the speaker to start it on: from the account, once Spotify answers.
    let music = existing?.spotify ? { ...existing.spotify } : null;
    const playlistSelect = h('select.scene-input', { 'aria-label': 'Spotify playlist' });
    const speakerSelect = h('select.scene-input', { 'aria-label': 'Spotify speaker' });
    const musicNote = h('div.sheet-note.scene-music-note');
    const musicBox = h('div.scene-tv-actions.scene-music', { hidden: true },
      h('div.field-label', 'Spotify'),
      h('div.scene-tv-choice', h('label', 'Playlist'), playlistSelect),
      h('div.scene-tv-choice', h('label', 'Speaker'), speakerSelect), musicNote);
    const fillMusic = (items, devices) => {
      const lists = items.slice();
      if (music && !lists.some((p) => p.uri === music.uri)) lists.unshift({ uri: music.uri, name: music.name });
      playlistSelect.replaceChildren(h('option', { value: '' }, 'No music'), ...lists.map((p) => h('option', { value: p.uri }, p.name)));
      playlistSelect.value = music?.uri || '';
      const outs = devices.filter((d) => d.id && !d.restricted).map((d) => ({ id: d.id, name: d.name }));
      if (music?.deviceName && !outs.some((d) => d.id === music.device || d.name === music.deviceName)) outs.push({ id: music.device || '', name: music.deviceName });
      speakerSelect.replaceChildren(h('option', { value: '' }, 'Whatever is playing now'), ...outs.map((d) => h('option', { value: d.name }, d.name)));
      speakerSelect.value = music?.deviceName || '';
      speakerSelect.disabled = !music;
      musicBox.hidden = false;
      const pick = () => {
        const list = lists.find((p) => p.uri === playlistSelect.value);
        const out = outs.find((d) => d.name === speakerSelect.value);
        music = list ? { uri: list.uri, name: list.name, ...(out ? { ...(out.id ? { device: out.id } : {}), deviceName: out.name } : {}) } : null;
        speakerSelect.disabled = !music;
        sync();
      };
      playlistSelect.onchange = pick;
      speakerSelect.onchange = pick;
    };
    (async () => {
      try {
        const [page, now] = await Promise.all([spotify.playlists(0), spotify.refresh().then(() => spotify.state)]);
        if (page.available === false || !now?.canTransfer) {
          if (music) { fillMusic([], []); musicNote.textContent = 'Connect Spotify to change this.'; }
          return;
        }
        let items = page.items || [];
        for (let next = page.next; next != null && items.length < 200;) {
          const more = await spotify.playlists(next);
          items = items.concat(more.items || []);
          next = more.next;
        }
        fillMusic(items, now.devices || []);
        musicNote.textContent = 'The speaker has to be on and show up in Spotify when the scene runs.';
      } catch {
        if (music) { fillMusic([], []); musicNote.textContent = 'Spotify cannot be reached right now.'; }
      }
    })();
    const name = h('input.scene-input', {
      type: 'text', value: existing?.name || '', placeholder: 'Movie night, Reading, Dinner…', maxlength: 32,
      autocomplete: 'off', autocapitalize: 'words', enterkeyhint: 'done', spellcheck: false, 'aria-label': 'Scene name',
    });
    name.addEventListener('input', () => name.classList.remove('invalid'));
    name.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); save(); } });
    const iconButtons = SCENE_ICONS.map((n) => h('button.scene-icon', {
      'aria-label': SCENE_ICON_NAMES[n] || n, title: SCENE_ICON_NAMES[n] || n,
      onclick: () => { haptic('tick'); iconName = n; sync(); },
    }, icon(n, 21)));
    const acChip = config.acs.length
      ? h('button.toggle-chip.scene-toggle', { onclick: () => { haptic('light'); withAC = !withAC; sync(); } }, icon('ac', 17), h('span.grow', 'Include AC'), h('span.switch'))
      : null;
    const retakeChip = existing
      ? h('button.toggle-chip.scene-toggle', { onclick: () => { haptic('light'); retake = !retake; sync(); } }, icon('refresh', 17), h('span.grow', 'Update to current lights'), h('span.switch'))
      : null;
    const what = h('div.sheet-note.scene-what');
    const saveBtn = h('button.pill.scene-save', { onclick: () => save() }, 'Save');
    const del = existing
      ? h('button.scene-delete', { onclick: () => { closeSheet(); deleteScene(id); } }, icon('trash', 16, 2), 'Delete scene')
      : null;

    function sync() {
      iconButtons.forEach((b, i) => {
        b.classList.toggle('selected', SCENE_ICONS[i] === iconName);
        b.setAttribute('aria-pressed', String(SCENE_ICONS[i] === iconName));
      });
      acChip?.classList.toggle('on', withAC);
      retakeChip?.classList.toggle('on', retake);
      // What Save keeps.
      const on = config.lights.filter((l) => state.lights[l.id].on).length;
      const parts = [!retake ? 'the lights as the scene has them'
        : on ? `${on} of ${config.lights.length} lights on, as they are now` : 'every light off, as they are now'];
      if (withAC) {
        const a = state.acs[config.acs[0].id];
        parts.push(hadAC && !retake ? 'its AC settings' : config.acs.length > 1 ? 'the ACs as they are'
          : a.on ? `the AC at ${a.target}° on ${MODE_LABEL[a.mode]}` : 'the AC off');
      }
      for (const [deviceID, action] of Object.entries(tvActions)) parts.push(`${action.name || action.app} on ${tvName(deviceID)}`);
      if (music) parts.push(`${music.name} on ${music.deviceName || 'Spotify'}`);
      what.replaceChildren(icon('sparkles', 16), h('span', `Saves ${parts.join(' and ')}.`));
    }

    function save() {
      const label = name.value.trim();
      if (!label) { name.classList.add('invalid'); name.focus(); haptic('error'); return; }
      const lights = retake ? captureLights() : existing.lights;
      const acs = !withAC ? {} : retake || !hadAC ? captureAcs() : existing.acs;
      const scene = { ...existing, id: existing?.id || newSceneId(label), name: label, icon: iconName, lights, acs, tvs: tvActions, spotify: music };
      haptic('success');
      commitScenes(existing ? config.scenes.map((x) => (x.id === existing.id ? scene : x)) : [...config.scenes, scene]);
      // Made from the lights as they are: that is the scene they are in now.
      if (retake) store.markScene(scene.id);
      closeSheet();
    }

    const sub = h('div.sheet-sub', existing ? existing.name : 'From the lights as they are now');
    return {
      nodes: [
        sheetHead(existing ? 'Edit scene' : 'New scene', sub, saveBtn),
        h('div.sheet-scroll.scene-form',
          h('div.field-label', h('span', 'Name')), name,
          h('div.field-label', h('span', 'Icon')), h('div.scene-icons', iconButtons),
          acChip || retakeChip ? h('div.scene-toggles', retakeChip, acChip) : null,
          tvOptions.length ? h('div.scene-tv-actions', h('div.field-label', 'TV apps'), ...tvOptions) : null,
          musicBox, what, del),
      ],
      // On a phone the keyboard would cover the icons: there the name is tapped when wanted.
      opened() { if (!isPhone && !existing) setTimeout(() => name.focus({ preventScroll: true }), 60); },
      update: sync,
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

    // Playing something: what, and a slider through it. Else just the app that is open.
    const playing = createNowPlaying({
      onPlayPause: () => key('playpause'),
      onSeek: (position) => tv.act(id, { action: 'seek', position }),
    });
    const nowLogo = h('span.tv-now-logo');
    const nowName = h('b');
    const now = h('div.tv-now', nowLogo, h('div.tv-now-text', h('span', 'Now on'), nowName),
      h('button.tv-now-home', { 'aria-label': 'Home screen', title: 'Home screen', onclick: () => { haptic('light'); key('home'); } }, icon('home', 16, 2)));

    const appButtons = new Map(APPS.map((a) => [a.id, h('button.tv-app', { 'aria-label': `Open ${a.name}`, title: a.name, onclick: () => { selectSearchApp(a.id); open(a); } },
      h('span.tv-app-icon', logoSVG(a, 58, true), h('i.tv-app-dot')), h('span.tv-app-name', a.name))]));
    const apps = h('div.tv-apps', [...appButtons.values()]);

    // Back, Home, Play/Pause and Mute down the left of the swipe pad, the volume down its right.
    const pad = createPad({ onKey: key });
    const side = (label, name, action, extra = null) => h('button.round.tv-key', { 'aria-label': label, title: label, onclick: () => { haptic('light'); key(action); } }, icon(name, 19, 2.1), extra);
    const muteBtn = side('Mute', 'mute', 'mute');
    const volume = createVolume({
      vertical: true,
      onStep: (dir) => key(dir > 0 ? 'volup' : 'voldown'),
      onLevel: (level) => tv.act(id, { action: 'volume', level }),
    });
    const volumeRow = h('div.tv-volume-col', volume.el);
    const remote = h('div.tv-remote',
      h('div.tv-keys', side('Home', 'home', 'home'), side('Back', 'undo', 'back'),
        h('button.round.tv-key.tv-playpause', { 'aria-label': 'Play or pause', title: 'Play / pause', onclick: () => { haptic('light'); key('playpause'); } },
          icon('play', 14, 2.4), icon('pause', 14, 2.4)), muteBtn),
      pad.el,
      volumeRow);
    const settings = h('button.tv-settings', { 'aria-label': 'Open Chromecast Settings', onclick: () => key('settings') }, icon('settings', 16, 2), 'Settings');
    const remoteCard = h('section.tv-remote-card', { 'aria-label': 'TV remote controls' },
      h('div.tv-remote-heading', h('b', 'Remote'), settings), remote);

    const searchApp = h('select.tv-search-app', { 'aria-label': 'App to search' },
      APPS.map((app) => h('option', { value: app.id }, app.name)));
    const appQuery = h('input.tv-search-input', { type: 'search', maxlength: 200, placeholder: 'Search YouTube on TV', 'aria-label': 'Search selected app on TV' });
    const appSubmit = h('button.tv-app-search-submit', { type: 'submit', 'aria-label': 'Search selected app on TV' }, icon('search', 18, 2));
    function selectSearchApp(app) {
      if (!APPS.some((a) => a.id === app)) return;
      searchApp.value = app;
      appQuery.placeholder = `Search ${APPS.find((a) => a.id === app).name} on TV`;
    }
    searchApp.onchange = () => selectSearchApp(searchApp.value);
    const appSearch = h('form.tv-app-search', { onsubmit: async (event) => {
      event.preventDefault();
      const text = appQuery.value.trim();
      if (!text || appSubmit.disabled) return;
      const app = APPS.find((a) => a.id === searchApp.value);
      appSubmit.disabled = true;
      try {
        if (await tv.act(id, { action: 'app-search', app: app.id, text })) toast(`Searching ${app.name} on the TV`, null, { note: true });
      } finally { appSubmit.disabled = false; }
    } }, searchApp, h('div.tv-search', icon('search', 17, 2), appQuery, appSubmit));
    selectSearchApp(d()?.app?.id || 'youtube');

    const search = createSearch({
      search: (q) => tv.search(q),
      onPlay: (r, offer) => open(appInfo({ id: offer.app }) || { id: offer.app, name: offer.name }, offer),
      onTvSearch: (q) => tv.act(id, { action: 'search', text: q }).then((ok) => ok && toast(`Searching the TV for “${q}”`, null, { note: true })),
      onType: (q) => tv.act(id, { action: 'text', text: q }).then((ok) => ok && toast(`Typed “${q}” on the TV`, null, { note: true })),
    });

    const problemText = h('span');
    const problem = h('div.sheet-note.tv-problem', { hidden: true }, icon('offline', 18, 2), problemText);
    // What's on, then the remote within a thumb's reach; the apps and search further down.
    const scroll = h('div.tv-scroll.sheet-scroll', problem, playing.el, now, remoteCard,
      h('div.tv-label', 'Apps'), apps, appSearch, h('div.tv-label', 'Movies & shows'), search.el);

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
      dispose() { pad.stop(); volume.stop(); search.stop(); playing.stop(); },
      search, // for screenshots and tests: search.show('the')
      playing, // and playing.preview(0.6)
      update() {
        const dev = d();
        const available = tv.state.available && Boolean(dev?.online);
        const on = Boolean(dev?.on);
        const app = on ? dev.app : null;
        if (opening && (Date.now() > opening.until || app?.id === opening.app.id)) opening = null;
        name.textContent = tvName(id);
        powerBtn.classList.toggle('on', on);
        powerBtn.disabled = !tv.state.available || !dev?.online;
        settings.disabled = !available;
        powerBtn.title = powerBtn.disabled ? (tv.state.error || 'The TV can’t be reached') : on ? 'Turn the TV off' : 'Turn the TV on';
        const glow = on ? glowOf(app) : null;
        sub.replaceChildren(
          opening ? `Opening ${opening.app.name}…` : h('b', tv.ready ? tvStatus(id) : 'Connecting…'),
          h(`span.live${on ? '' : '.idle'}`, { style: on ? { background: glow, boxShadow: `0 0 8px ${glow}` } : {} }));
        problem.hidden = !(tv.ready && !available);
        problemText.textContent = !tv.state.available ? tv.state.error || 'The TV can’t be reached.'
          : `${tvName(id)} isn’t answering. Is it plugged in and on the Wi-Fi?`;
        // Now on: the app on the screen (not the home screen), unless it says what it plays.
        const isPlaying = playing.set(dev);
        const showing = on && app && app.id !== 'home' && !isPlaying;
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
        volumeRow.classList.toggle('off', !on || dev.volume == null);
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
    } else if (hit.kind === 'speaker') {
      name = 'Studio speaker'; status = spotify.state.track?.title || 'Spotify'; on = Boolean(spotify.state.playing); color = '#85d7b3';
    } else {
      const cfg = store.acCfg.get(hit.id);
      const s = state.acs[hit.id];
      name = cfg.name; status = s.on ? `${MODE_LABEL[s.mode]} ${s.target}°` : 'Off'; on = s.on; color = MODE_COLORS[s.mode];
    }
    tooltip.replaceChildren(h('i.dot'), name, h('span', status));
    tooltip.classList.toggle('on', on);
    tooltip.style.setProperty('--dot', color);
    tooltip.style.left = `${clamp(hit.x, 70, card.clientWidth - 70)}px`;
    tooltip.style.top = `${Math.max(isPhone ? metrics.safeTop + 44 : 44, hit.y)}px`;
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
      h(`span.live${anyOn ? '' : '.idle'}`),
      // One run of text: the row's gap is for the dot.
      h('span', h('b', onCount ? `${onCount} of ${lights.length}` : 'No'), ' lights on',
        acsOn.length ? ` · AC ${acsOn[0].target}°` : ''));
    power.classList.toggle('on', anyOn);

    for (const [id, b] of sceneButtons) b.classList.toggle('active', state.scene === id);

    // Each room says how many of its lights are on (All: the whole home).
    for (const [id, { b, count }] of roomButtons) {
      b.classList.toggle('active', ui.room === id);
      const n = config.lights.filter((l) => (id === 'all' || l.room === id) && state.lights[l.id].on).length;
      count.textContent = n;
      count.classList.toggle('zero', n === 0);
      b.setAttribute('aria-label', `${id === 'all' ? 'All rooms' : roomName.get(id)}, ${n} ${n === 1 ? 'light' : 'lights'} on`);
    }

    const scoped = config.lights.filter(inScope);
    const scopedOn = scoped.filter((l) => state.lights[l.id].on).length;
    listTitle.replaceChildren(h('b', ui.room === 'all' ? 'Whole home' : roomName.get(ui.room)), ` · ${scopedOn} of ${scoped.length} on`);

    for (const t of tiles.values()) t.update();
    for (const t of tvTiles.values()) t.update();
    for (const head of heads.values()) head.update();
    sheetView?.update?.();
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
    // Typing to the house is not the TV's remote.
    if (voice?.open && voice.card.contains(ev.target) && ev.key !== 'Escape') return;
    if (ev.key === 'Escape' && voice?.close()) return;
    if (ui.sheet?.kind === 'tv' && sheetView?.key(ev)) return;
    if (ev.key !== 'Escape') return;
    if (!closeSheet()) onMenu(null, 'escape');
  };
  window.addEventListener('keydown', onKey);

  const unsubscribeSpotify = config.furniture.some((f) => f.type === 'speaker') ? spotify.subscribe(() => update()) : () => {};

  layoutTiles();
  update();
  measure();
  let offFrame = null;

  return {
    canvas,
    card,
    attach(w) {
      world = w;
      card.classList.remove('booting');
      offFrame = w.onFrame((now) => deck.tick(now));
      w.setSheetProgress(deck.progress);
    },
    /** The card as a sheet: `deck.set('expanded' | 'rest')`, `deck.detent`, `deck.progress`. */
    deck,
    /** Where the card rests and stops pulled up: { rest, expanded, safeTop, height } (px). */
    get metrics() { return { ...metrics }; },
    showTooltip,
    openSheet,
    closeSheet,
    selectRoom,
    toggleLight,
    get room() { return ui.room; },
    /** The tiles' order, as `tileOrder`. */
    get order() { return order.slice(); },
    setOrder,
    /** Scenes saved on another screen (the plan's `scenes`). */
    setScenes,
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
    /** The open sheet's device ({ kind, id }), or null on the home page. */
    get sheetTarget() { return ui.sheet; },
    anchorMenu: clip,
    clip,
    /** Stops listening; the card is removed by whoever replaces it. */
    dispose() {
      window.removeEventListener('keydown', onKey);
      voice?.dispose();
      unsubscribe();
      unsubscribeTv();
      unsubscribeSpotify();
      offTheme();
      offFrame?.();
      layoutRO.disconnect();
      deck.dispose();
      clearTimeout(themeHint.timer);
      reorder.cancel();
      sceneReorder.cancel();
      sheetView?.dispose?.();
      clearTimeout(toastEl.timer);
    },
  };
}
