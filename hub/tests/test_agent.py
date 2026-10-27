"""The house agent (agent.py, agent_mcp.py): the tools against pretend devices, the MCP server, and
the runner with a pretend Codex that starts the MCP server the way the real one does."""
from __future__ import annotations

import asyncio
import copy
import json
import os
import sys
from pathlib import Path

import aiohttp
import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import agent as agents  # noqa: E402
import fake_wiz  # noqa: E402
import house  # noqa: E402
import mrcool  # noqa: E402
from test_hub import fake_cielo  # noqa: E402

PORT = 38981  # the pretend lights' port: no real light answers a test
RILEY = HERE.parent.parent / "web" / "public" / "plans" / "riley.json"
needs_fake_lights = pytest.mark.skipif(
    not fake_wiz.addresses_ready(), reason="the pretend WiZ lights need 127.0.0.2-4 (see fake_wiz.addresses_ready)")


def run(coro):
    return asyncio.run(coro)


def riley(linked: bool = True) -> dict:
    plan = json.loads(RILEY.read_text())
    plan.pop("site", None)
    if not linked:
        for d in [*plan["lights"], *plan["acs"]]:
            d.pop("link", None)
    return plan


def text(result: dict) -> str:
    return result["content"][0]["text"]


def make_hub(tmp_path: Path, plan: dict) -> house.Hub:
    (tmp_path / "plan.json").write_text(json.dumps(plan))
    hub = house.Hub(tmp_path)
    hub._rebuild_plan()
    return hub


async def serve(hub: house.Hub) -> tuple[TestClient, str]:
    """The hub's routes on loopback, without starting its devices."""
    app = house.make_app(hub)
    app.on_startup.clear()
    app.on_cleanup.clear()
    client = TestClient(TestServer(app))
    await client.start_server()
    return client, str(client.make_url("")).rstrip("/")


# ---------- names ----------

def test_loose_names(tmp_path):
    hub = make_hub(tmp_path, riley(linked=False))
    t = hub.agent.tools
    ids = lambda q: [d["id"] for d in t._match(q, t.lights, agents.LIGHT_WORDS, "lights")]  # noqa: E731
    assert ids("kitchen") == ["kitchen.edison", "kitchen.counter"]
    assert ids("the kitchen lights") == ["kitchen.edison", "kitchen.counter"]
    assert ids("Counter Lights") == ["kitchen.counter"]
    assert ids("window lamp") == ["studio.window"]
    assert ids("the lamp by the window") == ["studio.window"]
    assert ids("kitchen.edison") == ["kitchen.edison"]
    assert ids("edison") == ["kitchen.edison"]
    assert ids("counter lite") == ["kitchen.counter"]   # as speech hears it
    assert ids("studio") == ["studio.window", "studio.door"]
    assert ids(["edison", "door light"]) == ["kitchen.edison", "studio.door"]
    assert len(ids("all")) == len(ids("lights")) == len(t.lights)
    with pytest.raises(agents.ToolError, match="No light called \"garage\""):
        ids("garage")
    assert [d["id"] for d in t._match("bedroom AC", t.acs, agents.AC_WORDS, "ACs")] == ["studio.ac"]
    assert [d["id"] for d in t._match("the air conditioner", t.acs, agents.AC_WORDS, "ACs")] == ["studio.ac"]

    plan = riley(linked=False)
    plan["rooms"] += [{"id": "office", "name": "Office", "rect": [0, 8, 3, 3]}, {"id": "bedroom", "name": "Bedroom", "rect": [3, 8, 3, 3]}]
    plan["lights"] += [{"id": "office.desk", "name": "Desk Lamp", "room": "office", "capabilities": []},
                       {"id": "bedroom.desk", "name": "Desk Light", "room": "bedroom", "capabilities": ["brightness"]}]
    hub = make_hub(tmp_path, plan)
    t = hub.agent.tools
    with pytest.raises(agents.ToolError, match="could be Desk Lamp .Office., Desk Light .Bedroom."):
        ids("desk")
    assert ids("bedroom light") == ["bedroom.desk"]
    assert ids("office desk lamp") == ["office.desk"]

    assert agents.app_id("Disney Plus") == "disney" and agents.app_id("prime") == "prime"
    assert agents.app_id("HBO Max") == "max" and agents.app_id("netflix") == "netflix" and agents.app_id("Fubo") is None


