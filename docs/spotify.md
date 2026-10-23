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
With Spotify Connect authorized, **Your playlists** lists the account's owned/followed
playlists, including private and collaborative playlists. Choose an output and tap a
playlist to start it on that device. More playlists load in pages of 50 only when asked;
the regular player poll never re-fetches the library. Merely choosing another output
preserves whether playback is paused.
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
When a Mac prefers its peer and discovery fails, it waits 30 seconds before trying that
same set of addresses again. Its local Spotify controls stay responsive during this
cooldown; discovery then resumes automatically. Changing the configured peer addresses
allows an immediate new probe.

This adapter controls the Spotify application. Choose the output in Spotify itself.
Spotify’s scripting dictionary does not expose an output picker; to select an Echo
directly from House Control, connect the account as below.

## Spotify Connect, including the Echo

Spotify’s [Player API](https://developer.spotify.com/documentation/web-api/reference/transfer-a-users-playback)
supports choosing among the account’s available Spotify Connect devices. Playback control
requires Spotify Premium; some devices are not exposed by Spotify’s API. An Echo must
already be linked to the Spotify account and appear as an available output in Spotify.
House Control shows only the devices Spotify actually reports and honors fixed-volume outputs.

For this home, authorize the **Dell hub** so playback does not depend on the Mac staying
on the same Wi-Fi. The Dell sends commands through Spotify's cloud, and the linked Echo
streams the music itself. The Mac can stay on Iron while the Dell and Echo stay on LocalTel
2595. House Control still needs a route to its hub, using its existing Tailscale addresses
when LAN addresses cannot be reached. Spotify's [Connect guidance](https://support.spotify.com/us/article/spotify-connect/)
notes that initial speaker pairing needs the same Wi-Fi; devices signed into the account
can subsequently appear across networks. Device availability is still determined by Spotify.

1. In the [Spotify developer dashboard](https://developer.spotify.com/dashboard), sign in
   with the existing Premium account and create **House Control**. Select **Web API** and
   register `http://127.0.0.1:8767/callback` as the redirect URI. The developer app does not
   require a separate developer subscription. Copy its **Client ID**, not its client secret.
2. From the Mac, open an SSH session with loopback forwarding to the Dell. Use its Tailscale
   SSH hostname instead of the LAN alias if the Mac is on another network:

   ```sh
   ssh -L 8767:127.0.0.1:8767 dell-server-lan
   cd ~/house-control/hub
   .venv/bin/python spotify_pair.py --client-id YOUR_PUBLIC_CLIENT_ID --no-browser
   ```

   Open the printed Spotify sign-in URL in the Mac browser. Keep SSH open until the
   command confirms pairing. The callback travels through SSH and the tokens are saved
   only on the Dell. Do not expose port 8767 on the LAN or forward it through the router.
   On the Mac hub, set `"prefer_peer": true` in `~/.house-hub/spotify.json` (preserving any
   existing settings). Its existing peer URLs then let the native desktop app use the
   Dell's authorized Spotify remote, including playlists, across Tailscale. Without this
   setting an unpaired Mac hub uses its local Spotify application's scripting interface.
3. Open House Control's speaker remote, choose the Echo under **Playing on**, then tap one
   of **Your playlists**. Spotify must report the Echo as available. If it has gone idle,
   open Spotify or ask Alexa to play Spotify, then Refresh the remote.

Alternatively, to authorize the Mac hub and let the Dell bridge to it, run locally:

```sh
cd ~/Developer/house-control/hub
.venv/bin/python spotify_pair.py --client-id YOUR_PUBLIC_CLIENT_ID
```

This uses Spotify’s [authorization code flow with PKCE](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow)
and requests `user-read-playback-state`, `user-modify-playback-state`, `playlist-read-private`
and `playlist-read-collaborative`. Existing playback-only authorizations need to sign in
again to allow reading the playlist library.
The callback listens on loopback, verifies a one-time state value, and expires after five
minutes. Tokens stay in `~/.house-hub/spotify.json` (mode 0600); they are refreshed on the
hub and never sent to the phone, desktop or TV. Pairing on the Mac is sufficient: the Dell
can bridge to that account. The hub picks up a new pairing without restarting.

Spotify's October 2026 [development-mode rules](https://developer.spotify.com/documentation/web-api/concepts/quota-modes)
require the owner to retain Premium, limit an app to five authorized users, and require
each user to be allowlisted. A shared public app with ordinary sign-in needs extended
access; the current criteria include a registered organization and 250,000 monthly active
users. This is a real distribution constraint. Other self-hosted homes can configure
their own client ID; the code does not embed Riley's app identity or tokens.
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

### Save the current song

The plus button saves the displayed song to **Liked Songs**. The adjacent playlist menu
adds that song to an editable playlist instead. Both capture the song's Spotify URI when
pressed, so a queued command never accidentally saves the next song. Episodes, local files,
and the Mac scripting fallback do not offer song saving. Playlist pages load independently
of the player poll; use **More playlists** to find another destination.

Existing Spotify connections must run `spotify_pair.py` once more and accept the additional
library and playlist permissions. Playback and speaker selection continue working before
that consent; the remote explains why saving is disabled. No new developer app or secret is
needed. Pairing stores the granted scopes with the private hub credentials.

The hub uses Spotify's current `PUT /me/library` and `POST /playlists/{id}/items` endpoints.
Saved-song checks are cached for one minute; library failures do not disable playback.
Commands are sent once to the selected hub and are never replayed on another hub after a
timeout. A playlist request that loses its reply should be checked in Spotify before retrying.
