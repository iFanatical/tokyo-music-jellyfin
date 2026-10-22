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
    def test_ellipsis_album_directory_is_visible_to_jellyfin(self):
        self.assertEqual(MODULE.safe_component("...And Justice for All"), "And Justice for All")
        with self.assertRaises(ValueError):
            MODULE.safe_component("...")

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

    def test_restarting_track_numbers_without_discs_warn(self):
        src = Path("/inbox/Box")
        items = [MODULE.ImportItem(src / f"{n:02}.flac", ["A"], ["A"], f"T{n}", "Box", track=t)
                 for n, t in [(1, 1), (2, 2), (3, 1), (4, 2)]]
        warnings = MODULE.disc_number_warnings(items)
        self.assertEqual(len(warnings), 1)
        self.assertIn("fix-disc-numbers.py", warnings[0])

    def test_proper_disc_numbers_do_not_warn(self):
        src = Path("/inbox/Box")
        items = [MODULE.ImportItem(src / f"{n:02}.flac", ["A"], ["A"], f"T{n}", "Box", track=t, disc=d)
                 for n, t, d in [(1, 1, 1), (2, 2, 1), (3, 1, 2), (4, 2, 2)]]
        self.assertEqual(MODULE.disc_number_warnings(items), [])

    def test_same_disc_and_track_twice_warns_without_suggesting_the_fixer(self):
        src = Path("/inbox/Album")
        items = [MODULE.ImportItem(src / f"{n}.flac", ["A"], ["A"], "T", "Album", track=1, disc=1)
                 for n in ("a", "b")]
        warnings = MODULE.disc_number_warnings(items)
        self.assertEqual(len(warnings), 1)
        self.assertNotIn("fix-disc-numbers.py", warnings[0])


if __name__ == "__main__":
    unittest.main()
