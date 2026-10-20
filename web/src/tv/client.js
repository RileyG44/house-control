// The TV's state for the whole page, from wherever this page gets it: the hub's events
// (served by the hub), the Mac app asking the hub for it (`hubRequest`, every 2 s while
// the panel is open), or a pretend TV in a plain browser (or with ?tv=demo). Changes asked
// for here show at once (the app being opened, the volume) and the TV's next report
// corrects them.
import { isHub, isNative, call, incoming } from '../bridge.js';
import { createDemoTv } from './demo.js';

export const TV_TYPES = new Set(['tv', 'tvCabinet']);
const POLL = 2000;
const HELD = 5000;        // how long a change asked for is shown before the TV must confirm it
const KEY_BACKLOG = 3;    // remote keys waiting to be sent; more are dropped (a held arrow)

const mode = new URLSearchParams(location.search).get('tv') === 'demo' || (!isHub && !isNative)
  ? 'demo' : isHub ? 'hub' : 'native';

const listeners = new Set();
let real = { available: false, error: '', devices: [] };
let merged = real;
let ready = false;
let started = false;
let visible = !document.hidden;
let pollTimer = 0;
let unsupported = false;   // the native shell does not answer hubRequest (the iPhone app)
const held = new Map();    // device id -> { patch, until }: what was asked, until the TV reports it
const queues = new Map();  // device id -> { tail, keys }
let demo = null;

const sameApp = (a, b) => (a?.id ?? null) === (b?.id ?? null);

function merge() {
  const now = Date.now();
  merged = {
    ...real,
    devices: real.devices.map((d) => {
      const h = held.get(d.id);
      if (!h) return d;
      if (now > h.until) { held.delete(d.id); return d; }
      // Each asked-for field stays until the TV reports that value.
      for (const k of Object.keys(h.patch)) {
        if (k === 'app' ? sameApp(d.app, h.patch.app) : d[k] === h.patch[k]) delete h.patch[k];
      }
      if (!Object.keys(h.patch).length) { held.delete(d.id); return d; }
      return { ...d, ...h.patch };
    }),
  };
}

function emit() {
  merge();
  for (const fn of listeners) fn(merged);
}

function take(next) {
  if (!next || typeof next !== 'object') return;
  real = { available: Boolean(next.available), error: next.error || '', devices: Array.isArray(next.devices) ? next.devices : [] };
  ready = true;
  emit();
}

// The hub's events carry {"tv": …}; bridge.js hands them over here.
incoming.tvState = take;

/* ---------- reading ---------- */

function timeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('No answer'), { silent: true })), ms))]);
}

async function readNative() {
  try {
    take(await timeout(call('hubRequest', { method: 'GET', path: 'api/tv' }), 6000));
  } catch (error) {
    // A shell that never answers has no hub to ask (the iPhone app): stop asking.
    if (error.silent) { unsupported = true; return; }
    take({ available: false, error: error.message, devices: [] });
  }
}

function schedule() {
  clearTimeout(pollTimer);
  if (mode !== 'native' || unsupported || !visible || !started) return;
  pollTimer = setTimeout(async () => { await readNative(); schedule(); }, POLL);
}

function start() {
  if (started) return;
  started = true;
  if (mode === 'demo') {
    demo = createDemoTv(take);
    take(demo.state());
  } else if (mode === 'hub') {
    fetch('./api/tv', { cache: 'no-store' }).then((r) => r.json()).then((s) => { if (!ready) take(s); })
      .catch(() => take({ available: false, error: 'The hub on the Mac cannot be reached', devices: [] }));
  } else {
    readNative().then(schedule);
  }
}

/* ---------- asking ---------- */

