"""AiDot / Linkind Wi-Fi bulbs, through AiDot's local LAN protocol.

AiDot bulbs do not speak WiZ. The AiDot cloud is used once, to sign in and learn
each bulb's LAN key and device password; afterwards the bulb itself is driven
over the home network on TCP port 10000 with AES-encrypted frames, and found by
a UDP broadcast on port 6666. That split is AiDot's own design, implemented by
the `python-aidot` library (the one Home Assistant's AiDot integration uses);
this module is only the translation between that library and the panel.

The panel's patch vocabulary (on, brightness 0..1, temp in kelvin, colour as
"#rrggbb") maps onto the bulb's attributes like this:

  on          OnOff     1 / 0
  brightness  Dimming   0..100 on the wire (the library takes 0..255)
  temp        CCT       kelvin, inside the bulb's own range
  colour      RGBW      (r<<24)|(g<<16)|(b<<8)|w, white channel 0

Credentials live in ~/.house-hub/aidot.json (0600): {"email", "password",
"country_code"}. The password is only ever sent, RSA-encrypted by the library,
to AiDot's sign-in endpoint; the day-to-day control is local. Changing a light
from the AiDot app is picked up from the bulb's own status reports, except for
white-vs-colour mode, which the bulb does not report: the hub remembers the
mode of the last change it sent.
"""
from __future__ import annotations

import asyncio
import functools
import json
import logging
import time
from pathlib import Path

from wiz import hex_color, rgb

log = logging.getLogger("house.aidot")

try:  # The hub still runs (and its WiZ/MRCOOL tests still pass) without it.
    from aidot.client import AidotClient as _AidotClient
    from aidot.device_client import DeviceClient as _DeviceClient
except Exception:  # ImportError, or a broken install
    _AidotClient = _DeviceClient = None


class AidotError(Exception):
    pass


# ---------- python-aidot's connection loops ----------
# These lean on DeviceClient internals of the pinned python-aidot (requirements.txt);
# check them again before upgrading it.

RECONNECT_GAP = 10.0  # seconds between connection attempts to one bulb


class _LanReader:
    """A bulb's TCP stream as python-aidot's receive loop reads it.

    The library (0.3.59) treats a read that fails with anything but a short list of
    connection errors as one bad message and reads again at once. A socket that has lost
    its local address (errno 49 on macOS, after the Mac changes networks) fails every read
    without waiting, so that loop never yielded: the hub stopped answering until restarted
    and logged about 14,000 identical lines a second. A failed read means the connection is
    gone, so it is reported as a reset, which the library answers by closing the socket and
    reconnecting (see _spaced_connect)."""

    def __init__(self, reader):
        self._reader = reader

    async def readexactly(self, n: int) -> bytes:
        try:
            return await self._reader.readexactly(n)
        except (asyncio.IncompleteReadError, ConnectionResetError, BrokenPipeError):
            raise
        except Exception as e:
            raise ConnectionResetError(f"connection lost ({e})") from e

    def __getattr__(self, name):
        return getattr(self._reader, name)


def _guarded_receive(receive):
    async def receive_data(self, *args, **kwargs):
        if getattr(self, "reader", None) is not None and not isinstance(self.reader, _LanReader):
            self.reader = _LanReader(self.reader)
        return await receive(self, *args, **kwargs)
    return receive_data


def _spaced_connect(connect):
    """After a reset the library reconnects at once, and again every minute until one
    works. A bulb that accepts the login and then drops the connection would be redialled
    as fast as the network answers, so attempts on one bulb are kept RECONNECT_GAP apart."""
    async def spaced(self, *args, **kwargs):
        wait = getattr(self, "_house_next_connect", 0.0) - time.monotonic()
        if wait > 0:
            self._connecting = True  # the library's other reconnect paths stand aside meanwhile
            try:
                await asyncio.sleep(wait)
            finally:
                self._connecting = False
            if self._is_close:
                return
        self._house_next_connect = time.monotonic() + RECONNECT_GAP
        return await connect(self, *args, **kwargs)
    return spaced


def _guard(cls, name: str, wrap) -> None:
    original = getattr(cls, name, None)
    if original is None:
        log.warning("python-aidot's DeviceClient has no %s; its connection guard is off", name)
        return
    if getattr(original, "house_guarded", False):
        return
    guarded = functools.wraps(original)(wrap(original))
    guarded.house_guarded = True
    setattr(cls, name, guarded)


if _DeviceClient is not None:
    _guard(_DeviceClient, "receive_data", _guarded_receive)
    _guard(_DeviceClient, "connect", _spaced_connect)


