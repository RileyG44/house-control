"""The streaming catalog (catalog.py): run with .venv/bin/python -m pytest tests (no network).

A pretend JustWatch (its GraphQL answers from justwatch_catalog.json, chosen by what is asked,
and its picture server) stands in for the real one, and the pretend launcher of
test_launcher.py for the TV's apps and Continue."""
from __future__ import annotations

import asyncio
import datetime
import json
import os
import sys
from pathlib import Path

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import catalog  # noqa: E402
import house  # noqa: E402
import launcher as launchers  # noqa: E402
import tv  # noqa: E402
from fake_launcher import ART, CODE, FakeLauncher  # noqa: E402
from test_launcher import hub_with_launcher  # noqa: E402
from test_tv import TV_ID, run  # noqa: E402

FIX = json.loads((HERE / "justwatch_catalog.json").read_text())
NETFLIX_TV = "intent://www.netflix.com/title/80057281#Intent;scheme=https;package=com.netflix.ninja;end"
EMPTY = {"data": {"popularTitles": {"edges": []}}}
PICTURE = b"\xff\xd8\xff\xe0" + b"j" * 994 + b"\xff\xd9"
# The launcher's Continue: an episode of a Netflix show, with its picture.
WATCHING = {"id": "0a1b2c3d4e5f6071", "pkg": "com.netflix.ninja", "app": "Netflix", "title": "Chapter Seven: The Bathtub",
            "subtitle": "Stranger Things · S1 E7", "progress": 0.42, "remainingMin": 31, "art": "art/h/0a1b2c3d4e5f6071"}
# The apps' own picks, as the launcher reads them from the TV provider.
PICKS = [
    {"id": "11aa22bb33cc44dd", "pkg": "com.netflix.ninja", "app": "Netflix", "title": "Top Pick: Dark",
     "poster": "https://occ.nflxso.net/dark.jpg", "intentUri": "https://www.netflix.com/title/80100172", "source": "preview"},
    {"id": "55ee66ff77aa88bb", "pkg": "com.spotify.tv.android", "app": "Spotify", "title": "Daily Mix 1",
     "poster": "https://i.scdn.co/x.jpg", "intentUri": "spotify:playlist:1", "source": "preview"},
    {"id": "99cc00dd11ee22ff", "pkg": "com.hulu.livingroomplus", "app": "Hulu", "title": "Keep watching: The Bear",
     "poster": "content://com.hulu.provider/art/1", "intentUri": "https://www.hulu.com/watch/1", "source": "watchNext"},
]


def which(variables: dict) -> str | None:
    shorts = (variables.get("filter") or {}).get("packages") or []
    return "nfx" if "nfx" in shorts else "hlu" if "hlu" in shorts else None


