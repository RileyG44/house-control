# House Control: the new home editor (design spec)

Riley's ask: the control panel's editor is "completely unusable" in the Windows widget. Redesign and
rewrite the editing UI/UX so editing and adding rooms and their elements feels native and magical in
the widget and the mobile/web app, is solid on the Mac app, the Windows app and the website, and any
edit made on one interface shows up on all of them.

This document is the whole brief for the build. Everything marked **P0** must ship; **P1** should ship;
**P2** only if everything else is done and polished.

---

## Status at hand-off (2026-10-19, paused for a usage reset)

Built, on `main`:
- Hub: plan revision and the saving screen's id in the reload event (`hub/house.py`).
- The new editor in `web/src/edit/` (plan, bottom sheet and docked card, pages, Add catalog, device
  pickers, undo, autosave) and the in-panel edit mode (pencil in the panel header, the 3D-to-plan
  morph, the card growing on a desktop). Exercised with Playwright screenshots at widget size
  (468 × 828 with the widget's `TILE_CSS`), phone size (390 × 844) and desktop (1440 × 900).
- `npm --prefix web run build` passes.

Not done or not checked yet:
- §9.4 standalone editor (`?mode=editor`: the Mac editor window and the iPhone app): not checked.
- §9.5 live sync between two open screens: the hub side is in; the web side (hot-swap,
  `adoptRemote`) is not checked.
- §9.6 plain browser preview (no hub): not checked.
- §8 Mac Swift change (close the editor window on `close`, `canClose` in its boot payload): not done.
- §8 home-screen web app (manifest and icons): not done. P2 items: not done.
- Nothing is deployed to Riley's Mac yet; the hub there still serves the old editor.

---

## 0. Where things are

- Repo: `/home/claude/house-control` (fork `RileyG44/house-control`, remote `origin`). Work on branch
  `wiz-mrcool-hub` (currently equal to `main`, both at d31c5e7). Git identity is already set.
- Web UI: `web/` (Vite 8, three 0.186, lucide 0.544; no other dependencies; do not add any).
  Build: `npm --prefix web run build` → `web/dist`, which the hub serves.
- Hub: `hub/house.py` (Python aiohttp; serves `web/dist`, `/api/events` SSE, `/api/call`, `/api/plan`).
  Tests: `hub/tests/test_hub.py` (pytest, which is not installed in this container and must not be
  installed for this task: update the tests for your hub change, and check the change here with a
  short script that drives a test hub instead).
- Mac app: `macos/Sources/HouseControl/*.swift` (WKWebView hosts the same web bundle with
  `isNative`), iOS app `ios/Sources/*.swift`. These cannot be built in this container; keep the web
  side compatible with them (see §8).
- Windows widget: `windows/` (Electron; loads the hub URL with `?platform=web&mode=panel` in a
  frameless transparent 468 × 828 window; the card is 440 × 800 inside a 14 px margin; injects
  `TILE_CSS`, see `windows/src/main.js`).

### Files you will read first
`web/src/main.js`, `web/src/bridge.js`, `web/src/config.js`, `web/src/store.js`, `web/src/ui/panel.js`,
`web/src/ui/dom.js`, `web/src/ui/icons.js`, `web/src/style.css`, `web/src/three/world.js`,
`web/src/three/house.js` (`wallSegments`), `web/src/three/furniture.js` (`FURNITURE_TYPES`,
`footprint`), the old editor `web/src/editor/editor.js` + `editor.css` + `connections.js` (logic to
port, layout to throw away), `hub/house.py` (`save_plan`, `_rebuild_plan`, `make_app`).

### Test hub already running in this container
A hub runs on `http://127.0.0.1:8777` (pid from `pgrep -f 'python3 house.py'`), started from `hub/` with
`HOUSE_HUB_DIR=/tmp/claude-0/hubtest/conf HOUSE_PANEL_PLAN=/tmp/claude-0/hubtest/panelplan.json
HOUSE_HUB_PORT=8777 HOUSE_HUB_WIZ_PORT=38999 nohup python3 house.py > /tmp/claude-0/hubtest/hub.log 2>&1 &`.
`/tmp/claude-0/hubtest/conf/plan.json` is a copy of Riley's real plan ("Riley's Studio": a Studio with a
Bathroom drawn inside it, 5 lights linked to WiZ/AiDot, 1 MRCOOL AC in °F, 16 furniture pieces, 4
openings). Copy it to `/tmp/claude-0/hubtest/plan.fixture.json` before your first save so you can
restore it. Never commit it. Restart the hub after changing `house.py` (kill by pid, not with a
`pkill -f` pattern that also matches your own shell). It cannot reach real devices: WiZ is "connected"
with no lights, AiDot/MRCOOL are not signed in, so `devices.all` is empty. For testing the device
pickers and "On your network", stub `call('devices.all')` from a Playwright script or temporarily
monkeypatch `catalog()`; do not commit stubs.

Screenshots: `node /tmp/claude-0/shoot.mjs <url> <WxH> <out.png> [scale] [script.js]` (Playwright
1.56 + SwiftShader WebGL, `hasTouch: true`; the script body gets `page`). Write your own Playwright
scripts for multi-step flows (import from `/opt/node-tools/node_modules/playwright/index.mjs`, launch
Chromium with the same `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader
--ignore-gpu-blocklist` args). Put screenshots in `/tmp/claude-0/shots/edit/`.

