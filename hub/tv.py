"""The TV, through tv-remote: a separate service on the Mac (~/tv-remote, LaunchAgent
local.tvremote, port 8765) that keeps an Android TV Remote connection to the Google TV.

  GET  /api/devices                 every TV, with isOn, currentApp and volume pushed live by the TV
  POST /api/devices/{id}/action     {"action": …} -> {"ok": true} or {"error": …}

The hub reads it every 2 s while a panel is watching (10 s otherwise), tells the panels what
changed as `{"tv": …}` on /api/events, and passes the panel's remote keys on, only the ones
listed here. App links from the streaming catalog (JustWatch) are checked against the app
before the TV is asked to open them. What is playing comes from the TV itself, over Cast
(nowplaying.py), and seeking goes the same way. Where tv-remote is: HOUSE_TV_URL, else
~/.house-hub/tv.json {"url": …}, else this Mac's LAN address, port 8765 (127.0.0.1:8765 is
another app on Riley's Mac).
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Callable
from urllib.parse import parse_qs, urlsplit

import aiohttp

import nowplaying
from nowplaying import Adb, cast_link

log = logging.getLogger("house.tv")

TV_PORT = 8765
POLL_WATCHED = 2.0    # seconds between reads while a panel is open
POLL_IDLE = 10.0
POLL_BURST = 0.7      # right after a command, until the TV has caught up
POLL_PLAYING = 1.0    # while a panel is open and something plays
SEEK_SETTLE = 3.0     # how long a seek's position stands before the TV's own reports take over
WAKE_WAIT = 6.0       # how long an app launch waits for a sleeping TV
SEARCH_TTL = 300.0
UNREACHABLE = "The TV remote service on the Mac isn't answering."

# name: (Android package, web hosts its links live on, JustWatch package names). From ~/tv-remote/catalog.py.
APPS = {
    "YouTube": ("com.google.android.youtube.tv", ("youtube.com", "youtu.be"), ("youtube", "youtubefree", "youtubepremium")),
    "Netflix": ("com.netflix.ninja", ("netflix.com",), ("netflix", "netflixbasicwithads")),
    "Prime Video": ("com.amazon.amazonvideo.livingroom", ("primevideo.com", "amazon.com", "watch.amazon.com"), ("amazonprime", "amazonprimevideowithads", "amazon")),
    "Disney+": ("com.disney.disneyplus", ("disneyplus.com",), ("disneyplus",)),
    "Hulu": ("com.hulu.livingroomplus", ("hulu.com",), ("hulu",)),
    "Max": ("com.wbd.stream", ("max.com", "hbomax.com"), ("max", "hbomax")),
    "Peacock": ("com.peacocktv.peacockandroid", ("peacocktv.com",), ("peacock", "peacockpremium", "peacockpremiumplus")),
    "Paramount+": ("com.cbs.ott", ("paramountplus.com",), ("paramountplus", "paramountplusessential", "paramountpluspremium")),
    "Apple TV": ("com.apple.atve.androidtv.appletv", ("tv.apple.com",), ("appletvplus", "itunes")),
    "Tubi": ("com.tubitv", ("tubitv.com",), ("tubitv",)),
    "Pluto TV": ("tv.pluto.android", ("pluto.tv",), ("plutotv",)),
    "Plex": ("com.plexapp.android", ("plex.tv",), ("plex",)),
    "Crunchyroll": ("com.crunchyroll.crunchyroid", ("crunchyroll.com",), ("crunchyroll",)),
}
# The panel's names for them (web/src/tv/apps.js).
APP_IDS = {
    "YouTube": "youtube", "Netflix": "netflix", "Prime Video": "prime", "Disney+": "disney", "Hulu": "hulu",
    "Max": "max", "Peacock": "peacock", "Paramount+": "paramount", "Apple TV": "appletv", "Tubi": "tubi",
    "Pluto TV": "pluto", "Plex": "plex", "Crunchyroll": "crunchyroll",
}
APP_NAMES = {v: k for k, v in APP_IDS.items()}
BY_PACKAGE = {pkg: name for name, (pkg, _, _) in APPS.items()}
BY_JUSTWATCH = {tech: name for name, (_, _, techs) in APPS.items() for tech in techs}
SYSTEM = {
    "com.google.android.apps.tv.launcherx": ("home", "Google TV"),
    "com.google.android.tvrecommendations": ("home", "Google TV"),
    "com.google.android.tvlauncher": ("home", "Google TV"),
    "com.google.android.backdrop": ("ambient", "Ambient"),
    "com.android.tv.settings": ("settings", "Settings"),
}
# Remote keys passed on as they are; volume, text, search, open and play (a title) are checked on their own.
KEYS = {"up", "down", "left", "right", "ok", "back", "home", "menu", "playpause", "play", "pause", "rewind",
        "forward", "volup", "voldown", "mute", "chup", "chdown", "input", "power", "wake", "sleep"}

INCLUDED = {"FLATRATE": "subscription", "FREE": "free", "ADS": "free with ads"}
PAID = {"RENT": "rent", "BUY": "buy"}
JUSTWATCH_URL = "https://apis.justwatch.com/graphql"
POSTER_BASE = "https://images.justwatch.com"
QUERY = """query Search($filter: TitleFilter!, $country: Country!, $language: Language!, $first: Int!) {
  popularTitles(country: $country, filter: $filter, first: $first) { edges { node {
    objectType
    content(country: $country, language: $language) { title originalReleaseYear fullPath shortDescription posterUrl }
    offers(country: $country, platform: WEB) {
      monetizationType standardWebURL tvLink: deeplinkURL(platform: ANDROID_TV)
      package { clearName technicalName } } } } } }"""


# ---------- app links ----------

_YT_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
_YT_LIST = re.compile(r"^[A-Za-z0-9_-]{2,64}$")
_YT_TIME = re.compile(r"^(\d+s?|(\d+h)?(\d+m)?(\d+s)?)$")


def _host_ok(app: str, host: str | None) -> bool:
    host = (host or "").lower()
    return any(host == d or host.endswith("." + d) for d in APPS.get(app, (None, (), ()))[1])


def normalize_youtube(url: str) -> str | None:
    """Every shape of YouTube link (watch, youtu.be, shorts, embed, live, playlist) as
    https://www.youtube.com/watch?v=ID (with its list and start time), or None."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    host = (parts.hostname or "").lower()
    query = parse_qs(parts.query)
    path = [p for p in parts.path.split("/") if p]
    video = None
    if host == "youtu.be" or host.endswith(".youtu.be"):
        video = path[0] if path else None
    elif host == "youtube.com" or host.endswith(".youtube.com"):
        if path[:1] == ["watch"]:
            video = (query.get("v") or [None])[0]
        elif len(path) >= 2 and path[0] in ("shorts", "embed", "live", "v"):
            video = path[1]
        elif path[:1] != ["playlist"]:
            return None
    else:
        return None
    playlist = (query.get("list") or [None])[0]
    start = (query.get("t") or query.get("start") or [None])[0]
    if playlist and not _YT_LIST.match(playlist):
        playlist = None
    if start and not _YT_TIME.match(start):
        start = None
    if video:
        if not _YT_ID.match(video):
            return None
        out = f"https://www.youtube.com/watch?v={video}"
        if playlist:
            out += f"&list={playlist}"
        if start:
            out += f"&t={start}"
        return out
    return f"https://www.youtube.com/playlist?list={playlist}" if playlist else None


