# Controls card, swipe-up sheet, light/dark, swipe pad, TV close-up

Riley's request (2026-10-21), with a reference screenshot of another home app (a Mac menu-bar
panel: a big, bright isometric model on top; below it ONE rounded card holding everything — a
header row with the home name, "2 of 5 lights on", a sun/appearance button, a reorder button and
a big round power button; a row of scene buttons; room chips with counts; then device tiles in a
two-column grid with warm-tinted "on" tiles):

> Give our app this UI, with all of the controls grouped onto a card like this. Swipe the card up to
> see more of the controls; it stops about an inch short of the top, and the 3D model gets smaller
> and moves up into the space left between the top of the card and the bottom of the Dynamic
> Island, with a smooth animation timed with the card's swipe so everything is smooth. I also like
> the light mode / dark mode option. Swap the remote's D-pad + OK for a swipe pad: swipes move,
> taps click, with a subtle halo effect for swipes and clicks, and a light vibration on taps like
> the iPhone keyboard, while still telling taps from swipes. When I select the TV (in the model or
> its tile) and the remote opens, the model zooms to the TV screen as if standing ~3 ft in front of
> it, looking straight on. When the remote's card is swiped up, the small view at the top is a
> smaller version of that straight-on TV view, not the whole apartment. The remote opens with the
> card already swiped up.

The reference is inspiration for layout and feel only. Keep House Control's own identity
(fonts, icons, colours, the 3D model, tile designs from the reorder work), but restructure it.

## 1. The card

