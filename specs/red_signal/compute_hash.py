"""Compute / verify the RED_SIGNAL_COMPLIANCE manifest content_hash.

Mirrors computeSpecHash() in packages/assurance/src/registry.ts: parse the manifest
with the registry's restricted YAML subset, drop content_hash, and take
"sha256:" + sha256(canonical JSON with sorted keys). Comments and formatting are not
hashed, and neither are artifact file bytes (the assurance record pins those separately).

Usage: python compute_hash.py [--write | --check]
"""
import hashlib
import json
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
MANIFEST = HERE / "manifest.yaml"
HASH_LINE = re.compile(r'^content_hash:.*$', re.M)


def _split(s, delimiter):
    parts, start, depth, quote = [], 0, 0, ""
    for i, c in enumerate(s):
        if quote:
            if c == quote and s[i - 1] != "\\":
                quote = ""
        elif c in "\"'":
            quote = c
        elif c in "[{":
            depth += 1
        elif c in "]}":
            depth -= 1
        elif c == delimiter and not depth:
            parts.append(s[start:i])
            start = i + 1
    if quote or depth:
        raise ValueError("Malformed YAML flow collection")
    parts.append(s[start:])
    return parts


def _scalar(raw):
    s = raw.strip()
    if s.startswith("[") and s.endswith("]"):
        return [_scalar(x) for x in _split(s[1:-1], ",")] if s[1:-1].strip() else []
    if s.startswith("{") and s.endswith("}"):
        return dict(_pair(x) for x in _split(s[1:-1], ",") if x.strip())
    if s.startswith('"'):
        return json.loads(s)
    if s.startswith("'") and s.endswith("'"):
        return s[1:-1].replace("''", "'")
    if re.match(r"^[&*!>|%@`]", s) or " #" in s:
        raise ValueError("Unsupported YAML syntax; use JSON or quoted scalars")
    if s in ("null", "~"):
        return None
    if s in ("true", "false"):
        return s == "true"
    return s


def _pair(s):
    m = re.match(r"^([^:]+):(?:\s+|$)(.*)$", s.strip(), re.S)
    if not m:
        raise ValueError("Invalid YAML mapping")
    return m.group(1).strip(), _scalar(m.group(2))


def _indent(line):
    return len(line) - len(line.lstrip())


def parse(text):
    lines = [l for l in re.split(r"\r?\n", text)
             if l.strip() and not l.strip().startswith("#") and l.strip() != "---"]
    pos = 0

    def block(indent):
        nonlocal pos
        sequence = lines[pos].strip().startswith("- ")
        result = [] if sequence else {}
        while pos < len(lines):
            line = lines[pos]
            n = _indent(line)
            if n < indent:
                break
            if n != indent or "\t" in line:
                raise ValueError("Invalid YAML indentation")
            s = line.strip()
            pos += 1
            nested = pos < len(lines) and _indent(lines[pos]) > indent
            if sequence:
                if not s.startswith("- "):
                    raise ValueError("Mixed YAML collection")
                rest = s[2:]
                if re.match(r"^[^{}\[\]]+:\s", rest):
                    k, v = _pair(rest)
                    item = {k: v}
                    if nested:
                        item.update(block(_indent(lines[pos])))
                    result.append(item)
                else:
                    result.append(_scalar(rest))
            else:
                k, v = _pair(s)
                if k in result or k in ("__proto__", "constructor", "prototype"):
                    raise ValueError("Duplicate or unsafe YAML key")
                result[k] = block(_indent(lines[pos])) if v == "" and nested else v
        return result

    if not lines:
        raise ValueError("Empty manifest")
    return block(_indent(lines[0]))


def compute(text):
    content = {k: v for k, v in parse(text).items() if k != "content_hash"}
    canonical = json.dumps(content, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "sha256:" + hashlib.sha256(canonical.encode()).hexdigest()


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