def test_get_home_and_pretend_devices(tmp_path):
    async def go():
        hub = make_hub(tmp_path, riley(linked=False))
        async with aiohttp.ClientSession() as http:
            hub.http = hub.spotify.http = hub.tv.http = http
            heard: asyncio.Queue = asyncio.Queue()
            hub.listeners.add(heard)
            t = hub.agent.tools
            home = await t.call("get_home", {})
            assert not home["isError"] and "Kitchen [kitchen]" in text(home) and "Edison Bulb [kitchen.edison]" in text(home)
            assert "Scenes: Bright [bright], Cozy [cozy], Night [night], All off [off]" in text(home)
            assert "Bedroom AC [studio.ac] AC (61–86°F" in text(home)
            assert home["structuredContent"]["rooms"][0]["lights"][0]["id"] == "kitchen.edison"
            # Not linked to real lights: the panels' pretend ones hear the change.
            r = await t.call("set_lights", {"lights": "studio", "brightness": 40})
            assert not r["isError"] and r["summary"] == "Studio lights → 40%"
            assert hub.state["lights"]["studio.door"] == {"on": True, "brightness": 0.4}
            assert heard.get_nowait()["lights"]["studio.window"]["brightness"] == 0.4
            assert "Studio · Door Light: on, 40%" in text(r)
            # The colour goes to the light that has one; the other is told about.
            r = await t.call("set_lights", {"lights": ["window light", "door"], "color": "blue"})
            assert hub.state["lights"]["studio.window"]["color"] == agents.COLORS["blue"]
            assert "Door Light has no colour" in text(r) and r["summary"] == "Window Light → blue"
            r = await t.call("set_lights", {"lights": "door light", "kelvin": 2700})
            assert r["isError"] and "Door Light has no adjustable white" in text(r)
            r = await t.call("set_lights", {"lights": "garage"})
            assert r["isError"] and "garage" in text(r)
            r = await t.call("nope", {})
            assert r["isError"] and "There is no tool nope" in text(r)
            r = await t.call("set_climate", {"target": 72})
            assert not r["isError"] and hub.state["acs"]["studio.ac"] == {"on": True, "target": 72}
            assert r["summary"] == "Bedroom AC → 72°F"
            r = await t.call("set_climate", {"target": 99})
            assert r["isError"] and "goes from 61 to 86°F" in text(r)
            r = await t.call("activate_scene", {"scene": "cozy"})
            assert r["summary"] == "Scene · Cozy" and hub.state["lights"]["kitchen.edison"]["temp"] == 2700
            assert hub.state["lights"]["kitchen.counter"] == {"on": True, "brightness": 0.45}  # no white on a colour strip
            r = await t.call("activate_scene", {"scene": "the movie scene"})
            assert r["isError"] and "Scenes: Bright, Cozy, Night, All off" in text(r)
            r = await t.call("tv", {"action": "up"})
            assert r["isError"]  # no TV answers in a test
    run(go())