---

## 1. The idea in one paragraph

Editing happens **inside the panel**, in place, with no page change. Tap the pencil in the panel's
header: the 3D house swoops to a straight-down view, cross-fades into a crisp 2D floor plan in the
same spot, and an iOS-style bottom sheet slides up. You move rooms and things by dragging them on the
plan (they snap together with guides), resize rooms by their edges, and add rooms, lamps, ACs, doors,
windows and furniture from a visual catalog in the sheet. Tapping anything opens its card in the
sheet (name, type, real device, delete). Every change saves itself within a second and every other
screen follows live. Tap Done: the plan fades back into the 3D model, which rises to the usual view
with its lights coming on. On a wide screen the same editor spreads out: plan on the left, the card
docked on the right.

---

## 2. Where the editor runs (P0)

| Surface | How it loads | Pencil does | Editor form | Saves through |
|---|---|---|---|---|
| Website, desktop browser (hub) | hub URL, `platform=web` | in-panel editor; the card grows to fill the window when the viewport is ≥ 980 × 640 (P1) | overlay, wide layout once grown | `call('savePlan')` → hub |
| Phone browser (hub over Tailscale/LAN) | `platform` resolves to `ios` (width ≤ 600) | in-panel editor, full screen | overlay, narrow | hub |
| Windows widget (Electron) | hub URL `platform=web&mode=panel`, 440 × 800 card | in-panel editor inside the card; the card never grows | overlay, narrow | hub |
| Mac menu bar panel (native) | WKWebView, `isNative`, glass | `post('openEditor')` (the app opens its editor window) | standalone `mode=editor`, wide (window 1240 × 800, min 980 × 640) | `call('savePlan')` → Mac app → its plan file → hub adopts it |
| iPhone app (native) | WKWebView, `platform=ios` | `post('openEditor')` (native screen hosting `mode=editor`) | standalone, narrow | native `savePlan` |
| Plain browser / `vite dev` (demo plans, no hub) | `./plans/home.json` | in-panel editor | overlay; status says "Preview, not saved"; Done applies the edit to this page only | nothing (offer "Download plan") |
| Old links `?mode=editor` on the hub | hub | n/a | standalone; Done goes back to the panel URL | hub |

Layout is chosen from the editor's own container size, re-evaluated on resize: **wide** when the
container is ≥ 900 px wide and ≥ 560 px tall, otherwise **narrow**.

---

## 3. Panel changes (P0)

- Header (`ui/panel.js`): add a round **pencil** button (`aria-label="Edit home"`, lucide `Pencil` or
  `PenLine`; add it to `ui/icons.js`) just left of the power button.
  - Hub: the gear goes away. Its two items move into the editor: "Find new lights and ACs" becomes
    "Look for new devices" in the Add catalog (§6.4); the plan name was decorative.
  - Native Mac and plain browser keep the gear menu (plans, AI access, login item, quit…); the menu's
    "Edit home…" item stays and does what the pencil does. iPhone app keeps its gear (`openSettings`).
- `main.js` boot is refactored into `mountHome(raw, opts)` → `{ raw, config, store, world, panel, card,
  dispose() }`. `dispose()` stops everything it started: `world.dispose()`, a new `store.dispose()`
  (clears the temperature-simulation interval and listeners, flushes the pending localStorage write),
  a new `panel.dispose()` (removes its `window` keydown listener and its `store.on` subscription,
  clears timers), the ResizeObserver, document/window listeners added in boot. `incoming.*` handlers are
  simply reassigned by the next mount.
- Device state survives a remount: add `store.exportState()` → `{ lights, acs, scene, features }` and
  `store.importState(s)` that applies it like `applyRemote` (never sends commands). The hub's SSE
  connection lives in `bridge.js` and is not reopened, so the new store must be seeded from the old.
- Keep `window.__house = { store, world, panel, config }` pointing at the current mount, and add
  `window.__house.edit()` to open the editor (handy for tests).

---

## 4. Live sync between screens (P0)

### Hub (`hub/house.py`)
- `self.plan_rev`: an integer bumped whenever `_rebuild_plan` changes `self.plan`.
- The reload event becomes `{"reload": true, "rev": <n>, "by": <client id or null>}`.
- `save_plan(config, by=None)` passes `by` through to the event and returns `{"ok": true, "rev": n}`
  (also when nothing changed: the current rev).
- `/api/call` `savePlan` reads `body.get("client")`. `/api/plan` adds an `X-Plan-Rev` header. The boot
  object injected by `index()` gets `"rev"`.
- Extend `test_editor_saves_the_plan_for_every_screen` (or add a test) for the rev and `by`.

### Web
- `bridge.js`: a per-page `CLIENT_ID` (random) exported; on `{reload}` call
  `incoming.planChanged(update)` when set, else `location.reload()` as now.
- The editor's saves send `{ config, client: CLIENT_ID }`.
- `main.js` `incoming.planChanged`: ignore when `update.by === CLIENT_ID` (our own echo). Otherwise
  fetch `./api/plan` (no-store). If the editor is open, hand it over with `editor.adoptRemote(raw)`;
  else **hot-swap**: `mountHome(newRaw)` with a quick cross-fade (no page reload; keep the selected
  room if it still exists; transfer device state). If the fetch fails, fall back to `location.reload()`.
