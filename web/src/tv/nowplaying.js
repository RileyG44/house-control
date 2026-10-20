// What the TV is playing, at the top of its sheet: the artwork, the title and its show or
// channel, a slider through it, and back 10 s / play-pause / ahead 30 s. Between the TV's
// reports the position is worked out here (`position` at `at`, moving while it plays), so
// the slider glides. A jump or a pause asked for here shows at once, and stands until the
// TV reports it (or a few seconds pass).
import { h, clamp } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { haptic, isPhone } from '../bridge.js';
import { glowOf, logoSVG } from './apps.js';

const BACK = 10;
const AHEAD = 30;
const ASKED = 4000;     // ms something asked for here is shown before the TV must agree
const AGREE = 2.5;      // s a reported position may differ from the one asked for
const NOTCHES = 10;     // haptic ticks across the whole slider
const NS = 'http://www.w3.org/2000/svg';

/** 75 → "1:15", 3725 → "1:02:05". */
export function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

const nowS = () => Date.now() / 1000;

/** Where the title is at time `t`: its last position, moved on while it plays. */
export function positionAt(np, t = nowS()) {
  if (!np || np.position == null) return null;
  const p = np.position + (np.state === 'playing' ? Math.max(0, t - (np.at ?? t)) : 0);
  return np.duration ? clamp(p, 0, np.duration) : Math.max(0, p);
}

// A circular arrow around the number of seconds, like a player's skip buttons.
function skipGlyph(seconds, ahead) {
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: 24, height: 24, fill: 'none', stroke: 'currentColor',
    'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'icon' })) svg.setAttribute(k, v);
  const path = (d) => { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); svg.append(p); };
  path(ahead ? 'M12 4.5A8.5 8.5 0 1 1 7.75 5.64' : 'M12 4.5A8.5 8.5 0 1 0 16.25 5.64');
  path(ahead ? 'M9.6 2.3 12 4.5 9.6 6.7' : 'M14.4 2.3 12 4.5 14.4 6.7');
  const t = document.createElementNS(NS, 'text');
  for (const [k, v] of Object.entries({ x: 12, y: 16.4, 'text-anchor': 'middle', 'font-size': 7.4, 'font-weight': 700,
    fill: 'currentColor', stroke: 'none', 'font-family': '-apple-system, system-ui, sans-serif' })) t.setAttribute(k, v);
  t.textContent = seconds;
  svg.append(t);
  return svg;
}

/**
 * The card. `onPlayPause()` sends the remote's play/pause key; `onSeek(seconds)` asks the TV
 * to jump there and resolves true when it did. `set(device)` shows the TV's state (hidden
 * when nothing plays) and says whether it is shown.
 */
