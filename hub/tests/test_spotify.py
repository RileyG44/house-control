import asyncio
import json
import stat
import time
from types import SimpleNamespace

import aiohttp
import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

import house
import spotify


def run(coro):
    return asyncio.run(coro)


async def api_server(command_status=204, command_body=None, command_type=None):
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
        if request.method == "GET" and request.path.endswith("/playlists"):
            return web.json_response({"items": [{"id": "37i9dQZF1DXcBWIGoYBM5M", "name": "Evening mix",
                                      "owner": {"display_name": "Riley"}}, None],
                                      "next": "https://api.spotify.com/v1/me/playlists?offset=50" if request.query.get("offset") == "0" else None})
        if request.method == "GET":
            return web.json_response({"is_playing": True, "progress_ms": 12000, "device": devices[0],
                                      "item": {"id": "track", "name": "Evening", "duration_ms": 200000,
                                               "artists": [{"name": "A musician"}], "album": {"name": "Studio", "images": []}}})
        return web.Response(status=command_status, text=command_body, content_type=command_type)

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
            assert sent[-1][3] == {"device_ids": ["echo"]}  # Keep paused playback paused when changing output.
            assert (await service.act({"action": "transfer", "device": "restricted"}))[1] == 409
            assert (await service.act({"action": "volume", "level": 999}))[1] == 200
            assert sent[-1][2] == {"volume_percent": "100"}
            assert (await service.act({"action": "seek", "position": 18.5}))[1] == 200
            assert sent[-1][2] == {"position_ms": "18500"}
            assert (await service.act({"action": "play", "uri": "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M", "device": "echo"}))[1] == 200
            assert sent[-1] == ("PUT", "/v1/me/player/play", {"device_id": "echo"},
                                {"context_uri": "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M"})
            for action, method in [("next", "POST"), ("previous", "POST"), ("play", "PUT"), ("pause", "PUT")]:
                assert (await service.act({"action": action}))[1] == 200
                assert sent[-1][:2] == (method, "/v1/me/player/" + action)
        await server.close()
    run(check())


def test_playlists_are_paged_separately_from_the_player_poll(tmp_path, monkeypatch):
    async def check():
        server, sent = await api_server()
        monkeypatch.setattr(spotify, "API", str(server.make_url("/v1")))
        spotify.save_config(tmp_path / "spotify.json", {"refresh_token": "refresh", "access_token": "new-access",
                                                       "expires_at": time.time() + 3600})
        service = spotify.Spotify(tmp_path)
        async with aiohttp.ClientSession() as http:
            service.http = http
            answer, code = await service.playlists()
            assert code == 200 and answer["available"]
            assert answer["items"] == [{"id": "37i9dQZF1DXcBWIGoYBM5M", "uri": "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M",
                                         "name": "Evening mix", "owner": "Riley"}]
            assert answer["next"] == 50
            assert sent[-1][2] == {"limit": "50", "offset": "0"}
            assert (await service.playlists(offset=50))[0]["next"] is None
            await service.state()
            assert len([call for call in sent if call[1].endswith("/playlists")]) == 2
            assert (await service.playlists(offset=-1))[1] == 400
        await server.close()
    run(check())


@pytest.mark.parametrize("status", [200, 403])
def test_playlist_bridge_is_local_only_and_keeps_setup_errors(tmp_path, status):
    async def check():
        seen = []
        async def library(request):
            seen.append(dict(request.query))
            if status == 403:
                return web.json_response({"error": "Connect Spotify again to read playlists."}, status=403)
            return web.json_response({"available": True, "backend": "connect", "items": [], "next": None})
        app = web.Application()
        app.router.add_get("/api/spotify/playlists", library)
        server = TestServer(app)
        await server.start_server()
        service = spotify.Spotify(tmp_path, [str(server.make_url("/")).rstrip("/")])
        service.is_mac = False
        async with aiohttp.ClientSession() as http:
            service.http = http
            answer, code = await service.playlists(offset=50)
            assert code == status
            if status == 200:
                assert answer["available"]
            else:
                assert "Connect Spotify again" in answer["error"]
            assert seen == [{"local": "1", "offset": "50"}]
            assert not (await service.playlists(local_only=True))[0]["available"]
            assert len(seen) == 1
        await server.close()
    run(check())


