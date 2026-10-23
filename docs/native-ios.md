# Native iPhone app (SwiftUI, Liquid Glass)

Riley's request (2026-10-21): port House Control to a truly native iPhone app: SwiftUI with real
iOS 26 Liquid Glass and native performance, not a web view around the panel. It does what the web
panel does today (docs/card-sheet.md, docs/tv-remote.md, docs/tile-reorder-now-playing.md),
rebuilt natively, and talks to the hub (hub/house.py) on the home server, or the backup hub.

The existing `ios/` app (web view, HomeKit / Hue / Home Assistant, widgets, App Store edition)
stays as it is. The native app is a separate, self-contained project in `ios-native/`.

## Project

- `ios-native/project.yml` (XcodeGen), one app target `HouseNative`, display name **House**,
  bundle id `dev.riley.HouseControl`, iOS 26.0 deployment target, iPhone only, portrait,
  Swift 6 language mode with `@Observable` models. No package dependencies, no extensions.
- **No entitlements** (no App Groups, HomeKit, keychain groups): it signs with Riley's team
  `PMJ8NUCVG3` (the one `cua-setup/build-iphone-app.sh` uses), which may be a free personal team.
  The team goes in `ios-native/Config/Local.xcconfig` (gitignored, like `ios/Config/Local.xcconfig`);
  `Base.xcconfig` `#include?`s it. `CODE_SIGN_STYLE = Automatic`, build with
  `-allowProvisioningUpdates`.
- Info.plist: `NSLocalNetworkUsageDescription`, `NSAppTransportSecurity.NSAllowsLocalNetworking`
  (the LAN hub is plain HTTP on an IP address), `UIUserInterfaceStyle` unset (the app picks).
- `scripts/build-ios-native.sh`: `xcodegen generate`, `xcodebuild` for `generic/platform=iOS`
  (`DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`; xcode-select points at the
  Command Line Tools), then `xcrun devicectl device install app` + `process launch` to the
  paired iPhone when one is connected. A `sim` mode builds for the simulator when an iOS
  simulator runtime is installed (none is today).

## Architecture

```
HouseApp
 ├─ HubClient        URLSession: GET /api/plan, GET /api/tv, SSE /api/events, POST /api/call, /api/tv/{id}, /api/tv/search, /api/tv/catalog, /api/tv/title/{id}
 ├─ HomeStore        @Observable: plan, light/AC state by plan id, TV state, tile order, optimistic edits
 ├─ ThemeStore       auto / light / dark (AppStorage), resolved ColorScheme
 ├─ Scene3D          RealityKit RealityView: the home built from the plan, live lamp/AC/TV state, camera rigs
 └─ UI               HomeScreen = Scene3D + controls card (native sheet with two detents)
                       ├─ card: header, scenes, room sections (collapsible, reorderable), tiles
                       ├─ LightSheet, ACSheet (pushed inside the card)
                       └─ TVRemote (pushed inside the card, opens expanded)
```

### Hub connection

- Two hubs that keep the same plan (hub/README.md, "A second hub"): the **home server**
  (dell-server: LAN `http://192.168.0.127:8766`, Tailscale `https://dell-server.tail946e94.ts.net`)
  and a **backup hub** (the MacBook: LAN `http://192.168.0.188:8766`, Tailscale
  `https://rileys-macbook-air.tail946e94.ts.net:8451`). The home server's two addresses are asked
  for `GET /api/plan` at once (the LAN one 0.3 s ahead); only if neither answers within ~3 s are the
  backup's asked (up to 5 s, which a first Tailscale connection can need). While on the backup, the
  home server is asked again every 30 s; when it answers the app moves back (a new event stream, the
  plan read again). The card header shows "Backup hub · Mac" under the status line while on the
  backup; Settings shows which hub is in use and its address.
- Both hubs' addresses and the backup's name are editable in Settings (the card header's ⋯ → Hub
  addresses), stored in UserDefaults (`hub.primary`, `hub.backup`, `hub.backupName`). The older
  single list `hub.addresses` becomes the home server's, without any address of the backup hub (the
  hub used to run there), and the usual addresses when nothing is left. Retry with backoff; re-pick on
  `scenePhase == .active` and on network path change (`NWPathMonitor`).
- The hub needs no auth; requests without an `Origin` header pass its same-origin check. Never
  send or store anything from `~/.house-hub`.
- **SSE** `/api/events`: `URLSession.bytes(for:)`, parse `data:` lines; events carry
  `lights` / `acs` / `features` maps keyed by plan id, `tv`, and plan-changed / reload messages
  (read `web/src/bridge.js` `hubCall` / `onmessage` and `hub/house.py` `_apply`/`publish` for the
  exact shapes). Reconnect on drop. Keep the stream only while the app is active.