All panel controls (header, scenes, room chips, device tiles, and device sheets such as AC/light/TV)
live on one rounded card (radius ~28, inset 10–12 px from the screen sides on phone, flush
inside the Mac panel's glass), sitting over the 3D view. The header moves *onto* the card:
home name + status line on the left; on the right an appearance button (sun/moon), the edit
(pencil) button and the power-all button (bigger, round, accent-filled when anything is on).
The existing top header over the model goes away on phone (the model gets the whole top area);
on Mac/desktop/Windows keep only what the window needs (drag region in Electron) and move the
rest to the card too. Scenes, room chips (with an on-count badge per room, like the reference),
then the tiles. "On" tiles get a warm tint like the reference in light mode.

## 2. Swipe-up sheet (phone first; also Mac panel / desktop / Windows widget)

The card is a bottom sheet with two detents:

- **Rest** (default on the home page): the card's top sits where the panel starts today; the model
  fills the area above it at today's framing.
- **Expanded**: the card's top stops "about an inch" below the top: `cardTop = safeTop + 92` px on
  phone (safeTop = status bar / Dynamic Island inset; ≈ 150 px from the screen top on a 15 Pro).
  The model shrinks and moves into the strip between the bottom of the Dynamic Island
  (`safeTop + 4`) and the card top: a small, complete, centred view of the home.
- Drag anywhere on the card's header/handle area, or on the content when its scroll is at the top
  (scroll-then-drag hand-off like iOS sheets: pulling down at scrollTop 0 collapses; pushing up
  while not expanded expands before the content scrolls). A small grabber pill at the top centre.
- 1:1 tracking while dragging, rubber-banding beyond the detents. On release, pick the detent by
  projected position (position + velocity × ~0.2 s) and animate with a critically-damped-ish
  spring (no visible bounce at the end; ~350–450 ms), carrying the release velocity.
- **The model is driven by the same progress value** `p ∈ [0,1]` every frame (during the drag and
  the spring): the world's framing (insets/viewport and camera distance) is interpolated between
  the rest framing and the mini framing, so the model shrinks and slides up exactly with the card,
  never on its own timer. Implement as an explicit `world.setSheetProgress(p)` (or interpolated
  insets) evaluated in the render loop, not via `setInsets` + `resize` per frame if that rebuilds
  anything expensive. The canvas must stay at full size (no per-frame canvas resizes).
- Haptic: light tick when the sheet snaps to a detent.
- Tapping the mini model while expanded collapses the sheet. Picking in the mini model still works
  (lights toggle, AC/TV open).
- Mac menu-bar panel, desktop and the Windows widget: same sheet; drag with the mouse on the
  grabber/header, trackpad/mouse wheel scroll at content top also moves it; expanded detent
  leaves ~96 px for the mini model. Check that the Mac panel still fits and feels right.
- Reduced motion: no spring, short cross-fade.
- The editor (pencil) keeps working from either detent (collapse first, then its existing
  transition).

## 3. Light / dark mode

Today the panel is dark only. Add a light theme for the whole panel (card, tiles, sheets, chips,
remote, now playing, editor's sheet surfaces if cheap; the 3D scene background/lighting too:
light mode is a bright warm-white backdrop like the reference, dark is today's).
- The card's sun/moon button cycles **Auto → Light → Dark** (icon shows the current choice;
  a small toast/label names it). Auto follows `prefers-color-scheme`.
- Implement with CSS custom properties on `:root[data-theme=…]`; no duplicated rulesets per theme
  beyond the token definitions where possible. The 3D world gets a `setTheme('light'|'dark')`
  that changes background/fog/ambient/hemisphere/floor tint smoothly (~300 ms).
- Persist per device (localStorage; in the native apps also fine). Theme switch animates (colour
  transitions ~250 ms), no flash on load (apply before first paint from the saved value).
- Contrast must pass in both (text on tiles, chips, the TV sheet, logos).

## 4. Swipe pad (replaces the D-pad + OK)

A large rounded-rectangle touch surface (full card width minus margins, ~1:1 to 4:3, at least
240 px tall on phone) with a faint hint ("Swipe to move · Tap to select") that fades after first use
in a session. Back / Home / Play-Pause / Mute stay as round buttons around or below it.
- **Tap** (pointer up within 220 ms and < 10 px movement) → `ok`. Halo: a soft ring expands from
  the touch point and fades (~350 ms), plus a brief inner glow. Haptic: the keyboard-like light
  tick (iPhone app: `haptic('tick')`/selection; phone browser: the hidden-switch trick from
  reorder; Mac: trackpad alignment haptic).
- **Swipe**: once movement passes ~24 px, it's a swipe (never also a tap). The dominant axis
  gives the direction; send one step, then one more step for every further ~44 px travelled in that
  direction (touchpad feel), max ~8 steps per gesture; a fast flick (velocity > ~1.2 px/ms) at
  release adds 1–2 extra steps. Each step: a tick haptic and a halo — a soft glow that travels
  toward and brightens the edge in the swipe's direction (and a faint trail following the finger).
- A long press (> 500 ms, no movement) is neither a tap nor a swipe: it sends nothing.
- Keyboard (desktop/Mac) arrow keys / Enter still work when the remote is focused.
- `touch-action: none` on the pad, no text selection, no iOS callouts; the sheet drag must not
  start from inside the pad.

## 5. TV close-up camera

- Opening the TV sheet (picking the TV in the model, its tile, `?device=`, `openDevice`) flies the
  camera to a **straight-on view of the screen**: eye at the screen's centre height, ~0.9 m in front
  of the screen along its normal, looking at the screen centre, FOV chosen so the TV plus a little
  cabinet and wall around it fill the view. Animate the fly-in (~700 ms ease-in-out). Nearby walls
  or furniture between the camera and the TV must not block it (hide/fade occluders, or clip with a
  near plane; walls that the house view already cuts away stay cut).
- The remote opens with the card **expanded** by default. In this mode the mini strip at the top
  shows the same straight-on TV view, smaller (framed to the strip), not the whole home. Swiping
  the card down to rest shows the big straight-on TV view above the card. Same progress-driven
  interpolation as the home page, between the two TV framings.
- Closing the remote (back button, swipe from the left edge, Escape) flies back to the home view
  at whatever detent the home page was in.
- While the TV view is shown, the live screen texture (app logo / glow / off) is what you see —
  make sure it's crisp at this distance (raise the canvas texture resolution, e.g. 1024×576, only
  if needed, and use anisotropic filtering).

## Platforms

Web panel everywhere (iPhone app's web view, phone browser via the hub/Tailscale, Mac menu-bar
panel, Windows widget, desktop browser). Native: iPhone haptics already go through
`post('haptic')`; Mac uses the haptic handler from the reorder work. Also add the `hubRequest`
handler to the iPhone app's Swift (ios/), mirroring the Mac one, so the TV works there; it can't
be built here or on Riley's Mac (no Xcode), so keep it small and say so.

