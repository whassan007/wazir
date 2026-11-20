#!/usr/bin/env python3
"""Wazir OS GNOME Shell Search Provider (org.gnome.Shell.SearchProvider2).

Runs as an isolated user D-Bus service so GNOME Shell remains completely
unaffected if Wazir's AI backend or daemon is offline.
"""

import json
import subprocess
import dbus
import dbus.service
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib

BUS_NAME = "org.wazir.SearchProvider"
OBJ_PATH = "/org/wazir/SearchProvider"
IFACE = "org.gnome.Shell.SearchProvider2"


class WazirGnomeSearchProvider(dbus.service.Object):
    def __init__(self):
        bus_name = dbus.service.BusName(BUS_NAME, bus=dbus.SessionBus())
        super().__init__(bus_name, OBJ_PATH)
        self._items = {}

    @dbus.service.method(IFACE, in_signature="as", out_signature="as")
    def GetInitialResultSet(self, terms):
        query = " ".join(terms).strip()
        if not query:
            return []
        try:
            proc = subprocess.run(
                ["wazir-spotlight", "match", query],
                capture_output=True,
                text=True,
                timeout=1.5,
            )
            if proc.returncode != 0 or not proc.stdout.strip():
                return []
            matches = json.loads(proc.stdout)
            ids = []
            for item in matches[:8]:
                mid = item["id"]
                self._items[mid] = item
                ids.append(mid)
            return ids
        except Exception:
            return []

    @dbus.service.method(IFACE, in_signature="asas", out_signature="as")
    def GetSubsearchResultSet(self, _previous_results, terms):
        return self.GetInitialResultSet(terms)

    @dbus.service.method(IFACE, in_signature="as", out_signature="aa{sv}")
    def GetResultMetas(self, identifiers):
        metas = []
        for mid in identifiers:
            item = self._items.get(mid)
            if not item:
                continue
            metas.append({
                "id": dbus.String(mid),
                "name": dbus.String(item.get("text", mid)),
                "description": dbus.String(item.get("subtext", "")),
                "gicon": dbus.String(item.get("iconName", "wazir")),
            })
        return metas

    @dbus.service.method(IFACE, in_signature="sasu")
    def ActivateResult(self, identifier, _terms, _timestamp):
        item = self._items.get(identifier)
        if not item:
            return
        payload = item.get("actionPayload", {})
        kind = payload.get("kind", "noop")
        target = payload.get("target", "")
        if kind == "exec-terminal":
            subprocess.Popen(["gnome-terminal", "--", "bash", "-lc", f"{target}; exec bash"])
        elif kind in ("open-file", "open-url"):
            subprocess.Popen(["xdg-open", target])
        elif kind in ("dispatch-ai", "switch-engine"):
            subprocess.Popen(["wazir-spotlight", "run", json.dumps(item)])

    @dbus.service.method(IFACE, in_signature="asu")
    def LaunchSearch(self, terms, _timestamp):
        query = " ".join(terms).strip()
        subprocess.Popen(["gnome-terminal", "--", "wa", "shell", "-c", query])


def main():
    DBusGMainLoop(set_as_default=True)
    WazirGnomeSearchProvider()
    GLib.MainLoop().run()


if __name__ == "__main__":
    main()
