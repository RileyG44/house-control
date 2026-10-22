#!/usr/bin/env python3
"""The nightly picks for the TV's Fresh today row (docs/streaming-catalog.md).

    .venv/bin/python smart_recs.py [--dry-run]

Run at 03:00 on the Dell by house-smart-recs.timer (systemd/; hub/README.md has the install):

1. What the TV played in the last 90 days (~/.house-hub/watch-history.jsonl, history.py) and the
   streaming apps it has (the running hub's /api/tv/catalog).
2. Codex (`codex exec`: read-only, no session kept, its answer held to SCHEMA) names 20 to 30 titles
   on those apps that aren't anything already watched or started.
3. Each is looked up on JustWatch (catalog.Catalog.find) and kept only when one of those apps
   includes it in the subscription; it becomes a catalog tile like any other, with its poster,
   backdrop and links, in the app Codex named when that one has it.
4. ~/.house-hub/smart-recs.json {generatedAt, picks}, which the hub's "For you" serves after the
   shows being watched. Nothing says why a title is there.

When anything goes wrong (no Codex, signed out, an answer that isn't the JSON, nothing found)
the previous file stays and the exit status isn't 0, so systemd's journal shows it.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import aiohttp

sys.path.insert(0, str(Path(__file__).resolve().parent))

import catalog  # noqa: E402
from history import WatchLog  # noqa: E402
from tv import APP_IDS, APPS, BY_PACKAGE  # noqa: E402

log = logging.getLogger("house.smart")

CONF = Path(os.environ.get("HOUSE_HUB_DIR", Path.home() / ".house-hub"))
HUB = os.environ.get("HOUSE_HUB_URL", "http://127.0.0.1:8766")
DAYS = 90
WANT = 25
KEEP = 30
CODEX_TIMEOUT = 15 * 60

SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["picks"],
    "properties": {
        "picks": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["title", "year", "kind", "app_hint"],
                "properties": {
                    "title": {"type": "string"},
                    "year": {"type": ["integer", "null"]},
                    "kind": {"type": "string", "enum": ["movie", "show"]},
                    "app_hint": {"type": ["string", "null"]},
                },
            },
        },
    },
}


class PicksError(Exception):
    """Nothing to show tonight: the reason, for the journal."""


# ---------- what was watched ----------

def show_of(e: dict) -> str:
    """The show for an episode ("Stranger Things · S1 E7" names it), else the title."""
    return catalog.seed_query(e)


def watched_lines(entries: list[dict], limit: int = 250) -> list[str]:
    """One line per title (an episode's show once), most recent first: day, app, title, how far."""
    seen: dict[str, dict] = {}
    for e in sorted(entries, key=lambda e: e["at"], reverse=True):
        name = show_of(e)
        k = f"{e['pkg']}|{name.casefold()}"
        if k in seen:
            seen[k]["n"] += 1
            continue
        seen[k] = {"e": e, "name": name, "n": 1}
    lines = []
    for v in list(seen.values())[:limit]:
        e = v["e"]
        app = e.get("app") or BY_PACKAGE.get(e["pkg"]) or e["pkg"]
        bits = [e["day"], app, v["name"]]
        if v["name"] != e["title"]:
            bits.append(f"last: {e['title']}" + (f" ({e['subtitle'].split(' · ', 1)[-1]})" if e.get("subtitle") else ""))
        if e.get("progress") is not None:
            bits.append(f"{round(e['progress'] * 100)}% through")
        if v["n"] > 1:
            bits.append(f"{v['n']} days")
        lines.append(" · ".join(bits))
    return lines


def prompt(lines: list[str], apps: list[str]) -> str:
    history = "\n".join(f"- {line}" for line in lines) or "- (nothing recorded yet)"
    return f"""You choose what Riley might enjoy watching next on the living room TV.

Their streaming services (US): {", ".join(apps)}.

What the TV played in the last {DAYS} days, most recent first (day · app · title · details):
{history}

Suggest {WANT} films or series that:
- are available to stream on one of those services in the US right now, included in the subscription (not rent or buy);
- are none of the titles above, nor any show whose episodes appear above (they have seen or started those);
- fit their taste as the list shows it, with some variety in genre and service;
- lean towards recent and well regarded titles (at most a third from before 2016).

Answer with JSON only, matching the schema: {{"picks": [{{"title", "year", "kind": "movie" or "show", "app_hint": the service you expect it on, exactly as named above, or null}}]}}.
Use each title's usual English name and first release year. No explanations, no other text."""


# ---------- Codex ----------

def ask_codex(text: str, codex: str = "codex") -> str:
    """Codex's last message for `text`, run read-only in an empty folder, keeping no session."""
    exe = shutil.which(codex) or shutil.which(codex, path=str(Path.home() / ".local/bin"))
    if not exe:
        raise PicksError("Codex isn't installed for this user: install it, then run `codex login` once")
    with tempfile.TemporaryDirectory() as tmp:
        schema = Path(tmp) / "schema.json"
        out = Path(tmp) / "answer.json"
        schema.write_text(json.dumps(SCHEMA))
        work = Path(tmp) / "work"
        work.mkdir()
        cmd = [exe, "exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "--color", "never",
               "--cd", str(work), "--output-schema", str(schema), "--output-last-message", str(out), "-"]
        try:
            r = subprocess.run(cmd, input=text, capture_output=True, text=True, timeout=CODEX_TIMEOUT)
        except subprocess.TimeoutExpired as e:
            raise PicksError(f"Codex took longer than {CODEX_TIMEOUT // 60} minutes") from e
        answer = out.read_text() if out.exists() else ""
        if r.returncode != 0 or not answer.strip():
            said = (r.stderr or r.stdout or "").strip().splitlines()[-3:]
            hint = " (signed out? run `codex login` on this computer)" if re.search(r"log ?in|auth|401", " ".join(said), re.I) else ""
            raise PicksError(f"Codex failed (exit {r.returncode}){hint}: {' / '.join(said)[:400]}")
        return answer


def parse_picks(answer: str) -> list[dict]:
    """The picks in Codex's answer: {"picks": [...]} or a bare list, even inside a code fence."""
    text = answer.strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    data = None
    for candidate in (text, *re.findall(r"(\{.*\}|\[.*\])", text, re.S)):
        try:
            data = json.loads(candidate)
            break
        except ValueError:
            continue
    if isinstance(data, dict):
        data = data.get("picks")
    if not isinstance(data, list):
        raise PicksError("Codex's answer isn't the picks' JSON: " + text[:200])
    out, seen = [], set()
    for p in data:
        if not isinstance(p, dict) or not isinstance(p.get("title"), str) or not p["title"].strip():
            continue
        title = " ".join(p["title"].split())[:200]
        year = p.get("year") if isinstance(p.get("year"), int) and not isinstance(p.get("year"), bool) and 1900 < p["year"] < 2100 else None
        kind = p.get("kind") if p.get("kind") in ("movie", "show") else None
        hint = p.get("app_hint") if isinstance(p.get("app_hint"), str) else None
        if title.casefold() in seen:
            continue
        seen.add(title.casefold())
        out.append({"title": title, "year": year, "kind": kind, "app_hint": hint})
    if not out:
        raise PicksError("Codex named no titles")
    return out


def app_named(hint: str | None, apps: list[str]) -> str | None:
    """Codex's service name as one of the TV's apps ("HBO Max" for Max, "Disney Plus" for Disney+)."""
    if not hint:
        return None
    h = re.sub(r"[^a-z0-9]", "", hint.casefold()).replace("plus", "")
    for name in apps:
        n = re.sub(r"[^a-z0-9]", "", name.casefold()).replace("plus", "")
        if h == n or (n and n in h) or APP_IDS.get(name) == h:
            return name
    return None


# ---------- JustWatch ----------

async def resolve(picks: list[dict], apps: list[str], watched: list[dict], http: aiohttp.ClientSession,
                  scratch: Path) -> list[dict]:
    """The picks as tiles in the TV's apps, in Codex's order, without anything already watched."""
    cat = catalog.Catalog(scratch, apps=lambda: apps)  # its own cache: the hub keeps its own
    cat.http = http
    seen_titles = {show_of(e).casefold() for e in watched} | {e["title"].casefold() for e in watched}
    seen_ids = {e["jw"] for e in watched if e.get("jw")}
    found = await asyncio.gather(*(cat.find(p["title"], apps, year=p["year"], kind=p["kind"], prefer=app_named(p["app_hint"], apps))
                                   for p in picks))
    out, ids = [], set()
    for p, t in zip(picks, found):
        if t is None:
            log.info("Not on the TV's apps: %s (%s)", p["title"], p["year"])
            continue
        if t["id"] in ids or t["id"] in seen_ids or any(catalog.same_title(t["title"], s) for s in seen_titles):
            continue
        ids.add(t["id"])
        out.append(t)
    return out[:KEEP]


# ---------- the run ----------

def tv_apps(hub: str) -> list[str]:
    """The streaming apps the TV has, as the running hub's catalog lists them."""
    try:
        with urllib.request.urlopen(hub.rstrip("/") + "/api/tv/catalog", timeout=120) as r:
            data = json.load(r)
    except (OSError, ValueError) as e:
        raise PicksError(f"The hub at {hub} didn't answer: {e}") from e
    names = [a.get("name") for a in data.get("apps") or [] if isinstance(a, dict) and a.get("name") in APPS]
    if not names:
        raise PicksError("The hub lists no streaming apps on the TV")
    return names


def write(conf: Path, tiles: list[dict], asked: int) -> Path:
    path = conf / catalog.SMART_FILE
    data = {"generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "asked": asked, "picks": tiles}
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=1))
    tmp.replace(path)
    return path


