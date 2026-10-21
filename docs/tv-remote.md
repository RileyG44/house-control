# TV: live status in the model, and a remote

> **October 21, 2026:** the hub now reaches the TV through its own launcher first
> (`tv-launcher/`, `hub/launcher.py`, [tv-launcher.md](tv-launcher.md)), with tv-remote as the
> fallback described here. `GET /api/tv`, `POST /api/tv/{id}` and the `{"tv": …}` event keep the
> shape below. See "Through the launcher" at the end.

Riley's request (2026-10-20): the TV by the fridge shows its current status in the 3D model
(off, or on with the active app's logo on the screen). Selecting the TV opens a TV launcher
page that works as a simple remote: volume, a Chromecast-style navigation pad, app icons
(Netflix, Hulu, YouTube, …), and title search across the apps. Reuse the existing TV back end;
the UI must be new and feel native to House Control.

## What exists

`~/tv-remote` on Riley's Mac (a separate project, **not** in this repo, do not change it) is a
Python aiohttp service (LaunchAgent `local.tvremote`) on `*:8765`. It keeps an Android TV Remote
protocol connection (androidtvremote2) to the Google TV / Chromecast "Living Room TV"
(`id 79519fff`, `192.168.0.225`). Note: `127.0.0.1:8765` is taken by an unrelated node app on the
Mac, so reach tv-remote at the Mac's LAN address (`http://192.168.0.188:8765`), not localhost.

API used here (no auth; requests without an `Origin` header are accepted):

- `GET /api/devices` →
  `{"devices": [{"id","name","kind":"googletv","label","host","online","needsPair","error",
  "caps":[…],"apps":["YouTube","Netflix",…],"volume":5,"muted":false,"volumeMax":25,
  "isOn":true,"currentApp":"com.google.android.youtube.tv","inputs":[]}], "server":{"ip"}}`.
  `isOn`, `currentApp` (Android package) and volume are pushed live by the TV, so polling this
  is cheap and current. Volume is `null` while the TV is asleep.
- `POST /api/devices/{id}/action` with `{"action": …, …}` → `{"ok": true}` or
  `{"error": "…"}` (400 / 404 / 503). Google TV actions: `up down left right ok back home menu
  playpause play pause rewind forward volup voldown mute chup chdown input power wake sleep`,
  `{"action":"volume","level":N}` (steps one key at a time to N, can take seconds),
  `{"action":"text","text":"…"}` (types into the focused field),
  `{"action":"search","text":"…"}` (opens Google TV global search and submits the text),
  `{"action":"launch","url":"…"}` (`send_launch_app_command`: an https app link, or a package
  id such as `com.netflix.ninja`), `{"action":"app","name":"Netflix"}`.

`~/tv-remote/catalog.py` has the app → package table and a JustWatch GraphQL lookup
(`where_to_watch`) with Android TV deep links. Port the parts needed into the hub (below).

## Architecture

```
3D model / panel  ──►  hub (hub/tv.py, :8766)  ──►  tv-remote (:8765)  ──►  Google TV
       ▲  SSE {"tv": …} or GET /api/tv                │
       └──────────────────────────────────────────────┘    JustWatch (search)
```

The panel never talks to tv-remote directly (different origin, LAN-only, and the Mac app's
panel runs on a custom scheme). Everything goes through the hub.

### Hub: `hub/tv.py` + routes in `hub/house.py`

- **Where tv-remote is**: env `HOUSE_TV_URL`, else `~/.house-hub/tv.json` `{"url": "…"}`, else
  `http://<this Mac's LAN IP>:8765` (UDP-socket trick for the IP). If it can't be reached, TV
  features report `available: false` with a plain message; nothing else in the hub is affected.
- **Background poll**: every 2 s while at least one SSE client is connected (else every 10 s),
  `GET /api/devices`. When the normalized TV state changes, broadcast it on the existing
  `/api/events` stream as `{"tv": <state>}` (the same SSE the panel already listens to; the
  first event for a new client must include the current TV state too, or send it right after).
- **Normalized state** (`GET /api/tv` returns the same):
  ```json
  {"available": true, "error": "",
   "devices": [{"id": "79519fff", "name": "Living Room TV", "online": true, "on": true,
                "app": {"id": "netflix", "name": "Netflix", "package": "com.netflix.ninja"},
                "volume": 5, "volumeMax": 25, "muted": false, "caps": [...]}]}
  ```
  `app` is `null` when off/unknown. Map packages with the table from catalog.py plus
  system apps: launcher (`com.google.android.apps.tv.launcherx`, `…tvrecommendations`) →
  `{"id":"home","name":"Google TV"}`, `com.google.android.backdrop` → `{"id":"ambient","name":"Ambient"}`,
  `com.android.tv.settings` → `{"id":"settings","name":"Settings"}`; unknown packages →
  `{"id":"other","name":<package>}`.
- **`POST /api/tv/{id}`** body `{"action": …}`:
  - Remote keys: whitelist exactly the key actions listed above plus `volume` (int level,
    0..volumeMax), `text` (≤ 200 chars), `search` (≤ 200 chars). Forward to tv-remote.
  - `{"action":"open","app":"netflix"}` → `launch` with the app's package id. If the TV is off,
    send `wake` first and wait (poll up to ~6 s) for `isOn`.
  - `{"action":"play","app":"netflix","link":"…"}` (a search result) → validate the link
    against that app (port `validate_link` / `https_form` / `normalize_youtube`), wake if
    needed, then `launch` with the https form. Never launch an unvalidated URL.
  - Answer `{"ok": true}` (after a successful action, trigger an immediate re-poll so the model
    updates within ~1 s) or `{"error": "…"}` with the tv-remote message, HTTP 4xx/5xx.
- **`GET /api/tv/search?q=…`** → JustWatch GraphQL (port `QUERY`, add `posterUrl` to `content`),
  country US, first 8. Return
  `{"results": [{"title","year","type":"movie|show","poster": "https://images.justwatch.com/poster/…/s166/…webp" | null,
  "offers": [{"app":"netflix","name":"Netflix","how":"subscription|free|free with ads","link":"…"}],
  "rentOrBuy": ["Apple TV (rent)", …]}]}`. Offers only for apps in the table, included
  (subscription/free/ads) only, de-duplicated per app, link = Android TV intent deeplink if
  present else standard web URL (both validated). Cache identical queries for 5 min. Errors →
  `{"error": "The streaming catalog didn't answer."}` with 502.
- Tests in `hub/tests/` with a fake tv-remote (aiohttp test server): state normalization, SSE
  broadcast on change, action whitelist, open (incl. wake-first), link validation rejects
  foreign hosts, search parsing from a canned JustWatch response (no network in tests).

### Mac app bridge

The Mac app's panel can't fetch the hub (custom scheme). Add one bridge message:
`call('hubRequest', {method, path, body})` in the panel → Swift forwards to
`LocalHubClient` (new generic `request(method:path:body:)`), **only for paths starting with
`api/tv`**, replies with the decoded JSON (or `{"error": …}`). In native mode the web polls
`GET api/tv` through it every 2 s while the panel is visible (and on `shown`).
Rebuild the Mac app with `macos/build-swiftc.sh` (Swift changes are compiled on the Mac).

### Web: `web/src/tv/`

- `tv/client.js`: one source of TV state for the page. Hub mode: `fetch('./api/tv')` once,
  then `{"tv": …}` SSE updates (route them out of `bridge.js`'s `onmessage` before
  `applyRemote`). Native: poll via `call('hubRequest')`. Plain browser / demo plans: a local
  simulated TV (`?tv=demo` or when no hub) so the UI can be developed and screenshot-tested;
  simulated actions change the simulated state. Exposes `subscribe(fn)`, `state`,
  `act(id, body)`, `search(q)`. Optimistic updates for volume and app launches, corrected by
  the next real state; failures toast via `panel.toast` and haptic('error').
- `tv/apps.js`: the app catalogue (id, name, package, brand colours) and logo drawing. Logos
  are drawn by us (SVG paths / canvas drawing in the brand colours: Netflix red N on black,
  YouTube red rounded play button, Hulu green wordmark on black, Prime Video blue, Disney+
  dark-blue, Max, Peacock, Paramount+, Apple TV, Tubi, Plex, Crunchyroll, plus Google TV home,
  Ambient and Settings glyphs). One function renders a logo to an SVG element (launcher tiles)
  and one draws it on a canvas (the 3D screen). No downloaded image files.

### 3D model

- **Which furniture is the TV**: a `tv` or `tvCabinet` item can carry `"device": "<tv-remote id>"`.
  With no explicit link, if the hub reports exactly one TV and the plan has exactly one
  `tv`/`tvCabinet`, they are linked automatically. Make sure `hub/plan.py`, the editor model and
  the native plan decoding keep the `device` field (round-trip). In the editor's furniture sheet
  for `tv` / `tvCabinet`, add a "Linked TV" row (None / Automatic / each TV from `GET api/tv`).
- **Screen**: the screen mesh of `tvCabinet` and `tv` gets a `CanvasTexture` (16:9, ~512×288)
  and is registered with the world as a pickable `{kind: 'tv', id: <device id>}` target (the
  whole TV + cabinet is the hit area; hover tooltip "Living Room TV · Netflix" / "· Off").
  - Off / asleep / unreachable: near-black glossy screen, no emission (today's blue glow goes).
  - On: the app's brand background with its logo centred, emissive so it reads as lit; a faint
    coloured light spill (a small, cheap `PointLight` or an emissive glow plane in front of the
    screen, tinted with the brand colour, low intensity) so the TV visibly glows in the room.
  - On, home screen / ambient / unknown: Google TV home glyph / soft gradient.
  - Changes cross-fade over ~300 ms; turning on is a quick CRT-free "fade up from black".
  - Unlinked TV furniture (no hub TV) keeps a dark screen.
- **Picking** the TV in the model → `panel.openSheet({kind: 'tv', id})` and the camera focuses
  the TV's room, like an AC. Also a TV tile in the device list next to the AC tile
  (icon `tv`, "Living Room TV", subtitle "Netflix" / "Off", power toggle on the tile).
  `incoming.openDevice(id)` and `?device=<id>` open it too.

### The TV sheet (the launcher / remote)

Built with the panel's existing sheet machinery and visual language (`sheetHead`, matte tiles,
the AC sheet's controls, the same fonts, radii, glass and dark/light handling). It must work at
the Mac menu-bar/widget size, phone (390×844, safe areas, one-thumb), desktop browser and the
Windows widget. Top to bottom:

1. **Head**: TV name, status line (`Netflix` / `Google TV home` / `Off` / `Not reachable`),
   power button (wake / sleep; disabled with a hint if tv-remote is unavailable).
2. **Now on**: when on, a compact strip with the current app's logo tile.
3. **Apps**: a horizontally scrolling (wrapping into a grid when the sheet is wide) row of
   rounded app tiles: YouTube, Netflix, Hulu, Prime Video, Disney+, Max first, then the rest
   of the catalogue. The running app has a ring and a "Now on" dot. Tap → `open` (wakes the TV
   if needed), haptic('light'), optimistic "Opening Netflix…".
4. **Pad** (since replaced by the swipe pad, docs/card-sheet.md): a Chromecast-remote style circular D-pad: one big disc with four arrow zones at
   the rim (press feedback on the touched quadrant) and a round OK button in the middle.
   Swiping on the disc also moves (touchpad: a swipe of ~40 px = one step, fast flicks repeat
   a few steps); press-and-hold on an arrow repeats (300 ms delay, then every 120 ms).
   Arrow keys / Enter / Backspace / Escape / Space on a keyboard drive it when the sheet is
   focused (desktop + Mac). Below or beside the pad: Back, Home, Play/Pause, and
   Mute as round buttons (icons from `ui/icons.js` / lucide).
5. **Volume**: a pill with − and + (hold repeats) and the level as a track
   (`5 / 25`); dragging the track sets an absolute level on release (`volume` action). Muted
   shows a struck speaker. Hidden while the TV is off.
6. **Search**: a search field ("Search movies and shows"). Debounced 350 ms →
   `GET api/tv/search`. Results as rows: poster thumb, title, year · Movie/Show, and the app
   logos it streams on (subscription/free). Tap an app logo on a row → `play` that title in that
   app; if only one app, tapping the row does it. Rent/buy-only results say "Rent or buy on …"
   and are not launchable. Under the results: "Search on the TV for “…”" (Google TV global
   search) and "Type into the TV" (sends the text to the focused field on the TV, for an app's
   own search box). Empty / error states in plain words.

The sheet updates live from the TV state (app ring, status, volume) while open. In layouts
that are too short (Mac widget-size panel), the sheet scrolls; the pad stays at least 168 px.

## Out of scope for now

Native Swift widgets / Dynamic Island TV status, the AI-access agent's TV tools, changes to
`~/tv-remote` itself, other TV brands' quirks (the hub proxies whatever tv-remote supports).

## Done when

- Hub tests pass (`hub/tests`), web builds, and screenshots at widget, phone (390×844) and
  desktop sizes show: the TV in the model lit with the current app logo; the sheet with apps,
  pad, volume and search results (simulated TV + canned search in the browser preview).
- On the Mac: the model shows the real TV's state within ~2 s of a change on the TV; opening
  an app, the pad, volume and a search → play work against the real TV.

## Status

Built (October 2026), everything above except the "Done when" checks that need the real TV:

- **Hub**: `hub/tv.py` with `GET /api/tv`, `GET /api/tv/search`, `POST /api/tv/{id}` and the
  `{"tv": …}` event on `/api/events`; tests in `hub/tests/test_tv.py` against a pretend
  tv-remote and a canned JustWatch answer (`hub/tests/justwatch_search.json`). tv-remote's URL:
  `HOUSE_TV_URL`, else `~/.house-hub/tv.json` (`{"url": "http://192.168.0.188:8765"}`), else
  port 8765 on the Mac's LAN address.
- **Mac app**: `hubRequest` (only `api/tv…` paths) through `LocalHubClient.request`; not compiled
  here (no Swift toolchain), so the first build on the Mac is its check. The iPhone app asks the
  hub beside its paired Mac (docs/card-sheet.md); the panel stops asking a shell that never answers.
- **Web**: `web/src/tv/` (client, logos, simulated TV, remote controls), the lit screen and its
  pick target in `web/src/three/tv.js`, the TV tile and sheet in `ui/panel.js`, and **Linked TV**
  (Automatic / None / each TV) on a TV piece's page in the editor. An AI's plan edits keep a TV
  piece's `device`. A plain browser (or `?tv=demo`) gets the simulated TV and a canned search.
- **Not yet checked against the real TV**: the ~2 s update, app launches and deep links, and
  live JustWatch answers (unreachable from where this was built; the query is the one
  tv-remote uses, with `posterUrl` added).

## Through the launcher (October 21, 2026)

- **Which way**: `~/.house-hub/tv.json` `"launcher": {"url", "token", "device", "name", "id"}`
  (written by `python hub/house.py --pair-tv [host]`, which keeps the file's other keys) makes
  the launcher the way in; `HOUSE_TV_BACKEND=tvremote` turns it off. `device` and `name` are
  tv-remote's for the same TV when it answered at pairing (`79519fff`, "Living Room TV"), so a
  plan's linked TV stays linked whichever way the hub reaches it.
- **State**: the hub long-polls `/api/state?since=rev` and maps it with `tv.from_launcher` onto
  the shape above: `on` is `tv.awake`, `app` the foreground package (the launcher's own Home is
  `{"id": "home", "name": "Living Room"}`), the volume Android's music stream (tv-remote's level
  when the launcher says the volume is fixed by HDMI-CEC), and `nowPlaying` the media session
  (a paused one only while its app is on screen). Cast stays the source when the launcher sees
  no session, and then the hub reads every 2 s again while a panel is open.
- **Pictures**: `nowPlaying.artwork` is the hub's `/api/tv/art/now?v=…`, made a whole URL with
  the address each panel reached the hub by; `/api/tv/banner/{pkg}` serves app banners. The
  token never leaves the hub.
- **Actions**: `tv.LAUNCHER_KEYS` maps the keys; `volume {level}`, `text`, `search` (text +
  submit into the focused field), `open` (`launch`) and `play` (`open {url, pkg}` with the
  checked https form) map as in the plan; `seek`/`skip` send an absolute `seek {positionMs}`.
  When the launcher says no (nothing playing, no text field, a fixed volume), or for `menu`,
  `chup`, `chdown` and `input`, tv-remote does it; when that isn't there either, the answer is
  409 with the launcher's reason. When the launcher doesn't answer at all, the hub uses
  tv-remote and tries the launcher again every 15 s.
- **The phone's own way in**: with a launcher, the TV's device also carries
  `"direct": {"url": "http://<the TV's LAN address>:8686", "id": "<the launcher's id>"}` (the id
  is the one `/pair/hello` gives; a pairing saved before it was kept is asked once), whichever
  way the hub reaches the TV right now. Never the token: the iPhone app pairs with the launcher
  itself and keeps its token in the Keychain (see docs/tv-launcher.md, phase 3).
- Tests: `hub/tests/test_launcher.py` against `hub/tests/fake_launcher.py`.
