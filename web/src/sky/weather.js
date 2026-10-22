// The weather at the house for the whole page, from wherever this page gets it: the hub's
// `weather` events and /api/weather (served by the hub), the Mac app asking its hub
// (`hubRequest`), or nothing (a plain browser: the sky shows the real day and night with a
// plain partly cloudy look). Read again every 10 minutes whatever events arrive.
//
// ?sky=<kind>&skytime=<HH:MM>[&skydate=YYYY-MM-DD] forces a look and a local time at the
// house and skips the hub (for testing and screenshots): kind is clear, partly, overcast,
// fog, drizzle, rain, snow or storm.
import { isHub, isNative, call, incoming } from '../bridge.js';

export const KINDS = ['clear', 'partly', 'overcast', 'fog', 'drizzle', 'rain', 'snow', 'storm'];
const EVERY = 10 * 60 * 1000;

// What a forced kind looks like, as a reading from the hub would say it.
const FORCED = {
  clear: { code: 0, cloud: 4, wind: 8 },
  partly: { code: 2, cloud: 45, wind: 14 },
  overcast: { code: 3, cloud: 100, wind: 16 },
  fog: { code: 45, cloud: 100, wind: 3, visibility: 140 },
  drizzle: { code: 53, cloud: 96, precip: 0.4, wind: 10, visibility: 9000 },
  rain: { code: 63, cloud: 100, precip: 4, wind: 24, visibility: 6000 },
  snow: { code: 73, cloud: 100, snow: 1.2, wind: 12, visibility: 2500, snowDepth: 0.08 },
  storm: { code: 95, cloud: 100, precip: 9, wind: 38, visibility: 5000 },
};

const query = new URLSearchParams(location.search);
const forcedKind = KINDS.includes(query.get('sky')) ? query.get('sky') : null;
const forcedTime = /^(\d{1,2}):(\d{2})$/.exec(query.get('skytime') || '');
const forcedDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(query.get('skydate') || '');

/** Whether the look or the time is forced from the address (the hub is then not asked). */
export const forced = Boolean(forcedKind || forcedTime || forcedDate);

const listeners = new Set();
let reading = forcedKind ? { kind: forcedKind, precip: 0, snow: 0, windDir: 225, visibility: 24000, snowDepth: 0, temp: 8, ...FORCED[forcedKind], stale: false } : null;
let started = false;

function take(next) {
  if (forced) return;
  reading = next && typeof next === 'object' && KINDS.includes(next.kind) ? next : null;
  for (const fn of listeners) fn(reading);
}

// The hub's events carry {"weather": …}; bridge.js hands them over here.
let heard = 0;
incoming.weather = (next) => { heard++; take(next); };

async function read() {
  // An event that comes in while this read is on its way is newer than its answer.
  const mark = heard;
  const fresh = (next) => { if (heard === mark) take(next); };
  try {
    if (isHub) {
      const res = await fetch('./api/weather', { cache: 'no-store' });
      if (res.ok) fresh(await res.json());
    } else if (isNative) {
      // The Mac app's hub; a shell with none (or that never answers) leaves the plain look.
      fresh(await Promise.race([call('hubRequest', { method: 'GET', path: 'api/weather' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('No answer')), 6000))]));
    }
  } catch { /* no hub: the last reading (or none) stays */ }
}

function start() {
  if (started || forced) return;
  started = true;
  if (!isHub && !isNative) return;
  read();
  setInterval(read, EVERY);
}

export const weather = {
  /** The last reading ({ kind, code, cloud, precip, snow, wind, windDir, … }), or null. */
  get reading() { return reading; },

  /** `fn(reading)` on every new reading; returns a remover. Starts reading on first use. */
  subscribe(fn) {
    start();
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  /**
   * Now, or the forced time: `skytime` is a local time at the house, whose UTC offset is
   * taken from the reading's sunrise when there is one, else this device's own when it is
   * near the house's longitude (Riley's devices are in the house's time zone), else the
   * longitude's (15° an hour).
   */
  now(lon = 0) {
    const real = new Date();
    if (!forcedTime && !forcedDate) return real;
    const offset = utcOffset(lon, real); // minutes east of UTC
    const local = new Date(real.getTime() + offset * 60000);
    const [y, mo, d] = forcedDate ? [+forcedDate[1], +forcedDate[2] - 1, +forcedDate[3]]
      : [local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()];
    const [h, mi] = forcedTime ? [+forcedTime[1], +forcedTime[2]] : [local.getUTCHours(), local.getUTCMinutes()];
    return new Date(Date.UTC(y, mo, d, h, mi) - offset * 60000);
  },
};

function utcOffset(lon, at) {
  const sunrise = /([+-])(\d{2}):(\d{2})$/.exec(reading?.sunrise || '');
  if (sunrise) return (sunrise[1] === '-' ? -1 : 1) * (+sunrise[2] * 60 + +sunrise[3]);
  const mine = -at.getTimezoneOffset();
  return Math.abs(mine - lon * 4) <= 100 ? mine : Math.round(lon / 15) * 60;
}
