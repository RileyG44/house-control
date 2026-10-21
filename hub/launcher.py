"""The TV's own launcher ("Living Room", tv-launcher/ in this repo), as the hub talks to it: an
HTTP API on the Chromecast itself, port 8686.

  GET  /api/state?since=rev     the whole state; waits (up to 25 s) until it changes after `rev`
  POST /api/cmd                 {"type": key|media|seek|volume|mute|launch|open|text|submit|wake|sleep|…}
  GET  /art/now, /banner/{pkg}  what is playing, an app's banner
  POST /pair/start, /pair/finish   the TV shows a 4-digit code, and the code is traded for the token

Every /api call carries the token in the X-LR-Key header. The hub pairs once
(`python house.py --pair-tv`), and keeps the launcher's address and token in
~/.house-hub/tv.json under "launcher", next to whatever else that file holds. The token never
leaves the hub: the panels get the pictures through the hub (/api/tv/art/now).
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
from pathlib import Path
from typing import Awaitable, Callable
from urllib.parse import urlsplit

import aiohttp

PORT = 8686
LONG_POLL = 25.0     # how long the launcher holds a /api/state?since= before it answers anyway
_PKG = re.compile(r"^[A-Za-z][\w.]{0,199}$")


class LauncherError(Exception):
    """The launcher didn't answer, or answered something that isn't its API."""


class NotPaired(LauncherError):
    """The launcher answered, but doesn't take this hub's token."""


def base_url(where: str) -> str:
    """'192.168.0.225', '192.168.0.225:8686' or 'http://192.168.0.225:8686/' as the launcher's address."""
    where = where.strip().rstrip("/")
    if not where.startswith(("http://", "https://")):
        where = "http://" + where
    parts = urlsplit(where)
    if not parts.hostname:
        raise ValueError(f"That isn't an address: {where!r}")
    return f"{parts.scheme}://{parts.hostname}:{parts.port or PORT}"


class Launcher:
    """One TV's launcher. `device` and `name` are what the panels call the TV (the same id
    tv-remote gives it, so a plan's linked TV stays linked whichever way the hub reaches it)."""

    def __init__(self, url: str, token: str, device: str = "living-room", name: str | None = None):
        self.url = url.rstrip("/")
        self.token = token
        self.device = device
        self.name = name

    @property
    def host(self) -> str | None:
        return urlsplit(self.url).hostname

    def _headers(self) -> dict:
        return {"X-LR-Key": self.token}

    async def state(self, http: aiohttp.ClientSession, since: int | None = None) -> dict:
        """The launcher's /api/state. With `since`, waits until something changed after that rev
        (or the long poll runs out); without it, answers at once."""
        params = {} if since is None else {"since": str(since)}
        total = LONG_POLL + 10 if since is not None else 5
        try:
            async with http.get(f"{self.url}/api/state", params=params, headers=self._headers(),
                                timeout=aiohttp.ClientTimeout(total=total, connect=3)) as r:
                if r.status == 401:
                    raise NotPaired("The TV doesn't know this hub's token")
                if r.status != 200:
                    raise LauncherError(f"HTTP {r.status}")
                data = await r.json(content_type=None)
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError, OSError) as e:
            raise LauncherError(str(e) or type(e).__name__) from e
        if not isinstance(data, dict) or not isinstance(data.get("tv"), dict):
            raise LauncherError("Not the launcher's state")
        return data

    async def cmd(self, http: aiohttp.ClientSession, body: dict) -> bool:
        """One command. True when the TV did it, False when it couldn't (nothing playing, no
        text field, an app that doesn't open that link)."""
        try:
            async with http.post(f"{self.url}/api/cmd", json=body, headers=self._headers(),
                                 timeout=aiohttp.ClientTimeout(total=8, connect=3)) as r:
                if r.status == 401:
                    raise NotPaired("The TV doesn't know this hub's token")
                if r.status != 200:
                    raise LauncherError(f"HTTP {r.status}")
                data = await r.json(content_type=None)
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError, OSError) as e:
            raise LauncherError(str(e) or type(e).__name__) from e
        return isinstance(data, dict) and data.get("ok") is True

    async def picture(self, http: aiohttp.ClientSession, kind: str, pkg: str | None = None) -> tuple[bytes, str] | None:
        """What is playing (`now`) or an app's banner (`banner`), as (bytes, content type), or
        None when the TV has no such picture."""
        if kind == "now":
            path = "/art/now"
        elif kind == "banner" and pkg and _PKG.match(pkg):
            path = f"/banner/{pkg}"
        else:
            return None
        try:
            async with http.get(self.url + path, headers=self._headers(),
                                timeout=aiohttp.ClientTimeout(total=8, connect=3)) as r:
                if r.status != 200:
                    return None
                return await r.read(), r.headers.get("Content-Type", "image/jpeg")
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError):
            return None


