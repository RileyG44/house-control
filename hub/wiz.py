"""WiZ lights, straight over the home network: no cloud, no account, no phone.

Every WiZ bulb, strip and plug listens for JSON on UDP port 38899. The calls used here:

  getPilot         what the light is doing now (state, dimming, temp or r/g/b, sceneId)
  setPilot         change it ({"state": true, "dimming": 40, "temp": 2700} …)
  getSystemConfig  its MAC address and module name (which says what it can do)
  getModelConfig   its white-temperature range (newer firmware only)

Lights are found by broadcasting getPilot; everyone answers. A light is known by its MAC
address, so it is still found when the router gives it a new IP address.
"""
from __future__ import annotations

import asyncio
import json
import logging
import socket
import time
from dataclasses import dataclass, field

log = logging.getLogger("house.wiz")

PORT = 38899
BROADCAST = "255.255.255.255"


@dataclass
class Light:
    mac: str
    ip: str
    module: str = ""
    firmware: str = ""
    capabilities: list[str] = field(default_factory=lambda: ["brightness"])
    kelvin: tuple[int, int] = (2700, 6500)
    online: bool = True
    seen: float = 0.0
    state: dict = field(default_factory=dict)

    @property
    def kind(self) -> str:
        """'strip', 'socket' or 'bulb': a guess at the shape, for the 3D model."""
        m = self.module.upper()
        if "SOCKET" in m or "PLUG" in m:
            return "socket"
        if "SHRGB3" in m or "STRIP" in m or "LED" in m:
            return "strip"
        return "bulb"

    def describe(self) -> dict:
        return {
            "id": self.mac, "ip": self.ip, "module": self.module, "firmware": self.firmware,
            "kind": self.kind, "capabilities": self.capabilities, "kelvin": list(self.kelvin),
            "online": self.online,
        }


def capabilities_of(module: str) -> list[str]:
    """What a light can do, from its module name ("ESP01_SHRGB1C_31", "ESP56_SHTW3_01" …):
    RGB lights do colour and white, TW lights tunable white, DW lights dimming only, and
    sockets just switch."""
    m = module.upper()
    if "SOCKET" in m or "PLUG" in m:
        return []
    if "RGB" in m:
        return ["brightness", "temp", "color"]
    if "TW" in m:
        return ["brightness", "temp"]
    return ["brightness"]


def hex_color(r: int, g: int, b: int) -> str:
    """The panel's "#rrggbb" at full value: WiZ keeps brightness apart in `dimming`."""
    top = max(r, g, b, 1)
    return "#%02x%02x%02x" % tuple(round(c * 255 / top) for c in (r, g, b))


def rgb(hex_: str) -> tuple[int, int, int] | None:
    s = hex_.strip().lstrip("#")
    if len(s) != 6:
        return None
    try:
        return int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16)
    except ValueError:
        return None


def reading(pilot: dict) -> dict:
    """getPilot's result in the panel's terms: on, brightness 0…1, temp in kelvin, color."""
    out: dict = {"on": bool(pilot.get("state"))}
    if "dimming" in pilot:
        out["brightness"] = max(0.05, min(1.0, pilot["dimming"] / 100))
    if pilot.get("temp"):
        out["temp"] = int(pilot["temp"])
        out["color"] = None
    elif all(k in pilot for k in ("r", "g", "b")) and (pilot["r"] or pilot["g"] or pilot["b"]):
        out["color"] = hex_color(pilot["r"], pilot["g"], pilot["b"])
    return out


def pilot_params(patch: dict, state: dict, light: Light | None = None) -> dict:
    """A change made in the panel as setPilot params. A light given a new brightness or
    colour while it shows as on is switched on too: it may have been switched off since."""
    params: dict = {}
    if "on" in patch:
        params["state"] = bool(patch["on"])
    elif state.get("on") and any(k in patch for k in ("brightness", "temp", "color")):
        params["state"] = True
    if params.get("state") is False:
        return params
    if "brightness" in patch:
        params["dimming"] = max(10, min(100, round(patch["brightness"] * 100)))
    if patch.get("color"):
        c = rgb(patch["color"])
        if c:
            params.update(r=c[0], g=c[1], b=c[2], c=0, w=0)
    elif "temp" in patch and patch["temp"]:
        lo, hi = light.kelvin if light else (2200, 6500)
        params["temp"] = max(lo, min(hi, int(patch["temp"])))
    if params.get("state") and len(params) > 1 and "dimming" not in params and "brightness" in state:
        # Colour and temperature changes keep the brightness the panel shows.
        params["dimming"] = max(10, min(100, round(state["brightness"] * 100)))
    return params


class _Protocol(asyncio.DatagramProtocol):
    def __init__(self, owner: "WizClient"):
        self.owner = owner

    def datagram_received(self, data: bytes, addr) -> None:
        try:
            msg = json.loads(data.decode("utf-8", "replace"))
        except ValueError:
            return
        self.owner._received(msg, addr[0])


