// The controls card as a sheet over the 3D view, with two detents: at rest its top is where
// the model ends; expanded, it stops a little below the top of the screen and the model
// shrinks into the strip left above it. It follows the finger 1:1 (stretching past either
// detent), and when let go it springs to the detent its momentum points at. Its progress `p`
// (0 at rest, 1 expanded) is what the 3D view is framed by, in the same frame.
//
// A finger drags it by its head, or by its content while that content can't scroll the way
// the finger goes: at rest every vertical swipe moves the card (pushing up past the top
// detent scrolls the content on, in the same gesture), and expanded, pulling down on content
// that is scrolled to its top brings the card down. A mouse drags it by its head; a wheel or
// trackpad moves it while the content is at its top. Only `transform` changes as it moves.
import { haptic } from '../bridge.js';

const SLOP = 8;            // px before a press is a drag (reorder.js lifts a tile held still)
const PROJECT = 0.2;       // s of the release velocity that picks the detent
const RESPONSE = 0.4;      // s: the spring's period…
const DAMPING = 0.9;       // …and just under critical: it lands without a visible bounce
const STRETCH = 140;       // px: how far the card gives past a detent, at most
const DECAY = 0.998;       // per ms: content flung after the card reached the top (iOS's rate)
const WHEEL_IDLE = 150;    // ms without a wheel event that ends a wheel gesture

const reduced = matchMedia('(prefers-reduced-motion: reduce)');
// Past a detent the card follows less and less, like iOS's rubber band.
const rubber = (d) => (1 - 1 / ((d * 0.55) / STRETCH + 1)) * STRETCH;

// Where a press must not start moving the card: controls that take the drag themselves.
const OWN_DRAG = '.tv-dpad-disc, .slider-track, .pad, .tv-scrub, .tv-track, input, textarea, select, .menu, [data-own-drag]';

/**
 * `el`: the card. `scrollers`: selector of its scrolling content. `handles`: selector of the
 * parts a mouse drags it by. `canDrag()`: false while something else owns the pointer (a
 * tile being moved). `onProgress(p)`: every frame it moves. `onGrab()`: a drag began.
 * `onDetent(name)`: it settled at 'rest' or 'expanded'. `ticker()`: asks the host's frame
 * loop for a frame and returns true when it will call `tick(now)` (the 3D view's loop, so
 * card and model move in the same frame); otherwise the card runs its own.
 */
