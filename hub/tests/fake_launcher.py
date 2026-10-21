"""A pretend TV launcher (tv-launcher/, port 8686) for testing the hub without the TV:
`python tests/fake_launcher.py [port]`, then pair with `python house.py --pair-tv 127.0.0.1:<port>`
(the code is 4821).

It answers the routes the hub uses, the way tv-launcher's CompanionServer does: the long-polled
/api/state, /api/cmd (with what each command does to the state), the pictures, and pairing.
Every /api call needs the token in X-LR-Key.
"""
from __future__ import annotations

import asyncio
import contextlib
import copy
import sys
import time

from aiohttp import web

TOKEN = "0123456789abcdef01234567"
CODE = "4821"
ART = b"\xff\xd8\xff\xe0fake-jpeg"
BANNER = b"\x89PNG\r\n\x1a\nfake-png"
APPS = {"com.google.android.youtube.tv": "YouTube", "com.netflix.ninja": "Netflix", "com.hulu.livingroomplus": "Hulu"}
# The links each app opens (its own https hosts), like their intent filters on the TV.
LINKS = {"com.netflix.ninja": ("www.netflix.com",), "com.google.android.youtube.tv": ("www.youtube.com",)}


def youtube_paused() -> dict:
    """Riley's TV on Oct 20: a paused YouTube video in front, with its artwork."""
    now = int(time.time() * 1000)
    return {
        "rev": 1, "serverTime": now,
        "tv": {"name": "Living Room", "awake": True, "screen": "app",
               "foreground": {"pkg": "com.google.android.youtube.tv", "label": "YouTube"},
               "volume": 8, "volumeMax": 15, "muted": False, "volumeFixed": False},
        "caps": {"keys": True, "media": True}, "textField": False, "owner": "Riley", "wallpaper": False, "tailnet": None,
        "now": {"pkg": "com.google.android.youtube.tv", "app": "YouTube",
                "title": "Episode P - Bretz in the Scablands", "subtitle": "Nick Zentner",
                "state": "paused", "positionMs": 420_000, "durationMs": 9_535_000, "speed": 0.0,
                "measuredAt": now, "canSeek": True, "art": "art/now?v=1a2b3c"},
        "apps": [{"pkg": p, "label": n, "color": "#ff0000"} for p, n in APPS.items()],
        "continue": [],
    }


