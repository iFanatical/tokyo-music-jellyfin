import importlib.util
import csv
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "tools" / "list-non-flac.py"
SPEC = importlib.util.spec_from_file_location("list_non_flac", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class ListNonFlacTests(unittest.TestCase):
    def test_lists_everything_except_case_insensitive_flac(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("one.flac", "two.FLAC", "three.mp3", "cover.jpg", "README"):
                (root / name).touch()
            found = {path.name for path in MODULE.non_flac_files(root)}
            self.assertEqual(found, {"three.mp3", "cover.jpg", "README"})

    def test_audio_only_excludes_sidecars(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("song.mp3", "song.opus", "cover.jpg", "notes.txt"):
                (root / name).touch()
            found = {path.name for path in MODULE.non_flac_files(root, audio_only=True)}
            self.assertEqual(found, {"song.mp3", "song.opus"})

    def test_csv_is_utf8_and_formula_safe(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            track = root / "=track.mp3"
            track.write_bytes(b"not real audio")
            output = root / "report.csv"
            MODULE.write_csv([track], root, output)
            with output.open(encoding="utf-8-sig", newline="") as stream:
                row = next(csv.DictReader(stream))
            self.assertEqual(row["file_name"], "'=track.mp3")
            self.assertEqual(row["extension"], "mp3")


if __name__ == "__main__":
    unittest.main()