export function createDeck({ el, scrollers, handles, canDrag = () => true, onProgress, onGrab, onDetent, ticker }) {
  let rest = 400;     // px from the top of the card's container, at rest…
  let top = 120;      // …and expanded
  let y = rest;       // where it is drawn
  let detent = 'rest';
  let spring = null;  // { to, v (px/s), last, resolve }
  let fling = null;   // content scrolling on after a drag: { scroller, v (px/ms), last }
  let g = null;       // the press: see down()
  let wheel = null;   // a wheel gesture: { timer, travel, samples }
  let raf = 0;
  let drawn = NaN;
  let guard = null;

  const progress = () => (rest - y) / Math.max(1, rest - top);
  const at = (name) => (name === 'expanded' ? top : rest);

  function draw() {
    if (y === drawn) return;
    drawn = y;
    el.style.transform = `translate3d(0, ${Math.round(y * 100) / 100}px, 0)`;
    onProgress?.(progress());
  }

  /* ---------- frames ---------- */

  function request() {
    if (ticker?.()) return;
    if (!raf) raf = requestAnimationFrame((now) => { raf = 0; if (tick(now)) request(); });
  }

  /** One frame: the finger's place, or a step of the spring. True while still moving. */
  function tick(now) {
    if (g?.dragging) {
      y = g.y;
      draw();
      return false;
    }
    let moving = false;
    if (spring) {
      const dt = Math.min(0.064, Math.max(0, (now - spring.last) / 1000));
      spring.last = now;
      // A damped spring toward the detent, in small steps so a slow frame stays stable.
      const w = (2 * Math.PI) / RESPONSE;
      for (let t = 0; t < dt; t += 1 / 240) {
        const h = Math.min(1 / 240, dt - t);
        const a = -w * w * (y - spring.to) - 2 * DAMPING * w * spring.v;
        spring.v += a * h;
        y += spring.v * h;
      }
      if (Math.abs(y - spring.to) < 0.25 && Math.abs(spring.v) < 12) {
        y = spring.to;
        const { resolve } = spring;
        spring = null;
        settled();
        resolve();
      } else moving = true;
    }
    if (fling) {
      const dt = Math.min(64, now - fling.last);
      fling.last = now;
      const before = fling.scroller.scrollTop;
      fling.scroller.scrollTop += fling.v * dt;
      fling.v *= DECAY ** dt;
      if (Math.abs(fling.v) < 0.02 || fling.scroller.scrollTop === before) fling = null;
      else moving = true;
    }
    draw();
    return moving;
  }

  function settled() {
    el.classList.toggle('open', detent === 'expanded');
    el.classList.remove('moving');
    onDetent?.(detent);
  }

  /** Springs (or, with reduced motion, fades) to `name`; resolves when it is there. */
  function set(name, { animate = true, velocity = 0 } = {}) {
    if (name !== 'rest' && name !== 'expanded') return Promise.resolve();
    detent = name;
    spring?.resolve();
    spring = null;
    const to = at(name);
    el.classList.remove('open');
    if (!animate || Math.abs(y - to) < 0.5) {
      y = to;
      draw();
      settled();
      return Promise.resolve();
    }
    if (reduced.matches) {
      // No travel: a short cross-fade of the card at its new place.
      y = to;
      draw();
      el.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
      settled();
      return Promise.resolve();
    }
    el.classList.add('moving');
    return new Promise((resolve) => {
      spring = { to, v: velocity, last: performance.now(), resolve };
      request();
    });
  }

  /* ---------- the finger or the mouse ---------- */

  const scrollerOf = (t) => t?.closest?.(scrollers) || null;
  const isHandle = (t) => Boolean(t?.closest?.(handles));

  function down(ev) {
    if (g || !ev.isPrimary || ev.button !== 0) return;
    fling = null;
    const t = ev.target;
    if (t.closest?.(OWN_DRAG)) return;
    const touch = ev.pointerType !== 'mouse';
    // A mouse moves the card by its head only: on the content it clicks, dims and drags tiles.
    if (!touch && !isHandle(t)) return;
    // A card on its way somewhere stops under the finger.
    if (spring) {
      spring.resolve();
      spring = null;
      el.classList.remove('moving');
    }
    g = {
      id: ev.pointerId, touch, x: ev.clientX, y0: ev.clientY, base: y, y,
      scroller: scrollerOf(t), handle: isHandle(t), dragging: false, decided: false, samples: [],
    };
  }

  // Whether this vertical move is the card's (true) or the content's own scroll.
  function claims(dy) {
    if (detent !== 'expanded' || el.classList.contains('moving') || g.handle) return true;
    if (!g.scroller) return true;
    return g.scroller.scrollTop <= 0 && dy > 0;
  }

  function move(ev) {
    if (!g || ev.pointerId !== g.id) return;
    const dx = ev.clientX - g.x;
    const dy = ev.clientY - g.y0;
    if (!g.decided) {
      if (Math.hypot(dx, dy) < SLOP) return;
      g.decided = true;
      // Sideways first: a dim, a row of chips or apps. Not the card's.
      if (Math.abs(dx) > Math.abs(dy) || !canDrag() || !claims(dy)) { g = null; return; }
      g.dragging = true;
      g.base = y;
      g.y0 = ev.clientY;
      g.scroll0 = g.scroller?.scrollTop ?? 0;
      try { el.setPointerCapture(g.id); } catch { /* gone already */ }
      el.classList.add('dragging');
      onGrab?.();
    }
    if (!g.dragging) return;
    const raw = g.base + (ev.clientY - g.y0);
    if (raw > rest) g.y = rest + rubber(raw - rest);
    else if (raw >= top) { g.y = raw; if (g.scroller) g.scroller.scrollTop = g.scroll0; }
    else if (g.scroller) {
      // Past the top detent the content takes over and scrolls on, in the same gesture.
      g.y = top;
      g.scroller.scrollTop = g.scroll0 + (top - raw);
    } else g.y = top - rubber(top - raw);
    g.raw = raw;
    g.samples.push([ev.timeStamp, raw]);
    while (g.samples.length > 2 && ev.timeStamp - g.samples[0][0] > 90) g.samples.shift();
    request();
  }

  function up(ev) {
    if (!g || ev.pointerId !== g.id) return;
    const d = g;
    g = null;
    if (!d.dragging) {
      // A tap on a card that was stopped mid-way: it carries on to its detent.
      if (Math.abs(y - at(detent)) > 0.5 && !spring) set(detent);
      return;
    }
    el.classList.remove('dragging');
    try { if (el.hasPointerCapture(d.id)) el.releasePointerCapture(d.id); } catch { /* released */ }
    swallowClick();
    // px/s, from the last ~90 ms of the drag.
    const [t0, y0] = d.samples[0] || [0, d.y];
    const [t1, y1] = d.samples[d.samples.length - 1] || [1, d.y];
    const v = t1 > t0 ? ((y1 - y0) / (t1 - t0)) * 1000 : 0;
    const cancelled = ev.type !== 'pointerup';
    if (d.scroller && d.raw < top && !cancelled) {
      // The content had taken over: it glides on, and the card stays up.
      detent = 'expanded';
      y = top;
      settled();
      if (v < -50) fling = { scroller: d.scroller, v: -v / 1000, last: performance.now() };
      request();
      return;
    }
    const projected = y + (cancelled ? 0 : v * PROJECT);
    const next = Math.abs(projected - top) < Math.abs(projected - rest) ? 'expanded' : 'rest';
    if (next !== detent) haptic('tick', { drag: true });
    set(next, { velocity: cancelled ? 0 : v });
  }

  // The click that ends a drag is not a tap on whatever was under the finger.
  function swallowClick() {
    guard?.();
    const swallow = (e) => { e.stopPropagation(); e.preventDefault(); off(); };
    const timer = setTimeout(() => off(), 400);
    const off = () => { window.removeEventListener('click', swallow, true); clearTimeout(timer); guard = null; };
    window.addEventListener('click', swallow, true);
    guard = off;
  }

  el.addEventListener('pointerdown', down, true);
  el.addEventListener('pointermove', move, true);
  el.addEventListener('pointerup', up, true);
  el.addEventListener('pointercancel', up, true);
  el.addEventListener('lostpointercapture', (ev) => { if (g?.dragging && ev.target === el) up(ev); });
  // Expanded, content at its top: a finger pulling down is the card's, not a scroll (Safari
  // knows no `touch-action: pan-down`, so the first move decides, as the press does).
  el.addEventListener('touchmove', (ev) => {
    if (g?.dragging && ev.cancelable) ev.preventDefault();
    else if (g && !g.decided && ev.cancelable && detent === 'expanded' && g.scroller?.scrollTop <= 0) {
      const tch = ev.touches[0];
      if (tch && tch.clientY - g.y0 > 2 && Math.abs(tch.clientY - g.y0) > Math.abs(tch.clientX - g.x)) ev.preventDefault();
    }
  }, { passive: false });

  /* ---------- wheel and trackpad ---------- */

  el.addEventListener('wheel', (ev) => {
    if (ev.ctrlKey || g || Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) return;
    const dy = ev.deltaY * (ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? el.clientHeight : 1);
    const scroller = scrollerOf(ev.target);
    if (!wheel) {
      // Up from rest; down from the top only while the content is at its own top.
      const mine = detent === 'rest' || spring ? true : dy < 0 && (!scroller || scroller.scrollTop <= 0);
      if (!mine || !canDrag() || ev.target.closest?.(OWN_DRAG)) return;
      spring?.resolve();
      spring = null;
      fling = null;
      wheel = { base: y, travel: 0 };
      onGrab?.();
    }
    ev.preventDefault();
    clearTimeout(wheel.timer);
    wheel.travel -= dy;
    const raw = wheel.base + wheel.travel;
    y = raw > rest ? rest + rubber(raw - rest) : raw < top ? top - rubber(top - raw) : raw;
    request();
    // The gesture (and a trackpad's glide after it) is over: to the detent it went toward.
    wheel.timer = setTimeout(() => {
      const w = wheel;
      wheel = null;
      const next = w.travel < -24 ? 'expanded' : w.travel > 24 ? 'rest' : detent;
      if (next !== detent) haptic('tick', { drag: true });
      set(next);
    }, WHEEL_IDLE);
  }, { passive: false });

  return {
    el,
    /** Where the card's top is at rest and expanded (px from its container's top). */
    layout(next) {
      rest = next.rest;
      top = Math.min(next.expanded, rest);
      if (!g?.dragging && !spring && !wheel) y = at(detent);
      drawn = NaN;
      draw();
    },
    set,
    toggle() { return set(detent === 'expanded' ? 'rest' : 'expanded'); },
    tick,
    /** 'rest' or 'expanded': where it is, or where it is going. */
    get detent() { return detent; },
    get progress() { return progress(); },
    get busy() { return Boolean(g?.dragging || spring || wheel); },
    /** Lets go of a press or a drag (the card is about to be rebuilt or covered). */
    cancel() { if (g?.dragging) up({ pointerId: g.id, type: 'pointercancel' }); g = null; },
    dispose() { spring?.resolve(); spring = null; fling = null; clearTimeout(wheel?.timer); guard?.(); cancelAnimationFrame(raf); },
  };
}
