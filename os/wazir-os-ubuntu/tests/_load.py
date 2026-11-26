"""Load the extension modules by file path (works under `python3 -I`)."""

import importlib.util
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(name, relpath):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, relpath))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def nautilus():
    return load("wazir_nautilus_extension", "nautilus/wazir_nautilus_extension.py")


def search():
    return load("wazir_gnome_search", "gnome/wazir-gnome-search.py")