async def fake_justwatch(monkeypatch, broken: set | None = None):
    """JustWatch's GraphQL and picture server. `broken` names kinds of question to fail."""
    asked: list[dict] = []
    pictures: list[str] = []
    broken = broken if broken is not None else set()

    async def graphql(request):
        assert request.headers["User-Agent"].endswith("HouseControl/1.0")
        body = await request.json()
        q, v = body["query"], body["variables"]
        assert v["country"] == "US" and v["language"] == "en"
        kind = ("packages" if "packages(country" in q else "new" if "newTitles" in q else "similar" if "similarTitlesV2" in q
                else "title" if "node(id" in q else "seed" if "searchQuery" in json.dumps(v) else v["sortBy"].lower())
        asked.append({"kind": kind, **v})
        if kind in broken:
            return web.json_response({"errors": [{"message": "down"}]}, status=500)
        if kind == "packages":
            return web.json_response(FIX["packages"])
        if kind == "new":
            days = FIX["new"].get(which(v)) or {}
            return web.json_response({"data": {k: days.get(k, {"edges": []}) for k in v if k.startswith("d") and k[1:].isdigit()}})
        if kind in ("similar", "seed"):
            return web.json_response(FIX[kind])
        if kind == "title":
            return web.json_response(FIX["title"] if v["id"] == "ts20503" else {"data": {"node": None}})
        if v.get("offset"):
            return web.json_response(EMPTY)
        return web.json_response(FIX[kind].get(which(v)) or EMPTY)

    async def picture(request):
        pictures.append(request.path)
        name = request.match_info["name"]
        if name.startswith("not-an-image"):
            return web.Response(text="<html>", content_type="text/html")
        if name.startswith("slow") or name.startswith("cut"):
            # A slow link: the picture comes in pieces; "cut" stops before the end.
            r = web.StreamResponse(headers={"Content-Type": "image/jpeg"})
            await r.prepare(request)
            for i in range(0, len(PICTURE) if name.startswith("slow") else 600, 200):
                await r.write(PICTURE[i:i + 200])
                await asyncio.sleep(0.01)
            await r.write_eof()
            return r
        return web.Response(body=PICTURE, content_type="image/jpeg")

    app = web.Application()
    app.router.add_post("/graphql", graphql)
    app.router.add_get("/{kind}/{num}/{profile}/{name}", picture)
    server = TestServer(app)
    await server.start_server()
    monkeypatch.setattr(catalog, "JUSTWATCH_URL", str(server.make_url("/graphql")))
    monkeypatch.setattr(catalog, "IMAGE_BASE", str(server.make_url("")).rstrip("/"))
    return server, asked, pictures


# ---------- JustWatch's titles as tiles ----------

def test_tiles_from_canned_answers():
    stranger = FIX["title"]["data"]["node"]
    t = catalog.tile(stranger, ["Netflix"])
    assert t == {
        "id": "ts20503", "title": "Stranger Things", "year": 2016, "kind": "show",
        "poster": "/api/tv/img/poster/323146457/stranger-things", "backdrop": "/api/tv/img/backdrop/177512134/stranger-things",
        "blurb": "When a young boy vanishes, a small town uncovers a mystery.", "runtime": 51, "rating": 8.7, "age": "TV-14",
        "genres": ["Drama", "Fantasy", "Horror"], "app": "netflix", "pkg": "com.netflix.ninja",
        "link": "https://www.netflix.com/title/80057281", "tvLink": NETFLIX_TV}
    # Only where it's included, in the apps asked for, in their order: no rentals or purchases.
    assert [o["app"] for o in catalog.offers(stranger, ["Hulu", "Disney+", "Netflix"])] == ["disney", "netflix"]
    assert catalog.tile(stranger, ["Hulu"]) is None
    assert catalog.tile(stranger, ["Disney+", "Netflix"])["app"] == "disney"
    assert catalog.rent_or_buy(stranger) == ["Apple TV (buy)"]
    popular = [e["node"] for e in FIX["popular"]["nfx"]["data"]["popularTitles"]["edges"]]
    rented, foreign, untitled = popular[2], popular[3], popular[4]
    assert catalog.tile(rented, ["Netflix", "Apple TV"]) is None
    assert catalog.tile(foreign, ["Netflix"]) is None  # a link off Netflix's own hosts
    assert catalog.tile(untitled, ["Netflix"]) is None
    glass = catalog.tile(popular[1], ["Netflix"])
    assert (glass["kind"], glass["backdrop"], glass["tvLink"], glass["link"]) == ("movie", None, None, "https://www.netflix.com/title/81458416")
    # A season that is new stands for its show, with the season's own offer.
    season = FIX["new"]["nfx"]["d0"]["edges"][0]["node"]
    squid = catalog.tile(season, ["Netflix"])
    assert (squid["id"], squid["title"], squid["kind"], squid["year"]) == ("ts271048", "Squid Game", "show", 2021)
    # A short name the technical name doesn't cover is matched too.
    odd = {**popular[1], "offers": [{**popular[1]["offers"][0], "package": {"clearName": "Netflix", "technicalName": "netflixnew", "shortName": "nfz"}}]}
    assert catalog.tile(odd, ["Netflix"]) is None and catalog.tile(odd, ["Netflix"], {"nfz": "Netflix"})["app"] == "netflix"
    assert catalog.image("/poster/1/{profile}/../../etc.{format}") is None and catalog.image(None) is None
    assert catalog.card({"id": "../x", "content": {"title": "x"}}) is None


