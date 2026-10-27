#!/usr/bin/env python3
"""The nightly picks for the TV's Fresh today row (docs/streaming-catalog.md).

    .venv/bin/python smart_recs.py [--evening] [--dry-run]

Run at 03:00 on the Dell by house-smart-recs.timer (systemd/; hub/README.md has the install), and
with --evening at 16:30 by house-smart-evening.timer: a dozen films for tonight, waiting on Home
when Riley gets in from work (smart-evening.json, which For you puts first until it is 12 hours
old). Both tell Codex what ~/.house-hub/taste.md says about Riley, when it is there (not in git).

1. What the TV played in the last 90 days (~/.house-hub/watch-history.jsonl, history.py) and the
   streaming apps it has (the running hub's /api/tv/catalog).
2. Codex (`codex exec`: read-only, no session kept, its answer held to SCHEMA) names 20 to 30 titles
   on those apps that aren't anything already watched or started.
3. Each is looked up on JustWatch (catalog.Catalog.find) and kept only when one of those apps
   includes it in the subscription; it becomes a catalog tile like any other, with its poster,
   backdrop and links, in the app Codex named when that one has it.
4. ~/.house-hub/smart-recs.json {generatedAt, picks, recent}, which the hub's "For you" serves after
   the shows being watched. Nothing says why a title is there. `recent` is the last few nights'
   titles: the next night asks for others, so the row is new each morning.
5. The running hub is asked to have the TV read its rows again (POST /api/tv/catalog/refresh), so
   the new picks are on Home at once rather than at the TV's next three-hourly read.

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
EVENING_WANT = 16
EVENING_KEEP = 12
NIGHTS_KEPT = 100   # titles of recent nights the next night avoids (about four nights' worth)
MIN_NEW = 12        # fewer new titles than this, and repeats fill the row after them
TASTE_FILE = "taste.md"
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


def taste(conf: Path) -> str:
    """What Riley told us about their taste (taste.md in the hub's folder), if anything."""
    try:
        return (conf / TASTE_FILE).read_text().strip()[:6000]
    except OSError:
        return ""


def about(text: str) -> str:
    return f"\nAbout Riley, in their own words and from what they do:\n{text}\n" if text else ""


def prompt(lines: list[str], apps: list[str], profile: str = "", shown: list[str] | None = None) -> str:
    history = "\n".join(f"- {line}" for line in lines) or "- (nothing recorded yet)"
    lately = "\n".join(f"- {t}" for t in shown or []) or "- (none yet)"
    return f"""You choose what Riley might enjoy watching next on the living room TV.

Their streaming services (US): {", ".join(apps)}.
{about(profile)}
What the TV played in the last {DAYS} days, most recent first (day · app · title · details):
{history}

Already suggested on recent days, on the TV's Home now or lately (suggest different ones, so the row is new):
{lately}

Suggest {WANT} films or series that:
- are available to stream on one of those services in the US right now, included in the subscription (not rent or buy);
- are none of the titles above (watched, started or already suggested), nor any show whose episodes appear above;
- fit their taste as the list shows it, with some variety in genre and service. YouTube videos say what interests them (subjects, channels, tone): turn those into films and series on the services, documentaries and docuseries included where they fit. Ignore test clips and demo reels;
- lean towards recent and well regarded titles (at most a third from before 2016).

Answer with JSON only, matching the schema: {{"picks": [{{"title", "year", "kind": "movie" or "show", "app_hint": the service you expect it on, exactly as named above, or null}}]}}.
Use each title's usual English name and first release year. No explanations, no other text."""


def evening_prompt(lines: list[str], apps: list[str], profile: str, recent: list[str], day: str) -> str:
    """Tonight's films: the evening run's question."""
    history = "\n".join(f"- {line}" for line in lines) or "- (nothing recorded yet)"
    lately = "\n".join(f"- {t}" for t in recent) or "- (none yet)"
    return f"""You pick tonight's movies for Riley: it is {day}, and these will be waiting on the living room TV
when they get home from work.

Their streaming services (US): {", ".join(apps)}.
{about(profile)}
What the TV played in the last {DAYS} days, most recent first (day · app · title · details):
{history}

Films already suggested on recent evenings (don't repeat them):
{lately}

Suggest {EVENING_WANT} feature films (no series) that:
- are available to stream on one of those services in the US right now, included in the subscription (not rent or buy);
- are none of the titles above;
- make a good night in: crowd-pleasers, adventures, comedies and the odd great documentary, the kind of thing to put on after work;
- lean on the films and eras Riley says they love (about half nostalgic picks in that vein, the rest newer or different), and suit the day of the week;
- vary in tone and service, best first.

Answer with JSON only, matching the schema: {{"picks": [{{"title", "year", "kind": "movie", "app_hint": the service you expect it on, exactly as named above, or null}}]}}.
Use each title's usual English name and first release year. No explanations, no other text."""


# ---------- Codex ----------

def find_codex(codex: str = "codex") -> str | None:
    """The Codex to run: on the PATH, else where its installer puts it (~/.local/bin on the Dell,
    an nvm Node's bin on the Mac, the newest Node first). The house agent (agent.py) uses it too."""
    found = shutil.which(codex) or shutil.which(codex, path=str(Path.home() / ".local/bin"))
    if found or os.sep in codex:
        return found
    nvm = sorted(Path.home().glob(f".nvm/versions/node/*/bin/{codex}"), reverse=True)
    return next((str(p) for p in nvm if os.access(p, os.X_OK)), None)


def ask_codex(text: str, codex: str = "codex") -> str:
    """Codex's last message for `text`, run read-only in an empty folder, keeping no session."""
    exe = find_codex(codex)
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
                  scratch: Path, shown: list[str] | None = None) -> list[dict]:
    """The picks as tiles in the TV's apps, in Codex's order, without anything already watched.
    Titles in `shown` (suggested lately) go after the new ones, and only when too few are new."""
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
    if shown:
        new = [t for t in out if not any(catalog.same_title(t["title"], s) for s in shown)]
        if len(new) < len(out):
            log.info("%d of the %d were suggested lately%s", len(out) - len(new), len(out),
                     "" if len(new) >= MIN_NEW else "; they fill the row after the new ones")
        out = new if len(new) >= MIN_NEW else new + [t for t in out if t not in new]
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