- **Commands**: `POST /api/call` `{"type":"command","id":<plan id>,"patch":{…},"state":{…}}` exactly
  as `web/src/store.js` `setLight` / `setAC` build them (on/brightness/colour temp/colour for
  lamps, power/mode/target/fan for ACs). Optimistic: apply locally at once, roll back with an
  error haptic + toast when the hub answers `{"error"}`. Slider drags are coalesced (send at most
  every ~120 ms, always the final value).
- **Plan saves** (tile and room order): `{"type":"savePlan","config":<whole plan with tileOrder>,"client":<id>}`,
  debounced 0.7 s, nothing when the order didn't change; adopt our own reload event in place.
- **TV**: `GET /api/tv`, `{"tv":…}` events, `POST /api/tv/{id}` (keys, `volume`, `open`, `play`,
  `seek`, `skip`, `text`, `search`), `GET /api/tv/search?q=` — shapes in docs/tv-remote.md and
  docs/tile-reorder-now-playing.md.
- **TV, direct** (docs/tv-launcher.md, phase 3): when the TV carries `direct` (the hub drives it
  through its launcher), the remote page asks the launcher itself (`LauncherClient`, port 8686)
  with a 600 ms timeout when it opens and whenever the network changes. With this phone's token
  (Keychain, from pairing on that page), the keys, pad, play/pause, seek, volume and typing go
  to it, and the state comes from its long poll, mapped like hub/tv.py's `from_launcher`
  (`LauncherState`). Opening apps and titles, search, `menu`, a fixed volume's level and a wake
  the launcher didn't manage stay on the hub; any launcher failure goes back to the hub at once
  and the command is sent there (a 401 also forgets the token). The page's ••• menu says which
  way ("Direct to the TV" / "via Home server").

### Plan model

Own `Codable` types in the app (do not depend on `core/`, which pulls in HomeKit): rooms (rect or
poly), openings, furniture (type, position, size, rotation, `device` for TVs), lights (type, room,
position, link), acs, scenes, camera, wallHeight / interiorWallHeight, `tileOrder`, and room order.
Unknown keys must survive a save: keep the raw JSON object and write back only the keys we
change. Start from `web/public/plans/riley.json` bundled as the offline fallback, and the
normalisation in `web/src/config.js`.

## The 3D model (RealityKit)

There is no mesh file: the web builds the studio procedurally from the plan with three.js
(`web/src/three/house.js`, `furniture.js`, `kit.js`, `lights.js`, `ac.js`, `tv.js`, `world.js`).
Port that builder to RealityKit with `MeshResource` primitives (boxes, rounded boxes, cylinders,
extruded room polygons via `MeshDescriptor`) and `PhysicallyBasedMaterial`, matching the web's
look: plinth, floors, cut-away walls at `interiorWallHeight`, furniture pieces, lamp fixtures.
Build it once per plan rev, off the main actor where possible; static geometry merged by
material so the frame cost stays low (target 120 fps on the 15 Pro Max, never below 60).

- **Live state**: each lamp has an emissive bulb material and a `PointLightComponent` /
  `SpotLightComponent` whose intensity and colour follow brightness / colour temperature / colour
  (cap the number of real lights; fake the rest with emissive glow). ACs show on/off (and mode
  tint). The TV screen is a `TextureResource` drawn from the app logo (off = glossy black,
  on = brand background + logo, cross-fade ~300 ms).
- **Camera**: a `PerspectiveCamera` entity orbiting the home at the plan's `camera`
  azimuth/elevation; one-finger drag orbits, pinch zooms (clamped), like the web's world.
- **Picking**: `SpatialTapGesture` + `RealityViewContent`/`ARView`-free hit test
  (`entity(at:)` / `hitTest`) on `InputTargetComponent` + `CollisionComponent` per device:
  tap a lamp toggles it (tick haptic); tap the AC or TV opens its page in the card.
- **Card progress drives the model**: the card's progress `p ∈ [0,1]` (rest → expanded), plus
  its upward stretch to 1.08, is computed every frame from the sheet's live position. `StageFraming` keeps the RealityKit
  viewport at the full screen width and shortens its height as the card rises. The camera fits
  the home, room, AC or TV into the usable area above the card. The sky and landscape keep
  reaching both screen edges, and the renderer continues under the card with a soft bottom fade.
  Tapping the small model while expanded collapses the card; picking and orbit gestures stay
  attached to the renderer. Check its framing across phone sizes with:

  ```sh
  swiftc ios-native/Sources/Scene/StageFraming.swift scripts/test-stage-framing.swift -o /tmp/house-stage-check
  /tmp/house-stage-check
  ```
