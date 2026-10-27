"""The house agent: say (or type) what you want, and Codex does it with the house tools.

docs/voice-agent.md has the whole picture. Two halves:

**HouseTools** are what a person has in the panel, as tools a model can call: look at the home,
switch and dim lights, the AC, scenes, the TV (keys, apps, finding and playing a title), the
speaker (Spotify) and tonight's picks. They run in the hub process on the hub's own objects
(Hub.command, TvRemote, Spotify), take loose names ("bedroom light", "the AC") and answer short
text: what was done and the new state, or why it couldn't be. TOOLS holds their JSON schemas,
the one list both GET /api/agent/tools and the MCP server (agent_mcp.py) hand out.

**Agent** runs a request: `codex exec --json` (the Codex that writes the nightly picks,
smart_recs.py) in an empty folder, read-only, with agent_mcp.py as its one MCP server, which
calls the tools back here over loopback (POST /api/agent/tool/<name>). Its JSONL events, and the
tool calls the hub itself hears, are the run's steps; its last message is the reply. Every panel
hears the run as `{"agent": {...}}` on /api/events. One run at a time, a few more waiting; a hub
without Codex hands the request to the other hub (peer.json) and passes its answer on.
"""
from __future__ import annotations

import asyncio
import contextlib
import difflib
import json
import logging
import os
import re
import signal
import sys
import tempfile
import time
from collections import deque
from pathlib import Path

import aiohttp

import catalog as catalogs
from mrcool import PANEL_FANS, PANEL_MODES
from smart_recs import about, find_codex, taste
from tv import APP_IDS, APP_NAMES, KEYS

log = logging.getLogger("house.agent")

HERE = Path(__file__).resolve().parent
MCP_SERVER = HERE / "agent_mcp.py"
HUB_URL = f"http://127.0.0.1:{os.environ.get('HOUSE_HUB_PORT', '8766')}"
AGENT_TIMEOUT = 120.0   # seconds a request may take, Codex and tools together
QUEUE = 3               # requests that may wait while one runs
MAX_TEXT = 500
OUTPUT_LIMIT = 4 * 1024 * 1024   # one JSONL line can carry a whole tool result
# Settings for Codex on top of the MCP server's: tool calls are never held for an approval
# nobody can give. Not checked against every codex-cli (written for 0.163.0): change them here.
CODEX_SETTINGS = [
    'mcp_servers.house.default_tools_approval_mode="approve"',
    'approval_policy="never"',
]

COLORS = {
    "red": "#ff3b30", "orange": "#ff9500", "yellow": "#ffd60a", "green": "#34c759",
    "cyan": "#32d2f5", "blue": "#0a84ff", "purple": "#8b5cff", "pink": "#ff5fc4",
}
WHITES = {"warm": 2700, "warm white": 2700, "white": 4000, "neutral": 4000, "daylight": 5000, "cool": 6500, "cool white": 6500}
COLOR_NAMES = {v: k for k, v in COLORS.items()}
RANGES = {"F": (61, 86), "C": (16, 30)}   # the panel's own (web/src/config.js), for an AC Cielo doesn't describe

# Words that say what kind of device, not which one; and ones that say nothing.
LIGHT_WORDS = {"light", "lamp", "bulb", "lighting", "fixture"}
AC_WORDS = {"ac", "acs", "air", "conditioner", "conditioning", "aircon", "unit", "hvac", "climate", "thermostat"}
FILLER = {"the", "my", "a", "an", "in", "on", "of", "and", "please", "room", "by", "near", "next", "to", "at", "over"}
EVERY = {"all", "every", "everything", "everywhere"}

# What the TV's keys are called when a model says them otherwise.
TV_ALIASES = {"volume_up": "volup", "volume up": "volup", "louder": "volup", "volume_down": "voldown",
              "volume down": "voldown", "quieter": "voldown", "select": "ok", "enter": "ok",
              "play_pause": "playpause", "resume": "play", "off": "sleep", "turn off": "sleep",
              "on": "wake", "turn on": "wake", "channel up": "chup", "channel down": "chdown"}
SPEAKER_ACTIONS = ["play", "pause", "next", "previous", "volume", "transfer", "play_playlist"]


class ToolError(Exception):
    """What a tool says when it can't: told to the model as the tool's answer."""


def words(text) -> list[str]:
    """Text as the words names are matched by: lower case, no "'s", plurals made singular."""
    out = []
    for w in re.findall(r"[a-z0-9]+", re.sub(r"['’]s\b", "", str(text).casefold())):
        if len(w) > 3 and w.endswith("s") and not w.endswith("ss"):
            w = w[:-1]
        out.append(w)
    return out


def app_id(name) -> str | None:
    """A streaming app by its id or name, loosely ("Disney Plus", "prime", "HBO Max")."""
    if not isinstance(name, str) or not name.strip():
        return None
    if name in APP_NAMES:
        return name
    key = re.sub(r"[^a-z0-9]", "", name.casefold()).replace("plus", "")
    for app, aid in APP_IDS.items():
        n = re.sub(r"[^a-z0-9]", "", app.casefold()).replace("plus", "")
        if key in (n, aid) or (n and n in key) or (len(key) > 2 and n.startswith(key)):
            return aid
    return None


def number(v) -> float | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, str):
        v = v.strip().rstrip("%°").strip()
        with contextlib.suppress(ValueError):
            return float(v)
        return None
    return float(v) if isinstance(v, (int, float)) and v == v else None


# ---------- the tools' schemas ----------

TARGETS = {"description": 'Ids, names ("Edison Bulb", "bedroom light"), room ids or names (every light in it), or "all".',
           "anyOf": [{"type": "string"}, {"type": "array", "items": {"type": "string"}}]}
READ = {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False}
ACT = {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False}

