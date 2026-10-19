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

Cielo only issues those keys for its newer thermostats and Breez Edge Pro/Max, so an
older Breez (like the MRCOOL SmartHVAC controller) is refused. Those still answer the
account Alexa and Google Home use. mrcool.json then holds the MRCOOL app email and
password, or a session already signed in ({"access_token", "refresh_token",
"session_id", "user_id", "x_api_key"}). Devices are read over HTTPS and changes are
sent over the websocket. The access token is refreshed through the mobile app's
/user/token/refresh (the old /web/token/refresh path now returns 403 for everyone);
a stored password signs in again when that refresh token is rejected.

The controller is infrared: Cielo keeps what it last told the AC and sends a whole state
each time, so a change is the current state with one field replaced.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path

import aiohttp
from yarl import URL

log = logging.getLogger("house.mrcool")

BASE_URL = os.environ.get("HOUSE_HUB_CIELO_URL", "https://api.smartcielo.com/openapi/v1")
WEB_BASE_URL = os.environ.get("HOUSE_HUB_CIELO_WEB_URL", "https://api.smartcielo.com")
WEB_WSS_URL = os.environ.get("HOUSE_HUB_CIELO_WSS_URL", "wss://wss.smartcielo.com/websocket/")
# Public keys baked into Cielo's own apps. The web key is what /web/* expects;
# the iOS key is what login and token refresh expect. Neither is an account secret.
WEB_X_API_KEY = "3iCWYuBqpY2g7yRq3yyTk1XCS4CMjt1n9ECCjdpd"
IOS_X_API_KEY = "T90bwfODtWaIUreVJtroN3itKWquNnUGRYiYUsf0"
IOS_USER_AGENT = "MRCOOL SmartHVAC/4.3.0 (com.smarthvac; build:2; iOS 26.5.0) Alamofire/5.9.1"

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
        self.web_devices: dict[str, dict] = {}  # mac -> the device as the web API describes it
        self._web_expires = float(self._stored().get("expires_at") or 0)  # when the web access token stops working
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
    def web_tokens(self) -> dict:
        stored = self._stored()
        return {k: stored.get(k) for k in
                ("access_token", "refresh_token", "session_id", "user_id", "x_api_key")
                if stored.get(k)}

    @property
    def account(self) -> bool:
        stored = self._stored()
        return bool(str(stored.get("email") or "").strip() and stored.get("password"))

    @property
    def configured(self) -> bool:
        return bool(self.api_key) or len(self.web_tokens) == 5 or self.account

    def save_key(self, key: str) -> None:
        self.token = None
        self._store(api_key=key.strip(), token=None)

    def save_web_tokens(self, tokens: dict) -> None:
        keep = {k: str(tokens[k]).strip() for k in
                ("access_token", "refresh_token", "session_id", "user_id", "x_api_key")
                if tokens.get(k)}
        if len(keep) != 5:
            raise MrcoolError("Give the access_token, refresh_token, session_id, user_id "
                              "and x_api_key from a Cielo portal sign-in")
        self._store(**keep)

    async def login(self, email: str, password: str) -> None:
        """Signs in with the MRCOOL app email and password and keeps both."""
        email = email.strip()
        if not email or not password:
            raise MrcoolError("Give the email and password of the MRCOOL app")
        self._store(email=email, password=password)
        if not await self._login_stored():
            raise MrcoolError("Cielo refused that MRCOOL sign-in")

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
        """Reads every device on the account, over the Open API when a key is saved,
        otherwise over the web API. Cielo is rate limited: call this every minute or
        two, and after a change use the state the action returned instead."""
        if not self.api_key:
            return await self._refresh_web()
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

    # ---------- web API (Alexa/Google path, for devices with no Open API key) ----------

    def _web_headers(self) -> dict:
        tokens = self.web_tokens
        return {"authorization": tokens.get("access_token", ""),
                "x-api-key": tokens.get("x_api_key", ""),
                "referer": "https://home.cielowigle.com/",
                "origin": "https://home.cielowigle.com"}

    @staticmethod
    def _tz_offset() -> str:
        off = datetime.now().astimezone().utcoffset() or timedelta(0)
        minutes = int(off.total_seconds() // 60)
        sign = "+" if minutes >= 0 else "-"
        minutes = abs(minutes)
        return f"{sign}{minutes // 60:02d}:{minutes % 60:02d}"

    def _remember_session(self, access: str, refresh: str, session: str, user_id: str, expires) -> None:
        if expires in (None, ""):
            self._web_expires = time.time() + 3300
        else:
            expires = float(expires)
            self._web_expires = expires if expires > 1_000_000_000 else time.time() + expires
        self._store(access_token=access, refresh_token=refresh, session_id=session,
                    user_id=str(user_id), x_api_key=self._stored().get("x_api_key") or WEB_X_API_KEY,
                    expires_at=self._web_expires)

    async def _login_stored(self) -> bool:
        """Signs in through the MRCOOL app's endpoint, which has no captcha."""
        stored = self._stored()
        email = str(stored.get("email") or "").strip()
        password = stored.get("password") or ""
        if not email or not password:
            return False
        payload = {"user": {
            "isDeviceCountRequired": 1, "isSmartHVAC": 1, "ipAddress": "",
            "deviceTokenId": "N/A", "mobileDeviceId": uuid.uuid4().hex[:8].upper(),
            "deviceType": "iPhone17,1", "appType": "iOS", "userId": email,
            "password": hashlib.sha256(password.encode()).hexdigest(),
            "timeZone": self._tz_offset(), "mobileDeviceName": "iPhone",
            "locale": "en", "appVersion": "4.3.0",
        }}
        headers = {"accept": "*/*", "content-type": "application/json",
                   "x-api-key": IOS_X_API_KEY, "user-agent": IOS_USER_AGENT}
        async with self.http.post(WEB_BASE_URL + "/user/smarthvac/login/1", json=payload, headers=headers,
                                  timeout=aiohttp.ClientTimeout(total=30)) as resp:
            result = await resp.json(content_type=None)
            if resp.status != 200 or (result or {}).get("status") not in (200, "200"):
                log.warning("MRCOOL sign-in refused (HTTP %s)", resp.status)
                return False
        user = ((result or {}).get("data") or {}).get("user") or {}
        if not user.get("accessToken") or not user.get("refreshToken"):
            return False
        session = user.get("sessionId") or f"hub-{int(time.time() * 1000)}"
        self._remember_session(user["accessToken"], user["refreshToken"], session,
                               user.get("userId") or "", user.get("expiresIn"))
        return True

    async def _web_refresh_tokens(self) -> None:
        # /web/token/refresh is rejected at Cielo's edge (HTTP 403) even with a
        # live token. The mobile app refreshes at /user/token/refresh instead.
        tokens = self.web_tokens
        headers = {"accept": "*/*", "content-type": "application/json",
                   "x-api-key": IOS_X_API_KEY, "user-agent": IOS_USER_AGENT,
                   "authorization": tokens.get("access_token", "")}
        async with self.http.post(WEB_BASE_URL + "/user/token/refresh",
                                  json={"refreshToken": tokens.get("refresh_token", "")},
                                  headers=headers,
                                  timeout=aiohttp.ClientTimeout(total=30)) as resp:
            result = await resp.json(content_type=None)
            if resp.status != 200 or (result or {}).get("status") not in (200, "200"):
                raise MrcoolError(f"Cielo web sign-in expired (HTTP {resp.status}): see hub/README.md")
        data = (result or {}).get("data") or {}
        if not data.get("accessToken"):
            raise MrcoolError("Cielo web sign-in expired: see hub/README.md")
        self._remember_session(data["accessToken"],
                               data.get("refreshToken") or tokens.get("refresh_token", ""),
                               tokens.get("session_id", ""), tokens.get("user_id", ""),
                               data.get("expiresIn"))

    async def _ensure_web_session(self) -> None:
        if len(self.web_tokens) < 5:
            if await self._login_stored():
                return
            raise MrcoolError("No Cielo sign-in yet: see hub/README.md")
        if time.time() < self._web_expires - 300:
            return
        try:
            await self._web_refresh_tokens()
        except MrcoolError:
            if not await self._login_stored():
                raise

    async def _refresh_web(self) -> dict[str, dict]:
        await self._ensure_web_session()
        refreshed = False
        for attempt in range(3):
            async with self.http.get(WEB_BASE_URL + "/web/devices?limit=420",
                                     headers=self._web_headers(),
                                     timeout=aiohttp.ClientTimeout(total=30)) as resp:
                if resp.status == 498 and attempt == 0:
                    await asyncio.sleep(1)  # a just-refreshed token can lag a moment
                    continue
                if resp.status in (401, 403, 498) and not refreshed:
                    try:
                        await self._web_refresh_tokens()
                    except MrcoolError:
                        if not await self._login_stored():
                            raise
                    refreshed = True
                    continue
                if resp.status != 200:
                    raise MrcoolError(f"Cielo web API answered HTTP {resp.status}")
                result = await resp.json(content_type=None)
            break
        else:
            raise MrcoolError("Cielo web API did not return the devices")
        devices = ((result or {}).get("data") or {}).get("listDevices") or []
        found: dict[str, dict] = {}
        self.web_devices = {}
        for raw in devices:
            mac = (raw.get("macAddress") or "").lower()
            if not mac:
                continue
            self.web_devices[mac] = raw
            action = raw.get("latestAction") or {}
            unit = "F" if raw.get("isFaren") in (1, "1", True) else "C"
            found[mac] = {
                "mac_address": raw.get("macAddress"), "device_name": raw.get("deviceName") or mac,
                "device_type": raw.get("deviceType", ""), "temperature_unit": unit,
                "connection_status": {"is_alive": raw.get("deviceStatus") in (1, "1", "on", True)},
                "sensor_readings": {"temperature": (raw.get("latEnv") or {}).get("temp")},
                "current_state": {"power": action.get("power"), "mode": action.get("mode"),
                                  "set_point": action.get("temp"), "fan_speed": action.get("fanspeed"),
                                  "swing_position": action.get("swing")},
                "supported_features": {"modes": {
                    m: {"fan_levels": ["auto", "low", "medium", "high"],
                        "swing": ["auto", "pos1", "pos2", "pos3", "adjust"],
                        "temperatures": {unit: {"values": list(range(61, 87)) if unit == "F" else list(range(16, 31))}}}
                    for m in PANEL_MODES}},
            }
        self.devices, self.updated = found, time.time()
        return found

    async def _send_web(self, mac: str, patch: dict) -> None:
        if mac not in self.web_devices:
            await self._refresh_web()
        raw = self.web_devices.get(mac)
        if raw is None:
            raise MrcoolError(f"The AC {mac} is not on this Cielo account")
        action = raw.get("latestAction") or {}
        current = {"power": action.get("power") or "off", "mode": action.get("mode") or "cool",
                   "fanspeed": action.get("fanspeed") or "auto", "temp": str(action.get("temp") or ""),
                   "swing": action.get("swing") or "auto", "swinginternal": ""}
        for extra in ("turbo", "light", "followme"):
            if action.get(extra) not in (None, ""):
                current[extra] = action[extra]
        steps: list[tuple[str, str]] = []
        if patch.get("on") is not None:
            steps.append(("power", "on" if patch["on"] else "off"))
        if patch.get("on") is False:
            steps = steps[:1]
        else:
            if current["power"] != "on" and any(k in patch for k in ("mode", "target", "fan", "swing")):
                steps.append(("power", "on"))
            if patch.get("mode") in PANEL_MODES:
                steps.append(("mode", patch["mode"]))
            if "target" in patch:
                steps.append(("temp", str(int(round(float(patch["target"]))))))
            if patch.get("fan"):
                steps.append(("fanspeed", patch["fan"]))
            if patch.get("swing"):
                swing = SWING_TO_CIELO.get(patch["swing"])
                if swing:
                    steps.append(("swing", swing))
        if not steps:
            return
        tokens = self.web_tokens
        url = str(URL(WEB_WSS_URL).with_query({"sessionId": tokens.get("session_id", ""),
                                                "token": tokens.get("access_token", "")}))
        try:
            async with self.http.ws_connect(url, headers={"Origin": "https://home.cielowigle.com"},
                                            timeout=aiohttp.ClientTimeout(total=30)) as ws:
                for action_type, value in steps:
                    old_power = current["power"]
                    current[action_type] = value
                    message = {
                        "action": "actionControl", "actionSource": "WEB",
                        "macAddress": raw.get("macAddress"), "user_id": tokens.get("user_id", ""),
                        "fw_version": raw.get("fwVersion", ""), "deviceTypeVersion": raw.get("deviceTypeVersion", ""),
                        "mid": "WEB", "connection_source": raw.get("connectionSource", 1),
                        "application_version": "1.4.4", "ts": int(time.time()),
                        "fwVersion": raw.get("fwVersion", ""), "applianceType": raw.get("applianceType", ""),
                        "applianceId": raw.get("applianceId"), "myRuleConfiguration": raw.get("myRuleConfiguration") or {},
                        "preset": 0, "actions": dict(current), "oldPower": old_power,
                        "actionType": action_type, "actionValue": value,
                    }
                    await ws.send_json(message)
                    await self._await_ack(ws, raw.get("macAddress") or mac)
        except MrcoolError:
            raise
        except (aiohttp.ClientError, asyncio.TimeoutError) as e:
            raise MrcoolError(f"Cielo web control failed: {e}") from e
        action.update(current)
        raw["latestAction"] = action
        if mac in self.devices:
            self.devices[mac]["current_state"] = {
                "power": current["power"], "mode": current["mode"], "set_point": current["temp"],
                "fan_speed": current["fanspeed"], "swing_position": current["swing"]}

    @staticmethod
    async def _await_ack(ws, mac: str) -> None:
        async def wait():
            async for msg in ws:
                if msg.type != aiohttp.WSMsgType.TEXT:
                    continue
                try:
                    body = json.loads(msg.data)
                except ValueError:
                    continue
                got = body.get("mac_address") or body.get("macAddress")
                if got and got.lower() == mac.lower() and \
                        body.get("message_type") in ("StateUpdate", "DeviceSettingsAck"):
                    return
            raise MrcoolError("Cielo closed the connection before confirming the change")
        try:
            await asyncio.wait_for(wait(), timeout=15)
        except asyncio.TimeoutError as e:
            raise MrcoolError("Cielo did not confirm the change in time") from e

    async def send(self, mac: str, patch: dict) -> None:
        """Applies a change made in the panel: one Cielo action per field, power first,
        then mode (which decides the fan speeds and range), then the rest."""
        if not self.api_key:
            return await self._send_web(mac, patch)
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
