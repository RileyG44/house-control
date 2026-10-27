# House Control hub

A small service on your Mac that drives the lights and air conditioners itself, and
serves the House Control panel to any phone or computer on your Wi-Fi. No Home Assistant,
no bridge, and no phone in the loop.

| Platform | How it is reached | What you need |
|---|---|---|
| **WiZ** (Philips WiZ bulbs, strips, plugs) | Directly over the home network: UDP port 38899, the same local API the WiZ app uses | Nothing. Lights are found by themselves |
| **AiDot / Linkind** (AiDot Wi-Fi bulbs) | Locally over the home network: TCP port 10000 (UDP 6666 finds them); the cloud is used once to sign in and learn each bulb's LAN key | The AiDot app sign-in, given once — see below |
| **MRCOOL SmartHVAC** | Cielo's cloud (the SmartHVAC controller is a Cielo Breez inside), the same account Alexa uses | The MRCOOL app email and password, given once |

## Set up

1. In Terminal: `cd house-control/hub && ./setup.sh`
2. If macOS asks whether Python may find devices on your local network, click **Allow**.
   Without it, no light can be found.
3. Open the address it prints (like `http://192.168.0.188:8766`) on your iPhone in Safari,
   then Share → **Add to Home Screen**.

It starts by itself whenever you log in. `python house.py uninstall` stops that.

### Name your lights and rooms

