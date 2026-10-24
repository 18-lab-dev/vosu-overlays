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


if __name__ == "__main__":
    unittest.main()