- Standalone editor in hub mode handles `planChanged` the same way via `adoptRemote`. Standalone in
  native mode keeps `incoming.planArrived(config, from)` (the Mac app calls it when the hub saved).

### What reaches what
- Hub save (website, phone, widget) → hub writes `~/.house-hub/plan.json` and the Mac app's plan file
  (same bytes and mtime) → SSE reload to every web client (hot-swap) → the Mac app's 2 s file watch
  reloads its panel and island and calls `planArrived` on an open editor window.
- Mac editor window save → Mac app's plan file → hub adopts newer file within 5 s → SSE reload to all
  web clients. (Already works; keep it working.)
- `adoptRemote(raw)` in an open editor: if there is no unsaved local change and no gesture in
  progress, take it (keep the selection when the item still exists, by id or by index for furniture and
  openings), push the previous doc on the undo stack, toast "Updated from another screen". If there
  is an unsaved local change, keep the local doc (it saves over the other one; last writer wins) and
  toast "Another screen changed the plan. Your edit replaces it." Defer while a drag is in progress.

---

## 5. Editor architecture

New folder `web/src/edit/` replaces `web/src/editor/` (delete `editor.js` and `editor.css`; move and
rewrite `connections.js`). Suggested modules (adjust if a better split appears):

- `model.js`: pure helpers on the plan document. Collections (`rooms`, `lights`, `acs`, `furniture`,
  `openings`, `scenes`), `ensureArrays`, `bounds` (rooms **and** everything else, for fitting),
  `roomAt(pos)` returning the **smallest** room containing the point, `uniqueId`, `slug`, `fix`
  (3 decimals), snapping, `snapAC`, riders of a room, add/remove/duplicate with cascades, room presets,
  furniture names, units and formatting.
- `glyphs.js`: top-down SVG glyph for every furniture type (§7.4), drawn in metres in the item's local
  frame, used both on the plan and as catalog thumbnails.
- `plan.js`: the interactive 2D plan (SVG): rendering, view (pan/zoom), hit testing, gestures, handles,
  snapping guides, drawing a room.
- `sheet.js`: the container that holds pages. Narrow: a bottom sheet with detents. Wide: a docked
  side card. Both share a page stack with push/pop.
- `forms.js`: iOS-style grouped list building blocks (§7.5).
- `pages.js` (split if long): Home, Add, Room, Light, AC, Furniture, Opening, Scene, Settings, pickers.
- `connections.js`: the platforms, the device catalog, the pickers (logic ported from
  `editor/connections.js`, rendering redone with `forms.js`). `smartlife.js`: the Smart Life sign-in
  page ported from the old `tuyaPanel` (native Mac only).
- `editor.js`: the controller. `createEditor(host, opts)`:
  - `opts`: `{ raw, mode: 'overlay' | 'standalone', store?, initialView?, canSave, onDone(doc), insets? }`
  - returns `{ el, view(), fitInsets(), adoptRemote(raw, from), done(): Promise<doc>, destroy() }`
  - owns: `doc`, selection, undo/redo, autosave, status, keyboard, layout switching.
- `edit.css`: all editor styles, scoped under `.ed` (and `html.mode-editor` for standalone).

Lazy-load it (`import('./edit/editor.js')`) as the old editor was, so the panel bundle stays small;
start the import at the first pointerdown on the pencil so it is ready when the morph ends.

Code style: match the surrounding code (ES modules, `h()` from `ui/dom.js`, `icon()` from
`ui/icons.js`, short comments that say why, UI copy in the existing voice: "Colour", sentence case).
Keep `window.__editor = { get doc(), select, ... }` for tests.

---

## 6. UX

### 6.1 Entering and leaving (overlay mode)

Enter (P0 for the fade; P1 for the camera morph):
1. Close any open device sheet or menu. Add `.editing` to `.card`: the header, scenes, rooms, tiles and
   tint fade out (200 ms) and stop taking input; `.top` becomes `display:none` once faded (the Windows
   widget makes `.top` a window-drag region and a hidden one would still swallow clicks).
2. P1 morph: the stage grows to the full card (`.card.editing .stage { height: 100% }`, mask and the
   header gradient off), `world.setInsets(editorTop, editorBottom)` using the editor's narrow insets,
   then `world.topDown(true, { duration: 650 })`: a timed ease-in-out tween of az → 0, el → 89.5 (az 0
   is north-up, which is how the plan is drawn: x right, z down), fitted to the whole home. Resolve a
   promise when it lands. Add `world.projectFloor(x, z)` → `{ x, y }` in canvas CSS px, and a
   `world.topDown(false)` that tweens back to the plan's default camera.
3. Create the editor with `initialView` computed from `projectFloor` of two opposite corners of the
   plan bounds, so the 2D plan appears exactly over the 3D floor. Fade the plan in (220 ms), then fade
   the canvas out and `world.setRunning(false)`. The sheet slides up to its first detent with a spring.
   Then the plan animates from `initialView` to its own fit.
4. P1 desktop: when the window is ≥ 980 × 640 (and not phone, not Electron), the card grows
   (`width: min(1280px, 100vw - 36px); height: min(880px, 100vh - 36px)`, 450 ms `var(--ease)`); the
   editor switches to the wide layout as it crosses 900 px and re-fits the plan smoothly.
5. If anything in the morph fails, fall back to the plain cross-fade. If the editor module fails to
   load, toast the error and restore the panel.

