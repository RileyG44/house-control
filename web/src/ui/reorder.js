// Long press a device tile, then drag it: the tile lifts and follows the finger, the tiles
// around it slide out of its way, and it settles into its new place when let go. A tile
// moves within its own room's group only. With a tile focused, Alt (Option) and an arrow
// key move it a place. Tiles are the grid's `.tile` children, each with a `data-key`; a
// `.group-label` starts the next room's group.
import { haptic } from '../bridge.js';

const HOLD = 380;           // ms a press stays still before the tile lifts
const SLOP = 8;             // px it may move first: more is a scroll (or a dim), not a lift
const FLIP_MS = 220;
const FLIP_EASE = 'cubic-bezier(.2, .8, .2, 1)';
const SETTLE_MS = 260;
const SETTLE_EASE = 'cubic-bezier(.3, 1.32, .55, 1)'; // lands with a slight overshoot
const LIFT_SCALE = 1.04;
const EDGE = 52;            // px from the list's top or bottom edge where it scrolls by itself
const SCROLL_MAX = 13;      // px per frame, right at the edge
const STRETCH = 14;         // px a tile can be pulled past its group's edge, at most

const reduced = matchMedia('(prefers-reduced-motion: reduce)');

// Past an edge the tile follows less and less, like a rubber band.
const rubber = (d) => STRETCH * (1 - 1 / (d / (STRETCH * 3) + 1));
const band = (v, lo, hi) => (v < lo ? lo - rubber(lo - v) : v > hi ? hi + rubber(v - hi) : v);

/** A tile's place in the grid's layout (not where an animation is drawing it). */
const slotOf = (el) => ({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });

/**
 * Runs `mutate` (which moves elements in the DOM) and slides each of `els` from where it
 * was drawn to its new place: the F-L-I-P of First, Last, Invert, Play.
 */
export function flip(els, mutate, { duration = FLIP_MS, easing = FLIP_EASE } = {}) {
  const first = new Map(els.map((el) => [el, el.getBoundingClientRect()]));
  for (const el of els) for (const a of el.getAnimations?.() || []) if (a.id === 'flip') a.cancel();
  mutate();
  if (reduced.matches) return;
  for (const el of els) {
    const a = first.get(el);
    const b = el.getBoundingClientRect();
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration, easing, id: 'flip' });
  }
}

/**
 * `onOrder(keys, el)`: a group's tiles were put in a new order (its keys, top to bottom).
 * `announce(text)`: words for a screen reader after a move made with the keyboard.
 */
