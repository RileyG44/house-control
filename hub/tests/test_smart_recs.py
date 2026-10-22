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
