import copy
import json
import runpy
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
add_speaker = runpy.run_path(str(ROOT / "scripts/add-studio-speaker.py"))["with_speaker"]


def test_existing_studio_keeps_every_device_and_preset_when_speaker_is_added():
    plan = json.loads((ROOT / "web/public/plans/riley.json").read_text())
    plan["furniture"] = [item for item in plan["furniture"] if item["type"] != "speaker"]
    before = copy.deepcopy(plan)
    after, changed = add_speaker(plan)
    assert changed
    speaker = after["furniture"].pop()
    assert after == before
    assert speaker["device"] == "spotify" and speaker["y"] == 0.5
    assert speaker["pos"] == [2.81, 7.4]  # the exterior-door nightstand, not the far bedside table


def test_a_second_run_keeps_the_users_speaker_in_its_chosen_position():
    plan = json.loads((ROOT / "web/public/plans/riley.json").read_text())
    speaker = next(item for item in plan["furniture"] if item["type"] == "speaker")
    speaker["pos"] = [4.0, 5.0]
    before = copy.deepcopy(plan)
    assert add_speaker(plan) == (before, False)