def https_form(url: str) -> str:
    """An Android intent link as the https address it stands for."""
    if url.startswith("intent://"):
        return "https://" + url[len("intent://"):].split("#Intent;")[0]
    return url


def _plain_ok(app: str, url: str) -> bool:
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return False
    return parts.scheme == "https" and not parts.username and not parts.password and port in (None, 443) \
        and _host_ok(app, parts.hostname)


def validate_link(app: str, url) -> str | None:
    """`url` if it is a link into `app` (by its catalog name) that the TV may open, else None.
    An intent:// link must name the app's own package and no other; a YouTube link comes back
    in its one plain form."""
    if app not in APPS or not isinstance(url, str) or not url or len(url) > 2048:
        return None
    if url.startswith("intent://"):
        if re.findall(r";package=([\w.]+)(?=;)", url) != [APPS[app][0]]:
            return None
        if "#Intent;" not in url or not url.endswith(";end"):
            return None
        return url if _plain_ok(app, https_form(url)) else None
    if not _plain_ok(app, url):
        return None
    if app == "YouTube":
        return normalize_youtube(url)
    return url


# ---------- the TV's state, as the panel takes it ----------

def app_of(package: str | None) -> dict | None:
    if not package:
        return None
    if package in BY_PACKAGE:
        name = BY_PACKAGE[package]
        return {"id": APP_IDS[name], "name": name, "package": package}
    if package in SYSTEM:
        aid, name = SYSTEM[package]
        return {"id": aid, "name": name, "package": package}
    return {"id": "other", "name": package, "package": package}


