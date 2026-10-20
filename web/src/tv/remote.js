// The TV sheet's controls: the round pad of a Chromecast remote, the volume pill and the
// title search. Each one only reports what was asked (`onKey`, `onVolume`, …); the panel
// sends it to the TV.
import { h, clamp } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { haptic, isPhone } from '../bridge.js';
import { logoSVG, appInfo, APPS } from './apps.js';

const STEP = 40;        // px of swipe per step
const HOLD = 300;       // ms before a held arrow repeats…
const REPEAT = 120;     // …and then every this many ms
const ARROWS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

/**
 * One big disc: an arrow zone at each side of its rim and OK in the middle. Tap a zone, hold
 * it to repeat, or swipe across the disc like a touchpad (a fast flick goes a few steps).
 * Arrow keys, Enter, Space (play/pause) and Backspace or Escape (back) work while it has focus.
 */
export function createPad({ onKey }) {
  const arrow = (dir, name) => h(`span.tv-arrow.${dir}`, icon(name, 22, 2.4));
  const okEl = h('span.tv-ok', 'OK');
  const el = h('div.tv-pad', { tabindex: 0, role: 'group', 'aria-label': 'Remote pad: arrow keys to move, Enter for OK' },
    h('span.tv-press'),
    arrow('up', 'up'), arrow('right', 'next'), arrow('down', 'down'), arrow('left', 'back'),
    okEl);

  let g = null;
  let flash = 0;
  const press = (zone) => {
    clearTimeout(flash);
    if (zone) el.dataset.press = zone; else delete el.dataset.press;
  };
  const send = (key, kind = 'light') => { haptic(kind); onKey(key); };
  const tap = (key) => {
    press(key);
    send(key);
    flash = setTimeout(() => press(null), 160);
  };

  function zoneAt(ev) {
    const r = el.getBoundingClientRect();
    const dx = ev.clientX - (r.left + r.width / 2);
    const dy = ev.clientY - (r.top + r.height / 2);
    if (Math.hypot(dx, dy) < r.width * 0.22) return 'ok';
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
  }

  function stopRepeat() {
    if (!g) return;
    clearTimeout(g.hold);
    clearInterval(g.repeat);
  }

  el.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    el.setPointerCapture(ev.pointerId);
    const zone = zoneAt(ev);
    g = { zone, x: ev.clientX, y: ev.clientY, ax: ev.clientX, ay: ev.clientY, swiped: false, repeated: false, trail: [[ev.clientX, ev.clientY, ev.timeStamp]] };
    press(zone);
    if (zone !== 'ok') {
      g.hold = setTimeout(() => {
        if (!g || g.swiped) return;
        g.repeated = true;
        send(zone, 'tick');
        g.repeat = setInterval(() => send(zone, 'tick'), REPEAT);
      }, HOLD);
    }
  });

  el.addEventListener('pointermove', (ev) => {
    if (!g) return;
    g.trail.push([ev.clientX, ev.clientY, ev.timeStamp]);
    if (g.trail.length > 8) g.trail.shift();
    if (!g.swiped && !g.repeated && Math.hypot(ev.clientX - g.x, ev.clientY - g.y) > 12) {
      g.swiped = true;
      stopRepeat();
    }
    if (!g.swiped) return;
    // Touchpad: every STEP px along the main direction is one press.
    const ax = ev.clientX - g.ax;
    const ay = ev.clientY - g.ay;
    if (Math.abs(ax) >= STEP && Math.abs(ax) >= Math.abs(ay)) {
      const dir = ax > 0 ? 'right' : 'left';
      g.ax += Math.sign(ax) * STEP;
      g.ay = ev.clientY;
      press(dir);
      send(dir, 'tick');
    } else if (Math.abs(ay) >= STEP) {
      const dir = ay > 0 ? 'down' : 'up';
      g.ay += Math.sign(ay) * STEP;
      g.ax = ev.clientX;
      press(dir);
      send(dir, 'tick');
    }
  });

  const finish = (ev) => {
    if (!g) return;
    stopRepeat();
    const done = g;
    g = null;
    press(null);
    if (ev.type !== 'pointerup') return;
    if (!done.swiped && !done.repeated) { tap(done.zone); return; }
    if (!done.swiped) return;
    // A fast flick keeps going for a few steps.
    const [x0, y0, t0] = done.trail[0];
    const dt = Math.max(1, ev.timeStamp - t0);
    const vx = (ev.clientX - x0) / dt;
    const vy = (ev.clientY - y0) / dt;
    const v = Math.max(Math.abs(vx), Math.abs(vy));
    if (v > 0.9) {
      const dir = Math.abs(vx) > Math.abs(vy) ? (vx > 0 ? 'right' : 'left') : (vy > 0 ? 'down' : 'up');
      const extra = Math.min(3, Math.floor(v / 0.6));
      for (let i = 0; i < extra; i++) setTimeout(() => send(dir, 'tick'), 90 * (i + 1));
    }
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
  el.addEventListener('lostpointercapture', finish);

  // `escape`: Escape is the TV's Back (the pad has focus) rather than "close the sheet".
  function key(ev, escape) {
    if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.repeat && !ARROWS[ev.key]) return false;
    const name = ARROWS[ev.key] || (ev.key === 'Enter' ? 'ok' : ev.key === ' ' ? 'playpause'
      : ev.key === 'Backspace' || (escape && ev.key === 'Escape') ? 'back' : null);
    if (!name) return false;
    ev.preventDefault();
    ev.stopPropagation();
    if (name === 'playpause') send(name); else tap(name);
    return true;
  }
  el.addEventListener('keydown', (ev) => key(ev, true));

  return {
    el,
    /** A key pressed anywhere in the sheet (not in a field): true when the pad took it. */
    key: (ev) => key(ev, false),
    stop() { stopRepeat(); g = null; clearTimeout(flash); },
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
export function createVolume({ onStep, onLevel }) {
  const down = repeater('Volume down', 'minus', () => { haptic('tick'); onStep(-1); });
  const up = repeater('Volume up', 'plus', () => { haptic('tick'); onStep(1); });
  const speaker = h('span.tv-speaker');
  const label = h('span.tv-level');
  const fill = h('span.tv-fill');
  const track = h('div.tv-track', { role: 'slider', 'aria-label': 'Volume', tabindex: 0 }, fill, speaker, label);
  const el = h('div.tv-volume', down.el, track, up.el);

  let shown = { level: 0, max: 25, muted: false };
  let drag = null;
  let mutedIcon = null;
  const paint = (level, max, muted) => {
    fill.style.setProperty('--p', String(max ? clamp(level / max, 0, 1) : 0));
    label.textContent = `${level} / ${max}`;
    track.classList.toggle('muted', muted);
    track.setAttribute('aria-valuenow', level);
    track.setAttribute('aria-valuemax', max);
    if (mutedIcon !== muted) { speaker.replaceChildren(icon(muted ? 'mute' : 'volume', 16, 2.2)); mutedIcon = muted; }
  };
  const levelAt = (ev) => {
    const r = track.getBoundingClientRect();
    return Math.round(clamp((ev.clientX - r.left) / r.width, 0, 1) * shown.max);
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
