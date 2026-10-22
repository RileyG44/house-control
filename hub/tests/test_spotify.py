import asyncio
import json
import stat
import time

import aiohttp
import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

import house
import spotify


def run(coro):
    return asyncio.run(coro)


async def api_server():
    sent = []
    devices = [{"id": "echo", "name": "Studio Echo", "type": "Speaker", "is_active": True, "volume_percent": 32},
               {"id": "restricted", "name": "Unavailable output", "is_restricted": True}]

    async def token(request):
        sent.append(("token", dict(await request.post())))
        return web.json_response({"access_token": "new-access", "refresh_token": "new-refresh", "expires_in": 3600})

    async def api(request):
        assert request.headers["Authorization"] == "Bearer new-access"
        body = await request.json() if request.can_read_body else None
        sent.append((request.method, request.path, dict(request.query), body))
        if request.method == "GET" and request.path.endswith("/devices"):
            return web.json_response({"devices": devices})
        if request.method == "GET":
            return web.json_response({"is_playing": True, "progress_ms": 12000, "device": devices[0],
                                      "item": {"id": "track", "name": "Evening", "duration_ms": 200000,
                                               "artists": [{"name": "A musician"}], "album": {"name": "Studio", "images": []}}})
        return web.Response(status=204)

    app = web.Application()
    app.router.add_post("/token", token)
    app.router.add_route("*", "/v1/{path:.*}", api)
    server = TestServer(app)
    await server.start_server()
    return server, sent


def test_connect_refresh_and_remote_state_are_private(tmp_path, monkeypatch):
    async def check():
        server, sent = await api_server()
        monkeypatch.setattr(spotify, "API", str(server.make_url("/v1")))
        monkeypatch.setattr(spotify, "TOKEN", str(server.make_url("/token")))
        spotify.save_config(tmp_path / "spotify.json", {"client_id": "client", "refresh_token": "old-refresh"})
        service = spotify.Spotify(tmp_path)
        service.is_mac = False
        async with aiohttp.ClientSession() as http:
            service.http = http
            state = await service.state()
            assert state["available"] and state["playing"]
            assert state["track"]["position"] == 12
            assert [d["id"] for d in state["devices"]] == ["echo"]
            assert "new-access" not in json.dumps(state) and "refresh_token" not in json.dumps(state)
            assert sent[0] == ("token", {"grant_type": "refresh_token", "refresh_token": "old-refresh", "client_id": "client"})
            saved = spotify.read_config(tmp_path / "spotify.json")
            assert saved["refresh_token"] == "new-refresh"
            assert stat.S_IMODE((tmp_path / "spotify.json").stat().st_mode) == 0o600
            # Reads from two screens share a short cache rather than doubling Spotify's traffic.
            count = len(sent)
            await service.state()
            assert len(sent) == count
        await server.close()
    run(check())


def test_connect_controls_real_available_devices_and_limits(tmp_path, monkeypatch):
    async def check():
        server, sent = await api_server()
        monkeypatch.setattr(spotify, "API", str(server.make_url("/v1")))
        spotify.save_config(tmp_path / "spotify.json", {"client_id": "client", "refresh_token": "refresh",
                            "access_token": "new-access", "expires_at": time.time() + 3600})
        service = spotify.Spotify(tmp_path)
        async with aiohttp.ClientSession() as http:
            service.http = http
            assert (await service.act({"action": "transfer", "device": "echo"}))[1] == 200
            assert sent[-1][1] == "/v1/me/player"
            assert sent[-1][3] == {"device_ids": ["echo"], "play": True}
            assert (await service.act({"action": "transfer", "device": "restricted"}))[1] == 409
            assert (await service.act({"action": "volume", "level": 999}))[1] == 200
            assert sent[-1][2] == {"volume_percent": "100"}
            assert (await service.act({"action": "seek", "position": 18.5}))[1] == 200
            assert sent[-1][2] == {"position_ms": "18500"}
            for action, method in [("next", "POST"), ("previous", "POST"), ("play", "PUT"), ("pause", "PUT")]:
                assert (await service.act({"action": action}))[1] == 200
                assert sent[-1][:2] == (method, "/v1/me/player/" + action)
        await server.close()
    run(check())


