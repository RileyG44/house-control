// The editor's Connections: the smart home platforms House Control can link the plan's
// lamps and ACs to, what each one offers, the pages that connect one (native app), and the
// pickers that link a lamp, an AC or a thermometer to a real device.
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { isNative, isHub, isPhone, call, post } from '../bridge.js';
import { SERVICES, linkOf } from '../config.js';
import { group, row, tile, button, note, textRow } from './forms.js';
import * as M from './model.js';

const ORDER = ['smartlife', 'homeassistant', 'hue', 'homekit'];
// What the hub on the Mac drives itself (hub/house.py), when the editor is served by it.
const HUB_ORDER = ['wiz', 'aidot', 'mrcool'];
const reachesDevices = isNative || isHub;
export const LOOK = {
  smartlife: { icon: 'plug', tint: '#ff7a3d', blurb: 'Tuya, Smart Life and the many brands built on them' },
  homeassistant: { icon: 'homeassistant', tint: '#18bcf2', blurb: 'Everything it runs: Zigbee, Matter, Nest, Xiaomi, Sonoff…' },
  hue: { icon: 'bulb', tint: '#c38bff', blurb: 'A Hue Bridge on this network. No account needed' },
  homekit: { icon: 'home', tint: '#ffb340', blurb: 'HomeKit and Matter accessories, through your iPhone' },
  wiz: { icon: 'bulb', tint: '#3d8bff', blurb: 'WiZ lights, found on the home network by the hub' },
  aidot: { icon: 'bulb', tint: '#2fc48d', blurb: 'AiDot bulbs, driven locally by the hub' },
  mrcool: { icon: 'ac', tint: '#5ac8fa', blurb: 'MRCOOL SmartHVAC air conditioners, through Cielo' },
};
const KIND_TITLES = { light: 'Lights and plugs', ac: 'Air conditioners', sensor: 'Temperature sensors' };
const dot = (online) => h(`span.ed-dot${online ? '.on' : ''}`, { title: online ? 'Online' : 'Offline' });

