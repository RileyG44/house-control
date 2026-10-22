#!/usr/bin/env python3
"""Add the speaker to an existing studio plan without replacing devices, presets or layout.

Dry-run: scripts/add-studio-speaker.py --hub http://192.168.0.127:8766
Save:    scripts/add-studio-speaker.py --hub http://192.168.0.127:8766 --apply
The script keeps a private backup; the hub stamps and synchronizes the save to its peer.
"""
import argparse
import json
import math
import os
import time
from pathlib import Path
import urllib.request


def with_speaker(plan):
    if any(item.get("type") == "speaker" for item in plan.get("furniture", [])):
        return plan, False
    points = []
    for room in plan.get("rooms", []):
        if "poly" in room:
            points += room["poly"]
        elif "rect" in room:
            x, z, w, d = room["rect"]
            points += [[x, z], [x + w, z + d]]
    if not points:
        raise ValueError("The plan has no rooms")
    xmin, xmax = min(p[0] for p in points), max(p[0] for p in points)
    zmin, zmax = min(p[1] for p in points), max(p[1] for p in points)
    doors = [o for o in plan.get("openings", []) if o.get("type") == "door" and "from" in o and "to" in o]
    outer = [o for o in doors if any(abs(o["from"][axis] - edge) < 0.05 and abs(o["to"][axis] - edge) < 0.05
                                   for axis, edge in [(0, xmin), (0, xmax), (1, zmin), (1, zmax)])]
    tables = [f for f in plan.get("furniture", []) if f.get("type") == "nightstand" and "pos" in f]
    if not outer or not tables:
        raise ValueError("No exterior door and bedside table were found. Place the speaker in Edit home instead.")
    centers = [[(o["from"][i] + o["to"][i]) / 2 for i in (0, 1)] for o in outer]
    table = min(tables, key=lambda t: min(math.dist(t["pos"], p) for p in centers))
    angle = math.radians(table.get("rot", 0))
    dx, dz = -0.14, 0.02  # beside the lamp, wholly on the tabletop
    position = [round(table["pos"][0] + dx * math.cos(angle) + dz * math.sin(angle), 3),
                round(table["pos"][1] - dx * math.sin(angle) + dz * math.cos(angle), 3)]
    plan["furniture"].append({"type": "speaker", "name": "Studio speaker", "device": "spotify",
                              "pos": position, "y": table.get("y", 0) + 0.5})
    return plan, True


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hub", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    with urllib.request.urlopen(args.hub.rstrip("/") + "/api/plan", timeout=10) as response:
        plan = json.load(response)
    before = json.dumps(plan, indent=2) + "\n"
    plan, changed = with_speaker(plan)
    if not changed:
        print("The home already has a speaker. No changes made.")
    elif not args.apply:
        print("Ready to add the studio speaker beside the lamp on the bedside table nearest the exterior door.")
    else:
        folder = Path.home() / ".house-hub" / "backups"
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        backup = folder / f"plan-before-speaker-{time.time_ns()}.json"
        with os.fdopen(os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as out:
            out.write(before)
        request = urllib.request.Request(args.hub.rstrip("/") + "/api/call",
                                         data=json.dumps({"type": "savePlan", "config": plan, "client": "speaker-setup"}).encode(),
                                         headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=15) as response:
            result = json.load(response)
        if result.get("error"):
            raise SystemExit(result["error"])
        print("Studio speaker saved. The hub will synchronize the plan to its peer.")
        print(f"Previous plan: {backup}")