@needs_fake_lights
def test_tools_drive_the_pretend_lights_and_ac(tmp_path, monkeypatch):
    monkeypatch.setattr(fake_wiz, "LIGHTS", copy.deepcopy(fake_wiz.LIGHTS))  # the other tests' lights start as they were

    async def go():
        bulbs = await fake_wiz.serve(PORT)
        cielo, actions = await fake_cielo()
        monkeypatch.setattr(mrcool, "BASE_URL", str(cielo.make_url("/openapi/v1")))
        monkeypatch.setenv("HOUSE_HUB_WIZ_PORT", str(PORT))
        (tmp_path / "mrcool.json").write_text(json.dumps({"api_key": "test-key"}))
        hub = make_hub(tmp_path, riley())
        hub.wiz.broadcast = [l["ip"] for l in fake_wiz.LIGHTS]
        http = aiohttp.ClientSession()
        hub.http = hub.spotify.http = hub.tv.http = http
        hub.mrcool = mrcool.MrcoolClient(tmp_path / "mrcool.json", http)
        await hub.wiz.start()
        try:
            await hub.wiz.discover(wait=0.3)
            await hub._read_acs()
            hub._publish_acs()
            await hub._poll_lights()
            t = hub.agent.tools
            assert "Edison Bulb [kitchen.edison] light (dims, white 2200–6500 K): on, 60%, 2700 K" in text(await t.call("get_home", {}))
            r = await t.call("set_lights", {"lights": "kitchen", "brightness": 30})
            assert not r["isError"] and r["summary"] == "Kitchen lights → 30%"
            assert bulbs[0].light["pilot"]["dimming"] == 30
            assert bulbs[1].light["pilot"]["state"] is True and bulbs[1].light["pilot"]["dimming"] == 30
            r = await t.call("set_lights", {"lights": "window light", "on": False})
            assert bulbs[2].light["pilot"]["state"] is False and "Studio · Window Light: off" in text(r)
            r = await t.call("activate_scene", {"scene": "Night"})
            assert not r["isError"] and bulbs[0].light["pilot"]["dimming"] == 10 and bulbs[2].light["pilot"]["state"] is True
            r = await t.call("set_climate", {"ac": "bedroom", "mode": "cool", "target": 72})
            assert not r["isError"] and r["summary"] == "Bedroom AC → 72°F cool"
            assert [a["action_type"] for a in actions] == ["mode", "set_point"] and actions[-1]["actions"]["set_point"] == 72
            assert "Bedroom AC: on, cool, target 72°F, fan high (room 75°F)" in text(r)
            r = await t.call("set_climate", {"fan": "turbo"})
            assert r["isError"] and "fan speeds: auto, low, medium, high" in text(r)
            r = await t.call("set_climate", {"on": False})
            assert actions[-1]["action_type"] == "power" and r["summary"] == "Bedroom AC → off"
        finally:
            hub.wiz.close()
            await http.close()
            await cielo.close()
            for b in bulbs:
                b.transport.close()
    run(go())


class FakeSpotify:
    def __init__(self):
        self.sent: list[dict] = []
        self.st = {"available": True, "playing": False, "device": "echo", "volume": 35,
                   "devices": [{"id": "echo", "name": "Studio Echo"}, {"id": "mac", "name": "MacBook"}],
                   "track": {"title": "A quiet evening", "artist": "Studio Sessions"}}

    async def state(self, **_):
        return self.st

    async def act(self, body, **_):
        self.sent.append(body)
        if body["action"] == "play":
            self.st["playing"] = True
        return {"ok": True}, 200

    async def playlists(self, offset=0, **_):
        items = [{"id": "a" * 22, "uri": "spotify:playlist:" + "a" * 22, "name": "Evening mix"},
                 {"id": "b" * 22, "uri": "spotify:playlist:" + "b" * 22, "name": "Morning Coffee"}]
        return ({"items": items, "next": None} if offset == 0 else {"items": [], "next": None}), 200