def test_continue_and_what_the_clients_get():
    t = catalog.continue_tile(WATCHING)
    assert t["id"] == "h:0a1b2c3d4e5f6071" and t["kind"] == "continue" and t["resume"] == "0a1b2c3d4e5f6071"
    assert (t["app"], t["poster"], t["progress"], t["link"]) == ("netflix", "/api/tv/art/h/0a1b2c3d4e5f6071", 0.42, None)
    assert catalog.continue_tile({**WATCHING, "art": "banner/com.netflix.ninja"})["poster"] is None
    assert catalog.continue_tile({**WATCHING, "id": "../x"}) is None
    r = catalog.recommendation_tile(PICKS[0])
    assert (r["id"], r["kind"], r["app"], r["poster"], r["recommendation"]) == \
        ("r:11aa22bb33cc44dd", "recommendation", "netflix", "https://occ.nflxso.net/dark.jpg", "11aa22bb33cc44dd")
    assert catalog.recommendation_tile(PICKS[2])["poster"] is None  # only the TV can read a content:// picture
    assert catalog.recommendation_tile({**PICKS[0], "id": "x y"}) is None
    assert catalog.seed_query(WATCHING) == "Stranger Things"
    assert catalog.seed_query({"title": "Dune: Part Two", "subtitle": "2024"}) == "Dune: Part Two"
    whole = catalog.for_client({"forYou": [t], "apps": [{"rows": [{"items": [{"poster": "/api/tv/img/poster/1/x", "link": "/api/tv/x"}]}]}]},
                               "https://dell.tail1234.ts.net")
    assert whole["forYou"][0]["poster"] == "https://dell.tail1234.ts.net/api/tv/art/h/0a1b2c3d4e5f6071"
    assert whole["apps"][0]["rows"][0]["items"][0] == {"poster": "https://dell.tail1234.ts.net/api/tv/img/poster/1/x", "link": "/api/tv/x"}

    class TV:
        launcher = None
        lr_state = None
    remote = TV()
    assert catalog.installed_apps(remote) == list(tv.APPS) and catalog.continuing(remote) == []
    remote.launcher = object()
    assert catalog.installed_apps(remote) == list(tv.APPS)  # paired, but not heard from yet
    remote.lr_state = {"apps": [{"pkg": "com.hulu.livingroomplus"}, {"pkg": "com.spotify.tv.android"}, {"pkg": "com.netflix.ninja"}],
                       "continue": [WATCHING, "junk"]}
    assert catalog.installed_apps(remote) == ["Hulu", "Netflix"] and catalog.continuing(remote) == [WATCHING]


# ---------- the catalog, against a pretend JustWatch ----------

