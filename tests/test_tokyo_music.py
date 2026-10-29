import importlib.util
import json
import os
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from test_fix_disc_numbers import HAVE_MUTAGEN, make_flac  # noqa: E402

TOOLS = Path(__file__).parents[1] / "tools"


def load(filename, name):
    spec = importlib.util.spec_from_file_location(name, TOOLS / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


TOKYO = load("tokyo-music.py", "tokyo_music_test")
IMPORT = load("import-music.py", "import_music_sidecar_test")
DEEZER = load("fix-from-deezer.py", "deezer_ogg_test")


class DiscoverTests(unittest.TestCase):
    STDERR = ("Artist page: 3 unique releases, 3 added\n"
              "Popular Albums page: 0 unique releases, 0 added\n"
              "Fever — Album • 2008\n"
              "Fever (Tour Edition) — Album • 2009\n"
              "Gravity — Album • 2018\n"
              "Found 3 unique release URLs. This is the catalog ...\n")
    STDOUT = "https://a/1\nhttps://a/2\nhttps://a/3\n"

    def test_titles_pair_with_urls_in_order(self):
        pairs = TOKYO.pair_titles(self.STDOUT, self.STDERR)
        self.assertEqual(pairs[1], ("https://a/2", "Fever (Tour Edition) — Album • 2009"))

    def test_alternate_editions_are_flagged_and_stripped_for_lucida(self):
        pairs = TOKYO.pair_titles(self.STDOUT, self.STDERR)
        groups = TOKYO.edition_groups(pairs)
        self.assertEqual([[u for u, _ in g] for g in groups], [["https://a/1", "https://a/2"]])
        text = TOKYO.render_list("https://music.amazon.com/artists/B000X", pairs)
        self.assertEqual(text.count("ALTERNATE EDITION"), 2)
        self.assertEqual(TOKYO.strip_list(text), ["https://a/1", "https://a/2", "https://a/3"])

    def test_different_records_are_not_editions(self):
        self.assertNotEqual(TOKYO.edition_key("Live at Leeds — Album"),
                            TOKYO.edition_key("Leeds — Album"))
        self.assertEqual(TOKYO.edition_key("1. Crunk Rock (Deluxe) [Explicit] — Album • 2010"),
                         TOKYO.edition_key("Crunk Rock — Album • 2010"))
        self.assertEqual(TOKYO.edition_key("Load [Explicit] — Album"),
                         TOKYO.edition_key("Load (Remastered 2021) — Album"))

    def test_artist_id_from_url(self):
        self.assertEqual(TOKYO.artist_id("https://music.amazon.com/artists/B000QKEOOW/foo"),
                         "B000QKEOOW")


class CredentialTests(unittest.TestCase):
    def make_profile(self, root, rows):
        os.makedirs(f"{root}/p1")
        con = sqlite3.connect(f"{root}/p1/cookies.sqlite")
        con.execute("CREATE TABLE moz_cookies (name TEXT, value TEXT, host TEXT, expiry INTEGER)")
        con.executemany("INSERT INTO moz_cookies VALUES (?, ?, ?, ?)", rows)
        con.commit()
        con.close()

    def test_freshest_unexpired_cookie_wins(self):
        now = int(time.time())
        with tempfile.TemporaryDirectory() as root:
            self.make_profile(root, [
                ("cf_clearance", "old", ".lucida.to", now - 60),
                ("cf_clearance", "good", ".lucida.to", (now + 3600) * 1000),  # milliseconds
                ("cf_clearance", "other", ".example.com", now + 9999),
            ])
            value, expiry = TOKYO.firefox_cookie(profiles_glob=f"{root}/*/cookies.sqlite")
            self.assertEqual(value, "good")
            self.assertAlmostEqual(expiry, now + 3600, delta=2)

    def test_no_cookie_explains_what_to_do(self):
        with tempfile.TemporaryDirectory() as root:
            self.make_profile(root, [])
            self.assertIsNone(TOKYO.firefox_cookie(profiles_glob=f"{root}/*/cookies.sqlite"))


class CanonicalTests(unittest.TestCase):
    def test_repo_spellings_win_over_old_user_ones(self):
        with tempfile.TemporaryDirectory() as root:
            repo, user = Path(root, "repo.json"), Path(root, "user.json")
            repo.write_text(json.dumps({"Tobymac": "TobyMac", "tobyMac": "TobyMac"}))
            user.write_text(json.dumps({"TobyMac": "tobyMac", "Toby Mac": "tobyMac",
                                        "Fm Static": "FM Static"}))
            merged = TOKYO.canonical_map(repo, user)
            self.assertNotIn("TobyMac", merged)  # would undo a settled name
            self.assertEqual(merged["Toby Mac"], "TobyMac")
            self.assertEqual(merged["tobyMac"], "TobyMac")
            self.assertEqual(merged["Fm Static"], "FM Static")


class InboxTests(unittest.TestCase):
    def test_cleanup_removes_emptied_folders_and_archives_reports(self):
        with tempfile.TemporaryDirectory() as root:
            inbox, archive = Path(root, "move"), Path(root, "archive")
            done = inbox / "Artist" / "Done Album"
            done.mkdir(parents=True)
            (done / "cover.jpg").write_bytes(b"x")
            kept = inbox / "Other" / "Skipped Album"
            kept.mkdir(parents=True)
            (kept / "01.flac").write_bytes(b"x")
            (inbox / "lucida-report-1.txt").write_text("r")
            notes = TOKYO.clean_inbox(inbox, archive)
            self.assertFalse((inbox / "Artist").exists())
            self.assertTrue((kept / "01.flac").exists())
            self.assertFalse((inbox / "lucida-report-1.txt").exists())
            self.assertEqual(len(list(archive.rglob("lucida-report-1.txt"))), 1)
            self.assertEqual(len(notes), 2)


@unittest.skipUnless(HAVE_MUTAGEN, "mutagen not installed")
class EditionTests(unittest.TestCase):
    def test_two_releases_in_one_folder_are_detected(self):
        from mutagen.flac import FLAC
        with tempfile.TemporaryDirectory() as root:
            files = []
            for name, date in (("a", "2016-01-08"), ("b", "2025-07-11")):
                path = f"{root}/{name}.flac"
                make_flac(path, track=1)
                f = FLAC(path)
                f["date"] = date
                f.save()
                files.append(DEEZER.read_file(path))
            self.assertTrue(TOKYO.mixed_editions(files))

    def test_duplicate_copies_of_one_release_are_not_flagged(self):
        with tempfile.TemporaryDirectory() as root:
            for name in ("a", "b"):
                make_flac(f"{root}/{name}.flac", track=1)
            files = [DEEZER.read_file(f"{root}/{n}.flac") for n in ("a", "b")]
            self.assertFalse(TOKYO.mixed_editions(files))


class SidecarTests(unittest.TestCase):
    def test_covers_and_lyrics_follow_the_audio(self):
        with tempfile.TemporaryDirectory() as root:
            src = Path(root, "in", "Artist", "Album")
            src.mkdir(parents=True)
            for name in ("01.flac", "01.lrc", "cover.jpg", "notes.nfo"):
                (src / name).write_bytes(b"x")
            dest = Path(root, "lib", "Artist", "Album")
            item = IMPORT.ImportItem(src / "01.flac", ["Artist"], ["Artist"], "T", "Album",
                                     destination=dest / "01.flac")
            got = {(s.name, d.name) for s, d in IMPORT.sidecars([item])}
            self.assertEqual(got, {("cover.jpg", "cover.jpg"), ("01.lrc", "01.lrc")})

    def test_album_already_in_library_is_skipped_not_refused(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            (root / "library" / "Artist" / "Album").mkdir(parents=True)
            (root / "library" / "Artist" / "Album" / "01.flac").touch()
            items = [IMPORT.ImportItem(root / "in" / f"0{n}.flac", ["Artist"], ["Artist"], f"T{n}", "Album")
                     for n in (1, 2)]
            errors = IMPORT.assign_destinations(items, root / "library", "Various Artists",
                                                skip_existing=True)
            self.assertEqual(errors, [])
            self.assertTrue(all(i.skipped for i in items))


@unittest.skipUnless(HAVE_MUTAGEN, "mutagen not installed")
class DryRunOrderTests(unittest.TestCase):
    def test_planned_disc_fixes_silence_the_order_warning(self):
        import contextlib
        import io
        from mutagen.flac import FLAC
        with tempfile.TemporaryDirectory() as root:
            album = Path(root, "in", "Artist", "Album")
            album.mkdir(parents=True)
            paths = [album / f"{n}.flac" for n in ("a", "b")]
            for n, path in enumerate(paths):
                make_flac(str(path), track=1)
                f = FLAC(str(path))
                f["artist"], f["albumartist"], f["album"], f["title"] = "Artist", "Artist", "Album", f"T{n}"
                f.save()
            argv = [str(Path(root, "in")), "--library", str(Path(root, "lib"))]

            def run(planned=None):
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    self.assertEqual(IMPORT.main(argv, planned), 0)
                return out.getvalue()

            self.assertIn("play out of order", run())
            planned = {str(p.resolve()): (disc, 1) for disc, p in enumerate(paths, 1)}
            self.assertNotIn("play out of order", run(planned))


@unittest.skipUnless(HAVE_MUTAGEN, "mutagen not installed")
class OggRepairTests(unittest.TestCase):
    def page(self, seq, last=False):
        from mutagen.ogg import OggPage
        pg = OggPage()
        pg.serial, pg.sequence, pg.packets, pg.last = 1, seq, [b"x" * 100], last
        return pg.write()

    def test_broken_tail_is_dropped_and_stream_ended(self):
        with tempfile.TemporaryDirectory() as root:
            path = f"{root}/a.opus"
            tail = self.page(2, last=True)[:40]
            Path(path).write_bytes(self.page(0) + self.page(1) + tail)
            self.assertEqual(DEEZER.repair_ogg_tail(path), len(tail))
            self.assertFalse(DEEZER.ogg_tail_broken(path))
            self.assertEqual(Path(path).read_bytes(), self.page(0) + self.page(1, last=True))

    def test_pages_out_of_sequence_are_not_repaired(self):
        with tempfile.TemporaryDirectory() as root:
            path = f"{root}/a.opus"
            original = self.page(0) + self.page(2) + b"junk"
            Path(path).write_bytes(original)
            with self.assertRaises(ValueError):
                DEEZER.repair_ogg_tail(path)
            self.assertEqual(Path(path).read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
