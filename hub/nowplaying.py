"""What the TV is playing, for the TV's sheet: read straight from the TV over Cast
(pychromecast), with Android's media sessions over adb as a fallback for apps that don't
report over Cast. Both only look: nothing here ever launches anything on the TV.

  Cast   title, series / season / episode or channel, position, duration, artwork; seekable
  adb    title, subtitle, state and position only (no duration, so not scrubbable)

A Cast session can outlive its app, so a session is only believed while its app is the one
on the screen (tv-remote's currentApp). Both are optional: without pychromecast, adb or the
TV, nothing is playing as far as the panel knows. From ~/tv-remote's cast.py and adb.py.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import re
import shutil
import threading
import time
import uuid
from typing import Callable

log = logging.getLogger("house.tv")

CAST_PORT = 8009
DRIFT = 1.5          # seconds a playing position may stray from where it should be before it counts as news
ADB_EVERY = 3.0      # seconds between adb reads of one TV
ADB_RETRY = 60.0     # after adb can't find the TV
SEEK_WAIT = 8.0
_YT_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")


# ---------- what the panel is shown ----------

def _plain(text) -> str:
    return re.sub(r"[^a-z0-9]", "", str(text or "").lower())


def same_app(cast_app: str | None, app: dict | None) -> bool:
    """Whether the Cast session's app ("YouTube") is the app on the screen (tv-remote's
    package, as the panel names it)."""
    cast, names = _plain(cast_app), [_plain((app or {}).get(k)) for k in ("name", "package")]
    return bool(cast) and any(n and (cast in n or n in cast) for n in names)


def subtitle_of(playing: dict) -> str | None:
    """A show's series with its season and episode ("The Bear · S2 E3"), else the channel."""
    series = playing.get("series")
    if series:
        season, episode = playing.get("season"), playing.get("episode")
        se = f"S{season} E{episode}" if season and episode else f"E{episode}" if episode else ""
        if playing.get("title") and playing["title"] != series:
            return f"{series} · {se}" if se else series
        return se or None
    return playing.get("channel") or None


def artwork_of(playing: dict, app: dict | None) -> str | None:
    for url in playing.get("images") or []:
        if isinstance(url, str) and url.startswith("https://"):
            return url
    content = playing.get("contentId")
    if (app or {}).get("id") == "youtube" and isinstance(content, str) and _YT_ID.match(content):
        return f"https://i.ytimg.com/vi/{content}/hqdefault.jpg"
    return None


def from_cast(snap: dict | None, app: dict | None, at: float) -> dict | None:
    """The Cast link's snapshot as the panel's nowPlaying, or None when it isn't what's on."""
    playing = (snap or {}).get("nowPlaying")
    if not playing or not same_app(snap.get("app"), app):
        return None
    state = playing.get("state")
    if state not in ("playing", "paused", "buffering"):
        return None
    title = playing.get("title") or playing.get("series")
    if not title:
        return None
    duration = playing.get("duration")
    duration = round(float(duration), 1) if isinstance(duration, (int, float)) and duration > 0 else None
    position = playing.get("position")
    position = round(max(0.0, float(position)), 1) if isinstance(position, (int, float)) else None
    if duration and position is not None:
        position = min(position, duration)
    return {
        "title": str(title), "subtitle": subtitle_of(playing), "state": state,
        "position": position, "duration": duration,
        "seekable": bool(playing.get("seekable")) and duration is not None and position is not None,
        "artwork": artwork_of(playing, app), "app": (app or {}).get("id"), "at": round(at, 3),
    }


def steady(last: dict | None, sample: dict | None) -> dict | None:
    """`sample`, unless it only says what `last` already did: a playing position that moved
    on as it should (or a paused one that didn't move). Panels work the position out between
    reports, so the TV's state is only sent again when something really changed."""
    if not sample or not last:
        return sample
    if {k: v for k, v in sample.items() if k not in ("position", "at")} != \
            {k: v for k, v in last.items() if k not in ("position", "at")}:
        return sample
    if sample["position"] is None or last["position"] is None:
        return last if sample["position"] == last["position"] else sample
    expected = last["position"] + (sample["at"] - last["at"] if last["state"] == "playing" else 0)
    return last if abs(sample["position"] - expected) < DRIFT else sample