TOOLS = [
    {"name": "get_home", "title": "Look at the home",
     "description": "Every room with its lights and ACs and what they do now, the TV, the speaker (Spotify) and the scenes, with ids.",
     "inputSchema": {"type": "object", "properties": {}}, "annotations": READ},
    {"name": "set_lights", "title": "Switch or adjust lights",
     "description": "Turn lights on or off, dim them, or set their white or colour. A brightness, white or colour also "
                    "switches a light on. Several lights at once is fine.",
     "inputSchema": {"type": "object", "required": ["lights"], "properties": {
         "lights": TARGETS,
         "on": {"type": "boolean"},
         "brightness": {"type": "number", "minimum": 1, "maximum": 100, "description": "Percent"},
         "kelvin": {"type": "number", "minimum": 2200, "maximum": 6500, "description": "White: 2700 warm, 4000 neutral, 6500 cool"},
         "color": {"type": "string", "description": f"#rrggbb or {', '.join(COLORS)}"}}},
     "annotations": ACT},
    {"name": "set_climate", "title": "Control the air conditioner",
     "description": "Switch an AC on or off, set its target temperature (in the AC's own unit, °F or °C as get_home says), "
                    "mode and fan. A target, mode or fan also switches it on unless on is false.",
     "inputSchema": {"type": "object", "properties": {
         "ac": {"type": "string", "description": "Id, name or room; leave out when there is one AC"},
         "on": {"type": "boolean"},
         "mode": {"type": "string", "enum": PANEL_MODES},
         "target": {"type": "number", "description": "In the AC's unit"},
         "fan": {"type": "string", "enum": PANEL_FANS}}},
     "annotations": ACT},
    {"name": "activate_scene", "title": "Activate a scene",
     "description": "Set the lights, ACs, TV and music the way a scene says (get_home lists them).",
     "inputSchema": {"type": "object", "required": ["scene"], "properties": {"scene": {"type": "string", "description": "Id or name"}}},
     "annotations": ACT},
    {"name": "tv", "title": "Use the TV",
     "description": "The TV's remote: a key (" + ", ".join(sorted(KEYS)) + "), volume with level (0 to the TV's maximum), "
                    "open with app (Netflix, YouTube…), or search with text. power toggles; wake and sleep switch it on and off.",
     "inputSchema": {"type": "object", "required": ["action"], "properties": {
         "action": {"type": "string", "enum": sorted(KEYS | {"volume", "open", "search"})},
         "level": {"type": "integer", "minimum": 0},
         "app": {"type": "string"},
         "text": {"type": "string"}}},
     "annotations": {**ACT, "idempotentHint": False}},
    {"name": "find_title", "title": "Find a film or show",
     "description": "Looks a film or series up in the streaming catalog: where it streams among the TV's apps, with the link play_title takes.",
     "inputSchema": {"type": "object", "required": ["query"], "properties": {"query": {"type": "string"}}},
     "annotations": READ},
    {"name": "play_title", "title": "Play a film or show",
     "description": "Opens a title on the TV, straight into it: an app and a link from find_title or picks.",
     "inputSchema": {"type": "object", "required": ["app", "link"], "properties": {
         "app": {"type": "string", "description": "The app's id or name"},
         "link": {"type": "string"}}},
     "annotations": {**ACT, "idempotentHint": False}},
    {"name": "speaker", "title": "Music on the speaker",
     "description": "Spotify, on the Echo or another output: play, pause, next, previous, volume (with level, percent), "
                    "transfer (to device, by name) or play_playlist (by name, from the account's playlists).",
     "inputSchema": {"type": "object", "required": ["action"], "properties": {
         "action": {"type": "string", "enum": SPEAKER_ACTIONS},
         "level": {"type": "number", "minimum": 0, "maximum": 100},
         "device": {"type": "string"},
         "name": {"type": "string"}}},
     "annotations": {**ACT, "idempotentHint": False}},
    {"name": "picks", "title": "Tonight's picks",
     "description": "The films picked for tonight and today's picks for the TV, chosen for Riley, with their apps and links: "
                    "for \"put on something good\".",
     "inputSchema": {"type": "object", "properties": {}}, "annotations": READ},
]


