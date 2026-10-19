"""MRCOOL SmartHVAC air conditioners, through Cielo's cloud.

MRCOOL's SmartHVAC controller is a Cielo Breez inside (the MRCOOL app's "About Device"
says BREEZ-I), and it is reached through Cielo's Open API, the one the official Home
Assistant integration uses:

  POST /openapi/v1/authenticate   x-api-key: <key>          -> data.access_token
  GET  /openapi/v1/devices/        + Authorization: <token>  -> every device and its state
  POST /openapi/v1/action          {mac_address, action_type, actions}

The key is made once in Cielo's web portal (home.cielowigle.com, signed in with the same
email as the MRCOOL app): Home Assistant section, Generate API key. It goes in
~/.house-hub/mrcool.json as {"api_key": "…"} and never leaves this Mac except to Cielo.

The controller is infrared: Cielo keeps what it last told the AC and sends a whole state
each time, so a change is the current state with one field replaced.
"""
from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path

import aiohttp

log = logging.getLogger("house.mrcool")

BASE_URL = os.environ.get("HOUSE_HUB_CIELO_URL", "https://api.smartcielo.com/openapi/v1")

# The panel's vocabulary (store.js) ⇄ Cielo's.
PANEL_MODES = ["cool", "heat", "dry", "fan", "auto"]
PANEL_FANS = ["auto", "low", "medium", "high", "turbo"]
SWING_TO_CIELO = {"swing": "auto", "l1": "pos1", "l2": "pos2", "l3": "pos3", "l4": "pos4", "l5": "pos5", "off": "auto/stop"}


def panel_fan(name: str) -> str | None:
    n = name.lower()
    if any(w in n for w in ("turbo", "max", "strong", "highest", "powerful")):
        return "turbo"
    if "high" in n:
        return "high"
    if "med" in n or "mid" in n:
        return "medium"
    if "low" in n or "quiet" in n:
        return "low"
    if "auto" in n:
        return "auto"
    return None


def panel_swing(position: str) -> str:
    p = (position or "").lower()
    for panel, cielo in SWING_TO_CIELO.items():
        if p == cielo:
            return panel
    return "off" if p in ("adjust", "auto/stop", "stop") else "swing"


class MrcoolError(Exception):
    pass