# ---------- pairing ----------

async def _post(http: aiohttp.ClientSession, url: str, body: dict | None = None) -> tuple[int, dict]:
    async with http.post(url, json=body or {}, timeout=aiohttp.ClientTimeout(total=8, connect=3)) as r:
        try:
            data = await r.json(content_type=None)
        except ValueError:
            data = {}
        return r.status, data if isinstance(data, dict) else {}


async def hello(http: aiohttp.ClientSession, url: str) -> dict:
    """Who the TV at `url` is: {"name", "id", "paired", …}."""
    async with http.get(f"{url}/pair/hello", timeout=aiohttp.ClientTimeout(total=5, connect=3)) as r:
        data = await r.json(content_type=None)
    if not isinstance(data, dict) or "id" not in data:
        raise LauncherError("That address answers, but not as the TV's launcher")
    return data


async def pair_start(http: aiohttp.ClientSession, url: str) -> bool:
    """Asks the TV to show a code. False when it can't draw one (its remote input service is off)."""
    _, data = await _post(http, f"{url}/pair/start")
    return data.get("ok") is True


async def pair_finish(http: aiohttp.ClientSession, url: str, code: str) -> dict | None:
    """{"token", "name", "id"} for the right code, else None."""
    status, data = await _post(http, f"{url}/pair/finish", {"code": code})
    return data if status == 200 and data.get("token") else None


async def pair_cancel(http: aiohttp.ClientSession, url: str) -> None:
    with contextlib.suppress(aiohttp.ClientError, asyncio.TimeoutError, OSError):
        await _post(http, f"{url}/pair/cancel")


def read_conf(conf: Path) -> dict:
    with contextlib.suppress(OSError, ValueError):
        data = json.loads((conf / "tv.json").read_text())
        if isinstance(data, dict):
            return data
    return {}


def save(conf: Path, entry: dict) -> Path:
    """Writes the launcher's {url, token, device, name} into tv.json, keeping every other key
    (tv-remote's "url" among them). Only this user can read the file: it holds the token."""
    path = conf / "tv.json"
    conf.mkdir(parents=True, exist_ok=True)
    data = read_conf(conf)
    data["launcher"] = entry
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n")
    os.chmod(tmp, 0o600)
    tmp.replace(path)
    return path


def from_conf(conf: Path) -> Launcher | None:
    """The paired launcher in tv.json, or None."""
    entry = read_conf(conf).get("launcher")
    if not isinstance(entry, dict):
        return None
    url, token = entry.get("url"), entry.get("token")
    if not isinstance(url, str) or not url.startswith("http") or not isinstance(token, str) or not token:
        return None
    device = entry.get("device") if isinstance(entry.get("device"), str) and entry["device"] else "living-room"
    name = entry.get("name") if isinstance(entry.get("name"), str) and entry["name"] else None
    return Launcher(url, token, device=device, name=name)


async def pair(http: aiohttp.ClientSession, conf: Path, url: str, ask: Callable[[str], Awaitable[str]],
               say: Callable[[str], None] = print, known: Callable[[str], Awaitable[tuple[str, str] | None]] | None = None,
               tries: int = 3) -> dict | None:
    """Pairs this hub with the launcher at `url`: the TV shows a code, `ask` gets it from the
    person, and the token is saved in tv.json. `known(host)` may name the TV the way tv-remote
    does ((id, name)), so the panels see the same TV whichever way the hub reaches it. Returns
    the saved entry, or None."""
    try:
        who = await hello(http, url)
    except (aiohttp.ClientError, asyncio.TimeoutError, ValueError, OSError, LauncherError) as e:
        say(f"No launcher answers at {url} ({e or type(e).__name__}). Is Living Room installed on the TV?")
        return None
    if not await pair_start(http, url):
        say("The TV can't show a code: its remote input service is off. Run tv-launcher/tools/tv-install.sh --no-build.")
        return None
    say(f"“{who.get('name') or 'The TV'}” shows a 4-digit code in its top corner.")
    got = None
    for _ in range(tries):
        code = "".join((await ask("Code: ")).split())
        if not code:
            break
        got = await pair_finish(http, url, code)
        if got:
            break
        say("That isn't the code on the TV.")
    if not got:
        await pair_cancel(http, url)
        return None
    device, name = str(got.get("id") or who.get("id") or "living-room"), got.get("name") or who.get("name")
    if known:
        with contextlib.suppress(Exception):
            match = await known(urlsplit(url).hostname or "")
            if match:
                device, name = match
    entry = {"url": url, "token": got["token"], "device": device, "name": name or "TV"}
    path = save(conf, entry)
    say(f"Paired with {entry['name']}. Saved in {path}.")
    return entry
