import { loadRawConfig, normalize, isLinked, DEFAULT_PLAN } from './config.js';
import { createStore } from './store.js';
import { createWorld } from './three/world.js';
import { createPanel } from './ui/panel.js';
import { createAgent } from './agent/tools.js';
import { h, openMenu } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { isNative, isHub, isPhone, post, call, incoming, haptic, CLIENT_ID, listenForPlanChanges } from './bridge.js';
import { publishWidgets, runWidgetAction } from './widgets.js';
import { tv } from './tv/client.js';

const DEMO_PLANS = [
  { id: 'riley', name: 'Riley’s Studio' },
  { id: 'home', name: 'Demo apartment' },
  { id: 'studio', name: 'Demo studio' },
];
const STAGE_INSETS = [62, 50]; // header above, panel overlap below

const app = document.getElementById('app');
if (isNative) document.documentElement.classList.add('native');
if (isPhone) document.documentElement.classList.add('ios');
// The Windows widget: its window is dragged by the panel's header (and the editor's bar).
const isElectron = /Electron/.test(navigator.userAgent);
if (isElectron) document.documentElement.classList.add('electron');
// The panel is a sheet of glass over the desktop (Liquid Glass in the Mac app, a blur in
// a browser); the phone layout fills the screen and stays opaque.
let mode = window.__HOUSE_BOOT__?.mode || new URLSearchParams(location.search).get('mode') || 'panel';
let glass = mode === 'panel' && !isPhone;
if (glass) document.documentElement.classList.add('glass');

// ?safeTop=62&safeBottom=34 stands in for a phone's safe areas when its layout is looked at in a browser.
for (const edge of ['top', 'bottom']) {
  const px = Number(new URLSearchParams(location.search).get(edge === 'top' ? 'safeTop' : 'safeBottom'));
  if (isPhone && px) document.documentElement.style.setProperty(`--safe-${edge}-preview`, `${px}px`);
}

// Height of the status bar / Dynamic Island on a phone; 0 everywhere else.
function safeAreaTop() {
  const probe = document.body.appendChild(h('div', { style: { position: 'fixed', paddingTop: 'var(--safe-top-preview, env(safe-area-inset-top, 0px))' } }));
  const top = parseFloat(getComputedStyle(probe).paddingTop) || 0;
  probe.remove();
  return top;
}

function fatal(title, error) {
  console.error(error);
  app.replaceChildren(h('div.fatal', h('h1', title),
    'The floor plan could not be loaded. Fix the file and reload, or pick another plan from the menu bar icon.',
    h('code', String(error?.message || error))));
  post('ready', { error: String(error?.message || error) });
}