WiZ lights tell the network their MAC address and what they can do, not their name. The
names and rooms live in `~/.house-hub/devices.json`, keyed by MAC address (the WiZ app shows
it under a light's Settings → Device info):

```json
{
  "home": "Riley's Home",
  "rooms": ["Kitchen", "Bedroom"],
  "lights": {
    "d8a0113a23e6": { "name": "Edison Bulb", "room": "Kitchen" },
    "444f8ec6fad8": { "name": "Counter Light", "room": "Kitchen", "type": "strip" }
  },
  "acs": { "485519fb47c7": { "name": "Bedroom AC", "room": "Bedroom" } }
}
```

A light may also have `"ip"` for a network that drops broadcasts, and `"type"` (`ceiling`,
`pendant`, `spots`, `floor`, `table`, `strip`) for how it looks in the 3D model. AiDot
bulbs also carry `"service": "aidot"`; they are matched by MAC address, or by `"ip"` or
`"name"` when AiDot has given the bulb a new device id. A hub with no
`~/.house-hub/plan.json` starts from Riley's Studio, the panel's default home
(`web/dist/plans/riley.json`, or `web/public/plans/riley.json` in the repo), and links each of
its unlinked lamps and ACs to the found device of the same name (so the AiDot "Door Light" and
"Bathroom Light" find their bulbs); it keeps doing so as devices turn up, until a plan is saved.
Without that file, and for a hub that already made one, it makes a simple floor plan from
`devices.json` (a box per room). A `~/.house-hub/plan.json` without `"generatedBy": "hub"` or
`"seededBy": "hub"` is your own plan and is used as it is, never replaced; link its lamps with `"link": {"service": "wiz", "id": "<mac>"}` (or `"aidot"`) and
its ACs with `"link": {"service": "mrcool", "id": "<mac>"}`. The Mac app's editor saves to
`~/Library/Application Support/HouseControl/plan.json`. When that file is newer, the hub
copies it here, so the site shows the layout you just saved.

### Rearrange the rooms

The panel's settings button → **Edit home…** opens the editor on any phone or browser that
reaches the hub (on the LAN or through Tailscale): drag rooms, resize them, move lamps, ACs and
furniture, and link lamps and ACs to the WiZ, AiDot and MRCOOL devices the hub found. **Save**
writes the plan to `~/.house-hub/plan.json` and to the Mac app's plan file, so every open panel
reloads with it and the Mac's menu bar panel and island switch to it within a couple of seconds.
`GET /api/plan` returns the plan the hub serves.

### The weather

When the plan has a `site` (where the home is: `lat`, `lon`; see `docs/landscape-weather.md`),
the hub reads the weather there from [Open-Meteo](https://open-meteo.com) every 10 minutes (no key,
no account; 2 minutes after a failed read, keeping the last good one) for the panel's sky.
`GET /api/weather` returns the last reading (`{"kind": null}` before the first one), and open
panels hear each change as a `weather` event on `/api/events`.

`python house.py scan` lists every light and AC the hub can find, with its MAC address.

### Connect the AiDot bulbs

AiDot bulbs keep their LAN key in AiDot's cloud, so the hub signs in once to learn it
and drives the bulbs locally from then on (the `python-aidot` library, the one Home
Assistant's AiDot integration uses):

```sh
curl -X POST http://localhost:8766/api/aidot -H 'Content-Type: application/json' -d '{"email": "YOU@EXAMPLE.COM", "password": "PASTE-IT-HERE"}'
```

Run it from this Mac (Terminal), not from a phone on the LAN. The sign-in is kept in
`~/.house-hub/aidot.json`, readable by you only, and sent to AiDot only. Name each bulb
in `devices.json` as above (`"service": "aidot"`, its MAC address without colons, its
room, and its `"ip"` if your network drops broadcasts). A change made in the AiDot app
shows in the panel from the bulb's own reports; white-vs-colour mode is remembered
from the last change the hub sent, because the bulb does not report it.

### Connect the MRCOOL air conditioner

The SmartHVAC controller is an older Cielo Breez. Cielo will not make a Home Assistant
API key for it, which is why Alexa can still control it: Alexa uses the account, not
that key. Give the hub the same email and password as the MRCOOL app:

```sh
curl -X POST http://localhost:8766/api/mrcool -H 'Content-Type: application/json' -d '{"email": "YOU@EXAMPLE.COM", "password": "PASTE-IT-HERE"}'
```

Run it from this Mac (Terminal), not from a phone on the LAN. The sign-in is kept in
`~/.house-hub/mrcool.json`, readable by you only, and sent to Cielo only. The hub
refreshes the session itself.

A newer thermostat or Breez Edge Pro/Max can instead take the one-time key from the
portal's Home Assistant page: `{"api_key": "PASTE-IT-HERE"}` to the same address.

Cielo's cloud is rate limited, so the hub reads the AC every 90 seconds; a change made in
the panel shows at once.

### The TV

When the hub is paired with the TV's own launcher (Living Room, `../tv-launcher`), it drives
the TV through that: the launcher's API on the Chromecast (port 8686) tells the hub the moment
anything changes on the TV, and takes the remote's keys, the volume, typing, opening an app or
a title, and seeking. Pair once, with the TV on:

```sh
python house.py --pair-tv 192.168.0.225   # the TV shows a 4-digit code; type it in
```

That adds `"launcher": {"url", "token", …}` to `~/.house-hub/tv.json` (and keeps what else is
there), then restart the hub. Each hub pairs on its own. `HOUSE_TV_BACKEND=tvremote` keeps
using tv-remote alone. When the launcher doesn't answer (the Chromecast asleep, the app
removed), the hub uses tv-remote, below, until the launcher is back; the few things only
tv-remote can do (menu, channels, input) always go there.

Without a paired launcher, the Google TV is driven by **tv-remote**, a separate service on this Mac (`~/tv-remote`,
port 8765). The hub reads it every 2 seconds while a panel is open, shows the TV's state in
the model (off, or the app it is in), and passes the panel's remote on to it: the pad,
volume, opening an app and playing a title found in the streaming catalog (JustWatch). The
hub finds tv-remote at this Mac's LAN address, port 8765; `HOUSE_TV_URL` or
`~/.house-hub/tv.json` (`{"url": "http://192.168.0.188:8765"}`) says otherwise. If it does
not answer, the panel says so and everything else works as before.

What the TV is playing (title, show or channel, position, artwork) comes from the launcher's
media sessions, its picture through the hub (`/api/tv/art/now`). Otherwise, the hub reads it
from the TV itself over Cast, with `pychromecast` (in `requirements.txt`). It only ever reads, and seeks
when the panel's slider is moved: nothing it does opens an app on the TV. For apps that don't
report over Cast, `adb` paired with the TV (`adb devices` lists it) gives the title and state.
Without either, the remote simply shows no "now playing".

`GET /api/tv` is the TV's state, `POST /api/tv/<id>` with `{"action": …}` drives it (only the
remote's own keys, `volume`, `text`, `search`, `open` an app, `play` a checked link, `resume` a
title in the launcher's Continue, `recommendation` to open one of the apps' own picks, and `seek`
to a position or `skip` by a few seconds), and `GET /api/tv/search?q=…` searches the catalog.
See [docs/tv-remote.md](../docs/tv-remote.md) and [docs/tile-reorder-now-playing.md](../docs/tile-reorder-now-playing.md).