class HouseTools:
    """The tools, on the running hub. `call` answers like an MCP tool: {"content", "isError"},
    with `summary` (one short line, the step a panel shows) and, for get_home, `structuredContent`."""

    def __init__(self, hub):
        self.hub = hub

    async def call(self, name: str, args) -> dict:
        run = getattr(self, f"_{name}", None) if any(t["name"] == name for t in TOOLS) else None
        if run is None:
            return self._error(f"There is no tool {name}. Tools: {', '.join(t['name'] for t in TOOLS)}", f"No tool {name}")
        try:
            out = await run(args if isinstance(args, dict) else {})
        except ToolError as e:
            return self._error(str(e), str(e))
        except Exception as e:
            log.exception("Tool %s failed", name)
            return self._error(f"{name} failed: {e}", f"{name} failed")
        result = {"content": [{"type": "text", "text": out["text"]}], "isError": False, "summary": out["summary"]}
        if out.get("data") is not None:
            result["structuredContent"] = out["data"]
        return result

    @staticmethod
    def _error(text: str, summary: str) -> dict:
        return {"content": [{"type": "text", "text": text}], "isError": True, "summary": summary[:120]}

    # ---------- the home as the plan has it ----------

    @property
    def rooms(self) -> dict[str, str]:
        return {r["id"]: r.get("name") or r["id"] for r in self.hub.plan.get("rooms") or [] if isinstance(r, dict) and r.get("id")}

    def _devices(self, kind: str) -> list[dict]:
        return [d for d in self.hub.plan.get(kind) or [] if isinstance(d, dict) and d.get("id")]

    @property
    def lights(self) -> list[dict]:
        return self._devices("lights")

    @property
    def acs(self) -> list[dict]:
        return self._devices("acs")

    @property
    def scenes(self) -> list[dict]:
        return [s for s in self.hub.plan.get("scenes") or [] if isinstance(s, dict) and s.get("id")]

    def _label(self, d: dict) -> str:
        return d.get("name") or d["id"]

    def _match(self, query, items: list[dict], kind: set[str], what: str) -> list[dict]:
        """`query` (a name, an id, a room, "all", or a list of them) as the devices it means."""
        wanted = query if isinstance(query, list) else [query]
        if not wanted:
            raise ToolError(f"Say which {what}")
        out: list[dict] = []
        for q in wanted:
            for d in self._match_one(q, items, kind, what):
                if d not in out:
                    out.append(d)
        return out

    def _match_one(self, q, items: list[dict], kind: set[str], what: str) -> list[dict]:
        one = what.rstrip("s") if what != "ACs" else "AC"
        if not isinstance(q, str) or not q.strip():
            raise ToolError(f"Say which {what}")
        if not items:
            raise ToolError(f"This home has no {what}")
        for d in items:
            if d["id"] == q:
                return [d]
        rooms = self.rooms
        said = words(q)
        key = [w for w in said if w not in FILLER]
        rest = [w for w in key if w not in kind and w not in EVERY]
        if not rest:
            return list(items)  # "all", "the lights", "the AC"
        named = [d for d in items if [w for w in words(self._label(d)) if w not in FILLER] in (key, rest)]
        if len(named) == 1:
            return named
        room = [rid for rid, name in rooms.items() if rid == q or [w for w in words(name) if w not in FILLER] == rest]
        if room:
            inside = [d for d in items if d.get("room") in room]
            if not inside:
                raise ToolError(f"{rooms[room[0]]} has no {what}")
            return inside
        tokens = {d["id"]: set(words(f"{rooms.get(d.get('room'), '')} {self._label(d)} {d['id'].replace('.', ' ')}")) for d in items}
        loose = [d for d in items if set(rest) <= tokens[d["id"]]] or named
        if len(loose) == 1:
            return loose
        if len(loose) > 1:
            raise ToolError(f'"{q}" could be {self._list(loose)}; say which')
        # Speech gets names a little wrong ("counter lite"): the closest name, if it is close.
        names = {" ".join(words(f"{rooms.get(d.get('room'), '')} {self._label(d)}")): d for d in items}
        names.update({" ".join(words(self._label(d))): d for d in items})
        close = difflib.get_close_matches(" ".join(key), list(names), n=1, cutoff=0.75)
        if close:
            return [names[close[0]]]
        raise ToolError(f'No {one} called "{q}". There is {self._list(items)}')

    def _list(self, items: list[dict]) -> str:
        rooms = self.rooms
        return ", ".join(f"{self._label(d)} ({rooms.get(d.get('room'), d.get('room') or 'no room')})" for d in items)

    def _online(self, d: dict) -> bool | None:
        """Whether a device answers: None for one not linked to a real device (a pretend one)."""
        service, device = self.hub.links.get(d["id"], (None, None))
        if service == "wiz":
            light = self.hub.wiz.lights.get(device)
            return bool(light and light.online)
        if service == "aidot":
            found = [x for x in (self.hub.aidot.describe_all() if self.hub.aidot else []) if x.get("id") == device]
            return bool(found and found[0].get("online"))
        if service == "mrcool":
            mrcool = self.hub.mrcool
            return bool(mrcool and device in mrcool.devices and mrcool.describe(device)["online"])
        return None

    # ---------- lights ----------

    def _light_text(self, d: dict) -> str:
        s = self.hub.state["lights"].get(d["id"])
        caps = d.get("capabilities") or []
        if s is None:
            state = "not heard from yet"
        elif not s.get("on"):
            state = "off"
        else:
            parts = ["on"]
            if "brightness" in caps and isinstance(s.get("brightness"), (int, float)):
                parts.append(f"{round(s['brightness'] * 100)}%")
            if s.get("color") and "color" in caps:
                parts.append(f"colour {COLOR_NAMES.get(str(s['color']).lower(), s['color'])}")
            elif s.get("temp") and "temp" in caps:
                parts.append(f"{s['temp']} K")
            state = ", ".join(parts)
        online = self._online(d)
        return state + (" — offline" if online is False else "")

    def _abilities(self, d: dict) -> str:
        caps = d.get("capabilities") or []
        said = [w for c, w in (("brightness", "dims"), ("temp", "white 2200–6500 K"), ("color", "colour")) if c in caps]
        return ", ".join(said) or "on/off only"

    async def _send(self, kind: str, d: dict, patch: dict) -> str | None:
        """One device's change through Hub.command, as a panel sends it. None when done, else why not.
        A device not linked to a real one is the panels' pretend one: they hear the change."""
        section = "lights" if kind == "light" else "acs"
        current = dict(self.hub.state[section].get(d["id"]) or {})
        result = await self.hub.command({"type": "command", "kind": kind, "id": d["id"], "patch": patch, "state": current})
        if result.get("error"):
            if self._online(d) is False:
                return f"{self._label(d)} is offline"
            return f"{self._label(d)}: {result['error']}"
        if d["id"] not in self.hub.links:
            self.hub._apply({section: {d["id"]: {**current, **patch}}})
        return None

    def _group(self, chosen: list[dict], items: list[dict], what: str) -> str:
        """What a step calls these devices: "All lights", "Kitchen lights", or their names."""
        if len(chosen) == len(items) and len(items) > 1:
            return f"All {what}"
        rooms = {d.get("room") for d in chosen}
        if len(chosen) > 1 and len(rooms) == 1:
            room = next(iter(rooms))
            if len([d for d in items if d.get("room") == room]) == len(chosen):
                return f"{self.rooms.get(room, room)} {what}"
        if len(chosen) <= 2:
            return " and ".join(self._label(d) for d in chosen)
        return f"{len(chosen)} {what}"

    async def _set_lights(self, args: dict) -> dict:
        chosen = self._match(args.get("lights", args.get("light")), self.lights, LIGHT_WORDS, "lights")
        on = args.get("on") if isinstance(args.get("on"), bool) else None
        brightness = number(args.get("brightness"))
        kelvin = number(args.get("kelvin"))
        color = args.get("color") if isinstance(args.get("color"), str) and args["color"].strip() else None
        if color and " ".join(words(color)) in WHITES and kelvin is None:
            kelvin, color = WHITES[" ".join(words(color))], None
        if color:
            hexed = COLORS.get(" ".join(words(color))) or ("#" + color.strip().lstrip("#").lower())
            if not re.fullmatch(r"#[0-9a-f]{6}", hexed):
                raise ToolError(f'"{color}" isn\'t a colour I know: say #rrggbb or {", ".join(COLORS)}')
            color = hexed
        if brightness is not None and brightness <= 1 and isinstance(args.get("brightness"), float):
            brightness *= 100  # 0.3 meant as a fraction
        if on is None and brightness is None and kelvin is None and color is None:
            raise ToolError("Say what to change: on, brightness, kelvin or color")
        notes, done = [], []
        jobs = []
        for d in chosen:
            caps = d.get("capabilities") or []
            patch: dict = {}
            if on is not None:
                patch["on"] = on
            if on is not False:
                if brightness is not None:
                    if "brightness" in caps:
                        patch["brightness"] = max(0.05, min(1.0, brightness / 100))
                    else:
                        notes.append(f"{self._label(d)} can't dim")
                if color is not None:
                    if "color" in caps:
                        patch["color"] = color
                    else:
                        notes.append(f"{self._label(d)} has no colour")
                elif kelvin is not None:
                    if "temp" in caps:
                        patch.update(temp=int(max(2200, min(6500, kelvin))), color=None)
                    else:
                        notes.append(f"{self._label(d)} has no adjustable white")
                if len(patch) > ("on" in patch):
                    patch.setdefault("on", True)
            if patch:
                jobs.append((d, patch))
        said = await asyncio.gather(*(self._send("light", d, p) for d, p in jobs))
        failed = [why for why in said if why]
        done = [d for (d, _), why in zip(jobs, said) if not why]
        rooms = self.rooms
        lines = [f"{rooms.get(d.get('room'), '')} · {self._label(d)}: {self._light_text(d)}" for d in done]
        text = "\n".join(lines + failed + notes) or "Nothing changed"
        if not done:
            raise ToolError(text)
        if on is False:
            how = "off"
        elif brightness is not None:
            how = f"{round(max(5, min(100, brightness)))}%"
        elif color is not None:
            how = COLOR_NAMES.get(color, color)
        elif kelvin is not None:
            how = f"{int(kelvin)} K"
        else:
            how = "on"
        summary = f"{self._group(done, self.lights, 'lights')} → {how}"
        return {"text": text, "summary": summary + (" (some failed)" if failed else "")}

    # ---------- the air conditioner ----------

    def _ac_info(self, d: dict) -> dict:
        """The AC's unit, range, modes and fans: Cielo's description when it is linked, else the panel's defaults."""
        service, device = self.hub.links.get(d["id"], (None, None))
        mrcool = self.hub.mrcool
        if service == "mrcool" and mrcool and device in mrcool.devices:
            info = mrcool.describe(device)
            unit, lo, hi = info["unit"], info["min"], info["max"]
        else:
            unit = "F" if d.get("unit") == "F" else "C"
            lo, hi = d.get("min") or RANGES[unit][0], d.get("max") or RANGES[unit][1]
        f = self.hub.state["features"].get(d["id"]) or {}
        return {"unit": unit, "min": lo, "max": hi, "modes": f.get("modes") or PANEL_MODES, "fans": f.get("fans") or PANEL_FANS}

    def _ac_text(self, d: dict) -> str:
        s = self.hub.state["acs"].get(d["id"])
        i = self._ac_info(d)
        if s is None:
            state = "not heard from yet"
        else:
            room = f"room {s['roomTemp']:g}°{i['unit']}" if isinstance(s.get("roomTemp"), (int, float)) else ""
            if s.get("on"):
                state = f"on, {s.get('mode', '?')}, target {s.get('target', '?')}°{i['unit']}, fan {s.get('fan', '?')}"
            else:
                state = "off"
            state += f" ({room})" if room else ""
        return state + (" — offline" if self._online(d) is False else "")

    async def _set_climate(self, args: dict) -> dict:
        query = args.get("ac") if isinstance(args.get("ac"), str) and args["ac"].strip() else None
        chosen = self._match(query or "all", self.acs, AC_WORDS, "ACs")
        if len(chosen) > 1 and query is None:
            raise ToolError(f"Which AC: {self._list(chosen)}?")
        lines, failed = [], []
        for d in chosen:
            i = self._ac_info(d)
            patch: dict = {}
            mode = args.get("mode")
            if mode is not None:
                mode = {"cooling": "cool", "heating": "heat", "fan_only": "fan", "dehumidify": "dry"}.get(mode, mode)
                if mode not in i["modes"]:
                    raise ToolError(f"{self._label(d)} modes: {', '.join(i['modes'])}")
                patch["mode"] = mode
            target = number(args.get("target"))
            if target is not None:
                if not i["min"] <= round(target) <= i["max"]:
                    raise ToolError(f"{self._label(d)} goes from {i['min']} to {i['max']}°{i['unit']}")
                patch["target"] = int(round(target))
            fan = args.get("fan")
            if fan is not None:
                if fan not in i["fans"]:
                    raise ToolError(f"{self._label(d)} fan speeds: {', '.join(i['fans'])}")
                patch["fan"] = fan
            if isinstance(args.get("on"), bool):
                patch["on"] = args["on"]
                if not args["on"]:
                    patch = {"on": False}
            elif patch and not (self.hub.state["acs"].get(d["id"]) or {}).get("on"):
                patch["on"] = True  # "set the AC to 72" means it should be running
            if not patch:
                raise ToolError("Say what to change: on, mode, target or fan")
            why = await self._send("ac", d, patch)
            if why:
                failed.append(why)
            else:
                lines.append(f"{self._label(d)}: {self._ac_text(d)}")
        if not lines:
            raise ToolError("\n".join(failed))
        d = chosen[0]
        s = self.hub.state["acs"].get(d["id"]) or {}
        unit = self._ac_info(d)["unit"]
        how = "off" if not s.get("on") else " ".join(str(x) for x in (f"{s.get('target')}°{unit}" if "target" in s else None, s.get("mode")) if x)
        return {"text": "\n".join(lines + failed), "summary": f"{self._group(chosen, self.acs, 'ACs')} → {how}"}

    # ---------- scenes ----------

    async def _activate_scene(self, args: dict) -> dict:
        want = args.get("scene")
        scenes = self.scenes
        if not isinstance(want, str) or not want.strip():
            raise ToolError("Say which scene")
        key = words(want)
        scene = next((s for s in scenes if s["id"] == want), None) or next(
            (s for s in scenes if words(s.get("name") or s["id"]) == key or [w for w in key if w != "scene"] == words(s.get("name") or "")), None)
        if scene is None:
            close = difflib.get_close_matches(" ".join(key), {" ".join(words(s.get("name") or s["id"])): s for s in scenes}, n=1, cutoff=0.7)
            scene = next((s for s in scenes if " ".join(words(s.get("name") or s["id"])) in close), None)
        if scene is None:
            raise ToolError(f'No scene "{want}". Scenes: {", ".join(s.get("name") or s["id"] for s in scenes) or "none"}')
        # As the panel's store.applyScene does it: "*" then each light's own, a white clearing the colour.
        jobs = []
        for d in self.lights:
            lights = scene.get("lights") or {}
            patch = {**(lights.get("*") or {}), **(lights.get(d["id"]) or {})}
            if "temp" in patch and "color" not in patch:
                patch["color"] = None
            # What this light can take, as store.js's sanitizeLight keeps it.
            caps = d.get("capabilities") or []
            clean: dict = {}
            if "on" in patch:
                clean["on"] = bool(patch["on"])
            if "brightness" in caps and number(patch.get("brightness")) is not None:
                clean["brightness"] = max(0.05, min(1.0, number(patch["brightness"])))
            if "temp" in caps and number(patch.get("temp")) is not None:
                clean.update(temp=int(max(2200, min(6500, number(patch["temp"])))), color=None)
            if "color" in caps and "color" in patch:
                clean["color"] = patch["color"]
            now = self.hub.state["lights"].get(d["id"]) or {}
            diff = {k: v for k, v in clean.items() if now.get(k) != v}
            if diff:
                jobs.append(self._send("light", d, diff))
        for d in self.acs:
            acs = scene.get("acs") or {}
            patch = {**(acs.get("*") or {}), **(acs.get(d["id"]) or {})}
            now = self.hub.state["acs"].get(d["id"]) or {}
            diff = {k: v for k, v in patch.items() if now.get(k) != v and k != "roomTemp"}
            if diff:
                jobs.append(self._send("ac", d, diff))
        extra = []
        for tv_id, action in (scene.get("tvs") or {}).items():
            if isinstance(action, dict) and isinstance(action.get("app"), str) and action["app"]:
                extra.append(self._tv_act(tv_id, {"action": "open", "app": action["app"], "name": action.get("name") or action["app"]}))
        music = scene.get("spotify") or {}
        if isinstance(music.get("uri"), str) and music["uri"]:
            extra.append(self._spotify_act({"action": "play", "uri": music["uri"],
                                            **{k: music[k] for k in ("device", "deviceName") if music.get(k)}}))
        results = await asyncio.gather(*jobs, *extra, return_exceptions=True)
        failed = [str(r) for r in results if isinstance(r, (str, Exception)) and str(r)]
        name = scene.get("name") or scene["id"]
        on = [f"{self._label(d)} ({self._light_text(d)})" for d in self.lights if (self.hub.state["lights"].get(d["id"]) or {}).get("on")]
        text = f'Scene "{name}" is on. Lights on now: {", ".join(on) or "none"}.' + (f"\nDidn't work: {'; '.join(failed)}" if failed else "")
        return {"text": text, "summary": f"Scene · {name}"}

    # ---------- the TV ----------

    def _the_tv(self) -> dict:
        snap = self.hub.tv.snapshot
        if not snap.get("available"):
            raise ToolError(snap.get("error") or "The TV isn't answering")
        devices = snap.get("devices") or []
        if not devices:
            raise ToolError("There is no TV")
        return next((d for d in devices if d.get("on")), devices[0])

    def _tv_text(self, d: dict) -> str:
        if not d.get("on"):
            return f"{d.get('name') or 'TV'}: off"
        bits = [f"{d.get('name') or 'TV'}: on"]
        if d.get("app"):
            bits.append(f"in {d['app'].get('name')}")
        np = d.get("nowPlaying") or {}
        if np.get("title"):
            bits.append(f"{np.get('state', 'playing')} \"{np['title']}\"" + (f" ({np['subtitle']})" if np.get("subtitle") else ""))
        if isinstance(d.get("volume"), int):
            bits.append(f"volume {d['volume']} of {d.get('volumeMax') or 100}" + (", muted" if d.get("muted") else ""))
        return ", ".join(bits)

    async def _tv_act(self, tv_id: str, body: dict) -> str | None:
        result, status = await self.hub.tv.act(tv_id, body)
        return None if status == 200 and not result.get("error") else str(result.get("error") or f"The TV said no ({status})")

    async def _tv(self, args: dict) -> dict:
        d = self._the_tv()
        action = str(args.get("action") or "").strip().lower()
        action = TV_ALIASES.get(action, action)
        if action == "volume":
            level = number(args.get("level"))
            top = d.get("volumeMax") or 100
            if level is None:
                raise ToolError(f"Say the volume level, 0 to {top}")
            body, summary = {"action": "volume", "level": int(max(0, min(top, round(level))))}, f"TV volume → {int(max(0, min(top, round(level))))}"
        elif action == "open":
            aid = app_id(args.get("app"))
            if not aid:
                raise ToolError(f'The TV has no app "{args.get("app")}". Apps: {", ".join(catalogs.installed_apps(self.hub.tv))}')
            body, summary = {"action": "open", "app": aid, "name": APP_NAMES[aid]}, f"TV · {APP_NAMES[aid]}"
        elif action == "search":
            text = args.get("text")
            if not isinstance(text, str) or not text.strip():
                raise ToolError("Say what to search for")
            body, summary = {"action": "search", "text": text.strip()[:200]}, f"TV search · {text.strip()[:40]}"
        elif action in KEYS:
            body, summary = {"action": action}, f"TV · {action}"
        else:
            raise ToolError(f"The TV can't do \"{action}\". Keys: {', '.join(sorted(KEYS))}; or volume, open, search")
        why = await self._tv_act(d["id"], body)
        if why:
            raise ToolError(why)
        return {"text": f"Done. {self._tv_text(self._device(d['id']) or d)}", "summary": summary}

    def _device(self, tv_id: str) -> dict | None:
        return next((x for x in self.hub.tv.snapshot.get("devices") or [] if x.get("id") == tv_id), None)

    async def _find_title(self, args: dict) -> dict:
        query = args.get("query")
        if not isinstance(query, str) or not query.strip():
            raise ToolError("Say what to look for")
        result, status = await self.hub.tv.search(query)
        if status != 200:
            raise ToolError(result.get("error") or "The streaming catalog didn't answer")
        apps = set(catalogs.installed_apps(self.hub.tv))
        lines = []
        for r in (result.get("results") or [])[:6]:
            where = [o for o in r.get("offers") or [] if o.get("name") in apps]
            head = f"- {r['title']} ({r.get('year') or '?'}, {r.get('type') or 'title'})"
            if where:
                lines.append(head + ": " + "; ".join(f"{o['name']} [app {o['app']}] link {o['link']}" for o in where))
            else:
                paid = ", ".join(r.get("rentOrBuy") or [])
                lines.append(head + ": not on the TV's apps" + (f" (only {paid})" if paid else ""))
        text = "\n".join(lines) or f'Nothing found for "{query}"'
        return {"text": text, "summary": f"Looked for “{query.strip()[:40]}”"}

    async def _play_title(self, args: dict) -> dict:
        d = self._the_tv()
        aid = app_id(args.get("app"))
        link = args.get("link")
        if not aid:
            raise ToolError(f'The TV has no app "{args.get("app")}"')
        if not isinstance(link, str) or not link.strip():
            raise ToolError("Give the link from find_title or picks")
        why = await self._tv_act(d["id"], {"action": "play", "app": aid, "link": link.strip()})
        if why:
            raise ToolError(why)
        return {"text": f"Opening it in {APP_NAMES[aid]} on {d.get('name') or 'the TV'}.", "summary": f"Playing on {APP_NAMES[aid]}"}

    # ---------- the speaker ----------

    async def _spotify_act(self, body: dict) -> str | None:
        result, status = await self.hub.spotify.act(body)
        return None if status == 200 and not result.get("error") else str(result.get("error") or f"Spotify said no ({status})")

    @staticmethod
    def _speaker_text(st: dict) -> str:
        if not st.get("available"):
            return f"Spotify: {st.get('error') or 'not available'}"
        devices = st.get("devices") or []
        where = next((x.get("name") for x in devices if x.get("id") == st.get("device")), None)
        t = st.get("track") or {}
        bits = ["playing" if st.get("playing") else "paused"]
        if t.get("title"):
            bits.append(f"\"{t['title']}\"" + (f" by {t['artist']}" if t.get("artist") else ""))
        if where:
            bits.append(f"on {where}")
        if isinstance(st.get("volume"), (int, float)):
            bits.append(f"volume {round(st['volume'])}%")
        outputs = ", ".join(x.get("name") or "?" for x in devices)
        return "Spotify: " + " ".join(bits) + (f". Outputs: {outputs}" if outputs else "")

    async def _speaker(self, args: dict) -> dict:
        sp = self.hub.spotify
        action = str(args.get("action") or "").strip().lower()
        if action in ("play", "pause", "next", "previous"):
            body, summary = {"action": action}, {"play": "Music · playing", "pause": "Music · paused",
                                                  "next": "Music · next", "previous": "Music · previous"}[action]
        elif action == "volume":
            level = number(args.get("level"))
            if level is None:
                raise ToolError("Say the volume, 0 to 100")
            level = max(0, min(100, round(level)))
            body, summary = {"action": "volume", "level": level}, f"Music volume → {level}%"
        elif action == "transfer":
            st = await sp.state(fresh=True)
            outputs = [x for x in st.get("devices") or [] if x.get("id")]
            want = args.get("device")
            if not isinstance(want, str) or not want.strip():
                raise ToolError(f"Say which output: {', '.join(x.get('name') or '?' for x in outputs) or 'Spotify lists none'}")
            found = self._by_name(want, outputs)
            if not found:
                raise ToolError(f'Spotify has no output "{want}". Outputs: {", ".join(x.get("name") or "?" for x in outputs) or "none"}')
            body, summary = {"action": "transfer", "device": found["id"]}, f"Music → {found.get('name')}"
        elif action == "play_playlist":
            want = args.get("name")
            if not isinstance(want, str) or not want.strip():
                raise ToolError("Say which playlist")
            lists, offset = [], 0
            while offset is not None and offset < 300:
                page, status = await sp.playlists(offset=offset)
                if status != 200:
                    raise ToolError(page.get("error") or "Spotify's playlists can't be read")
                lists += [p for p in page.get("items") or [] if p.get("uri")]
                offset = page.get("next")
            found = self._by_name(want, lists)
            if not found:
                raise ToolError(f'No playlist "{want}". Some: {", ".join(p["name"] for p in lists[:12]) or "none"}')
            body, summary = {"action": "play", "uri": found["uri"]}, f"Playing “{found['name']}”"
        else:
            raise ToolError(f"The speaker does {', '.join(SPEAKER_ACTIONS)}")
        why = await self._spotify_act(body)
        if why:
            raise ToolError(why)
        return {"text": f"Done. {self._speaker_text(await sp.state(fresh=True))}", "summary": summary}

    @staticmethod
    def _by_name(want: str, items: list[dict]) -> dict | None:
        key = words(want)
        by = {" ".join(words(x.get("name") or "")): x for x in items}
        if " ".join(key) in by:
            return by[" ".join(key)]
        loose = [x for x in items if set(key) <= set(words(x.get("name") or ""))]
        if len(loose) == 1:
            return loose[0]
        close = difflib.get_close_matches(" ".join(key), list(by), n=1, cutoff=0.6)
        return by[close[0]] if close else None

    # ---------- picks ----------

    async def _picks(self, _args: dict) -> dict:
        parts = []
        for name, what in ((catalogs.EVENING_FILE, "Tonight's films"), (catalogs.SMART_FILE, "Today's picks")):
            try:
                data = json.loads((self.hub.conf / name).read_text())
            except (OSError, ValueError):
                continue
            picks = [p for p in (data.get("picks") if isinstance(data, dict) else None) or [] if isinstance(p, dict) and p.get("title")]
            if not picks:
                continue
            lines = [f"- {p['title']} ({p.get('year') or '?'}, {p.get('kind') or 'title'}) · {APP_NAMES.get(p.get('app'), p.get('app'))} "
                     f"[app {p.get('app')}] link {p.get('tvLink') or p.get('link')}" for p in picks[:12]]
            parts.append(f"{what} (written {data.get('generatedAt', '?')}):\n" + "\n".join(lines))
        return {"text": "\n\n".join(parts) or "There are no picks yet", "summary": "Looked at the picks"}

    # ---------- the home ----------

    async def _get_home(self, _args: dict) -> dict:
        rooms = self.rooms
        lines = [f"{self.hub.plan.get('name') or 'Home'}, {time.strftime('%A %-d %B, %H:%M')}."]
        for rid, name in rooms.items():
            lights = [d for d in self.lights if d.get("room") == rid]
            acs = [d for d in self.acs if d.get("room") == rid]
            if not lights and not acs:
                continue
            lines.append(f"\n{name} [{rid}]")
            for d in lights:
                lines.append(f"  • {self._label(d)} [{d['id']}] light ({self._abilities(d)}): {self._light_text(d)}")
            for d in acs:
                i = self._ac_info(d)
                lines.append(f"  • {self._label(d)} [{d['id']}] AC ({i['min']}–{i['max']}°{i['unit']}; modes {', '.join(i['modes'])}; "
                             f"fans {', '.join(i['fans'])}): {self._ac_text(d)}")
        snap = self.hub.tv.snapshot
        tvs = snap.get("devices") or []
        if tvs:
            lines.append("\nTV: " + "; ".join(self._tv_text(d) for d in tvs) + f". Apps: {', '.join(catalogs.installed_apps(self.hub.tv))}")
        else:
            lines.append(f"\nTV: {snap.get('error') or 'none found'}")
        try:
            speaker = await asyncio.wait_for(self.hub.spotify.state(), 6)
        except Exception as e:  # a speaker that can't be read must not keep the rest from the model
            log.info("Spotify for get_home: %r", e)
            speaker = {"available": False, "error": "not answering"}
        lines.append(self._speaker_text(speaker))
        lines.append("Scenes: " + (", ".join(f"{s.get('name') or s['id']} [{s['id']}]" for s in self.scenes) or "none"))
        data = {
            "home": self.hub.plan.get("name"),
            "rooms": [{"id": rid, "name": name,
                       "lights": [{"id": d["id"], "name": self._label(d), "abilities": d.get("capabilities") or [],
                                   "online": self._online(d), **(self.hub.state["lights"].get(d["id"]) or {})}
                                  for d in self.lights if d.get("room") == rid],
                       "acs": [{"id": d["id"], "name": self._label(d), **self._ac_info(d), "online": self._online(d),
                                **(self.hub.state["acs"].get(d["id"]) or {})} for d in self.acs if d.get("room") == rid]}
                      for rid, name in rooms.items()],
            "tv": tvs,
            "speaker": {k: speaker.get(k) for k in ("available", "playing", "track", "device", "devices", "volume", "error")},
            "scenes": [{"id": s["id"], "name": s.get("name") or s["id"]} for s in self.scenes],
        }
        return {"text": "\n".join(lines), "summary": "Looked at the home", "data": data}