Done (P0):
1. Flush the autosave and wait for it (status shows Saving…).
2. Animate the plan to its fit (250 ms).
3. `mountHome(newRaw, { editing: true })` builds the new panel and world while the plan still covers
   them: move the editor's element into the new card (`newCard.append(editor.el)`) in the same task so
   nothing flashes, keep `.editing` on the new card, transfer device state, dispose the old mount.
4. P1: the new world starts top-down (`topDown(true, { instant: true })`) aligned with the plan. The
   plan and the editor chrome fade out (top bar up, sheet down), `.editing` comes off (card shrinks
   back if it grew), and `world.topDown(false)` lifts the camera to the usual view while `intro()`
   lights the lamps one by one.
5. Plain browser: same, from the edited doc, nothing saved.

### 6.2 Narrow layout (widget card, phone, iPhone app)

- **Top bar** floating over the plan (glass, 52 px + safe area on phones): left: Undo, Redo (icon
  buttons, disabled when empty); centre: "Edit Home" and under it the save status (§6.9); right:
  **Done** (accent pill). Standalone in the Mac window: Done shows only when
  `__HOUSE_BOOT__.canClose` (§8). In Electron the bar is the window's drag region (§8).
- **Plan** fills the container under everything. Its fit area excludes the top bar and the sheet's
  current height, so the home is always centred in what is visible.
- **Floating controls** at the plan's right edge, just above the sheet, move with it: "Fit"
  (lucide `Scan`), and P1 a "2D | 3D" toggle.
- **Bottom sheet** (glass, top radius 26, grabber), detents:
  - *peek*: the current page's summary block only (title row + quick actions), measured, about
    120–190 px plus safe area;
  - *medium*: about 52 % of the container;
  - *large*: up to just under the top bar (the top bar stays visible and usable).
  Drag the grabber or header to move it; release snaps to the nearest detent with a velocity flick.
  When the content is scrolled to the top, dragging down on the content moves the sheet (iOS). Use
  touch events with `preventDefault` for that hand-off (pointer events get `pointercancel` once the
  browser starts scrolling). Pages pushed from peek open at medium. Selecting on the plan opens the
  item at peek (or keeps medium/large if the user had it there) and pans the plan so the item is not
  under the sheet.

### 6.3 Wide layout (desktop window, Mac editor window, grown card)

- Top bar across the top (undo/redo, title + status, 2D|3D, Done).
- Plan fills the left; a docked card on the right (width 380, margin 16, full height under the top
  bar, same glass and page stack, no detents, its own scroll).
- Mouse and trackpad first: hover highlights, cursors (`grab`, `move`, `ew-resize`/`ns-resize`/
  `nwse-resize` on handles, `crosshair` while drawing), keyboard shortcuts (§6.10).

### 6.4 Pages

Every page has: a header (icon tile, title, subtitle, right side close/back), an optional quick
actions row (round 52 px buttons with labels, like iOS share-sheet actions) which together form the
*summary* shown at peek, then the body (grouped lists). Back is a chevron with the previous page's
short title. Pushing slides in from the right, popping slides back (iOS timing, 350 ms
`cubic-bezier(.32,.72,0,1)`).

**Home** (root, nothing selected)
- Summary: home name (large title), "2 rooms · 5 lights · 1 AC", and a prominent **Add** button (accent,
  `+`). If the hub reports devices that are not on the plan yet, a tinted row "3 new devices found ›"
  under it opens Add scrolled to them.
