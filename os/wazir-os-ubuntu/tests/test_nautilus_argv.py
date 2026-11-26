import os
import subprocess
import unittest

from tests import _load

ext = _load.nautilus()

ADVERSARIAL = [
    'a"b.txt',
    "$(touch pwned).txt",
    "x\ny.txt",
    "résumé ملف \U0001F600.txt",
    "-c.txt",
    "--attach",
    "; rm -rf ~ #.txt",
    "it's `id`.txt",
]


class FakeLocation:
    def __init__(self, path):
        self._path = path

    def get_path(self):
        return self._path


class FakeFile:
    def __init__(self, path, has_location=True):
        self._loc = FakeLocation(path) if has_location else None

    def get_location(self):
        return self._loc


def parse_c1(argv):
    """Reference C1 parser: options consume the NEXT argv element verbatim."""
    assert argv[0] == "wazir-shell"
    out = {"cwd": None, "attach": [], "c": None}
    i = 1
    while i < len(argv):
        flag = argv[i]
        if flag not in ("--cwd", "--attach", "-c"):
            raise AssertionError(f"unexpected token {flag!r}")
        value = argv[i + 1]
        if flag == "--cwd":
            out["cwd"] = value
        elif flag == "--attach":
            out["attach"].append(value)
        else:
            out["c"] = value
        i += 2
    return out


class NautilusArgvTests(unittest.TestCase):
    def test_nine_actions_preserved(self):
        self.assertEqual(len(ext.ACTIONS), 9)
        self.assertEqual(len(ext.WazirNautilusExtension.ACTIONS), 9)
        self.assertEqual(
            [a for a, _ in ext.WazirNautilusExtension.ACTIONS],
            ["summarize", "explain", "compare", "translate", "extract",
             "search", "duplicates", "task", "remote"],
        )

    def test_adversarial_names_are_separate_argv_elements(self):
        base = "/home/u/Docs"
        for action_id, _label, text in ext.ACTIONS:
            for name in ADVERSARIAL:
                with self.subTest(action=action_id, name=name):
                    path = os.path.join(base, name)
                    argv, cwd = ext.build_argv(action_id, [path])
                    parsed = parse_c1(argv)
                    self.assertEqual(parsed["attach"], [path])
                    self.assertEqual(parsed["cwd"], base)
                    self.assertEqual(cwd, base)
                    # Prompt text is fixed and never contains the path.
                    self.assertEqual(parsed["c"], text)
                    self.assertNotIn(name, parsed["c"])
                    # Exact argv: the path appears once, only as the --attach value.
                    self.assertEqual(argv, ["wazir-shell", "--cwd", base, "--attach", path, "-c", text])
                    self.assertEqual(argv.count(path), 1)

    def test_leading_dash_is_never_a_flag(self):
        argv, _ = ext.build_argv("summarize", ["-c.txt"])
        attach = parse_c1(argv)["attach"]
        self.assertEqual(len(attach), 1)
        self.assertTrue(attach[0].startswith("/"))
        self.assertTrue(attach[0].endswith("/-c.txt"))
        # every option value that is a path is absolute
        for i, tok in enumerate(argv):
            if tok in ("--attach", "--cwd"):
                self.assertTrue(argv[i + 1].startswith("/"), argv)

    def test_multiple_files_order_preserved(self):
        paths = [f"/tmp/d/{n}" for n in ADVERSARIAL]
        argv, cwd = ext.build_argv("compare", paths)
        self.assertEqual(parse_c1(argv)["attach"], paths)
        self.assertEqual(argv.count("--attach"), len(paths))
        self.assertEqual(argv[-2:], ["-c", "? Compare the attached files"])

    def test_unknown_action_and_empty(self):
        self.assertIsNone(ext.build_argv("nope", ["/a"]))
        self.assertIsNone(ext.build_argv("summarize", []))
        self.assertIsNone(ext.build_argv("summarize", [None, ""]))

    def test_non_local_files_skipped(self):
        files = [FakeFile(None), FakeFile("/a/b.txt"), FakeFile("x", has_location=False),
                 FakeFile("/a/nul\x00.txt")]
        self.assertEqual(ext.local_paths(files), ["/a/b.txt"])
        self.assertIsNone(ext.launch("summarize", ext.local_paths([FakeFile(None)])))

    def test_launch_uses_argv_without_shell(self):
        calls = []

        def fake_popen(argv, **kw):
            calls.append((argv, kw))
            return "proc"

        path = "/tmp/$(touch pwned).txt"
        self.assertEqual(ext.launch("summarize", [path], popen=fake_popen), "proc")
        argv, kw = calls[0]
        self.assertIsInstance(argv, list)
        self.assertIs(kw.get("shell"), False)
        self.assertIn(path, argv)
        self.assertTrue(kw.get("start_new_session"))

    def test_launch_missing_binary_returns_none(self):
        def raising(*_a, **_k):
            raise FileNotFoundError("wazir-shell")

        self.assertIsNone(ext.launch("summarize", ["/tmp/a"], popen=raising))

    def test_real_exec_receives_exact_argv(self):
        """Exec a real process with the argv and verify it arrives byte-exact."""
        path = "/tmp/q/" + 'a"b $(touch pwned)\nx -c.txt é'
        argv, _ = ext.build_argv("summarize", [path])
        probe = ["python3", "-I", "-c",
                 "import sys,json;print(json.dumps(sys.argv[1:]))"] + argv[1:]
        out = subprocess.run(probe, capture_output=True, text=True, check=True).stdout
        import json
        self.assertEqual(json.loads(out), argv[1:])
        self.assertFalse(os.path.exists("pwned"))


if __name__ == "__main__":
    unittest.main()
