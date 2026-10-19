// Keeps the installed app current: checks the fork's GitHub releases at start and every few
// hours, downloads a new version in the background and swaps it in while the tile is out of
// the way (hidden or not focused), then starts again where it was. The portable .exe and
// `npm start` can't replace themselves, so they only say what they are.

const { app } = require('electron');

const EVERY = 4 * 60 * 60 * 1000;

function setupUpdates({ win, onChange }) {
  const state = { status: 'idle', version: null };
  const set = (status, version = state.version) => { Object.assign(state, { status, version }); onChange(); };
  const supported = app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR;
  if (!supported) {
    state.status = app.isPackaged ? 'portable' : 'dev';
    return { state, check: () => {} };
  }

  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  let installing = false;
  const install = () => {
    if (installing) return;
    installing = true;
    app.emit('house:quitting');
    autoUpdater.quitAndInstall(true, true); // silent, start again afterwards
  };
  // Don't pull the tile out from under a click: wait until it's put away or loses focus.
  const installWhenIdle = () => {
    if (!win.isVisible() || !win.isFocused()) { install(); return; }
    win.once('blur', install);
    win.once('hide', install);
  };

  autoUpdater.on('checking-for-update', () => set('checking'));
  autoUpdater.on('update-not-available', () => set('current'));
  autoUpdater.on('update-available', (info) => set('downloading', info.version));
  autoUpdater.on('update-downloaded', (info) => { set('ready', info.version); installWhenIdle(); });
  autoUpdater.on('error', () => set('error'));

  const check = () => autoUpdater.checkForUpdates().catch(() => set('error'));
  setTimeout(check, 10 * 1000);
  setInterval(check, EVERY);
  return { state, check };
}

function describe(state) {
  switch (state.status) {
    case 'checking': return 'Checking for updates…';
    case 'current': return 'Up to date';
    case 'downloading': return `Downloading ${state.version}…`;
    case 'ready': return `Updating to ${state.version}…`;
    case 'error': return 'Couldn’t check for updates';
    case 'portable': return 'Portable copy: install to get updates';
    case 'dev': return 'Development build';
    default: return 'Check for updates';
  }
}

module.exports = { setupUpdates, describe };