# ---------- Codex's events ----------

def codex_event(line: str) -> tuple[str, dict] | None:
    """One line of `codex exec --json` as ("tool", {id, tool, server, arguments, done, ok, error}),
    ("message", {text}) or ("error", {message}); None for anything else. Both the item events
    ({"type": "item.completed", "item": {"type": "mcp_tool_call", …}}) and the older
    {"msg": {"type": "mcp_tool_call_begin", …}} shape are read."""
    try:
        ev = json.loads(line)
    except ValueError:
        return None
    if not isinstance(ev, dict):
        return None
    kind = ev.get("type")
    item = ev.get("item")
    if isinstance(item, dict) and isinstance(kind, str) and kind.startswith("item."):
        what = item.get("type") or item.get("item_type")
        if what == "mcp_tool_call":
            status = item.get("status")
            error = item.get("error")
            error = error.get("message") if isinstance(error, dict) else error
            done = kind == "item.completed" or status in ("completed", "failed")
            return "tool", {"id": str(item.get("id") or ""), "tool": item.get("tool") or "", "server": item.get("server"),
                            "arguments": _arguments(item.get("arguments")), "done": done,
                            "ok": None if not done else (status != "failed" and not error), "error": error}
        if what in ("agent_message", "assistant_message") and kind == "item.completed":
            text = item.get("text") or item.get("message") or ""
            return ("message", {"text": text}) if isinstance(text, str) and text.strip() else None
        return None
    if kind in ("error", "turn.failed"):
        err = ev.get("error") if isinstance(ev.get("error"), dict) else ev
        return "error", {"message": str(err.get("message") or "Codex failed")}
    msg = ev.get("msg")
    if isinstance(msg, dict):
        kind = msg.get("type")
        if kind in ("mcp_tool_call_begin", "mcp_tool_call_end"):
            inv = msg.get("invocation") or {}
            result = msg.get("result")
            error = result.get("Err") if isinstance(result, dict) and "Err" in result else None
            ok = (result.get("Ok") or {}).get("isError") is not True if isinstance(result, dict) and "Ok" in result else not error
            done = kind == "mcp_tool_call_end"
            return "tool", {"id": str(msg.get("call_id") or ""), "tool": inv.get("tool") or "", "server": inv.get("server"),
                            "arguments": _arguments(inv.get("arguments")), "done": done, "ok": ok if done else None,
                            "error": error}
        if kind == "agent_message" and isinstance(msg.get("message"), str) and msg["message"].strip():
            return "message", {"text": msg["message"]}
        if kind == "task_complete" and isinstance(msg.get("last_agent_message"), str) and msg["last_agent_message"].strip():
            return "message", {"text": msg["last_agent_message"]}
        if kind in ("error", "stream_error"):
            return "error", {"message": str(msg.get("message") or "Codex failed")}
    return None


