#!/usr/bin/env python3
"""Set album genres, and box-set disc numbers, from Deezer's catalogue.

THE PROBLEM
    Ripped files often carry no genre, or genres in whatever language the
    store used ("Alternatif et Indé"), and some box sets restart track
    numbers on each disc without writing DISCNUMBER, in a way the filename
    order cannot untangle (fix-disc-numbers.py reports these as ambiguous).

THE MATCH
    Each album folder is matched to one Deezer album: by the files' UPC when
    they have one, otherwise by looking up a few of their ISRCs. A match is
    only used when the Deezer album contains most of the folder's ISRCs
    (--min-coverage), so a single that also appears on a compilation does not
    pull in the compilation's genre. Lookups are cached (--cache), so a dry
    run followed by --apply asks Deezer only once. No account or key is used.

WHAT IS WRITTEN
    genres   every file in a matched folder gets the Deezer album's genres.
             Folders Deezer cannot match keep their genre, translated to the
             same names through GENRE_MAP; names that are not genres
             ("Germany", "Divers") are dropped.
    discs    only for folders where no file has a disc number, track numbers
             repeat, and every file's ISRC is on the matched Deezer album:
             disc and track come from Deezer's disk_number/track_position.

FILLING THE REST (--fill-missing)
    Albums with no genre after that take the genres their artist's other
    albums have (the most common set), which needs the whole library in one
    run. Artists with no such album are looked up on MusicBrainz: the album's
    release group by ISRC, else the artist, by ISRC or exact name. Its
    community tags are mapped onto Deezer's names through MB_RULES.

SAFETY
    Dry run unless --apply. Every write is recorded in the undo log, saved
    after each album, and --undo LOG restores the previous tags. Each file is
    re-read after writing and the audio must be unchanged, or the run stops.

USAGE
    tools/fix-from-deezer.py /path/to/music                    # dry run
    tools/fix-from-deezer.py /path/to/music --apply --jellyfin-url URL
    tools/fix-from-deezer.py "Artist/Album" --apply --no-genres # discs only
    tools/fix-from-deezer.py /path/to/music --fill-missing      # + artist/MusicBrainz
    tools/fix-from-deezer.py --undo deezer-undo.json

    Requires mutagen:  pip install mutagen  (a venv is fine)
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from difflib import SequenceMatcher
from dataclasses import dataclass, field
from pathlib import Path

DEEZER = "https://api.deezer.com/"
# Deezer allows 50 requests per 5 seconds.
REQUEST_GAP = 0.11
MUSICBRAINZ = "https://musicbrainz.org/ws/2/"
# MusicBrainz allows one request per second and wants an identifying User-Agent.
MB_GAP = 1.1
MB_AGENT = "TokyoMusic/1.0 (https://github.com/iFanatical/tokyo-music-jellyfin)"
VARIOUS = "various artists"

# MusicBrainz genres are community tags ("pop punk", "praise & worship"). Each is
# mapped to Deezer's names by the first rule whose keyword it contains, so the
# more specific keywords come first. Tags no rule covers are dropped.
MB_RULES = [
    (("christian", "worship", "gospel", "ccm"), "Christian"),
    (("soundtrack", "video game", "film score", "score"), "Films/Games"),
    (("metal", "deathcore"), "Metal"),
    (("hip hop", "hip-hop", "rap", "trap", "drill", "grime"), "Rap/Hip Hop"),
    (("country", "americana", "bluegrass"), "Country"),
    (("house", "techno"), "Techno/House"),
    (("trance", "hardstyle", "hard dance", "eurodance"), "Dance"),
    (("dubstep", "drum and bass", "electro", "edm", "electronic", "synth", "idm"), "Electro"),
    (("dance", "disco"), "Dance"),
    (("hard rock",), "Hard Rock"),
    (("punk", "emo", "post-hardcore", "hardcore", "alternative", "indie", "grunge",
      "shoegaze"), "Alternative"),
    (("r&b", "rhythm and blues", "soul", "funk"), "R&B"),
    (("rock",), "Rock"),
    (("pop",), "Pop"),
    (("folk", "singer-songwriter"), "Folk"),
    (("jazz", "swing"), "Jazz"),
    (("blues",), "Blues"),
    (("classical", "orchestral", "opera"), "Classical"),
    (("reggae", "ska"), "Reggae"),
    (("latin", "reggaeton", "salsa"), "Latin"),
]

# Store genre names (Qobuz, in English and French) -> Deezer's names. None drops
# a value that is not a genre. Anything not listed is kept as it is.
GENRE_MAP = {
    "Alternative & Indie": "Alternative",
    "Alternatif et Indé": "Alternative",
    "Gospel": "Christian",
    "Religious": "Christian",
    "Hip-Hop/Rap": "Rap/Hip Hop",
    "Electronic": "Electro",
    "Électronique": "Electro",
    "Trance": "Electro",
    "House": "Electro",
    "Drum & Bass": "Electro",
    "Ambient": "Electro",
    "Chill-out": "Electro",
    "Lounge": "Electro",
    "Experimental": "Electro",
    "Pop/Rock": "Rock",
    "Hard Rock": "Rock",
    "Punk / New Wave": "Rock",
    "Punk - New Wave": "Rock",
    "Rock progressif": "Rock",
    "Instrumental Progressive Metal": "Metal",
    "Film Soundtracks": "Films/Games",
    "Bandes originales de films": "Films/Games",
    "Blues Country Folk": "Folk",
    "Folk-Rock, Indie, Bluegrass": "Folk",
    "Irish Celtic": "Folk",
    "Contemporary Jazz": "Jazz",
    "K-Pop": "Asian Music",
    "Musiques de Noël": "Holiday",
    "Diction": None,
    "Eclectic/Other": None,
    "Miscellaneous": None,
    "Divers": None,
    "Germany": None,
    "Allemagne": None,
    "World": None,
}


def load_sibling(filename: str, name: str):
    path = Path(__file__).with_name(filename)
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


discs = load_sibling("fix-disc-numbers.py", "tokyo_music_discs")

# Keys this tool may write, per format. The undo log snapshots exactly these.
GENRE_KEY = {"vorbis": "genre", "mp3": "TCON", "mp4": "\xa9gen", "wma": "WM/Genre"}
TRACK_KEY = {"vorbis": "tracknumber", "mp3": "TRCK", "mp4": "trkn", "wma": "WM/TrackNumber"}
ISRC_KEYS = {"vorbis": ["isrc"], "mp3": ["TSRC"], "mp4": ["----:com.apple.iTunes:ISRC"],
             "wma": ["WM/ISRC"]}
UPC_KEYS = {"vorbis": ["upc", "barcode"], "mp3": ["TXXX:UPC", "TXXX:BARCODE"],
            "mp4": ["----:com.apple.iTunes:UPC", "----:com.apple.iTunes:BARCODE"],
            "wma": ["WM/UPC", "WM/Barcode"]}


def write_keys(k: str) -> list[str]:
    return [GENRE_KEY[k], TRACK_KEY[k], *discs.DISC_KEYS[k]]


def _values(audio, k: str, key: str) -> list[str]:
    value = audio.tags.get(key)
    if not value:
        return []
    if k == "mp3":
        return [str(v) for v in value.text]
    out = []
    for v in value:
        if isinstance(v, bytes):  # MP4 freeform atoms
            v = v.decode("utf-8", "replace")
        out.append(str(v))
    return out


def _first(audio, k: str, keys: list[str]) -> str:
    for key in keys:
        values = _values(audio, k, key)
        if values and values[0].strip():
            return values[0].strip()
    return ""


@dataclass
class FileTags:
    path: str
    kind: str
    track: int | None
    disc: int | None
    isrc: str
    upc: str
    genres: list[str]


def read_file(path: str) -> FileTags | None:
    k = discs.kind(path.rsplit(".", 1)[-1].lower())
    if k is None:
        return None
    audio = discs._open(path)
    track, disc = discs.read_numbers(path)
    return FileTags(path, k, track, disc, _first(audio, k, ISRC_KEYS[k]).upper(),
                    _first(audio, k, UPC_KEYS[k]), _values(audio, k, GENRE_KEY[k]))


class Deezer:
    """Cached, rate-limited GETs against the public API."""

    def __init__(self, cache_path: str | None, fetch=None):
        self.cache_path = cache_path
        self.cache = {}
        if cache_path and os.path.exists(cache_path):
            with open(cache_path, encoding="utf-8") as fh:
                self.cache = json.load(fh)
        self._fetch = fetch or self._http
        self._last = 0.0
        self._dirty = 0

    def _http(self, path: str):
        for attempt in range(5):
            wait = self._last + REQUEST_GAP - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            self._last = time.monotonic()
            try:
                with urllib.request.urlopen(DEEZER + path, timeout=30) as resp:
                    data = json.load(resp)
            except (urllib.error.URLError, TimeoutError):
                time.sleep(2 * (attempt + 1))
                continue
            # Code 4 is "quota exceeded": back off and retry.
            if isinstance(data, dict) and data.get("error", {}).get("code") == 4:
                time.sleep(5)
                continue
            return data
        raise RuntimeError(f"Deezer did not answer: {path}")

    def get(self, path: str):
        if path not in self.cache:
            self.cache[path] = self._fetch(path)
            self._dirty += 1
            if self._dirty >= 50:
                self.save()
        return self.cache[path]

    def save(self):
        if self.cache_path and self._dirty:
            tmp = self.cache_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(self.cache, fh)
            os.replace(tmp, self.cache_path)
            self._dirty = 0

    def album(self, album_id) -> dict | None:
        info = self.get(f"album/{album_id}")
        if not isinstance(info, dict) or "error" in info:
            return None
        tracks = self.get(f"album/{album_id}/tracks?limit=1000")
        info["track_list"] = tracks.get("data", []) if isinstance(tracks, dict) else []
        return info


class MusicBrainz(Deezer):
    """The same cache and pacing, against the MusicBrainz web service."""

    def _http(self, path: str):
        sep = "&" if "?" in path else "?"
        req = urllib.request.Request(f"{MUSICBRAINZ}{path}{sep}fmt=json",
                                     headers={"User-Agent": MB_AGENT})
        for attempt in range(5):
            wait = self._last + MB_GAP - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            self._last = time.monotonic()
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    return json.load(resp)
            except urllib.error.HTTPError as exc:
                if exc.code in (400, 404):
                    return {"error": exc.code}
                time.sleep(5 * (attempt + 1))  # 503: over the rate limit
            except (urllib.error.URLError, TimeoutError):
                time.sleep(2 * (attempt + 1))
        raise RuntimeError(f"MusicBrainz did not answer: {path}")


@dataclass
class AlbumPlan:
    folder: str
    files: list[FileTags]
    match: dict | None = None
    coverage: float = 0.0
    genres: list[str] = field(default_factory=list)
    genre_source: str = ""  # deezer | translated | artist | musicbrainz-album/-artist | ""
    discs: dict = field(default_factory=dict)  # path -> (disc, track, total)
    note: str = ""


def coverage(files: list[FileTags], album: dict) -> float:
    """Share of the folder's recordings on the album. Files without an ISRC count
    as misses, so one tagged stray cannot decide a folder of untagged files."""
    isrcs = {f.isrc for f in files if f.isrc}
    if not isrcs:
        return 0.0
    untagged = sum(1 for f in files if not f.isrc)
    hits = len(isrcs & {t.get("isrc", "").upper() for t in album["track_list"]})
    return hits / (len(isrcs) + untagged)


def find_album(dz: Deezer, files: list[FileTags], samples: int = 3) -> tuple[dict | None, float]:
    """The Deezer album that holds the most of this folder's ISRCs."""
    candidates = []
    for upc in Counter(f.upc for f in files if f.upc).most_common(1):
        hit = dz.get(f"album/upc:{upc[0]}")
        if isinstance(hit, dict) and hit.get("id"):
            candidates.append(hit["id"])
    with_isrc = [f for f in files if f.isrc]
    step = max(1, len(with_isrc) // samples)
    for f in with_isrc[::step][:samples]:
        hit = dz.get(f"track/isrc:{f.isrc}")
        if isinstance(hit, dict) and hit.get("album", {}).get("id"):
            candidates.append(hit["album"]["id"])
    best, best_cov = None, 0.0
    for album_id in dict.fromkeys(candidates):
        album = dz.album(album_id)
        if album is None:
            continue
        cov = coverage(files, album) if with_isrc else 1.0
        if cov > best_cov:
            best, best_cov = album, cov
    return best, best_cov


def translate(genres: list[str]) -> list[str]:
    out = []
    for g in genres:
        g = GENRE_MAP.get(g.strip(), g.strip())
        if g and g not in out:
            out.append(g)
    return out


def folder_artist(folder: str) -> str:
    return os.path.basename(os.path.dirname(folder))


def artist_genres(plans: list[AlbumPlan]) -> dict[str, list[str]]:
    """Each artist's most common genre list among the albums that have one."""
    seen: dict[str, Counter] = {}
    for p in plans:
        artist = folder_artist(p.folder).lower()
        if p.genre_source in ("deezer", "translated") and artist != VARIOUS:
            seen.setdefault(artist, Counter())[tuple(p.genres)] += 1
    return {a: list(c.most_common(1)[0][0]) for a, c in seen.items()}


def map_mb_genres(tags: list[dict], limit: int = 3) -> list[str]:
    """Most-voted MusicBrainz genres -> Deezer names. Tags with under a third of
    the top tag's votes are ignored, so one stray vote does not add a genre."""
    tags = sorted(tags, key=lambda t: -t.get("count", 0))
    if not tags:
        return []
    floor = max(1, tags[0].get("count", 0)) / 3
    out = []
    for t in tags:
        if t.get("count", 0) < floor:
            break
        name = t["name"].lower()
        mapped = next((g for keys, g in MB_RULES if any(k in name for k in keys)), None)
        if mapped and mapped not in out:
            out.append(mapped)
    return out[:limit]


def mb_genres(mb: MusicBrainz, folder: str, files: list[FileTags],
              samples: int = 3) -> tuple[list[str], str]:
    """Album genres from MusicBrainz, else the artist's. Recordings are found by
    ISRC; without one, the folder's artist is looked up by exact name."""
    group_ids, artist_ids = [], []
    for isrc in list(dict.fromkeys(f.isrc for f in files if f.isrc))[:samples]:
        for rec in mb.get(f"isrc/{isrc}?inc=releases+artists").get("recordings", []):
            for credit in rec.get("artist-credit", [])[:1]:
                artist_ids.append(credit["artist"]["id"])
            for rel in rec.get("releases", [])[:1]:
                group = mb.get(f"release/{rel['id']}?inc=release-groups").get("release-group")
                if group:
                    group_ids.append(group["id"])
    for gid in dict.fromkeys(group_ids):
        genres = map_mb_genres(mb.get(f"release-group/{gid}?inc=genres").get("genres", []))
        if genres:
            return genres, "album"
    artist = folder_artist(folder)
    if artist.lower() == VARIOUS:
        return [], ""  # the track artists' genres say nothing about a compilation
    if not artist_ids:
        query = urllib.parse.quote(f'artist:"{artist}"')
        for a in mb.get(f"artist?query={query}&limit=5").get("artists", []):
            if a.get("score") == 100 and a["name"].lower() == artist.lower():
                artist_ids.append(a["id"])
                break
    for aid in dict.fromkeys(artist_ids):
        genres = map_mb_genres(mb.get(f"artist/{aid}?inc=genres").get("genres", []))
        if genres:
            return genres, "artist"
    return [], ""


def fill_missing_genres(plans: list[AlbumPlan], mb: MusicBrainz | None,
                        known: dict[str, list[str]] | None = None) -> None:
    """Albums neither Deezer nor their own tags could name: take the artist's
    genres from their other albums, else ask MusicBrainz. `known` adds artists
    (lowercased) whose albums are not part of this run, e.g. from Jellyfin."""
    by_artist = {**(known or {}), **artist_genres(plans)}
    for p in plans:
        if p.genre_source:
            continue
        inherited = by_artist.get(folder_artist(p.folder).lower())
        if inherited:
            p.genres, p.genre_source = inherited, "artist"
        elif mb is not None:
            p.genres, level = mb_genres(mb, p.folder, p.files)
            if p.genres:
                p.genre_source = f"musicbrainz-{level}"


def needs_discs(files: list[FileTags]) -> bool:
    if any(f.disc is not None for f in files):
        return False
    tracks = [f.track for f in files if f.track is not None]
    return len(tracks) != len(set(tracks))


def _title_key(title: str) -> str:
    return "".join(ch for ch in title.lower() if ch.isalnum())


def same_title(folder: str, title: str) -> bool:
    """A live album also on a box set matches the box by ISRC; only the folder's own
    album may lend it a disc layout."""
    a, b = _title_key(os.path.basename(folder)), _title_key(title)
    return bool(a and b) and (a in b or b in a or SequenceMatcher(None, a, b).ratio() >= 0.6)


def plan_discs(files: list[FileTags], album: dict) -> tuple[dict, str]:
    by_isrc = {t.get("isrc", "").upper(): t for t in album["track_list"] if t.get("isrc")}
    total = max((t.get("disk_number") or 1 for t in album["track_list"]), default=1)
    if total < 2:
        return {}, "Deezer lists one disc; repeats are duplicate copies"
    out = {}
    for f in files:
        t = by_isrc.get(f.isrc)
        if not t:
            return {}, f"{os.path.basename(f.path)} is not on the Deezer album"
        out[f.path] = (t["disk_number"], t["track_position"], total)
    return out, ""


def plan_album(dz: Deezer, folder: str, files: list[FileTags], min_coverage: float,
               do_genres: bool, do_discs: bool) -> AlbumPlan:
    plan = AlbumPlan(folder, files)
    plan.match, plan.coverage = find_album(dz, files)
    matched = plan.match is not None and plan.coverage >= min_coverage
    if do_genres:
        deezer_genres = [g["name"] for g in (plan.match or {}).get("genres", {}).get("data", [])]
        if matched and deezer_genres:
            plan.genres, plan.genre_source = deezer_genres, "deezer"
        else:
            current = Counter(g for f in files for g in f.genres)
            plan.genres = translate([g for g, _ in current.most_common()])
            plan.genre_source = "translated" if plan.genres else ""
    if do_discs and needs_discs(files):
        if matched and not same_title(folder, plan.match.get("title", "")):
            plan.note = f"matches Deezer '{plan.match.get('title')}', a different release"
        elif matched:
            plan.discs, plan.note = plan_discs(files, plan.match)
        else:
            plan.note = "track numbers repeat, but no Deezer album matches"
    return plan


def file_changes(plan: AlbumPlan, f: FileTags, do_genres: bool) -> dict:
    change = {}
    if do_genres and plan.genre_source and f.genres != plan.genres:
        change["genres"] = plan.genres
    elif do_genres and not plan.genre_source and f.genres:
        change["genres"] = []  # every value was a non-genre
    if f.path in plan.discs:
        change["disc"] = plan.discs[f.path]
    return change


def _snapshot(audio, k: str) -> dict:
    out = {}
    for key in write_keys(k):
        value = audio.tags.get(key)
        if not value:
            out[key] = None
        elif k == "mp3":
            out[key] = [str(v) for v in value.text]
        elif k == "mp4" and key in ("trkn", "disk"):
            out[key] = [list(v) for v in value]
        else:
            out[key] = [str(v) for v in value]
    return out


def _restore(audio, k: str, snapshot: dict) -> None:
    from mutagen import id3
    for key, value in snapshot.items():
        if k == "mp3":
            audio.tags.delall(key)
            if value:
                audio.tags.add(getattr(id3, key)(encoding=3, text=value))
        elif value is None:
            if key in audio.tags:
                del audio.tags[key]
        elif k == "mp4" and key in ("trkn", "disk"):
            audio.tags[key] = [tuple(v) for v in value]
        else:
            audio.tags[key] = value


def ogg_tail_broken(path: str) -> bool:
    """Some downloaded Ogg files end in a partial page with no end-of-stream flag.
    mutagen cannot save tags to them: it fails partway through the rewrite."""
    if not path.lower().endswith((".ogg", ".oga", ".opus")):
        return False
    from mutagen.ogg import OggPage
    last = None
    with open(path, "rb") as fh:
        while True:
            try:
                last = OggPage(fh)
            except EOFError:
                return last is None or not last.last
            except Exception:  # noqa: BLE001
                return True


def repair_ogg_tail(path: str) -> int:
    """Drop the partial page after an Ogg file's last complete page and mark that
    page end-of-stream. The audio pages are rewritten unchanged. Refuses (raises)
    when pages are out of sequence or another page hides in the leftover bytes.
    Returns the number of bytes dropped."""
    from mutagen.ogg import OggPage
    size = os.path.getsize(path)
    pages, expected = [], {}
    with open(path, "rb") as fh:
        while True:
            pos = fh.tell()
            try:
                page = OggPage(fh)
            except EOFError:
                pos = size
                break
            except Exception:  # noqa: BLE001
                break
            if page.sequence != expected.get(page.serial, 0):
                raise ValueError(f"{path}: Ogg pages out of sequence; not repairing")
            expected[page.serial] = page.sequence + 1
            pages.append(page)
        fh.seek(pos)
        tail = fh.read()
    if not pages:
        raise ValueError(f"{path}: no Ogg pages")
    if b"OggS" in tail[1:]:
        raise ValueError(f"{path}: another page inside the broken tail; not repairing")
    pages[-1].last = True
    staged = path + ".repair.tmp"
    with open(staged, "wb") as fh:
        for page in pages:
            fh.write(page.write())
    try:
        if ogg_tail_broken(staged):
            raise ValueError(f"{path}: repair did not produce a clean file")
        os.replace(staged, path)
    finally:
        if os.path.exists(staged):
            os.remove(staged)
    return size - pos


def write_file(f: FileTags, change: dict) -> dict:
    from mutagen import id3
    audio = discs._open(f.path)
    before = discs.audio_fingerprint(audio)
    snapshot = _snapshot(audio, f.kind)
    k = f.kind
    if "genres" in change:
        key, genres = GENRE_KEY[k], change["genres"]
        if k == "mp3":
            audio.tags.delall(key)
            if genres:
                audio.tags.add(id3.TCON(encoding=3, text=genres))
        elif genres:
            audio.tags[key] = genres
        elif key in audio.tags:
            del audio.tags[key]
    if "disc" in change:
        disc, track, total = change["disc"]
        discs._set_disc(audio, k, disc, total)
        if k == "vorbis":
            audio.tags["tracknumber"] = [str(track)]
        elif k == "mp3":
            audio.tags.delall("TRCK")
            audio.tags.add(id3.TRCK(encoding=3, text=[str(track)]))
        elif k == "mp4":
            audio.tags["trkn"] = [(track, 0)]
        elif k == "wma":
            audio.tags["WM/TrackNumber"] = [str(track)]
    audio.save()

    check = read_file(f.path)
    if discs.audio_fingerprint(discs._open(f.path)) != before:
        raise RuntimeError(f"{f.path}: audio properties changed after writing; stopping")
    if "genres" in change and check.genres != change["genres"]:
        raise RuntimeError(f"{f.path}: genre did not read back")
    if "disc" in change and (check.disc, check.track) != change["disc"][:2]:
        raise RuntimeError(f"{f.path}: disc/track did not read back")
    return {"path": f.path, "kind": k, "before": snapshot}


def undo(log_path: str) -> int:
    discs.require_mutagen()
    with open(log_path, encoding="utf-8") as fh:
        records = json.load(fh)
    restored, failed = 0, []
    for rec in reversed(records):
        try:
            audio = discs._open(rec["path"])
            _restore(audio, rec["kind"], rec["before"])
            audio.save()
            restored += 1
        except Exception as exc:  # noqa: BLE001
            failed.append(f"{rec['path']}: {exc}")
    print(f"restored {restored} file(s)")
    for f in failed:
        print(f"  ! {f}")
    print("Refresh the affected albums in Jellyfin (replace all metadata) to see the old tags.")
    return 1 if failed else 0


def scan(root: str) -> tuple[list[tuple[str, list[FileTags]]], list[str]]:
    folders, errors = [], []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        files = []
        for name in sorted(filenames):
            if name.startswith(".") or name.rsplit(".", 1)[-1].lower() not in discs.AUDIO_EXTS:
                continue
            try:
                tags = read_file(os.path.join(dirpath, name))
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{os.path.join(dirpath, name)}: {exc}")
                continue
            if tags:
                files.append(tags)
        if files:
            folders.append((dirpath, files))
    return folders, errors


def main() -> int:
    ap = argparse.ArgumentParser(description="Set genres and box-set disc numbers from Deezer.")
    ap.add_argument("paths", nargs="*", metavar="path",
                    help="music directories to scan: the library, or individual albums")
    ap.add_argument("--apply", action="store_true", help="write changes (default is a dry run)")
    ap.add_argument("--no-genres", action="store_true", help="leave genres alone")
    ap.add_argument("--no-discs", action="store_true", help="leave disc numbers alone")
    ap.add_argument("--min-coverage", type=float, default=0.8,
                    help="share of a folder's ISRCs the Deezer album must hold (default: %(default)s)")
    ap.add_argument("--cache", default="deezer-cache.json",
                    help="Deezer response cache (default: %(default)s)")
    ap.add_argument("--fill-missing", action="store_true",
                    help="albums with no genre at all take the artist's genres from their "
                         "other albums, else MusicBrainz's (scan the whole library for this)")
    ap.add_argument("--no-musicbrainz", action="store_true",
                    help="with --fill-missing, only borrow genres from the artist's other albums")
    ap.add_argument("--mb-cache", default="musicbrainz-cache.json",
                    help="MusicBrainz response cache (default: %(default)s)")
    ap.add_argument("--report", help="also write the full plan as JSON here")
    ap.add_argument("--undo-log", default="deezer-undo.json",
                    help="where to record writes (default: %(default)s); appended to if it exists")
    ap.add_argument("--undo", metavar="LOG", help="reverse the writes recorded in LOG and exit")
    ap.add_argument("--jellyfin-url", help="refresh the changed albums after applying")
    ap.add_argument("--token", help="Jellyfin API key (or use --token-env / --token-file)")
    ap.add_argument("--token-env", default="JELLYFIN_TOKEN")
    ap.add_argument("--token-file", default=discs.DEFAULT_TOKEN_FILE)
    ap.add_argument("--media-root", default=discs.DEFAULT_MEDIA_ROOT,
                    help="library path on this machine (default: %(default)s)")
    ap.add_argument("--server-root", default=discs.DEFAULT_SERVER_ROOT,
                    help="the same path as Jellyfin sees it (default: %(default)s)")
    args = ap.parse_args()

    if args.undo:
        return undo(args.undo)
    if not args.paths:
        ap.error("a music directory is required")
    for path in args.paths:
        if not os.path.isdir(path):
            ap.error(f"not a directory: {path}")
    discs.require_mutagen()
    do_genres, do_discs = not args.no_genres, not args.no_discs
    paths = [os.path.abspath(p) for p in args.paths]
    root = os.path.dirname(os.path.commonpath(paths)) if len(paths) == 1 else os.path.commonpath(paths)

    def rel(path):
        return os.path.relpath(path, root)

    folders, errors = [], []
    for path in paths:
        print(f"scanning {path}", flush=True)
        found, failed = scan(path)
        folders += found
        errors += failed
    print(f"  {len(folders)} album folder(s); asking Deezer", flush=True)

    dz = Deezer(args.cache)
    plans = []
    try:
        for n, (folder, files) in enumerate(folders, 1):
            plans.append(plan_album(dz, folder, files, args.min_coverage, do_genres, do_discs))
            if n % 100 == 0:
                print(f"  ...{n} matched", file=sys.stderr, flush=True)
    finally:
        dz.save()
    if do_genres and args.fill_missing:
        mb = MusicBrainz(args.mb_cache) if not args.no_musicbrainz else None
        print("  filling genres for unmatched albums", flush=True)
        try:
            fill_missing_genres(plans, mb)
        finally:
            if mb:
                mb.save()

    changes = []  # (plan, file, change)
    for p in plans:
        for f in p.files:
            change = file_changes(p, f, do_genres)
            if change and ogg_tail_broken(f.path):
                errors.append(f"{rel(f.path)}: Ogg file ends in a broken page; not tagged")
            elif change:
                changes.append((p, f, change))

    sources = Counter(p.genre_source or "none" for p in plans)
    genre_totals = Counter()
    for p in plans:
        for g in p.genres:
            genre_totals[g] += len(p.files)
    print(f"\n  genres by source (albums): {dict(sources)}")
    print("  genres (tracks): " + ", ".join(f"{g} {c}" for g, c in genre_totals.most_common()))
    for p in plans:
        if p.discs:
            total = next(iter(p.discs.values()))[2]
            print(f"  DISCS {rel(p.folder)}  ->  {total} discs from Deezer "
                  f"'{p.match.get('title')}'")
        elif p.note:
            print(f"  SKIP  {rel(p.folder)}  ({p.note})")
    for e in errors:
        print(f"  ! {e}")
    if args.report:
        with open(args.report, "w", encoding="utf-8") as fh:
            json.dump([{"folder": rel(p.folder), "deezer": (p.match or {}).get("id"),
                        "deezer_title": (p.match or {}).get("title"),
                        "coverage": round(p.coverage, 3), "genres": p.genres,
                        "genre_source": p.genre_source,
                        "before": sorted({g for f in p.files for g in f.genres}),
                        "discs": len(p.discs), "note": p.note} for p in plans],
                      fh, indent=1, ensure_ascii=False)
    n_genre = sum("genres" in c for _, _, c in changes)
    n_disc = sum("disc" in c for _, _, c in changes)
    print(f"\n{len(changes)} file(s) to change: {n_genre} genre, {n_disc} disc/track")
    if not changes:
        return 0
    if not args.apply:
        print("Dry run — nothing written. Re-run with --apply.")
        return 0

    records = []
    if os.path.exists(args.undo_log):
        with open(args.undo_log, encoding="utf-8") as fh:
            records = json.load(fh)

    def save_log():
        tmp = args.undo_log + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(records, fh, indent=1, ensure_ascii=False)
        os.replace(tmp, args.undo_log)

    changed_dirs, written = set(), 0
    try:
        for p, f, change in changes:
            records.append(write_file(f, change))
            written += 1
            if p.folder not in changed_dirs:
                changed_dirs.add(p.folder)
                save_log()
                if len(changed_dirs) % 100 == 0:
                    print(f"  ...{len(changed_dirs)} albums written", flush=True)
    except Exception as exc:  # noqa: BLE001
        save_log()
        print(f"\nSTOPPED after {written} file(s): {exc}", file=sys.stderr)
        print(f"undo log: {args.undo_log}", file=sys.stderr)
        return 1
    save_log()
    print(f"\nwrote and verified {written} file(s) in {len(changed_dirs)} album(s)")
    print(f"undo log: {args.undo_log}  (reverse with --undo {args.undo_log})")

    if args.jellyfin_url:
        token = discs.read_token(args)
        if not token:
            print("error: no Jellyfin token; tags are written but Jellyfin was not refreshed",
                  file=sys.stderr)
            return 1
        discs.load_tag_tool().refresh_jellyfin(args.jellyfin_url, token, changed_dirs,
                                               args.media_root, args.server_root)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
