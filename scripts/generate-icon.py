#!/usr/bin/env python3
"""
Generates Wazir.app's macOS AppIcon.icns and all cross-platform icon variants
directly from the authoritative `assets/brand/logo.jpeg` via the canonical
brand asset pipeline (`scripts/generate-brand-assets.py`).
"""

from pathlib import Path
import runpy


def main() -> None:
    pipeline = Path(__file__).resolve().parent / "generate-brand-assets.py"
    runpy.run_path(str(pipeline), run_name="__main__")


if __name__ == "__main__":
    main()
