"""Wazir AI OS Nautilus Extension (nautilus-python).

Adds governed, local-first AI context actions to GNOME Files (Nautilus).
"""

import os
import subprocess
from gi.repository import GObject, Nautilus


class WazirNautilusExtension(GObject.GObject, Nautilus.MenuProvider):
    ACTIONS = [
        ("summarize", "Wazir: Summarize selected file"),
        ("explain", "Wazir: Explain source code"),
        ("compare", "Wazir: Compare files"),
        ("translate", "Wazir: Translate document"),
        ("extract", "Wazir: Extract structured data"),
        ("search", "Wazir: Search document contents"),
        ("duplicates", "Wazir: Identify duplicates"),
        ("task", "Wazir: Create Wazir task"),
        ("remote", "Wazir: Execute task remotely"),
    ]

    def _launch(self, _menu, action_id, files):
        paths = [f.get_location().get_path() for f in files if f.get_location() and f.get_location().get_path()]
        if not paths:
            return
        target = " ".join(f'"{p}"' for p in paths)
        prompt_map = {
            "summarize": f"? Summarize {target}",
            "explain": f"? Explain source code in {target}",
            "compare": f"? Compare {target}",
            "translate": f"? Translate {target}",
            "extract": f"? Extract structured data from {target}",
            "search": f"? Search contents in {target}",
            "duplicates": f"? Identify duplicates in {target}",
            "task": f"/goal Create task for {target}",
            "remote": f"/goal Execute remotely for {target}",
        }
        cmd = prompt_map.get(action_id, f"? Inspect {target}")
        subprocess.Popen(["wazir-shell", "-c", cmd], cwd=os.path.dirname(paths[0]) or os.path.expanduser("~"))

    def get_file_items(self, *args):
        files = args[-1] if args else []
        if not files:
            return []
        top = Nautilus.MenuItem(name="Wazir::Menu", label="Wazir AI", tip="Run governed Wazir actions")
        sub = Nautilus.Menu()
        top.set_submenu(sub)
        for action_id, label in self.ACTIONS:
            item = Nautilus.MenuItem(name=f"Wazir::{action_id}", label=label)
            item.connect("activate", self._launch, action_id, files)
            sub.append_item(item)
        return [top]
