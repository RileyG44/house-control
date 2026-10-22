"""The streaming catalog (docs/streaming-catalog.md): rows of titles for each streaming app the TV
has, a "For you" row, and one title's details, for the TV's launcher and the iPhone app. It all
comes from JustWatch, like the search in tv.py, so the TV never talks to JustWatch itself.

  GET /api/tv/catalog                            {apps: [{id, name, pkg, rows: [{key, title, label, items}]}], forYou, updatedAt}
  GET /api/tv/catalog/{app}?row=…&page=n         {app, row, page, items, more}: more of one row
  GET /api/tv/title/{id}                         a title's details, with the TV's apps it's included in
  GET /api/tv/img/{poster|backdrop}/{n}/{slug}   JustWatch's picture, through the hub, kept on disk

A tile is {id, title, year, kind: movie|show, poster, backdrop, app, pkg, link, tvLink, blurb,
runtime, rating, age}: `link` is the title's web page in that app and `tvLink` JustWatch's
Android TV deep link, both checked against the app (tv.validate_link); either plays it through
POST /api/tv/{id} {"action": "play", …}. The pictures are the hub's own addresses, made whole
for each client (`for_client`). "For you" tiles that come from the launcher's Continue have
kind "continue", `progress`, and `resume` (POST /api/tv/{id} {"action": "resume", "id": …});
the apps' own picks that the launcher read from the TV provider have kind "recommendation" and
`recommendation` (POST /api/tv/{id} {"action": "recommendation", "id": …}).

**Only Riley's services.** An app gets rows only when the TV has it (the launcher's `apps` while
the hub is paired with it, else every app in tv.APPS), and a title only shows under an app where
it's included in the subscription (FLATRATE, FREE, ADS), never to rent or buy.

**The rows** are JustWatch's `popularTitles`, filtered to the app's packages and those offers,
sorted POPULAR ("Popular on Netflix") and TRENDING (the popularity change over a week), and
`newTitles` for "New on Netflix": what the app added on each of the last seven days, all asked in
one request (a season that arrived stands for its show). JustWatch's package filter takes its
short names (nfx, hlu, mxx), and those change when a service renames, so they are read from its
`packages` list once a day and matched to tv.APPS by their technical names; SHORT_NAMES is only
the fallback. A row that fails, or comes back empty, is just left out.

**For you** is the launcher's Continue first, then the apps' own recommendations when the
launcher can read them from the TV provider (its `recommendations`; Watch Next and preview
channels, in the TV's apps only), then titles similar to the latest Continue titles
(`similarTitlesV2` of the JustWatch title found by a search in that app), in the TV's apps, then
each app's popular titles in turn.

**Kept** for six hours in ~/.house-hub/catalog-cache.json, so a restart doesn't ask again; an
older row is still shown while it is asked again in the background. Pictures stay in
~/.house-hub/catalog-art, the least recently used ones going first past ART_LIMIT.
"""
from __future__ import annotations

import asyncio
import contextlib
import datetime
import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Awaitable, Callable, Iterable

import aiohttp

from tv import (APP_IDS, APP_NAMES, APPS, BY_JUSTWATCH, BY_PACKAGE, INCLUDED, JUSTWATCH_URL as SEARCH_URL, PAID,
                POSTER_BASE, app_of, validate_link)

log = logging.getLogger("house.catalog")

JUSTWATCH_URL = SEARCH_URL
IMAGE_BASE = POSTER_BASE
HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh) HouseControl/1.0"}
COUNTRY, LANGUAGE = "US", "en"
MONETIZATION = list(INCLUDED)

PAGE = 20            # tiles in a row, and in each page of more
MAX_PAGE = 9
NEW_DAYS = 7         # days of "New on …" in one page, asked at once
NEW_PER_DAY = 10
TTL = 6 * 3600.0     # how long a row stands before JustWatch is asked again
PACKAGES_TTL = 24 * 3600.0
RETRY = 600.0        # after a failure: how long before the same thing is asked again
FETCHES = 4          # JustWatch requests at once
SIMILAR_SEEDS = 3    # Continue titles that "For you" finds similar titles for
SIMILAR_EACH = 8
FOR_YOU_MAX = 30
ART_LIMIT = 200 * 1024 * 1024   # the picture cache on disk
ART_ONE = 3 * 1024 * 1024       # a picture bigger than this isn't one
ART_PROFILES = {"poster": "s332", "backdrop": "s1440"}

