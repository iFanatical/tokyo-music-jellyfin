import importlib.util
import base64
import http.client
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

SCRIPT = Path(__file__).parents[1] / "tools" / "fill-missing-artwork.py"
SPEC = importlib.util.spec_from_file_location("fill_missing_artwork", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class ArtworkTests(unittest.TestCase):
    def test_upload_sends_base64_image_with_image_content_type(self):
        image = b'\x89PNG\r\n\x1a\n\x00\xff'
        with patch.object(MODULE.urllib.request, "urlopen") as opened:
            MODULE.Jellyfin("http://example", "token").upload_primary("abc", image, "image/png")
        request = opened.call_args.args[0]
        self.assertEqual(base64.b64decode(request.data, validate=True), image)
        self.assertEqual(request.get_header("Content-type"), "image/png")
        self.assertEqual(request.get_method(), "POST")

    def test_external_disconnect_retries_then_recovers(self):
        response = MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = b'{"relations": []}'
        response.headers.get_content_type.return_value = "application/json"
        fallback = MODULE.WikidataArtistImages()
        with patch.object(MODULE.urllib.request, "urlopen", side_effect=[
            http.client.RemoteDisconnected("connection closed"), response,
        ]) as opened, patch.object(MODULE.time, "sleep") as sleep, \
                patch("sys.stderr", new_callable=io.StringIO):
            data, _ = fallback._request("https://musicbrainz.org/ws/2/artist/test")
        self.assertEqual(data, {"relations": []})
        self.assertEqual(opened.call_count, 2)
        sleep.assert_called_once_with(1.1)

    def test_external_read_failures_exhaust_retries_as_jellyfin_error(self):
        for failure in (http.client.IncompleteRead(b"partial", 20),
                        TimeoutError("read timed out"), ConnectionResetError("reset")):
            with self.subTest(failure=type(failure).__name__):
                response = MagicMock()
                response.__enter__.return_value = response
                response.read.side_effect = failure
                with patch.object(MODULE.urllib.request, "urlopen", return_value=response) as opened, \
                        patch.object(MODULE.time, "sleep") as sleep, \
                        patch("sys.stderr", new_callable=io.StringIO):
                    with self.assertRaisesRegex(MODULE.JellyfinError, "after 4 attempts"):
                        MODULE.WikidataArtistImages()._request("https://example.com/image")
                self.assertEqual(opened.call_count, 4)
                self.assertEqual(sleep.call_count, 3)

    def test_sweep_continues_after_exhausted_disconnect_in_probe_and_apply(self):
        candidates = [("artist", {"Id": "1", "Name": "Disconnected"}),
                      ("artist", {"Id": "2", "Name": "Next artist"})]
        for mode in ("--probe", "--apply"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                report = Path(directory) / "report.json"
                fallback = MODULE.WikidataArtistImages()

                def find(item):
                    if item["Id"] == "1":
                        return fallback._request("https://musicbrainz.org/ws/2/artist/test")
                    return None

                with patch.object(sys, "argv", [str(SCRIPT), "artists", mode, "--delay", "0",
                                               "--report", str(report)]), \
                        patch.object(MODULE, "read_token", return_value="token"), \
                        patch.object(MODULE, "collect", return_value=candidates), \
                        patch.object(MODULE.Jellyfin, "remote_primary", return_value=None), \
                        patch.object(MODULE.WikidataArtistImages, "find", side_effect=find) as searched, \
                        patch.object(MODULE.urllib.request, "urlopen", side_effect=
                                     http.client.RemoteDisconnected("connection closed")) as opened, \
                        patch.object(MODULE.time, "sleep"), \
                        patch("sys.stdout", new_callable=io.StringIO) as output, \
                        patch("sys.stderr", new_callable=io.StringIO) as errors:
                    self.assertEqual(MODULE.main(), 1)
                self.assertEqual(opened.call_count, 4)
                self.assertEqual(searched.call_count, 2)
                self.assertIn("Next artist", output.getvalue())
                self.assertIn("FAILED: Disconnected", errors.getvalue())
                if mode == "--apply":
                    rows = json.loads(report.read_text())
                    self.assertEqual([row["status"] for row in rows],
                                     ["error", "no-provider-result"])

    def test_jellyfin_disconnect_is_reported_without_retrying_upload(self):
        client = MODULE.Jellyfin("http://example", "token")
        for action in (lambda: client.request("/Artists"),
                       lambda: client.upload_primary("abc", b"image", "image/png")):
            with patch.object(MODULE.urllib.request, "urlopen", side_effect=
                              http.client.RemoteDisconnected("connection closed")) as opened:
                with self.assertRaises(MODULE.JellyfinError):
                    action()
                opened.assert_called_once()

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

    def test_wikidata_fallback_prefers_existing_musicbrainz_id(self):
        fallback = MODULE.WikidataArtistImages(musicbrainz_delay=0)
        item = {"Name": "Artist", "ProviderIds": {"MusicBrainzArtist": "mbid"}}
        with patch.object(fallback, "_musicbrainz") as request:
            self.assertEqual(fallback.musicbrainz_id(item), "mbid")
        request.assert_not_called()

    def test_wikidata_fallback_accepts_one_exact_high_score_match(self):
        fallback = MODULE.WikidataArtistImages(musicbrainz_delay=0)
        with patch.object(fallback, "_musicbrainz", return_value={"artists": [
            {"id": "right", "name": "Skillet", "score": 100},
            {"id": "wrong", "name": "Skillet Tribute", "score": 100},
        ]}):
            self.assertEqual(fallback.musicbrainz_id({"Name": "Skillet"}), "right")

    def test_wikidata_fallback_rejects_ambiguous_exact_names(self):
        fallback = MODULE.WikidataArtistImages(musicbrainz_delay=0)
        with patch.object(fallback, "_musicbrainz", return_value={"artists": [
            {"id": "one", "name": "Dusty", "score": 100},
            {"id": "two", "name": "DUSTY", "score": 100},
        ]}):
            self.assertIsNone(fallback.musicbrainz_id({"Name": "DUSTY"}))

    def test_wikidata_relation_requires_one_entity(self):
        fallback = MODULE.WikidataArtistImages(musicbrainz_delay=0)
        with patch.object(fallback, "_musicbrainz", return_value={"relations": [
            {"type": "wikidata", "url": {"resource": "https://www.wikidata.org/wiki/Q42"}},
            {"type": "official homepage", "url": {"resource": "https://example.com"}},
        ]}):
            self.assertEqual(fallback.wikidata_id("mbid"), "Q42")

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
