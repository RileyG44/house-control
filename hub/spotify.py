"""Spotify remote: Spotify Connect, or the signed-in Mac app through a peer hub.

No credentials go to a panel. Connect uses PKCE (see spotify_pair.py); the Mac adapter uses
Spotify's installed scripting dictionary. A bridge request is local-only on the receiving
hub, so two peers can never forward a command back and forth or replay it after a timeout.
"""
from __future__ import annotations

import asyncio
import json
import math
import os
import platform
import re
import time
from pathlib import Path
from urllib.parse import urlsplit

import aiohttp

API = "https://api.spotify.com/v1"
TOKEN = "https://accounts.spotify.com/api/token"
TIMEOUT = aiohttp.ClientTimeout(total=8, connect=3)
ACTIONS = {"play", "pause", "next", "previous", "seek", "volume", "transfer", "open"}


def read_config(path: Path) -> dict:
    try:
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def save_config(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w") as out:
        json.dump(value, out)
    temp.replace(path)
    path.chmod(0o600)


class SpotifyError(Exception):
    def __init__(self, message: str, status: int = 503):
        super().__init__(message)
        self.status = status


def unavailable(message: str, backend="none", **extra) -> dict:
    return {"available": False, "backend": backend, "error": message, "devices": [],
            "playing": False, "track": None, "volume": None, "canTransfer": False, **extra}


def validate_action(body) -> dict:
    if not isinstance(body, dict) or not isinstance(body.get("action"), str) or body["action"] not in ACTIONS:
        raise SpotifyError("Unknown Spotify action", 400)
    action = body["action"]
    out = {"action": action}
    if action in {"volume", "seek"}:
        key = "level" if action == "volume" else "position"
        value = body.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise SpotifyError(f"Send a finite {key}", 400)
        out[key] = max(0, min(100 if action == "volume" else 24 * 3600, value))
    if action == "play" and "uri" in body:
        uri = body["uri"]
        if not isinstance(uri, str) or not re.fullmatch(r"spotify:playlist:[A-Za-z0-9]{22}", uri):
            raise SpotifyError("Choose a Spotify playlist.", 400)
        out["uri"] = uri
    if action == "transfer" or (action == "play" and "device" in body):
        device = body.get("device")
        if not isinstance(device, str) or not device or len(device) > 256:
            raise SpotifyError("Choose a Spotify output", 400)
        out["device"] = device
    return out


# JXA runs a fixed program; only a validated JSON action is passed as an argument. No track
# title, device name, URI or network text is ever evaluated as AppleScript or a shell command.
MAC_SCRIPT = r'''
function run(argv) {
    const input = JSON.parse(argv[0]);
    const app = Application('Spotify');
    if (!app.running()) return JSON.stringify({available:false, backend:'mac', canOpen:true,
        error:'Open Spotify on your Mac to use the remote.', devices:[], playing:false, track:null,
        volume:null, canTransfer:false});
    if (input.action === 'play') app.play();
    if (input.action === 'pause') app.pause();
    if (input.action === 'next') app.nextTrack();
    if (input.action === 'previous') app.previousTrack();
    if (input.action === 'volume') app.soundVolume = Math.round(input.level);
    if (input.action === 'seek') app.playerPosition = input.position;
    let track = null;
    try {
        const item = app.currentTrack;
        track = {id:item.id(), title:item.name(), artist:item.artist(), album:item.album(),
            artwork:item.artworkUrl(), duration:item.duration()/1000,
            position:app.playerPosition(), at:Date.now()/1000};
    } catch (_) {}
    return JSON.stringify({available:true, backend:'mac', error:'', playing:app.playerState()==='playing',
        volume:app.soundVolume(), track:track, canTransfer:false, canSeek:!!track,
        device:'mac', devices:[{id:'mac', name:'Spotify on Mac', type:'Computer', active:true,
            volume:app.soundVolume(), volumeSupported:true}]});
}
'''


class Spotify:
    def __init__(self, conf: Path, peers=()):
        self.path = conf / "spotify.json"
        self.peers = list(peers)
        self.http: aiohttp.ClientSession | None = None
        self.is_mac = platform.system() == "Darwin"
        self._lock = asyncio.Lock()
        self._token_lock = asyncio.Lock()
        self._cache = None
        self._cache_at = 0.0
        self._bridge_url = None
        self._rate_until = 0.0

    def bridge_urls(self) -> list[str]:
        env = os.environ.get("HOUSE_SPOTIFY_URLS")
        urls = env.split(",") if env is not None else read_config(self.path).get("bridge_urls", self.peers)
        if not isinstance(urls, list):
            return []
        return list(dict.fromkeys(u.rstrip("/") for u in urls if isinstance(u, str)
                                 and urlsplit(u).scheme in {"http", "https"} and urlsplit(u).hostname))

    async def _token(self, force=False):
        async with self._token_lock:
            cfg = read_config(self.path)
            if not force and cfg.get("access_token") and cfg.get("expires_at", 0) > time.time() + 45:
                return cfg["access_token"]
            if not cfg.get("refresh_token") or not cfg.get("client_id"):
                raise SpotifyError("Connect your Spotify account again.", 401)
            async with self.http.post(TOKEN, data={"grant_type": "refresh_token", "refresh_token": cfg["refresh_token"],
                                                  "client_id": cfg["client_id"]}, timeout=TIMEOUT) as response:
                if response.status != 200:
                    raise SpotifyError("Spotify sign-in expired. Connect your account again.", 401)
                tokens = await response.json()
            cfg.update(access_token=tokens["access_token"], expires_at=time.time() + tokens.get("expires_in", 3600))
            if tokens.get("refresh_token"):
                cfg["refresh_token"] = tokens["refresh_token"]
            save_config(self.path, cfg)
            return cfg["access_token"]

    async def _api(self, method, path, *, data=None, params=None):
        if time.monotonic() < self._rate_until:
            raise SpotifyError("Spotify is busy. Try again in a moment.", 429)
        for attempt in range(2):
            token = await self._token(force=attempt > 0)
            async with self.http.request(method, API + path, headers={"Authorization": "Bearer " + token},
                                         json=data, params=params, timeout=TIMEOUT) as response:
                if response.status == 401 and attempt == 0:
                    continue
                if response.status == 429:
                    try:
                        wait = max(1, min(3600, int(response.headers.get("Retry-After", "30"))))
                    except ValueError:
                        wait = 30
                    self._rate_until = time.monotonic() + wait
                    raise SpotifyError("Spotify is busy. Try again in a moment.", 429)
                if response.status == 403:
                    raise SpotifyError("Spotify refused playback. Check Premium and this app’s Spotify access.", 403)
                if response.status == 404:
                    raise SpotifyError("Open Spotify and choose a playback device first.", 409)
                if response.status >= 400:
                    raise SpotifyError("Spotify could not complete that request.", response.status)
                if not 200 <= response.status < 300:
                    raise SpotifyError("Spotify could not complete that request.", 502)
                # A successful player command can be an empty 200/202 as well as 204.
                # Its HTTP success is final: parsing a body must never invite a replay.
                if method != "GET":
                    return {}
                body = await response.read()
                if not body.strip() or not (response.content_type == "application/json" or response.content_type.endswith("+json")):
                    return {}
                try:
                    return json.loads(body)
                except ValueError as error:
                    raise SpotifyError("Spotify returned an unreadable response.", 502) from error

    async def _connect_state(self):
        player = await self._api("GET", "/me/player")
        outputs = await self._api("GET", "/me/player/devices")
        item = player.get("item")
        track = None
        if item:
            images = item.get("album", item).get("images", [])
            track = {"id": item.get("id"), "title": item.get("name", ""),
                     "artist": ", ".join(a.get("name", "") for a in item.get("artists", [])) or item.get("show", {}).get("name", ""),
                     "album": item.get("album", {}).get("name", ""), "artwork": images[0]["url"] if images else None,
                     "duration": item.get("duration_ms", 0) / 1000, "position": player.get("progress_ms", 0) / 1000,
                     "at": time.time()}
        device = player.get("device") or {}
        devices = [{"id": d.get("id"), "name": d.get("name", "Speaker"), "type": d.get("type", "Speaker"),
                    "active": d.get("is_active", False), "volume": d.get("volume_percent"),
                    "volumeSupported": d.get("supports_volume", True)}
                   for d in outputs.get("devices", []) if d.get("id") and not d.get("is_restricted")]
        return {"available": True, "backend": "connect", "error": "", "playing": player.get("is_playing", False),
                "track": track, "device": device.get("id"), "devices": devices,
                "volume": device.get("volume_percent"), "canTransfer": True,
                "canSeek": bool(track) and not player.get("actions", {}).get("disallows", {}).get("seeking", False),
                "volumeSupported": device.get("supports_volume", True)}

    async def _mac(self, body=None):
        if body and ("uri" in body or ("device" in body and body["action"] == "play")):
            raise SpotifyError("Connect your Spotify account to choose a playlist and speaker here.", 409)
        if body and body["action"] == "transfer":
            raise SpotifyError("Choose the speaker in Spotify on your Mac, or connect Spotify for an output picker.", 409)
        if body and body["action"] == "open":
            process = await asyncio.create_subprocess_exec("/usr/bin/open", "-a", "Spotify")
            await asyncio.wait_for(process.wait(), 5)
        process = await asyncio.create_subprocess_exec("/usr/bin/osascript", "-l", "JavaScript", "-e", MAC_SCRIPT,
                                                     json.dumps(body or {}), stdout=asyncio.subprocess.PIPE,
                                                     stderr=asyncio.subprocess.PIPE)
        try:
            output, error = await asyncio.wait_for(process.communicate(), 5)
        except asyncio.TimeoutError:
            process.kill()
            await process.communicate()
            raise SpotifyError("Spotify did not answer. Allow the hub to control Spotify in macOS Automation settings.")
        if process.returncode:
            raise SpotifyError("Allow the hub to control Spotify in macOS Settings → Privacy & Security → Automation.")
        state = json.loads(output)
        if body and body["action"] != "open" and not state.get("available"):
            raise SpotifyError(state.get("error", "Open Spotify on the Mac first."), 409)
        return state

    async def _bridge(self, body=None, *, path="/api/spotify", params=None):
        # Read-only discovery may try each address. A command uses just the chosen address:
        # if its answer is lost, forwarding it again could skip a second track or start music twice.
        urls = self.bridge_urls()
        if self._bridge_url in urls:
            urls = [self._bridge_url, *[u for u in urls if u != self._bridge_url]]
        if body and self._bridge_url:
            urls = [self._bridge_url]
        for url in urls:
            try:
                method = "POST" if body else "GET"
                async with self.http.request(method, url + path, params={"local": "1", **(params or {})}, json=body,
                                             timeout=TIMEOUT, allow_redirects=False) as response:
                    result = await response.json()
                    if body:
                        return result, response.status
                    if path == "/api/spotify/playlists" and response.status >= 400:
                        return result, response.status
                    if response.status == 200 and result.get("backend") in {"mac", "connect"}:
                        self._bridge_url = url
                        return result, 200
            except (aiohttp.ClientError, asyncio.TimeoutError, ValueError):
                if body:
                    raise SpotifyError("The Mac did not answer. Check Spotify before trying the action again.")
        return unavailable("Spotify is not connected. Open it on the Mac, or connect your account.", canOpen=False), 200

    async def playlists(self, *, local_only=False, offset=0):
        if not isinstance(offset, int) or not 0 <= offset <= 100000:
            return {"error": "Send a playlist offset between 0 and 100000."}, 400
        async with self._lock:
            try:
                cfg = read_config(self.path)
                if cfg.get("refresh_token"):
                    page = await self._api("GET", "/me/playlists", params={"limit": 50, "offset": offset})
                    items = [{"id": p["id"], "uri": "spotify:playlist:" + p["id"],
                              "name": p.get("name") or "Playlist", "owner": (p.get("owner") or {}).get("display_name") or ""}
                             for p in page.get("items", []) if isinstance(p, dict) and isinstance(p.get("id"), str)
                             and re.fullmatch(r"[A-Za-z0-9]{22}", p["id"])]
                    return {"available": True, "backend": "connect", "items": items,
                            "next": offset + 50 if page.get("next") and offset < 100000 else None}, 200
                if not local_only and (not self.is_mac or cfg.get("prefer_peer")):
                    return await self._bridge(path="/api/spotify/playlists", params={"offset": offset})
                return unavailable("Connect your Spotify account to browse and play your playlists.",
                                   backend="mac" if self.is_mac else "none"), 200
            except (SpotifyError, aiohttp.ClientError, asyncio.TimeoutError, ValueError, OSError) as error:
                status = error.status if isinstance(error, SpotifyError) else 503
                message = str(error) if isinstance(error, SpotifyError) else "Spotify playlists cannot be reached."
                if status == 403:
                    message = "Connect Spotify again to allow House Control to read your playlists."
                return {"error": message}, status

    async def state(self, *, local_only=False, fresh=False):
        async with self._lock:
            if not fresh and self._cache and self._cache[0] == local_only and time.monotonic() - self._cache_at < 2:
                return self._cache[1]
            try:
                cfg = read_config(self.path)
                if cfg.get("refresh_token"):
                    state = await self._connect_state()
                elif not local_only and (not self.is_mac or cfg.get("prefer_peer")):
                    state, _ = await self._bridge()
                    if self.is_mac and state.get("backend") == "none":
                        self._bridge_url = None
                        state = await self._mac()
                elif self.is_mac:
                    state = await self._mac()
                else:
                    state = unavailable("This hub has no local Spotify player.")
            except (SpotifyError, aiohttp.ClientError, asyncio.TimeoutError, ValueError, OSError) as error:
                state = unavailable(str(error) if isinstance(error, SpotifyError) else "Spotify cannot be reached.")
            self._cache = (local_only, state)
            self._cache_at = time.monotonic()
            return state

    async def act(self, body, *, local_only=False):
        try:
            body = validate_action(body)
            # Select a peer before sending a mutation; only read operations may fail over.
            cfg = read_config(self.path)
            if not cfg.get("refresh_token") and not local_only and not self._bridge_url and (not self.is_mac or cfg.get("prefer_peer")):
                await self.state(fresh=True)
            async with self._lock:
                self._cache = None
                cfg = read_config(self.path)
                if cfg.get("refresh_token"):
                    action = body["action"]
                    if action == "transfer":
                        outputs = await self._api("GET", "/me/player/devices")
                        if not any(d.get("id") == body["device"] and not d.get("is_restricted") for d in outputs.get("devices", [])):
                            raise SpotifyError("That speaker is no longer available in Spotify.", 409)
                        await self._api("PUT", "/me/player", data={"device_ids": [body["device"]]})
                    elif action in {"play", "pause"}:
                        await self._api("PUT", "/me/player/" + action,
                                        data={"context_uri": body["uri"]} if "uri" in body else None,
                                        params={"device_id": body["device"]} if "device" in body else None)
                    elif action in {"next", "previous"}:
                        await self._api("POST", "/me/player/" + action)
                    elif action == "seek":
                        await self._api("PUT", "/me/player/seek", params={"position_ms": int(body["position"] * 1000)})
                    elif action == "volume":
                        await self._api("PUT", "/me/player/volume", params={"volume_percent": round(body["level"])})
                    else:
                        raise SpotifyError("Open Spotify on your playback device.", 409)
                elif not local_only and self._bridge_url and (not self.is_mac or cfg.get("prefer_peer")):
                    return await self._bridge(body)
                elif self.is_mac:
                    await self._mac(body)
                else:
                    raise SpotifyError("No Spotify player is connected.", 409)
            return {"ok": True}, 200
        except (SpotifyError, aiohttp.ClientError, asyncio.TimeoutError, ValueError, OSError) as error:
            return {"error": str(error) if isinstance(error, SpotifyError) else "Spotify cannot be reached. Check it before trying again."}, getattr(error, "status", 503)
