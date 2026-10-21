"""The weather at the house, for the panel's sky (docs/landscape-weather.md).

Read from Open-Meteo (no key) every 10 minutes while the plan has a `site` with a latitude and
longitude, and kept normalised for the screens: GET /api/weather, and a `weather` event on
/api/events whenever it changes. A failed read keeps the last good one and tries again in 2
minutes; a reading over 40 minutes old is sent as `stale`.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Callable

import aiohttp

log = logging.getLogger("house.weather")

URL = "https://api.open-meteo.com/v1/forecast"
CURRENT = ("temperature_2m,weather_code,cloud_cover,precipitation,rain,showers,snowfall,"
           "wind_speed_10m,wind_direction_10m,is_day,visibility,snow_depth")
EVERY = 600.0        # seconds between reads
RETRY = 120.0        # after a failed read
STALE = 40 * 60.0    # a reading older than this is marked stale
TIMEOUT = aiohttp.ClientTimeout(total=10)
NO_SITE = 60.0       # how often a hub without a site looks again (the plan may get one)


def site_of(plan) -> dict | None:
    """The plan's `site` when it has a usable latitude and longitude, else None."""
    site = plan.get("site") if isinstance(plan, dict) else None
    if not isinstance(site, dict):
        return None
    lat, lon = site.get("lat"), site.get("lon")
    if not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in (lat, lon)):
        return None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    return {"lat": float(lat), "lon": float(lon)}


def kind_of(code) -> str:
    """The look a WMO weather code asks for."""
    if not isinstance(code, int):
        return "partly"
    if code == 0:
        return "clear"
    if code in (1, 2):
        return "partly"
    if code == 3:
        return "overcast"
    if code in (45, 48):
        return "fog"
    if 51 <= code <= 57:
        return "drizzle"
    if 61 <= code <= 67 or 80 <= code <= 82:
        return "rain"
    if 71 <= code <= 77 or code in (85, 86):
        return "snow"
    if 95 <= code <= 99:
        return "storm"
    return "partly"


def _num(v, default: float = 0.0) -> float:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else default


def _iso(local: str | None, offset: int) -> str | None:
    """Open-Meteo's local time ("2026-10-21T14:15", timezone=auto) with its UTC offset."""
    if not isinstance(local, str):
        return None
    try:
        t = datetime.fromisoformat(local)
    except ValueError:
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone(timedelta(seconds=offset)))
    return t.isoformat()


def normalise(data: dict) -> dict:
    """An Open-Meteo forecast answer as the panel's reading (without `stale`).

    `precipitation` and `snowfall` are sums over the reading's interval (15 minutes for
    `current`), turned into rates: mm/h and cm/h."""
    cur = data.get("current") or {}
    daily = data.get("daily") or {}
    offset = int(_num(data.get("utc_offset_seconds")))
    interval = _num(cur.get("interval"), 900.0) or 900.0
    per_hour = 3600.0 / interval
    code = cur.get("weather_code")
    code = int(code) if isinstance(code, (int, float)) and not isinstance(code, bool) else None
    first = lambda key: (daily.get(key) or [None])[0]  # noqa: E731
    return {
        "at": _iso(cur.get("time"), offset),
        "code": code,
        "kind": kind_of(code),
        "cloud": round(min(100.0, max(0.0, _num(cur.get("cloud_cover"))))),
        "precip": round(max(0.0, _num(cur.get("precipitation"))) * per_hour, 2),
        "snow": round(max(0.0, _num(cur.get("snowfall"))) * per_hour, 2),
        "wind": round(max(0.0, _num(cur.get("wind_speed_10m"))), 1),
        "windDir": round(_num(cur.get("wind_direction_10m")) % 360),
        "temp": round(_num(cur.get("temperature_2m")), 1),
        "isDay": bool(_num(cur.get("is_day"))),
        "visibility": round(max(0.0, _num(cur.get("visibility"), 24000.0))),
        "snowDepth": round(max(0.0, _num(cur.get("snow_depth"))), 3),
        "sunrise": _iso(first("sunrise"), offset),
        "sunset": _iso(first("sunset"), offset),
    }


class Weather:
    """Reads the weather for the plan's site; `publish(message)` tells the open panels."""

    def __init__(self, plan: Callable[[], dict], publish: Callable[[dict], None]):
        self._plan = plan
        self._publish = publish
        self.http: aiohttp.ClientSession | None = None
        self.last: dict | None = None    # the last good reading
        self._read_at = 0.0               # when it was read (time.time())
        self._where: dict | None = None   # the site it was read for
        self._wake = asyncio.Event()

    def current(self) -> dict:
        """The last reading with `stale`, or {"kind": None} before the first one."""
        if self.last is None:
            return {"kind": None}
        return {**self.last, "stale": time.time() - self._read_at > STALE}

    def site_changed(self) -> None:
        """The plan changed: a new or moved site is read now (a removed one is forgotten)."""
        if site_of(self._plan()) != self._where:
            self._wake.set()

    async def read(self) -> bool:
        """One read for the site the plan has now; whether it gave a reading."""
        site = site_of(self._plan())
        if site is None:
            if self.last is not None:
                self.last, self._where = None, None
            return False
        if self.http is None:
            return False
        params = {"latitude": f"{site['lat']:.4f}", "longitude": f"{site['lon']:.4f}", "current": CURRENT,
                  "daily": "sunrise,sunset", "timezone": "auto", "forecast_days": "1"}
        try:
            async with self.http.get(URL, params=params, timeout=TIMEOUT) as r:
                if r.status != 200:
                    raise aiohttp.ClientError(f"HTTP {r.status}")
                data = await r.json(content_type=None)
            if not isinstance(data, dict) or not isinstance(data.get("current"), dict):
                raise ValueError("no current weather in the answer")
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError, ValueError) as e:
            log.warning("Open-Meteo: %s", str(e) or e.__class__.__name__)
            return False
        reading = normalise(data)
        before = self.current()
        self.last, self._read_at, self._where = reading, time.time(), site
        # Only news is sent: the same weather read again (or a stale one refreshed) is not.
        if {k: v for k, v in before.items() if k not in ("at", "stale")} != \
                {k: v for k, v in reading.items() if k != "at"} or before.get("stale"):
            self._publish({"weather": self.current()})
        return True

    async def run(self) -> None:
        """Reads at start and every 10 minutes (2 after a failure), for as long as the hub runs."""
        while True:
            self._wake.clear()
            if site_of(self._plan()) is None:
                await self.read()  # forgets a reading for a site the plan no longer has
                wait = NO_SITE
            else:
                try:
                    wait = EVERY if await self.read() else RETRY
                except Exception:
                    log.exception("Reading the weather failed")
                    wait = RETRY
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self._wake.wait(), wait)
