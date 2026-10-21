// The TV sheet's controls: the direction pad of a remote, the volume pill and the title
// search. Each one only reports what was asked (`onKey`, `onVolume`, …); the panel sends it
// to the TV.
import { h, clamp } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { haptic, isPhone } from '../bridge.js';
import { logoSVG, appInfo, APPS } from './apps.js';

const HOLD = 300;       // ms before a held button (an arrow, the volume's − and +) repeats…
const REPEAT = 120;     // …and then every this many ms
const ARROWS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

// The direction pad, as fractions of its diameter.
const OK_SIZE = 0.4;    // the round OK button in the middle
const DEAD = 0.035;     // a ring around OK where a press is neither OK nor an arrow
const DIRS = ['up', 'right', 'down', 'left'];
const CHEVRON = { up: 'up', right: 'next', down: 'down', left: 'back' };
const DIR_LABEL = { up: 'Up', right: 'Right', down: 'Down', left: 'Left' };

/**
 * The direction pad of a Chromecast remote: one disc, an arrow at each quarter of its rim and
 * a round OK in the middle. A press on a quarter moves that way at once (held, it repeats:
 * after 300 ms, then every 120 ms), a press on OK selects; the quarter or OK pressed lights up,
 * and each step is a tick you can feel. Nothing is a swipe: where the finger goes after the
 * press does not matter. Arrow keys, Enter, Space (play/pause) and Backspace or Escape (back)
 * work while it has focus.
 *
 * (It replaced a swipe pad, which moved a step per stretch of a swipe: hard to control.)
 */
export function createPad({ onKey }) {
  const zones = Object.fromEntries(DIRS.map((d) => [d, h(`button.tv-dpad-zone.${d}`,
    { tabindex: -1, 'aria-label': DIR_LABEL[d], onclick: (ev) => { if (ev.detail === 0) press(d, true); } },
    icon(CHEVRON[d], isPhone ? 30 : 26, 2.4))]));
  const ok = h('button.tv-dpad-ok', { tabindex: -1, 'aria-label': 'OK', onclick: (ev) => { if (ev.detail === 0) press('ok', true); } },
    h('span', 'OK'));
  const disc = h('div.tv-dpad-disc', ...Object.values(zones), ok);
  const el = h('div.tv-dpad', { tabindex: 0, role: 'group', 'aria-label': 'Direction pad: press an arrow or OK, or use the arrow keys and Enter' }, disc);

  let g = null; // the press: { id, dir, hold, every }
  const partOf = (dir) => (dir === 'ok' ? ok : zones[dir]);

  function send(dir) {
    haptic(dir === 'ok' ? 'light' : 'tick', { drag: true });
    onKey(dir);
  }

  // A press that lights its part for a moment (the keyboard, a screen reader).
  function press(dir, flash = false) {
    send(dir);
    if (!flash) return;
    const part = partOf(dir);
    part.classList.add('pressed');
    clearTimeout(part.flash);
    part.flash = setTimeout(() => part.classList.remove('pressed'), 140);
  }

  /** What a press at (x, y) on the page is: 'ok', a direction, or null (the dead ring, outside). */
  function at(x, y) {
    const r = disc.getBoundingClientRect();
    const size = Math.min(r.width, r.height);
    const dx = x - (r.left + r.width / 2);
    const dy = y - (r.top + r.height / 2);
    const d = Math.hypot(dx, dy) / size;
    if (d <= OK_SIZE / 2) return 'ok';
    if (d < OK_SIZE / 2 + DEAD || d > 0.5) return null;
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
  }

  function release() {
    if (!g) return;
    clearTimeout(g.hold);
    clearInterval(g.every);
    partOf(g.dir).classList.remove('pressed');
    disc.dataset.pressed = '';
    g = null;
  }

  disc.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || !ev.isPrimary) return;
    const dir = at(ev.clientX, ev.clientY);
    if (!dir) return;
    ev.preventDefault(); // the pad keeps its focus ring off, and a mouse selects no text
    release();
    try { disc.setPointerCapture(ev.pointerId); } catch { /* gone already */ }
    g = { id: ev.pointerId, dir, hold: 0, every: 0 };
    partOf(dir).classList.add('pressed');
    disc.dataset.pressed = dir;
    send(dir);
    if (dir !== 'ok') {
      const held = g;
      held.hold = setTimeout(() => { held.every = setInterval(() => send(held.dir), REPEAT); }, HOLD);
    }
  });
  const end = (ev) => { if (g && ev.pointerId === g.id) release(); };
  disc.addEventListener('pointerup', end);
  disc.addEventListener('pointercancel', end);
  disc.addEventListener('lostpointercapture', end);
  // No page scroll, magnifier or menu from a finger on the pad.
  disc.addEventListener('touchmove', (ev) => { if (ev.cancelable) ev.preventDefault(); }, { passive: false });
  disc.addEventListener('contextmenu', (ev) => ev.preventDefault());

  /* ---------- the keyboard ---------- */

  // `escape`: Escape is the TV's Back (the pad has focus) rather than "close the sheet".
  function key(ev, escape) {
    if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.repeat && !ARROWS[ev.key]) return false;
    const name = ARROWS[ev.key] || (ev.key === 'Enter' ? 'ok' : ev.key === ' ' ? 'playpause'
      : ev.key === 'Backspace' || (escape && ev.key === 'Escape') ? 'back' : null);
    if (!name) return false;
    ev.preventDefault();
    ev.stopPropagation();
    if (name === 'ok' || ARROWS[ev.key]) press(name, true);
    else send(name);
    return true;
  }
  el.addEventListener('keydown', (ev) => key(ev, true));

  return {
    el,
    /** A key pressed anywhere in the sheet (not in a field): true when the pad took it. */
    key: (ev) => key(ev, false),
    stop() { release(); },
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
