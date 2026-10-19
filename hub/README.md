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
`"name"` when AiDot has given the bulb a new device id. The hub
makes a simple floor plan from this file (a box per room) until the real one is drawn.
A `~/.house-hub/plan.json` without `"generatedBy": "hub"` is your own plan and is used as
it is; link its lamps with `"link": {"service": "wiz", "id": "<mac>"}` (or `"aidot"`) and
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
- `plan.py` — the floor plan made from `devices.json`.

The panel is the same web UI the Mac and iPhone apps use (`../web`). Served by the hub it
sends each change to `POST /api/call` and receives the devices' state from
`GET /api/events`, the way it talks to the native shells.

## Development

```sh
.venv/bin/pip install pytest
.venv/bin/python -m pytest tests
```

The tests run against pretend WiZ lights (`tests/fake_wiz.py`) and a pretend Cielo, so they
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
