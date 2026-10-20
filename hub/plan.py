"""The hub's floor plan until the home is drawn in the editor.

A hub with no plan.json starts from Riley's Studio, the panel's bundled default home
(`plans/riley.json`), with its lamps and ACs linked by name to the devices the drivers
found (`seed`). Without that file, each room named in devices.json becomes a simple
4.5 × 4 m box, laid out two to a row, with its lights and ACs placed inside and a piece
of furniture that says what the room is (`build`). Every lamp and AC is linked to its
real device (`link: {service, id}`), so the panel controls the real thing. A plan.json
without "generatedBy": "hub" or "seededBy": "hub" is the user's own and is used as it is.

The panel's tile order (`tileOrder`: lamp and AC ids, "tv:<id>" for a TV) is the one thing
a screen may change in a plan the hub makes without making it the user's own: `ordered`
carries it into each plan the hub makes again.
"""
from __future__ import annotations

import copy
import json
import re
from pathlib import Path

W, D = 4.5, 4.0  # a room's width and depth, in metres

FURNITURE = [
    ("bed", lambda x, z: [{"type": "bed", "pos": [x + W / 2, z + 1.25], "width": 1.6, "color": "#8a9bb8"},
                          {"type": "nightstand", "pos": [x + W / 2 + 1.25, z + 0.4]}]),
    ("kitchen", lambda x, z: [{"type": "kitchen", "pos": [x + W / 2, z + D - 0.32], "rot": 180, "width": 2.6, "upper": False}]),
    ("bath", lambda x, z: [{"type": "vanity", "pos": [x + W / 2, z + 0.38], "width": 0.9}]),
    ("living", lambda x, z: [{"type": "sofa", "pos": [x + W / 2, z + D - 0.6], "rot": 180, "width": 2.1, "color": "#6f8f86"},
                             {"type": "rug", "pos": [x + W / 2, z + D / 2], "size": [2.4, 1.8], "color": "#5b4a6e"}]),
    ("office", lambda x, z: [{"type": "desk", "pos": [x + W / 2, z + 0.5], "width": 1.4}]),
]

SCENES = [
    {"id": "bright", "name": "Bright", "icon": "sun", "lights": {"*": {"on": True, "brightness": 1, "temp": 4200}}},
    {"id": "cozy", "name": "Cozy", "icon": "sofa", "lights": {"*": {"on": True, "brightness": 0.45, "temp": 2700}}},
    {"id": "night", "name": "Night", "icon": "moon", "lights": {"*": {"on": True, "brightness": 0.1, "temp": 2200}}},
    {"id": "off", "name": "All off", "icon": "power", "lights": {"*": {"on": False}}},
]


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "room"


def named(names: dict, kind: str, dev: dict) -> dict:
    """A device as a driver describes it, with its name and room from devices.json."""
    given = (names.get(kind) or {}).get(dev["id"], {})
    if not given and kind == "lights":
        # A driver may learn a bulb under a new id (AiDot reissues device
        # ids): the address or the app name in devices.json still matches.
        for candidate in (names.get(kind) or {}).values():
            if not isinstance(candidate, dict):
                continue
            if candidate.get("ip") and candidate["ip"] == dev.get("ip"):
                given = candidate
                break
            if candidate.get("name") and candidate["name"] == dev.get("name"):
                given = candidate
                break
    return {**dev, **(given if isinstance(given, dict) else {})}


def template(web: Path) -> dict | None:
    """Riley's Studio as the panel ships it: the built site's copy, else the repo's."""
    for path in (web / "plans" / "riley.json", Path(__file__).resolve().parent.parent / "web" / "public" / "plans" / "riley.json"):
        try:
            plan = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if isinstance(plan, dict) and isinstance(plan.get("rooms"), list):
            return plan
    return None


def seed(base: dict, names: dict, lights: list[dict], acs: list[dict]) -> dict:
    """`base` (Riley's Studio) with each unlinked lamp and AC linked to the found device of
    the same name (devices.json's name, or the driver's), so "Door Light" and "Bathroom Light"
    find their AiDot bulbs. Links already in the file are kept; a device links to one item."""
    plan = copy.deepcopy(base)
    plan["seededBy"] = "hub"
    for key, found, service in (("lights", lights, "wiz"), ("acs", acs, "mrcool")):
        items = [i for i in plan.get(key) or [] if isinstance(i, dict)]
        devices = [named(names, key, d) for d in found]
        taken = {(i["link"].get("service"), i["link"].get("id")) for i in items if isinstance(i.get("link"), dict)}
        for item in items:
            if (item.get("link") or {}).get("id"):
                continue
            want = str(item.get("name") or "").strip().casefold()
            for dev in devices:
                link = (dev.get("service") or service, dev["id"])
                if want and link not in taken and str(dev.get("name") or "").strip().casefold() == want:
                    item["link"] = {"service": link[0], "id": link[1]}
                    taken.add(link)
                    break
    return plan


