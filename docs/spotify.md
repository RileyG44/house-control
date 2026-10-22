# The studio speaker and Spotify remote

The speaker is a small furniture item (`type: "speaker"`) in the home editor. Its `pos` is
its footprint, and `y` is the tabletop height in metres. The bundled studio has one beside
the lamp on the bedside table nearest the exterior door. In an existing saved studio, use:

```sh
python3 scripts/add-studio-speaker.py --hub http://192.168.0.127:8766 --apply
```

The command adds the item to the current plan without replacing device links, presets,
room or tile order, or the rest of the layout. Running it again leaves an existing speaker
alone. The script keeps a private copy of the previous plan under `~/.house-hub/backups`
on the computer running it. The hub stamps the save and synchronizes it to the backup hub.

Tap the speaker in the 3D model or its tile to open Spotify. The native iPhone, Mac,
Windows and web remotes show the current track and provide play/pause, previous/next,
seeking and volume. Commands use `GET /api/spotify` and `POST /api/spotify` on the hub.
Opening the remote never starts music or changes the output.

## The signed-in Mac app

With Spotify installed and open on the Mac hub, the remote uses Spotify’s own macOS
scripting interface. macOS may ask to let the hub’s Python process control Spotify;
this can also be allowed under **Settings → Privacy & Security → Automation**. The
remote can open Spotify on the Mac if it is closed.

The Dell’s primary hub discovers the Mac remote through its existing `peer.json` URLs.
To specify a different bridge, set `HOUSE_SPOTIFY_URLS` (comma-separated hub addresses),
or `~/.house-hub/spotify.json` with `{"bridge_urls": ["http://192.168.0.188:8766"]}`.
Each receiving bridge request is local-only, so peers never forward a command in a loop.
An unanswered playback command is never retried on a second address.

This adapter controls the Spotify application. Choose the output in Spotify itself.
Spotify’s scripting dictionary does not expose an output picker; to select an Echo
directly from House Control, connect the account as below.

## Spotify Connect, including the Echo

Spotify’s [Player API](https://developer.spotify.com/documentation/web-api/reference/transfer-a-users-playback)
supports choosing among the account’s available Spotify Connect devices. Playback control
requires Spotify Premium; some devices are not exposed by Spotify’s API. An Echo must
already be linked to the Spotify account and appear as an available output in Spotify.
House Control shows only the devices Spotify actually reports and honors fixed-volume outputs.

1. In the [Spotify developer dashboard](https://developer.spotify.com/dashboard), use your
   own app and register `http://127.0.0.1:8767/callback` as a redirect URI.
2. On the Mac, run the command below with the app’s **public Client ID**. No client secret
   is needed. The browser opens Spotify’s sign-in and consent page.
3. Open House Control’s speaker remote and choose the Echo under **Playing on**.

```sh
cd ~/Developer/house-control/hub
.venv/bin/python spotify_pair.py --client-id YOUR_PUBLIC_CLIENT_ID
```

This uses Spotify’s [authorization code flow with PKCE](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow)
and requests only `user-read-playback-state` and `user-modify-playback-state`.
The callback listens on loopback, verifies a one-time state value, and expires after five
minutes. Tokens stay in `~/.house-hub/spotify.json` (mode 0600); they are refreshed on the
hub and never sent to the phone, desktop or TV. Pairing on the Mac is sufficient: the Dell
can bridge to that account. The hub picks up a new pairing without restarting.

Spotify developer access rules apply to the account and app; see its
[current development-mode requirements](https://developer.spotify.com/documentation/web-api/references/changes/february-2026).
If an account is not authorized, the remote shows the setup state instead of a pretend player.

## Checks

- `hub/.venv/bin/python -m pytest hub/tests/test_spotify.py`: account refresh, private token
  storage, device selection, transport controls, input validation, rate limits, bridge loop
  prevention, no playback replay after a timeout, and hub origin checks, all with fake services.
- `cd web && npm run test:e2e`: deterministic phone and desktop acceptance checks against
  `tests/preview_hub.py`, which never connects to devices. It uses the installed Chrome on
  macOS; elsewhere install Playwright Chromium. `HOUSE_TEST_PYTHON` selects Python with
  `aiohttp`; `HOUSE_TEST_CHROME` can select a browser executable.

Live Echo transfer requires the account’s one-time authorization. Native iPhone visual and
touch checks require a connected iPhone or an installed iOS simulator runtime.
