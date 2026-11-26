import json
import subprocess
import unittest

from tests import _load

sp = _load.search()


class Proc:
    def __init__(self, stdout="", returncode=0):
        self.stdout = stdout
        self.returncode = returncode


class RecordingRunner:
    def __init__(self, result=None, exc=None):
        self.calls = []
        self.result = result
        self.exc = exc

    def __call__(self, argv, **kw):
        self.calls.append((argv, kw))
        if self.exc:
            raise self.exc
        return self.result


class SearchProviderTests(unittest.TestCase):
    def test_query_truncated_to_512(self):
        q = sp.normalize_query(["a" * 5000])
        self.assertEqual(len(q), 512)
        self.assertEqual(sp.MAX_QUERY_CHARS, 512)

    def test_control_chars_removed(self):
        self.assertEqual(sp.normalize_query(["a\nb", "c\x00d", "\t e"]), "a b c d e")
        self.assertEqual(sp.normalize_query([]), "")
        self.assertEqual(sp.normalize_query(None), "")

    def test_route_argv_query_single_element_no_shell_with_timeout(self):
        r = RecordingRunner(Proc(json.dumps({"tier": 1, "handler": "h", "reason": "r"})))
        q = '$(touch pwned); "x" -c --json'
        res = sp.route(q, runner=r)
        argv, kw = r.calls[0]
        self.assertEqual(argv, ["wa", "route", "--json", q])
        self.assertIs(kw["shell"], False)
        self.assertGreater(kw["timeout"], 0)
        self.assertLessEqual(kw["timeout"], 2)
        self.assertEqual(len(res), 1)
        self.assertEqual(res[0]["query"], q)

    def test_huge_query_truncated_before_subprocess(self):
        r = RecordingRunner(Proc("{}"))
        sp.route("x" * 100000, runner=r)
        self.assertEqual(len(r.calls[0][0][3]), 512)

    def test_timeout_returns_empty(self):
        r = RecordingRunner(exc=subprocess.TimeoutExpired(["wa"], 1.5))
        self.assertEqual(sp.route("hello", runner=r), [])

    def test_real_timeout_with_sleeping_process(self):
        def runner(argv, **kw):
            return subprocess.run(["sleep", "5"], **kw)
        self.assertEqual(sp.route("hello", runner=runner, timeout=0.2), [])

    def test_failures_return_empty(self):
        cases = [
            RecordingRunner(exc=FileNotFoundError("wa")),
            RecordingRunner(exc=OSError("boom")),
            RecordingRunner(Proc("", 0)),
            RecordingRunner(Proc("{}", 1)),
            RecordingRunner(Proc("not json", 0)),
            RecordingRunner(Proc("[1,2,3]", 0)),
            RecordingRunner(Proc("x" * (sp.MAX_OUTPUT_CHARS + 1), 0)),
        ]
        for r in cases:
            with self.subTest(r=r.result or r.exc):
                self.assertEqual(sp.route("hello", runner=r), [])
        self.assertEqual(sp.route("   ", runner=RecordingRunner(Proc("{}"))), [])

    def test_results_capped(self):
        many = json.dumps([{"tier": i} for i in range(50)])
        core = sp.SearchCore(runner=RecordingRunner(Proc(many)))
        ids = core.initial(["hello"])
        self.assertLessEqual(len(ids), sp.MAX_RESULTS)
        self.assertEqual(len(ids), 5)
        self.assertEqual(len(set(ids)), 5)
        self.assertEqual(len(core.metas(ids)), 5)

    def test_cache_bounded(self):
        core = sp.SearchCore(runner=RecordingRunner(Proc("{}")))
        for i in range(sp.MAX_CACHE * 3):
            core.initial([f"q{i}"])
        self.assertLessEqual(len(core._items), sp.MAX_CACHE)

    def test_activation_uses_c1(self):
        launched = []
        core = sp.SearchCore(runner=RecordingRunner(Proc("{}")),
                             popen=lambda argv, **kw: launched.append((argv, kw)) or "p")
        q = '-c "$(id)"'
        (mid,) = core.initial([q])
        self.assertEqual(core.activate(mid), "p")
        self.assertEqual(launched[0][0], ["wazir-shell", "-c", q])
        self.assertIs(launched[0][1]["shell"], False)
        self.assertIsNone(core.activate("wazir:unknown"))
        core.launch_search(["a" * 2000])
        self.assertEqual(launched[1][0][:2], ["wazir-shell", "-c"])
        self.assertEqual(len(launched[1][0][2]), 512)

    def test_activation_missing_binary_is_silent(self):
        def raising(*_a, **_k):
            raise FileNotFoundError("wazir-shell")
        core = sp.SearchCore(popen=raising)
        self.assertIsNone(core.launch_search(["hi"]))


class ConfigConsistencyTests(unittest.TestCase):
    def _read(self, rel):
        import os
        with open(os.path.join(_load.ROOT, rel), encoding="utf-8") as fh:
            return fh.read()

    def _kv(self, text):
        out = {}
        for line in text.splitlines():
            if "=" in line and not line.startswith(("#", "[")):
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip()
        return out

    def test_bus_name_object_path_and_exec_consistent(self):
        ini = self._kv(self._read("gnome/org.wazir.SearchProvider.ini"))
        dbus_svc = self._kv(self._read("gnome/org.wazir.SearchProvider.service"))
        unit = self._kv(self._read("gnome/wazir-gnome-search.service"))
        self.assertEqual(ini["BusName"], sp.BUS_NAME)
        self.assertEqual(ini["ObjectPath"], sp.OBJ_PATH)
        self.assertEqual(ini["Version"], "2")
        self.assertEqual(dbus_svc["Name"], sp.BUS_NAME)
        self.assertEqual(unit["BusName"], sp.BUS_NAME)
        self.assertEqual(unit["Type"], "dbus")
        # build-deb.mjs installs the script at usr/libexec/wazir-gnome-search.py
        self.assertEqual(dbus_svc["Exec"], "/usr/libexec/wazir-gnome-search.py")
        self.assertEqual(unit["ExecStart"], "/usr/libexec/wazir-gnome-search.py")
        self.assertEqual(dbus_svc["SystemdService"], "wazir-gnome-search.service")
        self.assertEqual(ini["DesktopId"], "wazir-shell.desktop")

    def test_build_deb_install_paths_match(self):
        import os
        build = os.path.join(os.path.dirname(os.path.dirname(_load.ROOT)), "scripts", "build-deb.mjs")
        if not os.path.exists(build):
            self.skipTest("scripts/build-deb.mjs not available (subtree-only checkout)")
        with open(build, encoding="utf-8") as fh:
            src = fh.read()
        self.assertIn("'usr/libexec/wazir-gnome-search.py'", src)
        self.assertIn("usr/share/dbus-1/services/org.wazir.SearchProvider.service", src)
        self.assertIn("usr/lib/systemd/user/wazir-gnome-search.service", src)
        self.assertIn("usr/share/gnome-shell/search-providers/org.wazir.SearchProvider.ini", src)
        self.assertIn("usr/share/nautilus-python/extensions/wazir_nautilus_extension.py", src)


if __name__ == "__main__":
    unittest.main()
