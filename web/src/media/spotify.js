import { isNative, call } from '../bridge.js';
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';

let state = { available: false, devices: [], track: null, error: 'Connecting to Spotify…' };
const listeners = new Set();
let timer = 0;
let reading = null;
let tail = Promise.resolve();
const emit = () => listeners.forEach((fn) => fn(state));

async function request(body, path = 'api/spotify') {
  if (isNative) {
    let result;
    try {
      result = await call('hubRequest', { method: body ? 'POST' : 'GET', path, ...(body ? { body } : {}) });
    } catch (error) {
      // The shell rejects any reply with an `error`. A Spotify GET also carries its setup
      // state (including whether the Mac app can be opened), which the remote must keep.
      if (!body && path === 'api/spotify' && error.detail?.backend) return error.detail;
      throw error;
    }
    if (body && result.error) throw new Error(result.error);
    return result;
  }
  const response = await fetch('./' + path, { method: body ? 'POST' : 'GET', cache: 'no-store',
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
  const playlists = h('div.spotify-playlists');
  const libraryNote = h('p.spotify-output-hint.spotify-library-note', { role: 'status' });
  const more = h('button.pill', { hidden: true, onclick: () => loadPlaylists(false) }, 'More playlists');
  const open = h('button.pill', { onclick: () => spotify.act({ action: 'open' }) }, 'Open Spotify on Mac');
  const refresh = h('button.pill', { onclick: () => { spotify.refresh(); if (spotify.state.canTransfer) loadPlaylists(true); } }, 'Refresh');
  let libraryLoaded = false, libraryReading = false, libraryNext = null, libraryError = '', stopped = false, chosenOutput = '';
  function updateLibraryNote(s = spotify.state) {
    libraryNote.textContent = !s.available ? s.error || 'Spotify is temporarily unavailable. Try Refresh.'
      : !s.canTransfer ? 'Connect your Spotify account to choose playlists and your Echo here.'
      : libraryReading ? 'Loading your playlists…'
      : libraryError || (playlists.children.length ? 'Choose a playlist to play on the selected speaker.' : 'No playlists found in this Spotify account.');
  }
  async function loadPlaylists(reset) {
    if (libraryReading || stopped) return;
    libraryReading = true; libraryError = ''; more.disabled = true; updateLibraryNote();
    try {
      const result = await request(null, `api/spotify/playlists?offset=${reset ? 0 : libraryNext ?? 0}`);
      if (stopped) return;
      if (!result.available) throw new Error(result.error || 'Connect Spotify to browse your playlists.');
      if (reset) playlists.replaceChildren();
      for (const item of result.items || []) {
        playlists.append(h('button.spotify-playlist', { onclick: () => {
          const device = chosenOutput || spotify.state.device;
          spotify.act({ action: 'play', uri: item.uri, ...(device ? { device } : {}) });
        } }, h('span', h('b', item.name), h('small', item.owner || 'Spotify playlist')), icon('play', 18)));
      }
      libraryLoaded = true; libraryNext = result.next; more.hidden = libraryNext == null;
    } catch (error) { if (!stopped) libraryError = error.message; }
    finally {
      libraryReading = false;
      if (!stopped) {
        updateLibraryNote();
        more.disabled = !spotify.state.available || !spotify.state.canTransfer;
        for (const button of playlists.querySelectorAll('button')) button.disabled = more.disabled;
      }
    }
  }
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
  output.addEventListener('change', () => { chosenOutput = output.value; if (chosenOutput) spotify.act({ action: 'transfer', device: chosenOutput }); });
  const el = h('div.spotify-remote.sheet-scroll', note,
    h('div.spotify-cover', placeholder, artwork), title, artist,
    h('div.spotify-progress', seek, times), h('div.spotify-transport', previous, play, next),
    h('label.spotify-volume', icon('volume', 19), volume),
    h('div.field-label', 'Playing on'), output, outputHint,
    h('div.field-label', 'Your playlists'), libraryNote, playlists, more,
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
    if (chosenOutput && !opts.some((d) => d.id === chosenOutput)) chosenOutput = '';
    output.value = chosenOutput || s.device || ''; output.disabled = !s.canTransfer || !s.available;
    outputHint.textContent = !s.available ? s.error || 'Spotify is temporarily unavailable. Try Refresh.'
      : s.canTransfer ? 'Choose your Echo or another available Spotify Connect speaker.'
      : 'Choose the speaker in Spotify on your Mac. Connect your Spotify account to choose outputs here.';
    open.hidden = !s.canOpen;
    for (const button of playlists.querySelectorAll('button')) button.disabled = !s.available || !s.canTransfer;
    more.disabled = libraryReading || !s.available || !s.canTransfer;
    if (s.canTransfer && s.available && !libraryLoaded && !libraryReading) {
      // One library read per opening, rather than on every three-second player poll.
      libraryLoaded = true; loadPlaylists(true);
    }
    updateLibraryNote(s);
  });
  return { el, stop() { stopped = true; unsubscribe(); } };
}
