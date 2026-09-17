#!/usr/bin/env python3
"""
Generates an Apple ICNS file (AppIcon.icns) containing high-resolution
macOS app icons for Wazir.
"""

import os
import sys
import struct
from io import BytesIO
from PIL import Image, ImageDraw, ImageFilter

def create_icon(size):
    """Draws a modern macOS style icon for Wazir at the given pixel size."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Base padding
    pad = int(size * 0.08)
    box = [pad, pad, size - pad, size - pad]
    radius = int(size * 0.22)  # macOS squircle radius

    # Background squircle: deep navy/slate gradient
    bg = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bg_draw = ImageDraw.Draw(bg)
    
    # Create squircle mask
    mask = Image.new("L", (size, size), 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rounded_rectangle(box, radius=radius, fill=255)

    # Vertical gradient for background
    for y in range(size):
        ratio = y / size
        # From #161b22 (22, 27, 34) down to #090d13 (9, 13, 19)
        r = int(24 * (1 - ratio) + 10 * ratio)
        g = int(32 * (1 - ratio) + 14 * ratio)
        b = int(47 * (1 - ratio) + 24 * ratio)
        bg_draw.line([(0, y), (size, y)], fill=(r, g, b, 255))
    
    img.paste(bg, (0, 0), mask)

    # Outer border / subtle blue glow
    border_draw = ImageDraw.Draw(img)
    border_draw.rounded_rectangle(box, radius=radius, outline=(88, 166, 255, 120), width=max(1, int(size * 0.015)))

    # Draw a bold "W" monogram in center, representing Wazir.
    cx = size // 2
    cy = int(size * 0.51)
    scale = size / 512.0

    emblem = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    edraw = ImageDraw.Draw(emblem)

    w_half = int(150 * scale)
    w_top = cy - int(110 * scale)
    w_bot = cy + int(110 * scale)
    w_mid = cy + int(40 * scale)
    stroke = max(2, int(34 * scale))

    points = [
        (cx - w_half, w_top),
        (cx - w_half // 2, w_bot),
        (cx, w_mid),
        (cx + w_half // 2, w_bot),
        (cx + w_half, w_top),
    ]
    edraw.line(points, fill=(235, 242, 250, 255), width=stroke, joint="curve")

    # Round off the stroke's open end caps (joint="curve" only rounds interior joints).
    cap_r = stroke // 2
    for (px, py) in (points[0], points[-1]):
        edraw.ellipse([px - cap_r, py - cap_r, px + cap_r, py + cap_r], fill=(235, 242, 250, 255))

    # Paste emblem onto base
    img.alpha_composite(emblem)

    # Subtle cyan accent circle at bottom corner
    dot_r = int(size * 0.04)
    dot_cx = size - pad - int(size * 0.12)
    dot_cy = size - pad - int(size * 0.12)
    dot_draw = ImageDraw.Draw(img)
    dot_draw.ellipse([dot_cx - dot_r, dot_cy - dot_r, dot_cx + dot_r, dot_cy + dot_r], fill=(63, 185, 80, 255), outline=(255, 255, 255, 200), width=max(1, int(size * 0.01)))

    return img

def make_icns_file(out_path):
    """Generates an Apple ICNS containing standard icon sizes."""
    sizes = [
        (b'ic07', 128),
        (b'ic08', 256),
        (b'ic09', 512),
        (b'ic10', 1024),
    ]

    chunks = []
    for tag, size in sizes:
        img = create_icon(size)
        buf = BytesIO()
        img.save(buf, format="PNG")
        png_bytes = buf.getvalue()
        chunk_len = 8 + len(png_bytes)
        chunks.append(tag + struct.pack(">I", chunk_len) + png_bytes)

    total_len = 8 + sum(len(c) for c in chunks)
    header = b'icns' + struct.pack(">I", total_len)

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "wb") as f:
        f.write(header + b"".join(chunks))

    print(f"Generated ICNS icon: {out_path} ({total_len} bytes)")

if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "scripts/AppIcon.icns"
    make_icns_file(out)
