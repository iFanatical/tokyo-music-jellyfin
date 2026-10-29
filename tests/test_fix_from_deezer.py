import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from test_fix_disc_numbers import HAVE_MUTAGEN, make_flac  # noqa: E402

SCRIPT = Path(__file__).parents[1] / "tools" / "fix-from-deezer.py"
SPEC = importlib.util.spec_from_file_location("fix_from_deezer", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def tags(name, isrc, track=1, disc=None, genres=(), upc=""):
    return MODULE.FileTags(f"/a/{name}.flac", "vorbis", track, disc, isrc, upc, list(genres))


def fake_deezer(albums, isrc_to_album, upc_to_album=None):
    """albums: {id: (genres, [(isrc, disk, position), ...])}"""
    calls = []

    def fetch(path):
        calls.append(path)
        if path.startswith("track/isrc:"):
            album = isrc_to_album.get(path.split(":", 1)[1])
            return {"album": {"id": album}} if album else {"error": {"code": 800}}
        if path.startswith("album/upc:"):
            album = (upc_to_album or {}).get(path.split(":", 1)[1])
            return {"id": album} if album else {"error": {"code": 800}}
        album_id = int(path.split("/")[1].split("?")[0])
        genres, tracks = albums[album_id]
        if path.endswith("/tracks?limit=1000"):
            return {"data": [{"isrc": i, "disk_number": d, "track_position": p} for i, d, p in tracks]}
        return {"id": album_id, "title": f"Album {album_id}",
                "genres": {"data": [{"name": g} for g in genres]}}

    return MODULE.Deezer(None, fetch=fetch), calls


class PlanTests(unittest.TestCase):
    def test_matched_album_takes_deezer_genres(self):
        dz, _ = fake_deezer({1: (["Rock"], [("A", 1, 1), ("B", 1, 2)])}, {"A": 1, "B": 1})
        files = [tags("a", "A", genres=["Alternatif et Indé"]), tags("b", "B", track=2)]
        plan = MODULE.plan_album(dz, "/a", files, 0.8, True, True)
        self.assertEqual((plan.genres, plan.genre_source), (["Rock"], "deezer"))

    def test_low_coverage_falls_back_to_translated_genres(self):
        # One track also on a compilation: the compilation's genre must not win.
        dz, _ = fake_deezer({9: (["Films/Games"], [("A", 1, 1)])}, {"A": 9})
        files = [tags("a", "A", genres=["Alternatif et Indé"]), tags("b", "B", track=2),
                 tags("c", "C", track=3)]
        plan = MODULE.plan_album(dz, "/a", files, 0.8, True, True)
        self.assertEqual((plan.genres, plan.genre_source), (["Alternative"], "translated"))

    def test_one_tagged_stray_does_not_match_an_untagged_folder(self):
        dz, _ = fake_deezer({9: (["Rock"], [("A", 1, 1)])}, {"A": 9})
        files = [tags("stray", "A")] + [tags(f"u{n}", "", track=n) for n in range(2, 10)]
        plan = MODULE.plan_album(dz, "/a", files, 0.8, True, True)
        self.assertNotEqual(plan.genre_source, "deezer")

    def test_deezer_names_survive_a_second_run(self):
        self.assertEqual(MODULE.translate(["Christian", "Gospel"]), ["Christian", "Gospel"])
        self.assertEqual(MODULE.translate(["Rock", "Hard Rock", "Metal"]), ["Rock", "Hard Rock", "Metal"])

    def test_non_genres_are_dropped(self):
        self.assertEqual(MODULE.translate(["Germany", "Allemagne", "Pop", "Pop/Rock"]), ["Pop", "Rock"])

    def test_upc_is_tried_before_isrc(self):
        dz, calls = fake_deezer({5: (["Pop"], [("A", 1, 1)])}, {}, {"0123": 5})
        plan = MODULE.plan_album(dz, "/a", [tags("a", "A", upc="0123")], 0.8, True, False)
        self.assertEqual(plan.match["id"], 5)
        self.assertEqual(calls[0], "album/upc:0123")

    def test_box_set_gets_deezer_discs(self):
        layout = [("A", 1, 1), ("B", 1, 2), ("C", 2, 1), ("D", 2, 2)]
        dz, _ = fake_deezer({1: (["Rock"], layout)}, {i: 1 for i, _, _ in layout})
        files = [tags("a", "A", 1), tags("b", "B", 2), tags("c", "C", 1), tags("d", "D", 2)]
        plan = MODULE.plan_album(dz, "/a", files, 0.8, False, True)
        self.assertEqual(plan.discs["/a/c.flac"], (2, 1, 2))
        self.assertEqual(len(plan.discs), 4)

    def test_duplicate_copies_on_a_single_disc_are_left_alone(self):
        dz, _ = fake_deezer({1: (["Rap/Hip Hop"], [("A", 1, 1), ("B", 1, 2)])}, {"A": 1, "B": 1})
        files = [tags("a", "A", 1), tags("a2", "A", 1), tags("b", "B", 2)]
        plan = MODULE.plan_album(dz, "/a", files, 0.8, False, True)
        self.assertEqual(plan.discs, {})
        self.assertIn("one disc", plan.note)

    def test_live_album_on_a_box_set_keeps_its_own_discs(self):
        layout = [("A", 3, 1), ("B", 4, 1)]
        dz, _ = fake_deezer({1: (["Rock"], layout)}, {"A": 1, "B": 1})
        files = [tags("a", "A", 1), tags("b", "B", 1)]
        plan = MODULE.plan_album(dz, "/Delicate Sound of Thunder", files, 0.8, False, True)
        self.assertEqual(plan.discs, {})
        self.assertIn("different release", plan.note)

    def test_discs_need_every_file_on_the_album(self):
        layout = [("A", 1, 1), ("B", 2, 1)]
        dz, _ = fake_deezer({1: (["Rock"], layout)}, {"A": 1, "B": 1})
        files = [tags("a", "A", 1), tags("b", "B", 1), tags("x", "X", 1)]
        plan = MODULE.plan_album(dz, "/a", files, 0.5, False, True)
        self.assertEqual(plan.discs, {})
        self.assertIn("x.flac", plan.note)

    def test_existing_disc_numbers_are_never_replaced(self):
        dz, _ = fake_deezer({1: (["Rock"], [("A", 1, 1), ("B", 2, 1)])}, {"A": 1, "B": 1})
        files = [tags("a", "A", 1, disc=1), tags("b", "B", 1, disc=1)]
        self.assertEqual(MODULE.plan_album(dz, "/a", files, 0.8, False, True).discs, {})

    def test_cache_avoids_repeat_requests(self):
        dz, calls = fake_deezer({1: (["Rock"], [("A", 1, 1)])}, {"A": 1})
        dz.get("track/isrc:A")
        dz.get("track/isrc:A")
        self.assertEqual(calls, ["track/isrc:A"])


class FillMissingTests(unittest.TestCase):
    def plan(self, folder, genres=(), source=""):
        p = MODULE.AlbumPlan(folder, [tags("a", "")])
        p.genres, p.genre_source = list(genres), source
        return p

    def test_artist_genres_come_from_their_other_albums(self):
        plans = [self.plan("/l/Metallica/Load", ["Rock", "Metal"], "deezer"),
                 self.plan("/l/Metallica/Reload", ["Rock", "Metal"], "deezer"),
                 self.plan("/l/Metallica/Garage", ["Metal"], "deezer"),
                 self.plan("/l/Metallica/St. Anger")]
        MODULE.fill_missing_genres(plans, None)
        self.assertEqual((plans[3].genres, plans[3].genre_source), (["Rock", "Metal"], "artist"))

    def test_various_artists_do_not_share_genres(self):
        plans = [self.plan("/l/Various Artists/Halo", ["Films/Games"], "deezer"),
                 self.plan("/l/Various Artists/Hits")]
        MODULE.fill_missing_genres(plans, None)
        self.assertEqual(plans[1].genres, [])

    def test_musicbrainz_outage_skips_the_album_instead_of_failing(self):
        class DownMB:
            def get(self, path):
                raise RuntimeError(f"MusicBrainz did not answer: {path}")
        plans = [self.plan("/l/Valkyrik/Album"), self.plan("/l/Other/Album", ["Rock"], "deezer")]
        MODULE.fill_missing_genres(plans, DownMB())
        self.assertEqual(plans[0].genres, [])
        self.assertIn("MusicBrainz did not answer", plans[0].note)
        self.assertEqual(plans[1].genres, ["Rock"])

    def test_musicbrainz_tags_map_to_deezer_names(self):
        tags_ = [{"name": "contemporary christian", "count": 6}, {"name": "pop rock", "count": 4},
                 {"name": "praise & worship", "count": 3}, {"name": "polka", "count": 1}]
        self.assertEqual(MODULE.map_mb_genres(tags_), ["Christian", "Rock"])

    def test_musicbrainz_prefers_the_release_group(self):
        responses = {
            "isrc/X?inc=releases+artists": {"recordings": [
                {"artist-credit": [{"artist": {"id": "art"}}], "releases": [{"id": "rel"}]}]},
            "release/rel?inc=release-groups": {"release-group": {"id": "rg"}},
            "release-group/rg?inc=genres": {"genres": [{"name": "pop punk", "count": 3}]},
            "artist/art?inc=genres": {"genres": [{"name": "rock", "count": 9}]},
        }
        mb = MODULE.MusicBrainz(None, fetch=lambda path: responses.get(path, {}))
        genres, level = MODULE.mb_genres(mb, "/l/Band/Album", [tags("a", "X")])
        self.assertEqual((genres, level), (["Alternative"], "album"))

    def test_compilations_do_not_take_track_artist_genres(self):
        responses = {
            "isrc/X?inc=releases+artists": {"recordings": [
                {"artist-credit": [{"artist": {"id": "art"}}], "releases": []}]},
            "artist/art?inc=genres": {"genres": [{"name": "nu metal", "count": 9}]},
        }
        mb = MODULE.MusicBrainz(None, fetch=lambda path: responses.get(path, {}))
        self.assertEqual(MODULE.mb_genres(mb, "/l/Various Artists/Halo 2", [tags("a", "X")]),
                         ([], ""))

    def test_musicbrainz_falls_back_to_an_exact_artist_name(self):
        responses = {
            'artist?query=artist%3A%22Koe%20Wetzel%22&limit=5': {"artists": [
                {"score": 100, "name": "Koe Wetzel", "id": "kw"}]},
            "artist/kw?inc=genres": {"genres": [{"name": "country", "count": 2},
                                                {"name": "red dirt", "count": 1}]},
        }
        mb = MODULE.MusicBrainz(None, fetch=lambda path: responses.get(path, {}))
        self.assertEqual(MODULE.mb_genres(mb, "/l/Koe Wetzel/Sellout", [tags("a", "")]),
                         (["Country"], "artist"))


@unittest.skipUnless(HAVE_MUTAGEN, "mutagen not installed")
class WriteTests(unittest.TestCase):
    def test_write_verify_and_undo(self):
        with tempfile.TemporaryDirectory() as root:
            path = f"{root}/01.flac"
            make_flac(path, track=1)
            from mutagen.flac import FLAC
            f = FLAC(path)
            f["genre"] = ["Alternatif et Indé"]
            f["isrc"] = ["GB0000000001"]
            f.save()
            tags_before = MODULE.read_file(path)
            self.assertEqual(tags_before.isrc, "GB0000000001")
            record = MODULE.write_file(tags_before, {"genres": ["Rock"], "disc": (2, 5, 3)})
            after = MODULE.read_file(path)
            self.assertEqual((after.genres, after.disc, after.track), (["Rock"], 2, 5))

            log = f"{root}/undo.json"
            Path(log).write_text(json.dumps([record]))
            self.assertEqual(MODULE.undo(log), 0)
            restored = MODULE.read_file(path)
            self.assertEqual((restored.genres, restored.disc, restored.track),
                             (["Alternatif et Indé"], None, 1))

    def test_ogg_with_a_broken_tail_is_detected(self):
        from mutagen.ogg import OggPage

        def page(seq, last=False):
            pg = OggPage()
            pg.serial, pg.sequence, pg.packets, pg.last = 1, seq, [b"x" * 100], last
            return pg.write()

        with tempfile.TemporaryDirectory() as root:
            good, bad = f"{root}/good.opus", f"{root}/bad.opus"
            Path(good).write_bytes(page(0) + page(1, last=True))
            Path(bad).write_bytes(page(0) + page(1) + page(2, last=True)[:40])
            self.assertFalse(MODULE.ogg_tail_broken(good))
            self.assertTrue(MODULE.ogg_tail_broken(bad))


if __name__ == "__main__":
    unittest.main()
