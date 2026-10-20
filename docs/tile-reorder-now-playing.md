# Reorderable tiles, and Now Playing on the TV remote

Riley's request (2026-10-20): "make it so that I can reorder the tiles by long holding them and
dragging them around. For instance, long press the TV tile and drag it up above the AC tile, and
rearrange the order of the lights in the grid. The whole operation should be smooth, with nice,
subtle, professional, modern animations and haptics; it should feel like a polished professionally
made application. Also add 'now playing' info to the remote, that shows what show or video or movie
is on currently, with a draggable slider for jumping around."

## 1. Reordering device tiles

The panel's device list (web/src/ui/panel.js) shows tiles grouped under room headings (lights in
a two-column grid, the AC and TV as full-width rows). Today their order comes from the plan.

**Gesture**
- Long press (~380 ms, cancelled if the pointer moves > 8 px first, so scrolling and taps work
  exactly as now) lifts the tile: it scales to ~1.04, gains a soft, larger shadow, the rest dim
  very slightly. Haptic on lift (iPhone: `haptic('medium')`; Mac app: trackpad haptic via a small
  new `haptic` handler using `NSHapticFeedbackManager` `.alignment`/`.levelChange`; phone browser:
  `navigator.vibrate(8)` where supported, plus the iOS 17.4+/18 Safari trick of toggling a hidden
  `<input type="checkbox" switch>` label for a tick where that works; no errors where nothing works).
- While dragging, the tile follows the finger 1:1 (transform only, no layout thrash). Other tiles
  slide out of the way with a FLIP animation (~220 ms, `cubic-bezier(.2,.8,.2,1)`). Mixed sizes
  must reflow correctly: full-width rows (AC, TV) and grid tiles (lights) can be interleaved.
  Each time the drop slot changes: a light tick haptic.
- Tiles can move anywhere **within their room section**; moving across rooms is not allowed (the
  lifted tile is clamped to its section, its section is subtly highlighted).
- Auto-scroll when dragging near the top/bottom edge of the scroll area.
- Drop: the tile settles into its slot with a short spring (~260 ms, slight overshoot), shadow
  fades, haptic('light'). Escape / pointercancel returns it to where it started.
- A tap after a drag never toggles the light; a long press never opens the sheet.
- Works with mouse (desktop, Windows widget, Mac menu-bar panel) and touch (phone). Reduced
  motion: no scaling/spring, instant moves. Keyboard: with a tile focused, Alt/Option + arrow
  moves it within its section (announce with aria-live).
- Also during a light-tile drag on the phone, the page must not scroll or select text, and iOS
  long-press callouts/magnifier must not appear (`touch-action`, `user-select`,
  `-webkit-touch-callout: none` on tiles).

**Persistence**
- Store order in the plan as a top-level `"tileOrder": ["<device id>", …]` (ids of lights, ACs, and
  TV tiles as `tv:<device id>`). Tiles not listed keep their plan order after the listed ones.
  Save through the existing plan save path (`call('savePlan', …)` as editor.js does) so it lands in
  `~/.house-hub/plan.json` and every other screen picks it up via the existing plan-changed sync.
  The panel must not visibly re-mount/flash when its own save comes back (adopt in place).
- Make sure `tileOrder` round-trips through hub/plan.py, config.js `normalize`, the editor model
  and the native plan decoding (Swift `HouseCore` plan model and the Mac panel's save handling;
  check that the Mac app's panel can save at all — if `savePlan` is only handled by the editor
  window, add it for the panel). Widgets (native) may optionally honour it; not required.
- Debounce saves; a drag that ends where it started does not save.

## 2. Now Playing on the TV sheet

**Source**: the hub reads it directly from the TV over Cast (pychromecast, read-only, never
launching a receiver: see the CastLink reference the builder was given), with an optional ADB
media-session fallback for apps that don't report over Cast (title/state/position only, not
scrubbable). Add `pychromecast>=14,<15` to hub/requirements.txt. All of this lives in hub/tv.py
(or a new hub/nowplaying.py), keyed by the TV's host from tv-remote's `/api/devices`. Optional:
if pychromecast is missing or the TV is unreachable, now playing is simply absent.

**State**: each TV in `GET /api/tv` and the `{"tv": …}` event gets
```json
"nowPlaying": {"title": "Episode P - Bretz in the Scablands", "subtitle": "Nick Zentner",
               "state": "playing|paused|buffering", "position": 420, "duration": 9535,
               "seekable": true, "artwork": "https://i.ytimg.com/vi/<id>/hqdefault.jpg" | null,
               "app": "youtube", "at": <unix time of the position sample>}
```
or `null`. Only trust a Cast session while its app is the TV's foreground app. Subtitle: series
+ S/E for shows (`The Bear · S2 E3`), channel/artist for videos. Poll Cast status every 1 s while
an SSE client is connected and something plays (the existing 2 s TV poll otherwise); don't broadcast
on every position tick — the client extrapolates from `position` + `at` while `state` is playing.