def test_rows_for_you_and_the_cache(tmp_path, monkeypatch):
    async def go():
        server, asked, _ = await fake_justwatch(monkeypatch)
        async with aiohttp.ClientSession() as http:
            cat = catalog.Catalog(tmp_path, apps=lambda: ["Netflix", "Hulu"], recent=lambda: [WATCHING])
            cat.http = http
            out = await cat.overview()
            assert [a["id"] for a in out["apps"]] == ["netflix", "hulu"]
            netflix, hulu = out["apps"]
            assert netflix["name"] == "Netflix" and netflix["pkg"] == "com.netflix.ninja"
            rows = {r["key"]: r for r in netflix["rows"]}
            assert list(rows) == ["popular", "trending", "new"]
            assert rows["popular"]["title"] == "Popular on Netflix" and rows["popular"]["label"] == "Popular"
            # Rentals, foreign links, untitled and repeated titles are left out.
            assert [t["title"] for t in rows["popular"]["items"]] == ["Stranger Things", "Glass Onion"]
            assert [t["title"] for t in rows["trending"]["items"]] == ["Wednesday", "Stranger Things"]
            assert rows["new"]["title"] == "New on Netflix"
            assert [t["title"] for t in rows["new"]["items"]] == ["Squid Game", "Glass Onion"]
            # Hulu's trending failed and nothing is new there: just its popular row.
            assert [r["key"] for r in hulu["rows"]] == ["popular"]
            # Asked with the app's short names (from JustWatch's own list) and subscription offers only.
            pop = next(a for a in asked if a["kind"] == "popular" and which(a) == "nfx")
            assert pop["filter"] == {"packages": ["nfx", "nfa"], "monetizationTypes": ["FLATRATE", "FREE", "ADS"]}
            assert (pop["first"], pop["offset"]) == (20, 0)
            new = next(a for a in asked if a["kind"] == "new" and which(a) == "nfx")
            assert len([k for k in new if k.startswith("d") and k[1:].isdigit()]) == 7 and new["d0"] > new["d6"]
            # For you: Continue, then like Stranger Things (seeded by the show of the episode) in
            # the TV's apps, then each app's popular titles in turn.
            assert [t["id"] for t in out["forYou"]] == ["h:0a1b2c3d4e5f6071", "ts72073", "ts300000", "ts20503", "tm1065711"]
            seed = next(a for a in asked if a["kind"] == "seed")
            assert seed["filter"] == {"searchQuery": "Stranger Things", "packages": ["nfx", "nfa"]}
            similar = next(a for a in asked if a["kind"] == "similar")
            assert similar["id"] == "ts20503" and similar["filter"]["packages"] == ["nfx", "nfa", "hlu"]
            assert out["updatedAt"] and [a["kind"] for a in asked].count("packages") == 1

            # Asked again: all from memory, except nothing (the failed row waits too).
            n = len(asked)
            assert await cat.overview() == out and len(asked) == n
            # After a restart, from the file: only the row that failed is asked again.
            kept = json.loads((tmp_path / "catalog-cache.json").read_text())
            assert "netflix:popular:0" in kept["rows"] and kept["packages"]["short"]["Netflix"] == ["nfx", "nfa"]
            again = catalog.Catalog(tmp_path, apps=lambda: ["Netflix", "Hulu"], recent=lambda: [WATCHING])
            again.http = http
            assert (await again.overview())["apps"] == out["apps"]
            assert [(a["kind"], which(a)) for a in asked[n:]] == [("trending", "hlu")]

            # Six hours on, what is kept is shown at once and asked again behind it.
            for v in kept["rows"].values():
                v["at"] -= catalog.TTL + 1
            (tmp_path / "catalog-cache.json").write_text(json.dumps(kept))
            later = catalog.Catalog(tmp_path, apps=lambda: ["Netflix", "Hulu"], recent=lambda: [])
            later.http = http
            n = len(asked)
            stale = await later.overview()
            assert [t["title"] for t in stale["apps"][0]["rows"][0]["items"]] == ["Stranger Things", "Glass Onion"]
            for _ in range(100):
                if not later._later:
                    break
                await asyncio.sleep(0.02)
            assert len([a for a in asked[n:] if a["kind"] == "popular"]) == 2
            fresh = json.loads((tmp_path / "catalog-cache.json").read_text())
            assert fresh["rows"]["netflix:popular:0"]["at"] > kept["rows"]["netflix:popular:0"]["at"]
        await server.close()
    run(go())