def same_title(a: dict | None, b: dict | None) -> bool:
    return bool(a and b) and (a["title"], a["subtitle"], a["app"]) == (b["title"], b["subtitle"], b["app"])


# ---------- Cast ----------

class CastLink:
    """One TV's Cast connection: status only, plus seek. It never starts the default media
    receiver: no status read or seek may switch the TV to another app."""

    def __init__(self, host: str):
        import pychromecast
        from pychromecast.models import CastInfo, HostServiceInfo

        self.host = host
        info = CastInfo({HostServiceInfo(host, CAST_PORT)}, uuid.uuid4(), None, None, host, CAST_PORT, None, None)
        # Reconnects on its own thread for as long as it exists.
        self.cc = pychromecast.get_chromecast_from_cast_info(info, None, retry_wait=5)
        self.cc.media_controller.supporting_app_id = None
        self.cc.start()

    def snapshot(self) -> dict | None:
        cc = self.cc
        s = cc.status
        if s is None or not cc.socket_client.is_connected:
            return None
        out: dict = {"app": s.display_name or None, "standby": s.is_stand_by}
        m = cc.media_controller.status
        if s.display_name and m.player_state not in ("UNKNOWN", "IDLE") and (m.title or m.series_title):
            playing: dict = {"state": m.player_state.lower(), "title": m.title, "seekable": bool(m.supports_seek)}
            for key, value in (("series", m.series_title), ("season", m.season), ("episode", m.episode),
                               ("channel", m.artist), ("contentId", m.content_id)):
                if value:
                    playing[key] = value
            if m.adjusted_current_time is not None:
                playing["position"] = m.adjusted_current_time
            if m.duration:
                playing["duration"] = m.duration
            images = [i.url for i in m.images or [] if getattr(i, "url", None)]
            if images:
                playing["images"] = images
            out["nowPlaying"] = playing
        return out

    def refresh(self) -> None:
        # MediaController.update_status() goes through send_message(), which LAUNCHES the
        # default media receiver when the app on the screen lacks the media namespace.
        with contextlib.suppress(Exception):
            socket = self.cc.socket_client
            if not socket.is_connected:
                return
            socket.receiver_controller.update_status()
            media = self.cc.media_controller
            if media.namespace in socket.app_namespaces:
                media.send_message_nocheck({"type": "GET_STATUS"})

    def seek(self, seconds: float) -> None:
        """Jumps to `seconds`, playing or paused as it was (MediaController.seek() would
        resume a paused title). Blocking: run it on a thread. Raises when the TV says no."""
        done, answer = threading.Event(), {}

        def answered(ok, _data=None):
            answer["ok"] = ok
            done.set()

        # send_message() inside refuses (UnsupportedNamespace) rather than launch anything.
        self.cc.media_controller._send_command({"type": "SEEK", "currentTime": max(0.0, float(seconds))}, answered)
        if not done.wait(SEEK_WAIT) or not answer.get("ok"):
            raise RuntimeError("The TV didn't take the seek")

    def close(self) -> None:
        with contextlib.suppress(Exception):
            self.cc.disconnect(timeout=1)


def cast_link(host: str) -> CastLink | None:
    """A Cast link to the TV at `host`, or None without pychromecast (or HOUSE_TV_CAST=off)."""
    if os.environ.get("HOUSE_TV_CAST", "").lower() in ("0", "off", "no"):
        return None
    try:
        return CastLink(host)
    except ImportError:
        log.info("pychromecast isn't installed: no now playing over Cast (pip install -r requirements.txt)")
    except Exception as e:
        log.warning("Cast link to %s: %s", host, e)
    return None


# ---------- adb ----------

ADB_STATES = {0: "none", 1: "stopped", 2: "paused", 3: "playing", 4: "playing", 5: "playing", 6: "buffering",
              7: "error", 8: "connecting", 9: "playing", 10: "playing", 11: "playing"}


