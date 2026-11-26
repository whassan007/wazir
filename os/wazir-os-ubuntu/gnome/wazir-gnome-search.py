#!/usr/bin/python3
"""Wazir GNOME Shell Search Provider (org.gnome.Shell.SearchProvider2).

Routes queries through `wa route --json <query>` so GNOME Shell stays
responsive and isolated even when AI backends are offline.

Hardening (v0.4.3):
* the query is a single argv element; no shell is ever used;
* queries are sanitised (control characters removed) and truncated to
  MAX_QUERY_CHARS;
* the routing subprocess has a hard timeout; any failure yields no results;
* at most MAX_RESULTS results are returned and the in-memory result cache is
  bounded;
* activation launches the shell via contract C1: `wazir-shell -c <query>`.

The pure logic is importable without dbus/PyGObject for unit tests.
"""

import hashlib
import json
import subprocess
from collections import OrderedDict

try:  # pragma: no cover - exercised only on a GNOME session
    import dbus
    import dbus.service
    from dbus.mainloop.glib import DBusGMainLoop
    from gi.repository import GLib

    _HAVE_DBUS = True
except ImportError:
    _HAVE_DBUS = False

BUS_NAME = "org.wazir.SearchProvider"
OBJ_PATH = "/org/wazir/SearchProvider"
IFACE = "org.gnome.Shell.SearchProvider2"

WA_BIN = "wa"
SHELL_BIN = "wazir-shell"
MAX_QUERY_CHARS = 512
MAX_RESULTS = 5
MAX_CACHE = 64
MAX_OUTPUT_CHARS = 64 * 1024
MAX_FIELD_CHARS = 200
ROUTE_TIMEOUT_S = 1.5


def normalize_query(terms):
    """Join GNOME search terms into a single sanitised, length-capped query."""
    if isinstance(terms, str):
        terms = [terms]
    try:
        joined = " ".join(str(t) for t in (terms or []))
    except Exception:
        return ""
    # Replace control characters (incl. NUL, newlines) with spaces, collapse runs.
    cleaned = "".join(ch if ch.isprintable() else " " for ch in joined)
    cleaned = " ".join(cleaned.split())
    return cleaned[:MAX_QUERY_CHARS].strip()


def build_route_argv(query):
    return [WA_BIN, "route", "--json", query]


def build_activate_argv(query):
    """Contract C1: wazir-shell -c <input>. Query is one argv element."""
    return [SHELL_BIN, "-c", query]


def result_id(query, index=0):
    base = "wazir:" + hashlib.sha256(query.encode("utf-8")).hexdigest()[:16]
    return base if index == 0 else f"{base}:{index}"


def _clip(value):
    return str(value if value is not None else "")[:MAX_FIELD_CHARS]


def route(query, runner=subprocess.run, timeout=ROUTE_TIMEOUT_S):
    """Run `wa route --json`; return a list (<= MAX_RESULTS) of result dicts.

    Never raises: any error, timeout, non-zero exit or malformed output -> [].
    """
    query = normalize_query(query)
    if not query:
        return []
    try:
        proc = runner(
            build_route_argv(query),
            capture_output=True,
            text=True,
            timeout=timeout,
            shell=False,
            stdin=subprocess.DEVNULL,
        )
        if proc.returncode != 0:
            return []
        out = (proc.stdout or "").strip()
        if not out or len(out) > MAX_OUTPUT_CHARS:
            return []
        decoded = json.loads(out)
    except Exception:
        return []
    decisions = decoded if isinstance(decoded, list) else [decoded]
    results = []
    for decision in decisions:
        if not isinstance(decision, dict):
            continue
        results.append({
            "id": result_id(query, len(results)),
            "query": query,
            "tier": _clip(decision.get("tier", 0)),
            "handler": _clip(decision.get("handler", "wa")),
            "reason": _clip(decision.get("reason", "")),
        })
        if len(results) >= MAX_RESULTS:
            break
    return results


class SearchCore:
    """Transport-independent provider state (testable without D-Bus)."""

    def __init__(self, runner=subprocess.run, popen=subprocess.Popen):
        self._runner = runner
        self._popen = popen
        self._items = OrderedDict()

    def initial(self, terms):
        results = route(terms, runner=self._runner)[:MAX_RESULTS]
        for item in results:
            self._items[item["id"]] = item
            self._items.move_to_end(item["id"])
        while len(self._items) > MAX_CACHE:
            self._items.popitem(last=False)
        return [item["id"] for item in results]

    def metas(self, identifiers):
        metas = []
        for mid in identifiers or []:
            item = self._items.get(mid)
            if not item:
                continue
            metas.append({
                "id": mid,
                "name": f"Wazir: {item['query']}",
                "description": f"Tier {item['tier']} ({item['handler']}) - {item['reason']}",
                "gicon": "wazir-shell",
            })
        return metas

    def _spawn(self, query):
        query = normalize_query(query)
        if not query:
            return None
        try:
            return self._popen(
                build_activate_argv(query),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                close_fds=True,
                start_new_session=True,
                shell=False,
            )
        except (OSError, ValueError):
            return None

    def activate(self, identifier):
        item = self._items.get(identifier)
        if not item:
            return None
        return self._spawn(item["query"])

    def launch_search(self, terms):
        return self._spawn(terms)


if _HAVE_DBUS:  # pragma: no cover

    class WazirGnomeSearchProvider(dbus.service.Object):
        def __init__(self):
            bus_name = dbus.service.BusName(BUS_NAME, bus=dbus.SessionBus())
            super().__init__(bus_name, OBJ_PATH)
            self._core = SearchCore()

        @dbus.service.method(IFACE, in_signature="as", out_signature="as")
        def GetInitialResultSet(self, terms):
            try:
                return self._core.initial([str(t) for t in terms])
            except Exception:
                return []

        @dbus.service.method(IFACE, in_signature="asas", out_signature="as")
        def GetSubsearchResultSet(self, _previous_results, terms):
            return self.GetInitialResultSet(terms)

        @dbus.service.method(IFACE, in_signature="as", out_signature="aa{sv}")
        def GetResultMetas(self, identifiers):
            try:
                metas = self._core.metas([str(i) for i in identifiers])
            except Exception:
                return []
            return [{k: dbus.String(v) for k, v in m.items()} for m in metas]

        @dbus.service.method(IFACE, in_signature="sasu")
        def ActivateResult(self, identifier, _terms, _timestamp):
            try:
                self._core.activate(str(identifier))
            except Exception:
                pass

        @dbus.service.method(IFACE, in_signature="asu")
        def LaunchSearch(self, terms, _timestamp):
            try:
                self._core.launch_search([str(t) for t in terms])
            except Exception:
                pass


def main():
    if not _HAVE_DBUS:
        raise SystemExit("wazir-gnome-search: python3-dbus and python3-gi are required")
    DBusGMainLoop(set_as_default=True)
    WazirGnomeSearchProvider()
    GLib.MainLoop().run()


if __name__ == "__main__":
    main()
