# Native iPhone app (SwiftUI, Liquid Glass)

Riley's request (2026-10-21): port House Control to a truly native iPhone app: SwiftUI with real
iOS 26 Liquid Glass and native performance, not a web view around the panel. It does what the web
panel does today (docs/card-sheet.md, docs/tv-remote.md, docs/tile-reorder-now-playing.md),
rebuilt natively, and talks to the hub on the Mac (hub/house.py).

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
 ├─ HubClient        URLSession: GET /api/plan, GET /api/tv, SSE /api/events, POST /api/call, /api/tv/{id}, /api/tv/search
 ├─ HomeStore        @Observable: plan, light/AC state by plan id, TV state, tile order, optimistic edits
 ├─ ThemeStore       auto / light / dark (AppStorage), resolved ColorScheme
 ├─ Scene3D          RealityKit RealityView: the home built from the plan, live lamp/AC/TV state, camera rigs
 └─ UI               HomeScreen = Scene3D + controls card (native sheet with two detents)
                       ├─ card: header, scenes, room sections (collapsible, reorderable), tiles
                       ├─ LightSheet, ACSheet (pushed inside the card)
                       └─ TVRemote (pushed inside the card, opens expanded)
```

### Hub connection

- Two addresses, tried in order, the one that answers `GET /api/plan` within ~1.5 s wins and is
  remembered: LAN `http://192.168.0.188:8766`, then Tailscale
  `https://rileys-macbook-air.tail946e94.ts.net:8451`. Both editable in a small Settings page
  (gear in the card header's overflow), stored in UserDefaults. Retry with backoff; re-pick on
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
- **Card progress drives the model**: the card's progress `p ∈ [0,1]` (rest → expanded) is
  computed every frame from the sheet's live height. The 3D view stays full screen and is never
  resized; it gets a `scaleEffect` + `offset` (anchor top) interpolated from the rest framing
  (model filling the area above the resting card) to the mini framing (model fitted into the strip
  between `safeTop + 4` and the expanded card's top). Taps keep working through the transform.
  Tapping the mini model while expanded collapses the card.
- **TV close-up**: opening the TV flies the camera (0.7 s ease-in-out) to 0.9 m straight in front
  of the screen at its centre height, FOV fitted to the screen and a little surround; walls or
  furniture between camera and screen are hidden (or the near plane pushed past them). With the
  card expanded the mini strip shows this TV view in a rounded 2:1 window, not the whole home.
  Closing the remote flies back to the home view at the home's detent.
- **Theme**: light mode = bright warm-white backdrop and lighting; dark = today's look. Blend
  ~0.3 s on change.

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
  light mode / glow in dark. Tap a lamp tile toggles it; tap its label area or long-press-release
  opens its page. AC tile: mode, current/target temperature, power. TV tile: app logo, "Netflix ·
  title" or "Off", power.
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
3. **Swipe pad + side buttons**: a large rounded pad beside a column of round buttons (Home above
   Back, Play/Pause, Mute) and an **upright volume** control (vertical capsule: + / level / −,
   drag to set, hold repeats), matching the web's current layout (commit e221e5e / 03595e0,
   `web/src/tv/remote.js`). The pad is a UIKit view (`UIViewRepresentable`) so its touches never
   start the sheet drag: tap (< 10 px, < 500 ms) = `ok`; swipe starts at 24 px, one step then one
   per 44 px (max 8), a release over 1.2 px/ms adds 1–2; long press sends nothing. Halo: a ring
   expanding from the tap point; for swipes a glow travelling to the edge in the swipe direction.
   `UISelectionFeedbackGenerator` tick on every tap and step (keyboard-like).
4. **Apps**: horizontally scrolling glass tiles with the brand logos, drawn natively (port
   `web/src/tv/apps.js` shapes to SwiftUI `Canvas`/`Path`, no image downloads); running app ringed.
   Tap = `open` (wakes the TV), optimistic "Opening Netflix…".
5. **Search**: a search field (debounced 350 ms → `/api/tv/search`), result rows with poster,
   title, year · Movie/Show and the app logos it streams on; tap a logo (or the row if one app) to
   `play`. Rent/buy only says so. Below: "Search on the TV for “…”" and "Type into the TV".

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

Not built yet.