The streaming catalog (`catalog.py`, [docs/streaming-catalog.md](../docs/streaming-catalog.md)):
`GET /api/tv/catalog` gives rows of posters for each of the TV's apps (Popular, Trending, New)
and For you, `GET /api/tv/catalog/<app>?row=…&page=n` more of one row, and `GET
/api/tv/title/<id>` one title with the TV's apps it's included in. It comes from JustWatch,
kept 6 hours in `~/.house-hub/catalog-cache.json`; posters come through `/api/tv/img/…` and
stay in `~/.house-hub/catalog-art` (at most 200 MB).

#### The TV's nightly picks

The launcher sends what the TV plays to `POST /api/tv/history` (`history.py`); the hub keeps one
line per title, app and day in `~/.house-hub/watch-history.jsonl` (`GET /api/tv/history?days=90`
reads it). At 03:00, `smart_recs.py` gives Codex the last 90 days and the TV's apps, keeps the
titles it names that one of those apps includes in the subscription (found on JustWatch), and
writes `~/.house-hub/smart-recs.json`; For you serves them after the shows being watched. When a
night fails, the last picks stay. On the Dell, once (Codex signed in as riley: `codex login status`):

```sh
sudo cp ~/house-control/hub/systemd/house-smart-recs.* /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now house-smart-recs.timer
sudo systemctl start house-smart-recs.service       # tonight's picks now, rather than at 03:00
journalctl -u house-smart-recs.service -n 30         # how the last run went
```

`.venv/bin/python smart_recs.py --dry-run` prints the picks without keeping them.

At 16:30, `house-smart-evening.timer` runs `smart_recs.py --evening`: a dozen films for tonight in
`smart-evening.json`, which For you puts right after Continue until they are 12 hours old (it
remembers the last few evenings' films so they don't repeat). Both runs give Codex
`~/.house-hub/taste.md`, a free-form note on Riley's taste (favourite films and eras, interests);
it lives only on the hub, not in git. Install it like the nightly timer:

```sh
sudo cp ~/house-control/hub/systemd/house-smart-evening.* /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now house-smart-evening.timer
```

### The house agent (say what you want)

The panel's mic button (and the iPhone app's) sends what you say or type to `POST /api/agent
{"text", "client"}`; `agent.py` runs it through the same Codex as the nightly picks (`codex exec`,
read-only, in an empty folder), with the house's own tools: look at the home, lights, the AC,
scenes, the TV (keys, apps, finding and playing a title), Spotify on the Echo, and the picks. Its
steps reach every open panel as `agent` events on `/api/events`, and the answer is one or two
spoken sentences. One request runs at a time (three more may wait), each at most 120 s. A hub
without Codex (the Mac backup) asks the other hub. `HOUSE_AGENT_MODEL` picks the model,
`HOUSE_AGENT_EFFORT` its reasoning effort (`low`); `taste.md` tells it about Riley. See
[docs/voice-agent.md](../docs/voice-agent.md).

Codex reaches the tools through `agent_mcp.py`, a small stdio MCP server (standard library only)
that calls `GET /api/agent/tools` and `POST /api/agent/tool/<name>` on this hub; those answer only
programs on the hub computer itself. Any other MCP client there can use it too:

```sh
claude mcp add house -- ~/house-control/hub/.venv/bin/python ~/house-control/hub/agent_mcp.py
```