def test_tv_speaker_and_picks(tmp_path):
    async def go():
        hub = make_hub(tmp_path, riley(linked=False))
        hub.tv.state = {"available": True, "error": "", "devices": [{
            "id": "tv1", "name": "Studio TV", "online": True, "on": True, "volume": 10, "volumeMax": 25, "muted": False,
            "app": {"id": "home", "name": "Living Room"}, "nowPlaying": None}]}
        told: list[tuple[str, dict]] = []

        async def act(tv_id, body):
            told.append((tv_id, body))
            return ({"error": "That isn't a Netflix link"}, 400) if body.get("link") == "bad" else ({"ok": True}, 200)

        async def search(q):
            return {"results": [{"title": "The Goonies", "year": 1985, "type": "movie", "rentOrBuy": [],
                                 "offers": [{"app": "max", "name": "Max", "how": "subscription", "link": "https://play.max.com/movie/x"}]},
                                {"title": "Goonies Never Say Die", "year": 2010, "type": "movie", "offers": [],
                                 "rentOrBuy": ["Apple TV (rent)"]}]}, 200

        hub.tv.act = act
        hub.tv.search = search
        hub.spotify = FakeSpotify()
        t = hub.agent.tools
        r = await t.call("tv", {"action": "open", "app": "Netflix"})
        assert not r["isError"] and told[-1] == ("tv1", {"action": "open", "app": "netflix", "name": "Netflix"})
        assert r["summary"] == "TV · Netflix"
        r = await t.call("tv", {"action": "volume", "level": 40})
        assert told[-1][1] == {"action": "volume", "level": 25} and r["summary"] == "TV volume → 25"
        await t.call("tv", {"action": "volume up"})
        assert told[-1][1] == {"action": "volup"}
        r = await t.call("tv", {"action": "dance"})
        assert r["isError"] and "can't do" in text(r)
        r = await t.call("find_title", {"query": "the goonies"})
        assert "The Goonies (1985, movie): Max [app max] link https://play.max.com/movie/x" in text(r)
        assert "Goonies Never Say Die (2010, movie): not on the TV's apps (only Apple TV (rent))" in text(r)
        r = await t.call("play_title", {"app": "Max", "link": "https://play.max.com/movie/x"})
        assert not r["isError"] and told[-1][1] == {"action": "play", "app": "max", "link": "https://play.max.com/movie/x"}
        r = await t.call("play_title", {"app": "netflix", "link": "bad"})
        assert r["isError"] and text(r) == "That isn't a Netflix link"
        r = await t.call("speaker", {"action": "play_playlist", "name": "evening"})
        assert hub.spotify.sent[-1] == {"action": "play", "uri": "spotify:playlist:" + "a" * 22}
        assert r["summary"] == "Playing “Evening mix”" and "playing \"A quiet evening\" by Studio Sessions on Studio Echo" in text(r)
        r = await t.call("speaker", {"action": "transfer", "device": "the macbook"})
        assert hub.spotify.sent[-1] == {"action": "transfer", "device": "mac"} and r["summary"] == "Music → MacBook"
        r = await t.call("speaker", {"action": "volume", "level": 140})
        assert hub.spotify.sent[-1] == {"action": "volume", "level": 100}
        r = await t.call("speaker", {"action": "transfer", "device": "kitchen radio"})
        assert r["isError"] and "Outputs: Studio Echo, MacBook" in text(r)
        assert text(await t.call("picks", {})) == "There are no picks yet"
        (tmp_path / "smart-evening.json").write_text(json.dumps({"generatedAt": "2026-10-27T16:30:00", "picks": [
            {"title": "Back to the Future", "year": 1985, "kind": "movie", "app": "netflix",
             "link": "https://www.netflix.com/title/60010110", "tvLink": None}]}))
        r = await t.call("picks", {})
        assert "Back to the Future (1985, movie) · Netflix [app netflix] link https://www.netflix.com/title/60010110" in text(r)
    run(go())


# ---------- the MCP server ----------

async def mcp_server(url: str):
    proc = await asyncio.create_subprocess_exec(sys.executable, str(agents.MCP_SERVER), stdin=asyncio.subprocess.PIPE,
                                                stdout=asyncio.subprocess.PIPE, env={**os.environ, "HOUSE_HUB_URL": url})

    async def rpc(msg: dict):
        proc.stdin.write((json.dumps(msg) + "\n").encode())
        await proc.stdin.drain()
        if "id" not in msg:
            return None
        return json.loads(await asyncio.wait_for(proc.stdout.readline(), 10))
    return proc, rpc


