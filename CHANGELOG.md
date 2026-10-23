# Changelog

What changed in each release of House Control. The Mac app is on
[Releases](https://github.com/0xProbabillity/house-control/releases); the iPhone app is on TestFlight.

## Unreleased — 2026-10-22

- Match the iPhone and desktop controls to Living Room: Urbanist type, teal glass, circular
  icons, pill controls and softer card corners in light and dark appearances.
- Keep the iPhone's 3D sky and surroundings full width when expanding the main menu; fit the
  house above the card without shrinking the entire scene into a square.
- Animate the native iPhone AC’s airflow, following fan speed and swing and staying above the floor.
- Tapping AC or TV opens its controls; explicit power buttons switch them. Slide the TV tile
  sideways to change volume without opening its remote.
- Hold and drag presets to reorder them; edit or delete any preset, including the built-in ones.
  Presets can open a TV app alongside their lights and temperature settings, including on the TV launcher.
- Add a speaker to the furniture library and the studio’s door-side bedside table. Selecting
  it opens Spotify playback, seek and volume controls, with Spotify Connect playlist and output selection
  or a bridge to the signed-in Mac app. See [Spotify setup](docs/spotify.md).

## Unreleased

### Floor plans

- **Walls at any angle.** A room can be a polygon (`"poly"`: its corners) instead of a rectangle, and doors, windows
  and open gaps sit on angled walls too. In the editor, **Cut corner** turns a corner of a rectangular room into a
  short angled wall, and an angled room has a handle on every corner that snaps to walls, corners, the grid and 45°.
- **Doors and curtains:** a door's hinge side and the room it opens into (**Hinge**, **Opens into** in the editor),
  drawn as an arc on the plan and as a leaf ajar in 3D; an open gap can have a curtain.
- **New furniture:** counter (with a single or double sink), stove, microwave, TV cabinet, bean bag, water heater,
  chair, closet rod, storage bins and shower; a dresser can be taller. **Add** lists the furniture in groups:
  living, kitchen and dining, bedroom and storage, bathroom and utility.
- **Riley's Studio is the default home** on every surface — the web panel, the Mac and iPhone apps, the widgets'
  sample and a new hub, which links its lamps and AC by name to the devices it finds. The old demos stay in the
  plan picker as **Demo apartment** and **Demo studio**.
- The AI's floor plan tools take polygon rooms, door hinges and curtains, and the new furniture.

### Panel

- **One card for everything.** The home's name, how many lights are on, the look, edit and power buttons sit on
  the card with the scenes, rooms and tiles. Swipe the card up for more room: the model shrinks in step with your
  finger into the strip at the top (under the Dynamic Island on the iPhone), and a tap on it brings the card back
  down. The card follows the finger, carries a flick, settles with a spring and a tick, and works with a mouse,
  a trackpad or the scroll wheel too. The room chips count the lights on in each room.
- **Light and dark.** The sun / moon button on the card cycles Auto, Light and Dark: a warm-white panel and a
  daylit model, or the dark one, easing from one to the other. Auto follows the system. Each device keeps its own
  choice.
- **Tiles in your own order.** Touch and hold a tile (or press and hold with the mouse) and drag it: the TV above
  the AC, a lamp to the other side of the grid. The others slide out of the way, and it settles where you let go,
  with a tap you can feel on the iPhone and on a Mac's trackpad. Tiles move within their room; Option + arrow keys
  move the selected one. The order is part of the floor plan, so the Mac, the iPhone and the hub's site all show it.

### TV

- **A swipe pad** in place of the arrows and OK: swipe to move (a step for every stretch, a step or two more for a
  quick flick), tap to select, with a ring where you tap, a glow toward each step's edge and a tick you can feel.
  Back, Home, Play/Pause and Mute sit under it; arrow keys, Enter and Space work too.
- **Straight to the TV:** tapping the TV flies the view to just in front of its screen, the remote comes up
  ready to use, and a small picture of the TV stays above it. Swipe the remote down to see the TV big.
- **The TV on the iPhone:** the iPhone app reaches the TV through the hub on the Mac it's paired with.
- **Now playing** on the TV remote: what's on (the show and episode, or the video and its channel) with its
  picture, play and pause, back 10 s and ahead 30 s, and a slider to jump anywhere in it. The TV's tile says what's
  on too. It comes from the TV over Cast through the hub (`pip install -r hub/requirements.txt` adds pychromecast),
  or from adb for apps that don't tell Cast.
- **The TV in the model** shows what the real TV is showing: the app's logo on its screen, lit in the app's colours,
  and dark when the TV is off. It comes from tv-remote on the Mac through the hub, live within a couple of seconds.
- **A remote for the TV:** tap the TV (in the model or its tile) for a sheet with its apps, a touch pad, volume, and
  search across the streaming apps: pick a title and the TV opens it in the app that has it. In the editor, a TV
  piece's **Linked TV** chooses which TV it shows (or none).

### Mac

- **The panel's look** follows its light or dark choice, glass included.
- **Open at Login**, in the menu bar icon's right-click menu and in the panel's gear menu: House Control starts with
  your Mac. It is the app's entry under System Settings → General → Login Items, so it can be switched off there too.
  Run from the disk image, the app asks to be moved to Applications first; moved there later, the login item follows it.

## 1.0.0 — 2026-10-15

### Widgets, controls and quick actions

- **Widgets** for the iPhone's Home Screen, Lock Screen and StandBy, and for the Mac's desktop: Home in 3D,
  Scenes, Light, Room, Climate and Home Status.
- **Control Center controls** on the iPhone: All Lights, a Light, a Scene and an Air Conditioner.
- **Quick actions** on the iPhone's app icon, chosen in Settings.
- Every widget is live: tap a lamp, a scene or an AC and it switches without opening the app. On the Mac the app in
  the menu bar carries it out; on the iPhone the widget talks to Home Assistant, Hue and Smart Life itself.
  See [docs/widgets.md](https://github.com/0xProbabillity/house-control/blob/main/docs/widgets.md).

### An iPhone app that needs no Mac

- **Floor plan editor on the phone:** the Mac's editor laid out for a finger — tap to select, drag what is selected,
  pan, pinch to zoom, details in a sheet from the bottom. **New home** starts from one room or a demo layout.
- **Home Assistant and Philips Hue** screens on the phone; servers and bridges on the Wi-Fi are found by themselves.
- **Devices:** link each lamp and AC to a real device from one searchable list, or add several devices to a room
  already linked.
- **Smart Life on a single phone:** save the sign-in code to Photos and scan it from the Smart Life app.
- **Sync both ways.** A paired Mac is optional. Plans edited on either side reach the other, and so do Home Assistant
  and Hue connections (the newest wins, a disconnect included). If both changed the plan while apart, the phone
  asks which one to keep.

### Two iPhone editions

- **App Store edition:** Home Assistant, Philips Hue and Apple Home.
- **Smart Life edition:** all of that plus Smart Life / Tuya, for TestFlight and your own phone.
- Smart Life now lives in its own module (`HouseSmartLife`), linked only by the Mac app and the Smart Life
  edition. The two editions are separate apps and can sit on one phone.

### Also

- **About** links (website, privacy policy, support, source) on the iPhone and in the Mac's menu.
- The editor only offers the platforms the app has.
- A privacy manifest for the widgets.
- From this release on, every Mac disk image carries a build provenance attestation:
  `gh attestation verify HouseControl-1.0.0.dmg --repo 0xProbabillity/house-control`
  ([#5](https://github.com/0xProbabillity/house-control/issues/5)).

### Fixed

- The iPhone never found Hue Bridges or Home Assistant servers on the network: iOS only browses the Bonjour types an
  app declares, and those two were missing.
- Widgets could jump back to an older state when the app started with widget taps still queued.

## 0.1.0 — 2026-10-14

The first public release: the home as a live 3D model in the Mac menu bar and on the iPhone, the island under the
notch, the floor plan editor, AI Access, and Smart Life, Home Assistant, Philips Hue and Apple Home.

This image was built while the repository was still private, so it has no build provenance attestation — only its
SHA-256 can be checked.
