"""No-dependency static validation for four portable Wazir skill documents.

Works against any of the supported layouts:

  skills/formal/<name>/SKILL.md                                  (Wazir repo, default)
  skills/formal/wazir-formal-assurance-skills/skills/<name>/     (upstream bundle layout)
  .claude/skills/wazir-<name>/SKILL.md                           (Claude Code registration)

Usage:
  python skills/formal/scripts/validate_skills.py [--root DIR] [--check-mirror DIR]

--root defaults to the directory above this script. --check-mirror additionally
asserts that every file in DIR (e.g. .claude/skills) is byte-identical to its
skills/formal source, so the two copies cannot drift silently.
"""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXPECTED = {
    "z3": "P0", "dafny": "P1", "scenic": "P0", "verifai": "P0"
}
# .claude/skills/<dir> -> skills/formal/<dir>
MIRROR = {
    "alloy-formal-modeling": "alloy", "gam": "gam",
    "wazir-z3": "z3", "wazir-dafny": "dafny",
    "wazir-scenic": "scenic", "wazir-verifai": "verifai",
}


def skill_path(root, name):
    for candidate in (root / name, root / "skills" / name, root / f"wazir-{name}"):
        if (candidate / "SKILL.md").is_file():
            return candidate / "SKILL.md"
    raise AssertionError(f"{root}: no SKILL.md found for {name}")


def check_skills(root):
    for name, priority in EXPECTED.items():
        path = skill_path(root, name)
        content = path.read_text(encoding="utf-8")
        assert content.startswith("---\n"), f"{path}: missing frontmatter"
        frontmatter, body = content.split("---\n", 2)[1:]
        fields = {}
        for line in frontmatter.splitlines():
            if ":" in line:
                key, value = line.split(":", 1)
                fields[key.strip()] = value.strip()
        for key in ("name", "description", "priority", "version"):
            assert fields.get(key), f"{path}: missing {key}"
        assert fields["priority"] == priority, f"{path}: incorrect priority"
        assert "## " in body, f"{path}: no sections"
        assert "## References" in body, f"{path}: missing sources"
        for reference in ("examples", "workflow", "evidence"):
            assert reference in body.lower(), f"{path}: missing {reference}"
        print(f"OK {name} ({priority})")
    schema = json.loads((root / "evidence.schema.json").read_text())
    assert schema["title"] == "Wazir Formal Assurance Result"
    print("OK evidence.schema.json")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check_mirror(mirror, source):
    pairs = [(mirror / "evidence.schema.json", source / "evidence.schema.json")]
    for mirrored, short in MIRROR.items():
        src_dir, dst_dir = source / short, mirror / mirrored
        assert dst_dir.is_dir(), f"{dst_dir}: missing"
        src_files = {p.relative_to(src_dir) for p in src_dir.rglob("*") if p.is_file()}
        dst_files = {p.relative_to(dst_dir) for p in dst_dir.rglob("*") if p.is_file()}
        assert src_files == dst_files, f"{dst_dir}: file set differs ({sorted(map(str, src_files ^ dst_files))})"
        pairs += [(dst_dir / rel, src_dir / rel) for rel in sorted(src_files)]
    for dst, src in pairs:
        assert digest(dst) == digest(src), f"{dst}: differs from {src}"
    print(f"OK mirror {mirror} ({len(pairs)} files match {source})")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--check-mirror", type=Path)
    args = parser.parse_args()
    check_skills(args.root.resolve())
    if args.check_mirror:
        check_mirror(args.check_mirror.resolve(), ROOT)


if __name__ == "__main__":
    main()