def order_of(plan) -> list[str] | None:
    """A plan's `tileOrder`, without anything that is not a tile's name; None when it has none."""
    order = plan.get("tileOrder") if isinstance(plan, dict) else None
    if not isinstance(order, list):
        return None
    return list(dict.fromkeys(k for k in order if isinstance(k, str) and k))


def ordered(plan: dict, previous) -> dict:
    """`plan` with the tile order `previous` had (names the new plan lacks are kept: a lamp
    that is unplugged for a while comes back to its place)."""
    order = order_of(previous)
    if order is not None:
        plan["tileOrder"] = order
    return plan


def same_but_order(a, b) -> bool:
    """Whether two plans differ in their tile order alone."""
    if not isinstance(a, dict) or not isinstance(b, dict):
        return False
    return {k: v for k, v in a.items() if k != "tileOrder"} == {k: v for k, v in b.items() if k != "tileOrder"}


def build(names: dict, lights: list[dict], acs: list[dict]) -> dict:
    """`names` is devices.json; `lights` and `acs` are what the drivers found
    (`describe()` of each). Devices without a room in devices.json go in "Home"."""
    rooms: list[str] = []
    for r in names.get("rooms", []):
        if r not in rooms:
            rooms.append(r)

    def entry(kind: str, dev: dict) -> dict:
        given = named(names, kind, dev)
        room = given.get("room") or "Home"
        if room not in rooms:
            rooms.append(room)
        return {**given, "room": room}

    placed_lights = [entry("lights", l) for l in lights]
    placed_acs = [entry("acs", a) for a in acs]

    plan: dict = {
        "version": 1, "generatedBy": "hub", "name": names.get("home", "Home"),
        "wallHeight": 2.6, "interiorWallHeight": 1.25, "outdoorTemp": 22,
        "rooms": [], "openings": [], "furniture": [], "lights": [], "acs": [], "scenes": SCENES,
    }
    ids: set[str] = set()

    def unique(base: str) -> str:
        out, n = base, 2
        while out in ids:
            out, n = f"{base}-{n}", n + 1
        ids.add(out)
        return out

    for i, room in enumerate(rooms):
        rid = unique(slug(room))
        x, z = (i % 2) * W, (i // 2) * D
        plan["rooms"].append({"id": rid, "name": room, "rect": [x, z, W, D],
                              "floor": "tile" if "bath" in room.lower() or "kitchen" in room.lower() else "oak"})
        for word, make in FURNITURE:
            if word in room.lower():
                plan["furniture"] += make(x, z)
                break

        here = [l for l in placed_lights if l["room"] == room]
        strips = [l for l in here if (l.get("type") or l.get("kind")) == "strip"]
        lamps = [l for l in here if l not in strips]
        for j, l in enumerate(lamps):
            px = x + W * (j + 1) / (len(lamps) + 1)
            plan["lights"].append(_light(l, unique(f"{rid}.{slug(l.get('name') or 'light')}"), rid,
                                         l.get("type") or ("pendant" if len(lamps) == 1 else "ceiling"), [px, z + D / 2]))
        for j, l in enumerate(strips):
            # Along the back wall, under the cabinets if this is the kitchen.
            plan["lights"].append(_light(l, unique(f"{rid}.{slug(l.get('name') or 'strip')}"), rid, "strip",
                                         [x + W / 2, z + D - 0.45 - j * 0.3], y=1.42, length=2.4))
        for j, a in enumerate(a for a in placed_acs if a["room"] == room):
            unit = a.get("unit", "F")
            plan["acs"].append({
                "id": unique(f"{rid}.ac"), "name": a.get("name") or f"{room} AC", "room": rid,
                "wall": "north", "pos": [x + W * (0.7 - 0.4 * j), z], "y": 2.2, "unit": unit,
                "min": a.get("min", 61 if unit == "F" else 16), "max": a.get("max", 86 if unit == "F" else 30),
                "link": {"service": "mrcool", "id": a["id"]},
            })
    return plan


def _light(l: dict, lid: str, room: str, kind: str, pos: list, **extra) -> dict:
    out = {"id": lid, "name": l.get("name") or l["id"], "room": room, "type": kind, "pos": pos,
           "capabilities": l.get("capabilities", ["brightness"]),
           "link": {"service": l.get("service") or "wiz", "id": l["id"]}, **extra}
    if kind == "pendant":
        out["y"] = 1.9
    return out