def test_when_justwatch_is_down(tmp_path, monkeypatch):
    async def go():
        server, asked, _ = await fake_justwatch(monkeypatch, broken={"packages", "popular", "trending", "new", "seed"})
        async with aiohttp.ClientSession() as http:
            cat = catalog.Catalog(tmp_path, apps=lambda: ["Netflix"], recent=lambda: [WATCHING])
            cat.http = http
            out = await cat.overview()
            # Nothing but Continue; the short names fall back to the table.
            assert out["apps"] == [] and [t["id"] for t in out["forYou"]] == ["h:0a1b2c3d4e5f6071"]
            pop = next(a for a in asked if a["kind"] == "popular")
            assert pop["filter"]["packages"] == list(catalog.SHORT_NAMES["Netflix"])
            body, status = await cat.more("netflix", "popular", 0)
            assert status == 502 and body == {"error": "The streaming catalog didn't answer."}
        await server.close()
    run(go())


def test_more_and_a_title(tmp_path, monkeypatch):
    async def go():
        server, asked, _ = await fake_justwatch(monkeypatch)
        async with aiohttp.ClientSession() as http:
            cat = catalog.Catalog(tmp_path, apps=lambda: ["Netflix", "Hulu"])
            cat.http = http
            body, status = await cat.more("netflix", "trending", "0")
            assert status == 200 and [t["id"] for t in body["items"]] == ["ts305", "ts20503"]
            assert body["more"] is False and body["title"] == "Trending on Netflix"
            body, status = await cat.more("netflix", "popular", 1)
            assert status == 200 and body["items"] == [] and body["more"] is False
            assert next(a for a in asked if a["kind"] == "popular")["offset"] == 20
            body, status = await cat.more("netflix", "new", 1)
            assert status == 200
            older = next(a for a in asked if a["kind"] == "new")
            assert older["d0"] == (datetime.date.today() - datetime.timedelta(days=catalog.NEW_DAYS)).isoformat()
            for bad, code in ((("disney", "popular", 0), 404), (("nope", "popular", 0), 404), (("netflix", "rentals", 0), 400),
                              (("netflix", "popular", 10), 400), (("netflix", "popular", "x"), 400), (("netflix", "popular", -1), 400)):
                assert (await cat.more(*bad))[1] == code, bad
            # A title: where it's included in the TV's apps (Disney+ isn't one), and what's for rent or sale.
            body, status = await cat.title("ts20503")
            assert status == 200 and body["title"] == "Stranger Things" and body["genres"] == ["Drama", "Fantasy", "Horror"]
            assert body["offers"] == [{"app": "netflix", "name": "Netflix", "pkg": "com.netflix.ninja", "how": "subscription",
                                       "link": "https://www.netflix.com/title/80057281", "tvLink": NETFLIX_TV}]
            assert body["rentOrBuy"] == ["Apple TV (buy)"]
            n = len(asked)
            await cat.title("ts20503")
            assert len(asked) == n
            assert (await cat.title("tm1"))[1] == 404
            assert (await cat.title("../../x"))[1] == 400 and len(asked) == n + 1
        await server.close()
    run(go())


def test_pictures_are_kept_on_disk_and_bounded(tmp_path, monkeypatch):
    async def go():
        server, asked, pictures = await fake_justwatch(monkeypatch)
        monkeypatch.setattr(catalog, "ART_LIMIT", 2500)
        async with aiohttp.ClientSession() as http:
            cat = catalog.Catalog(tmp_path, apps=lambda: ["Netflix"])
            cat.http = http
            got = await cat.picture("poster", "323146457", "stranger-things")
            assert got == (PICTURE, "image/jpeg")
            assert pictures == ["/poster/323146457/s332/stranger-things.jpg"]
            assert await cat.picture("poster", "323146457", "stranger-things") == got and len(pictures) == 1
            await cat.picture("backdrop", "177512134", "stranger-things")
            assert pictures[-1] == "/backdrop/177512134/s1440/stranger-things.jpg"
            art = tmp_path / "catalog-art"
            os.utime(art / "poster-323146457.jpg", (1_000_000, 1_000_000))
            # A third one is past the limit: the least recently used goes.
            await cat.picture("poster", "305563428", "the-bear")
            assert sorted(f.name for f in art.iterdir()) == ["backdrop-177512134.jpg", "poster-305563428.jpg"]
            for bad in (("thumb", "1", "x"), ("poster", "../1", "x"), ("poster", "1", "x/../../y"), ("poster", "1", "not-an-image")):
                assert await cat.picture(*bad) is None, bad
        await server.close()
    run(go())


