// Thin bridge to the native shell (the macOS menu bar app or the iPhone app). In a plain
// browser every call is a no-op, so the same bundle runs under `vite dev` too.

const handler = window.webkit?.messageHandlers?.house;

export const isNative = Boolean(handler);
// Served by the House Control hub (hub/house.py) on a Mac: devices are real, commands go
// over HTTP and the devices' state comes back as server-sent events.
export const isHub = !handler && Boolean(window.__HOUSE_BOOT__?.hub);
// Whether changes made in the panel reach real devices at all.
export const controlsDevices = isNative || isHub;

// 'ios' inside the iPhone app (or with ?platform=ios in a browser, to work on that layout),
// and on a phone's browser opening the hub.
export const platform = window.__HOUSE_BOOT__?.platform
  || new URLSearchParams(location.search).get('platform')
  || (handler ? 'macos' : isHub && matchMedia('(max-width: 600px)').matches ? 'ios' : 'web');
export const isPhone = platform === 'ios';


export function post(type, payload = {}) {
  handler?.postMessage({ type, ...payload });
}

// A tap you can feel: 'tick' for a step of a slider, 'light' / 'medium' for a switch or a
// scene, 'error' when a device refuses a change. The iPhone app plays it; a phone's browser
// buzzes where it can. `drag`: feedback in the middle of a drag (a tile lifted, a slot
// passed), which the Mac's trackpad gives too; a click there already has its own feel.
export function haptic(kind = 'light', { drag = false } = {}) {
  if (isPhone && handler) post('haptic', { kind });
  else if (isPhone) buzz(kind);
  else if (drag && handler) post('haptic', { kind });
}

// A phone's browser: Android vibrates; Safari (iOS 18) ticks when a switch is flipped, so a
// hidden one is. Neither is there everywhere, and neither may complain when it isn't.
const BUZZ = { tick: 6, light: 10, medium: 16, heavy: 24, success: [10, 60, 10], error: [14, 70, 14] };
let tickSwitch = null;
function buzz(kind) {
  try {
    if (navigator.vibrate?.(BUZZ[kind] ?? 10)) return;
    if (document.activeElement?.matches?.('input, textarea')) return; // the switch must not take the keyboard
    if (!tickSwitch) {
      const input = Object.assign(document.createElement('input'), { type: 'checkbox', tabIndex: -1 });
      input.setAttribute('switch', '');
      tickSwitch = document.createElement('label');
      tickSwitch.setAttribute('aria-hidden', 'true');
      tickSwitch.style.cssText = 'position:fixed;left:-100px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
      tickSwitch.append(input);
      document.body.append(tickSwitch);
    }
    // Flipping it must not take the focus (the TV's pad keeps the arrow keys).
    const focused = document.activeElement;
    tickSwitch.click();
    if (focused && document.activeElement !== focused) focused.focus?.({ preventScroll: true });
  } catch { /* no haptics here */ }
}

// Native -> JS entry points are attached here by main.js.
export const incoming = (window.house = window.house || {});

// Request/response on top of the one-way message channel.
let nextId = 1;
const pending = new Map();

export function call(type, payload = {}) {
  if (isHub) return hubCall(type, payload);
  if (!handler) return Promise.reject(new Error('Only available inside the app'));
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    handler.postMessage({ type, callId: id, ...payload });
  });
}

incoming.reply = (id, result) => {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (result && result.error) p.reject(Object.assign(new Error(result.error), { detail: result }));
  else p.resolve(result);
};

// The hub answers a call like the native shell does: a result, or `{ error, failed }`.
async function hubCall(type, payload) {
  let result;
  try {
    const res = await fetch('./api/call', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, ...payload }),
    });
    result = await res.json();
  } catch (error) {
    throw Object.assign(new Error('The hub on the Mac cannot be reached'), { detail: {} });
  }
  if (result && result.error) throw Object.assign(new Error(result.error), { detail: result });
  return result;
}

// This page, as the hub's reload events name it: a plan this page saved comes back as an
// event `by` this id, which the page ignores (it already shows that plan).
export const CLIENT_ID = (crypto.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

let queuedPlanChange = null;
let readingPlan = false;
let planRetry = 0;
function planChanged(update) {
  if (update?.by === CLIENT_ID) return;
  queuedPlanChange = update;
  drainPlanChanges();
}
async function drainPlanChanges() {
  if (readingPlan || !incoming.planChanged) return;
  clearTimeout(planRetry);
  readingPlan = true;
  try {
    while (queuedPlanChange) {
      const update = queuedPlanChange;
      queuedPlanChange = null;
      try { await incoming.planChanged(update); }
      catch {
        // Keep the page and unsaved edits during a disconnect. Serialize reads so
        // a slower old response cannot replace a more recent plan.
        queuedPlanChange ||= update;
        planRetry = setTimeout(drainPlanChanges, 5000);
        break;
      }
    }
  } finally { readingPlan = false; }
}
export function listenForPlanChanges(listener) {
  incoming.planChanged = listener;
  drainPlanChanges(); // a change may have arrived while the 3D panel was mounting
}

// Device state from the hub, for incoming.applyRemote. Reconnects by itself (EventSource
// does). When the hub's floor plan changed (a new light was found, a plan was saved on
// another screen) the page takes it in place (planChanged: the panel swaps itself, an open
// editor merges it). Changes arriving before that handler mounts are queued.
if (isHub) {
  const events = new EventSource('./api/events');
  let connected = false;
  events.onopen = () => {
    // SSE sends current device state on reconnect, but plan events emitted while
    // offline are gone. Reconcile the plan as well, without reloading the page.
    if (connected) planChanged({ by: null });
    connected = true;
  };
  window.addEventListener('online', () => planChanged({ by: null }));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) planChanged({ by: null });
  });
  events.onmessage = (ev) => {
    let update;
    try { update = JSON.parse(ev.data); } catch { return; }
    if (update.reload) {
      planChanged(update);
    } else if (update.tv) {
      incoming.tvState?.(update.tv); // the TV (hub/tv.py), for tv/client.js
    } else if (update.weather) {
      incoming.weather?.(update.weather); // the weather at the house (hub/weather.py), for sky/weather.js
    } else incoming.applyRemote?.(update);
  };
}
