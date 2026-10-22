import importlib.util
import json
import struct
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "tools" / "fix-disc-numbers.py"
SPEC = importlib.util.spec_from_file_location("fix_disc_numbers", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

HAVE_MUTAGEN = MODULE.mutagen is not None


def make_flac(path, track=None, disc=None, md5=b"\x11" * 16):
    """A tag-only FLAC: STREAMINFO with no audio frames, enough for mutagen."""
    info = struct.pack(">HH", 4096, 4096) + bytes(6)
    packed = (44100 << 44) | (1 << 41) | (15 << 36) | (44100 * 3)
    info += packed.to_bytes(8, "big") + md5
    Path(path).write_bytes(b"fLaC" + bytes([0x80]) + len(info).to_bytes(3, "big") + info)
    from mutagen.flac import FLAC
    f = FLAC(path)
    if track is not None:
        f["tracknumber"] = str(track)
    if disc is not None:
        f["discnumber"] = str(disc)
    f.save()


def entries(*specs):
    """specs: (file_number, track, disc)"""
    return [MODULE.Entry(f"/a/{n:03}.flac" if n is not None else f"/a/x{t}.flac", n, t, d)
            for n, t, d in specs]


class PlanTests(unittest.TestCase):
    def test_restarting_track_numbers_become_discs(self):
        plan = MODULE.plan_album("/a", entries((1, 1, None), (2, 2, None), (3, 1, None), (4, 2, None), (5, 3, None)))
        self.assertEqual(plan.status, "fix")
        self.assertEqual([[e.track for e in d] for d in plan.discs], [[1, 2], [1, 2, 3]])

    def test_single_disc_is_left_alone(self):
        self.assertEqual(MODULE.plan_album("/a", entries((1, 1, None), (2, 2, None))).status, "single")

    def test_existing_disc_numbers_are_respected(self):
        plan = MODULE.plan_album("/a", entries((1, 1, 1), (2, 1, 2)))
        self.assertEqual(plan.status, "has-discs")

    def test_partly_tagged_album_needs_a_human(self):
        plan = MODULE.plan_album("/a", entries((1, 1, 1), (2, 1, None)))
        self.assertEqual(plan.status, "partial")

    def test_two_rips_in_one_folder_are_not_guessed(self):
        # "01 - Song.flac" and "01. Artist - Song.flac": filename numbers repeat.
        plan = MODULE.plan_album("/a", [
            MODULE.Entry("/a/01 - A.flac", 1, 1, None), MODULE.Entry("/a/01. X - A.flac", 1, 1, None),
            MODULE.Entry("/a/02 - B.flac", 2, 2, None), MODULE.Entry("/a/02. X - B.flac", 2, 2, None)])
        self.assertEqual(plan.status, "ambiguous")

    def test_disc_must_start_at_track_one(self):
        plan = MODULE.plan_album("/a", entries((1, 1, None), (2, 5, None), (3, 2, None), (4, 2, None)))
        self.assertEqual(plan.status, "ambiguous")

    def test_unnumbered_filenames_are_not_guessed(self):
        plan = MODULE.plan_album("/a", entries((None, 1, None), (None, 1, None)))
        self.assertEqual(plan.status, "ambiguous")

    def test_parse_number(self):
        self.assertEqual(MODULE.parse_number("3/12"), 3)
        self.assertEqual(MODULE.parse_number([(4, 9)]), 4)
        self.assertIsNone(MODULE.parse_number("x"))
        self.assertIsNone(MODULE.parse_number("0"))
        self.assertIsNone(MODULE.parse_number(None))


@unittest.skipUnless(HAVE_MUTAGEN, "mutagen not installed")
class WriteTests(unittest.TestCase):
    def test_scan_write_verify_and_undo(self):
        with tempfile.TemporaryDirectory() as tmp:
            album = Path(tmp) / "Artist" / "Box"
            album.mkdir(parents=True)
            for n, t in [(1, 1), (2, 2), (3, 1), (4, 2)]:
                make_flac(album / f"{n:02}. Song {n}.flac", track=t)

            plans, errors = MODULE.scan(tmp)
            self.assertEqual(errors, [])
            self.assertEqual([p.status for p in plans], ["fix"])

            records = []
            for d, disc in enumerate(plans[0].discs, 1):
                for e in disc:
                    records.append(MODULE.write_disc(e.path, d, 2, None, tmp))
            got = [MODULE.read_numbers(str(album / f"{n:02}. Song {n}.flac")) for n in (1, 2, 3, 4)]
            self.assertEqual(got, [(1, 1), (2, 1), (1, 2), (2, 2)])
            self.assertEqual(MODULE.scan(tmp)[0][0].status, "has-discs")  # idempotent

            log = Path(tmp) / "undo.json"
            log.write_text(json.dumps(records))
            self.assertEqual(MODULE.undo(str(log)), 0)
            got = [MODULE.read_numbers(str(album / f"{n:02}. Song {n}.flac"))[1] for n in (1, 2, 3, 4)]
            self.assertEqual(got, [None] * 4)

    def test_write_refuses_when_audio_properties_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "01. A.flac"
            make_flac(path, track=1)
            real = MODULE.audio_fingerprint
            calls = []

            def fake(audio):
                calls.append(1)
                return real(audio) if len(calls) == 1 else ("changed",)
            MODULE.audio_fingerprint = fake
            try:
                with self.assertRaises(RuntimeError):
                    MODULE.write_disc(str(path), 1, 2, None, tmp)
            finally:
                MODULE.audio_fingerprint = real


if __name__ == "__main__":
    unittest.main()