class MrcoolClient:
    def __init__(self, secret: Path, session: aiohttp.ClientSession):
        self.secret = secret
        self.http = session
        # Kept with the key: Cielo hands out few keys, so signing in again is the exception.
        self.token: str | None = self._stored().get("token")
        self.devices: dict[str, dict] = {}  # mac -> the device as Cielo last described it
        self.updated = 0.0

    def _stored(self) -> dict:
        try:
            return json.loads(self.secret.read_text())
        except (OSError, ValueError):
            return {}

    def _store(self, **values) -> None:
        self.secret.parent.mkdir(parents=True, exist_ok=True)
        self.secret.write_text(json.dumps({**self._stored(), **values}))
        self.secret.chmod(0o600)

    @property
    def api_key(self) -> str | None:
        return self._stored().get("api_key") or None

    @property
    def configured(self) -> bool:
        return bool(self.api_key)

    def save_key(self, key: str) -> None:
        self.token = None
        self._store(api_key=key.strip(), token=None)

    # ---------- HTTP ----------

    async def _call(self, method: str, path: str, body: dict | None = None, auth: bool = True) -> dict:
        key = self.api_key
        if not key:
            raise MrcoolError("No Cielo API key yet: see hub/README.md")
        for attempt in range(2):
            if auth and not self.token:
                await self._login()
            headers = {"x-api-key": key}
            if auth:
                headers["Authorization"] = self.token or ""
            async with self.http.request(method, BASE_URL + path, json=body, headers=headers,
                                         timeout=aiohttp.ClientTimeout(total=30)) as resp:
                if resp.status in (401, 403) and auth and attempt == 0:
                    self.token = None  # expired: sign in again once
                    continue
                if resp.status in (401, 403):
                    raise MrcoolError("Cielo refused the API key (it may have been revoked)")
                if resp.status != 200:
                    raise MrcoolError(f"Cielo answered HTTP {resp.status}: {(await resp.text())[:200]}")
                return await resp.json(content_type=None)
        raise MrcoolError("Cielo sign-in failed")

    async def _login(self) -> None:
        result = await self._call("POST", "/authenticate", auth=False)
        try:
            self.token = result["data"]["access_token"]
        except (KeyError, TypeError) as e:
            raise MrcoolError("Unexpected answer from Cielo's sign-in") from e
        self._store(token=self.token)

    # ---------- devices ----------

    async def refresh(self) -> dict[str, dict]:
        """Reads every device on the account. Cielo is rate limited: call this every
        minute or two, and after a change use the state the action returned instead."""
        result = await self._call("GET", "/devices/?cached_appliance_ids=[]")
        found: dict[str, dict] = {}
        payload = (result or {}).get("data", {})
        groups = payload.values() if isinstance(payload, dict) else [payload]
        for group in groups:
            if isinstance(group, dict):  # sometimes one level deeper
                group = [x for v in group.values() if isinstance(v, list) for x in v]
            for d in group if isinstance(group, list) else []:
                if isinstance(d, dict) and d.get("mac_address"):
                    found[d["mac_address"].lower()] = d
        self.devices, self.updated = found, time.time()
        return found

    def describe(self, mac: str) -> dict:
        d = self.devices[mac]
        unit = (d.get("temperature_unit") or "F").upper()
        temps = self._mode_caps(d).get("temperatures", {}).get(unit, {}).get("values") or []
        lo, hi = (min(temps), max(temps)) if temps else ((61, 86) if unit == "F" else (16, 30))
        return {
            "id": mac, "name": d.get("device_name") or mac, "unit": unit, "min": lo, "max": hi,
            "online": bool((d.get("connection_status") or {}).get("is_alive", True)),
            "type": d.get("device_type", ""),
        }

    @staticmethod
    def _mode_caps(d: dict, mode: str | None = None) -> dict:
        modes = (d.get("supported_features") or {}).get("modes") or {}
        mode = mode or (d.get("current_state") or {}).get("mode") or "cool"
        return modes.get("heat" if mode == "aux" else mode) or next(iter(modes.values()), {}) or {}

    def reading(self, mac: str) -> dict:
        """The AC in the panel's terms, plus what it can do (`features`)."""
        d = self.devices[mac]
        s = d.get("current_state") or {}
        caps = self._mode_caps(d)
        fans = caps.get("fan_levels") or []
        if fans and isinstance(fans[0], list):
            fans = fans[0]
        swings = caps.get("swing") or []
        if swings and isinstance(swings[0], list):
            swings = swings[0]
        mode = "heat" if s.get("mode") == "aux" else s.get("mode")
        ac: dict = {"on": str(s.get("power", "")).lower() == "on"}
        if mode in PANEL_MODES:
            ac["mode"] = mode
        if s.get("set_point") not in (None, ""):
            ac["target"] = round(float(s["set_point"]))
        fan = panel_fan(str(s.get("fan_speed") or ""))
        if fan:
            ac["fan"] = fan
        if swings:
            ac["swing"] = panel_swing(str(s.get("swing_position") or ""))
        room = (d.get("sensor_readings") or {}).get("temperature")
        if room not in (None, ""):
            ac["roomTemp"] = float(room)
        modes = (d.get("supported_features") or {}).get("modes") or {}
        features = {
            "modes": [m for m in PANEL_MODES if m in modes or (m == "heat" and "aux" in modes)],
            "fans": [f for f in PANEL_FANS if any(panel_fan(str(x)) == f for x in fans)],
            "swing": len(swings) > 1,
            "sleep": False,
            "eco": False,
        }
        return {"ac": ac, "features": features, "online": self.describe(mac)["online"]}

    def _cielo_fan(self, d: dict, mode: str, panel: str) -> str | None:
        fans = self._mode_caps(d, mode).get("fan_levels") or []
        if fans and isinstance(fans[0], list):
            fans = fans[0]
        return next((str(f) for f in fans if panel_fan(str(f)) == panel), None)

    def _cielo_swing(self, d: dict, mode: str, panel: str) -> str | None:
        swings = self._mode_caps(d, mode).get("swing") or []
        if swings and isinstance(swings[0], list):
            swings = swings[0]
        wanted = SWING_TO_CIELO.get(panel)
        by_lower = {str(s).lower(): str(s) for s in swings}
        for name in (wanted, "adjust" if panel == "off" else None):
            if name and name in by_lower:
                return by_lower[name]
        return None

    async def send(self, mac: str, patch: dict) -> None:
        """Applies a change made in the panel: one Cielo action per field, power first,
        then mode (which decides the fan speeds and range), then the rest."""
        if mac not in self.devices:
            await self.refresh()
        if mac not in self.devices:
            raise MrcoolError(f"The AC {mac} is not on this Cielo account")
        d = self.devices[mac]
        steps: list[tuple[str, object]] = []
        on = patch.get("on")
        if on is not None:
            steps.append(("power", "on" if on else "off"))
        if on is False:
            steps = steps[:1]
        else:
            if patch.get("mode") in PANEL_MODES:
                steps.append(("mode", patch["mode"]))
            mode = patch.get("mode") or (d.get("current_state") or {}).get("mode") or "cool"
            if "target" in patch:
                steps.append(("set_point", int(round(float(patch["target"])))))
            if patch.get("fan"):
                fan = self._cielo_fan(d, mode, patch["fan"])
                if not fan:
                    raise MrcoolError(f"This AC has no {patch['fan']} fan speed in {mode} mode")
                steps.append(("fan_speed", fan))
            if patch.get("swing"):
                swing = self._cielo_swing(d, mode, patch["swing"])
                if swing:
                    steps.append(("swing_position", swing))
        for action_type, value in steps:
            actions = dict(d.get("current_state") or {})
            actions[action_type] = value
            result = await self._call("POST", "/action", {
                "mac_address": d["mac_address"], "action_type": action_type, "actions": actions,
            })
            state = (result or {}).get("data")
            if isinstance(state, dict) and state:
                d["current_state"] = state
            else:
                d["current_state"] = actions