def nightly_recent(conf: Path) -> list[str]:
    """The titles of the last few nights, newest first: the picks file's `recent`, else its picks."""
    try:
        data = json.loads((conf / catalog.SMART_FILE).read_text())
    except (OSError, ValueError):
        return []
    if not isinstance(data, dict):
        return []
    titles = data.get("recent")
    if not isinstance(titles, list):
        titles = [p.get("title") for p in data.get("picks") or [] if isinstance(p, dict)]
    return [t for t in titles if isinstance(t, str) and t.strip()][:NIGHTS_KEPT]


def evening_tonight(conf: Path) -> list[str]:
    """The films the evening run picked last (they lead Home until the night's picks come)."""
    try:
        data = json.loads((conf / catalog.EVENING_FILE).read_text())
        return [p["title"] for p in data.get("picks") or [] if isinstance(p, dict) and isinstance(p.get("title"), str)]
    except (OSError, ValueError, AttributeError, TypeError):
        return []


def tell_tv(hub: str) -> bool:
    """Asks the running hub to have the TV read its rows again, so new picks show at once."""
    req = urllib.request.Request(hub.rstrip("/") + "/api/tv/catalog/refresh", data=b"{}", method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            answer = json.load(r)
    except (OSError, ValueError) as e:
        log.info("The TV gets them at its next read (the hub: %s)", e)
        return False
    if answer.get("ok") is True:
        log.info("Told the TV, which shows them now")
        return True
    log.info("The TV gets them at its next read (%s)", answer.get("error") or "the hub couldn't tell it")
    return False


def evening_recent(conf: Path) -> list[str]:
    """The films suggested on the last few evenings, newest first."""
    with_errors = (OSError, ValueError, AttributeError, TypeError)
    try:
        data = json.loads((conf / catalog.EVENING_FILE).read_text())
        return [t for t in data.get("recent") or [] if isinstance(t, str)][:60]
    except with_errors:
        return []


def write(conf: Path, tiles: list[dict], asked: int, name: str = catalog.SMART_FILE, **extra) -> Path:
    path = conf / name
    data = {"generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "asked": asked, "picks": tiles, **extra}
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=1))
    tmp.replace(path)
    return path


async def run(conf: Path, hub: str, codex: str, dry_run: bool, evening: bool = False) -> list[dict]:
    watched = WatchLog(conf).recent(DAYS)
    apps = tv_apps(hub)
    lines = watched_lines(watched)
    profile = taste(conf)
    log.info("%d titles watched in %d days; apps: %s%s", len(lines), DAYS, ", ".join(apps),
             "; with taste.md" if profile else "")
    recent = evening_recent(conf) if evening else nightly_recent(conf)
    # The night avoids its own last nights, and the films the evening has put first on Home.
    shown = [] if evening else list(dict.fromkeys(recent + evening_tonight(conf)))
    text = (evening_prompt(lines, apps, profile, recent, time.strftime("%A %B %-d")) if evening
            else prompt(lines, apps, profile, shown))
    answer = await asyncio.to_thread(ask_codex, text, codex)
    picks = parse_picks(answer)
    if evening:
        picks = [{**p, "kind": "movie"} for p in picks if p["kind"] != "show"]
    with tempfile.TemporaryDirectory() as scratch:
        async with aiohttp.ClientSession() as http:
            tiles = await resolve(picks, apps, watched, http, Path(scratch), shown)
    if evening:
        tiles = [t for t in tiles if t.get("kind") == "movie"][:EVENING_KEEP]
    if not tiles:
        raise PicksError(f"None of Codex's {len(picks)} titles is on the TV's apps")
    log.info("%d of %d picks are on the TV's apps", len(tiles), len(picks))
    if not dry_run:
        if evening:
            fresh = [t["title"] for t in tiles]
            path = write(conf, tiles, len(picks), catalog.EVENING_FILE,
                         recent=fresh + [t for t in recent if t not in fresh][:60 - len(fresh)])
        else:
            fresh = [t["title"] for t in tiles]
            path = write(conf, tiles, len(picks),
                         recent=fresh + [t for t in recent if t not in fresh][:NIGHTS_KEPT - len(fresh)])
        log.info("Wrote %s", path)
        tell_tv(hub)
    return tiles


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--conf", type=Path, default=CONF)
    ap.add_argument("--hub", default=HUB)
    ap.add_argument("--codex", default="codex")
    ap.add_argument("--evening", action="store_true", help="tonight's films (smart-evening.json)")
    ap.add_argument("--dry-run", action="store_true", help="print the picks; leave the picks' file alone")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    try:
        tiles = asyncio.run(run(args.conf, args.hub, args.codex, args.dry_run, args.evening))
    except PicksError as e:
        log.error("No new picks; the previous ones stay. %s", e)
        return 1
    if args.dry_run:
        for t in tiles:
            print(f"{t['title']} ({t['year']}) · {t['app']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
