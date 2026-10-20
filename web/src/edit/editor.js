// The home editor. In the panel it opens in place over the 3D view (overlay); the Mac
// app's editor window, the iPhone app and old ?mode=editor links load it on its own page
// (standalone). It owns the plan document, the selection, undo and the autosave; the
// plan (plan.js) and the sheet of pages (sheet.js, pages.js) only read it and ask for changes.
import './edit.css';
import * as THREE from 'three';
import { loadRawConfig } from '../config.js';
import { createWorld } from '../three/world.js';
import { lightColor } from '../three/lights.js';
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { isNative, isHub, isPhone, call, post, haptic, incoming, CLIENT_ID, listenForPlanChanges } from '../bridge.js';
import * as M from './model.js';
import { createPlan } from './plan.js';
import { createSheet } from './sheet.js';
import { createToaster, actionSheet, segmented, hooks as formHooks, holding } from './forms.js';
import { createConnections } from './connections.js';
import { createSmartLife } from './smartlife.js';
import * as P from './pages.js';
import { tv } from '../tv/client.js';

const WIDE = { w: 900, h: 560 };
const BAR_H = 52;
const DOCK_W = 380;
const DOCK_GAP = 16;
const UNDO_DEPTH = 100;
const SAVE_DELAY = 600;
const RETRY_MS = 5000;
const OFFLINE = /cannot be reached/i;

const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The same plan written by another program (the Mac app re-serialises it) compares equal.
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

// The status bar and the home indicator of a phone, read from the CSS the page already has.
function safeAreas(container) {
  const probe = h('i.ed-probe');
  container.append(probe);
  const cs = getComputedStyle(probe);
  const out = { top: parseFloat(cs.paddingTop) || 0, bottom: parseFloat(cs.paddingBottom) || 0 };
  probe.remove();
  return out;
}

/**
 * Where the plan will be framed in a container of this size, for the 3D view to land in
 * the same place before the editor exists: { top, bottom } in px.
 */
export function narrowInsets(container, size = null) {
  const r = size || container.getBoundingClientRect();
  const safe = safeAreas(container);
  if (r.width >= WIDE.w && r.height >= WIDE.h) return { top: BAR_H + safe.top + 12, bottom: 24 };
  return { top: BAR_H + safe.top + 10, bottom: Math.round(150 + safe.bottom) };
}

/**
 * The plan's view ({ s, tx, ty }, px per metre and offset) that lies exactly over the floor
 * of a 3D world looking straight down, so one can cross-fade into the other.
 */
export function viewFromWorld(world, raw) {
  const b = M.roomBounds(M.ensureArrays(structuredClone(raw)));
  const p0 = world.projectFloor(b.minX, b.minZ);
  const p1 = world.projectFloor(b.maxX, b.maxZ);
  const sx = (p1.x - p0.x) / Math.max(0.01, b.maxX - b.minX);
  const sz = (p1.y - p0.y) / Math.max(0.01, b.maxZ - b.minZ);
  const s = (sx + sz) / 2;
  if (!(s > 0) || !Number.isFinite(s)) return null;
  return { s, tx: (p0.x + p1.x) / 2 - ((b.minX + b.maxX) / 2) * s, ty: (p0.y + p1.y) / 2 - ((b.minZ + b.maxZ) / 2) * s };
}

/**
 * opts: { raw, mode: 'overlay' | 'standalone', store?, initialView?, canSave, onDone(doc),
 *         showDone = true, section? }
 */