async function send(id, body) {
  if (mode === 'demo') return demo.act(id, body);
  if (mode === 'native') return call('hubRequest', { method: 'POST', path: `api/tv/${encodeURIComponent(id)}`, body });
  let result;
  try {
    const res = await fetch(`./api/tv/${encodeURIComponent(id)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    result = await res.json();
  } catch {
    throw new Error('The hub on the Mac cannot be reached');
  }
  if (result?.error) throw new Error(result.error);
  return result;
}

// What the panel can show before the TV answers.
function expect(d, body) {
  const { action } = body;
  if (action === 'wake') return { on: true };
  if (action === 'sleep') return { on: false, app: null };
  if (action === 'power') return d.on ? { on: false, app: null } : { on: true };
  if (action === 'open' || (action === 'play' && body.app)) return { on: true, app: { id: body.app, name: body.name || body.app } };
  if (action === 'volume') return { volume: body.level, muted: false };
  if ((action === 'volup' || action === 'voldown') && d.volume != null) {
    return { volume: Math.max(0, Math.min(d.volumeMax || 100, d.volume + (action === 'volup' ? 1 : -1))), muted: false };
  }
  if (action === 'mute') return { muted: !d.muted };
  return null;
}

const KEYS = new Set(['up', 'down', 'left', 'right', 'ok', 'back', 'home', 'menu', 'playpause', 'rewind', 'forward', 'volup', 'voldown']);

export const tv = {
  mode,
  /** The TV's state: { available, error, devices: [{ id, name, online, on, app, volume, volumeMax, muted }] }. */
  get state() { start(); return merged; },
  /** Whether a first answer has arrived. */
  get ready() { return ready; },
  /** Set by the panel: a change the TV refused, in words. */
  onError: null,

  subscribe(fn) {
    start();
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  device(id) { return merged.devices.find((d) => d.id === id) || null; },

  /**
   * Asks the TV for something (see hub/tv.py for what may be asked). Changes are sent one
   * after another per TV; a held arrow that gets ahead of the TV drops presses instead of
   * piling them up. Resolves true when the TV did it.
   */
  act(id, body) {
    start();
    const q = queues.get(id) || { tail: Promise.resolve(), keys: 0 };
    queues.set(id, q);
    const isKey = KEYS.has(body.action);
    if (isKey && q.keys >= KEY_BACKLOG) return Promise.resolve(false);
    const d = this.device(id);
    const patch = d && expect(d, body);
    if (patch) {
      const h = held.get(id);
      held.set(id, { patch: { ...(h?.patch || {}), ...patch }, until: Date.now() + HELD });
      emit();
    }
    if (isKey) q.keys++;
    const run = q.tail.then(async () => {
      try {
        await send(id, body);
        return true;
      } catch (error) {
        held.delete(id);
        emit();
        tv.onError?.(error.message || 'The TV did not answer');
        return false;
      } finally {
        if (isKey) q.keys--;
      }
    });
    q.tail = run;
    if (mode === 'native') run.then(() => setTimeout(readNative, 600));
    return run;
  },

  /** The streaming catalog: { results: [...] }; throws with words to show. */
  async search(q) {
    start();
    if (mode === 'demo') return demo.search(q);
    const path = `api/tv/search?q=${encodeURIComponent(q)}`;
    if (mode === 'native') return call('hubRequest', { method: 'GET', path });
    let result;
    try {
      result = await (await fetch(`./${path}`)).json();
    } catch {
      throw new Error('The hub on the Mac cannot be reached');
    }
    if (result?.error) throw new Error(result.error);
    return result;
  },

  /** The panel is on screen (or not): the Mac app's panel asks for the state only then. */
  setVisible(on) {
    visible = on;
    if (on && started && mode === 'native' && !unsupported) readNative();
    schedule();
  },
};

document.addEventListener('visibilitychange', () => tv.setVisible(!document.hidden));

/**
 * Which TV each tv / tvCabinet of the plan shows: its `device`, or (no `device`) the one TV
 * there is when the plan has one TV piece. `"device": "none"` is a piece left unlinked.
 * Returns [{ index, item, id }] for every TV piece, id null when unlinked.
 */
export function tvLinks(furniture, state = merged) {
  const pieces = (furniture || []).map((item, index) => ({ item, index })).filter(({ item }) => TV_TYPES.has(item?.type));
  const auto = pieces.filter(({ item }) => item.device == null);
  return pieces.map(({ item, index }) => {
    let id = null;
    if (typeof item.device === 'string' && item.device && item.device !== 'none') id = item.device;
    else if (item.device == null && pieces.length === 1 && auto.length === 1 && state.devices.length === 1) id = state.devices[0].id;
    return { index, item, id };
  });
}