class FakeLauncher:
    def __init__(self, state: dict | None = None, hold: float = 25.0):
        self.state = state or youtube_paused()
        self.hold = hold              # how long a long poll waits for news
        self.sent: list[dict] = []    # every /api/cmd body
        self.broken = False           # answer 500 to everything, like an app that fell over
        self.pairing: str | None = None
        self.changed = asyncio.Event()
        self.polls = 0

    def update(self, **tv) -> None:
        """Changes the TV (keys of state["tv"], or `now=`), the way the launcher bumps its rev."""
        now = tv.pop("now", "same")
        self.state["tv"].update(tv)
        if now != "same":
            self.state["now"] = now
            if now is None:
                self.state.pop("now")
        self.bump()

    def bump(self) -> None:
        self.state["rev"] += 1
        self.changed.set()
        self.changed = asyncio.Event()

    # ---------- what each command does ----------

    def run(self, cmd: dict) -> bool:
        t, now = self.state["tv"], self.state.get("now")
        kind = cmd.get("type")
        if kind == "key":
            return self.state["caps"]["keys"] and cmd.get("key") in ("up", "down", "left", "right", "ok", "center", "back", "home")
        if kind == "media":
            if not now:
                return False
            action = cmd.get("action")
            if action in ("toggle", "play", "pause"):
                playing = now["state"] == "playing"
                now["state"] = "playing" if (action == "play" or (action == "toggle" and not playing)) else "paused"
            elif action == "seekBy":
                now["positionMs"] = max(0, now["positionMs"] + int(cmd.get("ms", 10_000)))
            else:
                return False
        elif kind == "seek":
            if not now or not now["canSeek"] or "positionMs" not in cmd:
                return False
            now["positionMs"] = max(0, min(int(cmd["positionMs"]), now["durationMs"]))
            now["measuredAt"] = int(time.time() * 1000)
        elif kind == "volume":
            if "level" in cmd:
                if t["volumeFixed"] or not isinstance(cmd["level"], int):
                    return False
                t["volume"] = max(0, min(cmd["level"], t["volumeMax"]))
            else:
                t["volume"] = max(0, min(t["volume"] + int(cmd.get("delta", 0)), t["volumeMax"]))
        elif kind == "mute":
            t["muted"] = not t["muted"]
        elif kind in ("wake", "sleep", "power"):
            t["awake"] = kind == "wake" or (kind == "power" and not t["awake"])
        elif kind == "launch":
            if cmd.get("pkg") not in APPS:
                return False
            t["foreground"] = {"pkg": cmd["pkg"], "label": APPS[cmd["pkg"]]}
            t["screen"] = "app"
        elif kind == "open":
            url, pkg = cmd.get("url") or "", cmd.get("pkg")
            if not url.startswith("https://") or url.split("/")[2] not in LINKS.get(pkg, ()):
                return False
            t["foreground"] = {"pkg": pkg, "label": APPS[pkg]}
        elif kind == "text":
            return bool(self.state["textField"])
        elif kind == "submit":
            return bool(self.state["textField"])
        else:
            return False
        self.state["serverTime"] = int(time.time() * 1000)
        self.bump()
        return True

    # ---------- the routes ----------

    def app(self) -> web.Application:
        def paired(request) -> bool:
            return (request.headers.get("X-LR-Key") or request.query.get("k")) == TOKEN

        async def state(request):
            if self.broken:
                return web.Response(status=500, text="Error")
            if not paired(request):
                return web.json_response({"error": "pair"}, status=401)
            self.polls += 1
            since = int(request.query.get("since", "-1"))
            if self.state["rev"] <= since:
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(self.changed.wait(), self.hold)
            out = copy.deepcopy(self.state)
            out["serverTime"] = int(time.time() * 1000)
            return web.json_response(out)

        async def cmd(request):
            if self.broken:
                return web.Response(status=500, text="Error")
            if not paired(request):
                return web.json_response({"error": "pair"}, status=401)
            body = await request.json()
            self.sent.append(body)
            return web.json_response({"ok": self.run(body)})

        async def art_now(_):
            return web.Response(body=ART, content_type="image/jpeg") if self.state.get("now") else web.Response(status=404)

        async def banner(request):
            pkg = request.match_info["pkg"]
            return web.Response(body=BANNER, content_type="image/png") if pkg in APPS else web.Response(status=404, text="No image")

        async def hello(request):
            return web.json_response({"name": self.state["tv"]["name"], "id": "5e1f00aa77bb", "v": 1,
                                      "paired": paired(request), "tailnet": None})

        async def start(_):
            self.pairing = CODE
            return web.json_response({"ok": self.state["caps"]["keys"]})

        async def finish(request):
            code = (await request.json()).get("code")
            if self.pairing and code == self.pairing:
                self.pairing = None
                return web.json_response({"token": TOKEN, "name": self.state["tv"]["name"], "id": "5e1f00aa77bb"})
            return web.json_response({"error": "code"}, status=403)

        async def cancel(_):
            self.pairing = None
            return web.json_response({"ok": True})

        app = web.Application()
        app.router.add_get("/api/state", state)
        app.router.add_post("/api/cmd", cmd)
        app.router.add_get("/art/now", art_now)
        app.router.add_get("/banner/{pkg}", banner)
        app.router.add_get("/pair/hello", hello)
        app.router.add_post("/pair/start", start)
        app.router.add_post("/pair/finish", finish)
        app.router.add_post("/pair/cancel", cancel)
        return app


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8686
    print(f"A pretend TV launcher on port {port} (pairing code {CODE})")
    web.run_app(FakeLauncher().app(), host="127.0.0.1", port=port, print=None)
