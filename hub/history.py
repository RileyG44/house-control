"""What the TV played, kept on the hub for the nightly picks (smart_recs.py).

  POST /api/tv/history          {"entries": [{pkg, app, title, subtitle, positionMs, durationMs, at, first, jw}]}
  GET  /api/tv/history?days=90  {"entries": [...]}, oldest first

The launcher sends each title it records from the apps' Now Playing (history/HistorySync.kt), a
batch a minute, again until the hub takes it. `at` and `first` are unix milliseconds; `jw` is the
JustWatch title the launcher opened just before, when it knows it.

~/.house-hub/watch-history.jsonl has one line per title, app and day (the TV's local day): the
same title played again that day updates its line (the latest position; `first` stays the first
time that day). Kept for good; it grows by a few kilobytes a day.
"""
from __future__ import annotations

import contextlib
import json
import logging
import re
import time
from pathlib import Path

log = logging.getLogger("house.history")

FILE = "watch-history.jsonl"
MAX_BATCH = 200
_PKG = re.compile(r"^[A-Za-z][A-Za-z0-9_.]{1,150}$")
_JW = re.compile(r"^t[a-z]{1,3}\d{1,12}$")
_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
EARLIEST = 1_577_836_800_000  # 2020-01-01: nothing older is real


def _text(v, limit: int) -> str | None:
    return " ".join(v.split())[:limit] or None if isinstance(v, str) else None


def _ms(v) -> int | None:
    return int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0 else None


def clean(e, now_ms: int | None = None) -> dict | None:
    """One entry as the hub keeps it, or None when it isn't one."""
    if not isinstance(e, dict):
        return None
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    pkg, title = e.get("pkg"), _text(e.get("title"), 300)
    if not isinstance(pkg, str) or not _PKG.match(pkg) or not title:
        return None
    at = _ms(e.get("at"))
    at = at if at is not None and EARLIEST <= at <= now_ms + 86_400_000 else now_ms
    first = _ms(e.get("first"))
    first = first if first is not None and EARLIEST <= first <= at else at
    pos, dur = _ms(e.get("positionMs")) or 0, _ms(e.get("durationMs")) or 0
    day = e.get("day") if isinstance(e.get("day"), str) and _DAY.match(e["day"]) else time.strftime("%Y-%m-%d", time.localtime(at / 1000))
    jw = e.get("jw") if isinstance(e.get("jw"), str) and _JW.match(e["jw"]) else None
    return {
        "day": day, "pkg": pkg, "app": _text(e.get("app"), 60), "title": title, "subtitle": _text(e.get("subtitle"), 300),
        "positionMs": min(pos, 10**9), "durationMs": min(dur, 10**9),
        "progress": round(min(pos / dur, 1.0), 3) if dur > 0 else None,
        "first": first, "at": at, "jw": jw,
    }


def _key(e: dict) -> tuple[str, str, str]:
    return e["pkg"], e["title"].casefold(), e["day"]


class WatchLog:
    """watch-history.jsonl, read once and kept in memory, rewritten whole when it changes."""

    def __init__(self, conf: Path):
        self.file = conf / FILE
        self._lines: dict[tuple[str, str, str], dict] | None = None

    def _all(self) -> dict[tuple[str, str, str], dict]:
        if self._lines is None:
            self._lines = {}
            with contextlib.suppress(OSError):
                for line in self.file.read_text().splitlines():
                    with contextlib.suppress(ValueError):
                        e = clean(json.loads(line))
                        if e:
                            self._merge(e)
        return self._lines

    def _merge(self, e: dict) -> bool:
        k = _key(e)
        old = self._lines.get(k)
        if old is None:
            self._lines[k] = e
            return True
        new = {**old, **{f: v for f, v in e.items() if v is not None}, "first": min(old["first"], e["first"])}
        if e["at"] < old["at"]:
            # An older report of the same day arriving late doesn't undo a newer position.
            new = {**new, **{f: old[f] for f in ("positionMs", "durationMs", "progress", "at")}}
        if new == old:
            return False
        self._lines[k] = new
        return True

    def add(self, entries: list) -> int:
        """Keeps the entries that are entries; returns how many there were."""
        lines = self._all()
        kept = changed = 0
        for raw in entries[:MAX_BATCH]:
            e = clean(raw)
            if e is None:
                continue
            kept += 1
            changed += self._merge(e)
        if changed:
            self._write(lines)
        return kept

    def _write(self, lines: dict) -> None:
        try:
            self.file.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.file.with_suffix(".jsonl.tmp")
            ordered = sorted(lines.values(), key=lambda e: (e["day"], e["first"]))
            tmp.write_text("".join(json.dumps(e, separators=(",", ":")) + "\n" for e in ordered))
            tmp.replace(self.file)
        except OSError as err:
            log.warning("Couldn't keep the watch history in %s: %s", self.file, err)

    def recent(self, days: int = 90, now_ms: int | None = None) -> list[dict]:
        """The last `days` days, oldest first."""
        now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
        cutoff = now_ms - days * 86_400_000
        return sorted((e for e in self._all().values() if e["at"] >= cutoff), key=lambda e: (e["day"], e["first"]))