export function createEditor(host, opts) {
  const mode = opts.mode || 'overlay';
  const canSave = Boolean(opts.canSave);
  const store = opts.store || null;
  let doc = M.ensureArrays(structuredClone(opts.raw));
  let sel = null;
  let layout = 'narrow';
  let destroyed = false;
  let view3d = false;

  /* ---------- chrome ---------- */

  const undoBtn = h('button.ed-icon-btn', { type: 'button', 'aria-label': 'Undo', title: 'Undo (⌘Z)', onclick: () => undoStep() }, icon('undo', 19, 2.2));
  const redoBtn = h('button.ed-icon-btn', { type: 'button', 'aria-label': 'Redo', title: 'Redo (⇧⌘Z)', onclick: () => redoStep() }, icon('redo', 19, 2.2));
  const statusEl = h('button.ed-status', { type: 'button', onclick: () => { if (status === 'error' || status === 'offline') flush(); } });
  const doneBtn = h('button.ed-done', { type: 'button', onclick: () => finish() }, h('span', 'Done'));
  const viewSlot = h('div.ed-bar-view');
  const bar = h('header.ed-bar',
    h('div.ed-bar-side.start', undoBtn, redoBtn),
    h('div.ed-bar-title', h('b.ed-bar-name', 'Edit Home'), statusEl),
    h('div.ed-bar-side.end', viewSlot, opts.showDone === false ? null : doneBtn));

  const fitBtn = h('button.ed-fab', { type: 'button', 'aria-label': 'Fit the home', title: 'Fit the home', onclick: () => { haptic('light'); plan.fit({ animate: 380 }); } }, icon('fit', 19, 2.2));
  const floatSlot = h('div.ed-float-view');
  const float = h('div.ed-float', floatSlot, fitBtn);
  const previewHost = h('div.ed-3d');
  // The Windows widget hides itself on Esc unless a `.sheet` is open: this marker keeps
  // Esc with the editor (it cancels drawing, goes back, deselects) instead of the window.
  const marker = h('i.sheet', { hidden: true, 'aria-hidden': 'true' });
  const el = h(`div.ed.${mode}`, { 'data-layout': layout }, previewHost);
  const toaster = createToaster(el);
  const toast = (text, o) => toaster.show(text, o);

  /* ---------- connections ---------- */

  const links = createConnections({ onChange: () => refreshSheet() });
  const smartLife = isNative && !isPhone ? createSmartLife({ onChange: () => refreshSheet(), connections: links }) : null;

  /* ---------- live state (overlay: the panel's store) ---------- */

  const tmp = new THREE.Color();
  function live(id) {
    const s = store?.state.lights[id];
    if (!s || !store.lightCfg.has(id)) return null;
    return { on: Boolean(s.on), color: `#${lightColor(s, tmp).getHexString()}` };
  }
  function liveAC(id) {
    const s = store?.state.acs[id];
    return s && store.acCfg.has(id) ? { on: Boolean(s.on), mode: s.mode } : null;
  }

  /* ---------- the plan ---------- */

  let gestureBefore = null;
  let deferredRemote = null;
  let remoteEpoch = 0;
  const plan = createPlan({
    doc: () => doc,
    sel: () => sel,
    select: (next, o = {}) => select(next, { ...o, via: 'plan' }),
    begin() { gestureBefore = JSON.stringify(doc); },
    preview() { plan.render(); },
    commit() {
      const before = gestureBefore;
      gestureBefore = null;
      if (before != null && before !== JSON.stringify(doc)) {
        pushUndo(before);
        afterChange();
      } else plan.render();
      if (deferredRemote) { const [raw, from] = deferredRemote; deferredRemote = null; adoptRemote(raw, from); }
    },
    idle() {
      if (deferredRemote) { const [raw, from] = deferredRemote; deferredRemote = null; adoptRemote(raw, from); }
      if (refreshWanted) refreshSheet();
    },
    insets,
    units: () => M.unitsOf(doc),
    live,
    liveAC,
    onView() {},
    onDrawn(rect) { drawn(rect); },
    onDrawCancel() { cancelDrawing(); },
    toast,
    cycle,
  });
  el.prepend(plan.el);

  /* ---------- the sheet ---------- */

  const sheet = createSheet({
    onChange: sheetMoved,
    onClose(page) {
      if (page.kind === 'item') select(null);
      else if (!sheet.pop()) select(null);
    },
  });
  el.append(float, bar, sheet.el, marker);
  el.append(toaster.el); // above the sheet

  let settleTimer = 0;
  function sheetMoved({ visible, detent, layout: lay, animate }) {
    el.style.setProperty('--ed-sheet', `${lay === 'narrow' ? visible : 0}px`);
    float.style.transition = animate ? 'transform 480ms cubic-bezier(0.32, 0.72, 0, 1), opacity 200ms' : 'opacity 200ms';
    float.classList.toggle('hidden', lay === 'narrow' && visible > el.clientHeight * 0.62);
    if (preview) applyPreviewInsets();
    // At the large detent the plan is hardly visible: it stays where it is (as in Maps).
    if (!animate || (lay === 'narrow' && detent === 'large')) return;
    // The plan follows what the sheet leaves visible, keeping the selection in view.
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      if (plan.pressed) return; // never under a finger (a touch and hold just selected it)
      const it = M.itemOf(doc, sel);
      plan.insetsChanged({ animate: 420, keep: it ? M.boxOf(sel.kind, it) : null });
    }, 0);
  }

  function insets() {
    const top = bar.offsetTop + bar.offsetHeight + 6;
    if (layout === 'wide') return { top, right: DOCK_W + DOCK_GAP * 2, bottom: 8, left: 0 };
    return { top, right: 0, bottom: sheet.visible + 6, left: 0 };
  }

  /* ---------- layout ---------- */

  // 2D | 3D: drawn again for each state (a segmented control keeps the value it was made with).
  let viewToggle = null;
  function drawViewToggle() {
    const next = segmented({
      key: 'view', small: true, label: 'Plan or 3D',
      options: [{ value: '2d', label: '2D' }, { value: '3d', label: '3D' }],
      value: view3d ? '3d' : '2d', onChange: (v) => set3D(v === '3d'),
    });
    next.classList.add('ed-view');
    if (viewToggle?.parentNode) viewToggle.replaceWith(next);
    viewToggle = next;
  }

  function layoutNow() {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const next = r.width >= WIDE.w && r.height >= WIDE.h ? 'wide' : 'narrow';
    const switched = next !== layout;
    layout = next;
    el.dataset.layout = layout;
    if (!viewToggle) drawViewToggle();
    (layout === 'wide' ? viewSlot : floatSlot).append(viewToggle);
    const safe = safeAreas(el);
    sheet.setGeometry({ height: r.height, top: bar.offsetTop + bar.offsetHeight, safeBottom: safe.bottom }, layout);
    if (switched) {
      // The page stack is the same; only the container changes.
      plan.measure();
      plan.insetsChanged({ animate: 380 });
    }
  }
  const ro = new ResizeObserver(() => { if (!destroyed) layoutNow(); });
  ro.observe(el);

  /* ---------- pages ---------- */

  const ctx = {
    get doc() { return doc; },
    get units() { return M.unitsOf(doc); },
    mode,
    store,
    touch: isPhone || matchMedia('(pointer: coarse)').matches,
    links,
    smartLife,
    live,
    select: (next, o = {}) => select(next, { ...o, via: 'page' }),
    change,
    push: (page, o) => sheet.push(page, o),
    pop: () => sheet.pop(),
    refresh: () => refreshSheet(),
    markCorner: (p) => plan.markCorner(p),
    toast,
    addRoom: (preset) => add((d) => M.selOf(d, 'room', M.addRoom(d, preset))),
    addLight: (type, room) => add((d) => M.selOf(d, 'light', M.addLight(d, type, M.roomById(d, room?.id) || targetRoom(d)))),
    addAC: (room) => add((d) => M.selOf(d, 'ac', M.addAC(d, M.roomById(d, room?.id) || targetRoom(d)))),
    addOpening: (type, room) => add((d) => M.selOf(d, 'opening', M.addOpening(d, type, M.roomById(d, room?.id) || targetRoom(d)))),
    addFurniture: (type, room) => add((d) => M.selOf(d, 'furniture', M.addFurniture(d, type, M.roomById(d, room?.id) || targetRoom(d)))),
    addDevice: (device, room) => add((d) => M.addFromDevice(d, device, M.roomById(d, room?.id) || targetRoom(d))),
    addScene() {
      const s = change((d) => M.addScene(d));
      sheet.push(P.scenePage(ctx, s.id));
    },
    startDrawing,
    remove,
    duplicate: dup,
    targetRoom: () => targetRoom(doc),
    exportPlan,
    importPlan,
  };

  let refreshQueued = false;
  let refreshWanted = false;
  function refreshSheet() {
    if (destroyed) return;
    // Never under a finger: a held stepper or a drag on the plan redraws when it ends.
    if (holding() || plan.busy) { refreshWanted = true; return; }
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(() => {
      refreshQueued = false;
      refreshWanted = false;
      if (!destroyed) sheet.refresh();
    });
  }
  formHooks.afterHold = () => { if (refreshWanted) refreshSheet(); };

  function rootPages() {
    return [P.homePage(ctx)];
  }

  /* ---------- selection ---------- */

  function select(next, { via = 'code', detent = null, quiet = false } = {}) {
    if (next && !M.itemOf(doc, next)) next = null;
    const same = next ? M.sameSel(next, sel) : !sel;
    if (same && (next ? sheet.top?.kind === 'item' : sheet.depth === 1 && sheet.top?.kind === 'root')) {
      if (detent) sheet.setDetent(detent);
      return;
    }
    if (!quiet && via !== 'plan' && next) haptic('light');
    sel = next;
    plan.markCorner(null); // a room page marks its "Cut corner" corner again as it renders
    plan.render();
    sheet.show(next ? [P.itemPage(ctx, next)] : rootPages(), { animate: 'fade', detent });
  }

  // Where new things go: the selected room, the room of the selected thing, the room in
  // the middle of what is visible, or the first room.
  function targetRoom(d = doc) {
    const it = M.itemOf(d, sel);
    if (it && sel.kind === 'room') return it;
    if (it && (sel.kind === 'light' || sel.kind === 'ac')) return M.roomById(d, it.room) || M.roomAt(d, it.pos) || d.rooms[0];
    if (it && sel.kind !== 'scene') {
      const c = M.centerOf(sel.kind, it);
      const r = c && M.roomAt(d, c);
      if (r) return r;
    }
    const ins = insets();
    const r = plan.svg.getBoundingClientRect();
    const mid = plan.toWorld((ins.left + r.width - ins.right) / 2, (ins.top + r.height - ins.bottom) / 2);
    return M.roomAt(d, mid) || d.rooms[0] || null;
  }

  // Tab on the plan: rooms, then lamps, ACs, doors and windows, furniture.
  function cycle(dir) {
    const list = [
      ...doc.rooms.map((r) => ({ kind: 'room', id: r.id })),
      ...doc.lights.map((l) => ({ kind: 'light', id: l.id })),
      ...doc.acs.map((a) => ({ kind: 'ac', id: a.id })),
      ...doc.openings.map((o, index) => (o.from && o.to ? { kind: 'opening', index } : null)),
      ...doc.furniture.map((f, index) => (Array.isArray(f.pos) ? { kind: 'furniture', index } : null)),
    ].filter(Boolean);
    const at = sel ? list.findIndex((s) => M.sameSel(s, sel)) : -1;
    const next = at < 0 ? (dir > 0 ? 0 : list.length - 1) : at + dir;
    if (next < 0 || next >= list.length) return false; // lets focus move on out of the plan
    select(list[next], { via: 'keyboard' });
    return true;
  }

  /* ---------- changes and undo ---------- */

  const undo = [];
  const redo = [];
  let lastKey = null;
  let lastAt = 0;
  let issue = null;

  function pushUndo(before) {
    undo.push(before);
    if (undo.length > UNDO_DEPTH) undo.shift();
    redo.length = 0;
    lastKey = null;
  }

  /**
   * Changes the document. `key` folds a burst on one field (typing, a held stepper) into
   * one undo step; `light` skips redrawing the page (the field being typed in stays).
   * Returns what `fn` returns.
   */
  function change(fn, { key = null, light = false } = {}) {
    const before = JSON.stringify(doc);
    const out = fn(doc);
    if (JSON.stringify(doc) === before) return out;
    const now = performance.now();
    if (!(key && key === lastKey && now - lastAt < 1500)) {
      undo.push(before);
      if (undo.length > UNDO_DEPTH) undo.shift();
      redo.length = 0;
    }
    lastKey = key;
    lastAt = now;
    afterChange({ light });
    return out;
  }

  function afterChange({ light = false } = {}) {
    issue = M.check(doc).error;
    if (sel && !M.itemOf(doc, sel)) select(null);
    plan.render();
    if (light) retitle(); else refreshSheet();
    syncHistory();
    scheduleSave();
    schedulePreview();
  }

  // Typing a name: the page's title follows without redrawing the field.
  function retitle() {
    const top = sheet.top;
    const node = sheet.el.querySelector('.ed-page:last-child .ed-page-title');
    if (!top || !node) return;
    try { node.textContent = top.render().head?.title ?? node.textContent; } catch { /* the next refresh draws it */ }
  }

  function restore(json) {
    doc = M.ensureArrays(JSON.parse(json));
    lastKey = null;
    afterChange();
  }

  function undoStep() {
    if (plan.busy || !undo.length) return false;
    redo.push(JSON.stringify(doc));
    restore(undo.pop());
    haptic('light');
    return true;
  }

  function redoStep() {
    if (plan.busy || !redo.length) return false;
    undo.push(JSON.stringify(doc));
    restore(redo.pop());
    haptic('light');
    return true;
  }

  function syncHistory() {
    undoBtn.disabled = !undo.length;
    redoBtn.disabled = !redo.length;
  }

  /* ---------- adding, removing, duplicating ---------- */

  function add(fn) {
    const made = change(fn);
    if (!made) return null;
    haptic('medium');
    plan.drop(made);
    // The sheet settles at the peek, and the plan then brings the new thing into view.
    select(made, { via: 'add', detent: layout === 'narrow' ? 'peek' : null, quiet: true });
    return made;
  }

  function labelOf(target, it) {
    if (target.kind === 'furniture') return M.furnitureName(it.type).toLowerCase();
    if (target.kind === 'opening') return M.openingName(it.type).toLowerCase();
    return it.name || it.id;
  }

  async function remove(target) {
    const it = M.itemOf(doc, target);
    if (!it) return;
    if (target.kind === 'room') {
      if (doc.rooms.length < 2) { toast('A home needs at least one room'); return; }
      const what = M.roomDeletion(doc, it);
      if (!what.empty) {
        const i = await actionSheet(el, {
          title: `Delete ${it.name || it.id}?`,
          message: [...what.lines, 'You can undo this.'],
          actions: [{ label: 'Delete room', destructive: true }],
        });
        if (i !== 0 || !M.itemOf(doc, target)) return;
      }
    }
    const name = labelOf(target, it);
    change((d) => M.removeItem(d, target));
    haptic('medium');
    if (sel && (M.sameSel(sel, target) || !M.BY_ID.has(sel.kind) || !M.itemOf(doc, sel))) select(null);
    toast(`Deleted ${name}`, { action: { label: 'Undo', onClick: () => { if (undoStep()) select(target, { via: 'undo' }); } } });
  }

  function dup(target) {
    const made = change((d) => M.duplicate(d, target));
    if (!made) return;
    if (made.kind === 'scene') { sheet.push(P.scenePage(ctx, made.id)); return; }
    haptic('medium');
    plan.drop(made);
    select(made, { via: 'add', quiet: true });
  }

  function rotate90() {
    const it = M.itemOf(doc, sel);
    if (!it || !(sel.kind === 'furniture' || (sel.kind === 'light' && it.type === 'strip'))) return;
    change((d) => { const x = M.itemOf(d, sel); x.rot = (((Math.round((x.rot || 0) - 90)) % 360) + 360) % 360; });
  }

  // Arrow keys: 5 cm (50 cm with Shift). A room takes what is in it along.
  function nudge(dx, dz) {
    if (!sel || sel.kind === 'scene') return;
    change((d) => {
      const it = M.itemOf(d, sel);
      if (!it) return;
      const mv = (p) => [M.fix(p[0] + dx), M.fix(p[1] + dz)];
      if (sel.kind === 'room') {
        const ride = M.riders(d, it);
        for (const r of [it, ...ride.rooms]) M.moveRoom(r, dx, dz);
        for (const o of [...ride.lights, ...ride.acs, ...ride.furniture]) o.pos = mv(o.pos);
        for (const o of ride.openings) { o.from = mv(o.from); o.to = mv(o.to); }
      } else if (sel.kind === 'light') {
        it.pos = mv(it.pos);
        const r = M.roomAt(d, it.pos);
        if (r) it.room = r.id;
      } else if (sel.kind === 'ac') {
        M.snapAC(d, it, mv(it.pos));
      } else if (sel.kind === 'furniture') {
        it.pos = mv(it.pos);
      } else if (sel.kind === 'opening') {
        // Along its wall, at whatever angle: the arrow's share in the wall's direction.
        const line = M.wallOf(d, it);
        const s = M.openingSpan(it);
        const on = line || s;
        const t = M.fix(dx * on.dir[0] + dz * on.dir[1]);
        if (Math.abs(t) < 0.005) return;
        const [p, q] = [it.from, it.to].map((pt) => pt[0] * on.dir[0] + pt[1] * on.dir[1]);
        const a0 = Math.min(p, q);
        const a = line ? M.clamp(a0 + t, line.a, line.b - s.w) : a0 + t;
        M.setOpeningSpan(it, { dir: on.dir, n: on.n, c: on.c, a, b: a + s.w });
      }
    }, { key: `nudge-${sel.kind}-${sel.id ?? sel.index}` });
    plan.reveal(sel, { animate: 160 });
  }

  /* ---------- drawing a room ---------- */

  function startDrawing() {
    set3D(false);
    if (layout === 'narrow') {
      if (sheet.depth > 1 || sel) select(null);
      sheet.setDetent('peek');
    }
    plan.startDrawing();
    el.classList.add('drawing');
  }

  function cancelDrawing() {
    plan.stopDrawing();
    el.classList.remove('drawing');
  }

  function drawn(rect) {
    el.classList.remove('drawing');
    const made = add((d) => M.selOf(d, 'room', M.addRoom(d, { name: 'Room', size: [rect[2], rect[3]], floor: 'oak' }, { rect })));
    if (!made) return;
    // The name field is ready to type in.
    setTimeout(() => {
      const input = sheet.el.querySelector(`[data-key="name-room-${CSS.escape(made.id)}"]`);
      if (input && layout === 'wide') { input.focus({ preventScroll: true }); input.select(); }
    }, 420);
  }

  /* ---------- saving ---------- */

  let savedCanon = canon(doc);
  let status = canSave ? 'saved' : 'preview';
  let lastError = '';
  let saveTimer = 0;
  let retryTimer = 0;
  let running = null;
  let again = false;
  let quietTimer = 0;

  const unsaved = () => canSave && canon(doc) !== savedCanon;

  function renderStatus() {
    let kind = status;
    let text;
    let ic = null;
    if (issue) { kind = 'invalid'; text = issue; ic = 'warning'; } else if (status === 'preview') { text = 'Preview, not saved'; ic = 'info'; } else if (status === 'saving') { text = 'Saving…'; ic = 'spinner'; } else if (status === 'error') { text = 'Not saved, tap to retry'; ic = 'alert'; } else if (status === 'offline') { text = 'Offline, retrying…'; ic = 'offline'; } else { text = 'Saved'; ic = 'check'; }
    statusEl.className = `ed-status ${kind}`;
    statusEl.title = kind === 'error' ? lastError : kind === 'invalid' ? issue : '';
    statusEl.disabled = !(kind === 'error' || kind === 'offline');
    statusEl.replaceChildren(icon(ic, 12, 2.6), h('span', text));
    clearTimeout(quietTimer);
    if (kind === 'saved') quietTimer = setTimeout(() => statusEl.classList.add('quiet'), 1800);
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    if (!canSave || issue) { renderStatus(); return; }
    if (!unsaved() && !running) { status = 'saved'; renderStatus(); return; }
    status = 'saving';
    renderStatus();
    saveTimer = setTimeout(() => flush(), SAVE_DELAY);
  }

  /** Saves now (and whatever changes meanwhile); resolves true once everything is saved. */
  function flush() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (!canSave) return Promise.resolve(true);
    if (running) { again = true; return running; }
    running = (async () => {
      let ok;
      do {
        again = false;
        ok = await saveOnce();
      } while (ok && !issue && (again || unsaved()));
      return ok;
    })().finally(() => { running = null; });
    return running;
  }

  async function saveOnce() {
    if (issue) { renderStatus(); return false; }
    const sent = canon(doc);
    if (sent === savedCanon) { status = 'saved'; renderStatus(); return true; }
    status = 'saving';
    renderStatus();
    const config = JSON.parse(JSON.stringify(doc));
    const epoch = remoteEpoch;
    try {
      await call('savePlan', isHub ? { config, client: CLIENT_ID } : { config });
      // A remote save can arrive before this request's response. Keep that newer
      // baseline so our pending local edit is actually written over it once more.
      if (epoch === remoteEpoch) savedCanon = sent;
      clearTimeout(retryTimer);
      status = canon(doc) === savedCanon ? 'saved' : 'saving';
      renderStatus();
      return true;
    } catch (e) {
      lastError = e.message || String(e);
      status = OFFLINE.test(lastError) ? 'offline' : 'error';
      renderStatus();
      clearTimeout(retryTimer);
      if (status === 'offline') retryTimer = setTimeout(() => { if (!destroyed && unsaved()) flush(); }, RETRY_MS);
      return false;
    }
  }

  /* ---------- another screen saved the plan ---------- */

  function adoptRemote(raw, from = 'another screen') {
    if (destroyed || !raw) return;
    // Never under a finger: taken when the drag ends.
    if (plan.pressed) { deferredRemote = [raw, from]; return; }
    const theirs = canon(raw);
    if (theirs === canon(doc)) { savedCanon = theirs; if (status !== 'preview') { status = 'saved'; renderStatus(); } return; }
    remoteEpoch++;
    if (unsaved()) {
      // Last writer wins: ours is about to be saved over it.
      savedCanon = theirs;
      toast('Another screen changed the plan. Your edit replaces it.');
      scheduleSave();
      return;
    }
    pushUndo(JSON.stringify(doc));
    doc = M.ensureArrays(structuredClone(raw));
    savedCanon = theirs;
    const keep = sel;
    sel = keep && M.itemOf(doc, keep) ? keep : null;
    issue = M.check(doc).error;
    plan.render();
    if (keep && !sel) sheet.show(rootPages(), { animate: 'fade' }); else refreshSheet();
    syncHistory();
    if (status !== 'preview') status = 'saved';
    renderStatus();
    schedulePreview();
    toast(`Updated from ${from}`);
  }

  /* ---------- 3D preview (P1) ---------- */

  let preview = null;
  let previewTimer = 0;
  let previewRO = null;

  function previewStore(cfg) {
    const state = { lights: {}, acs: {} };
    for (const l of cfg.lights) {
      const s = store?.state.lights[l.id];
      state.lights[l.id] = s && store.lightCfg.has(l.id) ? { ...s } : { on: true, brightness: 0.85, temp: 2700, color: l.color || null };
    }
    for (const a of cfg.acs) {
      const s = store?.state.acs[a.id];
      state.acs[a.id] = s && store.acCfg.has(a.id) ? { ...s } : { on: true, mode: 'cool', fan: 'auto', swing: 'swing', sleep: false, target: a.unit === 'F' ? 72 : 22 };
    }
    return { state, on: () => () => {} };
  }

  function applyPreviewInsets() {
    if (!preview) return;
    const ins = insets();
    preview.setInsets(ins.top + 10, layout === 'narrow' ? ins.bottom + 10 : 16);
  }

  function disposePreview() {
    clearTimeout(previewTimer);
    previewRO?.disconnect();
    previewRO = null;
    preview?.dispose();
    preview = null;
    previewHost.replaceChildren();
  }

  function buildPreview() {
    const cfg = M.check(doc).config;
    disposePreview();
    if (!view3d) return;
    if (!cfg) { previewHost.append(h('div.ed-3d-note', icon('warning', 18, 2.2), h('span', issue || 'This plan cannot be shown yet'))); return; }
    const canvas = h('canvas');
    previewHost.append(canvas);
    try {
      preview = createWorld(canvas, cfg, previewStore(cfg), {
        onHover() {},
        onPick(t) {
          if (t && (t.kind === 'light' || t.kind === 'ac' || t.kind === 'room')) select({ kind: t.kind, id: t.id }, { via: '3d' });
        },
      });
      applyPreviewInsets();
      preview.setRunning(true);
      const w = preview;
      previewRO = new ResizeObserver(() => { if (preview === w) w.resize(); });
      previewRO.observe(canvas);
    } catch (e) {
      disposePreview();
      previewHost.append(h('div.ed-3d-note', icon('warning', 18, 2.2), h('span', String(e.message || e))));
    }
  }

  function schedulePreview() {
    if (!view3d) return;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(buildPreview, 400);
  }

  function set3D(on) {
    if (on === view3d) return;
    view3d = on;
    if (on && plan.drawing) cancelDrawing();
    el.classList.toggle('three', on);
    drawViewToggle();
    if (on) buildPreview(); else disposePreview();
  }

  /* ---------- plan files ---------- */

  function download() {
    const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' })), download: `${M.slug(doc.name || 'home')}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function exportPlan() {
    if (!isNative) { download(); toast('Plan downloaded'); return; }
    try {
      const r = await call('exportPlan', { config: doc });
      if (r?.ok) toast('Plan exported');
    } catch (e) { toast(e.message, { tone: 'bad' }); }
  }

  function takePlan(json) {
    const { error } = M.check(json);
    if (error) { toast(`Not a valid plan: ${error}`, { tone: 'bad' }); return; }
    change((d) => {
      for (const k of Object.keys(d)) delete d[k];
      Object.assign(d, M.ensureArrays(structuredClone(json)));
    });
    select(null);
    plan.fit({ animate: 450 });
    toast('Plan imported', { action: { label: 'Undo', onClick: () => undoStep() } });
  }

  async function importPlan() {
    if (isNative) {
      try {
        const r = await call('importPlan');
        if (r?.config) takePlan(r.config);
      } catch (e) { toast(e.message, { tone: 'bad' }); }
      return;
    }
    const input = h('input', { type: 'file', accept: 'application/json,.json', style: { display: 'none' } });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      try { takePlan(JSON.parse(await file.text())); } catch (e) { toast(`Could not read the file: ${e.message}`, { tone: 'bad' }); }
    });
    document.body.append(input);
    input.click();
  }

  /* ---------- keyboard ---------- */

  function onKey(ev) {
    if (destroyed || !el.isConnected || el.classList.contains('leaving')) return;
    if (el.querySelector('.ed-action-sheet')) return; // it answers its own keys
    const mod = ev.metaKey || ev.ctrlKey;
    const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
    const active = document.activeElement;
    const typing = active && (/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName) || active.isContentEditable);
    if (mod && key === 's') { ev.preventDefault(); flush(); return; }
    if (typing) return;
    if (mod && key === 'z') { ev.preventDefault(); if (ev.shiftKey) redoStep(); else undoStep(); return; }
    if (mod && key === 'y') { ev.preventDefault(); redoStep(); return; }
    if (mod && key === 'd') { ev.preventDefault(); if (sel) dup(sel); return; }
    if (mod || ev.altKey) return;
    if (key === 'Escape') {
      ev.preventDefault();
      // In the panel, Esc never closes the editor: Done does.
      if (plan.drawing) cancelDrawing();
      else if (sheet.depth > 1) sheet.pop();
      else if (sel) select(null);
      return;
    }
    if (key === 'Delete' || key === 'Backspace') {
      if (sel && sel.kind !== 'scene') { ev.preventDefault(); remove(sel); }
      return;
    }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[key] && sel) {
      // Arrows inside a control (a segmented row, a chip) keep their own meaning.
      if (active && sheet.el.contains(active)) return;
      ev.preventDefault();
      const step = ev.shiftKey ? 0.5 : 0.05;
      nudge(arrows[key][0] * step, arrows[key][1] * step);
      return;
    }
    if (key === 'r') { rotate90(); }
  }
  window.addEventListener('keydown', onKey);

  /* ---------- live state ---------- */

  const unsubscribe = store?.on((c) => {
    if (c?.type === 'tick') return;
    plan.render();
    if (sheet.top?.key?.startsWith('item:light:')) refreshSheet();
  });
  // The TVs found (and their names) show on a TV piece's page and in its picker.
  let tvsSeen = '';
  const unsubscribeTv = tv.subscribe((state) => {
    const seen = `${tv.ready}|${state.error}|${state.devices.map((d) => `${d.id}:${d.name}:${d.online}:${d.on}:${d.app?.id}`).join(',')}`;
    if (seen === tvsSeen) return;
    tvsSeen = seen;
    const key = sheet.top?.key || '';
    if (key === 'tv-picker' || key.startsWith('item:furniture:')) refreshSheet();
  });

  /* ---------- done ---------- */

  async function done() {
    plan.cancelGesture();
    if (plan.drawing) cancelDrawing();
    if (document.activeElement && el.contains(document.activeElement)) document.activeElement.blur();
    if (issue) { toast(`This plan cannot be used yet: ${issue}`, { tone: 'bad' }); return null; }
    if (canSave) {
      doneBtn.classList.add('busy');
      const ok = await flush();
      doneBtn.classList.remove('busy');
      if (!ok) {
        const i = await actionSheet(el, {
          title: 'Your last change is not saved',
          message: status === 'offline' ? 'The hub on the Mac cannot be reached.' : lastError,
          actions: [{ label: 'Try again' }, { label: 'Leave without saving', destructive: true }],
        });
        if (i === 0) return done();
        if (i !== 1) return null;
      }
    }
    await plan.fit({ animate: 250 });
    return structuredClone(doc);
  }

  let finishing = false;
  async function finish() {
    if (finishing) return;
    finishing = true;
    try {
      const d = await done();
      if (d) { haptic('success'); await opts.onDone?.(d); }
    } finally {
      finishing = false;
    }
  }

  /* ---------- start ---------- */

  function start() {
    layoutNow();
    plan.measure();
    if (opts.initialView) plan.setView(opts.initialView); else plan.fit({ animate: 0 });
    plan.renderNow();
    sheet.show(rootPages(), { animate: false, detent: 'peek' });
    syncHistory();
    issue = M.check(doc).error;
    renderStatus();
    openSection(opts.section);
  }

  // HOUSE_OPEN_EDITOR / ?section= open a connection screen.
  function openSection(section) {
    if (!section) return;
    const service = section.startsWith('service:') ? section.slice(8) : section === 'tuya' ? 'smartlife' : null;
    if (section !== 'connections' && !service) return;
    sheet.push(links.overviewPage(ctx), { detent: 'large' });
    if (service) sheet.push(links.servicePage(ctx, service), { detent: 'large' });
  }

  if (host) { host.append(el); start(); }

  const api = {
    el,
    plan,
    sheet,
    get doc() { return doc; },
    get sel() { return sel; },
    get layout() { return layout; },
    get status() { return issue ? 'invalid' : status; },
    view: () => plan.view,
    fitInsets: () => insets(),
    select: (next, o) => select(next, { via: 'code', ...o }),
    undo: undoStep,
    redo: redoStep,
    flush,
    links,
    adoptRemote,
    done,
    /** Overlay: the plan fades in over the 3D view, the bar and the sheet slide in. */
    async enter() {
      el.classList.add('entering');
      start();
      await frame();
      await frame();
      sheet.el.style.transition = 'transform 560ms cubic-bezier(0.32, 0.72, 0, 1)';
      el.classList.remove('entering');
      await wait(230);
      plan.insetsChanged({ animate: 560 });
    },
    /** The plan and the chrome fade away, uncovering what is underneath. */
    async leave() {
      sheet.el.style.transition = '';
      el.classList.add('leaving');
      await wait(320);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      window.removeEventListener('keydown', onKey);
      ro.disconnect();
      plan.destroy();
      disposePreview();
      unsubscribe?.();
      unsubscribeTv();
      smartLife?.stop();
      links.stopPairing?.();
      clearTimeout(saveTimer);
      clearTimeout(retryTimer);
      clearTimeout(quietTimer);
      clearTimeout(settleTimer);
      if (formHooks.afterHold) formHooks.afterHold = null;
      toaster.hide();
      if (window.__editor === api) delete window.__editor;
    },
  };
  window.__editor = api;
  return api;
}