class QuietRepeats(logging.Filter):
    """Lets each distinct python-aidot message through at most once a minute.

    The library logs from inside its connection loops, so one failing bulb can repeat a
    line as fast as it retries. Repeats are counted and reported on the next one let through.
    The decision is kept on the record, so every handler it reaches agrees with the first."""

    def __init__(self, prefix: str = "aidot", every: float = 60.0, clock=time.monotonic):
        super().__init__()
        self.prefix, self.every, self.clock = prefix, every, clock
        self.seen: dict[str, list] = {}  # message -> [when last let through, repeats since]

    def filter(self, record: logging.LogRecord) -> bool:
        if record.name != self.prefix and not record.name.startswith(self.prefix + "."):
            return True
        decided = getattr(record, "house_quiet", None)
        if decided is None:
            decided = record.house_quiet = self._let_through(record)
        return decided

    def _let_through(self, record: logging.LogRecord) -> bool:
        text, now = record.getMessage(), self.clock()
        entry = self.seen.get(text)
        if entry and now - entry[0] < self.every:
            entry[1] += 1
            return False
        if len(self.seen) >= 256:
            self.seen = {k: v for k, v in self.seen.items() if now - v[0] < self.every}
        self.seen[text] = [now, 0]
        if entry and entry[1]:
            record.msg, record.args = f"{text} (and {entry[1]} more like it in {now - entry[0]:.0f}s)", ()
        return True


def normalize_mac(mac: str | None) -> str:
    """'D8:47:32:D8:D0:DF' -> 'd84732d8d0df', the key devices.json uses."""
    return (mac or "").replace(":", "").replace("-", "").strip().lower()


def panel_reading(status: dict, mode: str = "white") -> dict:
    """A bulb status in the panel's terms. `status` is {on, dimming 0..255,
    cct, rgbw (r, g, b, w)} as python-aidot's DeviceStatusData reports it."""
    out: dict = {"on": bool(status.get("on"))}
    dimming = status.get("dimming")
    if dimming is not None:
        out["brightness"] = max(0.05, min(1.0, dimming / 255))
    if mode == "color":
        r, g, b, _w = status.get("rgbw") or (0, 0, 0, 0)
        out["color"] = hex_color(r, g, b) if (r or g or b) else None
        out["temp"] = int(status["cct"]) if status.get("cct") else None
    else:
        if status.get("cct"):
            out["temp"] = int(status["cct"])
        out["color"] = None
    return out


def lan_steps(patch: dict) -> list[tuple[str, object]]:
    """A panel patch as ordered bulb operations: power first, then dimming,
    then white temperature or colour (a patch carries at most one of the two;
    the panel clears colour when it sets a temperature)."""
    steps: list[tuple[str, object]] = []
    if "on" in patch:
        steps.append(("on", bool(patch["on"])))
        if patch["on"] is False:
            return steps
    if "brightness" in patch and patch["brightness"] is not None:
        steps.append(("brightness", max(0, min(255, round(patch["brightness"] * 255)))))
    if patch.get("color"):
        c = rgb(patch["color"])
        if c:
            steps.append(("rgbw", (c[0], c[1], c[2], 0)))
    elif patch.get("temp"):
        steps.append(("cct", int(patch["temp"])))
    # Switching on with nothing else is still a step; an empty patch is not.
    if not steps and patch.get("on"):
        steps.append(("on", True))
    return steps


def _status_of(client) -> dict:
    s = client.status
    return {"on": bool(getattr(s, "on", False)), "dimming": getattr(s, "dimming", 100),
            "cct": getattr(s, "cct", 2700), "rgbw": tuple(getattr(s, "rgbw", (255, 0, 0, 0)))}