- **TV close-up**: opening the TV flies the camera (0.7 s ease-in-out) to 0.9 m straight in front
  of the screen at its centre height, FOV fitted to the screen and a little surround; walls or
  furniture between camera and screen are hidden (or the near plane pushed past them). With the
  card expanded the full-width strip shows this TV view with its wall and cabinet around it.
  Closing the remote flies back to the home view at the home's detent.
- **Theme**: light mode = bright warm-white backdrop and lighting; dark = today's look. Blend
  ~0.3 s on change. A plan with a `site` ignores the theme for the stage (below).
- **Landscape and sky** (plans with a `site`, docs/landscape-weather.md): `Landscape.swift` (the
  yard, the lake, the field, scrub; a 5 cm slab in place of the plinth), `Sky.swift` (the look from
  the real sun and moon, `Model/SunMoon.swift`, and the hub's weather, `Model/Weather.swift`; the
  dome, clouds, rain and snow, lightning). `HomeScene.applyLook` then takes its light from the sky.
  Launch arguments `-sky <kind> -skytime <HH:MM> [-skydate YYYY-MM-DD]` force a look and a local
  time at the house and skip the hub.

## The controls card

A real iOS sheet so it gets Liquid Glass, the system spring, and the scroll-then-drag hand-off for
free: `.sheet(isPresented: .constant(true))` on the 3D screen with
`.presentationDetents([rest, expanded], selection:)`, `.presentationBackgroundInteraction(.enabled(upThrough: expanded))`
(the model stays tappable), `.interactiveDismissDisabled()`, `.presentationDragIndicator(.visible)`,
and the iOS 26 default glass background (no custom background that would kill the glass).
- `rest` = the card top where the panel starts today (~45 % of the screen); `expanded` = card top at
  `safeTop + 92` pt (about an inch below the Dynamic Island).
- Progress is read every frame with `onGeometryChange` on the sheet content's height and published
  to the 3D screen (no animation of its own, so the model moves exactly with the card).
- Light tick (`.sensoryFeedback(.selection)`) when it settles on a detent.
- Inside: a `NavigationStack` so Light / AC / TV pages push within the card (back = swipe from the
  left edge or the back button). Opening the TV selects the `expanded` detent; light and AC
  pages open at rest; going back home restores the home's detent.
- If the sheet can't give a smooth per-frame progress or blocks the pad, fall back to a custom
  bottom card (`.glassEffect(.regular, in: .rect(cornerRadius: 28))`) with the same detents and
  a UIKit pan for the hand-off — decide by trying the sheet first on the device.

### Card contents (home)

- **Header** on the card: home name and "2 of 5 lights on" on the left; on the right the appearance
  button (sun / moon / circle-half: Auto → Light → Dark, a small capsule names the choice),
  edit/reorder toggle, and a big round power-all button (accent-filled when anything is on).
  Buttons use `.buttonStyle(.glass)` / `.glassProminent` inside a `GlassEffectContainer`.
- **Scenes** row from the plan's `scenes` (apply = the commands the web's scene code sends).
- **Rooms**: one section per room with its name and an on-count badge; tapping the header folds
  it away (chevron rotates, content collapses with a spring; folded state kept per room in
  UserDefaults, matching what the web panel stores where practical).
- **Tiles**: lamps in a two-column grid, AC and TV as full-width rows; on tiles get a warm tint in
  light mode / glow in dark. AC tile: mode, current/target temperature, power. TV tile: app logo,
  "Netflix · title" or "Off", power. Riley (2026-10-21):
  - **Tap** a tile = switch it on/off (lamp, AC power, TV wake/sleep).
  - **Slide sideways** across a lamp tile sets its brightness directly (the tile's fill shows the level,
    a tick every 5 %, sliding from off turns it on, commands coalesced); across the AC tile it sets the
    target (1° per ~24 pt, a tick per step, the value shown big while sliding). The axis is decided after
    ~8 pt: mostly vertical lets the card scroll.
  - **Press and hold** (medium haptic) then let go without moving = the device's page; hold then drag =
    reorder (below).
- **Scenes of your own**: a **+ New** chip ends the scenes row. A new scene captures every lamp as it is
  now (on/off, brightness, white temperature or colour) and, with "Include the AC", the AC (`on`, `mode`,
  `target`, `fan`); it gets a name and an icon from the set shared with the web panel (sun, bright, dim,
  sofa, film, tv, moon, bed, sparkles, leaf, kitchen, dining, bath, office, heat, cool, power; mapped to
  SF Symbols here, lucide there). Saved into the plan's ordered `scenes` with `savePlan`
  (`{"id":"custom-<slug>-<4 hex>","name","icon","lights":{"<id>":{…}},"acs":{"<id>":{…}}}`, one entry
  per lamp, no `"*"`, so web/src/store.js `applyScene` plays it). Holding a scene chip offers Edit (name,
  icon, take the lamps as they are now, include the AC) and Delete; the built-in ones can be edited and
  deleted too.
