# House Control for Windows

The control tile as a desktop widget: a frameless, see-through window cut to the card, with
no title bar, no taskbar button and no browser chrome. It shows the panel the hub on the Mac
serves, so it controls the same lights and AC, live.

## Install

Download `HouseControl-Setup-<version>.exe` from the latest `win-v*` release and run it. Windows
SmartScreen asks once for an unsigned app: **More info → Run anyway**. The portable .exe runs
without installing but can't update itself.

## Updates

The installed app checks the releases at start and every 4 hours, downloads a new version in the
background and swaps it in the next time the tile is hidden or loses focus. The tray menu shows the
version and the update status; click it to check now.

Most changes don't need a new app at all: the panel itself comes from the hub, so updating the
hub on the Mac updates the tile. A new app version is only for changes under `windows/`: bump
`version` in `windows/package.json` and push, and the **Windows app** workflow publishes the
release `win-v<version>` that installed copies pick up.

## Use

- Drag the tile by its header to put it anywhere on the desktop; it remembers the spot.
- The tray icon (by the clock) shows or hides it; **Ctrl+Alt+H** does the same from anywhere.
  **Esc** or **Alt+F4** tucks it away. Quit is in the tray menu.
- Tray menu → **Hub**: *Tailscale* (default; this PC must be in the same tailnet) or *Home Wi-Fi*
  (`http://192.168.0.188:8766`). **Edit settings file…** takes any other address (`"hub"` in
  `%APPDATA%\House Control\settings.json`).
- Tray menu → **Always on top**, **Start with Windows** (starts in the tray).
- If the hub can't be reached, the tile says so, retries every 15 seconds and offers the other address.

## Develop

```
cd windows
npm install
npm start          # the widget, against the hub in settings.json
npm run dist       # dist/*.exe (on Windows; on Linux electron-builder needs wine)
```

The page comes from the hub (`web/` built and served by `hub/house.py`) with `?platform=web` so a
440 px window keeps the desktop layout. `src/main.js` adds the CSS that fills the window with the card,
makes the header the drag handle and gives the glass an opaque tint (a transparent window has no
desktop behind it for the page to blur).