class AidotLanClient:
    """Every AiDot bulb on one account: sign in, learn the bulbs, drive them locally.

    Devices are keyed the way devices.json keys WiZ lights, by MAC address
    without colons, so a bulb keeps its name and room when AiDot gives it a
    new device id. The AiDot device id is kept alongside for the LAN login.
    """

    def __init__(self, secret: Path, session):
        self.secret = secret
        self.http = session
        self.client = None            # the python-aidot AidotClient, once signed in
        self.devices: dict[str, dict] = {}   # key -> the device as AiDot described it
        self.clients: dict[str, object] = {}  # key -> its DeviceClient (LAN connection)
        self.state: dict[str, dict] = {}      # key -> last panel reading
        self.modes: dict[str, str] = {}       # key -> "white" | "color" (see module note)
        self.ips: dict[str, str] = {}         # key -> last known address

    # ---------- credentials ----------

    def _stored(self) -> dict:
        try:
            return json.loads(self.secret.read_text())
        except (OSError, ValueError):
            return {}

    @property
    def email(self) -> str | None:
        stored = self._stored()
        return stored.get("email") or stored.get("username") or None

    @property
    def configured(self) -> bool:
        stored = self._stored()
        return bool(self.email and stored.get("password"))

    def save_credentials(self, email: str, password: str, country_code: str = "US") -> None:
        self.secret.parent.mkdir(parents=True, exist_ok=True)
        self.secret.write_text(json.dumps(
            {"email": email.strip(), "password": password, "country_code": country_code or "US"}))
        self.secret.chmod(0o600)

    # ---------- lifecycle ----------

    async def connect(self) -> None:
        """Signs in and learns every light on the account. Raises AidotError."""
        if _AidotClient is None:
            raise AidotError("python-aidot is not installed: run ./setup.sh or "
                             "`.venv/bin/pip install -r requirements.txt` in the hub folder")
        stored = self._stored()
        if not self.configured:
            raise AidotError("No AiDot sign-in yet: see hub/README.md")
        client = _AidotClient(self.http, country_code=stored.get("country_code") or "US",
                              username=self.email, password=stored["password"])
        try:
            await client.async_post_login()
            found = await client.async_get_all_device()
        except AidotError:
            raise
        except Exception as e:
            raise AidotError(f"AiDot sign-in failed: {e}") from e
        self.client = client
        self.devices, self.clients = {}, {}
        for device in found.get("device_list") or []:
            if device.get("type") not in (None, "light") and not device.get("aesKey"):
                continue
            key = normalize_mac(device.get("mac")) or device.get("id") or ""
            if not key:
                continue
            self.devices[key] = device
            props = device.get("properties") or {}
            if props.get("ipAddress"):
                self.ips[key] = props["ipAddress"]
            try:
                self.clients[key] = client.get_device_client(device)
            except Exception as e:
                log.warning("AiDot %s: no LAN client: %s", key, e)
        log.info("AiDot: %d light(s) on the account", len(self.devices))

    async def refresh(self) -> None:
        """Re-reads the account's device list (new bulbs, new addresses)."""
        await self.connect()
        self.set_known_ips(self.ips)

    def set_known_ips(self, ips: dict[str, str]) -> None:
        """Addresses written in devices.json win over the cloud's last report."""
        for key, ip in ips.items():
            if key in self.clients and ip:
                self.ips[key] = ip
                self.clients[key].update_ip_address(ip)

    async def close(self) -> None:
        if self.client is not None:
            try:
                await self.client.async_close()
            except Exception:
                pass
            self.client = None

    # ---------- devices ----------

    def describe_all(self) -> list[dict]:
        return [self.describe(key) for key in self.devices]

    def describe(self, key: str) -> dict:
        device = self.devices[key]
        client = self.clients.get(key)
        info = getattr(client, "info", None)
        caps = ["brightness"]
        if getattr(info, "enable_cct", True):
            caps.append("temp")
        if getattr(info, "enable_rgbw", True):
            caps.append("color")
        lo = int(getattr(info, "cct_min", 2700) or 2700)
        hi = int(getattr(info, "cct_max", 6500) or 6500)
        return {"id": key, "service": "aidot", "device_id": device.get("id"),
                "mac": device.get("mac"), "ip": self.ips.get(key),
                "module": device.get("modelId") or "", "kind": "bulb",
                "capabilities": caps, "kelvin": [lo, hi],
                "online": bool(getattr(getattr(client, "status", None), "online", False))}

    def read(self, key: str) -> dict:
        client = self.clients.get(key)
        if client is None or not getattr(client.status, "online", False):
            raise AidotError(f"The AiDot light {key} is not connected on the local network")
        reading = panel_reading(_status_of(client), self.modes.get(key, "white"))
        self.state[key] = reading
        return reading

    async def send(self, key: str, patch: dict, state: dict) -> None:
        client = self.clients.get(key)
        if client is None:
            raise AidotError(f"The AiDot light {key} has not been found on the account")
        for name, value in lan_steps(patch):
            try:
                if name == "on":
                    await (client.async_turn_on() if value else client.async_turn_off())
                elif name == "brightness":
                    await client.async_set_brightness(value)
                elif name == "cct":
                    await client.async_set_cct(value)
                elif name == "rgbw":
                    await client.async_set_rgbw(value)
            except AidotError:
                raise
            except Exception as e:
                raise AidotError(str(e) or e.__class__.__name__) from e
            if name == "cct":
                self.modes[key] = "white"
            elif name == "rgbw":
                self.modes[key] = "color"
        self.state.setdefault(key, dict(state))
        self.state[key].update(
            {k: v for k, v in patch.items() if k in ("on", "brightness", "temp", "color")})
