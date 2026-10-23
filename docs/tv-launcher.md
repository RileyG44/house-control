# TV launcher in House Control

Plan, October 21, 2026. **Status:** phases 1 and 2 are built (`tv-launcher/`, `hub/launcher.py`,
the launcher backend in `hub/tv.py`, `python hub/house.py --pair-tv`); not yet installed on the TV
or checked there, and not yet deployed to the hubs. Phase 3 is written (the hub's `direct` on the
TV; `LauncherClient`, `LauncherState` and the direct route in the iPhone app's `TVStore`, pairing
on the TV remote page), not yet built in Xcode or tried on the phone. Per-client tokens are not done.

**Goal.** Bring the Chromecast launcher ("Living Room", from `RileyG44/custom-tv-interface`, `tv/`) into this repo. Then let House Control's remote (web panel and the iPhone app "Riley's Place") drive the TV through the launcher instead of through `~/tv-remote` on the Mac. Smart home devices stay where they are: the Dell hub first, the Mac as backup. The iPhone remote from the other repo (`ios/LivingRoom`) is not brought over, because House Control's remote replaces it.

## What the launcher already is

- A Kotlin, Compose for TV Home screen for the Chromecast with Google TV 4K (Android 14, 32-bit ARM only, 2 GB RAM, about 750 MB free storage). Its Home (redesigned October 2026, see tv-launcher/README.md) has a greeting and clock, weather, a 3D studio tile that opens a full controller for the lights and AC, a Fresh today row (what is being watched, then the day's picks), Apps in Riley's order, All apps, and each app's catalog rows.
- An accessibility service for arrows, OK, Back, typing and sleep. Notification-listener access gives it Now Playing (title, art, position, seek) for any app that publishes a media session.
- Its own HTTP server on port 8686 (NanoHTTPD, advertised over Bonjour):
  - `GET /api/state?since=rev` is a long poll (up to 25 s). It returns the whole state: awake, home or app on screen, foreground app, now playing, installed apps, Continue, text-field focus and its Tailscale address.
  - `POST /api/cmd` takes `{type: key|primary|media|launch|resume|text|submit|volume|power}`.
  - `/icon/{pkg}`, `/banner/{pkg}`, `/art/now`, `/art/h/{id}` serve images.
  - `/pair/hello|start|finish|cancel` handle pairing: the TV shows a 4-digit code and the client trades it for the token.
- Installed and uninstalled from the Mac over wireless ADB (`tools/tv-install.sh`, `tv-uninstall.sh`). It was checked on the TV on Oct 20 (launch, banners, Continue, arrows). Media keys, volume, power and typing have not been tried yet.

## Layout in this repo

```
tv-launcher/            the Android app, copied from custom-tv-interface tv/ (Gradle project as is)
  app/src/main/...      minus assets/remote (the old web remote; House Control's panel replaces it)
  tools/                tv-install.sh, tv-uninstall.sh, tv-wallpaper.sh
  README.md             build + install + recovery
docs/tv-launcher.md     this file
hub/tv.py               gains a launcher backend next to the tv-remote one
hub/launcher.py         new: client for the launcher's :8686 API
```

**History.** The source repo has three commits, and the launcher arrived in one of them (2f329c7). A plain copy that names the source commit in its message loses nothing that matters, so I recommend that over a subtree merge. `custom-tv-interface` stays as it is, as the archive of the research and design work.

## Who talks to the TV

The hub and the phone both talk to the launcher.

| Path | Used for | Why |
|---|---|---|
| **Phone → launcher, on the home LAN** | Swipe pad, keys, typing, play/pause, ±10 s, volume, and the live state while the remote is open | Lowest lag (one hop, no hub). The remote keeps working when both hubs are down, or when the Dell's weak Wi-Fi drops it. |
| **Hub → launcher** | TV state for the 3D model, the TV tile and the Windows/Mac widgets, plus scenes ("Movie night" turns the TV on and dims lights), JustWatch search → play, and every screen that has no direct route (web panel, widgets) | One source of state for everything that isn't the phone. Scenes run on the server. |
| **Phone → hub → launcher, away from home** | Everything, when the LAN address doesn't answer | See below. |

**Away from home: through the hub.** The launcher reports a Tailscale address *if* Tailscale runs on the Chromecast. The Oct 20 package inventory (140 packages) has no Tailscale app, so today it doesn't. Installing it would work, since Tailscale ships an Android TV app. But that adds an always-on VPN to a 2 GB device with 750 MB free, and a second address the phone has to try. The phone already reaches the Dell hub over Tailscale, and the hub reaches the TV on the LAN. So away from home the phone sends TV commands to the hub, and the hub passes them on. A little extra lag doesn't matter much when you're not in the room. If Riley ever wants the phone to reach the TV directly from outside, installing Tailscale on the TV is all it takes; the launcher already reports the address.

**How the phone picks a route.** When the TV sheet opens, it tries the launcher's LAN address with a 600 ms timeout. If that answers, it uses the launcher until the sheet closes or a call fails. Otherwise it uses the hub's `/api/tv/{id}`. The TV store keeps one state model, filled from either the launcher's `/api/state` or the hub's `{"tv": …}` events.

## Pairing and the token

- The launcher has **one token** today (`prefs.token`). Anyone who pairs gets the same one, and it can't be revoked per device. It travels over plain HTTP, so it is LAN-grade security, the same level as the hub, which has no sign-in.
- **Hub:** paired once with the 4-digit code. A new command does it: `python hub/house.py --pair-tv` (or a "Pair TV" button in Settings on the panel). The hub stores `{url, token}` in `~/.house-hub/tv.json`, which never goes into git. Each hub (Dell and Mac) pairs on its own, and they don't copy the token to each other.
- **Phone:** it pairs with the launcher directly, using the same 4-digit code, from the TV remote page ("Faster remote: pair with the TV", shown when the launcher answers `/pair/hello` on this Wi-Fi and the phone has no token, or its token got a 401). The hub tells the phone where the launcher is (`direct: {url, id}` on the TV) and never passes its own token on. The token lives in the iOS Keychain. Until it's paired, the phone just uses the hub route, so nothing breaks.
- **Launcher change (small):** per-client tokens (`/pair/finish` returns a new token per client name, and Settings on the TV lists them with Forget). This lets Riley revoke a lost phone without re-pairing the hubs. It's worth doing, but optional for the first cut.

## API calls the remote needs

Here is how House Control's actions (`hub/tv.py` `act`, `web/src/tv`, `ios-native/Sources/Model/TVStore.swift`) map onto the launcher:

| House Control action | Launcher today | Change needed |
|---|---|---|
| `up/down/left/right/ok/back` | `key` via accessibility | none |
| `home` | `key home` opens Living Room | none |
| `playpause/play/pause` | `media toggle/play/pause` (media session), `primary` | none |
| `rewind/forward`, `skip ±s`, `seek position` | `media` with `ms` (relative) | add absolute `seek {positionMs}` |
| `volup/voldown/mute` | `volume {delta}` (AudioManager, CEC forwards it) | add `mute` |
| `volume {level}` (the slider) | — | add absolute level, and report `volume/volumeMax/muted` in state. **Risk:** with HDMI-CEC the Chromecast may not know the TV's real level. See the fallback below. |
| `power/wake/sleep` | `power` toggles | split into `wake` and `sleep` so scenes are idempotent |
| `text`, `search` | `text` + `submit` | none (search = type into the focused field + submit) |
| `open {app}` | `launch {pkg}` | none (the hub maps app ids to packages, `APPS` in tv.py) |
| `play {app, link}` (from search) | — | add `open {url, pkg}`: `ACTION_VIEW` on the link, restricted to the package. The hub keeps doing link validation. |
| `menu`, `chup/chdown`, `input` | — | dropped on the launcher route. They only make sense on the hub fallback, and the panel already hides them. |
| state: on/app/now playing/art | `/api/state` long poll | `hub/launcher.py` maps it to the panel's existing TV state (`normalize` in tv.py), so the web panel and widgets don't change |
| new: Continue, installed apps | in `/api/state` | the remote's app row can show the TV's real installed apps and order, and Continue can show up as cards in the sheet (later) |

Art: the hub proxies `/art/now` and `/banner/{pkg}` so the panel never needs the token. The phone, when it's on the LAN, loads them straight from the launcher.

## What moves off the Mac

| Today (Mac) | After |
|---|---|
| `~/tv-remote` (port 8765), the Android TV Remote connection for keys, launch and volume | Launcher API for keys, launch, media and text. The hub on the Dell talks to it directly. |
| pychromecast Now Playing in the hub (`nowplaying.py`) | Launcher media sessions. Cast stays as a fallback for cast-only sessions (casting from a phone app), where the launcher sees less. |
| ADB Now Playing fallback | ADB stays for install and recovery only |
| JustWatch search | already in the hub (`tv.py search`), no change |
| Launcher build + install (JDK 17, Android SDK, adb) | still on the Mac. The Dell could do it later, but it's not needed. |

**Fallback.** `hub/tv.py` keeps the tv-remote backend behind the same interface (`HOUSE_TV_BACKEND=launcher|tvremote`, launcher by default, with automatic fallback when the launcher doesn't answer). Things the launcher can't do from inside the TV go there: waking a TV whose Chromecast is in deep sleep, and possibly the real CEC volume level. Longer term, the Dell hub can speak the Android TV Remote v2 protocol itself (the `androidtvremote2` Python package) for just those, and then `~/tv-remote` can be retired. That is phase 3, not the first cut.

## Phases

1. **Bring it in.** Copy `tv/` → `tv-launcher/` (without the old web remote), and add the launcher changes from the table: absolute seek, mute, absolute volume plus state, wake/sleep, open-URL. Then build it, install it on the TV over ADB from the Mac, and check every action on the real TV with Riley watching.
2. **Hub backend.** Add `hub/launcher.py` + the backend switch in `tv.py`, pairing, and art proxy, plus tests next to `hub/tests/test_tv.py`. Deploy to the Dell and the Mac. The web panel, the widgets and the TestFlight app keep working with no change, because the hub API shape stays the same.
3. **Phone direct route.** The iPhone app gets LAN-first routing and pairing in `TVStore`. This touches `ios-native/`, so it gets coordinated with the Native iOS app thread, which is shipping TestFlight builds right now. It goes out as a new TestFlight build.
4. **Home takeover.** Authorized by Riley on October 23, 2026. Living Room now declares Android HOME/DEFAULT. `tv-home.py enable` records the stock Home, hardware serial and Google package enabled states, verifies the replacement opens, selects it, and disables launcherx and SetupWraith for user 0. `restore` reverses this before uninstall; failed takeover triggers restoration. See the launcher README for commands and live verification notes.

## Open risks

- **Home loop.** Both launcherx and SetupWraith are disabled for user 0 after the replacement opens. Their original states and the stock Home component are recorded for recovery; neither package is uninstalled. The installer verifies the selected Home, and update installs preserve the current foreground app when takeover is already configured.
- **Volume level over CEC.** It's unknown whether Android sees the TV's real volume. If it doesn't, the slider uses the Android TV Remote fallback, or turns into up/down buttons on the launcher route.
- **Wake from sleep.** When the Chromecast sleeps, Android may doze the launcher's server, so `wake` may not answer. The hub fallback (Remote protocol / Cast) covers wake. This needs testing on the device.
- **Unverified commands.** Play/pause/seek, volume, power and typing haven't been run on the real TV yet. Phase 1 tests them with Riley present, so nothing interrupts a show unexpectedly.
- **Now Playing coverage.** It's unknown which apps besides YouTube publish good media sessions (Netflix, Max, Hulu, Disney+). Cast stays as the fallback.
- **One shared token, plain HTTP.** It's LAN-grade, like the hub. Per-client tokens are listed above as an optional improvement.
- **Device budget.** The 2 GB RAM / 750 MB free limit means bounded art caches, no video backgrounds and no extra always-on services, which is part of why Tailscale stays off the TV.
- **Accessibility and notification access** are granted over ADB at install. A Google TV update can reset them. The launcher already reports `caps.keys/media`, and the remote should say "TV needs re-setup" when they go false.