def test_pictures_that_arrive_in_pieces_are_kept_whole(tmp_path, monkeypatch):
    async def go():
        server, asked, pictures = await fake_justwatch(monkeypatch)
        async with aiohttp.ClientSession() as http:
            cat = catalog.Catalog(tmp_path, apps=lambda: ["Netflix"])
            cat.http = http
            assert await cat.picture("poster", "1", "slow-link") == (PICTURE, "image/jpeg")
            # Cut off before the end: not shown, not kept, asked for again next time.
            assert await cat.picture("poster", "2", "cut-off") is None
            assert not (tmp_path / "catalog-art" / "poster-2.jpg").exists()
            assert await cat.picture("poster", "2", "cut-off") is None and len(pictures) == 3
        await server.close()
    run(go())


def test_cut_off_pictures_from_an_older_hub_are_dropped(tmp_path):
    art = tmp_path / "catalog-art"
    art.mkdir()
    (art / "poster-1.jpg").write_bytes(PICTURE)
    (art / "poster-2.jpg").write_bytes(PICTURE[:300])
    catalog.Catalog(tmp_path, apps=lambda: ["Netflix"])
    assert sorted(f.name for f in art.iterdir()) == ["poster-1.jpg"]


# ---------- the hub's routes ----------

def test_hub_catalog_routes(tmp_path, monkeypatch):
    async def go():
        server, asked, pictures = await fake_justwatch(monkeypatch)
        monkeypatch.setattr(house.Hub, "discover", lambda self: asyncio.sleep(0))
        hub = house.Hub(tmp_path)  # no launcher: every app in tv.APPS counts as the TV's
        client = TestClient(TestServer(house.make_app(hub)))
        await client.start_server()
        origin = f"http://{client.host}:{client.port}"
        try:
            r = await client.get("/api/tv/catalog")
            out = await r.json()
            assert r.status == 200 and r.headers["Cache-Control"] == "no-store"
            # Only the apps JustWatch had anything for in the canned answers.
            assert [a["id"] for a in out["apps"]] == ["netflix", "hulu"]
            first = out["apps"][0]["rows"][0]["items"][0]
            assert first["poster"] == origin + "/api/tv/img/poster/323146457/stranger-things"
            pic = await client.get(first["poster"][len(origin):])
            assert pic.status == 200 and await pic.read() == PICTURE and pic.content_type == "image/jpeg"
            assert (await client.get("/api/tv/img/poster/1/not-an-image")).status == 404
            served = await (await client.get("/api/tv/catalog", headers={"X-Forwarded-Proto": "https", "X-Forwarded-Host": "dell.tail1234.ts.net"})).json()
            assert served["apps"][0]["rows"][0]["items"][0]["poster"].startswith("https://dell.tail1234.ts.net/api/tv/img/")
            r = await client.get("/api/tv/catalog/netflix", params={"row": "trending", "page": "0"})
            assert r.status == 200 and (await r.json())["items"][0]["title"] == "Wednesday"
            assert (await client.get("/api/tv/catalog/netflix", params={"row": "x"})).status == 400
            r = await client.get("/api/tv/title/ts20503")
            body = await r.json()
            # Every app counts here, so Disney+ does too.
            assert r.status == 200 and [o["app"] for o in body["offers"]] == ["netflix", "disney"]
            assert body["backdrop"] == origin + "/api/tv/img/backdrop/177512134/stranger-things"
            assert (await client.get("/api/tv/title/nope")).status == 400
            assert (tmp_path / "catalog-cache.json").exists()
            # No launcher: no Continue, and nothing to pick up again.
            assert (await client.get("/api/tv/art/h/0a1b2c3d4e5f6071")).status == 404
        finally:
            await client.close()
            await server.close()
    run(go())


