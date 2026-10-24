"""Compute / verify the RED_SIGNAL_COMPLIANCE manifest content_hash.

Usage: python compute_hash.py [--write | --check]
"""
import hashlib
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
MANIFEST = HERE / "manifest.yaml"
HASH_LINE = re.compile(r'^content_hash:.*$', re.M)


def listed_files(text):
    return re.findall(r'^\s+(?:-\s+)?file:\s*(\S+)\s*$', text, re.M)


def compute(text):
    blank = HASH_LINE.sub('content_hash: ""', text)
    records = {"manifest.yaml": hashlib.sha256(blank.encode()).hexdigest()}
    for name in listed_files(text):
        records[name] = hashlib.sha256((HERE / name).read_bytes()).hexdigest()
    h = hashlib.sha256()
    for name in sorted(records):
        h.update(f"{name}\n{records[name]}\n".encode())
    return "sha256:" + h.hexdigest()


def main() -> int:
    text = MANIFEST.read_text()
    digest = compute(text)
    if "--write" in sys.argv:
        MANIFEST.write_text(HASH_LINE.sub(f'content_hash: "{digest}"', text))
    elif "--check" in sys.argv:
        m = re.search(r'^content_hash:\s*"?([^"\s]*)"?', text, re.M)
        ok = m and m.group(1) == digest
        print(("OK " if ok else "MISMATCH ") + digest)
        return 0 if ok else 1
    print(digest)
    return 0


if __name__ == "__main__":
    sys.exit(main())