- Body: **Rooms** (rows: floor swatch, name, size in the home's units, device count; tap selects the
  room on the plan and opens it), **Scenes** (rows; "New scene" row), **Connections** row (status like
  "WiZ · AiDot · MRCOOL"), **Home settings** row, and a short tip footer ("Drag rooms to move them.
  Touch and hold anything to pick it up.").

**Add** (catalog; pushed from Home or from a room; sheet goes to large)
- Target room: the selected room, or the room of the selected item, or the room under the centre of
  the visible plan, or the first room. Shown as a header chip "Adding to Studio ›" (tap to change).
- **On your network** first when non-empty (hub, or native with connections): devices from
  `devices.all` that no plan item links yet. Row: online dot, name, "WiZ · Kitchen", **Add** button →
  creates a light or AC linked to it (`link: { service, id }`; Smart Life uses `tuya.deviceId` like the
  old picker), named after the device, in the room whose name matches the device's room
  (case-insensitive) or the target room, capabilities and AC range matched from the device. Last row
  (hub): "Look for new devices" → `POST ./api/rescan`, spinner, then reload the catalog.
- **Rooms**: preset tiles (icon, name, default size in the home's units): Living room 4.5 × 4 oak,
  Bedroom 3.6 × 3.4 oak, Kitchen 3.2 × 3 tile, Bathroom 2.4 × 2.2 tile, Office 3 × 3 oak, Dining room
  3.6 × 3.2 walnut, Hallway 1.4 × 4 stone, Closet 1.6 × 1.6 oak, and **Draw a room** (P1: the sheet drops
  to peek, the plan shows "Drag to draw the room" and a Cancel chip; drag a rectangle with snapping and a
  live size label; on release the room is created, selected and its name field is ready). A preset
  room is placed against the home: to the right of the overall bounding box (top-aligned) when the
  home is taller than wide, below it (left-aligned) otherwise, sharing the wall line so the walls join.
  Names are made unique ("Bedroom 2").
- **Lights**: Ceiling, Pendant, Spots, Floor lamp, Table lamp, Light strip. Placed at a free spot in the
  target room (port `freeSpot`), named "<Room> <kind>", capabilities `['brightness']` until linked.
- **Climate**: Air conditioner, snapped to the middle of the target room's north wall (or the first
  wall without an AC), unit °F when the home uses imperial units (min 61 max 86), else °C (16–30).
- **Doors & windows**: Door 0.9 m, Window 1.2 m, Open passage 1.0 m. Placed centred on a wall of the
  target room (doors prefer a wall shared with another room, windows an exterior wall), shifted so
  they do not overlap an existing opening.
- **Furniture**: every `FURNITURE_TYPES` entry with its glyph thumbnail and a friendly name (Sofa,
  Armchair, Coffee table, TV, Sideboard, Dining table, Kitchen island, Kitchen counter, Fridge, Bed,
  Nightstand, Dresser, Plant, Vanity, Bathtub, Toilet, Desk, Wardrobe, Bookshelf, Rug). Placed at the
  centre of the target room (nudged to a free spot).
- After adding: the sheet drops to the new item's page at peek, the plan smoothly brings the item into
  view, and the item drops in (scale 1.12 → 1 with a fading ring, 300 ms spring). Haptic `medium`.

**Room**
- Summary quick actions: Add light, Add door, Duplicate, Delete.
- Name (inline text row), Floor (four swatch chips: Oak, Walnut, Tile, Stone), Size (Width and Depth
  steppers; step 10 cm or 3 in), **In this room** (rows for each light, AC, door/window and piece of
  furniture inside it; tap opens it), **Add to this room** chips (Light, AC, Door, Window, Furniture →
  Add page filtered), destructive **Delete room**.
- Delete asks with an action sheet that says what happens: devices standing inside another room move
  there ("2 lights move to Studio"), the rest are removed with the room, and so are furniture and
  openings that are only inside this room. The last room cannot be deleted (row disabled, footer says
  why). Everything is undoable.

**Light**
- Summary: icon tile (type icon, glowing in the light's live colour in overlay mode), name, "Studio ·
  Table lamp · WiZ"; quick actions: Turn on/off (overlay mode, only for lights already in the live store:
  `store.toggleLight`, so you can see which bulb it is), Duplicate, Delete.
- Name; **Type** chip grid with icons (Ceiling, Pendant, Spots, Floor, Table, Strip); **Room** row → room
  picker page (checkmark list); **Real device** row (value: device name and platform, or "Simulated") →
  device picker page (§6.6); **What it can do** toggles (Dimming, White temperature, Colour) with the
  footer "Matched from the device" when linked; **Placement** group: Height stepper with an "Auto" state
  (deletes `y`), for strips Length and Rotation steppers; Delete.
- P2 hint: if the light stands inside a smaller room than the one it is assigned to, show "It stands in
  Bathroom. Move it there?" with a one-tap fix.

**Air conditioner**
- Summary: icon, name, "Studio · west wall · MRCOOL"; quick actions: Duplicate, Delete.
- Name; Room row; **Wall** segmented (N, E, S, W; changing re-snaps to that wall's middle); Real device
  row; **Room temperature** row → sensor picker; **Units** segmented (°F, °C; switching converts min/max)
  and **Range** min/max steppers; Mount height stepper; Delete.

**Furniture**
- Summary: glyph tile, friendly name, "Studio" (or "Outside the home"); quick actions: Rotate 90°,
  Duplicate, Delete.
- Type grid (glyph thumbnails, 4 columns; changing keeps position and rotation); Width stepper for
  resizable types (sofa, coffeeTable, tv, sideboard, diningSet, island, kitchen, bed, dresser, vanity,
  desk, wardrobe, bookshelf); Size W × D for a rug; Rotation stepper (15°) and the two 90° buttons;
  Colour swatches (sofa, armchair, bed, rug; eight swatches plus Default); Chairs stepper (diningSet,
  2–8), Stools (island, 0–4), Upper cabinets toggle (kitchen), Height (wardrobe, bookshelf); Delete.

**Door / window / opening**
- Summary: icon, "Door", "0.9 m · Studio / Bathroom"; quick actions: Delete.
- Type segmented (Door, Window, Open); Width stepper; windows: Sill and Top steppers; when it is not on
  any wall line, a warning row "Not on a wall" with **Snap to nearest wall** (Riley's plan has one such
  window at x 0.35 against a wall at x 0.4). Delete.

**Scene** (scenes are not on the plan; reached from Home)
- Name; Icon grid (sun, sofa, film, moon, door, table, bed, tv, sparkles, power); P1 **Use the lights as
  they are now** (overlay mode: copies every light's on/brightness/temp or colour from the live store
  into the scene); **All lights** segmented (Leave, On, Off) and one row per light with the same
  segmented control (keep existing per-light brightness/temp/colour values when present; show them as
  the row's subtitle); **Air conditioners** segmented (Leave, On, Off); Delete scene.

**Home settings**
- Name; **Units** segmented (Feet, Metres; stored as `units: 'imperial' | 'metric'`); Wall height and
  Inner walls shown steppers; Outdoor temperature (stored in °C as now, shown in the home's units);
  View angle stepper (camera azimuth, 15° steps) with the existing note about cut-away walls; **Download
  plan** and **Import plan…** (file picker in a browser; `call('importPlan')` / `call('exportPlan')`
  natively, as the old editor did).

**Connections** and one page per platform
- List of the offered platforms (hub: WiZ, AiDot, MRCOOL; native Mac: whatever `services.info` lists,
  including hub ones; plain browser: all, with the note that connecting needs the app or the hub) with
  status. A platform page: status card, its devices grouped (lights and plugs, ACs, sensors) with
  online dots and either "In plan: Edison Bulb" or an **Add** button, Refresh, and the native connect
  flows ported as they are (Home Assistant address + token with discovery, Hue bridge discovery and
  button pairing, Apple Home instructions, Smart Life QR sign-in and the advanced Tuya Cloud form).
  Hub platforms say they are driven by the hub on the Mac (see hub/README.md to sign in).

### 6.5 The plan

Rendering (SVG, two layers):
- *World layer* (metres, one `transform` for pan/zoom; rebuilt only when the doc changes): dot grid
  (every 0.5 m, stronger every 1 m, fading out when zoomed far out), floors (material tint plus a very
  subtle pattern: planks for oak/walnut, a 0.3 m grid for tile, 0.6 m for stone; larger rooms first so a
  room drawn inside another sits on top), walls from `wallSegments` (export it from `three/house.js`):
  exterior 0.2 m, interior 0.1 m, light warm grey like the 3D walls; doors as a gap plus a leaf and a
  quarter-circle swing into the room; windows as a pale blue double line in the gap; open passages as a
  plain gap; furniture glyphs (rotate with `rotate(-rot)`, front faces +z); AC units as a 0.9 × 0.22 m
  body on their wall; light strips as a bar of their length and rotation.
- *Overlay layer* (screen px, re-laid out on every view change): room name (13 px, 600) and size or area
  (11 px, muted) centred in each room, hidden when the room is too small on screen; light markers (24 px
  circles with the type icon; ring in the light's live colour and a soft glow when it is on in overlay
  mode; dashed ring when simulated); AC badges; selection outline (2 px accent, non-scaling) with a soft
  glow; handles; snap guides; live dimension pills.
- Colours follow `style.css`: background `#0b1020`, glass `rgba(255,255,255,.055/.1)`, lines
  `rgba(255,255,255,.085)`, accent `#3d8bff`, warm `#ffb46b`. Floors roughly: oak `#4d3f30`, walnut
  `#3d3029`, tile `#3a434d`, stone `#31363e`.
- Items outside every room (Riley has two) are drawn normally with a faint dashed outline; the fit
  includes them so they can be dragged back.

View: pan, pinch and wheel zoom (0.5 × to 8 × the fit scale), double-tap or double-click empty space to
fit, the Fit button, smooth animated transitions (fit, bring a selected item into view above the sheet,
include a newly added item). Re-fit on container resize while the user has not moved the view.

Gestures (one code path for mouse, pen and touch; manual hit testing in metres, not DOM targets):
- Hit priority: handles, light markers (18 px radius on screen), AC badges, openings (10 px from the
  segment), furniture (rotated footprint, smallest first), rooms (smallest first).
- Tap: select what was hit, or deselect (sheet back to Home) on empty space.
- Mouse/pen: press on an item selects it and dragging (> 3 px) moves it; press on empty space pans.
- Touch: one finger on the **selected** item (or on a handle) drags it at once; one finger elsewhere
  pans; **touch and hold** (300 ms, < 8 px movement) on any item selects and lifts it (haptic `medium`,
  1.04 scale and shadow) and the same finger drags it; two fingers pinch and pan. A second finger during
  an item drag ends the drag (committed) and starts the pinch.
- Wheel: `ctrlKey` (trackpad pinch) zooms at the cursor; a plain mouse-wheel notch (|deltaY| ≥ 40, no
  deltaX) zooms; anything else pans.
- Dragging past the edge of the visible plan auto-pans gently.

Editing on the plan:
- **Room move**: carries its contents (lights and ACs of that room, furniture and openings inside it,
  rooms nested inside it and their contents). Its edges snap to other rooms' parallel edges within
  10 px on screen, otherwise movement snaps to 5 cm; an engaged snap shows a dashed accent guide across
  the plan and ticks (haptic `tick`).
- **Room resize**: when a room is selected, edge handles (pills on each edge's midpoint) and corner
  handles (dots). Dragging snaps the moving edge to other rooms' edges and to 5 cm; minimum 0.8 m.
  Live size pills on the edges. ACs on a moving wall follow it (stay on their wall, clamped), and so do
  openings lying on that edge; lights and furniture stay put.
- **Light**: moves freely (5 cm); its `room` becomes the smallest room under it. Strips: a rotate handle
  (15° snap, stronger at 90°) and end handles for length.
- **AC**: snaps to the nearest wall of the smallest room under the pointer (port `snapAC`).
- **Furniture**: moves freely; rotate handle on a short stem off the front edge (15° snap, stronger at
  90°); width handles on the left/right ends for resizable types; corner handle for a rug's size.
- **Door/window**: slides along its wall line, clamped to that wall; dragged more than 0.6 m away from
  the wall it jumps to the nearest other wall under the pointer (re-oriented). End handles change its
  width (minimum 0.4 m). An opening that is not on a wall snaps onto the nearest one when moved.
- Every drag is one undo step and one save, committed on release.

### 6.6 Device pickers

Pages, not `<select>`s. Search field when more than 8 devices. First row "Not linked (simulated)" or,
for a thermometer, "None (estimated)". Devices grouped by platform; each row shows an online dot,
name, room and detail, a checkmark on the current one, and a muted "Used by Kitchen Light" when another
plan item links it (still selectable). A current link not in the list shows as its own checked row
("WiZ · 444f8e0068c8 · not found now"). Choosing a light device copies its capabilities; an AC copies
min/max; a Smart Life sensor is only offered beside a Smart Life AC (as now). Pop back after choosing,
with a toast saying what was matched ("Matched: dimming, white temperature, colour").

### 6.7 Making it feel native

- Spring physics for the sheet, push/pop transitions, the drop-in for new items, the selection pulse.
- Deleting shows a snackbar "Deleted Bedroom · **Undo**" for 5 s instead of a confirm dialog for single
  items; rooms with contents ask first (action sheet) and are still undoable.
- Haptics through `haptic()` in `bridge.js` (iPhone app only; a no-op elsewhere): `light` on select,
  `tick` on snaps and stepper steps, `medium` on lift/add, `success` on Done.
- Text inputs ≥ 16 px on phones. Rows 44 px (widget/desktop) / 50 px (phone). Respect safe areas.
- No browser chrome feel: no text selection except in inputs, no tap highlight, no rubber-band
  scrolling of the page, `touch-action: none` on the plan.
- Empty states: a home with one empty room shows a friendly card in the sheet ("Add your first lamp")
  with the three most likely actions.
- Accessibility: buttons have labels; focus rings on keyboard focus; the plan has a keyboard path
  (Tab cycles items, arrows nudge).

### 6.8 3D preview (P1)

The "2D | 3D" toggle shows a live 3D world of the edited doc in the plan's place (`createWorld` with a
preview store: lights on at 2700 K / 85 %, ACs cooling; in overlay mode existing lights use their live
state). Rebuild 400 ms after the last change while visible; dispose when hidden. Tapping a lamp, AC or
room in 3D selects it.

### 6.9 Saving

- Autosave: each committed change schedules a save 600 ms later (`call('savePlan', { config: doc,
  client: CLIENT_ID })`), coalescing bursts; one save in flight at a time; a change during a save
  schedules another. Never save a doc that `normalize()` rejects (keep the UI from creating one; if it
  happens, show the issue in red under the title and do not save).
- Status in the top bar: "Saving…" (spinner) → "Saved" (check, fades to muted) / "Not saved, tap to
  retry" (red) / "Offline" (hub unreachable; retries every 5 s) / "Preview, not saved" (plain browser).
- `Cmd/Ctrl+S` saves at once. Done waits for the save.
- IDs never change on rename (scenes and hub links depend on them). New ids are unique across rooms,
  lights, ACs and scenes.

### 6.10 Undo, keyboard

- Undo/redo stacks of JSON snapshots (100 deep), a gesture or a burst of typing in one field is one
  step. Undo/redo autosave like any change. Selection survives when the item still exists.
- Keys (when not typing in a field): Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z or Ctrl+Y, Delete/Backspace,
  arrows nudge 5 cm (Shift 50 cm), Cmd/Ctrl+D duplicate, R rotate 90° (furniture, strips), Esc (cancel
  drawing, else pop page, else deselect, else nothing; in overlay mode Esc never closes the editor).

---

## 7. Details

### 7.1 Units
`doc.units` ('imperial' | 'metric'), default imperial when any AC has `unit: 'F'`, else metric.
Imperial lengths show as `12′ 6″` (nearest inch), areas in ft²; metric as `3.8 m` / `14.2 m²`.
Storage stays metres. Steppers: 10 cm or 3 in; heights 5 cm or 2 in.

### 7.2 Smallest-room rule
Everywhere a room is derived from a position (lights, ACs, furniture labels, add targets), use the
smallest room containing the point, so a bathroom drawn inside a studio wins.

### 7.3 Cascades
- Removing a light/AC removes it from every scene's `lights`/`acs` map.
- Removing a room: see §6.4 Room.
- Duplicating offsets the copy by 0.3 m (rooms: placed against the original like a preset) with a new
  id and name "… 2".

### 7.4 Furniture glyphs (top-down, local frame, front = +y)
bed (frame, headboard at the back, two pillows, duvet with a fold line), sofa (base, back cushion strip,
arms, seat cushions), armchair, coffee table (rounded, inner shelf), TV (console with the screen line at
the back), sideboard/dresser (door lines), dining table with chairs on the long sides (count from
`chairs`), kitchen island with stools in front (`stools`), kitchen counter (sink and four-ring hob),
fridge, nightstand, plant (leafy circle), vanity (basin), bathtub (inner tub, drain), toilet (tank and
bowl), desk with a chair, wardrobe (doors and a rail line), bookshelf (book stripes), rug (border inset,
in its colour). Sizes from `footprint(item)`. Fill `rgba(235,240,255,.10)`, stroke
`rgba(235,240,255,.38)` 1 px non-scaling; items with `color` mix it into the fill.

### 7.5 Forms (`forms.js`)
`group(title?, rows, footer?)`, `row({ icon, tint, title, subtitle, value, chevron, onClick,
destructive, disabled, accessory })`, `textRow`, `toggleRow`, `stepperRow({ value, format, step, min,
max, onChange })` with press-and-hold repeat, `segmented`, `chipGrid` (icon or glyph + label),
`swatches`, `button({ style: 'primary' | 'tinted' | 'destructive' | 'plain' })`, `note`,
`actionSheet({ title, message, actions, cancel })`, `toast(text, { action })`. Pages refresh by
re-rendering their body while keeping scroll position and the focused input (by a `data-key`) with
its caret; do not re-render pages during a drag, only on commit.

---

## 8. Platform specifics

**Windows widget (Electron)**
- Add `html.electron` when `navigator.userAgent` contains `Electron`. In `edit.css`:
  `html.electron .ed-bar { -webkit-app-region: drag }` and `no-drag` on everything interactive in it.
  Nothing interactive may sit under a drag region (the sheet's large detent stops below the bar).
- The widget hides its window on Esc unless `document.querySelector('.sheet:not(.hidden)')` matches.
  While the editor is open, keep a hidden marker `<i class="sheet" hidden>` inside the editor (comment
  why) so Esc stays with the editor. No widget release is needed for this feature.
- The card never grows there (window is fixed); narrow layout only.

**Phone browser**
- `html.ios` already gives the full-screen card and safe areas (`--safe-top`, `--safe-bottom`; preview
  them with `?safeTop=47&safeBottom=34`). Editor top bar and sheet respect them.
- P1 home-screen web app: in `web/index.html` add `apple-mobile-web-app-capable`,
  `mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style=black-translucent`,
  `apple-mobile-web-app-title=House`, `theme-color #0a0e1a`, an apple-touch-icon and a
  `manifest.json` (name "House Control", short_name "House", display standalone, colours #0a0e1a,
  start_url "./", icons 192 and 512). Make the icons from `windows/assets/icon.png` (PIL is already
  installed here) into `web/public/icons/`.

**Mac app**
- The panel's pencil posts `openEditor`; the editor window loads `mode=editor` (standalone, wide).
  Standalone needs its own page frame: opaque `#0a0e1a` background, no `#app` padding (beware
  `html.native` rules in `style.css`), full window.
- Native `close` currently hides the menu bar panel even when the editor window sends it. Small Swift
  change in `AppDelegate.swift`: on `close` from the editor's host, close the editor window
  (`EditorController.close()` → `window.close()`); the editor host's boot payload gets
  `canClose: true`. The web shows Done in a native Mac editor only when `canClose` is true, so the old
  app binary simply has no Done button (its window close button works). Do not build the Mac app; it
  is rebuilt on Riley's Mac afterwards.
- Native saves keep `call('savePlan', { config })`; the reply has no rev. `planArrived(config, from)`
  must keep working.

**iPhone app**: `platform=ios`, native. Done → `post('close')`. Connections rows →
`post('openConnection', { service })` as before.

---

## 9. Checks before you call it done

Run these yourself and look at every screenshot; iterate until it looks and feels like a native app:
no overflow, nothing clipped, text readable at 440 px, aligned spacing, no console errors.

1. Widget: load `http://127.0.0.1:8777/?platform=web&mode=panel` at 468 × 828 with the widget's
   `TILE_CSS` injected (copy it from `windows/src/main.js`, PAD 14). Tap the pencil. Screens: Home at
   peek, Home at medium, Add at large, a room selected with handles, a light page, the device picker
   (stubbed catalog), the furniture type grid. Drag a room (snaps to the other room's edge), resize it,
   add a Bedroom preset, add a lamp, delete it and undo, Done → 3D shows the change.
2. Phone: `?platform=ios&safeTop=47&safeBottom=34` at 390 × 844 with touch input (taps, long-press
   drag, two-finger pinch via CDP `Input.dispatchTouchEvent`). Sheet drag between detents.
3. Desktop browser at 1440 × 900: card grows, wide layout, mouse drag/resize/rotate, keyboard
   shortcuts, Done shrinks back.
4. Standalone: `?mode=editor&platform=web` at 1240 × 800 and `?mode=editor&platform=ios` at 390 × 844;
   Done returns to the panel (hub).
5. Sync: two pages on the hub. A edits (rename a room, move a lamp); B's panel hot-swaps without a
   reload (put a marker on `window` and check it survives) within ~2 s; A does not remount from its
   own echo; B's open editor adopts or keeps its edit as §4 says. The saved
   `/tmp/claude-0/hubtest/conf/plan.json` and `panelplan.json` (create the latter first so the hub
   mirrors to it) equal the doc and pass `normalize`.
6. Plain browser without the hub (`npm --prefix web run dev`, demo plan): editing works, status says
   preview, Done applies locally.
7. Your hub check script passes (rev bumps, `by` in the reload event, `X-Plan-Rev`, save returns the
   rev, both plan files written); `npm --prefix web run build` passes with no warnings you introduced.

## 10. Hand-off

- Commit in logical steps on `wiz-mrcool-hub` with clear messages ending with exactly:
  ```
  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_018QTxf6tHQsxa3EzRGQ3zmt
  ```
  Push (`git push -u origin wiz-mrcool-hub`, retry with backoff on network errors) and fast-forward
  `main` (`git push origin wiz-mrcool-hub:main`).
- Do not touch Riley's Mac, the real hub, or the Windows app version. Do not commit fixtures or stubs.
- Report back: what shipped (by section), what did not and why, the screenshot paths for each check in
  §9, and anything Riley should know.