def normalize(payload: dict) -> dict:
    """tv-remote's /api/devices as the panel's TV state (see docs/tv-remote.md). What is
    playing (`nowPlaying`) is filled in from the TV itself (TvRemote._read_playing)."""
    devices = []
    for d in (payload or {}).get("devices") or []:
        if not isinstance(d, dict) or not d.get("id"):
            continue
        online = bool(d.get("online"))
        on = online and bool(d.get("isOn"))
        volume = d.get("volume")
        devices.append({
            "id": str(d["id"]), "name": d.get("name") or d.get("label") or "TV",
            "online": online, "on": on,
            "app": app_of(d.get("currentApp")) if on else None,
            "volume": volume if on and isinstance(volume, int) and not isinstance(volume, bool) else None,
            "volumeMax": d.get("volumeMax") or 100, "muted": bool(d.get("muted")),
            "caps": list(d.get("caps") or []), "nowPlaying": None,
        })
    return {"available": True, "error": "", "devices": devices}


def parse_search(data: dict) -> list[dict]:
    """JustWatch's answer as search results: where each title streams, in the apps the TV has."""
    results = []
    edges = ((((data or {}).get("data") or {}).get("popularTitles") or {}).get("edges")) or []
    for edge in edges:
        node = (edge or {}).get("node") or {}
        content = node.get("content") or {}
        if not content.get("title"):
            continue
        poster = content.get("posterUrl")
        offers, seen, paid = [], set(), []
        for o in node.get("offers") or []:
            pkg = o.get("package") or {}
            how = o.get("monetizationType")
            app = BY_JUSTWATCH.get(pkg.get("technicalName"))
            if how in INCLUDED and app and app not in seen:
                link = validate_link(app, o.get("tvLink")) or validate_link(app, o.get("standardWebURL"))
                if link:
                    seen.add(app)
                    offers.append({"app": APP_IDS[app], "name": app, "how": INCLUDED[how], "link": link})
            elif how in PAID and pkg.get("clearName"):
                label = f"{pkg['clearName']} ({PAID[how]})"
                if label not in paid:
                    paid.append(label)
        results.append({
            "title": content["title"], "year": content.get("originalReleaseYear"),
            "type": "movie" if node.get("objectType") == "MOVIE" else "show",
            "poster": POSTER_BASE + poster.replace("{profile}", "s166").replace("{format}", "webp")
            if isinstance(poster, str) and poster.startswith("/") else None,
            "offers": offers, "rentOrBuy": paid,
        })
    return results


def default_url(conf: Path, lan_ip: Callable[[], str]) -> str:
    if os.environ.get("HOUSE_TV_URL"):
        return os.environ["HOUSE_TV_URL"].rstrip("/")
    with contextlib.suppress(OSError, ValueError, AttributeError):
        url = json.loads((conf / "tv.json").read_text()).get("url")
        if isinstance(url, str) and url.startswith("http"):
            return url.rstrip("/")
    return f"http://{lan_ip()}:{TV_PORT}"