def test_mcp_server_round_trip(tmp_path):
    async def go():
        hub = make_hub(tmp_path, riley(linked=False))
        client, url = await serve(hub)
        proc, rpc = await mcp_server(url)
        try:
            init = await rpc({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                              "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "test"}}})
            assert init["result"]["protocolVersion"] == "2025-03-26" and init["result"]["serverInfo"]["name"] == "house"
            assert init["result"]["capabilities"] == {"tools": {"listChanged": False}}
            assert await rpc({"jsonrpc": "2.0", "method": "notifications/initialized"}) is None
            assert (await rpc({"jsonrpc": "2.0", "id": 2, "method": "ping"}))["result"] == {}
            listed = (await rpc({"jsonrpc": "2.0", "id": 3, "method": "tools/list"}))["result"]["tools"]
            assert [t["name"] for t in listed] == [t["name"] for t in agents.TOOLS]
            assert all(t["annotations"]["destructiveHint"] is False and t["annotations"]["openWorldHint"] is False for t in listed)
            assert listed[1]["inputSchema"]["required"] == ["lights"]
            got = (await rpc({"jsonrpc": "2.0", "id": 4, "method": "tools/call",
                              "params": {"name": "set_lights", "arguments": {"lights": "kitchen", "on": False}}}))["result"]
            assert got["isError"] is False and "Kitchen · Edison Bulb: off" in got["content"][0]["text"]
            assert hub.state["lights"]["kitchen.counter"]["on"] is False
            got = (await rpc({"jsonrpc": "2.0", "id": "five", "method": "tools/call", "params": {"name": "get_home"}}))
            assert got["id"] == "five" and got["result"]["structuredContent"]["home"] == "Riley's Studio"
            got = (await rpc({"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "launch_rockets"}}))["result"]
            assert got["isError"] is True and "There is no tool launch_rockets" in got["content"][0]["text"]
            assert (await rpc({"jsonrpc": "2.0", "id": 7, "method": "resources/list"}))["error"]["code"] == -32601
            # Only on the hub computer itself: Tailscale Serve's forwarding comes from loopback too.
            r = await client.get("/api/agent/tools", headers={"X-Forwarded-For": "100.64.0.9", "X-Forwarded-Proto": "https"})
            assert r.status == 403
            r = await client.post("/api/agent/tool/get_home", json={}, headers={"X-Forwarded-Proto": "https"})
            assert r.status == 403
        finally:
            proc.stdin.close()
            await asyncio.wait_for(proc.wait(), 5)
            await client.close()
        # A hub that isn't there: the call is an error result, not a dead server.
        proc, rpc = await mcp_server("http://127.0.0.1:9")
        try:
            got = (await rpc({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "get_home"}}))["result"]
            assert got["isError"] is True and "isn't answering" in got["content"][0]["text"]
            assert (await rpc({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}))["error"]["code"] == -32603
        finally:
            proc.stdin.close()
            await proc.wait()
    run(go())


# ---------- the runner ----------

FAKE_CODEX = r'''#!PYTHON
"""A pretend `codex exec --json`: starts the MCP server from its -c settings and calls one tool."""
import json, os, re, subprocess, sys, time

args = sys.argv[1:]
settings = dict(args[i + 1].split("=", 1) for i, a in enumerate(args) if a == "-c")
last = args[args.index("--output-last-message") + 1]
prompt = sys.stdin.read()
with open(os.environ["FAKE_CODEX_LOG"], "w") as f:
    json.dump({"args": args, "prompt": prompt}, f)
mode = os.environ.get("FAKE_CODEX_MODE", "ok")
if mode == "slow":
    time.sleep(30)
if mode == "signed-out":
    print("Error: you are not logged in. Run codex login", file=sys.stderr)
    sys.exit(1)

url = json.loads(re.search(r'HOUSE_HUB_URL\s*=\s*("[^"]*")', settings["mcp_servers.house.env"]).group(1))
mcp = subprocess.Popen([json.loads(settings["mcp_servers.house.command"]), *json.loads(settings["mcp_servers.house.args"])],
                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env={**os.environ, "HOUSE_HUB_URL": url})

def rpc(rid, method, params=None):
    mcp.stdin.write(json.dumps({"jsonrpc": "2.0", **({"id": rid} if rid is not None else {}), "method": method,
                                "params": params or {}}) + "\n")
    mcp.stdin.flush()
    return json.loads(mcp.stdout.readline()) if rid is not None else None

def emit(event):
    print(json.dumps(event), flush=True)

emit({"type": "thread.started", "thread_id": "t1"})
rpc(1, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "codex"}})
rpc(None, "notifications/initialized")
assert "set_lights" in [t["name"] for t in rpc(2, "tools/list")["result"]["tools"]]
call = {"lights": "kitchen", "brightness": 30}
if mode == "old":
    emit({"id": "0", "msg": {"type": "mcp_tool_call_begin", "call_id": "c1",
                             "invocation": {"server": "house", "tool": "set_lights", "arguments": call}}})
else:
    emit({"type": "item.started", "item": {"id": "item_1", "type": "mcp_tool_call", "server": "house", "tool": "set_lights",
                                           "arguments": call, "status": "in_progress"}})
result = rpc(3, "tools/call", {"name": "set_lights", "arguments": call})["result"]
print("not an event", flush=True)
if mode == "old":
    emit({"id": "0", "msg": {"type": "mcp_tool_call_end", "call_id": "c1", "result": {"Ok": result},
                             "invocation": {"server": "house", "tool": "set_lights", "arguments": call}}})
else:
    emit({"type": "item.completed", "item": {"id": "item_1", "type": "mcp_tool_call", "server": "house", "tool": "set_lights",
                                             "arguments": call, "status": "completed", "result": result}})
reply = "The kitchen is at 30 percent."
if mode == "old":
    emit({"id": "0", "msg": {"type": "agent_message", "message": reply}})
elif mode != "file-only":
    emit({"type": "item.completed", "item": {"id": "item_2", "type": "agent_message", "text": reply}})
with open(last, "w") as f:
    f.write(reply)
emit({"type": "turn.completed", "usage": {"input_tokens": 1, "output_tokens": 1}})
mcp.stdin.close()
mcp.wait()
'''


def fake_codex(tmp_path: Path, monkeypatch) -> Path:
    exe = tmp_path / "bin" / "codex"
    exe.parent.mkdir()
    exe.write_text(FAKE_CODEX.replace("PYTHON", sys.executable))
    exe.chmod(0o755)
    monkeypatch.setattr(agents, "find_codex", lambda: str(exe))
    monkeypatch.setenv("FAKE_CODEX_LOG", str(tmp_path / "codex-run.json"))
    (tmp_path / "taste.md").write_text("Loves 80s adventure films.")
    return tmp_path / "codex-run.json"


def agent_events(q: asyncio.Queue) -> list[dict]:
    out = []
    while not q.empty():
        msg = q.get_nowait()
        if "agent" in msg:
            out.append(msg["agent"])
    return out


@pytest.mark.parametrize("mode", ["ok", "old", "file-only"])
def test_runner_with_a_pretend_codex(tmp_path, monkeypatch, mode):
    record = fake_codex(tmp_path, monkeypatch)
    monkeypatch.setenv("FAKE_CODEX_MODE", mode)
    monkeypatch.setenv("HOUSE_AGENT_MODEL", "gpt-test")
    monkeypatch.delenv("HOUSE_AGENT_EFFORT", raising=False)

    async def go():
        hub = make_hub(tmp_path, riley(linked=False))
        client, url = await serve(hub)
        hub.agent.hub_url = url
        heard: asyncio.Queue = asyncio.Queue(maxsize=200)
        hub.listeners.add(heard)
        try:
            r = await client.post("/api/agent", json={"text": "  dim the kitchen\nto 30 ", "client": "tab-1"})
            answer = await r.json()
            assert r.status == 200, answer
            assert answer["ok"] is True and answer["reply"] == "The kitchen is at 30 percent."
            assert answer["steps"] == [{"tool": "set_lights", "text": "Kitchen lights → 30%", "ok": True}]
            assert hub.state["lights"]["kitchen.edison"]["brightness"] == 0.3
            events = agent_events(heard)
            assert events[0]["state"] == "thinking" and events[0]["text"] == "dim the kitchen to 30" and events[0]["client"] == "tab-1"
            assert any(e["state"] == "acting" for e in events)
            assert events[-1]["state"] == "done" and events[-1]["reply"] == answer["reply"] and events[-1]["steps"] == answer["steps"]
            assert len({e["id"] for e in events}) == 1
            ran = json.loads(record.read_text())
            args = ran["args"]
            assert args[:2] == ["exec", "--json"] and args[args.index("--sandbox") + 1] == "read-only" and args[-1] == "-"
            assert "--ephemeral" in args and "--skip-git-repo-check" in args and args[args.index("-m") + 1] == "gpt-test"
            settings = [args[i + 1] for i, a in enumerate(args) if a == "-c"]
            assert 'approval_policy="never"' in settings and 'model_reasoning_effort="low"' in settings
            assert f"mcp_servers.house.args=[{json.dumps(str(agents.MCP_SERVER))}]" in settings
            assert "Riley says: dim the kitchen to 30" in ran["prompt"] and "Loves 80s adventure films." in ran["prompt"]
            assert "Edison Bulb [kitchen.edison]" in ran["prompt"]
        finally:
            await client.close()
    run(go())


def test_runner_failures(tmp_path, monkeypatch):
    fake_codex(tmp_path, monkeypatch)

    async def go():
        hub = make_hub(tmp_path, riley(linked=False))
        heard: asyncio.Queue = asyncio.Queue(maxsize=200)
        hub.listeners.add(heard)
        monkeypatch.setenv("FAKE_CODEX_MODE", "signed-out")
        answer, status = await hub.agent.ask("lights off", client="phone")
        assert status == 502 and answer["ok"] is False and "codex login" in answer["error"]
        assert agent_events(heard)[-1]["state"] == "failed"
        monkeypatch.setenv("FAKE_CODEX_MODE", "slow")
        hub.agent.timeout = 1
        started = asyncio.get_running_loop().time()
        answer, status = await hub.agent.ask("lights off")
        assert status == 502 and "longer than 1 seconds" in answer["reply"]
        assert asyncio.get_running_loop().time() - started < 5
        assert (await hub.agent.ask("   "))[1] == 400
    run(go())


def test_one_run_at_a_time_and_a_short_queue(tmp_path, monkeypatch):
    monkeypatch.setattr(agents, "find_codex", lambda: "/bin/true")

    async def go():
        hub = make_hub(tmp_path, riley(linked=False))
        release = asyncio.Event()
        active = []

        async def codex(run, exe, text):
            active.append(text)
            assert len(active) == 1  # never two at once
            await release.wait()
            active.remove(text)
            return f"did {text}"

        done: list = []
        hub.agent._codex = codex
        tasks = [asyncio.create_task(hub.agent.ask(f"request {i}")) for i in range(4)]
        await asyncio.sleep(0.05)
        answer, status = await hub.agent.ask("one too many")
        assert status == 429 and "busy" in answer["error"]
        release.set()
        for t in tasks:
            answer, status = await t
            done.append(answer)
            assert status == 200
        assert [a["reply"] for a in done] == [f"did request {i}" for i in range(4)]
    run(go())


def test_a_hub_without_codex_asks_the_other_one(tmp_path, monkeypatch):
    monkeypatch.setattr(agents, "find_codex", lambda: None)

    async def go():
        asked = []

        async def peer_agent(request):
            asked.append(await request.json())
            return web.json_response({"ok": True, "reply": "Done, the kitchen is off.",
                                      "steps": [{"tool": "set_lights", "text": "Kitchen lights → off", "ok": True}]})

        app = web.Application()
        app.router.add_post("/api/agent", peer_agent)
        peer = TestServer(app)
        await peer.start_server()
        hub = make_hub(tmp_path, riley(linked=False))
        hub.peers = ["http://127.0.0.1:9", str(peer.make_url("")).rstrip("/")]
        heard: asyncio.Queue = asyncio.Queue(maxsize=200)
        hub.listeners.add(heard)
        async with aiohttp.ClientSession() as http:
            hub.http = http
            answer, status = await hub.agent.ask("kitchen off", client="tab-2")
            assert status == 200 and answer["reply"] == "Done, the kitchen is off."
            assert asked == [{"text": "kitchen off", "client": "tab-2", "fromPeer": True}]
            last = agent_events(heard)[-1]
            assert last["state"] == "done" and last["steps"][0]["text"] == "Kitchen lights → off"
            # The other hub never sends it back.
            answer, status = await hub.agent.ask("kitchen off", from_peer=True)
            assert status == 503 and "no Codex" in answer["error"]
        await peer.close()
    run(go())


def test_codex_events():
    tool = {"type": "item.started", "item": {"id": "i1", "type": "mcp_tool_call", "server": "house", "tool": "tv",
                                             "arguments": '{"action": "pause"}', "status": "in_progress"}}
    assert agents.codex_event(json.dumps(tool)) == ("tool", {"id": "i1", "tool": "tv", "server": "house",
                                                             "arguments": {"action": "pause"}, "done": False, "ok": None, "error": None})
    failed = {"type": "item.completed", "item": {**tool["item"], "status": "failed", "error": {"message": "TV asleep"}}}
    assert agents.codex_event(json.dumps(failed))[1] == {**agents.codex_event(json.dumps(tool))[1], "done": True, "ok": False,
                                                         "error": "TV asleep"}
    end = {"id": "0", "msg": {"type": "mcp_tool_call_end", "call_id": "c9", "invocation": {"server": "house", "tool": "tv"},
                              "result": {"Ok": {"content": [], "isError": True}}}}
    assert agents.codex_event(json.dumps(end))[1]["ok"] is False
    assert agents.codex_event(json.dumps({"type": "item.completed", "item": {"type": "assistant_message", "text": "Hi"}})) == \
        ("message", {"text": "Hi"})
    assert agents.codex_event(json.dumps({"type": "turn.failed", "error": {"message": "quota"}})) == ("error", {"message": "quota"})
    for line in ("", "not json", "[1]", json.dumps({"type": "item.completed", "item": {"type": "reasoning", "text": "hmm"}}),
                 json.dumps({"type": "turn.completed"})):
        assert agents.codex_event(line) is None
