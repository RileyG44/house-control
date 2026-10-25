# Living Room: the TV launcher

A calm Home for the Chromecast with Google TV 4K, and the API that House Control's remote drives
the TV through. No root, no Mac at runtime, no app store. Copied from
`RileyG44/custom-tv-interface` (`tv/`, commit efe09a6), where the research and design work
stays. The plan for it in this repo is [`docs/tv-launcher.md`](../docs/tv-launcher.md).

- **Home screen** (after Ron Design Lab's look: frosted glass over an out-of-focus teal and olive
  field, Urbanist in light weights, thin numerals): the greeting, a large clock and the date; a
  weather card with the day's temperature curve; and a tile of the 3D studio with each light
  glowing as it really is and the AC's setting. Below them, **Fresh today**: what this TV is in
  the middle of (its three most recent, from apps' Now Playing info), then the day's picks from
  the hub. Under that, peeking up from the bottom edge, your **Apps** with their real banners,
  then All apps, Search, pairing and Settings; further down, each app's Popular, Trending and New
  rows. Nothing explains why a title is there.
- **Home presets:** the saved house modes sit below the greeting/weather/studio band. OK runs
  the same light, heat-pump and optional TV-app actions as the iPhone or desktop. Create and edit
  them on either app; the hub synchronizes their order and TV actions. Home initially focuses a
  poster, so opening the launcher never triggers a routine.
- **Weather:** the tile includes sunrise, sunset and today's maximum wind speed. OK opens the
  full forecast, with conditions, high/low, rain chance, wind/gusts and the hourly forecast.
  Select any of the ten days to see that day's details and hours; Back returns focus to the tile.
  Times use the forecast location's timezone, including daylight-saving changes. Missing solar
  or hourly values stay blank rather than becoming zero. Forecast data comes from
  [Open-Meteo](https://open-meteo.com/en/docs); Refresh keeps the last good forecast on failure.
  The last forecast survives app/Chromecast restarts. Failed boot requests retry after 10 seconds,
  backing off to at most one minute; a validated network reconnect also requests a refresh.
- **Chromecast Settings:** the labelled button below the clock opens Android's Settings directly;
  Settings is also available on the phone and web remote's white control card.
- **Scrolling rows:** recommendations, Keep watching, Apps and presets share the clock/studio
  alignment. Items remain opaque in the central area and fade through the 48 dp screen gutters.
- **The studio:** OK on the studio tile opens it full screen: the 3D studio with every light and
  the AC marked, the plan's scenes, the AC (OK on or off, ◀ ▶ temperature, mode and fan) and each
  light (OK on or off, ◀ ▶ brightness). It goes through House Control's hub (`/api/plan`,
  `/api/events` while Home is on screen, `/api/call`), exactly as the web panel does. The picture
  is `res/drawable-nodpi/studio_render.webp`, made from the hub's own 3D view by
  `tools/studio-render.py`; run it again when the studio's furniture changes.
- **API on port 8686** (advertised over Bonjour as `_livingroom._tcp`): the hub
  (`hub/launcher.py`) and, later, the iPhone app talk to it. Playback always happens on the TV, in
  each provider's own app.

The old web remote the TV used to serve is gone; House Control's panel and iPhone app replace it.

## Build

On the Mac: JDK 17 (`/opt/homebrew/opt/openjdk@17`) and the Android SDK
(`~/Library/Android/sdk`, platform 36 and its build tools). The Gradle wrapper is pinned to
8.14.6, with AGP 8.13.2 and Kotlin 2.2.21.

```sh
cd tv-launcher
export JAVA_HOME=/opt/homebrew/opt/openjdk@17 ANDROID_HOME=~/Library/Android/sdk
./gradlew :app:assembleRelease      # app/build/outputs/apk/release/app-release.apk
./gradlew :app:testDebugUnitTest    # forecast parsing/DST and plan-recovery checks; no device needed
python3 -m unittest discover -s tools/tests -v  # Home takeover, rollback and target-device guards (fake ADB)
```

The release build is minified (R8) and signed with the debug key: Compose runs several times
faster than in a debug build on this hardware. `assembleDebug` works too, for a quick check.

## Install, pair, remove

The TV must be paired with the Mac for wireless ADB first (Settings → System → Developer options →
Wireless debugging), and `adb devices` must list it.

```sh
export ANDROID_SERIAL=<the-TV-serial-or-address-from-adb-devices>
tv-launcher/tools/tv-install.sh               # build, install, grant remote access and select Living Room as Home
tv-launcher/tools/tv-install.sh --no-build    # install the APK that is already built
tv-launcher/tools/tv-install.sh --keep-stock-home  # optional regular-app test install
python3 tv-launcher/tools/tv-home.py status   # inspect the current Home and Google package states
python3 tv-launcher/tools/tv-home.py restore  # restore the recorded stock Home without removing Living Room
tv-launcher/tools/tv-uninstall.sh             # restore stock Home first, then remove Living Room
tv-launcher/tools/tv-wallpaper.sh photo.jpg   # stores a wallpaper (JPEG, PNG or HEIC); the redesigned Home shows its own field instead
```

`tv-install.sh` grants two things over ADB: notification-listener access (Now Playing, play,
pause and seek) and the accessibility service (arrows, OK, Back, typing, sleep, and opening apps
while the launcher is in the background). The first time, it saves the TV's accessibility
settings in `tools/.tv-state/` (never committed), so the uninstall can put them back exactly.

Pair the hub once: `python hub/house.py --pair-tv <tv address>`. The TV shows a 4-digit code
in its top corner; type it in, and the hub saves the launcher's address and token in
`~/.house-hub/tv.json`. Each hub (the Dell and the Mac) pairs on its own.

Living Room is a real Android Home handler (`MAIN` + `HOME` + `DEFAULT`) as well as a TV app.
The installer selects it as Home, then disables Google TV Home (`launcherx`) and its competing
SetupWraith fallback for user 0. Both packages stay installed. The physical Home button and
startup now use Living Room; pressing Home also closes overlays and returns to the top row.
Back at Home keeps the launcher open. Once takeover is configured, later installs verify it
without switching away from the app currently on screen. `--keep-stock-home` skips takeover.

Home takeover is specific to the tested Chromecast 4K (`sabrina`) after Android setup completes.
The script records the hardware serial, resolved stock Home and exact Google enabled states in
`tools/.tv-state/home.json` before any changes, and restores them if takeover fails. Always set
`ANDROID_SERIAL`; the tools refuse to choose an arbitrary attached Android device.

## Recovery

If something goes wrong, keep the authorized ADB connection available. Restore stock Home with
`ANDROID_SERIAL=<TV> python3 tools/tv-home.py restore`. This re-enables the stock packages first,
selects the recorded Home component, restores their original enabled states and presses Home.
The recovery file is bound to the TV's hardware serial and cannot be applied to another device.
If the Mac no longer sees wireless ADB, read the current IP/port from the TV's Wireless debugging
page, reconnect with `adb connect <address>:<port>`, and set `ANDROID_SERIAL` to that address.

### Keep wireless debugging available after a Wi-Fi reconnect

Android can turn Wireless debugging off when Wi-Fi disconnects or the access point changes.
For this dedicated home Chromecast, install with `--keep-adb` to opt into recovery:

```sh
ANDROID_SERIAL=<TV-address:port> tv-launcher/tools/tv-install.sh --no-build --keep-adb
python3 tv-launcher/tools/tv-debugging.py status
python3 tv-launcher/tools/tv-debugging.py disable   # stop automatic recovery; no ADB needed
```

The option grants `WRITE_SECURE_SETTINGS` once and records the connected Wi-Fi's IPv4 subnet
and gateway. The launcher restores `adb_wifi_enabled` three seconds after a validated reconnect
on that saved network, including startup. It makes one attempt per network connection, respects
the Developer options master switch, and leaves Android's trusted-network and paired-computer
authorization checks intact. It does not open legacy port 5555 or disable authorization expiry.
Turning debugging off manually stays effective until the next reconnect; disable recovery above
to keep it off across reconnects. If the router/subnet changes, explicitly enable recovery again
on the new home network. A normal install does not grant this optional permission or enable recovery.
The first grant and recovery on this Chromecast must be verified over ADB before relying on it.

Recovery steps:

- **The launcher misbehaves or its API stops answering.** The hub falls back to tv-remote on the
  Mac by itself. Restart the app with `adb shell am force-stop com.livingroom.tv` and open it from
  the app row, or remove it with `tools/tv-uninstall.sh`.
- **A plan read fails:** the studio and preset row retry on event-stream heartbeats as well as
  reconnects. Failed reads remain pending, with at least five seconds between attempts. A failed
  reload keeps the previous usable plan until its replacement can be read.
- **Arrows, typing or Now Playing stopped working** (`caps.keys` or `caps.media` is false in
  `/api/state`; a Google TV update can reset these). Run `tools/tv-install.sh --no-build` to grant
  them again.
- **Remove everything:** `tools/tv-uninstall.sh` restores stock Home first, then takes listener access away,
  restores saved accessibility settings and uninstalls the app. A failed Home restore stops removal.
- **No ADB:** reconnect authorized wireless debugging first. Keep Living Room installed while it is the only
  enabled Home. Do not factory-reset the TV to solve a default-launcher selection problem.

## The API

Every `/api` call carries the token as `X-LR-Key` (or `?k=`); without it the answer is `401
{"error": "pair"}`.

| Call | What it does |
|---|---|
| `GET /api/state?since=rev` | Long poll (up to 25 s): returns as soon as anything changes after `rev`. Awake, home or app on screen, foreground app, volume, now playing, installed apps, Continue, text-field focus, Tailscale address. |
| `POST /api/cmd` | One command, `{"type": …}`, below. Answers `{"ok": true}` or `{"ok": false}`. |
| `GET /icon/{pkg}`, `/banner/{pkg}`, `/art/now`, `/art/h/{id}` | Pictures: an app's icon and banner, what is playing, a Continue entry. |
| `GET /pair/hello` | Who this TV is, and whether the caller's token is good. |
| `POST /pair/start`, `/pair/finish {code}`, `/pair/cancel` | Show a 4-digit code on the TV, trade it for the token, hide it. |

`tv.volume`, `tv.volumeMax` and `tv.muted` are Android's music stream. With HDMI-CEC volume
control the Chromecast's own volume may be fixed (`tv.volumeFixed`): then the steps and mute go to
the TV over CEC, but there is no level to read or set.

`{"type":"settings"}` opens Chromecast Settings. `{"type":"search","pkg":"com.google.android.youtube.tv","text":"…"}`
opens the chosen installed app's search using its Android search intent (YouTube also supports
its search URL). Queries are limited to 200 characters. Apps without a compatible search entry
return `ok:false`; the remote explains how to use the app's search field and Type into the TV.
App searches never fall through to Google TV's global search.

