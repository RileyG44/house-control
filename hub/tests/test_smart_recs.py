"""The nightly picks (smart_recs.py), with a pretend Codex and a pretend JustWatch: run with
.venv/bin/python -m pytest tests (no network, no real Codex)."""
from __future__ import annotations

import asyncio
import json
import stat
import sys
import time
from pathlib import Path

import aiohttp
import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import catalog  # noqa: E402
import history  # noqa: E402
import smart_recs  # noqa: E402

FIX = json.loads((HERE / "justwatch_catalog.json").read_text())
NODES = [e["node"] for k in ("popular", "trending") for v in FIX[k].values()
         for e in (((v or {}).get("data") or {}).get("popularTitles") or {}).get("edges") or []]
NOW = int(time.time() * 1000)
APPS = ["Netflix", "Hulu"]

ANSWER = {"picks": [
    {"title": "Stranger Things", "year": 2016, "kind": "show", "app_hint": "Netflix"},   # being watched: left out
    {"title": "the bear", "year": 2022, "kind": "show", "app_hint": "Hulu"},
    {"title": "Glass Onion", "year": 2023, "kind": "movie", "app_hint": "HBO Max"},     # a year off is still it
    {"title": "Only To Rent", "year": 2024, "kind": "movie", "app_hint": "Netflix"},    # to rent only
    {"title": "Nothing Like It", "year": 2025, "kind": "movie", "app_hint": None},       # not found
    {"title": "Wednesday", "year": 2022, "kind": "movie", "app_hint": None},             # a show, not a film
]}


async def fake_justwatch(monkeypatch):
    asked = []

    async def graphql(request):
        body = await request.json()
        v = body["variables"]
        flt = v.get("filter") or {}
        asked.append(flt)
        if "packages(country" in body["query"]:
            return web.json_response(FIX["packages"])
        q = flt.get("searchQuery", "")
        hits = [n for n in NODES if catalog.same_title((n.get("content") or {}).get("title") or "", q)]
        return web.json_response({"data": {"popularTitles": {"edges": [{"node": n} for n in hits[:1]]}}})

    app = web.Application()
    app.router.add_post("/graphql", graphql)
    server = TestServer(app)
    await server.start_server()
    monkeypatch.setattr(catalog, "JUSTWATCH_URL", str(server.make_url("/graphql")))
    return server, asked


def watched() -> list[dict]:
    e = history.clean({"pkg": "com.netflix.ninja", "app": "Netflix", "title": "Chapter Seven: The Bathtub",
                       "subtitle": "Stranger Things · S1 E7", "positionMs": 600_000, "durationMs": 3_000_000, "at": NOW})
    yt = history.clean({"pkg": "com.google.android.youtube.tv", "app": "YouTube", "title": "Ice in the Cascades", "at": NOW})
    return [e, yt]


def test_the_answer_is_read_however_it_comes():
    assert [p["title"] for p in smart_recs.parse_picks(json.dumps(ANSWER))][:2] == ["Stranger Things", "the bear"]
    fenced = "```json\n" + json.dumps(ANSWER["picks"]) + "\n```"
    assert len(smart_recs.parse_picks(fenced)) == 6
    odd = smart_recs.parse_picks(json.dumps([{"title": " Dune ", "year": "1984", "kind": "film"}, {"title": "dune"}, {"x": 1}]))
    assert odd == [{"title": "Dune", "year": None, "kind": None, "app_hint": None}]
    for bad in ("Sorry, I can't.", "{}", json.dumps({"picks": []})):
        with pytest.raises(smart_recs.PicksError):
            smart_recs.parse_picks(bad)


def test_what_was_watched_reads_as_one_line_a_show():
    lines = smart_recs.watched_lines(watched())
    assert any(line.endswith("Stranger Things · last: Chapter Seven: The Bathtub (S1 E7) · 20% through") for line in lines)
    assert any("YouTube · Ice in the Cascades" in line for line in lines)
    text = smart_recs.prompt(lines, APPS)
    assert "Netflix, Hulu" in text and "Stranger Things" in text and '"picks"' in text
    assert smart_recs.app_named("HBO Max", ["Netflix", "Max"]) == "Max"
    assert smart_recs.app_named("Disney Plus", ["Disney+"]) == "Disney+"
    assert smart_recs.app_named("Apple TV+", ["Apple TV"]) == "Apple TV"
    assert smart_recs.app_named("Showtime", APPS) is None


