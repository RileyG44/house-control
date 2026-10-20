// A pretend TV for a plain browser (no hub) or ?tv=demo: it answers the way the hub and
// tv-remote do, a moment later, so the TV's sheet and its screen in the model can be worked
// on and photographed without the real one. It plays an episode in Netflix and a video in
// YouTube (their positions move on, and seek, play and pause work); other apps play nothing.
import { APPS } from './apps.js';

const app = (id) => {
  const a = APPS.find((x) => x.id === id);
  return { id: a.id, name: a.name, package: a.package };
};
const HOME = { id: 'home', name: 'Google TV', package: 'com.google.android.apps.tv.launcherx' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now() / 1000;

// What each app is in the middle of, in the shape the hub's nowPlaying takes.
const SHOWS = {
  netflix: { title: 'Chapter Seven: The Bathtub', subtitle: 'Stranger Things · S1 E7', duration: 2492, position: 1134, state: 'playing' },
  youtube: { title: 'Episode P - Bretz in the Scablands', subtitle: 'Nick Zentner', duration: 9535, position: 420, state: 'paused' },
};

export function createDemoTv(onState) {
  const tv = {
    id: '79519fff', name: 'Living Room TV', online: true, on: true, app: app('netflix'),
    volume: 12, volumeMax: 25, muted: false, caps: ['keys', 'volume', 'apps', 'text', 'search'],
  };
  const shows = structuredClone(SHOWS);
  for (const show of Object.values(shows)) show.at = now();
  // Where a show is now: its position moves on while it plays.
  const settle = (show) => {
    if (show.state === 'playing') show.position = Math.min(show.duration, show.position + now() - show.at);
    show.at = now();
  };
  const playing = () => (tv.on && tv.app && shows[tv.app.id]) || null;
  const nowPlaying = () => {
    const show = playing();
    if (!show) return null;
    return { title: show.title, subtitle: show.subtitle, state: show.state, position: Math.round(show.position * 10) / 10,
      duration: show.duration, seekable: true, artwork: null, app: tv.app.id, at: show.at };
  };
  const state = () => ({ available: true, error: '', devices: [{ ...structuredClone(tv), nowPlaying: nowPlaying() }] });
  const changed = () => onState(state());

  return {
    state,
    async act(id, body) {
      await wait(160);
      if (id !== tv.id) throw new Error('There is no such TV');
      const { action } = body;
      if (action === 'wake' || (action === 'power' && !tv.on)) {
        await wait(500);
        Object.assign(tv, { on: true, app: HOME });
      } else if (action === 'sleep' || action === 'power') {
        Object.assign(tv, { on: false, app: null });
      } else if (action === 'open' || (action === 'play' && body.app)) {
        if (!tv.on) { await wait(500); tv.on = true; }
        tv.app = app(body.app);
      } else if (action === 'home') {
        if (tv.on) tv.app = HOME;
      } else if (action === 'volume') {
        Object.assign(tv, { volume: body.level, muted: false });
      } else if (action === 'volup' || action === 'voldown') {
        tv.volume = Math.max(0, Math.min(tv.volumeMax, tv.volume + (action === 'volup' ? 1 : -1)));
        tv.muted = false;
      } else if (action === 'mute') {
        tv.muted = !tv.muted;
      } else if (['playpause', 'play', 'pause', 'seek', 'skip'].includes(action)) {
        const show = playing();
        if (!show) {
          if (action === 'seek' || action === 'skip') throw new Error('What’s on the TV can’t be moved through');
        } else {
          settle(show);
          if (action === 'seek' || action === 'skip') {
            const to = action === 'seek' ? body.position : show.position + body.by;
            show.position = Math.max(0, Math.min(show.duration - 1, to));
          } else {
            show.state = action === 'play' || (action === 'playpause' && show.state === 'paused') ? 'playing' : 'paused';
          }
        }
      }
      changed();
      return { ok: true };
    },
    async search(q) {
      await wait(380);
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      return { results: CANNED.filter((r) => words.every((w) => r.title.toLowerCase().includes(w))) };
    },
  };
}

// A few titles in the shape GET api/tv/search answers with (no posters: there is no network).
const offer = (id, how, link) => ({ app: id, name: APPS.find((a) => a.id === id).name, how, link });
const CANNED = [
  { title: 'Stranger Things', year: 2016, type: 'show', poster: null, rentOrBuy: [],
    offers: [offer('netflix', 'subscription', 'https://www.netflix.com/title/80057281')] },
  { title: 'The Bear', year: 2022, type: 'show', poster: null, rentOrBuy: ['Apple TV (buy)'],
    offers: [offer('hulu', 'subscription', 'https://www.hulu.com/series/the-bear'), offer('disney', 'subscription', 'https://www.disneyplus.com/series/the-bear/1aNbB0hl5LS9')] },
  { title: 'The Boys', year: 2019, type: 'show', poster: null, rentOrBuy: [],
    offers: [offer('prime', 'subscription', 'https://www.primevideo.com/detail/0KRGHGZCHKS920ZQGY5LBRF7MA')] },
  { title: 'The Last of Us', year: 2023, type: 'show', poster: null, rentOrBuy: [],
    offers: [offer('max', 'subscription', 'https://play.max.com/show/the-last-of-us')] },
  { title: 'The Office', year: 2005, type: 'show', poster: null, rentOrBuy: [],
    offers: [offer('peacock', 'subscription', 'https://www.peacocktv.com/watch/asset/tv/the-office'), offer('tubi', 'free with ads', 'https://tubitv.com/series/the-office')] },
  { title: 'Dune: Part Two', year: 2024, type: 'movie', poster: null, offers: [],
    rentOrBuy: ['Apple TV (rent)', 'Apple TV (buy)', 'Amazon Video (rent)'] },
  { title: 'Severance', year: 2022, type: 'show', poster: null, rentOrBuy: [],
    offers: [offer('appletv', 'subscription', 'https://tv.apple.com/us/show/severance/umc.cmc.1srk2goyh2q2zdxcx605w8vtx')] },
];