def test_catalog_through_the_launcher(tmp_path, monkeypatch):
    async def go():
        jw, asked, _ = await fake_justwatch(monkeypatch)
        fake = FakeLauncher(hold=5.0)
        fake.state["continue"] = [WATCHING]
        fake.state["recommendations"] = PICKS
        fake, lr, server, state, sent, hub, client = await hub_with_launcher(tmp_path, monkeypatch, fake)
        origin = f"http://{client.host}:{client.port}"
        try:
            await client.get("/api/tv")
            out = await (await client.get("/api/tv/catalog")).json()
            # The launcher's apps (YouTube, Netflix, Hulu), in its order; YouTube has nothing here.
            assert [a["id"] for a in out["apps"]] == ["netflix", "hulu"]
            assert {which(a) for a in asked if a["kind"] == "popular"} == {"nfx", "hlu", None}
            mine = out["forYou"][0]
            assert mine["kind"] == "continue" and mine["poster"] == origin + "/api/tv/art/h/0a1b2c3d4e5f6071"
            # Then the apps' own picks, in the TV's streaming apps only, before the similar titles.
            assert [t["id"] for t in out["forYou"][1:4]] == ["r:11aa22bb33cc44dd", "r:99cc00dd11ee22ff", "ts72073"]
            r = await client.post(f"/api/tv/{TV_ID}", json={"action": "recommendation", "id": "99cc00dd11ee22ff"})
            assert r.status == 200 and fake.sent[-1] == {"type": "recommendation", "id": "99cc00dd11ee22ff"}
            assert (await client.post(f"/api/tv/{TV_ID}", json={"action": "recommendation", "id": "0a1b2c3d4e5f6071"})).status == 404
            pic = await client.get("/api/tv/art/h/0a1b2c3d4e5f6071")
            assert pic.status == 200 and await pic.read() == ART
            assert (await client.get("/api/tv/art/h/ffff")).status == 404
            # Picked up again on the TV, in its app.
            r = await client.post(f"/api/tv/{TV_ID}", json={"action": "resume", "id": mine["resume"]})
            assert r.status == 200 and fake.sent[-1] == {"type": "resume", "id": "0a1b2c3d4e5f6071"}
            assert fake.state["tv"]["foreground"]["pkg"] == "com.netflix.ninja"
            n = len(fake.sent)
            assert (await client.post(f"/api/tv/{TV_ID}", json={"action": "resume", "id": "../x"})).status == 400
            assert (await client.post(f"/api/tv/{TV_ID}", json={"action": "resume", "id": "ffff"})).status == 404
            assert len(fake.sent) == n
            # A catalog tile plays through the same path as a search result.
            tile = out["apps"][0]["rows"][0]["items"][0]
            r = await client.post(f"/api/tv/{TV_ID}", json={"action": "play", "app": tile["app"], "link": tile["tvLink"] or tile["link"]})
            assert r.status == 200 and fake.sent[-1] == {"type": "open", "url": "https://www.netflix.com/title/80057281", "pkg": "com.netflix.ninja"}
        finally:
            await client.close()
            await server.close()
            await lr.close()
            await jw.close()
    run(go())


def test_pairing_tells_the_launcher_where_the_hub_is(tmp_path):
    async def go():
        fake = FakeLauncher()
        lr = TestServer(fake.app())
        await lr.start_server()
        said: list[str] = []

        async def ask(_):
            return CODE

        async with aiohttp.ClientSession() as http:
            entry = await launchers.pair(http, tmp_path, str(lr.make_url("")).rstrip("/"), ask=ask, say=said.append,
                                         hub_url="http://192.168.0.127:8766")
        assert entry and fake.settings == [{"hub": "http://192.168.0.127:8766"}]
        await lr.close()
    run(go())