def test_picks_become_tiles_in_the_tvs_apps(tmp_path, monkeypatch):
    async def go():
        server, asked = await fake_justwatch(monkeypatch)
        try:
            async with aiohttp.ClientSession() as http:
                picks = smart_recs.parse_picks(json.dumps(ANSWER))
                tiles = await smart_recs.resolve(picks, APPS, watched(), http, tmp_path)
        finally:
            await server.close()
        assert [(t["id"], t["app"]) for t in tiles] == [("ts300000", "hulu"), ("tm1065711", "netflix")]
        bear = tiles[0]
        assert bear["poster"].startswith("/api/tv/img/poster/") and bear["pkg"] == "com.hulu.livingroomplus" and "reason" not in bear
        # Searched in the TV's apps' packages, only what's included, a film or a show as named.
        finds = [a for a in asked if "searchQuery" in a]
        assert all(a["monetizationTypes"] == catalog.MONETIZATION for a in finds)
        assert {tuple(a["objectTypes"]) for a in finds} == {("SHOW",), ("MOVIE",)}
    asyncio.run(go())


def fake_codex(tmp_path: Path, answer: str | None, code: int = 0, said: str = "") -> Path:
    """A `codex` that records its arguments and writes `answer` where -o says."""
    exe = tmp_path / "codex"
    exe.write_text(f"""#!{sys.executable}
import json, sys
args = sys.argv[1:]
open({str(tmp_path / 'args.json')!r}, 'w').write(json.dumps({{"args": args, "stdin": sys.stdin.read()}}))
answer = {answer!r}
if answer is not None:
    open(args[args.index('--output-last-message') + 1], 'w').write(answer)
sys.stderr.write({said!r})
sys.exit({code})
""")
    exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    return exe


def test_codex_is_asked_read_only_with_the_schema(tmp_path):
    exe = fake_codex(tmp_path, json.dumps(ANSWER))
    assert json.loads(smart_recs.ask_codex("Pick some films", str(exe))) == ANSWER
    ran = json.loads((tmp_path / "args.json").read_text())
    a = ran["args"]
    assert a[0] == "exec" and a[a.index("--sandbox") + 1] == "read-only" and "--ephemeral" in a and a[-1] == "-"
    assert "--output-schema" in a and ran["stdin"] == "Pick some films"
    signed_out = fake_codex(tmp_path, None, code=1, said="Error: not logged in. Run codex login\n")
    with pytest.raises(smart_recs.PicksError, match="codex login"):
        smart_recs.ask_codex("x", str(signed_out))
    with pytest.raises(smart_recs.PicksError, match="isn't installed"):
        smart_recs.ask_codex("x", str(tmp_path / "no-codex"))


def test_a_bad_night_keeps_the_last_picks(tmp_path, monkeypatch):
    async def go():
        server, _ = await fake_justwatch(monkeypatch)
        monkeypatch.setattr(smart_recs, "tv_apps", lambda hub: APPS)
        monkeypatch.setattr(smart_recs, "tell_tv", lambda hub: False)
        history.WatchLog(tmp_path).add([{"pkg": "com.netflix.ninja", "title": "Chapter Seven: The Bathtub",
                                         "subtitle": "Stranger Things · S1 E7", "at": NOW}])
        try:
            good = fake_codex(tmp_path, json.dumps(ANSWER))
            tiles = await smart_recs.run(tmp_path, "http://hub", str(good), dry_run=False)
            kept = json.loads((tmp_path / catalog.SMART_FILE).read_text())
            assert [t["id"] for t in kept["picks"]] == [t["id"] for t in tiles] == ["ts300000", "tm1065711"]
            assert kept["generatedAt"] and kept["asked"] == 6
            # What Codex was told: the show being watched, and the TV's apps.
            told = json.loads((tmp_path / "args.json").read_text())["stdin"]
            assert "Stranger Things" in told and "Netflix, Hulu" in told
            before = (tmp_path / catalog.SMART_FILE).read_text()
            for answer in ("no idea", json.dumps({"picks": [{"title": "Nothing Like It", "year": 2025, "kind": "movie", "app_hint": None}]})):
                with pytest.raises(smart_recs.PicksError):
                    await smart_recs.run(tmp_path, "http://hub", str(fake_codex(tmp_path, answer)), dry_run=False)
                assert (tmp_path / catalog.SMART_FILE).read_text() == before
        finally:
            await server.close()
    asyncio.run(go())


def test_tonights_films_come_first_for_twelve_hours(tmp_path):
    cat = catalog.Catalog(tmp_path, apps=lambda: ["Hulu"])
    film = {"id": "tm100000", "title": "National Treasure", "pkg": "com.hulu.livingroomplus", "kind": "movie"}
    path = tmp_path / catalog.EVENING_FILE
    path.write_text(json.dumps({"generatedAt": "2026-10-23T16:30:00", "picks": [film, {"id": "../x"}], "recent": ["National Treasure"]}))
    made = path.stat().st_mtime
    assert [t["id"] for t in cat.evening_picks(now=made + 3600)] == ["tm100000"]
    assert cat.evening_picks(now=made + 13 * 3600) == []