def parse_media_sessions(text: str) -> list[dict]:
    """`adb shell dumpsys media_session` as one dict per session: package, active, state,
    position (seconds), title and subtitle (from its metadata's description)."""
    sessions: list[dict] = []
    cur: dict | None = None
    for line in (text or "").splitlines():
        s = line.strip()
        if s.startswith("package="):
            cur = {"package": s[len("package="):]}
            sessions.append(cur)
        elif cur is None:
            continue
        elif s.startswith("active="):
            cur["active"] = s.endswith("true")
        elif s.startswith("state=PlaybackState"):
            m = re.search(r"state=(?:[A-Z_]+\()?(\d+)\)?, position=(-?\d+)", s)
            if m:
                cur["state"] = ADB_STATES.get(int(m.group(1)), "unknown")
                cur["position"] = max(0, int(m.group(2)) // 1000)
        elif s.startswith("metadata:"):
            m = re.search(r"description=(.*)$", s)
            if m:
                parts = [p for p in m.group(1).split(", ") if p and p != "null"]
                if parts:
                    cur["title"] = parts[0]
                    if len(parts) > 1:
                        cur["subtitle"] = ", ".join(parts[1:])
    return sessions


def from_adb(sessions: list[dict] | None, app: dict | None, at: float) -> dict | None:
    """The media session of the app on the screen as the panel's nowPlaying (not scrubbable)."""
    package = (app or {}).get("package")
    mine = [s for s in sessions or [] if s.get("package") == package and s.get("title")
            and s.get("state") in ("playing", "paused", "buffering")]
    if not mine:
        return None
    s = sorted(mine, key=lambda s: not s.get("active"))[0]
    return {"title": s["title"], "subtitle": s.get("subtitle"), "state": s["state"],
            "position": float(s["position"]) if "position" in s else None, "duration": None, "seekable": False,
            "artwork": None, "app": (app or {}).get("id"), "at": round(at, 3)}


class Adb:
    """adb, paired with the TV on the Mac (tv-remote's fallback). Reads a TV's media sessions
    at most every few seconds; finds the TV's serial by its address (`adb devices`, then
    `adb mdns services` for a wireless-debugging pairing)."""

    def __init__(self, path: str):
        self.path = path
        self._serials: dict[str, tuple[str | None, float]] = {}   # host -> (serial, until)
        self._read: dict[str, tuple[float, list[dict] | None]] = {}

    @classmethod
    def find(cls) -> Adb | None:
        """adb when it is there (HOUSE_TV_ADB=<path>, or on the PATH, or Homebrew's), None
        when not, or when HOUSE_TV_ADB=off."""
        given = os.environ.get("HOUSE_TV_ADB", "")
        if given.lower() in ("0", "off", "no"):
            return None
        for path in (given, shutil.which("adb"), "/opt/homebrew/bin/adb"):
            if path and os.access(path, os.X_OK):
                return cls(path)
        return None

    async def _run(self, *args: str, timeout: float = 4.0) -> str:
        proc = await asyncio.create_subprocess_exec(self.path, *args, stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.DEVNULL)
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout)
        except asyncio.TimeoutError:
            with contextlib.suppress(ProcessLookupError):
                proc.kill()
            raise
        return out.decode(errors="replace")

    async def serial(self, host: str) -> str | None:
        known = self._serials.get(host)
        if known and (known[0] or time.monotonic() < known[1]):
            return known[0]
        serial = None
        with contextlib.suppress(OSError, asyncio.TimeoutError):
            attached = [l.split()[0] for l in (await self._run("devices")).splitlines()[1:] if l.strip().endswith("device")]
            serial = next((s for s in attached if s.startswith(f"{host}:")), None)
            if serial is None:
                for line in (await self._run("mdns", "services")).splitlines():
                    parts = line.split()
                    if len(parts) >= 3 and parts[1].startswith("_adb-tls-connect") and parts[2].split(":")[0] == host:
                        serial = next((s for s in attached if s.startswith(parts[0])), None)
                        if serial:
                            break
        self._serials[host] = (serial, time.monotonic() + ADB_RETRY)
        return serial

    async def sessions(self, host: str) -> list[dict] | None:
        last = self._read.get(host)
        if last and time.monotonic() - last[0] < ADB_EVERY:
            return last[1]
        result = None
        serial = await self.serial(host)
        if serial:
            try:
                result = parse_media_sessions(await self._run("-s", serial, "shell", "dumpsys", "media_session"))
            except (OSError, asyncio.TimeoutError) as e:
                log.info("adb on %s: %s", host, e)
                self._serials.pop(host, None)
        self._read[host] = (time.monotonic(), result)
        return result


CastFactory = Callable[[str], "CastLink | None"]
