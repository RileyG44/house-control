// The TV sheet's controls: the swipe pad of a touch remote, the volume pill and the title
// search. Each one only reports what was asked (`onKey`, `onVolume`, …); the panel sends it
// to the TV.
import { h, clamp } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { haptic, isPhone } from '../bridge.js';
import { logoSVG, appInfo, APPS } from './apps.js';

const HOLD = 300;       // ms before a held volume button repeats…
const REPEAT = 120;     // …and then every this many ms
const ARROWS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

// The swipe pad: what tells a tap from a swipe from a held finger.
const TAP_SLOP = 10;    // px a tap may wander
const PRESS_MS = 500;   // a tap is let go within this (most take under 220 ms); held longer, it is neither
const SWIPE = 24;       // px before a move is a swipe (and never also a tap): one step…
const STEP = 44;        // …and one more for every this many px on
const MAX_STEPS = 8;    // per gesture
const FLICK = 1.2;      // px/ms at release: one more step (and two past twice that)
const HINT_KEY = 'house.padUsed';
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

/**
 * The swipe pad: swipe to move (a step per stretch of travel, like a touchpad; a fast flick
 * goes a step or two further), tap to select. A ring spreads from a tap; each step glows
 * toward the edge it moves to, and a faint light follows the finger. A tick you can feel
 * with each (the iPhone's keyboard tick; a Mac's trackpad). Holding still sends nothing.
 * Arrow keys, Enter, Space (play/pause) and Backspace or Escape (back) work while it has focus.
 */
