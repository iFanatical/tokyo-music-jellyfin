#!/usr/bin/env python3
"""Tag the eight known tag-empty Limbo releases from the download inbox.

Dry-run by default. The manifest is intentionally exact: unexpected folders,
track counts, or filenames are refused rather than guessed.
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path

from mutagen.flac import FLAC


RELEASES = {
    "Limbo - Czarny Kolczyk": {
        "artist": "Limbo", "albumartist": "Limbo", "album": "Czarny Kolczyk",
        "date": "2008-12-12",
        "titles": ["Pięknoduch", "Czarny Kolczyk", "Jutro", "Sofi Bolero", "Rogi",
                   "Oczko", "Mandarynki", "Piosenka Pożegnalna", "Kurz i smród",
                   "Księżycowy Pałac", "Kaja mówi"],
    },
    "Limbo - El mundo no es igual": {
        "artist": "Limbo", "albumartist": "Limbo", "album": "El mundo no es igual",
        "titles": ["Intro Predicador", "Blasfemia", "El mundo no es igual", "Tatuajes",
                   "Dance (the fuckers)", "Dulce princesa", "I hate you", "Furioso Tsunami"],
    },
    "Limbo - Lycklig": {
        "artist": "Limbo", "albumartist": "Limbo", "album": "Lycklig", "date": "1992",
        "titles": ["Full kontroll", "Barfotadans", "Lycklig", "Salt", "Vad tyst du är",
                   "Allt eller inget", "Uppe på toppen igen", "Mellan natt och gryning",
                   "Dansar på vår grav", "Loop", "Närmare allt jag önskat"],
    },
    "Limbo - Ruidos En El Cielo": {
        "artist": "Limbo", "albumartist": "Limbo", "album": "Ruidos en el Cielo",
        "date": "1993-01-01",
        "titles": ["La Vereda del Sol", "Amanecer", "Fe de Días", "Qué Lindo Es", "Cajón",
                   "Una Sensación Desconocida", "Sentidos", "El Placer Es Mío",
                   "Viviana Lolocco", "Nativo", "Paiu-Paiu", "Río Moro"],
    },
    "Limbo - Soft Devotion": {
        "artist": "Limbo", "albumartist": "Limbo", "album": "Soft Devotion",
        "date": "2014-10-27",
        "titles": ["Swell", "Rocking Chair", "Keep On Fighting", "Forever", "Cold Light",
                   "Down the Hole", "Sundown On the Beach", "Things Change", "Soft Devotion",
                   "Ocean", "Be Water"],
    },
    "Limbo - The Greatest": {
        "artist": "Limbo", "albumartist": "Limbo", "album": "The Greatest",
        "titles": ["The Greatest", "Floating", "Fishing Rod", "Winter Rampage", "Goldie",
                   "On the Run", "Different Shades of Gray", "What Goes On", "Into the Deep",
                   "This Is Our Last Song"],
    },
    "Limbo, ALESSIO MANZI - EXP": {
        "artist": "ALESSIO MANZI", "albumartist": "Limbo & ALESSIO MANZI", "album": "EXP",
        "date": "2001-01-01",
        "titles": ["Esperienze", "C6", "Adesso e Ora", "Fermami", "Io Sono Qui", "Strum"],
    },
    "Limbo, ALESSIO MANZI - Solo Per Adulti": {
        "artist": "ALESSIO MANZI", "albumartist": "Limbo & ALESSIO MANZI",
        "album": "Solo Per Adulti", "date": "2007-07-07",
        "titles": ["Sesto Senso", "1000 Volte", "Crisalide", "Carpediem", "Non MI Va",
                   "Quello Che Vorrei"],
    },
}

TRACK_RE = re.compile(r"^(\d{2}) - .+\.flac$", re.IGNORECASE)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("source", nargs="?", default="~/Downloads/downloaded-music/move")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    root = Path(args.source).expanduser().resolve()

    plan = []
    errors = []
    for folder, release in RELEASES.items():
        directory = root / folder
        files = sorted(directory.glob("*.flac"))
        titles = release["titles"]
        if len(files) != len(titles):
            errors.append(f"{directory}: expected {len(titles)} FLACs, found {len(files)}")
            continue
        for number, (path, title) in enumerate(zip(files, titles), 1):
            match = TRACK_RE.match(path.name)
            if not match or int(match.group(1)) != number:
                errors.append(f"{path}: expected track {number:02d}")
                continue
            audio = FLAC(path)
            if any(audio.get(key) for key in ("artist", "albumartist", "album", "title")):
                errors.append(f"{path}: already has identity tags; refusing to overwrite")
                continue
            target = path.with_name(f"{number:02d} - {title}.flac")
            if target != path and target.exists():
                errors.append(f"{path}: rename target already exists: {target}")
                continue
            plan.append((path, target, release, title, number, len(titles)))

    if errors:
        print(f"Refusing tag operation: {len(errors)} problem(s):")
        for error in errors:
            print(f"  {error}")
        return 2

    print(f"Validated {len(plan)} tag-empty FLAC files across {len(RELEASES)} releases.")
    for path, target, release, title, number, total in plan:
        rename = f"; rename -> {target.name}" if target != path else ""
        print(f"  {path.parent.name}/{path.name}: {release['artist']} — "
              f"{release['album']} — {number}/{total} — {title}{rename}")

    if not args.apply:
        print("\nDry run — nothing written. Re-run with --apply after reviewing this plan.")
        return 0

    for path, target, release, title, number, total in plan:
        audio = FLAC(path)
        audio["artist"] = release["artist"]
        audio["albumartist"] = release["albumartist"]
        audio["album"] = release["album"]
        audio["title"] = title
        audio["tracknumber"] = str(number)
        audio["tracktotal"] = str(total)
        if release.get("date"):
            audio["date"] = release["date"]
        audio.save()
        check = FLAC(path)
        expected = {"artist": release["artist"], "albumartist": release["albumartist"],
                    "album": release["album"], "title": title,
                    "tracknumber": str(number), "tracktotal": str(total)}
        if any(check.get(key) != [value] for key, value in expected.items()):
            raise RuntimeError(f"verification failed: {path}")
        if target != path:
            path.rename(target)

    print(f"\nTagged, verified, and filename-normalized {len(plan)} FLAC files.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