async def run(conf: Path, hub: str, codex: str, dry_run: bool) -> list[dict]:
    watched = WatchLog(conf).recent(DAYS)
    apps = tv_apps(hub)
    lines = watched_lines(watched)
    log.info("%d titles watched in %d days; apps: %s", len(lines), DAYS, ", ".join(apps))
    answer = await asyncio.to_thread(ask_codex, prompt(lines, apps), codex)
    picks = parse_picks(answer)
    with tempfile.TemporaryDirectory() as scratch:
        async with aiohttp.ClientSession() as http:
            tiles = await resolve(picks, apps, watched, http, Path(scratch))
    if not tiles:
        raise PicksError(f"None of Codex's {len(picks)} titles is on the TV's apps")
    log.info("%d of %d picks are on the TV's apps", len(tiles), len(picks))
    if not dry_run:
        log.info("Wrote %s", write(conf, tiles, len(picks)))
    return tiles


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--conf", type=Path, default=CONF)
    ap.add_argument("--hub", default=HUB)
    ap.add_argument("--codex", default="codex")
    ap.add_argument("--dry-run", action="store_true", help="print the picks; leave smart-recs.json alone")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    try:
        tiles = asyncio.run(run(args.conf, args.hub, args.codex, args.dry_run))
    except PicksError as e:
        log.error("No new picks; the previous ones stay. %s", e)
        return 1
    if args.dry_run:
        for t in tiles:
            print(f"{t['title']} ({t['year']}) · {t['app']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
