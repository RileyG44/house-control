import { isNative, call } from '../bridge.js';
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';

let state = { available: false, devices: [], track: null, error: 'Connecting to Spotify…' };
const listeners = new Set();
let timer = 0;
let reading = null;
let tail = Promise.resolve();
const emit = () => listeners.forEach((fn) => fn(state));

async function request(body) {
  if (isNative) {
    let result;
    try {
      result = await call('hubRequest', { method: body ? 'POST' : 'GET', path: 'api/spotify', ...(body ? { body } : {}) });
    } catch (error) {
      // The shell rejects any reply with an `error`. A Spotify GET also carries its setup
      // state (including whether the Mac app can be opened), which the remote must keep.
      if (!body && error.detail?.backend) return error.detail;
      throw error;
    }
    if (body && result.error) throw new Error(result.error);
    return result;
  }
  const response = await fetch('./api/spotify', { method: body ? 'POST' : 'GET', cache: 'no-store',
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Spotify cannot be reached');
  return result;
}

function schedule() {
  clearTimeout(timer);
  if (listeners.size && !document.hidden) timer = setTimeout(() => spotify.refresh(), 3000);
}

export const spotify = {
  get state() { return state; },
  subscribe(fn) {
    listeners.add(fn); fn(state); spotify.refresh();
    return () => { listeners.delete(fn); if (!listeners.size) clearTimeout(timer); };
  },
  refresh() {
    if (reading) return reading;
    reading = request().then((next) => { state = next; emit(); })
      .catch(() => { state = { ...state, available: false, error: 'The Spotify remote cannot reach your hub.' }; emit(); })
      .finally(() => { reading = null; schedule(); });
    return reading;
  },
  act(body) {
    const work = tail.then(async () => {
      try {
        await request(body);
        await spotify.refresh();
        return true;
      } catch (error) { state = { ...state, error: error.message }; emit(); return false; }
    });
    tail = work;
    return work;
  },
};
document.addEventListener('visibilitychange', () => { if (!document.hidden && listeners.size) spotify.refresh(); else clearTimeout(timer); });

const clock = (seconds) => `${Math.floor(Math.max(0, seconds || 0) / 60)}:${String(Math.floor(Math.max(0, seconds || 0) % 60)).padStart(2, '0')}`;

/** Shared by the Mac, Windows and phone web shells. All control remains on the hub. */
export function createSpotifyRemote() {
  const artwork = h('img.spotify-art', { alt: '', hidden: true });
  const placeholder = h('div.spotify-art.spotify-placeholder', icon('speaker', 50, 1.2));
  const title = h('div.spotify-title', 'Spotify');
  const artist = h('div.spotify-artist');
  const note = h('div.sheet-note.spotify-note', { role: 'status' });
  const play = h('button.round.spotify-play', { 'aria-label': 'Play', onclick: () => spotify.act({ action: spotify.state.playing ? 'pause' : 'play' }) }, icon('play', 24));
  const previous = h('button.round', { 'aria-label': 'Previous track', onclick: () => spotify.act({ action: 'previous' }) }, icon('previousTrack', 23));
  const next = h('button.round', { 'aria-label': 'Next track', onclick: () => spotify.act({ action: 'next' }) }, icon('nextTrack', 23));
  const seek = h('input.spotify-slider', { type: 'range', min: 0, max: 1, value: 0, step: 1, 'aria-label': 'Track position' });
  const times = h('div.spotify-times');
  const volume = h('input.spotify-slider', { type: 'range', min: 0, max: 100, step: 1, value: 0, 'aria-label': 'Spotify volume' });
  const output = h('select.scene-input', { 'aria-label': 'Spotify output' });
  const outputHint = h('p.spotify-output-hint');
  const open = h('button.pill', { onclick: () => spotify.act({ action: 'open' }) }, 'Open Spotify on Mac');
  const refresh = h('button.pill', { onclick: () => spotify.refresh() }, 'Refresh');
  let seekDragging = false, volumeDragging = false, pendingVolume = null, sendingVolume = false;
  seek.addEventListener('input', () => { seekDragging = true; times.textContent = `${clock(Number(seek.value))} / ${clock(spotify.state.track?.duration)}`; });
  seek.addEventListener('change', async () => { await spotify.act({ action: 'seek', position: Number(seek.value) }); seekDragging = false; });
  async function drainVolume() {
    if (sendingVolume) return;
    sendingVolume = true;
    try {
      while (pendingVolume !== null) {
        const level = pendingVolume; pendingVolume = null;
        await spotify.act({ action: 'volume', level });
      }
    } finally { sendingVolume = false; volumeDragging = false; }
  }
  volume.addEventListener('input', () => { volumeDragging = true; pendingVolume = Number(volume.value); drainVolume(); });
  output.addEventListener('change', () => { if (output.value) spotify.act({ action: 'transfer', device: output.value }); });
  const el = h('div.spotify-remote.sheet-scroll', note,
    h('div.spotify-cover', placeholder, artwork), title, artist,
    h('div.spotify-progress', seek, times), h('div.spotify-transport', previous, play, next),
    h('label.spotify-volume', icon('volume', 19), volume),
    h('div.field-label', 'Playing on'), output, outputHint,
    h('div.spotify-actions', open, refresh));
  const unsubscribe = spotify.subscribe((s) => {
    title.textContent = s.track?.title || 'Spotify'; artist.textContent = s.track?.artist || 'Your music, around the studio';
    const url = s.track?.artwork;
    artwork.hidden = !url; placeholder.hidden = Boolean(url);
    if (url && artwork.getAttribute('src') !== url) artwork.src = url;
    if (!url) artwork.removeAttribute('src');
    note.hidden = !s.error; note.textContent = s.error || '';
    play.replaceChildren(icon(s.playing ? 'pause' : 'play', 24));
    play.setAttribute('aria-label', s.playing ? 'Pause' : 'Play');
    for (const b of [play, previous, next]) b.disabled = !s.available;
    seek.disabled = !s.available || !s.canSeek || !s.track?.duration;
    if (!seekDragging) {
      seek.max = String(s.track?.duration || 1); seek.value = String(s.track?.position || 0);
      times.textContent = `${clock(s.track?.position)} / ${clock(s.track?.duration)}`;
    }
    volume.disabled = !s.available || s.volume == null || s.volumeSupported === false;
    if (!volumeDragging) volume.value = String(s.volume ?? 0);
    const opts = s.devices || [];
    const key = JSON.stringify(opts.map((d) => [d.id, d.name]));
    if (output.dataset.devices !== key) {
      output.replaceChildren(h('option', { value: '' }, opts.length ? 'Choose a speaker' : 'No speakers available'), ...opts.map((d) => h('option', { value: d.id }, d.name)));
      output.dataset.devices = key;
    }
    output.value = s.device || ''; output.disabled = !s.canTransfer || !s.available;
    outputHint.textContent = s.canTransfer ? 'Choose your Echo or another available Spotify Connect speaker.'
      : 'Choose the speaker in Spotify on your Mac. Connect your Spotify account to choose outputs here.';
    open.hidden = !s.canOpen;
  });
  return { el, stop: unsubscribe };
}