export function createReorder({ grid, scroller, onOrder, announce }) {
  let press = null;   // a press that may become a lift: { el, opts, id, x, y, lx, ly, timer }
  let drag = null;    // the lifted tile
  let zone = null;    // the lifted tile's group, softly lit behind it
  let clickGuard = null;

  // Escape puts a lifted tile back where it was (and nothing else hears it).
  const onEscape = (ev) => {
    if (ev.key !== 'Escape' || !drag) return;
    ev.preventDefault();
    ev.stopPropagation();
    drop(true);
  };

  /* ---------- groups ---------- */

  function groupOf(el) {
    let cur = [];
    const all = [cur];
    for (const c of grid.children) {
      if (c.classList.contains('group-label')) { cur = []; all.push(cur); } else if (c.classList.contains('tile')) cur.push(c);
    }
    return all.find((g) => g.includes(el)) || [el];
  }

  const labelOf = (group) => {
    let p = group[0]?.previousElementSibling;
    while (p && !p.classList.contains('group-label')) p = p.previousElementSibling;
    return p;
  };

  function bounds(group) {
    const s = group.map(slotOf);
    const left = Math.min(...s.map((r) => r.x));
    const top = Math.min(...s.map((r) => r.y));
    return { left, top, right: Math.max(...s.map((r) => r.x + r.w)), bottom: Math.max(...s.map((r) => r.y + r.h)) };
  }

  function placeZone(group) {
    if (!zone) return;
    const b = bounds(group);
    Object.assign(zone.style, { left: `${b.left - 6}px`, top: `${b.top - 6}px`, width: `${b.right - b.left + 12}px`, height: `${b.bottom - b.top + 12}px` });
  }

  /**
   * Puts `group`'s tiles in the order `next`, sliding them there. `still` (the lifted tile)
   * is never taken out of the page, so it keeps the pointer: the others move around it.
   */
  function arrange(group, next, still, { slide = group.filter((t) => t !== still) } = {}) {
    flip(slide, () => {
      const at = next.indexOf(still);
      for (const t of next.slice(0, at)) grid.insertBefore(t, still);
      let prev = still;
      for (const t of next.slice(at + 1)) { grid.insertBefore(t, prev.nextSibling); prev = t; }
    });
    group.splice(0, group.length, ...next);
    placeZone(group);
  }

  /* ---------- pressing ---------- */

  function cancelPress() {
    if (!press) return;
    clearTimeout(press.timer);
    press = null;
  }

  /**
   * Makes `el` a tile that can be dragged. `canLift()` may say no when the hold ends (a
   * light being dimmed); `onHold()` runs when a lifted tile is let go where it was.
   */
  function attach(el, opts = {}) {
    el.addEventListener('pointerdown', (ev) => {
      if (drag || ev.button !== 0 || !ev.isPrimary) return;
      cancelPress();
      press = { el, opts, id: ev.pointerId, x: ev.clientX, y: ev.clientY, lx: ev.clientX, ly: ev.clientY, top: scroller.scrollTop };
      press.timer = setTimeout(lift, HOLD);
      el.liftedBy = null;
    });
    el.addEventListener('pointermove', (ev) => {
      if (drag?.el === el && ev.pointerId === drag.id) {
        drag.px = ev.clientX;
        drag.py = ev.clientY;
        drag.travel = Math.max(drag.travel, Math.hypot(ev.clientX - drag.sx, ev.clientY - drag.sy));
        frame();
      } else if (press?.el === el && ev.pointerId === press.id) {
        press.lx = ev.clientX;
        press.ly = ev.clientY;
        if (Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > SLOP) cancelPress();
      }
    });
    const end = (ev) => {
      if (drag?.el === el && ev.pointerId === drag.id) drop(ev.type !== 'pointerup');
      else if (press?.el === el) cancelPress();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    // (A child that held the touch loses it to the tile when the tile lifts: that one is fine.)
    el.addEventListener('lostpointercapture', (ev) => { if (drag?.el === el && ev.target === el && ev.pointerId === drag.id) drop(true); });
    // A mouse that wanders off before the hold ends was not holding the tile.
    el.addEventListener('pointerleave', (ev) => { if (press?.el === el && ev.pointerType === 'mouse') cancelPress(); });
    // Once lifted, a finger drags the tile, not the page (and no menu or magnifier appears).
    el.addEventListener('touchmove', (ev) => { if (drag?.el === el && ev.cancelable) ev.preventDefault(); }, { passive: false });
    el.addEventListener('contextmenu', (ev) => { if (press?.el === el || drag?.el === el) ev.preventDefault(); });
    el.addEventListener('keydown', (ev) => {
      if (!ev.altKey || ev.metaKey || ev.ctrlKey) return;
      const dir = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 }[ev.key];
      if (!dir) return;
      ev.preventDefault();
      ev.stopPropagation();
      moveBy(el, dir);
    });
  }

  /* ---------- lifting and dragging ---------- */

  function lift() {
    const p = press;
    press = null;
    // The list moved meanwhile (a slow scroll): the finger was scrolling, not holding.
    if (!p || drag || Math.abs(scroller.scrollTop - p.top) > 2 || (p.opts.canLift && !p.opts.canLift())) return;
    const { el } = p;
    const group = groupOf(el);
    try { el.setPointerCapture(p.id); } catch { /* the pointer is already gone */ }
    const g = grid.getBoundingClientRect();
    drag = {
      el, opts: p.opts, id: p.id, group, start: group.slice(),
      grabX: p.lx - g.left - el.offsetLeft, grabY: p.ly - g.top - el.offsetTop,
      px: p.lx, py: p.ly, sx: p.lx, sy: p.ly, travel: 0, raf: 0,
    };
    el.liftedBy = p.id;
    el.classList.remove('pressed');
    el.classList.add('lifted');
    grid.classList.add('reordering');
    for (const t of grid.querySelectorAll('.tile')) t.classList.toggle('elsewhere', !group.includes(t));
    labelOf(group)?.classList.add('lit');
    zone = grid.appendChild(document.createElement('div'));
    zone.className = 'reorder-zone';
    placeZone(group);
    requestAnimationFrame(() => zone?.classList.add('shown'));
    window.addEventListener('keydown', onEscape, true);
    haptic('medium', { drag: true });
    frame();
  }

  function frame() {
    if (drag && !drag.raf) drag.raf = requestAnimationFrame(step);
  }

  function step() {
    if (!drag) return;
    drag.raf = 0;
    if (autoscroll()) frame();
    follow();
    const next = target();
    if (next) {
      arrange(drag.group, next, drag.el);
      follow();
      haptic('tick', { drag: true });
    }
  }

  // The tile under the finger, 1:1, kept inside its group (with a little give at the edges).
  function follow() {
    const { el } = drag;
    const g = grid.getBoundingClientRect();
    const b = bounds(drag.group);
    const s = slotOf(el);
    drag.x = band(drag.px - g.left - drag.grabX, b.left, b.right - s.w);
    drag.y = band(drag.py - g.top - drag.grabY, b.top, b.bottom - s.h);
    el.style.translate = `${drag.x - s.x}px ${drag.y - s.y}px`;
  }

  // Near the list's top or bottom edge, the list scrolls (while the group goes on that way).
  // Only once the tile is carried toward that edge: one picked up near it stays put.
  function autoscroll() {
    const s = scroller.getBoundingClientRect();
    const g = grid.getBoundingClientRect();
    const b = bounds(drag.group);
    const toward = (dir) => drag.travel >= SLOP && (drag.py - drag.sy) * dir > SLOP;
    let v = 0;
    if (drag.py < s.top + EDGE && g.top + b.top < s.top + 4 && toward(-1)) v = -Math.min(1, (s.top + EDGE - drag.py) / EDGE);
    else if (drag.py > s.bottom - EDGE && g.top + b.bottom > s.bottom - 4 && toward(1)) v = Math.min(1, (drag.py - s.bottom + EDGE) / EDGE);
    if (!v) return false;
    const before = scroller.scrollTop;
    scroller.scrollTop += v * v * Math.sign(v) * SCROLL_MAX + Math.sign(v);
    return scroller.scrollTop !== before;
  }

  /**
   * Where the lifted tile would go, as its group's new order, or null to stay. Its centre
   * picks the nearest other tile and a side of it: above or below a row, left or right of a
   * tile in the grid. A row being dragged passes a whole row of grid tiles at a time.
   */
  function target() {
    const { el, group } = drag;
    const own = slotOf(el);
    const c = { x: drag.x + own.w / 2, y: drag.y + own.h / 2 };
    const inside = (r) => c.x >= r.x && c.x <= r.x + r.w && c.y >= r.y && c.y <= r.y + r.h;
    if (inside(own)) return null;
    const others = group.filter((t) => t !== el).map((t) => ({ t, r: slotOf(t) }));
    if (!others.length) return null;
    const wide = own.w > grid.clientWidth * 0.75;
    let candidates = others;
    if (wide) {
      // A row: the tiles that share a line count as one.
      const lines = new Map();
      for (const o of others) {
        const line = lines.get(o.r.y) || { t: [], r: { x: 0, y: o.r.y, w: grid.clientWidth, h: 0 } };
        line.t.push(o.t);
        line.r.h = Math.max(line.r.h, o.r.h);
        lines.set(o.r.y, line);
      }
      candidates = [...lines.values()];
    }
    const dist = (r) => Math.hypot(Math.max(r.x - c.x, 0, c.x - r.x - r.w), Math.max(r.y - c.y, 0, c.y - r.y - r.h));
    const near = candidates.reduce((a, b) => (dist(b.r) < dist(a.r) ? b : a));
    const r = near.r;
    const full = wide || r.w > grid.clientWidth * 0.75;
    let after;
    if (c.y < r.y) after = false;
    else if (c.y > r.y + r.h) after = true;
    else after = full ? c.y > r.y + r.h / 2 : c.x > r.x + r.w / 2;
    const list = group.filter((t) => t !== el);
    const ts = [].concat(near.t);
    const at = after ? list.indexOf(ts[ts.length - 1]) + 1 : list.indexOf(ts[0]);
    list.splice(at, 0, el);
    return list.every((t, i) => t === group[i]) ? null : list;
  }

  /* ---------- letting go ---------- */

  function drop(cancelled) {
    const d = drag;
    if (!d) return;
    drag = null;
    cancelAnimationFrame(d.raf);
    window.removeEventListener('keydown', onEscape, true);
    const { el } = d;
    if (cancelled && d.group.some((t, i) => t !== d.start[i])) arrange(d.group, d.start.slice(), el);
    const from = el.style.translate || '0px 0px';
    el.style.translate = '';
    el.classList.remove('lifted');
    if (!reduced.matches) {
      // Into its place with a little spring, the shadow fading as it lands.
      el.classList.add('settling');
      const a = el.animate([{ translate: from, scale: String(LIFT_SCALE) }, { translate: '0px 0px', scale: '1' }],
        { duration: SETTLE_MS, easing: SETTLE_EASE });
      a.onfinish = a.oncancel = () => el.classList.remove('settling');
    }
    grid.classList.remove('reordering');
    for (const t of grid.querySelectorAll('.tile.elsewhere')) t.classList.remove('elsewhere');
    for (const l of grid.querySelectorAll('.group-label.lit')) l.classList.remove('lit');
    const z = zone;
    zone = null;
    z?.classList.remove('shown');
    setTimeout(() => z?.remove(), 240);
    try { if (el.hasPointerCapture?.(d.id)) el.releasePointerCapture(d.id); } catch { /* already released */ }
    guardClick();
    const moved = d.group.some((t, i) => t !== d.start[i]);
    if (cancelled) return;
    haptic('light');
    if (moved) onOrder(d.group.map((t) => t.dataset.key), el);
    else if (d.travel < 12) d.opts.onHold?.();
  }

  // The click that follows letting go is not a tap on the tile (or a button on it).
  function guardClick() {
    clickGuard?.();
    const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); off(); };
    const timer = setTimeout(() => off(), 450);
    const off = () => { window.removeEventListener('click', swallow, true); clearTimeout(timer); clickGuard = null; };
    window.addEventListener('click', swallow, true);
    clickGuard = off;
  }

  /* ---------- the keyboard ---------- */

  function moveBy(el, dir) {
    if (drag) return;
    const group = groupOf(el);
    const from = group.indexOf(el);
    const to = Math.min(group.length - 1, Math.max(0, from + dir));
    const where = `${to + 1} of ${group.length}`;
    if (from === to) { announce?.(`${el.getAttribute('aria-label') || 'Tile'} stays at ${where}`); return; }
    const next = group.filter((t) => t !== el);
    next.splice(to, 0, el);
    arrange(group, next, el, { slide: group.slice() });
    el.focus({ preventScroll: true });
    el.scrollIntoView?.({ block: 'nearest', behavior: reduced.matches ? 'auto' : 'smooth' });
    announce?.(`${el.getAttribute('aria-label') || 'Tile'} moved to ${where}`);
    onOrder(next.map((t) => t.dataset.key), el);
  }

  return {
    attach,
    moveBy,
    /** True while a tile is lifted. */
    get busy() { return Boolean(drag); },
    /** Whether the press now ending on `el` lifted it (so it is not a tap). */
    lifted(el) { return el.liftedBy != null; },
    /** Puts every tile back and forgets the press (the list is about to be rebuilt). */
    cancel() { cancelPress(); if (drag) drop(true); },
  };
}
