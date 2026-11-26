"""Wazir AI OS Nautilus Extension (nautilus-python).

Adds governed, local-first AI context actions to GNOME Files (Nautilus).

Security model (v0.4.3, contract C1):
  wazir-shell [--cwd <dir>] [--attach <path>]... [-c <input>]

* File paths are NEVER interpolated into the prompt text. Each selected path is
  passed as its own argv element after ``--attach``; the ``-c`` input is a fixed,
  action-specific string.
* No shell is involved (``subprocess.Popen`` with an argv list, ``shell=False``).
* Paths are normalised to absolute paths, so an attached path always begins with
  ``/`` and can never be mistaken for an option (e.g. a file named ``-c.txt``
  is attached as ``/dir/-c.txt``).
* Non-local files (``get_path()`` returns ``None``: sftp://, trash://, etc.) are
  skipped.

The pure argv-building logic lives in module-level functions so it can be unit
tested without Nautilus or PyGObject installed.
"""

import os
import subprocess

try:  # pragma: no cover - exercised only inside Nautilus
    import gi

    try:
        gi.require_version("Nautilus", "4.0")
    except ValueError:
        gi.require_version("Nautilus", "3.0")
    from gi.repository import GObject, Nautilus

    _HAVE_NAUTILUS = True
except (ImportError, ValueError):
    _HAVE_NAUTILUS = False

    class _StubGObject:  # minimal stand-ins so the module imports in tests
        class GObject:
            pass

    class _StubNautilus:
        class MenuProvider:
            pass

    GObject = _StubGObject  # type: ignore[assignment]
    Nautilus = _StubNautilus  # type: ignore[assignment]


SHELL_BIN = "wazir-shell"

# (action_id, menu label, fixed -c input). Inputs never contain file names.
ACTIONS = [
    ("summarize", "Wazir: Summarize selected file", "? Summarize the attached files"),
    ("explain", "Wazir: Explain source code", "? Explain the source code in the attached files"),
    ("compare", "Wazir: Compare files", "? Compare the attached files"),
    ("translate", "Wazir: Translate document", "? Translate the attached documents"),
    ("extract", "Wazir: Extract structured data", "? Extract structured data from the attached files"),
    ("search", "Wazir: Search document contents", "? Search the contents of the attached files"),
    ("duplicates", "Wazir: Identify duplicates", "? Identify duplicates among the attached files"),
    ("task", "Wazir: Create Wazir task", "/goal Create a task for the attached files"),
    ("remote", "Wazir: Execute task remotely", "/goal Execute remotely for the attached files"),
]
ACTION_INPUTS = {action_id: text for action_id, _label, text in ACTIONS}


def local_paths(files):
    """Return absolute local paths for Nautilus FileInfo objects; skip non-local files."""
    paths = []
    for f in files or []:
        try:
            location = f.get_location()
            path = location.get_path() if location is not None else None
        except Exception:
            continue
        if not path or "\x00" in path:
            continue
        paths.append(os.path.abspath(path))
    return paths


def build_argv(action_id, paths, home=None):
    """Build (argv, cwd) for an action and a list of local paths.

    Returns ``None`` if there is nothing to launch (unknown action or no paths).
    """
    text = ACTION_INPUTS.get(action_id)
    if text is None:
        return None
    abs_paths = [os.path.abspath(p) for p in (paths or []) if p and "\x00" not in p]
    if not abs_paths:
        return None
    cwd = os.path.dirname(abs_paths[0]) or home or os.path.expanduser("~")
    argv = [SHELL_BIN, "--cwd", cwd]
    for p in abs_paths:
        argv.extend(["--attach", p])
    argv.extend(["-c", text])
    return argv, cwd


def launch(action_id, paths, popen=subprocess.Popen):
    """Spawn wazir-shell for the action. Returns the Popen object or None."""
    built = build_argv(action_id, paths)
    if built is None:
        return None
    argv, cwd = built
    try:
        return popen(
            argv,
            cwd=cwd if os.path.isdir(cwd) else None,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            start_new_session=True,
            shell=False,
        )
    except (OSError, ValueError):
        return None


class WazirNautilusExtension(GObject.GObject, Nautilus.MenuProvider):
    ACTIONS = [(action_id, label) for action_id, label, _text in ACTIONS]

    def _launch(self, _menu, action_id, files):
        launch(action_id, local_paths(files))

    def get_file_items(self, *args):
        # Nautilus 4: get_file_items(files); Nautilus 3: get_file_items(window, files)
        files = args[-1] if args else []
        if not files or not _HAVE_NAUTILUS:
            return []
        top = Nautilus.MenuItem(name="Wazir::Menu", label="Wazir AI", tip="Run governed Wazir actions")
        sub = Nautilus.Menu()
        top.set_submenu(sub)
        for action_id, label in self.ACTIONS:
            item = Nautilus.MenuItem(name=f"Wazir::{action_id}", label=label)
            item.connect("activate", self._launch, action_id, files)
            sub.append_item(item)
        return [top]
