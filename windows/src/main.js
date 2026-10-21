// House Control for Windows: the panel the hub serves, in a frameless, transparent window
// cut to the control tile, with a tray icon to bring it back. Nothing runs here but the
// window; the lights and the AC are driven by the hub on the Mac.

const { app, BrowserWindow, Tray, Menu, ipcMain, screen, shell, globalShortcut, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { setupUpdates, describe } = require('./updates');

const HUBS = {
  tailscale: 'https://rileys-macbook-air.tail946e94.ts.net:8451',
  lan: 'http://192.168.0.188:8766',
};
// The tile is .card in web/src/style.css (440 × 800, radius 34). The window adds a
// transparent margin so the card's shadow has somewhere to fall.
const CARD = { width: 440, height: 800 };
const PAD = 14;
const SHORTCUT = 'Control+Alt+H';

const settingsFile = path.join(app.getPath('userData'), 'settings.json');
let settings = { hub: HUBS.tailscale, onTop: false, bounds: null };
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }; } catch { /* first run */ }
const save = () => {
  try { fs.mkdirSync(path.dirname(settingsFile), { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2)); } catch { /* not fatal */ }
};

let win = null;
let tray = null;
let quitting = false;
let retryTimer = null;
let updates = { state: { status: 'idle' }, check: () => {} };

// Fills the window with the card and gives it what a browser tab would not: an opaque
// enough tint in the panel's light or dark look (a transparent window has no desktop behind
// it to blur) and a strip along the top to drag it by.
const TILE_CSS = `
  html, body { background: transparent !important; }
  #app { padding: ${PAD}px !important; place-items: stretch !important; }
  .card { width: auto !important; height: auto !important;
    box-shadow: 0 10px 22px -8px rgba(0, 0, 0, 0.6), 0 2px 8px -2px rgba(0, 0, 0, 0.45) !important; }
  .notch { display: none !important; }
  html.glass .card-clip {
    background: var(--widget-bg) !important;
    backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }
  .top { -webkit-app-region: drag; }
  .top button, .top [role="button"], .top a, .top input, .top .ai-badge { -webkit-app-region: no-drag; }
  ::-webkit-scrollbar { width: 0; height: 0; }
`;

function hubUrl() {
  // platform=web keeps the desktop layout: the hub picks the phone layout for windows under 600 px.
  const url = new URL(settings.hub);
  url.searchParams.set('platform', 'web');
  url.searchParams.set('mode', 'panel');
  return url.toString();
}

function size() {
  const area = screen.getPrimaryDisplay().workArea;
  return { width: CARD.width + PAD * 2, height: Math.min(CARD.height + PAD * 2, area.height - 8) };
}

function startBounds() {
  const { width, height } = size();
  const saved = settings.bounds;
  if (saved) {
    const area = screen.getDisplayMatching({ ...saved, width, height }).workArea;
    const x = Math.min(Math.max(saved.x, area.x - PAD), area.x + area.width - width + PAD);
    const y = Math.min(Math.max(saved.y, area.y - PAD), area.y + area.height - height + PAD);
    return { x, y, width, height };
  }
  // Like a tray flyout: bottom right, just above the taskbar.
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + area.width - width - 6 + PAD, y: area.y + area.height - height - 6 + PAD, width, height };
}

function createWindow() {
  win = new BrowserWindow({
    ...startBounds(),
    title: 'House Control',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: settings.onTop,
    skipTaskbar: true, // a widget on the desktop, not an app window: it lives in the tray
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: true,
    },
  });
  win.setMenu(null);

  const wc = win.webContents;
  wc.on('dom-ready', () => { if (!wc.getURL().startsWith('file:')) wc.insertCSS(TILE_CSS); });
  wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3: aborted by a newer navigation
    showOffline(description || `Error ${code}`);
  });

  // Links out of the panel open in the browser; the window itself never leaves the hub.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    if (url.startsWith('file:') || new URL(url).origin === new URL(settings.hub).origin) return;
    event.preventDefault();
    shell.openExternal(url);
  });

  // Esc hides the tile, unless the panel has a device sheet open (it closes that itself).
  wc.on('before-input-event', async (_e, input) => {
    if (input.type !== 'keyDown' || input.key !== 'Escape') return;
    const sheetOpen = await wc.executeJavaScript("!!document.querySelector('.sheet:not(.hidden)')").catch(() => false);
    if (!sheetOpen) win.hide();
  });

  win.on('moved', () => { settings.bounds = win.getBounds(); save(); });
  // Closing (Alt+F4) hides to the tray; Quit is in the tray menu.
  win.on('close', (event) => { if (!quitting) { event.preventDefault(); win.hide(); } });

  load();
}

function load() {
  clearTimeout(retryTimer);
  win.loadURL(hubUrl()).catch(() => { /* reported by did-fail-load */ });
}

function showOffline(reason) {
  const page = path.join(__dirname, 'offline.html');
  win.loadFile(page, { query: { hub: settings.hub, reason, tailscale: HUBS.tailscale, lan: HUBS.lan } });
  clearTimeout(retryTimer);
  retryTimer = setTimeout(load, 15000);
}

function toggle() {
  if (win.isVisible() && win.isFocused()) { win.hide(); return; }
  win.show();
  win.focus();
}

function useHub(url) {
  settings.hub = url.replace(/\/+$/, '');
  save();
  load();
  buildTrayMenu();
}

function buildTrayMenu() {
  const hubItem = (label, url) => ({ label, type: 'radio', checked: settings.hub === url, click: () => useHub(url) });
  const custom = !Object.values(HUBS).includes(settings.hub);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show House Control', accelerator: SHORTCUT, click: () => { win.show(); win.focus(); } },
    { type: 'separator' },
    { label: 'Hub', submenu: [
      hubItem('Tailscale (anywhere)', HUBS.tailscale),
      hubItem('Home Wi-Fi (LAN)', HUBS.lan),
      ...(custom ? [{ label: `Custom: ${settings.hub}`, type: 'radio', checked: true }] : []),
      { type: 'separator' },
      { label: 'Edit settings file…', click: () => { save(); shell.openPath(settingsFile); } },
    ] },
    { label: 'Reload', click: load },
    { label: 'Always on top', type: 'checkbox', checked: settings.onTop,
      click: (item) => { settings.onTop = item.checked; win.setAlwaysOnTop(item.checked); save(); } },
    { label: 'Start with Windows', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }) },
    { type: 'separator' },
    { label: `Version ${app.getVersion()} · ${describe(updates.state)}`, enabled: ['idle', 'current', 'error'].includes(updates.state.status),
      click: () => updates.check() },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
  app.whenReady().then(() => {
    app.setAppUserModelId('local.housecontrol.windows');
    createWindow();
    // Started at login (--hidden): stay in the tray until clicked.
    if (!process.argv.includes('--hidden')) win.once('ready-to-show', () => win.show());

    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png')));
    tray.setToolTip('House Control');
    tray.on('click', toggle);
    buildTrayMenu();
    globalShortcut.register(SHORTCUT, toggle);
    updates = setupUpdates({ win, onChange: buildTrayMenu });

    ipcMain.on('house:retry', load);
    ipcMain.on('house:hide', () => win.hide());
    ipcMain.on('house:use-hub', (_e, url) => { if (typeof url === 'string' && /^https?:\/\//.test(url)) useHub(url); });

    // The tile keeps its size when the display changes (scaling, a new monitor).
    screen.on('display-metrics-changed', () => win.setBounds({ ...win.getBounds(), ...size() }));
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('house:quitting', () => { quitting = true; });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => {}); // lives in the tray
}
