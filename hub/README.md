# House Control hub

A small service on your Mac that drives the lights and air conditioners itself, and
serves the House Control panel to any phone or computer on your Wi-Fi. No Home Assistant,
no bridge, and no phone in the loop.

| Platform | How it is reached | What you need |
|---|---|---|
| **WiZ** (Philips WiZ bulbs, strips, plugs) | Directly over the home network: UDP port 38899, the same local API the WiZ app uses | Nothing. Lights are found by themselves |
| **MRCOOL SmartHVAC** | Cielo's cloud (the SmartHVAC controller is a Cielo Breez inside), through Cielo's Open API | A Cielo API key, made once |

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
`pendant`, `spots`, `floor`, `table`, `strip`) for how it looks in the 3D model. The hub
makes a simple floor plan from this file (a box per room) until the real one is drawn.
A `~/.house-hub/plan.json` without `"generatedBy": "hub"` is your own plan and is used as
it is; link its lamps with `"link": {"service": "wiz", "id": "<mac>"}` and its ACs with
`"link": {"service": "mrcool", "id": "<mac>"}`.

`python house.py scan` lists every light and AC the hub can find, with its MAC address.

### Connect the MRCOOL air conditioner

1. Open [home.cielowigle.com](https://home.cielowigle.com) and sign in with the email and
   password of the MRCOOL SmartHVAC app.
2. Open the menu at the top left, choose **Home Assistant** and copy the API key (a new one
   can take a minute to appear). Each key can be used once, and Cielo allows three a month.
3. Give it to the hub:

   ```sh
   curl -X POST http://localhost:8766/api/mrcool -H 'Content-Type: application/json' -d '{"api_key": "PASTE-IT-HERE"}'
   ```

   It is kept in `~/.house-hub/mrcool.json`, readable by you only, and sent to Cielo only.

Cielo's cloud is rate limited, so the hub reads the AC every 90 seconds; a change made in
the panel shows at once.

## How it fits together

```
iPhone / Mac browser ── HTTP ──▶ hub (house.py, port 8766) ── UDP 38899 ──▶ WiZ lights
        ▲                          │
        └── server-sent events ────┤ ── HTTPS ──▶ Cielo cloud ──▶ MRCOOL SmartHVAC
```

- `house.py` — the web server, the device state, the login item.
- `wiz.py` — WiZ discovery and control.
- `mrcool.py` — the Cielo Open API client.
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