async function boot(initialRaw = null) {
  let raw;
  try {
    raw = initialRaw || await loadRawConfig();
    normalize(structuredClone(raw));
  } catch (error) {
    fatal('Could not open this home', error);
    return;
  }
  try {
    home = mountHome(raw, { first: true });
  } catch (error) {
    fatal('3D view failed to start', error);
    return;
  }
  // Served by the hub: a plan saved on another screen (or new devices found) arrives as a
  // reload event. The panel swaps itself in place; an open editor takes it in.
  listenForPlanChanges(async (update) => {
    if (update?.by === CLIENT_ID) return; // our own save coming back
    const res = await fetch('./api/plan', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const next = await res.json();
    if (editing) {
      if (editing.editor) editing.editor.adoptRemote(next, 'another screen');
      else editing.pending = next;
      return;
    }
    if (JSON.stringify(next) === JSON.stringify(home.raw)) return;
    // Only the tiles were rearranged (on another screen): they slide into place here.
    if (JSON.stringify({ ...next, tileOrder: null }) === JSON.stringify({ ...home.raw, tileOrder: null })) {
      if (next.tileOrder == null) delete home.raw.tileOrder; else home.raw.tileOrder = next.tileOrder;
      home.panel.setOrder(next.tileOrder);
      return;
    }
    swapHome(next);
  });
}

/* ---------- the tiles' order ---------- */

// Dragging a tile changes the plan's `tileOrder`, saved the way the editor saves a plan (the
// hub; the Mac or iPhone app), so every screen shows it. The panel keeps the plan it shows:
// nothing is rebuilt when the save comes back. A plain browser, or the app showing a demo
// while the user's own home is saved separately, keeps the order in this browser only.
const ORDER_SAVE = 700; // ms after the last move

function savesOrder() {
  if (isHub) return true;
  const boot = window.__HOUSE_BOOT__ || {};
  return isNative && (boot.plan === 'custom' || !boot.hasCustomPlan);
}

const orderKey = (raw) => `house.tileOrder.${window.__HOUSE_BOOT__?.plan || new URLSearchParams(location.search).get('plan') || DEFAULT_PLAN}.${raw.name || ''}`;

function keptOrder(raw) {
  try {
    const kept = JSON.parse(localStorage.getItem(orderKey(raw)));
    return Array.isArray(kept) ? kept.filter((k) => typeof k === 'string') : null;
  } catch { return null; }
}

function saveOrder(m, order) {
  m.raw.tileOrder = order; // in place: the editor and AI Access work on this same plan
  if (!savesOrder()) {
    try { localStorage.setItem(orderKey(m.raw), JSON.stringify(order)); } catch { /* private browsing */ }
    return;
  }
  clearTimeout(m.orderTimer);
  m.orderTimer = setTimeout(async () => {
    try {
      await call('savePlan', isHub ? { config: m.raw, client: CLIENT_ID } : { config: m.raw });
      // The app keeps it as the user's own home from now on. (A plan the hub makes stays the
      // hub's: a new order changes nothing else.)
      if (!isHub) Object.assign(window.__HOUSE_BOOT__ ||= {}, { plan: 'custom', hasCustomPlan: true });
    } catch (error) {
      m.panel?.toast(`The new order wasn’t saved: ${error.message}`);
      haptic('error');
    }
  }, ORDER_SAVE);
}

// A standalone browser preview has no server to keep its edits through a navigation.
// Mount its edited document directly, just as Done in the in-panel editor does.
export async function showPreviewPanel(raw) {
  mode = 'panel';
  glass = !isPhone;
  document.documentElement.classList.remove('mode-editor');
  document.documentElement.classList.toggle('glass', glass);
  const url = new URL(location.href);
  url.searchParams.delete('mode');
  url.searchParams.delete('section');
  history.replaceState(null, '', url);
  await boot(raw);
}

/**
 * Builds the panel and the 3D view of one plan. Everything it starts, `dispose()` stops,
 * so a saved plan swaps in without reloading the page. opts: { first, editing, state, room }.
 */
function mountHome(raw, { first = false, editing: underEditor = false, grown = false, state = null, room = null } = {}) {
  const config = normalize(structuredClone(raw));
  if (!savesOrder()) config.tileOrder = keptOrder(raw) ?? config.tileOrder;
  const lifetime = new AbortController();
  const { signal } = lifetime;

  const store = createStore(config);
  const linked = [...config.lights, ...config.acs].some(isLinked);
  if (state) store.importState(state);
  // Never invent a starting state for real hardware: it reports its own.
  else if (first && !store.restored && !linked) {
    // First launch: start with something worth looking at.
    const scene = config.scenes.find((s) => s.id === 'cozy') || config.scenes[1] || config.scenes[0];
    if (scene) store.applyScene(scene.id);
    if (config.acs[0]) store.setAC(config.acs[0].id, { on: true, target: 23 });
  }

  let world;
  const m = { raw, config, store, world: null, panel: null, card: null, editing: underEditor, applyInsets: null, dispose };
  const panel = createPanel(app, config, store, {
    onFocus: (target) => world?.focus(target),
    onMenu: (anchor, reason) => {
      if (reason === 'escape') post('close');
      else if (reason === 'agent') post('openAgent');
      else if (isPhone && isNative) post('openSettings'); // plans, sync and sign-in are native screens there
      else planMenu(anchor);
    },
    onEdit: () => openEditor(),
    onEditPrefetch: () => { if (!isNative) loadEditor().catch(() => {}); },
    onOrder: (order) => saveOrder(m, order),
    editing: underEditor,
    grown,
  });

  try {
    world = createWorld(panel.canvas, config, store, {
      ...(glass && { background: null }),
      onHover: panel.showTooltip,
      onPick(target) {
        if (!target) return;
        if (target.kind === 'light') { haptic('light'); store.toggleLight(target.id); }
        else if (target.kind === 'ac' || target.kind === 'tv') panel.openSheet(target);
        else if (target.kind === 'room') panel.selectRoom(target.id);
      },
    });
  } catch (error) {
    panel.dispose();
    panel.card.remove();
    store.dispose();
    throw error;
  }
  Object.assign(m, { world, panel, card: panel.card });

  panel.attach(world);
  // On a phone the header sits lower (status bar) but is closer to the model. While the
  // editor is open it decides where the model is framed.
  m.applyInsets = () => {
    if (m.editing) return;
    if (isPhone) world.setInsets(50 + safeAreaTop(), 36); else world.setInsets(...STAGE_INSETS);
  };
  m.applyInsets();
  const ro = new ResizeObserver(() => (isPhone && !m.editing ? m.applyInsets() : world.resize()));
  ro.observe(panel.canvas);

  const show = () => { tv.setVisible(true); if (m.editing) return; world.setRunning(true); world.intro(); };
  const hide = () => { tv.setVisible(false); world.setRunning(false); };
  incoming.shown = show;
  incoming.hidden = () => { hide(); panel.closeSheet(); if (panel.room !== 'all') panel.selectRoom('all'); };
  incoming.setNotch = (x) => panel.setNotch(x);
  if (isPhone) {
    // Swiping in from the left edge goes back from a device sheet, as it does everywhere on iOS.
    let edge = null;
    window.addEventListener('pointerdown', (ev) => { edge = ev.clientX < 28 ? { x: ev.clientX, y: ev.clientY } : null; }, { capture: true, signal });
    window.addEventListener('pointerup', (ev) => {
      const swiped = edge && ev.clientX - edge.x > 56 && Math.abs(ev.clientY - edge.y) < 80;
      edge = null;
      if (swiped && !m.editing && panel.closeSheet()) haptic('light');
    }, { capture: true, signal });
    window.addEventListener('pointercancel', () => { edge = null; }, { capture: true, signal });
  }
  incoming.applyRemote = (update) => store.applyRemote(update);
  incoming.adopt = (s) => store.adopt(s);
  incoming.share = () => store.share();
  // Widgets and controls: what they changed while the app was away is run here, where it
  // reaches the devices; a widget's tap on a lamp or a scene opens that in the panel.
  incoming.widget = (actions) => {
    store.source = 'Widget';
    try {
      for (const action of [].concat(actions)) runWidgetAction(store, config, action);
    } finally {
      store.source = null;
    }
  };
  incoming.openDevice = (id) => {
    if (store.acCfg.has(id)) panel.openSheet({ kind: 'ac', id });
    else if (store.lightCfg.has(id)) panel.openSheet({ kind: 'light', id });
    else if (config.rooms.some((r) => r.id === id)) { panel.closeSheet(); panel.selectRoom(id); }
    else openTvWhenKnown(id);
  };
  // A TV is known once the TV has answered (it may be linked to the plan automatically).
  function openTvWhenKnown(id) {
    if (!id || panel.openTv(id) || tv.ready) return;
    const off = tv.subscribe(() => {
      if (!tv.ready) return;
      off();
      if (home === m) panel.openTv(id);
    });
  }
  // AI Access: an AI assistant's requests are run here, where the state of every device lives.
  const agent = createAgent({
    store, config, raw,
    render: (r) => renderShot(config, store, r),
    onAction: ({ client, summary }) => { if (summary) panel.toast(summary, client || 'AI'); },
  });
  incoming.agent = async (request) => {
    store.source = request.client || 'AI'; // the other views say who made the change
    try {
      return JSON.stringify(await agent.handle(request));
    } finally {
      store.source = null;
    }
  };
  incoming.agentLive = (live) => { agentLive = Boolean(live); panel.setAgentLive(agentLive); };
  panel.setAgentLive(agentLive);
  incoming.openAtLogin = (s) => { openAtLogin = s; };

  tv.onError = (message) => {
    panel.toast(message);
    haptic('error');
  };
  store.onDeviceError = (id, message) => {
    const name = store.lightCfg.get(id)?.name || store.acCfg.get(id)?.name || id;
    panel.toast(`${name}: ${message}`);
    haptic('error');
  };
  // The loop pauses whenever the page is hidden; any sign of life resumes it (not while
  // the editor's plan covers the model).
  const resume = () => { if (!document.hidden && !m.editing) world.setRunning(true); };
  document.addEventListener('visibilitychange', () => (document.hidden ? hide() : resume()), { signal });
  for (const type of ['focus', 'pageshow', 'pointermove', 'pointerdown']) window.addEventListener(type, resume, { passive: true, signal });

  function planMenu(anchor) {
    const current = window.__HOUSE_BOOT__?.plan ?? (new URLSearchParams(location.search).get('plan') || DEFAULT_PLAN);
    const items = DEMO_PLANS.map((p) => ({
      label: p.name,
      selected: p.id === current,
      icon: p.id === current ? icon('check', 16, 2.4) : null,
      action: () => {
        if (isNative) post('selectPlan', { plan: p.id });
        else location.search = `?plan=${p.id}`;
      },
    }));
    if (window.__HOUSE_BOOT__?.hasCustomPlan) {
      items.unshift({
        label: 'My home',
        selected: current === 'custom',
        icon: current === 'custom' ? icon('check', 16, 2.4) : null,
        action: () => post('selectPlan', { plan: 'custom' }),
      });
    }
    items.push('-', { label: 'Edit home…', action: () => openEditor() });
    if (isNative) {
      items.push(
        { label: 'AI access…', action: () => post('openAgent') },
        { label: 'Load floor plan…', action: () => post('loadPlan') },
        { label: 'Reveal plan file', action: () => post('revealPlan') },
        '-',
        {
          label: openAtLogin === 'needsApproval' ? 'Open at login — allow in Settings…' : 'Open at login',
          icon: openAtLogin === 'on' ? icon('check', 16, 2.4) : null,
          action: () => post('setOpenAtLogin', { on: openAtLogin !== 'on' }),
        },
        { label: 'Quit House Control', action: () => post('quit') });
    }
    openMenu(panel.anchorMenu, anchor, items);
  }

  if (room && room !== 'all' && config.rooms.some((r) => r.id === room)) panel.selectRoom(room);
  if (first) {
    const opened = window.__HOUSE_BOOT__?.openDevice || new URLSearchParams(location.search).get('device');
    if (store.acCfg.has(opened)) panel.openSheet({ kind: 'ac', id: opened });
    else if (store.lightCfg.has(opened)) panel.openSheet({ kind: 'light', id: opened });
    else openTvWhenKnown(opened);
    if (!isNative) show();
    post('ready', { summary: store.summary() });
  } else if (!underEditor) {
    world.setRunning(true);
  }
  if (isNative) publishWidgets(config, store);
  window.__house = { store, world, panel, config, tv, edit: () => openEditor() }; // handy in the dev console

  function dispose() {
    lifetime.abort();
    ro.disconnect();
    panel.dispose();
    world.dispose();
    store.dispose();
    panel.card.remove();
  }
  return m;
}

// A plan saved elsewhere: the new panel fades in over the old one, keeping the room and
// what every device is doing. No reload, so nothing else on the page is lost.
function swapHome(raw) {
  const old = home;
  let next;
  try {
    next = mountHome(raw, { state: old.store.exportState(), room: old.panel.room });
  } catch (error) {
    console.error('The new plan could not be shown', error);
    return;
  }
  home = next;
  old.card.inert = true;
  old.card.setAttribute('aria-hidden', 'true');
  next.card.classList.add('swap-in');
  old.card.classList.add('swap-out');
  void next.card.offsetWidth;
  next.card.classList.remove('swap-in');
  setTimeout(() => old.dispose(), 320);
}

/* ---------- the editor, in the panel ---------- */

let home = null;
let editing = null; // { m, editor, pending } while the editor is open
let editorModule = null;
let agentLive = Boolean(window.__HOUSE_BOOT__?.agentLive);
// 'on', 'off' or 'needsApproval' (switched on, waiting to be allowed in System Settings).
let openAtLogin = window.__HOUSE_BOOT__?.openAtLogin || 'off';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function loadEditor() {
  editorModule ||= import('./edit/editor.js').catch((e) => { editorModule = null; throw e; });
  return editorModule;
}

// A desktop browser window with room to spare: the card grows into an editing table.
function canGrow() {
  return !isPhone && !isNative && !isElectron && innerWidth >= 980 && innerHeight >= 640;
}
const grownSize = () => ({ width: Math.min(1280, innerWidth - 36), height: Math.min(880, innerHeight - 36) });

async function openEditor() {
  // The Mac app and the iPhone app open their own editor window or screen.
  if (isNative) { post('openEditor'); return; }
  if (editing || !home) return;
  const m = home;
  const session = { m, editor: null, pending: null };
  editing = session;
  m.editing = true;
  m.panel.closeSheet();
  haptic('medium');
  const grow = canGrow();
  m.card.classList.add('editing');
  if (grow) m.card.classList.add('grow');
  // A hidden header would still be a window-drag region in the Windows widget: gone once faded.
  setTimeout(() => { if (editing === session) m.card.classList.add('faded'); }, 220);

  let mod;
  try {
    mod = await loadEditor();
  } catch (error) {
    m.panel.toast(`The editor could not be loaded: ${error.message}`);
    cancelOpen(session);
    return;
  }

  // The house swoops to a straight-down view of the whole home…
  let initialView = null;
  try {
    const ins = mod.narrowInsets(m.card, grow ? grownSize() : null);
    m.world.setRunning(true);
    m.world.setInsets(ins.top, ins.bottom);
    await Promise.all([m.world.topDown(true, { duration: 650 }), grow ? wait(470) : null]);
    initialView = mod.viewFromWorld(m.world, m.raw);
  } catch (error) {
    console.warn('Editor: the camera move failed, cross-fading instead', error);
  }
  if (editing !== session) return;

  // …and the plan appears exactly over its floor.
  let editor;
  try {
    editor = mod.createEditor(null, {
      raw: m.raw, mode: 'overlay', store: m.store, initialView,
      canSave: isHub, onDone: (doc) => closeEditor(session, mod, doc),
    });
  } catch (error) {
    m.panel.toast(`The editor could not start: ${error.message}`);
    cancelOpen(session);
    return;
  }
  session.editor = editor;
  m.card.append(editor.el);
  await editor.enter();
  if (editing !== session) return;
  m.card.classList.add('covered');
  setTimeout(() => { if (editing === session && session.m === home) home.world.setRunning(false); }, 260);
  if (session.pending) { editor.adoptRemote(session.pending, 'another screen'); session.pending = null; }
}

function cancelOpen(session) {
  const { m } = session;
  editing = null;
  m.editing = false;
  m.card.classList.remove('faded');
  void m.card.offsetWidth;
  m.card.classList.remove('editing', 'grow', 'covered');
  m.applyInsets();
  m.world.topDown(false);
}

// Done: the new plan is built under the editor, the plan fades into it and the camera
// rises back to the usual view while the lamps come on.
async function closeEditor(session, mod, doc) {
  if (editing !== session) return;
  const { editor, m: old } = session;
  let next;
  try {
    next = mountHome(doc, { editing: true, grown: old.card.classList.contains('grow'), state: old.store.exportState(), room: null });
  } catch (error) {
    console.error(error);
    old.panel.toast(`This plan cannot be shown: ${error.message}`);
    return;
  }
  // Same task: the plan moves to the new card before the old one goes, so nothing flashes.
  next.card.append(editor.el);
  old.dispose();
  home = next;
  if (session.pending) session.pending = null;

  try {
    const ins = editor.fitInsets();
    next.world.resize();
    next.world.setInsets(ins.top, editor.layout === 'narrow' ? ins.bottom : 24);
    await next.world.topDown(true, { instant: true });
    next.world.setRunning(true);
    await editor.plan.setView(mod.viewFromWorld(next.world, doc), { animate: 260 });
  } catch (error) {
    console.warn('Editor: could not line the 3D view up with the plan', error);
  }
  await editor.leave();
  editor.destroy();
  editor.el.remove();
  editing = null;
  next.editing = false;
  next.card.classList.remove('faded');
  void next.card.offsetWidth;
  next.card.classList.remove('editing', 'grow');
  next.applyInsets();
  next.world.topDown(false, { duration: 800 });
  next.world.intro({ camera: false });
}

// A still of the 3D model for an AI checking its own edit: a second, off-screen world
// rendered once and thrown away, so the panel's own view is left as it is.
async function renderShot(config, store, room) {
  const canvas = h('canvas', { style: { width: '100%', height: '100%', display: 'block' } });
  const holder = h('div', { style: { position: 'fixed', left: '-4000px', top: '0', width: '880px', height: '660px', pointerEvents: 'none' } }, canvas);
  document.body.append(holder);
  let shot;
  try {
    shot = createWorld(canvas, config, store, { onHover() {}, onPick() {} });
    shot.setInsets(0, 0);
    if (room) shot.focus({ kind: 'room', id: room });
    shot.settle(8);
    return canvas.toDataURL('image/jpeg', 0.86);
  } finally {
    shot?.dispose();
    holder.remove();
  }
}

if (mode === 'editor') {
  document.documentElement.classList.add('mode-editor');
  import('./edit/editor.js').then((m) => m.bootEditor(app)).catch((e) => fatal('Editor failed to start', e));
} else if (mode === 'agent') {
  import('./agent/console.js').then((m) => m.bootConsole(app)).catch((e) => fatal('AI Access failed to start', e));
} else if (mode === 'island') {
  document.documentElement.classList.add('mode-island');
  import('./island/island.js').then((m) => m.bootIsland(app)).catch((e) => console.error(e));
} else {
  boot();
}
