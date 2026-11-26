#!/usr/bin/env python3
"""Wazir GNOME Shell Search Provider (org.gnome.Shell.SearchProvider2).

Routes queries through `/usr/bin/wa route --json` so GNOME Shell stays
responsive and isolated even when AI backends are offline.
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
                ["wa", "route", "--json", query],
                capture_output=True,
                text=True,
                timeout=1.5,
            )
            if proc.returncode != 0 or not proc.stdout.strip():
                return []
            decision = json.loads(proc.stdout)
            mid = f"wazir:{hash(query) & 0xffffffff}"
            self._items[mid] = {
                "query": query,
                "tier": decision.get("tier", 0),
                "handler": decision.get("handler", "wa"),
                "reason": decision.get("reason", ""),
            }
            return [mid]
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
                "name": dbus.String(f"Wazir: {item['query']}"),
                "description": dbus.String(f"Tier {item['tier']} ({item['handler']}) — {item['reason']}"),
                "gicon": dbus.String("wazir-shell"),
            })
        return metas

    @dbus.service.method(IFACE, in_signature="sasu")
    def ActivateResult(self, identifier, _terms, _timestamp):
        item = self._items.get(identifier)
        if not item:
            return
        subprocess.Popen(["wazir-shell", "-c", item["query"]])

    @dbus.service.method(IFACE, in_signature="asu")
    def LaunchSearch(self, terms, _timestamp):
        query = " ".join(terms).strip()
        subprocess.Popen(["wazir-shell", "-c", query])


def main():
    DBusGMainLoop(set_as_default=True)
    WazirGnomeSearchProvider()
    GLib.MainLoop().run()


if __name__ == "__main__":
    main()