## Done when

- Screenshots + short Playwright videos (phone 390×844 `?platform=ios&safeTop=59&safeBottom=34`,
  Mac-panel size, desktop): home at rest and expanded (both themes); the swipe-up in motion (several
  frames showing the model shrinking in step with the card); the TV close-up at rest and with the
  card expanded (default on open); the swipe pad with a tap halo and a swipe halo mid-animation.
- Existing behaviours keep working: tile reorder (long-press drag within the card, also when
  expanded), light/AC sheets, now playing, editor, room focus, the Mac panel and Windows widget.
- Hub and web tests pass; web builds.

## Status

Built (October 2026), everything above; checked in Playwright (phone, Mac panel and desktop sizes),
not yet on an iPhone or Mac:

- **The card**: `web/src/ui/deck.js` (the two detents: 1:1 drag with a rubber band past either
  end, release projected 0.2 s ahead, a damped spring (response 0.4 s, damping 0.9) that keeps the
  finger's speed, content that scrolls first and hands the drag over at its top, a flick that
  carries on into the list, wheel and trackpad, a tick at each detent; reduced motion cross-fades
  in 180 ms). `ui/panel.js` puts the header, scenes, rooms and tiles on it; the grabber toggles it
  with a click or a key, and with a mouse the card is dragged by the grabber and its header. A sheet opened from home remembers where the card was and goes
  back there; the TV opens expanded, the light and AC sheets at rest. The editor puts the card
  down first, then opens.
- **The model in step**: `world.setSheetProgress(p)` from the card's frame (one loop for both: the
  card moves, then the model is drawn, in the same frame). The camera's goal never changes; the
  picture is zoomed and offset (`zoom` + `setViewOffset`) into the strip under the Dynamic Island
  (top of the card on a Mac or desktop), so the canvas is never resized while dragging. A tap on
  the small model puts the card down; a lamp there still switches, and the AC or another device
  still opens.
- **Light / dark**: `web/src/ui/theme.js` (Auto → Light → Dark on the card's sun / moon button,
  kept in `localStorage`, applied in `index.html` before the first paint, a pill names the choice)
  and the tokens at the top of `style.css`; `world.setTheme` blends background, hemisphere, moon
  light, exposure, bloom and plinth over 0.3 s. The page posts `theme` (`{theme, look}`): the Mac
  panel's window takes the choice and its glass a light or dark tint (`PanelController.setTheme`);
  the iPhone app's status bar follows (`RootView`), its own sheets stay dark. The editor stays
  dark. The Windows widget's tint is the theme's `--widget-bg`.
- **Swipe pad**: `createPad` in `web/src/tv/remote.js` with Back, Home, Play/Pause and Mute
  under it. A tap is a press that moves under 10 px and is let go within 500 ms (most taps are
  under 220 ms; a slower deliberate tap still selects); a swipe starts at 24 px and steps every
  44 px (8 at most), a release faster than 1.2 px/ms adds one or two, and a short quick flick is one
  step. Held longer than 500 ms without moving, it sends nothing.
- **TV close up**: `world.focus` on a TV flies (0.7 s) to 0.9 m straight in front of the screen at
  its centre height, the field of view fitted to the screen and its surround, the near plane
  pushed past anything in between, orbiting off. Pulled up, the small view is a rounded 2:1 window
  on the TV (a `clip-path` on the canvas). The screen texture is 1024 × 576 with the GPU's
  anisotropic filtering.
- **iPhone TV**: `hubRequest` in `ios/Sources/AppModel.swift` asks the hub beside the paired Mac
  (`SyncClient.macHost`, the sync connection's address, port 8766) through `LocalHubClient`; only
  `api/tv…` paths. Not built (no Xcode here or on Riley's Mac): its first build is its check.
- **Checked here**: hub tests, `web/tests/editor-model.mjs`, `editor.mjs`, the build; screenshots
  and frame-exact videos of every part at the three sizes in both looks; tile reorder in the
  expanded card; the editor from the expanded card; frame pacing of a drag (one transform a frame,
  no layout, no canvas resize).
- **Not yet checked**: the Swift (Mac `theme`, iPhone `hubRequest` and status bar), feel and frame
  rate on real hardware (there is no GPU here), and the haptics.
