#!/usr/bin/env python3
"""
Generates an Apple ICNS file (AppIcon.icns) containing high-resolution
macOS app icons for Rook.
"""

import os
import sys
import struct
from io import BytesIO
from PIL import Image, ImageDraw, ImageFilter

def create_rook_icon(size):
    """Draws a modern macOS style icon for Rook at the given pixel size."""
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

    # Draw Rook (chess castle) emblem in center
    # Emblem dimensions:
    cx = size // 2
    cy = int(size * 0.51)
    scale = size / 512.0

    emblem = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    edraw = ImageDraw.Draw(emblem)

    # Castle coordinates relative to cx, cy scaled
    # Top battlements (crenellations)
    top_y = cy - int(120 * scale)
    wall_top = cy - int(70 * scale)
    neck_top = cy - int(45 * scale)
    neck_bot = cy + int(60 * scale)
    base_top = cy + int(60 * scale)
    base_bot = cy + int(115 * scale)

    # Base platform
    b_w = int(140 * scale)
    edraw.rounded_rectangle([cx - b_w, base_bot - int(25 * scale), cx + b_w, base_bot], radius=int(6 * scale), fill=(230, 237, 243, 255))
    edraw.polygon([
        (cx - int(120 * scale), base_top),
        (cx + int(120 * scale), base_top),
        (cx + b_w, base_bot - int(20 * scale)),
        (cx - b_w, base_bot - int(20 * scale))
    ], fill=(210, 222, 235, 255))

    # Waist / Tower Body
    tower_top_w = int(80 * scale)
    tower_bot_w = int(105 * scale)
    edraw.polygon([
        (cx - tower_top_w, neck_top),
        (cx + tower_top_w, neck_top),
        (cx + tower_bot_w, base_top),
        (cx - tower_bot_w, base_top)
    ], fill=(235, 242, 250, 255))

    # Center window / embrasure (cyan accent)
    win_w = int(18 * scale)
    win_h = int(45 * scale)
    win_y = cy - int(5 * scale)
    edraw.rounded_rectangle([cx - win_w, win_y - win_h // 2, cx + win_w, win_y + win_h // 2], radius=int(9 * scale), fill=(31, 111, 235, 255))

    # Neck collar
    collar_w = int(95 * scale)
    edraw.rounded_rectangle([cx - collar_w, wall_top, cx + collar_w, neck_top], radius=int(4 * scale), fill=(245, 248, 252, 255))

    # Battlements (crenels & merlons)
    b_top = top_y
    b_height = wall_top - top_y
    bat_w = int(110 * scale)
    # Background rectangle of battlement
    merlon_w = int(32 * scale)
    gap_w = int(22 * scale)

    # Draw 3 merlons
    # Left
    edraw.rounded_rectangle([cx - bat_w, b_top, cx - bat_w + merlon_w, wall_top], radius=int(4 * scale), fill=(255, 255, 255, 255))
    # Center
    edraw.rounded_rectangle([cx - merlon_w // 2, b_top, cx + merlon_w // 2, wall_top], radius=int(4 * scale), fill=(255, 255, 255, 255))
    # Right
    edraw.rounded_rectangle([cx + bat_w - merlon_w, b_top, cx + bat_w, wall_top], radius=int(4 * scale), fill=(255, 255, 255, 255))
    # Fill bar below crenels
    edraw.rectangle([cx - bat_w, b_top + int(b_height * 0.55), cx + bat_w, wall_top], fill=(255, 255, 255, 255))

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
        img = create_rook_icon(size)
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