export function createPad({ onKey }) {
  const glow = h('span.tv-swipe-glow');
  const finger = h('span.tv-swipe-finger');
  const edges = Object.fromEntries(['up', 'right', 'down', 'left'].map((d) => [d, h(`span.tv-swipe-edge.${d}`)]));
  let used = false;
  try { used = sessionStorage.getItem(HINT_KEY) === '1'; } catch { /* no storage */ }
  const hint = h('span.tv-swipe-hint', { 'aria-hidden': 'true' }, 'Swipe to move · Tap to select');
  const el = h(`div.tv-swipe${used ? '.used' : ''}`, { tabindex: 0, role: 'group', 'aria-label': 'Touch pad: swipe or use the arrow keys to move, tap or Enter to select' },
    glow, ...Object.values(edges), finger, hint);

  let g = null;        // the finger: { id, x, y, t, ax, ay, steps, swiping, trail, timer }
  let follow = 0;      // the finger light's next frame

  const firstUse = () => {
    if (used) return;
    used = true;
    el.classList.add('used');
    try { sessionStorage.setItem(HINT_KEY, '1'); } catch { /* no storage */ }
  };
  const local = (ev) => {
    const r = el.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top, w: r.width, h: r.height };
  };
  const send = (key) => { haptic('tick', { drag: true }); onKey(key); };

  /* ---------- halos ---------- */

  // A tap: a ring spreads from the finger and fades, over a brief glow under it.
  function ring(x, y) {
    if (reduced.matches) { glowAt(x, y, 0.5); return; }
    const r = el.appendChild(h('span.tv-swipe-ring'));
    r.style.left = `${x}px`;
    r.style.top = `${y}px`;
    r.animate([{ transform: 'translate(-50%, -50%) scale(0.25)', opacity: 0.85 }, { transform: 'translate(-50%, -50%) scale(1.7)', opacity: 0 }],
      { duration: 380, easing: 'cubic-bezier(.2, .7, .3, 1)' }).onfinish = () => r.remove();
    glowAt(x, y, 0.9);
  }

  function glowAt(x, y, strength) {
    glow.style.left = `${x}px`;
    glow.style.top = `${y}px`;
    glow.animate([{ opacity: strength, transform: 'translate(-50%, -50%) scale(0.7)' }, { opacity: 0, transform: 'translate(-50%, -50%) scale(1.15)' }],
      { duration: 420, easing: 'ease-out' });
  }

  // A step: a soft light travels from the finger toward the edge it moves to, and that
  // edge brightens.
  function stepHalo(dir, x, y) {
    const e = edges[dir];
    e.animate([{ opacity: 0 }, { opacity: 1, offset: 0.25 }, { opacity: 0 }], { duration: 460, easing: 'ease-out' });
    if (reduced.matches) return;
    const b = el.appendChild(h('span.tv-swipe-step'));
    b.style.left = `${x}px`;
    b.style.top = `${y}px`;
    const r = el.getBoundingClientRect();
    const [dx, dy] = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[dir];
    const reach = Math.min(dx ? r.width : r.height, 160) * 0.42;
    b.animate([
      { transform: 'translate(-50%, -50%) scale(0.6)', opacity: 0.9 },
      { transform: `translate(calc(-50% + ${dx * reach}px), calc(-50% + ${dy * reach}px)) scale(1.05)`, opacity: 0 },
    ], { duration: 420, easing: 'cubic-bezier(.25, .8, .35, 1)' }).onfinish = () => b.remove();
  }

  function moveFinger(x, y) {
    cancelAnimationFrame(follow);
    follow = requestAnimationFrame(() => { finger.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`; });
  }

  function step(gesture, dir, at) {
    if (gesture.steps >= MAX_STEPS) return;
    gesture.steps++;
    send(dir);
    stepHalo(dir, at.x, at.y);
  }

  /* ---------- the finger ---------- */

  el.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || g) return;
    el.setPointerCapture(ev.pointerId);
    const p = local(ev);
    g = { id: ev.pointerId, x: p.x, y: p.y, t: ev.timeStamp, ax: p.x, ay: p.y, steps: 0, swiping: false, moved: 0, trail: [[ev.timeStamp, p.x, p.y]] };
    el.classList.add('touching');
    finger.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`;
  });

  el.addEventListener('pointermove', (ev) => {
    if (!g || ev.pointerId !== g.id) return;
    const p = local(ev);
    g.trail.push([ev.timeStamp, p.x, p.y]);
    while (g.trail.length > 2 && ev.timeStamp - g.trail[0][0] > 80) g.trail.shift();
    g.moved = Math.max(g.moved, Math.hypot(p.x - g.x, p.y - g.y));
    moveFinger(p.x, p.y);
    if (!g.swiping) {
      if (g.moved < SWIPE) return;
      // A swipe from here on: its first step goes the way it went the most.
      g.swiping = true;
      el.classList.add('swiping');
      firstUse();
      const dx = p.x - g.x;
      const dy = p.y - g.y;
      step(g, Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'), p);
      g.ax = p.x;
      g.ay = p.y;
      return;
    }
    // On from there, like a touchpad: a step for every STEP px along the way it goes.
    const ax = p.x - g.ax;
    const ay = p.y - g.ay;
    if (Math.abs(ax) >= STEP && Math.abs(ax) >= Math.abs(ay)) {
      g.ax += Math.sign(ax) * STEP;
      g.ay = p.y;
      step(g, ax > 0 ? 'right' : 'left', p);
    } else if (Math.abs(ay) >= STEP) {
      g.ay += Math.sign(ay) * STEP;
      g.ax = p.x;
      step(g, ay > 0 ? 'down' : 'up', p);
    }
  });

  const finish = (ev) => {
    if (!g || ev.pointerId !== g.id) return;
    const d = g;
    g = null;
    el.classList.remove('touching', 'swiping');
    if (ev.type !== 'pointerup') return;
    const p = local(ev);
    const held = ev.timeStamp - d.t;
    const [t0, x0, y0] = d.trail[0];
    const dt = Math.max(1, ev.timeStamp - t0);
    const vx = (p.x - x0) / dt;
    const vy = (p.y - y0) / dt;
    const v = Math.max(Math.abs(vx), Math.abs(vy));
    const dir = Math.abs(vx) > Math.abs(vy) ? (vx > 0 ? 'right' : 'left') : (vy > 0 ? 'down' : 'up');
    if (!d.swiping) {
      if (d.moved < TAP_SLOP && held <= PRESS_MS) {
        // A tap (a quick one, or a slower one that stayed put): select.
        firstUse();
        send('ok');
        ring(d.x, d.y);
      } else if (d.moved >= TAP_SLOP && v > FLICK * 0.5) {
        // Too short for a swipe but quick: a flick, one step.
        firstUse();
        step(d, dir, p);
      }
      return;
    }
    // A fast flick at the end goes a step or two further, the way it was going.
    if (v > FLICK) {
      const extra = Math.min(MAX_STEPS - d.steps, v > FLICK * 2 ? 2 : 1);
      for (let i = 1; i <= extra; i++) {
        setTimeout(() => { send(dir); stepHalo(dir, p.x, p.y); }, 70 * i);
      }
    }
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
  el.addEventListener('lostpointercapture', finish);
  // No page scroll, magnifier or menu from a finger on the pad.
  el.addEventListener('touchmove', (ev) => { if (ev.cancelable) ev.preventDefault(); }, { passive: false });
  el.addEventListener('contextmenu', (ev) => ev.preventDefault());

  /* ---------- the keyboard ---------- */

  // `escape`: Escape is the TV's Back (the pad has focus) rather than "close the sheet".
  function key(ev, escape) {
    if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.repeat && !ARROWS[ev.key]) return false;
    const name = ARROWS[ev.key] || (ev.key === 'Enter' ? 'ok' : ev.key === ' ' ? 'playpause'
      : ev.key === 'Backspace' || (escape && ev.key === 'Escape') ? 'back' : null);
    if (!name) return false;
    ev.preventDefault();
    ev.stopPropagation();
    send(name);
    const r = el.getBoundingClientRect();
    if (name === 'ok') ring(r.width / 2, r.height / 2);
    else if (ARROWS[ev.key]) stepHalo(name, r.width / 2, r.height / 2);
    return true;
  }
  el.addEventListener('keydown', (ev) => key(ev, true));

  return {
    el,
    /** A key pressed anywhere in the sheet (not in a field): true when the pad took it. */
    key: (ev) => key(ev, false),
    stop() { g = null; cancelAnimationFrame(follow); el.classList.remove('touching', 'swiping'); },
  };
}

/** A round button that repeats while held (the volume's − and +). */
function repeater(label, name, onStep) {
  let hold = 0;
  let every = 0;
  const stop = () => { clearTimeout(hold); clearInterval(every); };
  const b = h('button.round.tv-step', { 'aria-label': label, title: label });
  b.append(icon(name, 18, 2.2));
  b.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    b.setPointerCapture(ev.pointerId);
    onStep();
    hold = setTimeout(() => { every = setInterval(onStep, REPEAT); }, HOLD);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(type, stop);
  // Keyboard: one step per press.
  b.addEventListener('click', (ev) => { if (ev.detail === 0) onStep(); });
  return { el: b, stop };
}

/**
 * The volume pill: − and + (held, they repeat) either side of the level as a track. Dragging
 * the track sets a level, sent when it is let go. A muted TV shows a struck speaker.
 */
export function createVolume({ onStep, onLevel, vertical = false }) {
  const down = repeater('Volume down', 'minus', () => { haptic('tick'); onStep(-1); });
  const up = repeater('Volume up', 'plus', () => { haptic('tick'); onStep(1); });
  const speaker = h('span.tv-speaker');
  const label = h('span.tv-level');
  const fill = h('span.tv-fill');
  const track = h('div.tv-track', { role: 'slider', 'aria-label': 'Volume', tabindex: 0 }, fill, speaker, label);
  // Upright beside the pad: + at the top, the level rising from the bottom.
  const el = vertical ? h('div.tv-volume.vertical', up.el, track, down.el) : h('div.tv-volume', down.el, track, up.el);

  let shown = { level: 0, max: 25, muted: false };
  let drag = null;
  let mutedIcon = null;
  const paint = (level, max, muted) => {
    fill.style.setProperty('--p', String(max ? clamp(level / max, 0, 1) : 0));
    label.textContent = vertical ? String(level) : `${level} / ${max}`;
    track.classList.toggle('muted', muted);
    track.setAttribute('aria-valuenow', level);
    track.setAttribute('aria-valuemax', max);
    if (mutedIcon !== muted) { speaker.replaceChildren(icon(muted ? 'mute' : 'volume', 16, 2.2)); mutedIcon = muted; }
  };
  const levelAt = (ev) => {
    const r = track.getBoundingClientRect();
    const at = vertical ? (r.bottom - ev.clientY) / r.height : (ev.clientX - r.left) / r.width;
    return Math.round(clamp(at, 0, 1) * shown.max);
  };
  track.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    track.setPointerCapture(ev.pointerId);
    drag = { level: levelAt(ev) };
    track.classList.add('dragging');
    paint(drag.level, shown.max, false);
  });
  track.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const level = levelAt(ev);
    if (level !== drag.level) { drag.level = level; haptic('tick'); paint(level, shown.max, false); }
  });
  const release = (ev) => {
    if (!drag) return;
    const { level } = drag;
    drag = null;
    track.classList.remove('dragging');
    if (ev.type === 'pointerup' && level !== shown.level) onLevel(level);
    else paint(shown.level, shown.max, shown.muted);
  };
  track.addEventListener('pointerup', release);
  track.addEventListener('pointercancel', release);
  track.addEventListener('keydown', (ev) => {
    const d = ev.key === 'ArrowRight' || ev.key === 'ArrowUp' ? 1 : ev.key === 'ArrowLeft' || ev.key === 'ArrowDown' ? -1 : 0;
    if (!d) return;
    ev.preventDefault();
    ev.stopPropagation();
    onStep(d);
  });

  return {
    el,
    set(level, max, muted) {
      shown = { level: level ?? 0, max: max || 25, muted };
      if (!drag) paint(shown.level, shown.max, muted);
    },
    stop() { down.stop(); up.stop(); },
  };
}