(`HOUSE_HUB_URL` in its environment if the hub isn't on `http://127.0.0.1:8766`).

### A second hub that keeps the same plan

Two hubs can stand in for each other: Riley's runs on the home server (dell-server) and, as a
backup, on the MacBook; the native iPhone app goes to the backup when the server doesn't answer
(docs/native-ios.md). Each keeps the other's floor plan, tile order, room order and scenes, so the
home looks the same whichever one a screen reaches. Tell each hub where the other one is, in
`~/.house-hub/peer.json` (addresses tried in this order):

```json
{ "urls": ["http://192.168.0.127:8766", "https://dell-server.tail946e94.ts.net"] }
```

or in `HOUSE_PEER_URLS` (comma separated, which wins over the file). Without either, the hub keeps
its plan to itself.

- Every save from a screen stamps the plan with `savedAt` (unix ms, always later than the plan it
  replaces) and sends it on: `POST /api/call {"type": "savePlan", "config": <plan>, "client": "peer",
  "fromPeer": true}` to the first address that answers (three tries, 5 s then 10 s apart).
- A plan marked `fromPeer` is kept as it is, stamp and all, and is not sent back; one no newer than
  this hub's own is left alone. Screens on that hub reload it as after any save.
- At start and every 60 s each hub reads the other's `GET /api/plan`: the plan saved last wins on
  both (a plan without a stamp counts as the oldest; two without one are left as they are). So a
  hub that was off, or a Wi-Fi link that dropped, catches up within a minute of coming back.
- The stamp isn't part of how a plan looks: it never makes a plan the hub makes the user's own,
  and a save that changes nothing else doesn't make the screens reload. A plan copied in from the
  Mac app's editor file is stamped with that file's time.

## How it fits together

```
iPhone / Mac browser ── HTTP ──▶ hub (house.py, port 8766) ── UDP 38899 ──▶ WiZ lights
        ▲                          ├ ── TCP 10000 ──▶ AiDot bulbs (key learned once from AiDot's cloud)
        └── server-sent events ────┤ ── HTTPS ──▶ Cielo cloud ──▶ MRCOOL SmartHVAC
```

- `house.py` — the web server, the device state, the login item.
- `wiz.py` — WiZ discovery and control.
- `aidot_lan.py` — AiDot sign-in and local control, over `python-aidot`.
- `mrcool.py` — the Cielo client (Open API key, or the MRCOOL account Alexa uses).
- `tv.py` — the TV through its launcher or tv-remote, and the streaming catalog search.
- `launcher.py` — the client for the TV launcher's API, and pairing with it.
- `nowplaying.py` — what the TV is playing, over Cast (or adb), and seeking.
- `plan.py` — the starting floor plan: Riley's Studio linked by name, or boxes made from `devices.json`.
- `agent.py` — the house agent: the tools, and running a request through Codex; `agent_mcp.py` — those tools over MCP.

The panel is the same web UI the Mac and iPhone apps use (`../web`). Served by the hub it
sends each change to `POST /api/call` and receives the devices' state from
`GET /api/events`, the way it talks to the native shells.

## Development

```sh
.venv/bin/pip install pytest
.venv/bin/python -m pytest tests
```

The tests run against pretend WiZ lights (`tests/fake_wiz.py`), a pretend Cielo, tv-remote and
TV launcher (`tests/fake_launcher.py`, which also runs on its own: pair with code 4821), so they
need no hardware or account. To work on the panel with pretend lights:

```sh
python tests/fake_wiz.py &        # three lights on 127.0.0.2–4
HOUSE_HUB_DIR=/tmp/hub python house.py
```

with a `/tmp/hub/devices.json` that gives those lights `"ip": "127.0.0.2"` and so on.

| Variable | Default | |
|---|---|---|
| `HOUSE_HUB_PORT` | `8766` | The panel's port |
| `HOUSE_HUB_DIR` | `~/.house-hub` | Names, plan, Cielo key, log |
| `HOUSE_HUB_WEB` | `../web/dist` | The built panel |
| `HOUSE_TV_BACKEND` | `launcher` when paired | `tvremote`: drive the TV through tv-remote only |
| `HOUSE_TV_URL` | `http://<LAN IP>:8765` | tv-remote, the TV's service on the Mac |
| `HOUSE_TV_CAST` | on | `off`: don't read the TV over Cast |
| `HOUSE_TV_ADB` | `adb` on the `PATH` | The adb to read the TV's media sessions with, or `off` |
| `HOUSE_AGENT_MODEL` | Codex's own | The model the house agent asks (`codex exec -m`) |
| `HOUSE_AGENT_EFFORT` | `low` | Its reasoning effort |
