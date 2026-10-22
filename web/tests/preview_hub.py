"""Deterministic home for browser acceptance checks. It never connects to hardware."""
import asyncio
import copy
import json
from pathlib import Path

from aiohttp import web

ROOT = Path(__file__).resolve().parents[2]
plan = json.loads((ROOT / "web/public/plans/riley.json").read_text())
plan.pop("site", None)
plan["scenes"] = [
    {"id": "bright", "name": "Bright", "icon": "sun", "lights": {"*": {"on": True, "brightness": 1}}},
    {"id": "movie", "name": "Movie night", "icon": "film", "lights": {"*": {"on": True, "brightness": 0.2}},
     "acs": {"studio.ac": {"on": True, "target": 72}}, "tvs": {"test-tv": {"app": "netflix", "name": "Netflix"}}},
    {"id": "night", "name": "Night", "icon": "moon", "lights": {"*": {"on": True, "brightness": 0.1}}},
]
plan["tileOrder"] = ["tv:test-tv", "studio.ac", "speaker:spotify"]
initial = copy.deepcopy(plan)
state = {"lights": {l["id"]: {"on": True, "brightness": 0.8, "temp": 2700} for l in plan["lights"]},
         "acs": {"studio.ac": {"on": True, "target": 74, "mode": "cool", "fan": "high", "swing": "swing", "roomTemp": 76}},
         "features": {}, "scene": None}
tv = {"available": True, "error": "", "devices": [{"id": "test-tv", "name": "Studio TV", "online": True,
      "on": True, "volume": 10, "volumeMax": 25, "muted": False, "caps": ["volume", "keys", "apps"],
      "app": {"id": "home", "name": "Living Room"}, "nowPlaying": None}]}
spotify = {"available": True, "backend": "connect", "error": "", "playing": False, "volume": 35,
           "canTransfer": True, "canSeek": True, "device": "echo", "devices": [{"id": "echo", "name": "Studio Echo"},
           {"id": "mac", "name": "MacBook"}], "track": {"title": "A quiet evening", "artist": "Studio Sessions",
           "duration": 240, "position": 48}}
sent = []
listeners = set()
initial_state, initial_tv, initial_spotify = copy.deepcopy((state, tv, spotify))


async def publish(value):
    for queue in listeners:
        queue.put_nowait(value)


async def index(_):
    html = (ROOT / "web/dist/index.html").read_text()
    boot = {"hub": True, "config": plan, "rev": 1}
    return web.Response(text=html.replace("<head>", "<head><script>window.__HOUSE_BOOT__=" + json.dumps(boot) + "</script>", 1), content_type="text/html")


async def events(request):
    response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
    await response.prepare(request)
    queue = asyncio.Queue()
    listeners.add(queue)
    try:
        await response.write(f"data: {json.dumps(state)}\n\n".encode())
        await response.write(f"data: {json.dumps({'tv': tv})}\n\n".encode())
        while True:
            message = await queue.get()
            await response.write(f"data: {json.dumps(message)}\n\n".encode())
    except (ConnectionResetError, asyncio.CancelledError):
        pass
    finally:
        listeners.discard(queue)
    return response


async def call(request):
    body = await request.json()
    sent.append(body)
    if body.get("type") == "savePlan":
        plan.clear()
        plan.update(body["config"])
    elif body.get("type") == "command":
        collection = "lights" if body["kind"] == "light" else "acs"
        state[collection][body["id"]].update(body["patch"])
        await publish({collection: state[collection]})
    return web.json_response({"ok": True})


async def tv_action(request):
    body = await request.json()
    sent.append({"route": "tv", **body})
    if body["action"] == "volume":
        tv["devices"][0]["volume"] = body["level"]
    if body["action"] == "open":
        tv["devices"][0]["app"] = {"id": body["app"], "name": body.get("name", body["app"])}
    await publish({"tv": tv})
    return web.json_response({"ok": True})


async def spotify_action(request):
    body = await request.json()
    sent.append({"route": "spotify", **body})
    if body["action"] in {"play", "pause"}:
        spotify["playing"] = body["action"] == "play"
    elif body["action"] == "transfer":
        spotify["device"] = body["device"]
    elif body["action"] == "volume":
        spotify["volume"] = body["level"]
    elif body["action"] == "seek":
        spotify["track"]["position"] = body["position"]
    return web.json_response({"ok": True})


async def reset(_):
    plan.clear()
    plan.update(copy.deepcopy(initial))
    for current, original in [(state, initial_state), (tv, initial_tv), (spotify, initial_spotify)]:
        current.clear()
        current.update(copy.deepcopy(original))
    sent.clear()
    return web.json_response({"ok": True})


async def debug(_):
    return web.json_response({"sent": sent, "plan": plan})


async def get_plan(_):
    return web.json_response(plan)


async def get_tv(_):
    return web.json_response(tv)


async def get_spotify(_):
    return web.json_response(spotify)


async def get_playlists(request):
    sent.append({"route": "playlists", "offset": request.query.get("offset", "0")})
    first = request.query.get("offset", "0") == "0"
    return web.json_response({"available": True, "backend": "connect", "items": [
        {"id": "37i9dQZF1DXcBWIGoYBM5M" if first else "37i9dQZF1DX0XUsuxWHRQd",
         "uri": "spotify:playlist:" + ("37i9dQZF1DXcBWIGoYBM5M" if first else "37i9dQZF1DX0XUsuxWHRQd"),
         "name": "Evening mix" if first else "Morning mix", "owner": "Riley"}], "next": 50 if first else None})


app = web.Application()
app.add_routes([web.get("/", index), web.get("/api/events", events), web.post("/api/call", call),
                web.get("/api/plan", get_plan), web.get("/api/tv", get_tv), web.post("/api/tv/{id}", tv_action),
                web.get("/api/spotify", get_spotify), web.post("/api/spotify", spotify_action),
                web.get("/api/spotify/playlists", get_playlists),
                web.post("/test/reset", reset), web.get("/test/state", debug)])
app.router.add_static("/", ROOT / "web/dist")
if __name__ == "__main__":
    web.run_app(app, host="127.0.0.1", port=8798, access_log=None)
