import json
import shutil
import subprocess
import unittest
from pathlib import Path

MODULE = (Path(__file__).resolve().parents[1] / "static" / "mode.js").as_uri()
OSU = {"number": 0, "name": "osu"}
MANIA = {"number": 3, "name": "mania"}
TAIKO = {"number": 1, "name": "taiko"}


def active_mode(snapshot):
    script = (
        f"import {{ activeMode }} from {json.dumps(MODULE)};"
        f"process.stdout.write(JSON.stringify(activeMode({json.dumps(snapshot)}) ?? null));"
    )
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)


@unittest.skipIf(shutil.which("node") is None, "node is required to run the overlay module")
class ActiveModeTests(unittest.TestCase):
    def test_converted_map_in_play_uses_play_mode(self):
        snapshot = {
            "state": {"number": 2, "name": "play"},
            "beatmap": {"mode": OSU, "isConvert": True},
            "settings": {"mode": MANIA},
            "play": {"mode": MANIA},
        }
        self.assertEqual(active_mode(snapshot), MANIA)

    def test_play_mode_wins_over_menu_selection_while_playing(self):
        snapshot = {
            "state": {"number": 2, "name": "play"},
            "beatmap": {"mode": OSU},
            "settings": {"mode": TAIKO},
            "play": {"mode": MANIA},
        }
        self.assertEqual(active_mode(snapshot), MANIA)

    def test_song_select_uses_selected_ruleset_not_original_map_mode(self):
        snapshot = {
            "state": {"number": 5, "name": "selectPlay"},
            "beatmap": {"mode": OSU},
            "settings": {"mode": TAIKO},
            "play": {"mode": MANIA},
        }
        self.assertEqual(active_mode(snapshot), TAIKO)

    def test_falls_back_to_beatmap_mode_without_named_settings(self):
        snapshot = {
            "state": {"number": 0, "name": "menu"},
            "beatmap": {"mode": MANIA},
            "settings": {"mode": {"name": ""}},
        }
        self.assertEqual(active_mode(snapshot), MANIA)

    def test_missing_snapshot_has_no_mode(self):
        self.assertIsNone(active_mode(None))


@unittest.skipIf(shutil.which("node") is None, "node is required")
class TimelineReplacementTests(unittest.TestCase):
    def test_fallback_only_on_new_tool_404(self):
        path = Path(__file__).resolve().parents[1] / "overlays/ratings-timeline/overlay.js"
        source = path.read_text()
        reader = "async function read" + source.split("async function read", 1)[1].split("function draw", 1)[0]
        for status, expected in [(200, 1), (404, 2), (503, 1)]:
            script = reader + f"""
const calls=[];
globalThis.fetch=async path=>{{calls.push(path);const status=calls.length===1?{status}:200;return {{status,ok:status===200,json:async()=>({{ok:true}})}};}};
try{{await read('v1/beatmap/current');}}catch{{}}
if(calls.length!=={expected}||!calls[0].startsWith('/tools/map-analysis/api/'))throw Error(JSON.stringify(calls));
if(calls.length===2&&!calls[1].startsWith('/tools/mania-ratings/api/'))throw Error('wrong legacy fallback');
"""
            subprocess.run(["node", "--input-type=module", "-e", script], check=True, capture_output=True, text=True)
        self.assertNotIn("/rates", reader)


if __name__ == "__main__":
    unittest.main()