/* ---------- standalone page (the Mac's editor window, the iPhone app, ?mode=editor) ---------- */

export async function bootEditor(app) {
  const raw = await loadRawConfig();
  const boot = window.__HOUSE_BOOT__ || {};
  // In the Mac app's window Done only shows when the app can close it (newer builds say so);
  // the window's own close button always works.
  const showDone = isNative ? isPhone || Boolean(boot.canClose) : true;
  app.replaceChildren();
  const editor = createEditor(app, {
    raw,
    mode: 'standalone',
    canSave: isNative || isHub,
    showDone,
    section: boot.section || new URLSearchParams(location.search).get('section') || '',
    onDone: async (doc) => {
      if (!isNative && !isHub) {
        editor.destroy();
        editor.el.remove();
        const { showPreviewPanel } = await import('../main.js');
        await showPreviewPanel(doc);
      } else leave();
    },
  });

  // A plan saved on the other device (the hub, the paired iPhone) while this is open.
  incoming.planArrived = (config, from) => editor.adoptRemote(config, from || 'your other device');
  // Served by the hub: a plan saved anywhere else arrives as a reload event.
  listenForPlanChanges(async (update) => {
    if (update?.by === CLIENT_ID) return;
    const res = await fetch('./api/plan', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    editor.adoptRemote(await res.json(), 'another screen');
  });
  post('ready');
  return editor;
}

// Back to the panel: the native shell closes the editor's window or screen; served by the
// hub (or a plain browser), the editor is the panel's own page with ?mode=editor.
function leave() {
  if (isNative) { post('close'); return; }
  const url = new URL(location.href);
  url.searchParams.delete('mode');
  url.searchParams.delete('section');
  location.href = url.href;
}