- **Reorder** (rooms and tiles): long-press (~0.38 s) lifts (scale 1.04, shadow, medium haptic),
  drag 1:1, others slide out of the way (spring), tick on each slot change, settle with a short
  spring; tiles move only within their room; rooms reorder as whole sections (collapse them while
  dragging). Persist tiles as `tileOrder` and rooms as the order of the plan's room list (or a
  `roomOrder` key if the web panel uses one — check `web/src/ui/panel.js`), saved via `savePlan`.
  Implement with a custom drag (not `List` edit mode) so it feels like the web's.

### Light and AC pages

Native versions of the web's sheets (`web/src/ui/panel.js` light and AC sheets): big power toggle,
brightness slider, white temperature slider, colour presets / picker when the lamp supports colour
(`capabilities`); AC: power, mode (cool/heat/dry/fan/auto), target temperature stepper / dial with
the hub's min/max, fan speed. Tick haptics on slider steps.

### TV remote page

Top to bottom (docs/tv-remote.md and docs/card-sheet.md):
1. Head: TV name, status ("Netflix", "Google TV home", "Off", "Not reachable"), power.
2. **Now Playing** when something plays: artwork thumbnail (`AsyncImage`, rounded, 16:9 or poster
   ratio) with the app badge, title (2 lines), subtitle, −10 s / play-pause / +30 s, and a
   scrubber extrapolated from `position` + `at` (`TimelineView(.animation)`), a time bubble while
   dragging, tick every 10 %, seek on release (optimistic). Not seekable → plain progress. When an
   app is open but nothing reports playing: the "Now on" strip with the app logo.
3. **Direction pad + side buttons** (Riley, 2026-10-21: "replace the swipe navigation panel with one like
   Google's Chromecast remote, the circle with the selection button in the center"): one big glass disc
   (~250 pt) with four chevron zones at its rim and a round **OK** in the middle (40 % of the disc). A press
   in a rim quarter is that direction, picked by its angle from the centre; a thin ring between OK and the
   rim does nothing; no swiping at all. Held, an arrow repeats after 300 ms every 120 ms. The pressed
   quarter lights up; a selection tick with each press and repeat, a firmer tap for OK. Its touches never
   start the sheet's drag (an immediate UIKit recognizer). Beside it: a column of round buttons (Home above
   Back, Play/Pause, Mute) and the **upright volume** (vertical capsule: + / level / −, drag to set, hold
   repeats).
4. **Apps**: horizontally scrolling glass tiles with the brand logos, drawn natively (port
   `web/src/tv/apps.js` shapes to SwiftUI `Canvas`/`Path`, no image downloads); running app ringed.
   Tap = `open` (wakes the TV), optimistic "Opening Netflix…".
5. **Search**: a search field (debounced 350 ms → `/api/tv/search`), result rows with poster,
   title, year · Movie/Show and the app logos it streams on; tap a logo (or the row if one app) to
   `play`. Rent/buy only says so. Below: "Search on the TV for “…”" and "Type into the TV".
6. **Pairing** (only when the launcher answers on this Wi-Fi and the phone has no token): one quiet
   row, "Faster remote: pair with the TV". It makes the TV show a 4-digit code (`/pair/start`) and
   opens a sheet with a 4-digit field; the fourth digit sends it (`/pair/finish`), Cancel hides
   the code (`/pair/cancel`). The ••• menu in the head also pairs, or forgets the pairing.

## Theme

`ThemeStore` (`auto|light|dark` in `@AppStorage`) → `.preferredColorScheme(nil|.light|.dark)` at the
root, the 3D backdrop, and tile tints. Colours as named tokens (asset catalog colour sets with
any/dark appearances) mirroring the tokens at the top of `web/src/style.css`.

## Done when

- `scripts/build-ios-native.sh` builds with no warnings-as-errors failures and installs and
  launches on Riley's iPhone 15 Pro Max (iOS 27.2, connected by cable).
- On the phone: the studio model renders with live lamp / AC / TV state; tapping a lamp switches
  the real lamp; the card drags between two detents with the model shrinking under the Dynamic
  Island in step; light/dark/auto; rooms fold and reorder; tiles reorder and the order survives a
  relaunch and shows in the web panel; light and AC pages control the devices; the TV remote's
  pad, side buttons, volume, apps, search, now playing and the close-up camera work against the
  real TV.