class WizClient:
    """One UDP socket for every light. Requests are matched to answers by sender and method."""

    def __init__(self, broadcast: list[str] | None = None, port: int = PORT):
        self.port = port
        self.broadcast = broadcast or [BROADCAST]
        self.lights: dict[str, Light] = {}
        self._transport: asyncio.DatagramTransport | None = None
        self._waiting: dict[tuple[str, str], list[asyncio.Future]] = {}
        self._scan: list[tuple[str, dict]] | None = None

    async def start(self) -> None:
        loop = asyncio.get_running_loop()
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sock.bind(("0.0.0.0", 0))
        sock.setblocking(False)
        self._transport, _ = await loop.create_datagram_endpoint(lambda: _Protocol(self), sock=sock)

    def close(self) -> None:
        if self._transport:
            self._transport.close()

    def _received(self, msg: dict, ip: str) -> None:
        method = msg.get("method", "")
        if self._scan is not None and method == "getPilot":
            self._scan.append((ip, msg))
        for fut in self._waiting.pop((ip, method), []):
            if not fut.done():
                fut.set_result(msg)

    def _send(self, ip: str, method: str, params: dict | None = None) -> None:
        payload = json.dumps({"id": int(time.time() * 1000) % 100000, "method": method, "params": params or {}})
        assert self._transport, "start() first"
        self._transport.sendto(payload.encode(), (ip, self.port))

    async def request(self, ip: str, method: str, params: dict | None = None,
                      tries: int = 3, wait: float = 0.6) -> dict:
        """Sends a call and waits for its answer, resending: UDP on Wi-Fi loses packets."""
        loop = asyncio.get_running_loop()
        for _ in range(tries):
            fut = loop.create_future()
            self._waiting.setdefault((ip, method), []).append(fut)
            self._send(ip, method, params)
            try:
                msg = await asyncio.wait_for(fut, wait)
            except asyncio.TimeoutError:
                continue
            if "error" in msg:
                raise WizError(f"{ip} {method}: {msg['error'].get('message', msg['error'])}")
            return msg.get("result", {})
        raise WizError(f"No answer from the light at {ip}")

    # ---------- discovery ----------

    async def discover(self, wait: float = 1.5, extra: list[str] = ()) -> list[Light]:
        """Broadcasts getPilot (and asks `extra` addresses directly), then learns each
        light that answered. Lights that did not answer keep their last known address."""
        self._scan = []
        try:
            for _ in range(3):
                for target in [*self.broadcast, *extra]:
                    try:
                        self._send(target, "getPilot")
                    except OSError as e:
                        log.debug("broadcast to %s failed: %s", target, e)
                await asyncio.sleep(wait / 3)
            answers, self._scan = self._scan, None
        finally:
            self._scan = None
        found: dict[str, Light] = {}
        for ip, msg in answers:
            mac = (msg.get("result") or {}).get("mac", "").lower()
            if mac and mac not in found:
                found[mac] = await self._learn(mac, ip, msg.get("result") or {})
        return list(found.values())

    async def _learn(self, mac: str, ip: str, pilot: dict) -> Light:
        light = self.lights.get(mac)
        if light is None:
            light = Light(mac=mac, ip=ip)
            try:
                cfg = await self.request(ip, "getSystemConfig")
                light.module = cfg.get("moduleName", "")
                light.firmware = cfg.get("fwVersion", "")
                light.capabilities = capabilities_of(light.module)
            except WizError as e:
                log.info("%s: %s", mac, e)
            try:
                model = await self.request(ip, "getModelConfig", tries=1)
                cct = model.get("cctRange") or []
                if len(cct) >= 2:
                    light.kelvin = (int(min(cct)), int(max(cct)))
            except WizError:
                if "color" in light.capabilities:
                    light.kelvin = (2200, 6500)
            self.lights[mac] = light
            log.info("found %s at %s (%s)", mac, ip, light.module or "unknown module")
        elif light.ip != ip:
            log.info("%s moved from %s to %s", mac, light.ip, ip)
            light.ip = ip
        light.online, light.seen, light.state = True, time.time(), reading(pilot)
        return light

    # ---------- state ----------

    async def read(self, mac: str) -> dict:
        light = self.lights[mac]
        try:
            pilot = await self.request(light.ip, "getPilot", tries=2, wait=0.8)
        except WizError:
            light.online = False
            raise
        light.online, light.seen, light.state = True, time.time(), reading(pilot)
        return light.state

    async def send(self, mac: str, patch: dict, state: dict) -> None:
        light = self.lights.get(mac)
        if light is None:
            raise WizError(f"The light {mac} has not been found on the network")
        params = pilot_params(patch, state, light)
        if not params:
            return
        await self.request(light.ip, "setPilot", params)
        light.state.update({k: v for k, v in patch.items() if k in ("on", "brightness", "temp", "color")})


class WizError(Exception):
    pass