def test_the_evening_asks_for_films_in_riley_s_taste_without_repeats(tmp_path):
    (tmp_path / smart_recs.TASTE_FILE).write_text("Loves The Goonies and National Treasure.")
    text = smart_recs.evening_prompt(["2026-10-22 · YouTube · Ice in the Cascades"], ["Hulu", "Disney+"],
                                     smart_recs.taste(tmp_path), ["The Sandlot"], "Friday October 23")
    assert "Loves The Goonies" in text and "- The Sandlot" in text and "feature films (no series)" in text
    assert "Friday October 23" in text and "Ice in the Cascades" in text
    assert smart_recs.taste(tmp_path / "nowhere") == "" and smart_recs.about("") == ""


def test_the_night_asks_for_titles_it_hasn_t_suggested_lately_and_tells_the_tv(tmp_path, monkeypatch):
    async def go():
        server, _ = await fake_justwatch(monkeypatch)
        told = []
        monkeypatch.setattr(smart_recs, "tv_apps", lambda hub: APPS)
        monkeypatch.setattr(smart_recs, "tell_tv", told.append)
        history.WatchLog(tmp_path).add([{"pkg": "com.netflix.ninja", "title": "Chapter Seven: The Bathtub",
                                         "subtitle": "Stranger Things · S1 E7", "at": NOW}])
        # Last night's file, from before nights were remembered: its picks are what was shown.
        (tmp_path / catalog.SMART_FILE).write_text(json.dumps({"picks": [
            {"id": "ts300000", "title": "The Bear", "pkg": "com.hulu.livingroomplus"}]}))
        (tmp_path / catalog.EVENING_FILE).write_text(json.dumps({"picks": [
            {"id": "tm1", "title": "National Treasure", "pkg": "com.hulu.livingroomplus"}], "recent": ["National Treasure"]}))
        try:
            codex = fake_codex(tmp_path, json.dumps(ANSWER))
            tiles = await smart_recs.run(tmp_path, "http://hub", str(codex), dry_run=False)
            asked = json.loads((tmp_path / "args.json").read_text())["stdin"]
            lately = asked.split("Already suggested on recent days", 1)[1].split("Suggest ", 1)[0]
            assert "- The Bear" in lately and "- National Treasure" in lately
            # Codex named The Bear again: with too few new titles it stays, after the new one.
            assert [t["id"] for t in tiles] == ["tm1065711", "ts300000"]
            kept = json.loads((tmp_path / catalog.SMART_FILE).read_text())
            assert kept["recent"] == [t["title"] for t in tiles]
            assert told == ["http://hub"]
            # With enough new titles, a repeat is left out altogether.
            monkeypatch.setattr(smart_recs, "MIN_NEW", 1)
            (tmp_path / catalog.SMART_FILE).write_text(json.dumps({"picks": [], "recent": ["The Bear"]}))
            tiles = await smart_recs.run(tmp_path, "http://hub", str(codex), dry_run=False)
            assert [t["id"] for t in tiles] == ["tm1065711"]
            assert json.loads((tmp_path / catalog.SMART_FILE).read_text())["recent"][:2] == [tiles[0]["title"], "The Bear"]
        finally:
            await server.close()
    asyncio.run(go())


def test_the_hub_is_asked_to_show_the_new_picks_on_the_tv(monkeypatch):
    async def go():
        answers = [{"ok": True}, {"ok": False, "error": "This hub isn't paired with the TV's launcher"}]
        asked = []

        async def refresh(request):
            asked.append(request.path)
            return web.json_response(answers[len(asked) - 1])

        app = web.Application()
        app.router.add_post("/api/tv/catalog/refresh", refresh)
        server = TestServer(app)
        await server.start_server()
        try:
            hub = str(server.make_url("/"))
            assert await asyncio.to_thread(smart_recs.tell_tv, hub) is True
            assert await asyncio.to_thread(smart_recs.tell_tv, hub) is False
        finally:
            await server.close()
        assert asked == ["/api/tv/catalog/refresh"] * 2
        assert await asyncio.to_thread(smart_recs.tell_tv, "http://127.0.0.1:9") is False  # no hub there
    asyncio.run(go())


def test_tonights_films_give_way_to_the_night_s_picks(tmp_path):
    import os
    cat = catalog.Catalog(tmp_path, apps=lambda: ["Hulu"])
    film = {"id": "tm100000", "title": "National Treasure", "pkg": "com.hulu.livingroomplus", "kind": "movie"}
    pick = {"id": "tm200000", "title": "Palm Springs", "pkg": "com.hulu.livingroomplus", "kind": "movie"}
    evening, night = tmp_path / catalog.EVENING_FILE, tmp_path / catalog.SMART_FILE
    evening.write_text(json.dumps({"picks": [film]}))
    night.write_text(json.dumps({"picks": [pick]}))
    made = time.time() - 4 * 3600   # 16:30
    os.utime(night, (made - 13 * 3600, made - 13 * 3600))  # last night's 03:00
    os.utime(evening, (made, made))
    assert [t["id"] for t in cat.evening_picks(now=made + 3600)] == ["tm100000"]
    os.utime(night, (made + 10.5 * 3600, made + 10.5 * 3600))  # this morning's 03:00
    assert cat.evening_picks(now=made + 11 * 3600) == []
