# Tiles you slide, tap and hold; scenes you make

Riley's request (October 2026):

> Right now, sliding left and right on the tiles doesn't adjust the brightness slider/temp on the
> lights or AC. I'd like to be able to adjust these things without opening all the way into the
> menu for each device. Then, I'd like tapping these tiles to toggle them on/off. Only press and
> hold/long pressing an item should take me all the way into that items control page. Then, for
> presets/scenes, I'd like to be able to add new ones/make my own and add them. Bright, cozy, and
> night aren't cutting it for me lol

The web panel everywhere it runs (the iPhone app's web view, a phone's browser on the hub, the Mac
panel, desktop). The native iPhone app (`ios-native/`) uses the same scene shape.

## Tiles

| On a tile | Lamp | AC | TV |
| --- | --- | --- | --- |
| Tap | on / off | power | power (the TV's wake / sleep) |
| Slide sideways | brightness: the whole tile's width is off → 100 %; under 5 % is off; from off it turns on | target temperature: 1° per 24 px; turns it on | nothing |
| Hold, let go | its page (brightness, white, colour) | its page | the remote |
| Hold, drag | moves the tile (`ui/reorder.js`) | moves | moves |

- **Which it is** is decided after 8 px: more sideways than up or down is a slide; up or down is the
  list's scroll or the card's drag (`ui/deck.js`), and is neither a tap nor a slide. A tile held
  still for 450 ms lifts (`haptic('medium')`); let go without moving, the device's page opens; dragged,
  it moves within its room. A slide never toggles; a drop never toggles or opens; a press on a button
  in a tile (the AC's − / + and power, the TV's power, the lamp's settings button on a Mac) is that
  button's.
- **While sliding** the level fills the tile from the left in the device's colour and the value
  stands at its right in big type (`45%`, `Off`, `74°`); a `haptic('tick')` every 5 % or every degree.
  The store gets at most one change a frame, and `store.js` sends a device one command at a time,
  merging what changes meanwhile (lamps every 300 ms, ACs every 900 ms): a slide is two or three
  commands, not one per move.
- **Mouse**: the same (click, drag sideways, hold the button); a right click opens the page too.
  **Keyboard**: Space switches, Enter opens the page, ← / → step the level (10 % or 1°), Alt + arrows
  move the tile.
- `touch-action: pan-y` on lamp and AC tiles; while sliding, `touchmove` is cancelled. Reduced
  motion: no press scale, the readout fades without the pop.

## Scenes

- A **+** chip ends the scenes row (the row scrolls sideways once there are more than fit). It opens
  a sheet: a name, an icon from `sun, bright, dim, sofa, film, tv, moon, bed, sparkles, leaf,
  kitchen, dining, bath, office, heat, cool, power`, and **Include AC**. Save takes every lamp as it
  is now (and the AC, when included); the new scene is then the active one.
- **Hold a scene chip** (or right click, or Shift+F10): Edit (rename, icon, Include AC, **Update to
  current lights**) or Delete. The built-in scenes can be edited and deleted too.
- **Shape** (agreed with the native app, kept exactly):

  ```json
  { "id": "custom-movie-night-3fa1", "name": "Movie night", "icon": "film",
    "lights": { "studio.window": { "on": true, "brightness": 0.6, "temp": 2700 },
                "kitchen.counter": { "on": true, "brightness": 0.35, "color": "#ff5fc4" },
                "studio.door": { "on": false } },
    "acs": { "studio.ac": { "on": true, "mode": "cool", "target": 72, "fan": "auto" } } }
  ```

  A lamp in colour keeps its `color` (no `temp`); a white one its `temp` when it has one; a lamp
  without brightness just `on`. `acs` is left out when the scene doesn't set the AC. Built-in scenes
  may still use `"*"` for every lamp.
- **Kept** in the plan's `scenes`, saved like the tiles' order (`main.js` `saveScenes`: the hub's
  `savePlan`, or the Mac / iPhone app's). The panel keeps the plan it shows: nothing is rebuilt when
  the save comes back, and another screen takes new scenes in place (`panel.setScenes`). On a plan the
  hub makes, scenes (like `tileOrder`) leave it the hub's and are carried into each plan it makes
  again (`hub/plan.py` `PANEL_KEYS`, `ordered`). A plain browser (the demo) keeps them in
  `localStorage` (`house.scenes.<plan>.<name>`).

## Status

Built (October 2026) in `web/src/ui/panel.js` (`gestures`, `lampSlide`, `acSlide`, the scenes'
chips, menu and `sceneSheet`), `ui/reorder.js` (unchanged: a 450 ms hold for tiles), `store.js`
(`markScene`), `config.js` (`normalizeScenes`), `main.js`, `style.css`, and `hub/plan.py` /
`hub/house.py` (`scenes` like `tileOrder`).

Checked: `web/tests/tiles-scenes.mjs` in Playwright (WebKit) at 390 × 844
`?platform=ios&safeTop=59&safeBottom=34`, with the page told it is on a hub and its calls answered by
the test (nothing reaches a device or a plan): a touch slide on a lamp from off to 60 % (the level and
the % shown while sliding, two or three commands for 42 moves, no toggle, no page), taps on and off,
a vertical drag and a cancelled slide that toggle nothing, hold → the lamp's page, the AC three
degrees warmer by sliding, its tap power and hold page, hold and drag → a new order saved with nothing
toggled or opened, the mouse (click, slide, held click; right click at the Mac panel's size), a new
scene with an icon and the AC saved in the agreed shape without a new card, hold → Edit (rename,
update to current lights, AC off: no `acs`) and Delete (a custom and a built-in one), scenes from
another screen taken in place, the dark look with reduced motion. Hub tests:
`test_custom_scenes_round_trip`, `test_custom_scenes_leave_a_made_plan_the_hubs`.

Not checked: real touch on an iPhone (the test sends the pointer events a phone does), the haptics.