Commands:

| `type` | Fields | |
|---|---|---|
| `key` | `key`: `up down left right ok center back home` | Through the accessibility service; `home` opens Living Room. |
| `primary` | | The big play button: play/pause the session, or OK when there is none. |
| `media` | `action`: `toggle play pause next seekBy seekTo`, `ms` | `seekBy` moves by `ms` (default 10 s); `seekTo` jumps to `ms`. |
| `seek` | `positionMs` | Jumps to that position in what is playing. `false` when the app doesn't take a position. |
| `volume` | `delta` or `level` | Relative steps, or an absolute level from 0 to `tv.volumeMax`. A level is refused (`false`) when `tv.volumeFixed` is true. |
| `mute` | | Mutes, or unmutes when muted. |
| `power` | | Sleeps when awake; wakes when asleep. |
| `wake`, `sleep` | | The same, but each only one way: a TV that is already awake stays awake. |
| `launch` | `pkg` | Opens an app. |
| `open` | `url`, `pkg` | Opens an https link (a title) in that app and no other. `false` when the app has nothing that opens it. |
| `resume` | `id` | Opens a Continue entry's app. |
| `text`, `submit` | `text` | Types into the focused field; presses its Search / Go key. |

**Profiles.** For 20 s after an app opens (from Living Room, the hub, the phone or the physical
remote), the accessibility service reads its window. If it shows a profile picker ("Who's
watching?", "Choose profile", or the name as one of a short row of tiles), it selects the
profile named by `POST /api/settings {"profile": "…"}` (default "Riley"), once. YouTube and
Netflix draw theirs without accessible text: after Living Room itself opens one of them from cold
(not in front in the last 30 minutes), it presses OK once on the profile the app has focused,
unless the screen has readable text or something is playing. `{"profileOk": false}` turns that off.

## How it works

| Piece | File |
|---|---|
| Home UI (Compose for TV) | `app/src/main/java/com/livingroom/tv/ui/` |
| Installed apps, banners, pinned order, launching | `apps/AppsRepository.kt` |
| Now Playing + history (notification-listener access) | `media/MediaWatcher.kt`, `history/HistoryStore.kt` |
| Arrows, OK, Back, typing, launching from the background (accessibility service) | `input/RemoteInputService.kt` |
| Choosing Riley's profile on an app's "Who's watching?" screen | `input/ProfilePicker.kt` |
| Server on port 8686, pairing, long-poll state, commands | `companion/` |

## Verified on the device (Oct 20, 2026)

- The release build launches in about 0.9 s and uses about 20 MB of memory.
- Home shows real app banners and a Continue card recorded from YouTube's media session (title,
  channel, artwork, time left).
- The API's state shows the live TV: a paused YouTube video, artwork, position, the app row.
- Arrow keys from the phone move focus on the TV, and rows stop at their ends.

## Not yet verified

- Play/pause/seek, volume (HDMI-CEC forwarding, and whether Android knows the TV's real level),
  mute, power/wake/sleep, typing and opening links. These are phase 1's checks on the real TV,
  with Riley watching.
- Which other apps (Netflix, Apple TV, Max, Hulu, Disney+) publish good Now Playing metadata.
