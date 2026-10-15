#!/usr/bin/env python3
"""Verify and restore a content-addressed backup using Python 3 standard library."""
from __future__ import annotations

import argparse
import contextlib
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import unicodedata
import zipfile

CHUNK = 1024 * 1024
MAX_MANIFEST = 256 * 1024 * 1024
SHA256 = re.compile(r"[a-f0-9]{64}\Z")
RESERVED = re.compile(r"(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])\Z", re.I)


class BackupError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise BackupError(message)


def safe_path(value):
    require(isinstance(value, str) and bool(value), "Empty or invalid relative path")
    require(not value.startswith(("/", "\\")) and "\\" not in value,
            "Absolute paths and backslash paths are forbidden")
    parts = value.split("/")
    for part in parts:
        require(part not in ("", ".", ".."), "Empty, dot or traversal path component")
        require(not part.endswith((".", " ")), "Trailing dot or space in path")
        require(not any(ord(c) < 32 or ord(c) == 127 or c in '<>:"|?*' for c in part),
                "Control character or Windows-invalid path component")
        require(not RESERVED.fullmatch(part.split(".", 1)[0].rstrip(" .")),
                "Windows reserved path name")
    return parts


def canonical(value):
    return tuple(unicodedata.normalize("NFC", p).casefold() for p in safe_path(value))


def no_links(path):
    """Reject symlinks and Windows reparse points in every existing ancestor."""
    path = Path(os.path.abspath(path))
    for current in reversed((path, *path.parents)):
        try:
            info = current.lstat()
        except FileNotFoundError:
            continue
        require(not stat.S_ISLNK(info.st_mode) and
                not (getattr(info, "st_file_attributes", 0) & 0x400),
                "Symlink or reparse point is forbidden")
    return path


def integer(value):
    require(type(value) is int and value >= 0, "Invalid byte count")
    return value


def digest_value(value):
    require(isinstance(value, str) and SHA256.fullmatch(value), "Invalid SHA-256")
    return value


def stream_digest(source, target=None, expected_bytes=None):
    count = 0
    digest = hashlib.sha256()
    while True:
        chunk = source.read(CHUNK)
        if not chunk:
            break
        count += len(chunk)
        if expected_bytes is not None:
            require(count <= expected_bytes, "Object exceeds declared byte count")
        digest.update(chunk)
        if target is not None:
            target.write(chunk)
    return count, digest.hexdigest()


