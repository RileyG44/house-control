# Living Room: the TV launcher

A calm Home for the Chromecast with Google TV 4K, and the API that House Control's remote drives
the TV through. No root, no Mac at runtime, no app store. Copied from
`RileyG44/custom-tv-interface` (`tv/`, commit efe09a6), where the research and design work
stays. The plan for it in this repo is [`docs/tv-launcher.md`](../docs/tv-launcher.md).

- **Home screen:** the top half describes the focused item. Below it are a **Continue** row (what
  this TV actually played, recorded from each app's Now Playing info), your **Apps** in your order
  with their real banners, and **All apps** (hold OK to pin or unpin). The top-right row holds
  Search, pairing and Settings.
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
```

The release build is minified (R8) and signed with the debug key: Compose runs several times
faster than in a debug build on this hardware. `assembleDebug` works too, for a quick check.

## Install, pair, remove

The TV must be paired with the Mac for wireless ADB first (Settings → System → Developer options →
Wireless debugging), and `adb devices` must list it.

```sh
tv-launcher/tools/tv-install.sh               # build, install, grant Now Playing + remote input over ADB
tv-launcher/tools/tv-install.sh --no-build    # install the APK that is already built
tv-launcher/tools/tv-uninstall.sh             # remove it and put the TV's settings back
tv-launcher/tools/tv-wallpaper.sh photo.jpg   # Home wallpaper (JPEG, PNG or HEIC); --clear removes it
```

`tv-install.sh` grants two things over ADB: notification-listener access (Now Playing, play,
pause and seek) and the accessibility service (arrows, OK, Back, typing, sleep, and opening apps
while the launcher is in the background). The first time, it saves the TV's accessibility
settings in `tools/.tv-state/` (never committed), so the uninstall can put them back exactly.

Pair the hub once: `python hub/house.py --pair-tv <tv address>`. The TV shows a 4-digit code
in its top corner; type it in, and the hub saves the launcher's address and token in
`~/.house-hub/tv.json`. Each hub (the Dell and the Mac) pairs on its own.

This runs as a normal app. The physical remote's Home button still opens Google TV; making it
open Living Room is phase 4 of the plan and needs its own go-ahead.

## Recovery

Nothing here replaces Home or disables any Google package, so the stock launcher is always one
press of Home away. If something goes wrong:

- **The launcher misbehaves or its API stops answering.** The hub falls back to tv-remote on the
  Mac by itself. Restart the app with `adb shell am force-stop com.livingroom.tv` and open it from
  the app row, or remove it with `tools/tv-uninstall.sh`.
- **Arrows, typing or Now Playing stopped working** (`caps.keys` or `caps.media` is false in
  `/api/state`; a Google TV update can reset these). Run `tools/tv-install.sh --no-build` to grant
  them again.
- **Remove everything:** `tools/tv-uninstall.sh` takes the listener access away, restores the
  saved accessibility settings and uninstalls the app.
- **No ADB:** uninstall Living Room from Settings → Apps on the TV. A factory reset is the last
  resort, and it erases the TV.

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
