#!/usr/bin/env python3
"""Wazir Spotlight KRunner D-Bus provider (org.kde.krunner1).

Delegates matching and execution to @wazir/spotlight (`wazir-spotlight`),
keeping KRunner isolated from any AI or network failures.
"""

import json
import shlex
import subprocess
import dbus
import dbus.service
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib

BUS_NAME = "org.wazir.Spotlight"
OBJ_PATH = "/WazirSpotlight"
IFACE = "org.kde.krunner1"


class WazirSpotlightRunner(dbus.service.Object):
    def __init__(self):
        bus_name = dbus.service.BusName(BUS_NAME, bus=dbus.SessionBus())
        super().__init__(bus_name, OBJ_PATH)
        self._cache = {}

    @dbus.service.method(IFACE, in_signature="s", out_signature="a(sssida{sv})")
    def Match(self, query: str):
        try:
            proc = subprocess.run(
                ["wazir-spotlight", "match", query],
                capture_output=True,
                text=True,
                timeout=1.8,
            )
            if proc.returncode != 0 or not proc.stdout.strip():
                return []
            items = json.loads(proc.stdout)
            results = []
            for item in items:
                mid = item["id"]
                self._cache[mid] = item
                results.append((
                    mid,
                    item["text"],
                    item.get("iconName", "wazir"),
                    100 if item.get("relevance", 0.5) >= 0.85 else 50,
                    float(item.get("relevance", 0.7)),
                    {"subtext": item.get("subtext", "")},
                ))
            return results
        except Exception:
            return []

    @dbus.service.method(IFACE, in_signature="ss")
    def Run(self, match_id: str, action_id: str):
        item = self._cache.get(match_id)
        if not item:
            return
        payload = item.get("actionPayload", {})
        kind = payload.get("kind", "noop")
        target = payload.get("target", "")

        if kind == "exec-terminal":
            quoted = shlex.quote(target)
            subprocess.Popen(["konsole", "--profile", "Wazir", "-e", "zsh", "-lc", f"eval {quoted}; exec zsh"])
        elif kind == "open-file":
            subprocess.Popen(["xdg-open", target])
        elif kind == "open-url":
            subprocess.Popen(["xdg-open", target])
        elif kind in ("dispatch-ai", "switch-engine"):
            subprocess.Popen(["wazir-spotlight", "run", json.dumps(item)])


def main():
    DBusGMainLoop(set_as_default=True)
    WazirSpotlightRunner()
    GLib.MainLoop().run()


if __name__ == "__main__":
    main()
