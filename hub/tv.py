"""The TV, two ways. Both give the panels the same TV state and take the same actions.

**The launcher** (tv-launcher/, launcher.py): the TV's own Home app, with an API on the
Chromecast itself. The hub long-polls its state, so a change on the TV reaches the panels at
once, and sends the panel's actions to it as the launcher's commands (LAUNCHER_KEYS). It is
used when the hub is paired with it (`python house.py --pair-tv`, which writes "launcher" into
~/.house-hub/tv.json), unless HOUSE_TV_BACKEND=tvremote.

**tv-remote**: a separate service on the Mac (~/tv-remote, LaunchAgent local.tvremote, port
8765) that keeps an Android TV Remote connection to the Google TV.

  GET  /api/devices                 every TV, with isOn, currentApp and volume pushed live by the TV
  POST /api/devices/{id}/action     {"action": …} -> {"ok": true} or {"error": …}

The hub reads it every 2 s while a panel is watching (10 s otherwise). It is the only way
without a paired launcher, and the fallback with one: when the launcher stops answering (the
Chromecast asleep, the app gone), the hub reads tv-remote instead and tries the launcher again
every LAUNCHER_RETRY seconds. Actions the launcher can't do (menu, channels, input), or that it
says no to (play/pause with nothing playing, typing with no text field), go to tv-remote too.
Where tv-remote is: HOUSE_TV_URL, else ~/.house-hub/tv.json {"url": …}, else this Mac's LAN
address, port 8765 (127.0.0.1:8765 is another app on Riley's Mac).

Either way, the hub tells the panels what changed as `{"tv": …}` on /api/events, and passes the
panel's remote keys on, only the ones listed here. App links from the streaming catalog
(JustWatch) are checked against the app before the TV is asked to open them. What is playing
comes from the launcher's media sessions; when it sees none (an app that only reports over
Cast), from the TV over Cast (nowplaying.py), and seeking goes the same way it came. The
launcher's pictures go to the panels through the hub (/api/tv/art/now), so its token stays here.

With a launcher, its TV also says where the launcher is (`direct`: {"url", "id"}), whichever way
the hub reaches it right now: the iPhone app pairs with it on its own and drives it straight
over the house Wi-Fi while its remote is open, and comes back here when that doesn't answer.
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

import launcher as launchers
import nowplaying
from launcher import Launcher, LauncherError, NotPaired
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
UNREACHABLE_BOTH = "The TV isn't answering: neither its launcher nor the TV remote service on the Mac."
LAUNCHER_RETRY = 15.0  # seconds before a launcher that stopped answering is tried again
LAUNCHER_PKG = "com.livingroom.tv"

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
# How tv-remote opens an app: this Google TV refuses a bare package (androidtvremote2 sends it as
# market://launch?id=…, the TV answers with an error and drops the connection for a few seconds),
# but opens an https app link. The links are the ones Home Assistant's Android TV Remote docs list;
# YouTube's was checked on the TV (Oct 21). Apps missing here still go as their package.
APP_LINKS = {
    "YouTube": "https://www.youtube.com",
    "Netflix": "https://www.netflix.com/title",
    "Prime Video": "https://app.primevideo.com",
    "Disney+": "https://www.disneyplus.com",
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
    LAUNCHER_PKG: ("home", "Living Room"),
}
# Remote keys passed on as they are; volume, text, search, open and play (a title) are checked on their own.
KEYS = {"up", "down", "left", "right", "ok", "back", "home", "menu", "playpause", "play", "pause", "rewind",
        "forward", "volup", "voldown", "mute", "chup", "chdown", "input", "power", "wake", "sleep"}

# The panel's remote keys as the launcher's commands (tv-launcher/README.md). The ones missing
# here (menu, channels, input) only tv-remote can do.
LAUNCHER_KEYS = {
    **{k: {"type": "key", "key": k} for k in ("up", "down", "left", "right", "ok", "back", "home")},
    "playpause": {"type": "media", "action": "toggle"},
    "play": {"type": "media", "action": "play"},
    "pause": {"type": "media", "action": "pause"},
    "rewind": {"type": "media", "action": "seekBy", "ms": -10_000},
    "forward": {"type": "media", "action": "seekBy", "ms": 10_000},
    "volup": {"type": "volume", "delta": 1},
    "voldown": {"type": "volume", "delta": -1},
    "mute": {"type": "mute"},
    "power": {"type": "power"},
    "wake": {"type": "wake"},
    "sleep": {"type": "sleep"},
}
# What to say when the launcher says no and tv-remote can't step in.
LAUNCHER_NO = {
    "playpause": "Nothing on the TV is playing", "play": "Nothing on the TV is playing",
    "pause": "Nothing on the TV is playing", "rewind": "Nothing on the TV is playing",
    "forward": "Nothing on the TV is playing", "text": "Nothing on the TV takes text right now",
    "search": "Nothing on the TV takes text right now", "volume": "The TV's volume only goes up and down from here",
    "open": "The TV couldn't open that app", "play-title": "That app on the TV can't open this title",
}

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
ART_QUERY = """query Art($filter: TitleFilter!, $country: Country!, $language: Language!) {
  popularTitles(country: $country, filter: $filter, first: 1) { edges { node {
    content(country: $country, language: $language) { title posterUrl backdrops { backdropUrl } } } } } }"""
YT_RESULT = re.compile(r'"videoId":"([A-Za-z0-9_-]{11})"')
WEB_HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
               "Accept-Language": "en-US,en;q=0.9", "Cookie": "CONSENT=YES+1"}


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


def _count(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def launcher_playing(st: dict, app: dict | None, at: float) -> dict | None:
    """The launcher's `now` (the media session it follows) as the panel's nowPlaying, or None.
    A paused session of an app that is no longer on the screen isn't what's on. `at` is the
    hub's clock when the state arrived; the position was measured a little before, by the TV's
    own clock (serverTime - measuredAt)."""
    n = st.get("now")
    if not isinstance(n, dict) or not n.get("title") or n.get("state") not in ("playing", "paused", "buffering"):
        return None
    pkg = n.get("pkg") if isinstance(n.get("pkg"), str) else None
    if n["state"] == "paused" and (app or {}).get("package") != pkg:
        return None
    duration = round(n["durationMs"] / 1000, 1) if _count(n.get("durationMs")) and n["durationMs"] > 0 else None
    position = round(max(0, n["positionMs"]) / 1000, 1) if _count(n.get("positionMs")) else None
    if duration and position is not None:
        position = min(position, duration)
    measured, told = n.get("measuredAt"), st.get("serverTime")
    since = (told - measured) / 1000 if _count(measured) and _count(told) and 0 <= told - measured < 600_000 else 0
    art = n.get("art")
    artwork = None
    if isinstance(art, str) and art.startswith("art/now"):
        version = art.partition("?v=")[2]
        artwork = "/api/tv/art/now" + (f"?v={version}" if re.fullmatch(r"[0-9a-f]{1,16}", version) else "")
    return {
        "title": str(n["title"]), "subtitle": n.get("subtitle") or None, "state": n["state"],
        "position": position, "duration": duration,
        "seekable": bool(n.get("canSeek")) and duration is not None and position is not None,
        "artwork": artwork, "app": (app_of(pkg) or app or {}).get("id"), "at": round(at - since, 3),
    }


def from_launcher(st: dict, tv: Launcher, at: float, volume: dict | None = None) -> dict:
    """The launcher's /api/state as the panel's TV state, the same shape normalize() gives
    tv-remote's. `volume` is tv-remote's {volume, volumeMax, muted} for the same TV, used when
    the Chromecast's own volume is fixed (HDMI-CEC sends every change to the TV, so Android
    doesn't know the TV's level)."""
    t = st.get("tv") or {}
    on = bool(t.get("awake"))
    app = app_of((t.get("foreground") or {}).get("pkg")) if on else None
    level, top, muted = t.get("volume"), t.get("volumeMax"), bool(t.get("muted"))
    if t.get("volumeFixed") and volume:
        level, top, muted = volume.get("volume"), volume.get("volumeMax"), bool(volume.get("muted"))
    caps = st.get("caps") or {}
    return {"available": True, "error": "", "devices": [{
        "id": tv.device, "name": tv.name or t.get("name") or "TV",
        "online": True, "on": on, "app": app,
        "volume": level if on and _count(level) else None,
        "volumeMax": top if _count(top) and top > 0 else 100, "muted": muted,
        "caps": ["apps", "volume", *(["keys", "text", "search"] if caps.get("keys") else []),
                 *(["media"] if caps.get("media") else [])],
        "nowPlaying": launcher_playing(st, app, at) if on else None,
    }]}


def for_client(state: dict, origin: str) -> dict:
    """`state` for one panel: the hub's own picture addresses (/api/tv/art/…) made whole with
    the address that panel reaches the hub by, so the iPhone app can load them too."""
    def whole(d: dict) -> dict:
        np = d.get("nowPlaying") or {}
        art = np.get("artwork")
        return {**d, "nowPlaying": {**np, "artwork": origin + art}} if isinstance(art, str) and art.startswith("/api/tv/") else d
    return {**state, "devices": [whole(d) for d in state.get("devices") or []]}


def launcher_for(conf: Path) -> Launcher | None:
    """The launcher to drive the TV through: the paired one in tv.json, unless
    HOUSE_TV_BACKEND=tvremote. None means tv-remote only, as before the launcher."""
    backend = os.environ.get("HOUSE_TV_BACKEND", "").strip().lower()
    if backend == "tvremote":
        return None
    found = launchers.from_conf(conf)
    if found is None and backend == "launcher":
        log.warning("HOUSE_TV_BACKEND=launcher, but this hub isn't paired with the TV yet "
                    "(python house.py --pair-tv); using tv-remote")
    return found


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
    """The TV as the hub sees it: through its launcher when there is one (`launcher`), through
    tv-remote (`url`) otherwise or while the launcher doesn't answer. `publish` gets
    {"tv": state} whenever it changes; `watched()` says whether a panel is open (the TV is read
    more often then)."""

    def __init__(self, url: str, publish: Callable[[dict], None], watched: Callable[[], bool] = lambda: False,
                 cast: Callable[[str], object] = cast_link, adb: Adb | None = None, launcher: Launcher | None = None):
        self.url = url
        self.launcher = launcher
        # Which way the TV is read and driven now: "launcher" while it answers, else "tvremote".
        self.route = "launcher" if launcher else "tvremote"
        self.lr_rev = -1                 # the launcher's state revision the panels have seen
        self._lr_retry_at = 0.0          # when a launcher that stopped answering is tried again
        self._following = False          # a long poll of the launcher is up to date
        self._wants_cast = False         # something plays that only Cast tells about: read often, not long-poll
        self._np_from: dict[str, str] = {}   # TV id -> where its nowPlaying came from (launcher, cast, adb)
        self._volume: dict | None = None     # tv-remote's volume for the launcher's TV (see from_launcher)
        self._volume_at = 0.0
        self._volume_busy = False
        self._asked_id = False           # the launcher was asked for its id (older pairings didn't save it)
        if launcher:
            log.info("The TV: through its launcher at %s, with tv-remote at %s when it doesn't answer", launcher.url, url)
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
        self._art: dict[tuple, str | None] = {}   # (app, title, subtitle) -> a picture of it, None = none found
        self._art_busy: set[tuple] = set()

    @property
    def snapshot(self) -> dict:
        return self.state or {"available": False, "error": "Looking for the TV…", "devices": []}

    @property
    def unreachable(self) -> str:
        return UNREACHABLE_BOTH if self.launcher else UNREACHABLE

    @property
    def direct(self) -> dict | None:
        """Where the iPhone app finds the launcher on the house Wi-Fi: its address, and its own id
        when the hub knows it (the app keeps its token under it). Never the hub's token."""
        if not self.launcher:
            return None
        lr = self.launcher
        return {"url": lr.url, **({"id": lr.install_id} if lr.install_id else {})}

    def _with_direct(self, state: dict) -> dict:
        """`state` with `direct` on the launcher's TV: the one under its id, or (read from
        tv-remote) the one at its address."""
        direct = self.direct
        if not direct:
            return state
        assert self.launcher

        def mine(d: dict) -> bool:
            return d.get("id") == self.launcher.device or (self.raw.get(d.get("id")) or {}).get("host") == self.launcher.host
        return {**state, "devices": [{**d, "direct": direct} if mine(d) else d for d in state.get("devices") or []]}

    # ---------- reading the launcher ----------

    def _launcher_down(self, e: Exception) -> None:
        """The launcher didn't answer: tv-remote stands in, and the launcher is tried again soon."""
        if self.route == "launcher":
            if isinstance(e, NotPaired):
                log.warning("The TV's launcher doesn't take this hub's token any more (pair again: "
                            "python house.py --pair-tv); using tv-remote")
            else:
                log.warning("The TV's launcher isn't answering (%s); using tv-remote", e)
        self.route = "tvremote"
        self._following = False
        self._lr_retry_at = time.monotonic() + LAUNCHER_RETRY

    async def _read_launcher(self, since: int | None = None) -> dict | None:
        """The launcher's state as the panel's, or None when it didn't answer. With `since`, a
        long poll: it answers when the TV changes."""
        assert self.launcher and self.http
        try:
            st = await self.launcher.state(self.http, since)
        except LauncherError as e:
            self._launcher_down(e)
            return None
        if self.route != "launcher":
            log.info("The TV's launcher answers again at %s", self.launcher.url)
        self.route = "launcher"
        if self.launcher.install_id is None and not self._asked_id:
            self._asked_id = True
            asyncio.ensure_future(self._learn_id())
        self.lr_rev = st["rev"] if _count(st.get("rev")) else -1
        volume = None
        if (st.get("tv") or {}).get("volumeFixed"):
            self._peek_volume()
            volume = self._volume
        return from_launcher(st, self.launcher, time.time(), volume)

    async def _learn_id(self) -> None:
        """A pairing from before tv.json kept the launcher's id: asks the TV once (/pair/hello),
        so `direct` can carry it, and tells the panels."""
        assert self.launcher and self.http
        with contextlib.suppress(aiohttp.ClientError, asyncio.TimeoutError, ValueError, OSError, LauncherError):
            got = (await launchers.hello(self.http, self.launcher.url)).get("id")
            if isinstance(got, str) and got:
                self.launcher.install_id = got
                self.kick()

    def _peek_volume(self) -> None:
        """Asks tv-remote (in the background, at most every POLL_IDLE s) for the TV's own volume,
        for when the Chromecast's volume is fixed and the launcher can't know it."""
        if self._volume_busy or time.monotonic() - self._volume_at < POLL_IDLE or not self.http:
            return
        self._volume_busy = True

        async def peek():
            try:
                devices = (await self._devices()).get("devices") or []
                assert self.launcher
                mine = [d for d in devices if isinstance(d, dict)
                        and (str(d.get("id")) == self.launcher.device or d.get("host") == self.launcher.host)]
                d = mine[0] if mine else None
                self._volume = {k: d.get(k) for k in ("volume", "volumeMax", "muted")} \
                    if d and d.get("isOn") and _count(d.get("volume")) else None
            except (aiohttp.ClientError, asyncio.TimeoutError, ValueError, OSError, AttributeError):
                self._volume = None
            finally:
                self._volume_at = time.monotonic()
                self._volume_busy = False
        asyncio.ensure_future(peek())

    async def _follow(self) -> None:
        """One long poll of the launcher: back as soon as the TV changes (or after 25 s), or when
        the hub is kicked (a command, a panel that wants news now), then read at once."""
        kicked = asyncio.ensure_future(self._kick.wait())
        poll = asyncio.ensure_future(self._read_launcher(self.lr_rev if self.state is not None else None))
        try:
            await asyncio.wait({poll, kicked}, return_when=asyncio.FIRST_COMPLETED)
        except asyncio.CancelledError:
            poll.cancel()  # the hub is stopping
            raise
        finally:
            kicked.cancel()
        if not poll.done():
            poll.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await poll
            self._kick.clear()
            await self.refresh()
            return
        new = poll.result()
        if new is None:
            self._following = False
            return
        self._following = True
        await self._read_playing(new)
        self._commit(new)

    async def picture(self, kind: str, pkg: str | None = None) -> tuple[bytes, str] | None:
        """A picture from the launcher, for the panels (they never get its token)."""
        if not self.launcher or not self.http:
            return None
        return await self.launcher.picture(self.http, kind, pkg)

    # ---------- reading tv-remote ----------

    async def _devices(self) -> dict:
        assert self.http
        async with self.http.get(f"{self.url}/api/devices", timeout=aiohttp.ClientTimeout(total=4)) as r:
            if r.status != 200:
                raise aiohttp.ClientError(f"HTTP {r.status}")
            return await r.json(content_type=None)

    async def _read_tv_remote(self) -> dict:
        try:
            payload = await self._devices()
            new = normalize(payload)
            self.raw = {str(d.get("id")): d for d in payload.get("devices") or [] if isinstance(d, dict)}
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError, OSError):
            new = {"available": False, "error": self.unreachable, "devices": []}
        return new

    def _commit(self, new: dict) -> None:
        self.read_at = time.monotonic()
        new = self._with_direct(new)
        if new != self.state:
            self.state = new
            self.publish({"tv": new})

    async def refresh(self) -> dict:
        """Reads every TV once (from the launcher, else tv-remote); tells the panels when
        anything they show changed."""
        new = None
        if self.launcher and (self.route == "launcher" or time.monotonic() >= self._lr_retry_at):
            new = await self._read_launcher()
        if new is None:
            new = await self._read_tv_remote()
        await self._read_playing(new)
        self._commit(new)
        return new

    async def current(self) -> dict:
        """The state for GET /api/tv: read again when the last read is a few seconds old (a
        launcher being long-polled is never old: it says when anything changes)."""
        self.asked_at = time.monotonic()
        live = self.route == "launcher" and self._following
        if self.state is None or (not live and time.monotonic() - self.read_at > POLL_WATCHED * 1.5):
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

    def _host(self, tv_id: str) -> str | None:
        if self.launcher and self.route == "launcher" and tv_id == self.launcher.device:
            return self.launcher.host
        return (self.raw.get(tv_id) or {}).get("host")

    async def _read_playing(self, new: dict) -> None:
        """Fills in each TV's `nowPlaying`: the launcher's when it saw a media session, else
        from Cast, else adb; the last one stands while the new one only moved on as expected
        (nowplaying.steady)."""
        old = {d["id"]: d.get("nowPlaying") for d in self.snapshot["devices"]}
        self._wants_cast = False
        for dev in new["devices"]:
            sample = dev.get("nowPlaying")
            source = "launcher"
            host = self._host(dev["id"])
            if not dev["on"] or not dev["app"] or (not host and not sample):
                self._np_from[dev["id"]] = source if sample else ""
                continue
            at = sample["at"] if sample else time.time()
            link = None if sample else await self._link(host)
            if link is not None:
                source = "cast"
                if self.route == "launcher" and dev["app"]["id"] not in ("home", "ambient", "settings"):
                    self._wants_cast = True  # it may start playing without the launcher seeing it
                try:
                    sample = nowplaying.from_cast(link.snapshot(), dev["app"], at)
                    link.refresh()  # answered in the background: the next read has it
                except Exception as e:  # a link that broke must not stop the TV's state
                    log.debug("Cast status from %s: %s", host, e)
            if sample is None and self.adb is not None and host:
                source = "adb"
                with contextlib.suppress(Exception):
                    sample = nowplaying.from_adb(await self.adb.sessions(host), dev["app"], at)
            self._np_from[dev["id"]] = source if sample else ""
            if sample and not sample.get("artwork"):
                sample = self._with_art(sample)
            last = old.get(dev["id"])
            if time.monotonic() < self._settle.get(dev["id"], 0) and nowplaying.same_title(last, sample):
                # A seek just asked for: the TV may still report where it was. The position
                # asked for stands; a pause or play pressed meanwhile still counts.
                sample = last if sample["state"] == last["state"] else \
                    {**sample, "position": nowplaying.position_at(last, at), "at": round(at, 3)}
            dev["nowPlaying"] = nowplaying.steady(last, sample)

    # ---------- a picture of what is playing ----------

    def _with_art(self, np: dict) -> dict:
        """`np` with a picture of it when one was found; else one is looked for in the background
        (the TV's state goes out again once it is)."""
        key = (np.get("app"), np.get("title"), np.get("subtitle"))
        if key in self._art:
            return {**np, "artwork": self._art[key]} if self._art[key] else np
        if key not in self._art_busy and self.http:
            self._art_busy.add(key)
            asyncio.ensure_future(self._find_art(key))
        return np

    async def _find_art(self, key: tuple) -> None:
        app, title, subtitle = key
        url = None
        try:
            if app == "youtube":
                url = await self._youtube_art(" ".join(filter(None, (title, subtitle))))
            else:
                # A show's episode: the show's picture ("Stranger Things · S1 E7" names it).
                show = subtitle.split(" · ")[0] if subtitle and re.search(r"\bS\d+|\bE\d+", subtitle) else None
                url = await self._catalog_art(show or title)
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError, AttributeError, KeyError, OSError) as e:
            log.info("No picture for %r: %s", title, e)
        finally:
            self._art_busy.discard(key)
        if len(self._art) > 200:
            self._art.clear()
        self._art[key] = url
        if url:
            self.kick()

    async def _youtube_art(self, q: str) -> str | None:
        assert self.http
        async with self.http.get("https://www.youtube.com/results", params={"search_query": q}, headers=WEB_HEADERS,
                                 timeout=aiohttp.ClientTimeout(total=8)) as r:
            if r.status != 200:
                raise aiohttp.ClientError(f"HTTP {r.status}")
            m = YT_RESULT.search(await r.text())
        return f"https://i.ytimg.com/vi/{m.group(1)}/hqdefault.jpg" if m else None

    async def _catalog_art(self, q: str) -> str | None:
        assert self.http
        payload = {"query": ART_QUERY, "variables": {"filter": {"searchQuery": q}, "country": "US", "language": "en"}}
        async with self.http.post(JUSTWATCH_URL, json=payload, timeout=aiohttp.ClientTimeout(total=8),
                                  headers={"User-Agent": "Mozilla/5.0 (Macintosh) HouseControl/1.0"}) as r:
            if r.status != 200:
                raise aiohttp.ClientError(f"HTTP {r.status}")
            data = await r.json(content_type=None)
        edges = data["data"]["popularTitles"]["edges"]
        if not edges:
            return None
        content = edges[0]["node"]["content"]
        # A wide still suits the card; a poster when there is none.
        backdrop = next((b.get("backdropUrl") for b in content.get("backdrops") or [] if b.get("backdropUrl")), None)
        path, profile = (backdrop, "s640") if backdrop else (content.get("posterUrl"), "s332")
        if not isinstance(path, str) or not path.startswith("/"):
            return None
        return POSTER_BASE + path.replace("{profile}", profile).replace("{format}", "jpg")

    def close(self) -> None:
        for link in self.links.values():
            if link is not None:
                link.close()
        self.links.clear()

    async def run(self) -> None:
        while True:
            try:
                # The launcher says when anything changes. Only what Cast alone reports (an app
                # with no media session) has to be asked for again and again while a panel looks.
                if self.route == "launcher" and not (self._wants_cast and self._interval() < POLL_IDLE):
                    await self._follow()
                    continue
                await self.refresh()
            except Exception:
                log.exception("TV read failed")
                await asyncio.sleep(1)
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
            return {"error": self.unreachable}, 503

    async def _launcher_cmd(self, body: dict) -> bool | None:
        """One command to the launcher: True done, False refused, None when it didn't answer
        (tv-remote takes over from then on)."""
        if not self.launcher or self.route != "launcher":
            return None
        assert self.http
        try:
            return await self.launcher.cmd(self.http, body)
        except LauncherError as e:
            self._launcher_down(e)
            return None

    async def _deliver(self, tv_id: str, action: str, out: dict, commands: list[dict] | None) -> tuple[dict, int]:
        """Does `action`: as the launcher's `commands` while it answers, else (or when the launcher
        can't do the first of them) as tv-remote's `out`."""
        said_no = False
        if commands and self.route == "launcher":
            first = await self._launcher_cmd(commands[0])
            if first:
                for c in commands[1:]:
                    if not await self._launcher_cmd(c):
                        return {"error": "The TV only did part of that"}, 502
                return {"ok": True}, 200
            said_no = first is False
        result, status = await self._send(tv_id, out)
        if said_no and status == 503:
            # tv-remote isn't there to step in: what the launcher said is the answer.
            return {"error": LAUNCHER_NO.get(action, "The TV couldn't do that")}, 409
        return result, status

    def _device(self, tv_id: str) -> dict | None:
        return next((d for d in self.snapshot["devices"] if d["id"] == tv_id), None)

    async def _is_on(self, tv_id: str) -> bool:
        if self.route == "launcher":
            assert self.launcher and self.http
            with contextlib.suppress(LauncherError, asyncio.TimeoutError):
                st = await asyncio.wait_for(self.launcher.state(self.http), 2)
                return bool((st.get("tv") or {}).get("awake"))
            return False
        with contextlib.suppress(aiohttp.ClientError, asyncio.TimeoutError, ValueError, OSError):
            raw = next((d for d in (await self._devices()).get("devices") or [] if str(d.get("id")) == tv_id), None)
            return bool(raw and raw.get("isOn"))
        return False

    async def _awake(self, tv_id: str) -> None:
        """Wakes a sleeping TV and waits (a few seconds at most) until it says it is on. The
        launcher wakes it when it answers; a Chromecast asleep deeply enough that it doesn't
        is woken through tv-remote."""
        dev = self._device(tv_id)
        if dev and dev["on"]:
            return
        by_launcher = await self._launcher_cmd({"type": "wake"})
        if not by_launcher:
            await self._send(tv_id, {"action": "wake"})
        deadline = time.monotonic() + WAKE_WAIT
        while time.monotonic() < deadline:
            await asyncio.sleep(min(0.4, WAKE_WAIT / 6))
            if await self._is_on(tv_id):
                return
        if by_launcher:
            # The launcher's wake didn't reach the TV (CEC, or a Chromecast half asleep): tv-remote's may.
            await self._send(tv_id, {"action": "wake"})

    async def act(self, tv_id: str, body) -> tuple[dict, int]:
        """One thing the panel asks the TV to do, checked first. Returns (answer, HTTP status)."""
        if not isinstance(body, dict) or not isinstance(body.get("action"), str):
            return {"error": "Say what the TV should do"}, 400
        if self.state is None:
            await self.refresh()
        if not self.snapshot["available"]:
            return {"error": self.snapshot["error"] or self.unreachable}, 503
        dev = self._device(tv_id)
        if dev is None:
            return {"error": "There is no such TV"}, 404
        action = body["action"]
        if action in ("seek", "skip"):
            return await self._seek(tv_id, dev, body)
        # "play" is also the remote's play key: with an app it is a search result to play.
        titled = action == "open" or (action == "play" and "app" in body)
        # `out` is the action as tv-remote takes it, `commands` as the launcher does (None: only tv-remote can).
        if action in KEYS and not titled:
            out = {"action": action}
            commands = [LAUNCHER_KEYS[action]] if action in LAUNCHER_KEYS else None
        elif action == "volume":
            level = body.get("level")
            top = dev.get("volumeMax") or 100
            if not isinstance(level, int) or isinstance(level, bool) or not 0 <= level <= top:
                return {"error": f"The volume goes from 0 to {top}"}, 400
            out = {"action": "volume", "level": level}
            commands = [{"type": "volume", "level": level}]
        elif action in ("text", "search"):
            text = body.get("text")
            if not isinstance(text, str) or not text.strip() or len(text) > 200:
                return {"error": "Up to 200 characters of text"}, 400
            out = {"action": action, "text": text}
            # A search is typed into the field the TV has open, and sent; with none, tv-remote
            # opens Google TV's own search instead.
            commands = [{"type": "text", "text": text}, *([{"type": "submit"}] if action == "search" else [])]
        elif titled:
            name = APP_NAMES.get(body.get("app"))
            if not name:
                return {"error": "The TV doesn't have that app"}, 400
            package = APPS[name][0]
            target = APP_LINKS.get(name, package)
            commands = [{"type": "launch", "pkg": package}]
            if action == "play":
                link = validate_link(name, body.get("link"))
                if not link:
                    return {"error": f"That isn't a {name} link"}, 400
                target = https_form(link)
                commands = [{"type": "open", "url": target, "pkg": package}]
                action = "play-title"
            await self._awake(tv_id)
            out = {"action": "launch", "url": target}
        else:
            return {"error": f"The TV can't do “{action}”"}, 400
        result, status = await self._deliver(tv_id, action, out, commands)
        if status == 200:
            log.info("TV %s %s (%s)", tv_id, " ".join(f"{k}={v}" for k, v in out.items() if k != "text"), self.route)
            self.kick()
        else:
            log.warning("TV %s %s: %s", tv_id, action, result.get("error"))
        return result, status

    async def _seek(self, tv_id: str, dev: dict, body: dict) -> tuple[dict, int]:
        """`{"action": "seek", "position": s}` or `{"action": "skip", "by": ±s}`, the way what
        plays was found: through the launcher's media session, else over Cast. The new
        position is shown at once; the TV's own reports take over when they agree."""
        key = "position" if body["action"] == "seek" else "by"
        value = body.get(key)
        if not isinstance(value, (int, float)) or isinstance(value, bool) or value != value or abs(value) > 1e7:
            return {"error": f"Say {'where to jump to' if key == 'position' else 'how far to skip'}, in seconds"}, 400
        playing = dev.get("nowPlaying")
        by_launcher = self.route == "launcher" and self._np_from.get(tv_id) == "launcher"
        link = None if by_launcher else self.links.get(self._host(tv_id))
        if not playing or not playing.get("seekable") or (link is None and not by_launcher):
            return {"error": "What's on the TV can't be moved through"}, 400
        now = time.time()
        current = playing["position"] + (now - playing["at"] if playing["state"] == "playing" else 0)
        target = round(min(max(0.0, value if key == "position" else current + value), max(0.0, playing["duration"] - 1)), 1)
        if by_launcher:
            if not await self._launcher_cmd({"type": "seek", "positionMs": int(target * 1000)}):
                log.warning("TV %s seek to %s: the launcher said no", tv_id, target)
                return {"error": "The TV didn't jump there"}, 502
        else:
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