export function createNowPlaying({ onPlayPause, onSeek }) {
  const art = h('div.tv-np-art');
  const badge = h('span.tv-np-badge');
  const media = h('div.tv-np-media', art, badge);
  const title = h('div.tv-np-title');
  const sub = h('div.tv-np-sub');
  const fill = h('div.tv-scrub-fill');
  const track = h('div.tv-scrub-track', fill);
  const thumb = h('div.tv-scrub-thumb');
  const bubbleText = h('span');
  const bubble = h('div.tv-scrub-bubble', bubbleText);
  const scrub = h('div.tv-scrub', { role: 'slider', tabindex: 0, 'aria-label': 'Position' }, track, thumb, bubble);
  const elapsed = h('span.tv-np-elapsed');
  const remaining = h('span.tv-np-left');
  const times = h('div.tv-np-times', elapsed, remaining);
  const playBtn = h('button.tv-np-play', { 'aria-label': 'Play or pause', onclick: playPause }, icon('play', 20, 2), icon('pause', 20, 2));
  const back = h('button.tv-np-skip', { 'aria-label': `Back ${BACK} seconds`, title: `Back ${BACK} s`, onclick: () => skip(-BACK) }, skipGlyph(BACK, false));
  const ahead = h('button.tv-np-skip', { 'aria-label': `Ahead ${AHEAD} seconds`, title: `Ahead ${AHEAD} s`, onclick: () => skip(AHEAD) }, skipGlyph(AHEAD, true));
  const el = h('div.tv-np', { hidden: true },
    h('div.tv-np-top', media, h('div.tv-np-text', title, sub)),
    scrub, times,
    h('div.tv-np-controls', back, playBtn, ahead));

  let np = null;         // as the TV last reported it
  let asked = null;      // { kind: 'seek' | 'state', patch, until }: asked for here, not yet reported
  let drag = null;       // the finger on the slider: { id, x, p, notch, live }
  let width = 0;
  let raf = 0;
  let shownSecond = null;
  let artKey = null;

  new ResizeObserver(() => { width = track.clientWidth; paint(); }).observe(track);

  // What to show: the TV's report, with what was just asked for on top.
  function current() {
    if (asked && Date.now() > asked.until) asked = null;
    return asked ? { ...np, ...asked.patch } : np;
  }

  const seekable = () => Boolean(np?.seekable && np.duration);

  /* ---------- drawing ---------- */

  function paint() {
    if (!np) return;
    const cur = current();
    const pos = drag?.live ? drag.p * np.duration : positionAt(cur);
    const p = np.duration ? clamp((pos ?? 0) / np.duration, 0, 1) : 0;
    fill.style.transform = `scaleX(${p})`;
    thumb.style.transform = `translateX(${p * width}px)`;
    if (drag?.live) {
      bubbleText.textContent = clock(pos);
      const bw = bubble.offsetWidth;
      bubble.style.transform = `translateX(${clamp(p * width, bw / 2, width - bw / 2)}px)`;
    }
    const second = Math.floor(pos ?? -1);
    if (second !== shownSecond) {
      shownSecond = second;
      elapsed.textContent = pos == null ? '' : clock(pos);
      remaining.textContent = np.duration ? `−${clock(np.duration - Math.floor(pos ?? 0))}` : '';
      scrub.setAttribute('aria-valuenow', String(Math.round(pos ?? 0)));
      scrub.setAttribute('aria-valuetext', np.duration ? `${clock(pos)} of ${clock(np.duration)}` : clock(pos));
    }
    playBtn.classList.toggle('playing', cur.state !== 'paused');
    playBtn.setAttribute('aria-label', cur.state === 'paused' ? 'Play' : 'Pause');
  }

  // Smooth while it plays (or a finger is on the slider); still otherwise.
  function loop() {
    const moving = np && el.isConnected && !el.hidden && (current().state === 'playing' || drag);
    if (moving && !raf) {
      const frame = () => {
        raf = 0;
        paint();
        loop();
      };
      raf = requestAnimationFrame(frame);
    }
  }

  function setArt(dev) {
    const key = `${np.artwork || ''}|${dev.app?.id}|${dev.app?.name}`;
    if (key === artKey) return;
    artKey = key;
    el.style.setProperty('--glow', glowOf(dev.app));
    media.classList.remove('poster', 'pictured');
    // Until (or unless) there is a picture: the app's own logo on its colours.
    art.replaceChildren(h('span.tv-np-logo', logoSVG(dev.app, 64)));
    badge.replaceChildren(logoSVG(dev.app, 22));
    if (!np.artwork) return;
    const img = h('img', { alt: '', decoding: 'async', referrerpolicy: 'no-referrer' });
    img.addEventListener('load', () => {
      if (artKey !== key) return;
      media.classList.toggle('poster', img.naturalHeight > img.naturalWidth * 1.1);
      media.classList.add('pictured');
    });
    img.addEventListener('error', () => img.remove());
    img.src = np.artwork;
    art.append(img);
  }

  /* ---------- asking ---------- */

  function ask(kind, patch) {
    asked = { kind, patch: { at: nowS(), ...patch }, until: Date.now() + ASKED };
    shownSecond = null;
    paint();
    loop();
  }

  function seekTo(seconds) {
    if (!seekable()) return;
    const target = clamp(seconds, 0, Math.max(0, np.duration - 1));
    ask('seek', { position: target });
    Promise.resolve(onSeek(target)).then((ok) => {
      if (ok === false && asked?.kind === 'seek') { asked = null; shownSecond = null; paint(); loop(); }
    });
  }

  function skip(by) {
    if (!seekable()) return;
    haptic('light');
    seekTo(positionAt(current()) + by);
  }

  function playPause() {
    const cur = current();
    if (!cur) return;
    haptic('light');
    ask('state', { state: cur.state === 'paused' ? 'playing' : 'paused', position: positionAt(cur) });
    onPlayPause();
  }

  /* ---------- the slider ---------- */

  const fraction = (ev) => {
    const r = track.getBoundingClientRect();
    return clamp((ev.clientX - r.left) / r.width, 0, 1);
  };

  function grab(live) {
    drag.live = live;
    el.classList.toggle('scrubbing', live);
    shownSecond = null;
    paint();
    loop();
  }

  scrub.addEventListener('pointerdown', (ev) => {
    if (!seekable() || ev.button !== 0 || drag) return;
    scrub.setPointerCapture(ev.pointerId);
    drag = { id: ev.pointerId, x: ev.clientX, p: fraction(ev), notch: null, live: false };
    drag.notch = Math.floor(drag.p * NOTCHES);
    // A mouse takes hold at once; a finger first has to move sideways (it may be scrolling).
    if (ev.pointerType === 'mouse') grab(true);
  });
  scrub.addEventListener('pointermove', (ev) => {
    if (!drag || ev.pointerId !== drag.id) return;
    if (!drag.live && Math.abs(ev.clientX - drag.x) < 4) return;
    drag.p = fraction(ev);
    const notch = Math.floor(drag.p * NOTCHES);
    if (notch !== drag.notch) { drag.notch = notch; haptic('tick', { drag: true }); }
    if (!drag.live) grab(true);
    else paint();
  });
  const release = (ev) => {
    if (!drag || ev.pointerId !== drag.id) return;
    const { p } = drag;
    const done = ev.type === 'pointerup';
    drag = null;
    el.classList.remove('scrubbing');
    shownSecond = null;
    if (done) {
      if (isPhone) haptic('light');
      seekTo(p * np.duration);
    } else paint();
    loop();
  };
  scrub.addEventListener('pointerup', release);
  scrub.addEventListener('pointercancel', release);
  scrub.addEventListener('keydown', (ev) => {
    const by = { ArrowLeft: -BACK, ArrowDown: -BACK, ArrowRight: BACK, ArrowUp: BACK }[ev.key];
    if (!by || !seekable()) return;
    ev.preventDefault();
    ev.stopPropagation();
    seekTo(positionAt(current()) + by);
  });

  return {
    el,
    /** Shows what `device` is playing; false (and hidden) when nothing is. */
    set(dev) {
      const next = dev?.on ? dev.nowPlaying : null;
      if (!next) {
        el.hidden = true;
        np = null;
        asked = null;
        artKey = null;
        return false;
      }
      if (!np || np.title !== next.title || np.subtitle !== next.subtitle || np.app !== next.app) asked = null;
      np = next;
      // The TV caught up with what was asked: its own reports take over.
      if (asked && (asked.kind === 'state' ? np.state === asked.patch.state
        : Math.abs(positionAt(np) - positionAt({ ...np, ...asked.patch })) < AGREE)) asked = null;
      el.hidden = false;
      if (title.textContent !== np.title) title.textContent = np.title;
      const subtitle = np.subtitle || dev.app?.name || '';
      if (sub.textContent !== subtitle) sub.textContent = subtitle;
      setArt(dev);
      el.classList.toggle('seekable', seekable());
      el.classList.toggle('timed', Boolean(np.duration));
      scrub.setAttribute('aria-valuemax', String(Math.round(np.duration || 0)));
      scrub.setAttribute('aria-disabled', String(!seekable()));
      back.disabled = ahead.disabled = !seekable();
      shownSecond = null;
      paint();
      loop();
      return true;
    },
    /** For screenshots and tests: puts a finger on the slider at `p` (0–1), or lifts it. */
    preview(p) {
      if (p == null) { drag = null; el.classList.remove('scrubbing'); paint(); return; }
      drag = { id: -1, x: 0, p, notch: 0, live: false };
      grab(true);
    },
    stop() { cancelAnimationFrame(raf); raf = 0; },
  };
}