export function createConnections({ onChange }) {
  const boot = window.__HOUSE_BOOT__ || {};
  const state = {
    info: boot.services || {},
    devices: null,
    errors: {},
    loading: false,
    found: {},       // service -> discovered servers / bridges
    scanning: {},
    pairing: null,   // { host, until } while waiting for the Hue button
    rescanning: false,
  };
  const changed = () => onChange?.();

  // The platforms this app offers: the native side lists them (the iPhone's App Store
  // edition has no Smart Life). A plain browser shows them all.
  const offered = () => (isHub ? HUB_ORDER : isNative && boot.services ? [...ORDER, ...HUB_ORDER].filter((id) => id in state.info) : ORDER);
  const connected = (id) => Boolean(state.info[id]?.connected);
  const anyConnected = () => offered().some(connected);
  const devicesOf = (id) => (state.devices || []).filter((d) => d.service === id);

  async function refreshInfo() {
    if (!reachesDevices) return;
    try { state.info = await call('services.info'); } catch { /* keep what we had */ }
  }

  let loadPromise = null;
  function load({ quiet = false } = {}) {
    if (!reachesDevices) { state.devices = null; changed(); return Promise.resolve(); }
    if (loadPromise) return loadPromise;
    state.loading = true;
    if (!quiet) changed();
    loadPromise = (async () => {
      try {
        if (!anyConnected()) await refreshInfo();
        if (!anyConnected()) { state.devices = null; return; }
        const r = await call('devices.all');
        state.devices = r.devices || [];
        state.errors = r.errors || {};
      } catch (e) {
        state.errors = { all: e.message };
      } finally {
        state.loading = false;
        loadPromise = null;
        changed();
      }
    })();
    return loadPromise;
  }

  // Served by the hub: "Look for new devices" asks it to search the network again.
  async function rescan() {
    if (!isHub || state.rescanning) return;
    state.rescanning = true;
    changed();
    try {
      await fetch('./api/rescan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    } catch { /* the catalog below says what is there */ }
    state.rescanning = false;
    await load({ quiet: true });
  }

  if (reachesDevices) refreshInfo().then(() => load({ quiet: true }));

  // The Mac pushes this when the paired iPhone sent its Apple Home devices.
  window.house = window.house || {};
  window.house.servicesChanged = (info) => { state.info = info; load({ quiet: true }); };

  const find = (service, id) => (state.devices || []).find((d) => d.service === service && d.id === id) || null;

  /** Devices on the network that no item of the plan links yet (lamps and ACs only). */
  function unlinked(doc) {
    const used = M.usedDevices(doc);
    return (state.devices || []).filter((d) => (d.kind === 'light' || d.kind === 'ac') && !used.has(`${d.service}|${d.id}`));
  }

  function statusText(id) {
    const info = state.info[id] || {};
    if (id === 'homekit' && info.remote) return info.connected ? `${info.count} devices from ${info.from || 'your iPhone'}` : 'Set up on your iPhone';
    if (!info.connected) return HUB_ORDER.includes(id) ? 'Not signed in on the hub' : 'Not connected';
    const count = devicesOf(id).length;
    const name = id === 'homeassistant' || id === 'hue' ? info.name : id === 'smartlife' ? info.account : '';
    return [name, state.devices ? `${count} device${count === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ') || 'Connected';
  }

  /** "WiZ · AiDot · MRCOOL", the connected ones, for the Home page. */
  function summary() {
    const on = offered().filter(connected).map((id) => SERVICES[id]?.short || id);
    if (on.length) return on.join(' · ');
    return reachesDevices ? 'None connected' : 'Simulated';
  }

  const serviceTile = (id, size = 30) => tile(LOOK[id]?.icon || 'link', LOOK[id]?.tint, size);

  /* ---------- pages ---------- */

  function overviewPage(ctx) {
    return {
      key: 'connections',
      short: 'Connections',
      render() {
        if (anyConnected() && !state.devices && !state.loading) setTimeout(() => load(), 0);
        return {
          head: { tile: tile('link', '#3d8bff', 40), title: 'Connections', subtitle: 'Where your real lamps and ACs live' },
          body: [
            group(null, offered().map((id) => row({
              lead: serviceTile(id), title: SERVICES[id].name, subtitle: statusText(id), chevron: true, key: `svc-${id}`,
              accessory: connected(id) ? h('span.ed-badge-ok', icon('ok', 15, 2.2)) : null,
              onClick: () => (isPhone && isNative && !HUB_ORDER.includes(id) ? post('openConnection', { service: id }) : ctx.push(servicePage(ctx, id))),
            })), 'Lamps and ACs stay simulated until you link them: open one and choose its real device. One home can mix them all.'),
            isHub ? note('The hub on your Mac drives these. AiDot and MRCOOL are signed in once on the Mac (see hub/README.md); WiZ lights are found by themselves.', { icon: 'info' })
              : isNative ? null : note('Connecting needs the House Control app or the hub on your Mac. This browser preview shows the plan only.', { icon: 'info', tone: 'warn' }),
          ],
        };
      },
    };
  }

  function deviceRows(ctx, id) {
    if (state.loading && !state.devices) return group(null, [row({ lead: h('span.ed-spin', icon('spinner', 18, 2.2)), title: 'Asking for the devices…' })]);
    if (state.errors[id] || state.errors.all) return note(state.errors[id] || state.errors.all, { tone: 'bad', icon: 'alert' });
    if (!state.devices) return null;
    const list = devicesOf(id);
    if (!list.length) return note('Connected, but no lamps, air conditioners or temperature sensors were found.', { icon: 'info' });
    const used = M.usedDevices(ctx.doc);
    return ['light', 'ac', 'sensor'].map((kind) => {
      const items = list.filter((d) => d.kind === kind);
      if (!items.length) return null;
      return group(`${KIND_TITLES[kind]} · ${items.length}`, items.map((d) => {
        const by = used.get(`${d.service}|${d.id}`);
        return row({
          lead: dot(d.online), title: d.name, subtitle: [d.room, d.detail].filter(Boolean).join(' · ') || d.id, key: `dev-${d.service}-${d.id}`,
          value: by ? `In plan: ${by}` : null,
          accessory: !by && kind !== 'sensor' ? button({ label: 'Add', style: 'tinted', small: true, onClick: (ev) => { ev.stopPropagation(); ctx.addDevice(d); } }) : null,
        });
      }));
    });
  }

  function servicePage(ctx, id) {
    return {
      key: `service:${id}`,
      short: SERVICES[id]?.short || id,
      onLeave: () => stopPairing(),
      render() {
        const on = connected(id);
        const head = { tile: serviceTile(id, 40), title: SERVICES[id]?.name || id, subtitle: LOOK[id]?.blurb };
        let body;
        if (HUB_ORDER.includes(id) && (isHub || !isNative || state.info[id]?.local)) body = hubService(ctx, id);
        else if (id === 'smartlife') body = ctx.smartLife ? ctx.smartLife.render(ctx) : [note('Smart Life is set up in the House Control app on your Mac.', { icon: 'info' })];
        else if (id === 'homeassistant') body = homeAssistant(ctx);
        else if (id === 'hue') body = hue(ctx);
        else body = homeKit(ctx);
        if (!reachesDevices) body = [note('Connecting works inside the House Control app or from the hub on your Mac (this is the browser preview).', { tone: 'warn', icon: 'info' }), ...[body].flat()];
        if (on && !state.devices && !state.loading) setTimeout(() => load(), 0);
        return { head, body };
      },
    };
  }

  // A platform the hub drives: nothing to connect from here, just what it found.
  function hubService(ctx, id) {
    const on = connected(id);
    return [
      group(null, [
        row({ lead: dot(on), title: on ? 'Driven by the hub' : 'Not signed in on the hub', subtitle: on ? 'On your Mac' : 'Sign in on the Mac: see hub/README.md' }),
        row({ icon: 'refresh', tint: 'rgba(61,139,255,.85)', title: state.loading ? 'Refreshing…' : 'Refresh devices', onClick: () => load(), disabled: state.loading, key: 'refresh' }),
      ]),
      deviceRows(ctx, id),
    ];
  }

  function connectedHeader(ctx, id, name, line) {
    return group(null, [
      row({ lead: dot(true), title: name, subtitle: line }),
      row({ icon: 'refresh', tint: 'rgba(61,139,255,.85)', title: 'Refresh devices', onClick: () => load(), key: 'refresh' }),
      row({ icon: 'unlink', tint: 'rgba(255,69,58,.8)', title: 'Disconnect', destructive: true, onClick: () => disconnect(ctx, id), key: 'disconnect' }),
    ]);
  }

  async function disconnect(ctx, id) {
    try {
      state.info = await call('service.disconnect', { service: id });
      state.devices = state.devices?.filter((d) => d.service !== id) ?? null;
      ctx.toast(`${SERVICES[id].name} disconnected`);
    } catch (e) { ctx.toast(e.message, { tone: 'bad' }); }
    changed();
  }

  async function scan(id) {
    if (!isNative || state.scanning[id]) return;
    state.scanning[id] = true;
    changed();
    try {
      state.found[id] = (await call('services.discover', { service: id })).found;
    } catch { state.found[id] = []; }
    state.scanning[id] = false;
    changed();
  }

  /* ---------- Home Assistant ---------- */

  const ha = { url: '', token: '', error: null, busy: false };

  function homeAssistant(ctx) {
    const info = state.info.homeassistant || {};
    if (info.connected) {
      return [connectedHeader(ctx, 'homeassistant', info.name, [info.url, info.version && `version ${info.version}`].filter(Boolean).join(' · ')),
        deviceRows(ctx, 'homeassistant')];
    }
    if (isNative && !state.found.homeassistant && !state.scanning.homeassistant) setTimeout(() => scan('homeassistant'), 0);
    const found = state.found.homeassistant || [];
    const connect = async () => {
      ha.busy = true; ha.error = null; changed();
      try {
        state.info = await call('homeassistant.connect', { url: ha.url, token: ha.token });
        ha.token = '';
        ctx.toast(`Connected to ${state.info.homeassistant?.name || 'Home Assistant'}`);
        await load();
      } catch (e) { ha.error = e.message; }
      ha.busy = false;
      changed();
    };
    return [
      group('On your network', [
        state.scanning.homeassistant ? row({ lead: h('span.ed-spin', icon('spinner', 18, 2.2)), title: 'Looking for Home Assistant…' }) : null,
        ...found.map((s) => row({ lead: dot(true), title: s.name, subtitle: [s.url, s.version && `version ${s.version}`].filter(Boolean).join(' · '), check: ha.url === s.url, onClick: () => { ha.url = s.url; changed(); } })),
        !state.scanning.homeassistant ? row({ icon: 'radar', tint: 'rgba(61,139,255,.85)', title: found.length ? 'Look again' : 'None found by itself. Look again', onClick: () => scan('homeassistant'), disabled: !isNative }) : null,
      ]),
      group('Connect', [
        textRow({ label: 'Address', value: ha.url, placeholder: 'http://homeassistant.local:8123', type: 'url', key: 'ha-url', onInput: (v) => { ha.url = v; } }),
        textRow({ label: 'Token', value: ha.token, placeholder: 'Long-lived access token', type: 'password', key: 'ha-token', onInput: (v) => { ha.token = v; } }),
      ], 'In Home Assistant open your profile → Security → Long-lived access tokens → Create token, name it “House Control” and paste it here. The token stays on this Mac.'),
      button({ label: ha.busy ? 'Connecting…' : 'Connect', style: 'primary', wide: true, busy: ha.busy, disabled: !isNative, onClick: () => { if (ha.url.trim() && ha.token.trim()) connect(); else ctx.toast('Give the address and the token'); } }),
      ha.error ? note(ha.error, { tone: 'bad', icon: 'alert' }) : null,
    ];
  }

  /* ---------- Philips Hue ---------- */

  let pairTimer = 0;
  function stopPairing() { clearInterval(pairTimer); pairTimer = 0; state.pairing = null; }

  function pairHue(ctx, bridge) {
    stopPairing();
    state.pairing = { ...bridge, until: Date.now() + 60_000, error: null };
    const attempt = async () => {
      if (!state.pairing) return;
      if (Date.now() > state.pairing.until) {
        state.pairing.error = 'Nobody pressed the button in time. Try again.';
        clearInterval(pairTimer);
        changed();
        return;
      }
      try {
        const r = await call('hue.pair', { host: bridge.host, bridgeId: bridge.bridgeId, name: bridge.name });
        if (r.waiting) { changed(); return; }
        stopPairing();
        state.info = r;
        ctx.toast(`Paired with ${state.info.hue?.name || 'the Hue Bridge'}`);
        await load();
      } catch (e) {
        if (state.pairing) state.pairing.error = e.message;
        clearInterval(pairTimer);
      }
      changed();
    };
    attempt();
    pairTimer = setInterval(attempt, 2000);
    changed();
  }

  const hueManual = { host: '' };

  function hue(ctx) {
    const info = state.info.hue || {};
    if (info.connected) return [connectedHeader(ctx, 'hue', info.name, [info.host, info.bridgeId].filter(Boolean).join(' · ')), deviceRows(ctx, 'hue')];
    if (state.pairing) {
      const left = Math.max(0, Math.ceil((state.pairing.until - Date.now()) / 1000));
      return [group('Pairing', [
        row({ lead: h('span.ed-press', h('span')), title: 'Press the round button on the bridge', subtitle: state.pairing.error || `${state.pairing.name || state.pairing.host} · waiting ${left} s` }),
        state.pairing.error ? row({ icon: 'refresh', title: 'Try again', onClick: () => pairHue(ctx, state.pairing) }) : null,
        row({ icon: 'close', title: 'Cancel', onClick: () => { stopPairing(); changed(); } }),
      ], 'The big button on top of the Hue Bridge lets one app in for 30 seconds. House Control keeps the key it gets, on this Mac.')];
    }
    if (isNative && !state.found.hue && !state.scanning.hue) setTimeout(() => scan('hue'), 0);
    const found = state.found.hue || [];
    return [
      group('On your network', [
        state.scanning.hue ? row({ lead: h('span.ed-spin', icon('spinner', 18, 2.2)), title: 'Looking for Hue Bridges…' }) : null,
        ...found.map((b) => row({ lead: dot(true), title: b.name, subtitle: [b.host, b.bridgeId].filter(Boolean).join(' · '),
          accessory: button({ label: 'Pair', style: 'tinted', small: true, disabled: !isNative, onClick: () => pairHue(ctx, b) }) })),
        !state.scanning.hue ? row({ icon: 'radar', tint: 'rgba(61,139,255,.85)', title: found.length ? 'Look again' : 'No bridge found by itself. Look again', onClick: () => scan('hue'), disabled: !isNative }) : null,
      ]),
      group('Or by address', [
        textRow({ label: 'Bridge', value: hueManual.host, placeholder: 'e.g. 192.168.1.20', key: 'hue-host', onInput: (v) => { hueManual.host = v; } }),
      ], 'The Hue app shows it under Settings → My Hue system.'),
      button({ label: 'Pair', style: 'tinted', wide: true, disabled: !isNative, onClick: () => { if (hueManual.host.trim()) pairHue(ctx, { host: hueManual.host.trim(), name: 'Hue Bridge' }); } }),
    ];
  }

  /* ---------- Apple Home ---------- */

  function homeKit(ctx) {
    const info = state.info.homekit || {};
    const nodes = [];
    if (info.connected) {
      const when = info.updated ? new Date(info.updated * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
      nodes.push(group('From your iPhone', [
        row({ lead: dot(true), title: info.from || 'iPhone', subtitle: `${info.count} devices · sent ${when}` }),
        row({ icon: 'unlink', title: 'Forget this list', destructive: true, onClick: () => disconnect(ctx, 'homekit') }),
      ]), deviceRows(ctx, 'homekit'));
    }
    nodes.push(group(info.connected ? 'How it works' : 'Set it up on your iPhone', [
      row({ icon: 'phone', title: 'Pair your iPhone with this Mac', subtitle: 'Right-click the menu bar icon → Pair iPhone…' }),
      row({ icon: 'home', tint: '#ffb340', title: 'Connect Apple Home on the iPhone', subtitle: 'House Control → Settings → Apple Home → Connect' }),
      row({ icon: 'link', title: 'Link its devices here', subtitle: 'Its lamps, ACs and thermometers appear in the pickers' }),
    ], 'Apple lets only iPhone, iPad and App Store apps use HomeKit, so the iPhone app switches these devices. On the Mac they show what you set, but stay simulated.'));
    return nodes;
  }

  /* ---------- pickers ---------- */

  const current = (item, kind) => {
    if (kind === 'sensor') {
      if (item.sensor?.id) return { service: item.sensor.service, id: item.sensor.id };
      if (item.tuya?.sensorId) return { service: 'smartlife', id: item.tuya.sensorId };
      return null;
    }
    return linkOf(item);
  };

  function deviceLabel(item, kind) {
    const link = current(item, kind);
    if (!link) return kind === 'sensor' ? 'Estimated' : 'Simulated';
    const d = find(link.service, link.id);
    const svc = SERVICES[link.service]?.short || link.service;
    return d ? `${d.name} · ${svc}` : `${svc} · not found now`;
  }

  /**
   * A page listing every device of a kind, grouped by platform. `sel` is the plan item
   * being linked (a lamp, an AC; `kind: 'sensor'` links an AC's thermometer).
   */
  function pickerPage(ctx, sel, kind) {
    let query = '';
    return {
      key: `picker:${kind}`,
      short: kind === 'sensor' ? 'Thermometer' : 'Device',
      detent: 'large',
      render() {
        const item = M.itemOf(ctx.doc, sel);
        if (!item) return { head: { title: 'Gone' }, body: [] };
        const acKind = kind === 'sensor' ? 'sensor' : sel.kind === 'ac' ? 'ac' : 'light';
        const link = current(item, acKind === 'sensor' ? 'sensor' : acKind);
        const acLink = linkOf(item);
        if (reachesDevices && !state.devices && !state.loading) setTimeout(() => load({ quiet: true }), 0);
        const used = M.usedDevices(ctx.doc);
        const all = (state.devices || []).filter((d) => d.kind === acKind
          // Smart Life sensors only work beside a Smart Life AC.
          && (acKind !== 'sensor' || d.service !== 'smartlife' || acLink?.service === 'smartlife'));
        const q = query.trim().toLowerCase();
        const shown = q ? all.filter((d) => `${d.name} ${d.room} ${d.detail} ${SERVICES[d.service]?.name}`.toLowerCase().includes(q)) : all;
        const choose = (device) => {
          const note = ctx.change(() => {
            const it = M.itemOf(ctx.doc, sel);
            if (acKind === 'sensor') {
              delete it.sensor;
              if (it.tuya) { delete it.tuya.sensorId; if (!Object.keys(it.tuya).length) delete it.tuya; }
              if (device?.service === 'smartlife') it.tuya = { ...(it.tuya || {}), sensorId: device.id };
              else if (device) it.sensor = { service: device.service, id: device.id };
              return device ? `Room temperature from ${device.name}` : 'Room temperature estimated';
            }
            return M.linkDevice(it, acKind, device) || (device ? `Linked to ${device.name}` : 'Simulated');
          });
          ctx.pop();
          ctx.toast(note);
        };
        const isCurrent = (d) => link && d.service === link.service && d.id === link.id;
        const body = [];
        if (all.length > 8) {
          const input = h('input.ed-search-input', { type: 'search', placeholder: 'Search', value: query, 'data-key': 'search', spellcheck: 'false', 'aria-label': 'Search devices' });
          input.addEventListener('input', () => { query = input.value; ctx.refresh(); });
          input.addEventListener('keydown', (ev) => ev.stopPropagation());
          body.push(h('label.ed-search', icon('search', 16, 2.2), input));
        }
        body.push(group(null, [row({
          icon: acKind === 'sensor' ? 'thermo' : 'sparkles', tint: 'rgba(255,255,255,.14)',
          title: acKind === 'sensor' ? 'None (estimated)' : 'Not linked (simulated)',
          subtitle: acKind === 'sensor' ? 'The AC’s own reading, or an estimate' : 'Works in the plan only',
          check: !link, onClick: () => choose(null), key: 'none',
        })]));
        const listed = new Set();
        for (const id of offered()) {
          const list = shown.filter((d) => d.service === id);
          if (!list.length) continue;
          body.push(group(SERVICES[id]?.name || id, list.map((d) => {
            listed.add(`${d.service}|${d.id}`);
            const by = used.get(`${d.service}|${d.id}`);
            const mine = isCurrent(d);
            return row({
              lead: dot(d.online), title: d.name, key: `pick-${d.service}-${d.id}`,
              subtitle: [d.room, d.detail, !d.online && 'offline', by && !mine && `Used by ${by}`].filter(Boolean).join(' · ') || d.id,
              check: mine, onClick: () => choose(d),
            });
          })));
        }
        if (link && !listed.has(`${link.service}|${link.id}`) && !q) {
          body.push(group('Linked now', [row({ lead: dot(false), title: `${SERVICES[link.service]?.short || link.service} · ${link.id}`, subtitle: state.devices ? 'Not found now' : 'Loading…', check: true, onClick: () => ctx.pop() })]));
        }
        if (state.loading) body.push(group(null, [row({ lead: h('span.ed-spin', icon('spinner', 18, 2.2)), title: 'Asking for the devices…' })]));
        else if (!reachesDevices) body.push(note('Linking needs the House Control app or the hub on your Mac. In this preview every lamp and AC is simulated.', { icon: 'info' }));
        else if (!anyConnected()) {
          body.push(note(isHub ? 'The hub on your Mac has no WiZ, AiDot or MRCOOL device to offer yet.' : 'Connect Smart Life, Home Assistant, Philips Hue or Apple Home to control the real one.', { icon: 'info' }),
            group(null, [row({ icon: 'link', tint: '#3d8bff', title: 'Open Connections', chevron: true, onClick: () => ctx.push(overviewPage(ctx)) })]));
        } else if (!all.length) body.push(note(`No ${acKind === 'ac' ? 'air conditioners' : acKind === 'sensor' ? 'temperature sensors' : 'lamps'} found on your platforms.`, { icon: 'info' }));
        const errs = Object.entries(state.errors).filter(([, e]) => e);
        if (errs.length) body.push(note(errs.map(([s, e]) => `${SERVICES[s]?.name || 'Devices'}: ${e}`).join(' · '), { tone: 'bad', icon: 'alert' }));
        return {
          head: { tile: tile(acKind === 'sensor' ? 'thermo' : 'link', '#3d8bff', 40), title: acKind === 'sensor' ? 'Room temperature' : 'Real device', subtitle: item.name || item.id },
          body,
        };
      },
    };
  }

  return {
    state, load, rescan, refreshInfo, offered, connected, anyConnected, devicesOf, find, unlinked, summary, deviceLabel,
    overviewPage, servicePage, pickerPage, serviceTile, stopPairing, reachesDevices,
  };
}