# label, the row's title (with the app's name), and how it is asked for (None: newTitles).
ROWS = {
    "popular": ("Popular", "Popular on {app}", "POPULAR"),
    "trending": ("Trending", "Trending on {app}", "TRENDING"),
    "new": ("New", "New on {app}", None),
}

# JustWatch's short names for the apps (its package filter takes these), when its own list
# can't be read. Seen in other JustWatch clients in 2026; Paramount+ was `pmp` before it split.
SHORT_NAMES = {
    "YouTube": ("yot", "ytr"), "Netflix": ("nfx", "nfa"), "Prime Video": ("amp", "pva", "prv"), "Disney+": ("dnp",),
    "Hulu": ("hlu",), "Max": ("mxx",), "Peacock": ("pct", "pcp"), "Paramount+": ("ppp", "ppe", "pmp"),
    "Apple TV": ("atp",), "Tubi": ("tbv",), "Pluto TV": ("ptv",), "Plex": ("pxp",), "Crunchyroll": ("cru",),
}

_CONTENT = """content(country: $country, language: $language) {
        title originalReleaseYear shortDescription posterUrl runtime ageCertification
        backdrops { backdropUrl } scoring { imdbScore } genres { translation(language: $language) } }"""
_OFFERS = """offers(country: $country, platform: WEB) {
        monetizationType standardWebURL tvLink: deeplinkURL(platform: ANDROID_TV)
        package { clearName technicalName shortName } }"""
_CARD = f"id objectType {_CONTENT} {_OFFERS}"

POPULAR_QUERY = f"""query Popular($country: Country!, $language: Language!, $filter: TitleFilter!,
    $sortBy: PopularTitlesSorting!, $first: Int!, $offset: Int) {{
  popularTitles(country: $country, filter: $filter, sortBy: $sortBy, first: $first, offset: $offset) {{
    edges {{ node {{ {_CARD} }} }} }} }}"""
_NEW_NODE = f"""__typename
      ... on MovieOrShowOrSeason {{ id objectType {_OFFERS} }}
      ... on Movie {{ {_CONTENT} }}
      ... on Season {{ show {{ id objectType {_CONTENT} }} }}"""
SIMILAR_QUERY = f"""query Similar($id: ID!, $country: Country!, $language: Language!, $filter: TitleFilter, $first: Int!) {{
  node(id: $id) {{ ... on MovieOrShow {{
    similarTitlesV2(country: $country, filter: $filter, first: $first) {{ edges {{ node {{ {_CARD} }} }} }} }} }} }}"""
SEED_QUERY = """query Seed($country: Country!, $language: Language!, $filter: TitleFilter!) {
  popularTitles(country: $country, filter: $filter, first: 1) {
    edges { node { id objectType content(country: $country, language: $language) { title } } } } }"""
TITLE_QUERY = f"""query Title($id: ID!, $country: Country!, $language: Language!) {{
  node(id: $id) {{ ... on MovieOrShow {{ {_CARD} }} }} }}"""
PACKAGES_QUERY = """query Packages($country: Country!) {
  packages(country: $country, platform: WEB) { shortName technicalName clearName } }"""


def new_query(days: int) -> str:
    """newTitles for `days` days at once, as d0 (the first date) … d{days-1}."""
    dates = ", ".join(f"$d{i}: Date!" for i in range(days))
    asked = "\n".join(f"  d{i}: newTitles(country: $country, date: $d{i}, filter: $filter, first: $first) {{\n"
                      f"    edges {{ node {{ {_NEW_NODE} }} }} }}" for i in range(days))
    return f"query New($country: Country!, $language: Language!, $filter: TitleFilter, $first: Int!, {dates}) {{\n{asked}\n}}"



def _whole_jpeg(body: bytes | bytearray) -> bool:
    """A JPEG that ends where JPEGs end (pictures that aren't JPEG pass)."""
    return not body.startswith(b"\xff\xd8") or body.rstrip(b"\0").endswith(b"\xff\xd9")

class CatalogError(Exception):
    """JustWatch didn't answer, or answered with errors and nothing else."""


# ---------- JustWatch's titles as tiles ----------

_IMAGE = re.compile(r"^/(poster|backdrop)/(\d{1,12})/\{profile\}/([A-Za-z0-9_-]{1,160})\.\{format\}$")
_TITLE_ID = re.compile(r"^t[a-z]{1,3}\d{1,12}$")
_HISTORY_ID = re.compile(r"^[0-9a-f]{1,32}$")
_EPISODE = re.compile(r"\bS\d+|\bE\d+")