@pytest.mark.parametrize("body", [None, [], {"action": []}, {"action": "shell"}, {"action": "volume", "level": "1;do evil"},
                                 {"action": "seek", "position": float("nan")}, {"action": "volume", "level": True},
                                 {"action": "transfer", "device": ""}])
def test_invalid_actions_never_reach_a_player(body):
    with pytest.raises(spotify.SpotifyError) as error:
        spotify.validate_action(body)
    assert error.value.status == 400


def test_bridge_uses_local_only_and_never_replays_a_timed_out_skip(tmp_path, monkeypatch):
    async def check():
        seen = []

        async def player(request):
            seen.append((request.method, request.query.get("local")))
            assert request.query.get("local") == "1"
            if request.method == "POST":
                await asyncio.sleep(0.4)  # the action arrived, but its answer was lost
            return web.json_response({"available": True, "backend": "mac", "devices": []})

        app = web.Application()
        app.router.add_route("*", "/api/spotify", player)
        server = TestServer(app)
        await server.start_server()
        monkeypatch.setattr(spotify, "TIMEOUT", aiohttp.ClientTimeout(total=0.1))
        service = spotify.Spotify(tmp_path, [str(server.make_url("/")).rstrip("/"), "http://127.0.0.1:9"])
        service.is_mac = False
        async with aiohttp.ClientSession() as http:
            service.http = http
            assert (await service.state())["available"]
            answer, status = await service.act({"action": "next"})
            assert status == 503 and "Check Spotify" in answer["error"]
            assert seen == [("GET", "1"), ("POST", "1")]
        await server.close()
    run(check())


def test_local_only_request_cannot_forward_to_another_peer(tmp_path):
    async def check():
        service = spotify.Spotify(tmp_path, ["http://127.0.0.1:9"])
        service.is_mac = False
        state = await service.state(local_only=True)
        assert not state["available"] and state["backend"] == "none"
        answer, status = await service.act({"action": "next"}, local_only=True)
        assert status == 409
    run(check())


def test_rate_limit_is_respected_without_repeated_requests(tmp_path, monkeypatch):
    async def check():
        calls = []

        async def busy(request):
            calls.append(request.path)
            return web.json_response({}, status=429, headers={"Retry-After": "12"})

        app = web.Application()
        app.router.add_route("*", "/{path:.*}", busy)
        server = TestServer(app)
        await server.start_server()
        monkeypatch.setattr(spotify, "API", str(server.make_url("/v1")))
        spotify.save_config(tmp_path / "spotify.json", {"refresh_token": "refresh", "access_token": "token", "expires_at": time.time() + 3600})
        service = spotify.Spotify(tmp_path)
        async with aiohttp.ClientSession() as http:
            service.http = http
            assert (await service.act({"action": "next"}))[1] == 429
            assert (await service.act({"action": "next"}))[1] == 429
            assert len(calls) == 1
        await server.close()
    run(check())


def test_hub_routes_enforce_origin_and_do_not_start_discovery(tmp_path):
    async def check():
        hub = house.Hub(tmp_path)
        hub.spotify.is_mac = False
        app = house.make_app(hub)
        app.on_startup.clear()
        app.on_cleanup.clear()
        client = TestClient(TestServer(app))
        await client.start_server()
        try:
            assert (await client.get("/api/spotify?local=1")).status == 200
            assert (await client.post("/api/spotify", json={"action": "next"}, headers={"Origin": "https://foreign.example"})).status == 403
            assert (await client.post("/api/spotify", json={"action": "bad"})).status == 400
            assert (await client.post("/api/spotify", data="bad")).status == 400
        finally:
            await client.close()
    run(check())