/* ---------- search ---------- */

const rentNames = (list) => [...new Set(list.map((s) => s.replace(/\s*\((rent|buy)\)$/i, '')))];

function poster(r) {
  const holder = h('span.tv-poster', h('span.tv-poster-letter', (r.title || '?').replace(/^the\s+/i, '').slice(0, 1).toUpperCase()));
  const tint = appInfo(r.offers?.[0] ? { id: r.offers[0].app } : null)?.glow || '#5b6f8f';
  holder.style.setProperty('--tint', tint);
  if (r.poster) {
    const img = h('img', { src: r.poster, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('load', () => holder.classList.add('loaded'));
    img.addEventListener('error', () => img.remove());
    holder.append(img);
  }
  return holder;
}

/**
 * The search field and its results. `search(q)` resolves { results } or throws with words to
 * show; `onPlay(result, offer)` plays a title in an app; `onTvSearch(q)` and `onType(q)` hand
 * the words to the TV itself.
 */
export function createSearch({ search, onPlay, onTvSearch, onType }) {
  const input = h('input.tv-search-input', {
    type: 'search', placeholder: 'Search movies and shows', autocomplete: 'off', autocorrect: 'off',
    spellcheck: 'false', enterkeyhint: 'search', 'aria-label': 'Search movies and shows',
  });
  const clear = h('button.tv-search-clear', { 'aria-label': 'Clear the search', hidden: true, onclick: () => { input.value = ''; changed(); input.focus(); } }, icon('close', 14, 2.6));
  const field = h('label.tv-search', icon('search', 17, 2.2), input, clear);
  const list = h('div.tv-results', { 'aria-live': 'polite' });
  const el = h('div.tv-search-box', field, list);

  let timer = 0;
  let asked = '';
  let seq = 0;

  function extras(q) {
    return h('div.tv-extra',
      h('button.tv-extra-row', { onclick: () => { haptic('light'); onTvSearch(q); } },
        h('span.tv-extra-icon', icon('tv', 16, 2)), h('span', 'Search on the TV for ', h('b', `“${q}”`))),
      h('button.tv-extra-row', { onclick: () => { haptic('light'); onType(q); } },
        h('span.tv-extra-icon', icon('keyboard', 16, 2)), h('span', 'Type into the TV', h('small', 'for an app’s own search box'))));
  }

  function row(r) {
    const offers = r.offers || [];
    const kind = r.type === 'movie' ? 'Movie' : 'Show';
    const sub = [r.year, kind].filter(Boolean).join(' · ');
    const apps = offers.map((o) => {
      const app = appInfo({ id: o.app }) || APPS[0];
      return h('button.tv-offer', {
        'aria-label': `Play ${r.title} in ${o.name}`, title: `${o.name} · ${o.how}`,
        onclick: (ev) => { ev.stopPropagation(); onPlay(r, o); },
      }, logoSVG(app, 30));
    });
    const note = offers.length ? null
      : h('div.tv-result-note', r.rentOrBuy?.length ? `Rent or buy on ${rentNames(r.rentOrBuy).join(', ')}` : 'Not on the TV’s apps');
    const one = offers.length === 1;
    return h(`div.tv-result${one ? '.playable' : ''}${offers.length ? '' : '.unavailable'}`, {
      role: one ? 'button' : null, tabindex: one ? 0 : null,
      onclick: one ? () => onPlay(r, offers[0]) : null,
      onkeydown: one ? (ev) => { if (ev.key === 'Enter') onPlay(r, offers[0]); } : null,
    }, poster(r), h('div.tv-result-text', h('div.tv-result-title', r.title), h('div.tv-result-sub', sub), note),
    apps.length ? h('div.tv-result-apps', apps) : null);
  }

  async function run(q) {
    const mine = ++seq;
    list.replaceChildren(h('div.tv-results-state', h('span.tv-spin', icon('spinner', 16, 2.4)), 'Searching…'), extras(q));
    let rows;
    try {
      const { results = [] } = await search(q);
      rows = results.length ? results.map(row) : [h('div.tv-results-state', `Nothing found for “${q}”.`)];
    } catch (error) {
      rows = [h('div.tv-results-state.error', icon('alert', 16, 2.2), error.message || 'The streaming catalog didn’t answer.')];
    }
    if (mine !== seq) return;
    list.replaceChildren(...rows, extras(q));
  }

  function changed() {
    const q = input.value.trim();
    clear.hidden = !input.value;
    clearTimeout(timer);
    if (q === asked) return;
    asked = q;
    if (!q) { seq++; list.replaceChildren(); return; }
    timer = setTimeout(() => run(q), 350);
  }
  input.addEventListener('input', changed);
  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation(); // typing is not the pad
    if (ev.key === 'Enter') { clearTimeout(timer); const q = input.value.trim(); if (q) { asked = q; run(q); } input.blur(); }
    if (ev.key === 'Escape' && input.value) { ev.preventDefault(); input.value = ''; changed(); }
  });
  if (isPhone) input.addEventListener('focus', () => setTimeout(() => field.scrollIntoView({ block: 'start', behavior: 'smooth' }), 300));

  return {
    el,
    input,
    /** Shows `q` and its results at once (the screenshots, a deep link). */
    show(q) { input.value = q; asked = q.trim(); clear.hidden = !q; if (asked) run(asked); },
    stop() { clearTimeout(timer); seq++; },
  };
}
