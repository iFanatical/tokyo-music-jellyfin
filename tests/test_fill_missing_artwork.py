import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).parents[1] / "tools" / "fill-missing-artwork.py"
SPEC = importlib.util.spec_from_file_location("fill_missing_artwork", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class ArtworkTests(unittest.TestCase):
    def test_missing_primary_ignores_other_image_types(self):
        items = [
            {"Id": "1", "ImageTags": {"Primary": "tag"}},
            {"Id": "2", "ImageTags": {"Logo": "tag"}},
            {"Id": "3"},
        ]
        self.assertEqual([i["Id"] for i in MODULE.missing_primary(items)], ["2", "3"])

    def test_token_prefers_environment(self):
        with patch.dict(os.environ, {"TEST_TOKEN": " from-env "}):
            self.assertEqual(MODULE.read_token("TEST_TOKEN", "/missing"), "from-env")

    def test_token_file_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "token"
            path.write_text("from-file\n", encoding="utf-8")
            with patch.dict(os.environ, {}, clear=True):
                self.assertEqual(MODULE.read_token("TEST_TOKEN", str(path)), "from-file")

    def test_remote_search_requests_only_primary(self):
        client = MODULE.Jellyfin("http://example", "token")
        with patch.object(client, "request", return_value={"Images": [{"Url": "x"}]}) as request:
            image = client.remote_primary("abc")
        params = request.call_args.kwargs["params"]
        self.assertEqual(params["type"], "Primary")
        self.assertEqual(params["limit"], 1)
        self.assertEqual(image["Url"], "x")

    def test_download_uses_provider_url(self):
        client = MODULE.Jellyfin("http://example", "token")
        with patch.object(client, "request") as request:
            client.download_primary("abc", "https://provider/image.jpg")
        self.assertEqual(request.call_args.kwargs["method"], "POST")
        self.assertEqual(request.call_args.kwargs["params"], {
            "type": "Primary", "imageUrl": "https://provider/image.jpg",
        })

    def test_artist_visibility_uses_artist_index(self):
        client = MODULE.Jellyfin("http://example", "token")
        item = {"Id": "abc", "Name": "Artist"}
        with patch.object(client, "paged", return_value=[
            {"Id": "other", "ImageTags": {"Primary": "wrong"}},
            {"Id": "abc", "ImageTags": {"Primary": "right"}},
        ]) as paged, patch.object(client, "item") as generic_item:
            self.assertTrue(client.primary_is_visible("artist", item))
        generic_item.assert_not_called()
        self.assertEqual(paged.call_args.args[0], "/Artists")

    def test_album_visibility_uses_generic_item(self):
        client = MODULE.Jellyfin("http://example", "token")
        item = {"Id": "abc", "Name": "Album"}
        with patch.object(client, "item", return_value={
            "ImageTags": {"Primary": "tag"},
        }) as generic_item:
            self.assertTrue(client.primary_is_visible("album", item))
        generic_item.assert_called_once_with("abc")

    def test_review_move_preserves_library_relative_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            media = root / "mount" / "library"
            review = root / "mount" / "review"
            album = media / "Artist" / "Album"
            album.mkdir(parents=True)
            item = {"Id": "1", "Name": "Album", "Path": "/srv/music/library/Artist/Album"}
            plans, errors = MODULE.plan_review_moves(
                [("album", item)], "/srv/music/library", media, review
            )
            self.assertEqual(errors, [])
            self.assertEqual(plans[0][3], review / "Artist" / "Album")

    def test_review_move_rejects_stale_server_path(self):
        item = {"Id": "1", "Name": "Artist", "Path": "/jellyfin/Music/Artist"}
        plans, errors = MODULE.plan_review_moves(
            [("artist", item)], "/srv/music/library", "/mnt/library", "/mnt/review"
        )
        self.assertEqual(plans, [])
        self.assertIn("outside /srv/music/library", errors[0])

    def test_split_stale_excludes_only_exact_prefix(self):
        items = [
            ("album", {"Id": "1", "Path": "/jellyfin/Music/Artist/Album"}),
            ("album", {"Id": "2", "Path": "/srv/music/library/Artist/Album"}),
            ("artist", {"Id": "3", "Path": "/var/lib/jellyfin/metadata/artists/A"}),
        ]
        current, stale = MODULE.split_stale(items, "/jellyfin/Music")
        self.assertEqual([item["Id"] for _kind, item in current], ["2", "3"])
        self.assertEqual([item["Id"] for _kind, item in stale], ["1"])


if __name__ == "__main__":
    unittest.main()