**Actions** on `POST /api/tv/{id}`: `{"action":"seek","position":seconds}` (Cast seek; 400 if
not seekable), plus `{"action":"skip","by":±seconds}` (seek relative). Play/pause keep using the
remote keys. After a seek, refresh and broadcast immediately.

**UI** (in the TV sheet, directly under the head, replacing the "Now on" strip when something is
playing; keep the "Now on" strip when an app is open but nothing reports playing):
- Artwork (rounded, 16:9 for video / poster ratio when it's tall) with the app logo badge, title
  (2 lines max), subtitle, and a play/pause button.
- A scrubber: elapsed and remaining time, a track that animates smoothly (requestAnimationFrame,
  extrapolated while playing), a thumb that grows on hover/press. Dragging shows the target time
  in a small bubble above the thumb, tick haptics every 10 % (phone), and seeks on release
  (optimistic, then reconciled with the TV). −10 s / +30 s buttons beside play/pause.
  Not seekable → plain progress bar without thumb; no duration → elapsed only.
- The TV tile in the device list shows the title as its subtitle when playing
  ("YouTube · Bretz in the Scablands").
- Simulated TV (browser / `?tv=demo`): plays a fake episode with a moving position and working seek.

## Done when

- Hub tests cover now playing (fake Cast source), seek/skip, the ADB parser, tileOrder round-trip.
- Screenshots (phone 390×844 `?platform=ios`, Mac panel size, desktop): a tile mid-drag (lifted,
  others shifted), the list after a drop, now playing with scrubber, mid-scrub with the time
  bubble. A short screen recording (Playwright video) of a drag on the phone layout.
- On the Mac: dragging the TV tile above the AC tile persists across reloads and other screens;
  the remote shows what's on the real TV and seeking moves it.

## Status

Built (October 2026), everything above except the "Done when" checks that need the real TV and Mac:

- **Reordering**: `web/src/ui/reorder.js` (the long press, lift, FLIP, autoscroll, settle and
  keyboard moves) used by the tiles in `ui/panel.js`. A light on the phone still opens its sheet
  when it is held and let go without moving (the hold that used to open it now lifts it first).
  Autoscroll starts once a tile is carried toward an edge, not when one is picked up beside it.
- **Where the order is kept**: the plan's `tileOrder`, saved with `savePlan` 0.7 s after the last
  move (nothing when a tile is put back where it was). The hub stores it like any plan; a plan the
  hub makes stays the hub's when only its order changes, and keeps the order as it is made again
  (`plan.ordered`). The Mac and iPhone apps store it as the user's plan without loading the panel
  again (the Mac app passes it to an open editor and to paired phones); a demo home shown while the
  user has a home of their own, and a plain browser, keep the order in that browser instead. The
  editor, the AI's plan edits and `PlanEditor.remove` (Swift) keep it and drop removed lamps and ACs.
- **Haptics**: iPhone app through `haptic`; the Mac app's new `haptic` message plays
  `NSHapticFeedbackManager` `.levelChange` on lift and `.alignment` on each slot, during a drag
  only; a phone's browser vibrates, or flips a hidden switch on Safari 18.
- **Now playing**: `hub/nowplaying.py` (Cast through pychromecast, read-only, plus the optional
  `adb` media-session reader) used by `hub/tv.py`; `seek` and `skip` on `POST /api/tv/{id}`. The
  card is `web/src/tv/nowplaying.js`; the simulated TV plays an episode of Stranger Things on
  Netflix and a paused YouTube video. Tests: `hub/tests/test_nowplaying.py` (fake Cast source).
  `HOUSE_TV_CAST=off` and `HOUSE_TV_ADB=off` turn the two sources off.
- **Checked here**: hub tests; `web/tests/editor-model.mjs` and `editor.mjs`; browser checks of
  every gesture at phone, Mac panel and desktop sizes; and `hub/house.py` run against a pretend
  tv-remote and Cast source (order saved and kept over a restart, now playing over `/api/tv` and
  the events, seek, skip, play/pause).
- **Not yet checked**: the Swift changes (no toolchain here; the first build on the Mac is their
  check), Cast against the real TV (the seek uses pychromecast's `media_controller._send_command`
  so a paused title stays paused), and the trackpad and Safari switch haptics on real hardware.