def _arguments(value) -> dict:
    if isinstance(value, str):
        with contextlib.suppress(ValueError):
            value = json.loads(value)
    return value if isinstance(value, dict) else {}


def toml(value: str) -> str:
    """A TOML basic string (the same escapes as JSON's, for what a path or address holds)."""
    return json.dumps(value)


TOOL_STEPS = {t["name"]: t["title"] for t in TOOLS}


class AgentError(Exception):
    pass


class Agent:
    """Runs requests through Codex, one at a time. `ask` answers ({"ok", "reply", "steps"}, HTTP status)."""

    def __init__(self, hub, hub_url: str = HUB_URL):
        self.hub = hub
        self.tools = HouseTools(hub)
        self.hub_url = hub_url
        self.timeout = AGENT_TIMEOUT
        self.python = sys.executable
        self._lock = asyncio.Lock()
        self._load = 0          # requests running or waiting
        self._seq = 0
        self.current: dict | None = None   # the run under way, with its steps

    def command(self, exe: str, work: Path, last: Path) -> list[str]:
        cmd = [exe, "exec", "--json", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only",
               "--color", "never", "--cd", str(work), "--output-last-message", str(last),
               "-c", f"mcp_servers.house.command={toml(self.python)}",
               "-c", f"mcp_servers.house.args=[{toml(str(MCP_SERVER))}]",
               "-c", f"mcp_servers.house.env={{HOUSE_HUB_URL={toml(self.hub_url)}}}"]
        for setting in CODEX_SETTINGS:
            cmd += ["-c", setting]
        cmd += ["-c", f"model_reasoning_effort={toml(os.environ.get('HOUSE_AGENT_EFFORT') or 'low')}"]
        if os.environ.get("HOUSE_AGENT_MODEL"):
            cmd += ["-m", os.environ["HOUSE_AGENT_MODEL"]]
        return cmd + ["-"]

    async def prompt(self, text: str) -> str:
        home = (await self.tools.call("get_home", {}))["content"][0]["text"]
        units = ", ".join(sorted({f"°{self.tools._ac_info(d)['unit']}" for d in self.tools.acs})) or "none"
        return f"""You run Riley's home: its lights, air conditioner, TV and music, through the house tools (the MCP server "house").
{about(taste(self.hub.conf))}
The home right now (get_home gives it again):
{home}

Rules:
- Do what is asked with the tools, straight away. Don't ask back unless the request is truly ambiguous; then ask one short question.
- Use only the devices, scenes, apps and outputs listed above; never invent one. When something can't be done, say why.
- A film or show: find_title, then play_title with one of the TV's apps and that result's link. "Something good to watch": picks.
- Brightness is a percentage. The AC's temperature is in its own unit ({units}).
- Your answer is spoken aloud: one or two short sentences in plain words, no lists, no markdown, no ids.

Riley says: {text}"""

    # ---------- a run ----------

    def _new_run(self, text: str, client) -> dict:
        self._seq += 1
        return {"id": f"{int(time.time())}-{self._seq}", "client": client if isinstance(client, str) else None,
                "text": text, "state": "thinking", "steps": [], "reply": ""}

    def _publish(self, run: dict) -> None:
        steps = [{"tool": s["tool"], "text": s["text"], "ok": s["ok"]} for s in run["steps"]]
        self.hub._publish({"agent": {**{k: v for k, v in run.items() if not k.startswith("_")}, "steps": steps}})

    def heard(self, name: str, args, result: dict) -> None:
        """A tool call the hub ran (POST /api/agent/tool/…): a step of the run under way, so
        steps show whatever shape Codex's own events have."""
        run = self.current
        if run is None:
            return
        ok = not result.get("isError")
        text = result.get("summary") or TOOL_STEPS.get(name, name)
        step = next((s for s in run["steps"] if s["tool"] == name and not s["_heard"]), None)
        if step is None:
            step = {"tool": name, "_codex": None}
            run["steps"].append(step)
        step.update(text=text, ok=ok, _heard=True)
        run["state"] = "acting"
        self._publish(run)

    def _take(self, run: dict, line: str) -> None:
        """One line of Codex's output."""
        got = codex_event(line)
        if got is None:
            return
        kind, ev = got
        if kind == "message":
            run["reply"] = ev["text"].strip()
            return
        if kind == "error":
            run["_error"] = ev["message"]
            return
        name = ev["tool"]
        step = next((s for s in run["steps"] if s.get("_codex") == ev["id"] and ev["id"]), None)
        if step is None:
            # The hub may have heard the call before this line was read.
            step = next((s for s in run["steps"] if s["tool"] == name and s.get("_codex") is None and s["_heard"]), None)
            if step is None:
                step = {"tool": name, "text": TOOL_STEPS.get(name, name), "ok": None, "_heard": False}
                run["steps"].append(step)
            step["_codex"] = ev["id"]
        if ev["done"] and not step["_heard"]:
            step["ok"] = bool(ev["ok"])
            if not ev["ok"] and ev.get("error"):
                step["text"] = f"{TOOL_STEPS.get(name, name)}: {str(ev['error'])[:100]}"
        run["state"] = "acting"
        self._publish(run)

    async def _codex(self, run: dict, exe: str, text: str) -> str:
        prompt = await self.prompt(text)
        with tempfile.TemporaryDirectory(prefix="house-agent-") as tmp:
            work = Path(tmp) / "work"
            work.mkdir()
            last = Path(tmp) / "reply.txt"
            proc = await asyncio.create_subprocess_exec(
                *self.command(exe, work, last), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE, limit=OUTPUT_LIMIT, start_new_session=True)
            said: deque[str] = deque(maxlen=12)

            async def feed():
                assert proc.stdin
                with contextlib.suppress(BrokenPipeError, ConnectionResetError):
                    proc.stdin.write(prompt.encode())
                    await proc.stdin.drain()
                    proc.stdin.close()

            async def out():
                assert proc.stdout
                async for raw in proc.stdout:
                    self._take(run, raw.decode(errors="replace"))

            async def err():
                assert proc.stderr
                async for raw in proc.stderr:
                    if raw.strip():
                        said.append(raw.decode(errors="replace").strip())

            try:
                await asyncio.wait_for(asyncio.gather(feed(), out(), err(), proc.wait()), self.timeout)
            except asyncio.TimeoutError:
                # The whole group: Codex and the MCP server it started.
                with contextlib.suppress(ProcessLookupError, PermissionError):
                    os.killpg(proc.pid, signal.SIGKILL)
                with contextlib.suppress(ProcessLookupError):
                    proc.kill()
                await proc.wait()
                raise AgentError(f"That took longer than {self.timeout:.0f} seconds, so I stopped")
            reply = run["reply"]
            if not reply and last.exists():
                reply = last.read_text(errors="replace").strip()
            if not reply:
                lines = list(said) + ([run["_error"]] if run.get("_error") else [])
                hint = " (signed out? run `codex login` on the hub)" if re.search(r"log ?in|auth|401", " ".join(lines), re.I) else ""
                raise AgentError(f"Codex failed (exit {proc.returncode}){hint}: {' / '.join(lines[-2:])[:200] or 'no answer'}")
            return reply

    async def ask(self, text, client=None, from_peer: bool = False) -> tuple[dict, int]:
        text = " ".join(str(text or "").split())[:MAX_TEXT]
        if not text:
            return {"ok": False, "error": "Say what to do"}, 400
        exe = find_codex()
        if not exe:
            if from_peer or not self.hub.peers:
                return {"ok": False, "error": "This hub has no Codex to run the agent with"}, 503
            return await self._forward(text, client)
        if self._load > QUEUE:
            return {"ok": False, "error": "The house is busy with other requests; try again in a moment"}, 429
        self._load += 1
        try:
            async with self._lock:
                return await self._run(exe, text, client)
        finally:
            self._load -= 1

    async def _run(self, exe: str, text: str, client) -> tuple[dict, int]:
        run = self._new_run(text, client)
        started = time.monotonic()
        self.current = run
        self._publish(run)
        try:
            run["reply"] = await self._codex(run, exe, text)
            run["state"] = "done"
        except (AgentError, OSError) as e:
            run["state"], run["reply"] = "failed", str(e)
        finally:
            self.current = None
        for s in run["steps"]:
            if s["ok"] is None:
                s["ok"] = run["state"] == "done"
        self._publish(run)
        log.info("Agent %s: %r → %s in %.1f s, %d steps: %r", run["id"], text[:80], run["state"],
                 time.monotonic() - started, len(run["steps"]), run["reply"][:120])
        steps = [{"tool": s["tool"], "text": s["text"], "ok": s["ok"]} for s in run["steps"]]
        ok = run["state"] == "done"
        return {"ok": ok, "id": run["id"], "reply": run["reply"], "steps": steps,
                **({} if ok else {"error": run["reply"]})}, 200 if ok else 502

    async def _forward(self, text: str, client) -> tuple[dict, int]:
        """No Codex here (the Mac backup): the other hub runs it, and this one's panels hear the answer."""
        run = self._new_run(text, client)
        self._publish(run)
        started = time.monotonic()
        for url in self.hub.peers:
            if self.hub.http is None:
                break
            try:
                async with self.hub.http.post(url + "/api/agent", json={"text": text, "client": client, "fromPeer": True},
                                              timeout=aiohttp.ClientTimeout(total=self.timeout + 15, connect=4)) as r:
                    answer = await r.json(content_type=None)
                    status = r.status
            except (aiohttp.ClientError, asyncio.TimeoutError, OSError, ValueError):
                continue
            if not isinstance(answer, dict) or status in (404, 405):
                continue
            run["steps"] = [{"tool": str(s.get("tool") or ""), "text": str(s.get("text") or ""), "ok": s.get("ok")}
                            for s in answer.get("steps") or [] if isinstance(s, dict)]
            run["reply"] = str(answer.get("reply") or answer.get("error") or "")
            run["state"] = "done" if answer.get("ok") else "failed"
            self._publish(run)
            log.info("Agent %s via %s: %r → %s in %.1f s", run["id"], url, text[:80], run["state"], time.monotonic() - started)
            return answer, status
        run["state"], run["reply"] = "failed", "Neither this hub nor the other one can run the agent right now"
        self._publish(run)
        log.info("Agent %s: %r → no Codex here and no other hub answered", run["id"], text[:80])
        return {"ok": False, "id": run["id"], "reply": run["reply"], "steps": [], "error": run["reply"]}, 503