def unique_json(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate key in manifest JSON")
        result[key] = value
    return result


def read_manifest(backup):
    plain, compressed = backup / "manifest.json", backup / "manifest.json.gz"
    require(plain.is_file() != compressed.is_file(),
            "Backup must contain exactly one manifest.json or manifest.json.gz")
    source = no_links(plain if plain.is_file() else compressed)
    opener = gzip.open if source.suffix == ".gz" else open
    with opener(source, "rb") as handle:
        data = handle.read(MAX_MANIFEST + 1)
    require(len(data) <= MAX_MANIFEST, "Manifest exceeds 256 MiB limit")
    value = json.loads(data.decode("utf-8-sig"), object_pairs_hook=unique_json)
    require(isinstance(value, dict), "Manifest must be an object")
    return value


def validate_manifest(manifest):
    files, objects, volumes = (manifest.get(k) for k in ("files", "objects", "volumes"))
    require(isinstance(files, list) and isinstance(objects, dict) and isinstance(volumes, list),
            "Manifest requires files, objects and volumes")
    volume_map, volume_names = {}, set()
    for entry in volumes:
        require(isinstance(entry, dict), "Invalid volume record")
        name = entry.get("path")
        safe_path(name)
        require(re.fullmatch(r"volumes/part-[A-Za-z0-9_-]+\.zip", name), "Invalid volume path")
        key = canonical(name)
        require(key not in volume_names, "Duplicate or colliding volume path")
        volume_names.add(key)
        integer(entry.get("bytes")); digest_value(entry.get("sha256"))
        volume_map[name] = entry
    members = {name: {} for name in volume_map}
    for name, entry in objects.items():
        require(isinstance(entry, dict), "Invalid object record")
        safe_path(name)
        member, volume = entry.get("member"), entry.get("volume")
        safe_path(member)
        require(re.fullmatch(r"objects/[a-f0-9]{64}(?:\.[A-Za-z0-9_-]+)*", member),
                "Invalid object member path")
        require(volume in volume_map, "Object references unknown volume")
        require(member not in members[volume], "Duplicate object member mapping")
        size, digest = integer(entry.get("bytes")), digest_value(entry.get("sha256"))
        require(member.split("/", 1)[1].split(".", 1)[0] == digest,
                "Content-addressed object member does not match SHA-256")
        members[volume][member] = (name, size, digest)
    paths, directories, spellings, restore, excluded = set(), set(), {}, [], 0
    for entry in files:
        require(isinstance(entry, dict), "Invalid file record")
        key = canonical(entry.get("path"))
        original = tuple(safe_path(entry["path"]))
        for length in range(1, len(key) + 1):
            prefix = key[:length]
            require(prefix not in spellings or spellings[prefix] == original[:length],
                    "Case or Unicode-normalization path spelling collision")
            spellings[prefix] = original[:length]
        require(key not in paths, "Duplicate or case-insensitive file path collision")
        require(key not in directories, "File/directory path collision")
        for length in range(1, len(key)):
            require(key[:length] not in paths, "File/directory path collision")
            directories.add(key[:length])
        paths.add(key)
        status = entry.get("status", "")
        require(isinstance(status, str), "Invalid file status")
        if entry.get("object") is None:
            require(status == "excluded" or status.startswith("excluded_"),
                    "Missing file object without explicit excluded status")
            excluded += 1
            continue
        require(entry["object"] in objects, "File references unknown object")
        obj = objects[entry["object"]]
        require(integer(entry.get("bytes")) == obj["bytes"] and
                digest_value(entry.get("sha256")) == obj["sha256"],
                "File size/hash disagrees with referenced object")
        restore.append(entry)
    return restore, objects, volume_map, members, excluded


def check_zip(archive, expected):
    found = set()
    for info in archive.infolist():
        if info.is_dir():
            require(info.filename == "objects/", "Unexpected ZIP directory")
            continue
        safe_path(info.filename)
        require(info.filename not in found, "Duplicate ZIP member")
        found.add(info.filename)
        require(info.filename in expected, "Unexpected ZIP member")
        kind = stat.S_IFMT(info.external_attr >> 16)
        require(kind in (0, stat.S_IFREG), "ZIP member is not a regular file")
        require(not (info.flag_bits & 1), "Encrypted ZIP member is unsupported")
        require(info.file_size == expected[info.filename][1], "ZIP member byte count mismatch")
    require(found == set(expected), "Missing ZIP object")


def destination_path(value, backup):
    require(value is not None, "Restore requires explicit --destination")
    destination = no_links(value)
    require(destination != backup and backup not in destination.parents and
            destination not in backup.parents, "Destination and backup must not overlap")
    if destination.exists():
        require(destination.is_dir() and not any(destination.iterdir()),
                "Destination must be a new or empty directory")
    return destination


def restore_backup(backup, destination=None, verify_only=False):
    backup = no_links(backup)
    require(backup.is_dir(), "Backup directory does not exist")
    manifest = read_manifest(backup)
    files, objects, volumes, members, excluded = validate_manifest(manifest)
    target = None if verify_only else destination_path(destination, backup)
    # Keep the actual volume file handles open through verification and copying.
    with contextlib.ExitStack() as stack:
        archives = {}
        for name, meta in volumes.items():
            volume = no_links(backup.joinpath(*safe_path(name)))
            require(volume.is_file(), "Missing volume")
            handle = stack.enter_context(open(volume, "rb"))
            size, digest = stream_digest(handle, expected_bytes=meta["bytes"])
            require((size, digest) == (meta["bytes"], meta["sha256"]),
                    "Volume byte count or SHA-256 mismatch")
            handle.seek(0)
            archive = stack.enter_context(zipfile.ZipFile(handle))
            check_zip(archive, members[name])
            archives[name] = archive
        for obj in objects.values():
            with archives[obj["volume"]].open(obj["member"]) as handle:
                size, digest = stream_digest(handle, expected_bytes=obj["bytes"])
            require((size, digest) == (obj["bytes"], obj["sha256"]),
                    "Object byte count or SHA-256 mismatch")
        if target is not None:
            # Recheck after potentially lengthy validation, before creating output.
            destination_path(target, backup)
            target.mkdir(parents=True, exist_ok=True)
            for entry in files:
                output = no_links(target.joinpath(*safe_path(entry["path"])))
                no_links(output.parent)
                output.parent.mkdir(parents=True, exist_ok=True)
                no_links(output.parent)
                obj = objects[entry["object"]]
                with archives[obj["volume"]].open(obj["member"]) as source, open(output, "xb") as sink:
                    size, digest = stream_digest(source, sink, expected_bytes=obj["bytes"])
                require((size, digest) == (entry["bytes"], entry["sha256"]),
                        "Restored file mismatch; preserve directory for inspection")
    return {"verified": True, "volumes": len(volumes), "objects": len(objects),
            "files": len(files), "excluded": excluded,
            "sanitized": sum("sanit" in item.get("status", "").lower() for item in files),
            "restored": target is not None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backup", default="full-backup", help="Backup directory (default: full-backup)")
    parser.add_argument("--destination", help="Explicit new or empty restore directory")
    parser.add_argument("--verify-only", action="store_true", help="Verify everything without restoring")
    args = parser.parse_args()
    require(not (args.verify_only and args.destination), "--verify-only cannot use --destination")
    result = restore_backup(args.backup, args.destination, args.verify_only)
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    try:
        main()
    except (BackupError, OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile,
            RuntimeError, EOFError) as exc:
        # Errors intentionally avoid printing file content, manifest data or credentials.
        message = str(exc) if isinstance(exc, BackupError) else type(exc).__name__
        print("RESTORE_FAILED: " + message, file=sys.stderr)
        sys.exit(1)