def test_mac_can_prefer_the_dell_connect_account_without_forwarding_local_requests(tmp_path, monkeypatch):
    async def check():
        seen = []
        async def player(request):
            seen.append((request.method, dict(request.query)))
            if request.method == "POST":
                assert (await request.json())["action"] == "next"
                return web.json_response({"ok": True})
            return web.json_response({"available": True, "backend": "connect", "devices": []})
        app = web.Application()
        app.router.add_route("*", "/api/spotify", player)
        server = TestServer(app)
        await server.start_server()
        spotify.save_config(tmp_path / "spotify.json", {"prefer_peer": True})
        service = spotify.Spotify(tmp_path, [str(server.make_url("/")).rstrip("/")])
        service.is_mac = True
        local = []
        async def mac(body=None):
            local.append(body)
            return {"available": True, "backend": "mac"}
        monkeypatch.setattr(service, "_mac", mac)
        async with aiohttp.ClientSession() as http:
            service.http = http
            assert (await service.state())["backend"] == "connect"
            assert (await service.act({"action": "next"}))[1] == 200
            assert local == []
            assert seen == [("GET", {"local": "1"}), ("POST", {"local": "1"})]
            assert (await service.state(local_only=True))["backend"] == "mac"
            assert (await service.act({"action": "pause"}, local_only=True))[1] == 200
            assert local == [None, {"action": "pause"}]
            assert len(seen) == 2
        await server.close()
    run(check())


def test_offline_dell_probes_back_off_while_mac_controls_keep_working(tmp_path, monkeypatch):
    async def check():
        probes, local = [], []
        clock = [100.0]
        monkeypatch.setattr(spotify, "time", SimpleNamespace(monotonic=lambda: clock[0], time=time.time))
        async def offline(request):
            probes.append(request.path)
            return web.json_response({"error": "Offline"}, status=503)
        app = web.Application()
        app.router.add_get("/{address}/api/spotify", offline)
        server = TestServer(app)
        await server.start_server()
        urls = [str(server.make_url("/lan")), str(server.make_url("/tailscale"))]
        spotify.save_config(tmp_path / "spotify.json", {"prefer_peer": True})
        service = spotify.Spotify(tmp_path, urls)
        service.is_mac = True
        async def mac(body=None):
            local.append(body)
            return {"available": True, "backend": "mac"}
        monkeypatch.setattr(service, "_mac", mac)
        async with aiohttp.ClientSession() as http:
            service.http = http
            assert (await service.state(fresh=True))["backend"] == "mac"
            assert probes == ["/lan/api/spotify", "/tailscale/api/spotify"]
            clock[0] += 5
            assert (await service.state(fresh=True))["backend"] == "mac"
            assert (await service.act({"action": "next"}))[1] == 200
            assert local[-1] == {"action": "next"}
            assert len(probes) == 2  # Neither polling nor a command probes the offline Dell again.
            clock[0] += 26
            assert (await service.state(fresh=True))["backend"] == "mac"
            assert len(probes) == 4  # Discovery resumes when the cooldown expires.
        await server.close()
    run(check())


@pytest.mark.parametrize("status,body,content_type", [(200, None, None), (202, None, None),
                         (202, "Accepted", "text/plain"), (200, '{"accepted":true}', "application/json"),
                         (202, "", "application/json")])
def test_successful_player_commands_do_not_require_a_json_body(tmp_path, monkeypatch, status, body, content_type):
    async def check():
        server, sent = await api_server(status, body, content_type)
        monkeypatch.setattr(spotify, "API", str(server.make_url("/v1")))
        spotify.save_config(tmp_path / "spotify.json", {"refresh_token": "refresh", "access_token": "new-access",
                                                       "expires_at": time.time() + 3600})
        service = spotify.Spotify(tmp_path)
        async with aiohttp.ClientSession() as http:
            service.http = http
            answer, code = await service.act({"action": "next"})
            assert code == 200 and answer == {"ok": True}
            assert [entry[:2] for entry in sent] == [("POST", "/v1/me/player/next")]
        await server.close()
    run(check())


@pytest.mark.parametrize("body", [None, [], {"action": []}, {"action": "shell"}, {"action": "volume", "level": "1;do evil"},
                                 {"action": "seek", "position": float("nan")}, {"action": "volume", "level": True},
                                 {"action": "play", "uri": "https://foreign.example"}, {"action": "play", "uri": None},
                                 {"action": "play", "device": ""},
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
            assert (await client.get("/api/spotify/playlists?local=1")).status == 200
            assert (await client.get("/api/spotify/playlists?offset=bad")).status == 400
            assert (await client.get("/api/spotify/playlists?offset=100001")).status == 400
            assert (await client.post("/api/spotify", json={"action": "next"}, headers={"Origin": "https://foreign.example"})).status == 403
            assert (await client.post("/api/spotify", json={"action": "bad"})).status == 400
            assert (await client.post("/api/spotify", data="bad")).status == 400
        finally:
            await client.close()
    run(check())
