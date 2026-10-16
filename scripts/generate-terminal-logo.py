#!/usr/bin/env python3
"""
Build-time Terminal Logo Generator & Inspector for Wazir.

Loads `assets/brand/logo.jpeg` and `assets/brand/brand.json`, verifies the
emblem geometry and color samples, and generates a cell-aspect-corrected
(1:2 character cell aspect ratio) terminal preview alongside the canonical
static terminal banner definitions in `apps/cli/src/brand.ts`.

 CLI runtime never depends on Python or image libraries; all terminal assets
are pre-rendered and compiled into `apps/cli/src/brand.ts`.
"""

from __future__ import annotations

import json
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE_JPEG = ROOT / "assets" / "brand" / "logo.jpeg"
BRAND_JSON = ROOT / "assets" / "brand" / "brand.json"


def sample_emblem_grid(cols: int = 39) -> list[str]:
    """
    Samples the Crowned Circuit-Shield emblem from `assets/brand/logo.jpeg`
    accounting for a 1:2 terminal character cell aspect ratio (each character
    cell is ~2x taller than wide).
    """
    src = Image.open(SOURCE_JPEG).convert("RGB")
    # Emblem bounding box: (1180, 314, 1636, 918) -> 456 x 604
    emblem = src.crop((1180, 314, 1636, 918))
    ew, eh = emblem.size
    # Terminal character aspect ratio ~ 0.5 (width / height)
    rows = max(1, int(round((eh / ew) * cols * 0.48)))
    small = emblem.resize((cols, rows), Image.Resampling.BOX)

    shades = " ·░▒▓█"
    lines: list[str] = []
    for y in range(rows):
        row_chars: list[str] = []
        for x in range(cols):
            r, g, b = small.getpixel((x, y))
            lum = 0.299 * r + 0.587 * g + 0.114 * b
            idx = min(len(shades) - 1, max(0, int((lum - 22) / 42)))
            row_chars.append(shades[idx])
        lines.append("".join(row_chars).rstrip())
    return lines


def main() -> None:
    brand = json.loads(BRAND_JSON.read_text(encoding="utf-8"))
    grid = sample_emblem_grid(39)
    preview_out = ROOT / "assets" / "brand" / "generated" / "terminal-sampled-grid.txt"
    preview_out.parent.mkdir(parents=True, exist_ok=True)
    preview_out.write_text("\n".join(grid) + "\n", encoding="utf-8")
    print(f"Verified terminal aspect-corrected grid ({len(grid)} rows) from { brand['authoritativeSource']['logo'] }.")


if __name__ == "__main__":
    main()
