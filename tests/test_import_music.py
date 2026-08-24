import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "tools" / "import-music.py"
SPEC = importlib.util.spec_from_file_location("import_music", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class ImportMusicTests(unittest.TestCase):
    def test_safe_component_blocks_traversal_and_slashes(self):
        self.assertEqual(MODULE.safe_component("AC/DC"), "AC - DC")
        with self.assertRaises(ValueError):
            MODULE.safe_component("..")

    def test_compilation_uses_various_artists_folder(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root)
            items = [
                MODULE.ImportItem(source / "disc" / "01.flac", ["One"], [], "A", "Mix"),
                MODULE.ImportItem(source / "disc" / "02.flac", ["Two"], [], "B", "Mix"),
            ]
            errors = MODULE.assign_destinations(items, source / "library", "Various Artists")
            self.assertEqual(errors, [])
            self.assertTrue(all(i.library_artist == "Various Artists" for i in items))

    def test_existing_destination_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            dest = root / "library" / "Artist" / "Album"
            dest.mkdir(parents=True)
            (dest / "song.flac").touch()
            item = MODULE.ImportItem(root / "song.flac", ["Artist"], ["Artist"], "Song", "Album")
            errors = MODULE.assign_destinations([item], root / "library", "Various Artists")
            self.assertIn("destination already exists", errors[0])


if __name__ == "__main__":
    unittest.main()