class TvRemote:
    """tv-remote, as the hub sees it. `publish` gets {"tv": state} whenever it changes;
    `watched()` says whether a panel is open (the TV is read more often then)."""

    def __init__(self, url: str, publish: Callable[[dict], None], watched: Callable[[], bool] = lambda: False,
                 cast: Callable[[str], object] = cast_link, adb: Adb | None = None):
        self.url = url
        self.publish = publish
        self.watched = watched
        self.cast = cast                 # host -> a Cast link (nowplaying.CastLink), or None
        self.adb = adb                   # nowplaying.Adb, when adb is paired with the TV
        self.links: dict[str, object] = {}
        self._settle: dict[str, float] = {}   # TV id -> until when a seek's position stands
        self.http: aiohttp.ClientSession | None = None
        self.state: dict | None = None   # None until the first read
        self.raw: dict = {}              # tv-remote's own view of each TV, by id
        self.read_at = 0.0
        self.asked_at = 0.0              # the last GET /api/tv (the Mac app polls it)
        self._burst_until = 0.0
        self._kick = asyncio.Event()
        self._cache: dict[str, tuple[float, list]] = {}

    @property
    def snapshot(self) -> dict:
        return self.state or {"available": False, "error": "Looking for the TV…", "devices": []}

    # ---------- reading ----------

    async def _devices(self) -> dict:
        assert self.http
        async with self.http.get(f"{self.url}/api/devices", timeout=aiohttp.ClientTimeout(total=4)) as r:
            if r.status != 200:
                raise aiohttp.ClientError(f"HTTP {r.status}")
            return await r.json(content_type=None)

    async def refresh(self) -> dict:
        """Reads every TV once; tells the panels when anything they show changed."""
        try:
            payload = await self._devices()
            new = normalize(payload)
            self.raw = {str(d.get("id")): d for d in payload.get("devices") or [] if isinstance(d, dict)}
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError, OSError):
            new = {"available": False, "error": UNREACHABLE, "devices": []}
        await self._read_playing(new)
        self.read_at = time.monotonic()
        if new != self.state:
            self.state = new
            self.publish({"tv": new})
        return new

    async def current(self) -> dict:
        """The state for GET /api/tv: read again when the last read is a few seconds old."""
        self.asked_at = time.monotonic()
        if self.state is None or time.monotonic() - self.read_at > POLL_WATCHED * 1.5:
            await self.refresh()
        return self.snapshot

    def _interval(self) -> float:
        now = time.monotonic()
        if now < self._burst_until:
            return POLL_BURST
        if self.watched() or now - self.asked_at < 8:
            playing = any((d.get("nowPlaying") or {}).get("state") in ("playing", "buffering") for d in self.snapshot["devices"])
            return POLL_PLAYING if playing and self.watched() else POLL_WATCHED
        return POLL_IDLE

    # ---------- what is playing ----------

    async def _link(self, host: str):
        """The Cast link to the TV at `host`, made the first time it is needed (None without pychromecast)."""
        if host not in self.links:
            self.links[host] = await asyncio.to_thread(self.cast, host)
        return self.links[host]

    async def _read_playing(self, new: dict) -> None:
        """Fills in each TV's `nowPlaying`: from Cast, else adb; the last one stands while
        the new one only moved on as expected (nowplaying.steady)."""
        old = {d["id"]: d.get("nowPlaying") for d in self.snapshot["devices"]}
        for dev in new["devices"]:
            host = (self.raw.get(dev["id"]) or {}).get("host")
            if not dev["on"] or not dev["app"] or not host:
                continue
            at = time.time()
            sample = None
            link = await self._link(host)
            if link is not None:
                try:
                    sample = nowplaying.from_cast(link.snapshot(), dev["app"], at)
                    link.refresh()  # answered in the background: the next read has it
                except Exception as e:  # a link that broke must not stop the TV's state
                    log.debug("Cast status from %s: %s", host, e)
            if sample is None and self.adb is not None:
                with contextlib.suppress(Exception):
                    sample = nowplaying.from_adb(await self.adb.sessions(host), dev["app"], at)
            last = old.get(dev["id"])
            if time.monotonic() < self._settle.get(dev["id"], 0) and nowplaying.same_title(last, sample):
                # A seek just asked for: the TV may still report where it was. The position
                # asked for stands; a pause or play pressed meanwhile still counts.
                sample = last if sample["state"] == last["state"] else \
                    {**sample, "position": nowplaying.position_at(last, at), "at": round(at, 3)}
            dev["nowPlaying"] = nowplaying.steady(last, sample)

    def close(self) -> None:
        for link in self.links.values():
            if link is not None:
                link.close()
        self.links.clear()

    async def run(self) -> None:
        while True:
            try:
                await self.refresh()
            except Exception:
                log.exception("TV read failed")
            self._kick.clear()
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self._kick.wait(), self._interval())

    def kick(self) -> None:
        """Read again now, and quickly for a few seconds: the TV takes a moment to switch."""
        self._burst_until = time.monotonic() + 4
        self._kick.set()

    # ---------- commands ----------

    async def _send(self, tv_id: str, body: dict) -> tuple[dict, int]:
        assert self.http
        try:
            async with self.http.post(f"{self.url}/api/devices/{tv_id}/action", json=body,
                                      timeout=aiohttp.ClientTimeout(total=20)) as r:
                try:
                    result = await r.json(content_type=None)
                except ValueError:
                    result = {}
                if not isinstance(result, dict):
                    result = {}
                if r.status >= 400 or result.get("error"):
                    return {"error": str(result.get("error") or f"The TV said no (HTTP {r.status})")}, r.status if r.status >= 400 else 502
                return {"ok": True}, 200
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError):
            return {"error": UNREACHABLE}, 503

    def _device(self, tv_id: str) -> dict | None:
        return next((d for d in self.snapshot["devices"] if d["id"] == tv_id), None)

    async def _awake(self, tv_id: str) -> None:
        """Wakes a sleeping TV and waits (a few seconds at most) until it says it is on."""
        dev = self._device(tv_id)
        if dev and dev["on"]:
            return
        await self._send(tv_id, {"action": "wake"})
        deadline = time.monotonic() + WAKE_WAIT
        while time.monotonic() < deadline:
            await asyncio.sleep(min(0.4, WAKE_WAIT / 6))
            with contextlib.suppress(aiohttp.ClientError, asyncio.TimeoutError, ValueError, OSError):
                raw = next((d for d in (await self._devices()).get("devices") or [] if str(d.get("id")) == tv_id), None)
                if raw and raw.get("isOn"):
                    return

    async def act(self, tv_id: str, body) -> tuple[dict, int]:
        """One thing the panel asks the TV to do, checked first. Returns (answer, HTTP status)."""
        if not isinstance(body, dict) or not isinstance(body.get("action"), str):
            return {"error": "Say what the TV should do"}, 400
        if self.state is None:
            await self.refresh()
        if not self.snapshot["available"]:
            return {"error": self.snapshot["error"] or UNREACHABLE}, 503
        dev = self._device(tv_id)
        if dev is None:
            return {"error": "There is no such TV"}, 404
        action = body["action"]
        if action in ("seek", "skip"):
            return await self._seek(tv_id, dev, body)
        # "play" is also the remote's play key: with an app it is a search result to play.
        titled = action == "open" or (action == "play" and "app" in body)
        if action in KEYS and not titled:
            out = {"action": action}
        elif action == "volume":
            level = body.get("level")
            top = dev.get("volumeMax") or 100
            if not isinstance(level, int) or isinstance(level, bool) or not 0 <= level <= top:
                return {"error": f"The volume goes from 0 to {top}"}, 400
            out = {"action": "volume", "level": level}
        elif action in ("text", "search"):
            text = body.get("text")
            if not isinstance(text, str) or not text.strip() or len(text) > 200:
                return {"error": "Up to 200 characters of text"}, 400
            out = {"action": action, "text": text}
        elif titled:
            name = APP_NAMES.get(body.get("app"))
            if not name:
                return {"error": "The TV doesn't have that app"}, 400
            target = APPS[name][0]
            if action == "play":
                link = validate_link(name, body.get("link"))
                if not link:
                    return {"error": f"That isn't a {name} link"}, 400
                target = https_form(link)
            await self._awake(tv_id)
            out = {"action": "launch", "url": target}
        else:
            return {"error": f"The TV can't do “{action}”"}, 400
        result, status = await self._send(tv_id, out)
        if status == 200:
            log.info("TV %s %s", tv_id, " ".join(f"{k}={v}" for k, v in out.items() if k != "text"))
            self.kick()
        else:
            log.warning("TV %s %s: %s", tv_id, action, result.get("error"))
        return result, status

    async def _seek(self, tv_id: str, dev: dict, body: dict) -> tuple[dict, int]:
        """`{"action": "seek", "position": s}` or `{"action": "skip", "by": ±s}`, over Cast.
        The new position is shown at once; the TV's own reports take over when they agree."""
        key = "position" if body["action"] == "seek" else "by"
        value = body.get(key)
        if not isinstance(value, (int, float)) or isinstance(value, bool) or value != value or abs(value) > 1e7:
            return {"error": f"Say {'where to jump to' if key == 'position' else 'how far to skip'}, in seconds"}, 400
        playing = dev.get("nowPlaying")
        link = self.links.get((self.raw.get(tv_id) or {}).get("host"))
        if not playing or not playing.get("seekable") or link is None:
            return {"error": "What's on the TV can't be moved through"}, 400
        now = time.time()
        current = playing["position"] + (now - playing["at"] if playing["state"] == "playing" else 0)
        target = round(min(max(0.0, value if key == "position" else current + value), max(0.0, playing["duration"] - 1)), 1)
        try:
            await asyncio.to_thread(link.seek, target)
        except Exception as e:
            log.warning("TV %s seek to %s: %s", tv_id, target, e)
            return {"error": "The TV didn't jump there"}, 502
        log.info("TV %s seek %s", tv_id, target)
        self._settle[tv_id] = time.monotonic() + SEEK_SETTLE
        moved = {**playing, "position": target, "at": round(now, 3)}
        self.state = {**self.snapshot, "devices": [{**d, "nowPlaying": moved} if d["id"] == tv_id else d
                                                   for d in self.snapshot["devices"]]}
        self.publish({"tv": self.state})
        self.kick()
        return {"ok": True, "position": target}, 200

    # ---------- the streaming catalog ----------

    async def search(self, q: str) -> tuple[dict, int]:
        q = " ".join((q or "").split())[:100]
        if not q:
            return {"results": []}, 200
        key = q.casefold()
        hit = self._cache.get(key)
        if hit and time.monotonic() - hit[0] < SEARCH_TTL:
            return {"results": hit[1]}, 200
        assert self.http
        payload = {"query": QUERY, "variables": {"filter": {"searchQuery": q}, "country": "US", "language": "en", "first": 8}}
        try:
            async with self.http.post(JUSTWATCH_URL, json=payload, timeout=aiohttp.ClientTimeout(total=10),
                                      headers={"User-Agent": "Mozilla/5.0 (Macintosh) HouseControl/1.0"}) as r:
                if r.status != 200:
                    raise aiohttp.ClientError(f"HTTP {r.status}")
                data = await r.json(content_type=None)
            if data.get("errors") and not (data.get("data") or {}).get("popularTitles"):
                raise ValueError(str(data["errors"])[:200])
            results = parse_search(data)
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError, AttributeError, OSError) as e:
            log.warning("JustWatch search %r: %s", q, e)
            return {"error": "The streaming catalog didn't answer."}, 502
        if len(self._cache) > 200:
            self._cache.clear()
        self._cache[key] = (time.monotonic(), results)
        return {"results": results}, 200