def image(path) -> str | None:
    """A JustWatch picture path (/poster/123/{profile}/slug.{format}) as the hub's address for it."""
    m = _IMAGE.match(path) if isinstance(path, str) else None
    return f"/api/tv/img/{m[1]}/{m[2]}/{m[3]}" if m else None


def _count(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def card(node: dict) -> dict | None:
    """A JustWatch title (a popularTitles, similarTitlesV2 or node answer; a newTitles season
    stands for its show) as a tile without its app, or None when it has no id or title."""
    node = node if isinstance(node, dict) else {}
    show = node.get("show")
    if isinstance(show, dict) and isinstance(show.get("content"), dict):
        ident, kind, content = show.get("id"), "show", show["content"]
    else:
        ident, content = node.get("id"), node.get("content")
        kind = "movie" if node.get("objectType") == "MOVIE" else "show"
    if not isinstance(content, dict) or not isinstance(ident, str) or not _TITLE_ID.match(ident):
        return None
    title = content.get("title")
    if not isinstance(title, str) or not title.strip():
        return None
    backdrop = next((image(b.get("backdropUrl")) for b in content.get("backdrops") or []
                     if isinstance(b, dict) and image(b.get("backdropUrl"))), None)
    score = (content.get("scoring") or {}).get("imdbScore")
    blurb = content.get("shortDescription")
    runtime = content.get("runtime")
    genres = [g.get("translation") for g in content.get("genres") or [] if isinstance(g, dict) and isinstance(g.get("translation"), str)]
    age = content.get("ageCertification")
    return {
        "id": ident, "title": title.strip(),
        "year": content["originalReleaseYear"] if _count(content.get("originalReleaseYear")) else None,
        "kind": kind, "poster": image(content.get("posterUrl")), "backdrop": backdrop,
        "blurb": " ".join(blurb.split())[:600] if isinstance(blurb, str) and blurb.strip() else None,
        "runtime": runtime if _count(runtime) and runtime > 0 else None,
        "rating": round(float(score), 1) if isinstance(score, (int, float)) and not isinstance(score, bool) and score > 0 else None,
        "age": age if isinstance(age, str) and age else None,
        "genres": genres[:3],
    }


def _offer_app(o: dict, by_short: dict[str, str]) -> str | None:
    pkg = o.get("package") or {}
    return BY_JUSTWATCH.get(pkg.get("technicalName")) or by_short.get(pkg.get("shortName"))


def offers(node: dict, apps: Iterable[str], by_short: dict[str, str] | None = None) -> list[dict]:
    """Where `node` is included in the subscription, in `apps` (catalog names) and in their
    order, one offer per app: {app, name, pkg, how, link, tvLink}. Links that don't belong to
    the app are dropped; the web page is `link` (the deep link when there is no page)."""
    found: dict[str, dict] = {}
    allowed = list(apps)
    for o in (node or {}).get("offers") or []:
        if not isinstance(o, dict) or o.get("monetizationType") not in INCLUDED:
            continue
        app = _offer_app(o, by_short or {})
        if app not in allowed or app in found:
            continue
        tv_link = validate_link(app, o.get("tvLink"))
        web = validate_link(app, o.get("standardWebURL"))
        if tv_link or web:
            found[app] = {"app": APP_IDS[app], "name": app, "pkg": APPS[app][0], "how": INCLUDED[o["monetizationType"]],
                          "link": web or tv_link, "tvLink": tv_link}
    return [found[a] for a in allowed if a in found]


def tile(node: dict, apps: Iterable[str], by_short: dict[str, str] | None = None) -> dict | None:
    """`node` as a tile in the first of `apps` it's included in, or None."""
    base = card(node)
    if base is None:
        return None
    # A newTitles season carries its own offers; the show's content is the title.
    where = offers(node, apps, by_short)
    if not where:
        return None
    o = where[0]
    return {**base, "app": o["app"], "pkg": o["pkg"], "link": o["link"], "tvLink": o["tvLink"]}


def rent_or_buy(node: dict) -> list[str]:
    paid = []
    for o in (node or {}).get("offers") or []:
        pkg = (o or {}).get("package") or {}
        if (o or {}).get("monetizationType") in PAID and pkg.get("clearName"):
            label = f"{pkg['clearName']} ({PAID[o['monetizationType']]})"
            if label not in paid:
                paid.append(label)
    return paid


def continue_tile(entry: dict) -> dict | None:
    """One title of the launcher's Continue (its /api/state `continue`) as a "For you" tile."""
    if not isinstance(entry, dict):
        return None
    hid, pkg, title = entry.get("id"), entry.get("pkg"), entry.get("title")
    if not isinstance(hid, str) or not _HISTORY_ID.match(hid) or not isinstance(pkg, str) or not isinstance(title, str) or not title:
        return None
    art = f"/api/tv/art/h/{hid}" if str(entry.get("art") or "").startswith("art/h/") else None
    progress = entry.get("progress")
    subtitle = entry.get("subtitle") if isinstance(entry.get("subtitle"), str) and entry["subtitle"] else None
    return {
        "id": f"h:{hid}", "title": title, "year": None, "kind": "continue", "poster": art, "backdrop": art,
        "app": (app_of(pkg) or {}).get("id"), "pkg": pkg, "link": None, "tvLink": None, "blurb": subtitle,
        "runtime": None, "rating": None, "age": None, "genres": [], "subtitle": subtitle,
        "progress": round(float(progress), 3) if isinstance(progress, (int, float)) and not isinstance(progress, bool) and progress >= 0 else None,
        "resume": hid,
    }


def recommendation_tile(entry: dict) -> dict | None:
    """One of the apps' own picks (the launcher's /api/state `recommendations`) as a "For you"
    tile. Its poster is kept only when it is a web address (a content:// one only the TV reads)."""
    if not isinstance(entry, dict):
        return None
    rid, pkg, title = entry.get("id"), entry.get("pkg"), entry.get("title")
    if not isinstance(rid, str) or not _HISTORY_ID.match(rid) or not isinstance(pkg, str) or not isinstance(title, str) or not title:
        return None
    poster = entry.get("poster")
    poster = poster if isinstance(poster, str) and poster.startswith(("https://", "http://")) and len(poster) < 2048 else None
    return {
        "id": f"r:{rid}", "title": title, "year": None, "kind": "recommendation", "poster": poster, "backdrop": None,
        "app": (app_of(pkg) or {}).get("id"), "pkg": pkg, "link": None, "tvLink": None, "blurb": None,
        "runtime": None, "rating": None, "age": None, "genres": [], "recommendation": rid,
    }


def seed_query(entry: dict) -> str:
    """What to look for in JustWatch for a Continue title: the show, for an episode
    ("Stranger Things · S1 E7" names it), else the title."""
    title, subtitle = str(entry.get("title") or ""), entry.get("subtitle")
    show = subtitle.split(" · ")[0] if isinstance(subtitle, str) and _EPISODE.search(subtitle) else None
    return " ".join((show or title).split())[:100]


def for_client(value, origin: str):
    """`value` with the hub's own picture addresses (/api/tv/…) made whole with the address the
    client reaches the hub by."""
    if isinstance(value, dict):
        return {k: origin + v if k in ("poster", "backdrop") and isinstance(v, str) and v.startswith("/api/tv/")
                else for_client(v, origin) for k, v in value.items()}
    if isinstance(value, list):
        return [for_client(v, origin) for v in value]
    return value


def installed_apps(tv) -> list[str]:
    """The streaming apps the TV has, by catalog name and in the launcher's order: its `apps`
    while the hub drives the TV through it and has heard from it, else every app in APPS."""
    listed = (tv.lr_state or {}).get("apps") if tv.launcher else None
    if isinstance(listed, list) and listed:
        return list(dict.fromkeys(BY_PACKAGE[a["pkg"]] for a in listed if isinstance(a, dict) and a.get("pkg") in BY_PACKAGE))
    return list(APPS)


def continuing(tv) -> list[dict]:
    """The launcher's Continue, most recent first (nothing without the launcher)."""
    listed = (tv.lr_state or {}).get("continue") if tv.launcher else None
    return [e for e in listed if isinstance(e, dict)] if isinstance(listed, list) else []


def recommended(tv) -> list[dict]:
    """The apps' own picks the launcher read from the TV provider (often none)."""
    listed = (tv.lr_state or {}).get("recommendations") if tv.launcher else None
    return [e for e in listed if isinstance(e, dict)] if isinstance(listed, list) else []


# ---------- the catalog ----------

class Catalog:
    """The rows, "For you", a title's details and the pictures. `apps()` names the TV's
    streaming apps (installed_apps), `recent()` its Continue (continuing), `picks()` the apps'
    own recommendations (recommended)."""

    def __init__(self, conf: Path, apps: Callable[[], list[str]], recent: Callable[[], list[dict]] = list,
                 picks: Callable[[], list[dict]] = list):
        self.file = conf / "catalog-cache.json"
        self.art = conf / "catalog-art"
        self.apps = apps
        self.recent = recent
        self.picks = picks
        self.http: aiohttp.ClientSession | None = None
        self._rows: dict[str, dict] = {}       # "netflix:popular:0" -> {"at", "items"}
        self._similar: dict[str, dict] = {}    # "netflix|stranger things|netflix,hulu" -> {"at", "items"}
        self._packages: dict = {}              # {"at", "short": {app name: [short names]}}
        self._packages_retry = 0.0
        self._failed: dict[str, float] = {}    # a row that failed, with nothing kept -> when to ask again
        self._titles: dict[str, tuple[float, dict]] = {}
        self._busy: dict[str, asyncio.Future] = {}
        self._later: set[asyncio.Future] = set()
        self._gate: asyncio.Semaphore | None = None
        self._dirty = False
        self._art_bytes: int | None = None
        self._load()
        self.drop_cut_pictures()

    # ---------- the file ----------

    def _load(self) -> None:
        with contextlib.suppress(OSError, ValueError):
            data = json.loads(self.file.read_text())
            if not isinstance(data, dict):
                return
            for name, into in (("rows", self._rows), ("similar", self._similar)):
                for k, v in (data.get(name) or {}).items():
                    if isinstance(v, dict) and isinstance(v.get("at"), (int, float)) and isinstance(v.get("items"), list):
                        into[k] = v
            p = data.get("packages")
            if isinstance(p, dict) and isinstance(p.get("at"), (int, float)) and isinstance(p.get("short"), dict):
                self._packages = p

    def _save(self) -> None:
        if not self._dirty:
            return
        self._dirty = False
        now = time.time()
        # Rows nobody has asked for again in a day go.
        keep = lambda d: {k: v for k, v in d.items() if now - v["at"] < TTL + 24 * 3600}  # noqa: E731
        data = {"rows": keep(self._rows), "similar": keep(self._similar), "packages": self._packages}
        try:
            self.file.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.file.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(data, separators=(",", ":")))
            tmp.replace(self.file)
        except OSError as e:
            log.warning("Couldn't keep the catalog in %s: %s", self.file, e)

    # ---------- asking JustWatch ----------

    async def _ask(self, query: str, variables: dict) -> dict:
        """One GraphQL request; its `data`. An answer with errors and no data raises."""
        if self.http is None:
            raise CatalogError("No HTTP session yet")
        if self._gate is None:
            self._gate = asyncio.Semaphore(FETCHES)
        payload = {"query": query, "variables": {"country": COUNTRY, "language": LANGUAGE, **variables}}
        async with self._gate:
            try:
                async with self.http.post(JUSTWATCH_URL, json=payload, headers=HEADERS,
                                          timeout=aiohttp.ClientTimeout(total=12)) as r:
                    if r.status != 200:
                        raise CatalogError(f"HTTP {r.status}")
                    data = await r.json(content_type=None)
            except (aiohttp.ClientError, asyncio.TimeoutError, ValueError, OSError) as e:
                raise CatalogError(str(e) or type(e).__name__) from e
        if not isinstance(data, dict):
            raise CatalogError("Not a GraphQL answer")
        got = data.get("data") if isinstance(data.get("data"), dict) else {}
        if data.get("errors") and not any(v is not None for v in got.values()):
            raise CatalogError(str(data["errors"])[:300])
        return got

    async def _once(self, key: str, make: Callable[[], Awaitable]):
        """`make()`, but only one at a time for `key`: a second asker waits for the first's answer."""
        task = self._busy.get(key)
        if task is None:
            task = asyncio.ensure_future(make())
            self._busy[key] = task
            task.add_done_callback(lambda _: self._busy.pop(key, None))
        return await asyncio.shield(task)

    def _in_background(self, coro) -> None:
        task = asyncio.ensure_future(coro)
        self._later.add(task)
        task.add_done_callback(self._later.discard)

    async def short_names(self) -> dict[str, list[str]]:
        """Each app's JustWatch short names (its package filter takes these), from JustWatch's
        own list matched by technical name, read once a day; SHORT_NAMES where that has none."""
        now = time.time()
        if not (self._packages and now - self._packages["at"] < PACKAGES_TTL) and now >= self._packages_retry:
            try:
                data = await self._once("packages", lambda: self._ask(PACKAGES_QUERY, {}))
                found: dict[str, list[str]] = {}
                for p in data.get("packages") or []:
                    name = BY_JUSTWATCH.get((p or {}).get("technicalName"))
                    short = (p or {}).get("shortName")
                    if name and isinstance(short, str) and short and short not in found.setdefault(name, []):
                        found[name].append(short)
                if found:
                    self._packages = {"at": now, "short": found}
                    self._dirty = True
            except CatalogError as e:
                log.warning("JustWatch's packages: %s", e)
                self._packages_retry = now + RETRY
        known = self._packages.get("short") or {}
        return {name: list(known.get(name) or SHORT_NAMES.get(name, ())) for name in APPS}

    def _by_short(self, shorts: dict[str, list[str]]) -> dict[str, str]:
        return {s: name for name, ss in shorts.items() for s in ss}

    # ---------- rows ----------

    async def _fetch_row(self, name: str, key: str, page: int) -> list[dict]:
        shorts = await self.short_names()
        if not shorts.get(name):
            return []
        flt = {"packages": shorts[name], "monetizationTypes": MONETIZATION}
        by_short = self._by_short(shorts)
        sort = ROWS[key][2]
        if sort:
            data = await self._ask(POPULAR_QUERY, {"filter": flt, "sortBy": sort, "first": PAGE, "offset": page * PAGE})
            edges = ((data.get("popularTitles") or {}).get("edges")) or []
        else:
            today = datetime.date.today()
            days = {f"d{i}": (today - datetime.timedelta(days=page * NEW_DAYS + i)).isoformat() for i in range(NEW_DAYS)}
            data = await self._ask(new_query(NEW_DAYS), {"filter": flt, "first": NEW_PER_DAY, **days})
            edges = [e for i in range(NEW_DAYS) for e in ((data.get(f"d{i}") or {}).get("edges") or [])]
        items, seen = [], set()
        for edge in edges:
            t = tile((edge or {}).get("node") or {}, [name], by_short)
            if t and t["id"] not in seen:
                seen.add(t["id"])
                items.append(t)
        return items[:PAGE] if sort else items[:PAGE * 2]

    async def _refresh_row(self, name: str, key: str, page: int) -> list[dict] | None:
        k = f"{APP_IDS[name]}:{key}:{page}"
        try:
            items = await self._once("row:" + k, lambda: self._fetch_row(name, key, page))
        except CatalogError as e:
            log.warning("JustWatch row %s: %s", k, e)
            self._failed[k] = time.time() + RETRY
            old = self._rows.get(k)
            if old:
                # Asked again after RETRY, not on every request.
                old["at"] = max(old["at"], time.time() - TTL + RETRY)
            return old["items"] if old else None
        self._rows[k] = {"at": time.time(), "items": items}
        self._failed.pop(k, None)
        self._dirty = True
        return items

    async def row(self, name: str, key: str, page: int = 0) -> list[dict] | None:
        """One row's tiles (None when JustWatch didn't answer and nothing is kept): kept ones
        while they're fresh; older ones are shown while they're asked again in the background."""
        k = f"{APP_IDS[name]}:{key}:{page}"
        hit = self._rows.get(k)
        if hit and time.time() - hit["at"] < TTL:
            return hit["items"]
        if hit:
            async def again():
                await self._refresh_row(name, key, page)
                self._save()
            if "row:" + k not in self._busy:
                self._in_background(again())
            return hit["items"]
        if time.time() < self._failed.get(k, 0):
            return None
        return await self._refresh_row(name, key, page)

    # ---------- for you ----------

    async def _fetch_similar(self, app: str, q: str, names: list[str]) -> list[dict]:
        shorts = await self.short_names()
        if not shorts.get(app):
            return []
        seed = await self._ask(SEED_QUERY, {"filter": {"searchQuery": q, "packages": shorts[app]}})
        edges = ((seed.get("popularTitles") or {}).get("edges")) or []
        ident = ((edges[0] or {}).get("node") or {}).get("id") if edges else None
        if not isinstance(ident, str) or not _TITLE_ID.match(ident):
            return []
        packages = [s for n in names for s in shorts.get(n, [])]
        data = await self._ask(SIMILAR_QUERY, {"id": ident, "first": 16,
                                               "filter": {"packages": packages, "monetizationTypes": MONETIZATION}})
        similar = (data.get("node") or {}).get("similarTitlesV2") or {}
        nodes = [(e or {}).get("node") for e in similar.get("edges") or []] if isinstance(similar, dict) else []
        by_short = self._by_short(shorts)
        return [t for t in (tile(n or {}, names, by_short) for n in nodes) if t and t["id"] != ident]

    async def similar(self, app: str, q: str, names: list[str]) -> list[dict]:
        """Titles like `q` (a Continue title in `app`) that the TV's apps include."""
        k = f"{APP_IDS[app]}|{q.casefold()}|{','.join(APP_IDS[n] for n in names)}"
        hit = self._similar.get(k)
        if hit and time.time() - hit["at"] < TTL:
            return hit["items"]
        try:
            items = await self._once("similar:" + k, lambda: self._fetch_similar(app, q, names))
        except CatalogError as e:
            log.info("No similar titles for %r: %s", q, e)
            items = hit["items"] if hit else []
            self._similar[k] = {"at": time.time() - TTL + RETRY, "items": items}
            self._dirty = True
            return items
        self._similar[k] = {"at": time.time(), "items": items}
        self._dirty = True
        return items

    async def for_you(self, names: list[str], popular: dict[str, list[dict]]) -> list[dict]:
        """Continue, the apps' own picks, then titles similar to the latest Continue titles (in
        the TV's apps), then each app's popular ones in turn."""
        recent = self.recent()
        out = [t for t in (continue_tile(e) for e in recent[:8]) if t]
        packages = {APPS[n][0] for n in names}
        out += [t for t in (recommendation_tile(e) for e in self.picks()) if t and t["pkg"] in packages][:20]
        seen: set[str] = set()
        picked: list[dict] = []

        def add(t: dict) -> None:
            if t["id"] not in seen and len(picked) < FOR_YOU_MAX:
                seen.add(t["id"])
                picked.append(t)

        seeds = []
        for e in recent:
            app = BY_PACKAGE.get(e.get("pkg"))
            if app in names and app != "YouTube" and seed_query(e):
                seeds.append((app, seed_query(e)))
            if len(seeds) >= SIMILAR_SEEDS:
                break
        for items in await asyncio.gather(*(self.similar(app, q, names) for app, q in dict.fromkeys(seeds))):
            for t in items[:SIMILAR_EACH]:
                add(t)
        rows = [popular.get(n) or [] for n in names]
        for i in range(max((len(r) for r in rows), default=0)):
            for r in rows:
                if i < len(r):
                    add(r[i])
        return out + picked

    # ---------- what the routes answer ----------

    async def overview(self) -> dict:
        """GET /api/tv/catalog: each of the TV's apps with its rows, and "For you"."""
        names = self.apps()
        asked = [(n, k) for n in names for k in ROWS]
        got = await asyncio.gather(*(self.row(n, k) for n, k in asked))
        rows: dict[str, list[dict]] = {}
        for (n, k), items in zip(asked, got):
            if items:
                rows.setdefault(n, []).append({"key": k, "label": ROWS[k][0], "title": ROWS[k][1].format(app=n), "items": items})
        popular = {n: next((r["items"] for r in rows.get(n, []) if r["key"] == "popular"), []) for n in names}
        for_you = await self.for_you(names, popular)
        stamps = [self._rows[f"{APP_IDS[n]}:{k}:0"]["at"] for n, k in asked if f"{APP_IDS[n]}:{k}:0" in self._rows]
        self._save()
        return {
            "apps": [{"id": APP_IDS[n], "name": n, "pkg": APPS[n][0], "rows": rows[n]} for n in names if rows.get(n)],
            "forYou": for_you,
            "updatedAt": int(min(stamps)) if stamps else None,
        }

    async def more(self, app_id: str, key: str, page) -> tuple[dict, int]:
        """GET /api/tv/catalog/{app}?row=&page=: one page of one row."""
        name = APP_NAMES.get(app_id)
        if not name or name not in self.apps():
            return {"error": "The TV doesn't have that app"}, 404
        if key not in ROWS:
            return {"error": "The rows are " + ", ".join(ROWS)}, 400
        try:
            page = int(page)
        except (TypeError, ValueError):
            page = -1
        if not 0 <= page <= MAX_PAGE:
            return {"error": f"Pages go from 0 to {MAX_PAGE}"}, 400
        items = await self.row(name, key, page)
        self._save()
        if items is None:
            return {"error": "The streaming catalog didn't answer."}, 502
        more = bool(items) and page < MAX_PAGE and (key == "new" or len(items) >= PAGE)
        return {"app": app_id, "row": key, "label": ROWS[key][0], "title": ROWS[key][1].format(app=name),
                "page": page, "items": items, "more": more}, 200

    async def title(self, ident: str) -> tuple[dict, int]:
        """GET /api/tv/title/{id}: the title, and which of the TV's apps include it."""
        if not isinstance(ident, str) or not _TITLE_ID.match(ident):
            return {"error": "That isn't a JustWatch title"}, 400
        hit = self._titles.get(ident)
        if hit and time.time() - hit[0] < TTL:
            node = hit[1]
        else:
            try:
                data = await self._once("title:" + ident, lambda: self._ask(TITLE_QUERY, {"id": ident}))
            except CatalogError as e:
                log.warning("JustWatch title %s: %s", ident, e)
                return {"error": "The streaming catalog didn't answer."}, 502
            node = data.get("node") if isinstance(data.get("node"), dict) else {}
            if len(self._titles) > 300:
                self._titles.clear()
            self._titles[ident] = (time.time(), node)
        base = card(node)
        if base is None:
            return {"error": "The streaming catalog doesn't know that title"}, 404
        shorts = await self.short_names()
        return {**base, "offers": offers(node, self.apps(), self._by_short(shorts)), "rentOrBuy": rent_or_buy(node)}, 200

    # ---------- pictures ----------

    async def picture(self, kind: str, num: str, slug: str) -> tuple[bytes, str] | None:
        """JustWatch's poster or backdrop `num`, from the disk when it was fetched before."""
        if kind not in ART_PROFILES or not re.fullmatch(r"\d{1,12}", num or "") or not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", slug or ""):
            return None
        path = self.art / f"{kind}-{num}.jpg"
        with contextlib.suppress(OSError):
            body = path.read_bytes()
            os.utime(path)  # the least recently used go first
            return body, "image/jpeg"
        try:
            body = await self._once(f"art:{kind}:{num}", lambda: self._fetch_picture(kind, num, slug, path))
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError, CatalogError) as e:
            log.info("No %s %s: %s", kind, num, e)
            return None
        return (body, "image/jpeg") if body else None

    async def _fetch_picture(self, kind: str, num: str, slug: str, path: Path) -> bytes | None:
        if self.http is None:
            raise CatalogError("No HTTP session yet")
        url = f"{IMAGE_BASE}/{kind}/{num}/{ART_PROFILES[kind]}/{slug}.jpg"
        async with self.http.get(url, headers=HEADERS, timeout=aiohttp.ClientTimeout(total=15)) as r:
            if r.status != 200 or not r.headers.get("Content-Type", "").startswith("image/"):
                return None
            # content.read(n) returns what has arrived so far, not n bytes: on a slow link that is
            # the first few KB, and a cut-off JPEG draws as a strip of picture over black.
            body = bytearray()
            async for chunk in r.content.iter_chunked(64 * 1024):
                body += chunk
                if len(body) > ART_ONE:
                    return None
            expected = r.content_length
        if not body or (expected is not None and len(body) != expected) or not _whole_jpeg(body):
            return None
        body = bytes(body)
        self.art.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(body)
        tmp.replace(path)
        self._kept(len(body))
        return body

    def drop_cut_pictures(self) -> int:
        """Removes pictures an older hub cached cut off (see _fetch_picture); they are fetched again."""
        gone = 0
        for f in self.art.glob("*.jpg"):
            with contextlib.suppress(OSError):
                if not _whole_jpeg(f.read_bytes()):
                    f.unlink()
                    gone += 1
        if gone:
            self._art_bytes = None
            log.info("Dropped %d cut-off pictures", gone)
        return gone

    def _kept(self, added: int) -> None:
        """Counts a new picture; past ART_LIMIT, the least recently used go until 80% is left."""
        if self._art_bytes is None:
            self._art_bytes = sum(f.stat().st_size for f in self.art.glob("*.jpg"))
        else:
            self._art_bytes += added
        if self._art_bytes <= ART_LIMIT:
            return
        files = sorted(self.art.glob("*.jpg"), key=lambda f: f.stat().st_mtime)
        total = sum(f.stat().st_size for f in files)
        for f in files:
            if total <= ART_LIMIT * 0.8:
                break
            with contextlib.suppress(OSError):
                size = f.stat().st_size
                f.unlink()
                total -= size
        self._art_bytes = total