- README section for the native app; this doc's Status filled in with what was and wasn't checked.

## Status

Built (October 2026) in `ios-native/` (XcodeGen `project.yml`, Swift 6, iOS 26, no package dependencies,
no entitlements), signed with team `PMJ8NUCVG3` (a free personal team: its profiles last 7 days).
`scripts/build-ios-native.sh` generates, builds, installs on the iPhone connected by cable and launches.

What is where:

- `Sources/Hub/HubClient.swift`: the home server's addresses (LAN and Tailscale, asked at once) and the
  backup hub's, asked when the server doesn't answer within ~3 s, with the server tried again every 30 s
  (all editable under the card's ⋯ → Hub addresses), reconnect with backoff, re-pick on `scenePhase` and network path
  changes, `/api/events` read with `URLSession.bytes` while the app is active.
- `Sources/Model/`: `Plan` (the plan kept as JSON so a save writes back every key; normalised like
  config.js; walls split like house.js), `HomeStore` (optimistic lamp / AC commands, one in flight per
  device and the rest merged, roll-back with an error tick and a toast; tile order, room order and scenes
  saved with `savePlan` 0.7 s after the last change, only ever onto a plan read from the hub in this
  session), `TVStore` (state, held optimistic fields, a queue per TV that drops a held key's backlog,
  search).
- `Sources/Scene/`: the RealityKit model built from the plan once per plan (house, all 30 furniture
  builders, merged into one mesh per material), lamps with their glow and a real light each (RealityKit's
  eight, the moon included), the AC’s LED, flap and moving airflow streaks (fan speed and swing follow the unit,
  and low vents skim above the floor), the TV's picture drawn from the app logos (`ImageRenderer`)
  with a 0.3 s cross-fade, image-based light blended between the dark and light looks, the camera rig of
  world.js (orbit, pinch, room / AC focus, the 0.7 s fly to 0.9 m in front of the TV with the near plane
  pushed past what stands between). The card's progress scales and moves the full-screen `RealityView`
  into the strip under the Dynamic Island; in front of the TV the strip is a rounded 2:1 window.
- `Sources/UI/`: the sheet (two custom detents, `presentationBackgroundInteraction`, the iOS 26 glass), a
  probe that reads the sheet's presentation layer every frame (so the model follows the system spring
  too), the header with glass buttons, scenes (and scenes of your own), rooms that fold and tiles that
  switch, slide and reorder, room ordering, the light / AC / TV / scene / hub pages. iOS 26 floats a
  partial sheet higher than its detent height says; the app measures where the card settles once per
  launch and keeps the correction (`card.restFix` / `card.expandedFix`).

Checked on Riley's iPhone 15 Pro Max (iOS 27.2), from screenshots taken with
`xcrun devicectl device capture screenshot` (no simulator is installed here):

- It installs and launches; it finds the hub on the Wi-Fi and shows the live state (5 of 5 lights on,
  their real colours, the AC on Auto 72°, the TV and its app).
- The studio renders in RealityKit with the lamps lit in their colours, the AC's wash, the TV showing the
  running app's picture; dark and light looks; the card at rest and pulled up with the model in the strip
  (the sheet's position read every frame through the system's spring, logged on the device); the card
  stops at `safeTop + 92` after the measured correction.
- The light and AC pages (the camera on the room / the AC), and the TV page (it renders; its first
  version, with the swipe pad, before the direction pad replaced it).
- Riley used the build on the phone while it was being made (rooms folded, the look switched), so taps,
  folding and the appearance button work.

Not checked (the phone was disconnected from the Mac for the last part of the work, and touches can't be
driven from here):

- The direction pad, sliding across tiles, tap-to-switch / hold-to-open, scenes of your own (new, edit,
  delete), tile and room reordering with their haptics, and that the order and scenes reach the web panel
  — all built, none seen on the phone. Nothing was sent to the real devices or saved to the hub from here.
- The TV close-up flight and its 2:1 window on the phone (the fix that links the TV before flying landed
  after the last screenshot), seeking and now playing against something that reports over Cast, search
  results, app launches.
- Frame rate: debug builds write it every 2 s to `Documents/frames.txt` in the app's container
  (`xcrun devicectl device copy from --domain-type appDataContainer --domain-identifier
  dev.riley.HouseControl --source Documents --destination …`); not read yet.
- The scene format: colours are written as `"#rrggbb"` strings, which is how the hub and the store keep a
  lamp's colour; `[r, g, b]` (0–255) is read too.
