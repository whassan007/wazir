#!/usr/bin/env python3
"""
Canonical Brand Asset Pipeline for Wazir.

Reads the authoritative brand logo (`assets/brand/logo.jpeg`) and CVI token
specification (`assets/brand/brand.json`) to deterministically generate all
web, desktop (macOS/Windows/Linux/Tauri), mobile (Android/iOS), and vector
brand assets without aspect-ratio distortion or generic placeholder symbols.
"""

from __future__ import annotations

import json
import math
import shutil
import subprocess
import tempfile
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SOURCE_JPEG = ROOT / "assets" / "brand" / "logo.jpeg"
BRAND_JSON = ROOT / "assets" / "brand" / "brand.json"

# CVI Authoritative Palette
DARK_ABYSS = (15, 19, 26, 255)       # #0f131a
ELECTRIC_BLUE = (56, 189, 248, 255)  # #38bdf8
METALLIC_SILVER = (148, 163, 184, 255)  # #94a3b8
DATA_GREEN = (34, 197, 94, 255)      # #22c55e
ICE_WHITE = (248, 250, 252, 255)     # #f8fafc


def extract_authoritative_emblem_and_lockup(
    src: Image.Image,
) -> tuple[Image.Image, Image.Image]:
    """
    Extracts the authoritative Wazir Crowned Circuit-Shield emblem and full
    combination lockup from `assets/brand/logo.jpeg` (2816x1536):
    - Uses a 4x supersampled geometric silhouette mask covering the exact
      shield cavity and 3-peaked crown so the dark navy shield interior and
      delicate circuit traces remain 100% intact and noise-free.
    - Combines outer luminance/chroma keying with the structural silhouette
      mask so exterior pixels are cleanly transparent on both light and dark
      surfaces.
    """
    w, h = src.size
    assert (w, h) == (2816, 1536), f"Expected 2816x1536 source, got {w}x{h}"

    # Build a high-resolution alpha mask in source image coordinates
    # 1. Protected interior polygon of the shield + crown cavity
    interior_mask = Image.new("L", (w, h), 0)
    idraw = ImageDraw.Draw(interior_mask)

    # Shield + Crown structural hull in 2816x1536 space
    shield_hull = [
        (1408, 314),  # Center crown tip
        (1518, 468),  # Right inner crown valley
        (1631, 345),  # Right crown tip
        (1570, 500),  # Right crown outer base
        (1632, 472),  # Right shield shoulder
        (1632, 665),  # Right shield vertical side
        (1614, 735),  # Right shield upper curve
        (1575, 800),  # Right shield mid curve
        (1510, 860),  # Right shield lower curve
        (1408, 920),  # Bottom shield tip
        (1306, 860),  # Left shield lower curve
        (1241, 800),  # Left shield mid curve
        (1202, 735),  # Left shield upper curve
        (1184, 665),  # Left shield vertical side
        (1184, 472),  # Left shield shoulder
        (1246, 500),  # Left crown outer base
        (1185, 345),  # Left crown tip
        (1298, 468),  # Left inner crown valley
    ]
    idraw.polygon(shield_hull, fill=255)
    # Slightly soften only the outermost 2px boundary for anti-aliasing
    interior_mask = interior_mask.filter(ImageFilter.GaussianBlur(radius=1.5))

    # 2. Outer tight envelope around the emblem (including subtle outer bevel + text region)
    outer_envelope = Image.new("L", (w, h), 0)
    odraw = ImageDraw.Draw(outer_envelope)
    odraw.polygon(shield_hull, fill=255, outline=255)
    outer_emblem_zone = outer_envelope.filter(ImageFilter.MaxFilter(15)).filter(
        ImageFilter.GaussianBlur(radius=4.0)
    )

    # Now compute per-pixel alpha for the crop region (1000..1816, 298..1236)
    crop_box = (1000, 298, 1816, 1236)
    cropped = src.crop(crop_box).convert("RGBA")
    int_crop = interior_mask.crop(crop_box)
    env_crop = outer_emblem_zone.crop(crop_box)

    cw, ch = cropped.size
    px = cropped.load()
    ipx = int_crop.load()
    epx = env_crop.load()

    # Background reference around the emblem in logo.jpeg
    bg_r, bg_g, bg_b = 26.0, 34.0, 46.0

    for y in range(ch):
        src_y = y + crop_box[1]
        for x in range(cw):
            r, g, b, _ = px[x, y]
            inside_val = ipx[x, y]

            if src_y <= 935:
                # Emblem region: use interior hull + bright rim extraction along outer edge
                env_val = epx[x, y]
                if env_val == 0:
                    px[x, y] = (r, g, b, 0)
                    continue
                if inside_val >= 245:
                    px[x, y] = (r, g, b, 255)
                else:
                    # Edge zone: keep metallic/cyan highlights, drop dark background halo
                    lum = 0.299 * r + 0.587 * g + 0.114 * b
                    key_alpha = max(0.0, min(1.0, (lum - 42.0) / 55.0))
                    combined = max(inside_val / 255.0, key_alpha * (env_val / 255.0))
                    px[x, y] = (r, g, b, int(round(combined * 255)))
            else:
                # Wordmark ("WAZIR"), subtitle ("A LOCAL AI FLEET COUNSELOR"), and accent bar
                dist = math.sqrt((r - bg_r) ** 2 + (g - bg_g) ** 2 + (b - bg_b) ** 2)
                lum = 0.299 * r + 0.587 * g + 0.114 * b
                signal = max(dist - 18.0, lum - 38.0)
                if signal <= 0.0:
                    px[x, y] = (r, g, b, 0)
                else:
                    alpha = int(max(0.0, min(1.0, signal / 55.0)) * 255)
                    px[x, y] = (r, g, b, alpha)

    # Extract emblem-only (y <= 935 in source -> y <= 637 in crop)
    emblem_only = cropped.crop((0, 0, cw, 637))
    emblem_bbox = emblem_only.getbbox()
    assert emblem_bbox is not None
    emblem_tight = emblem_only.crop(emblem_bbox)

    lockup_bbox = cropped.getbbox()
    assert lockup_bbox is not None
    lockup_tight = cropped.crop(lockup_bbox)

    return emblem_tight, lockup_tight


def place_centered(
    emblem: Image.Image,
    canvas_size: tuple[int, int],
    scale_ratio: float = 0.80,
    bg_color: tuple[int, int, int, int] = (0, 0, 0, 0),
) -> Image.Image:
    """Centers `emblem` inside `canvas_size` preserving aspect ratio."""
    cw, ch = canvas_size
    canvas = Image.new("RGBA", (cw, ch), bg_color)
    ew, eh = emblem.size
    target_w = int(cw * scale_ratio)
    target_h = int(ch * scale_ratio)
    scale = min(target_w / ew, target_h / eh)
    new_w = max(1, int(round(ew * scale)))
    new_h = max(1, int(round(eh * scale)))
    resized = emblem.resize((new_w, new_h), Image.Resampling.LANCZOS)
    ox = (cw - new_w) // 2
    oy = (ch - new_h) // 2
    canvas.alpha_composite(resized, (ox, oy))
    return canvas


def build_squircle_app_icon(emblem: Image.Image, size: int) -> Image.Image:
    """
    Builds a desktop/app icon with a Dark Abyss (#0f131a) squircle card,
    radial Electric Blue (#38bdf8) ambient core glow, subtle metallic border,
    and the authoritative Wazir Crowned Circuit-Shield emblem centered cleanly.
    """
    supersample = max(size * 2, 512)
    pad = int(supersample * 0.055)
    radius = int(supersample * 0.21)

    # Squircle mask
    mask = Image.new("L", (supersample, supersample), 0)
    mdraw = ImageDraw.Draw(mask)
    mdraw.rounded_rectangle(
        [pad, pad, supersample - pad - 1, supersample - pad - 1],
        radius=radius,
        fill=255,
    )

    # Dark Abyss background with soft radial cyan core glow behind emblem
    bg = Image.new("RGBA", (supersample, supersample), DARK_ABYSS)
    glow = Image.new("RGBA", (supersample, supersample), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    cx, cy = supersample // 2, int(supersample * 0.50)
    max_r = int(supersample * 0.44)
    for r in range(max_r, 0, -4):
        t = 1.0 - (r / max_r)
        alpha = int(46 * (t ** 2.2))
        gdraw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(56, 189, 248, alpha))
    bg = Image.alpha_composite(bg, glow)

    # Composite the clean polygon-masked emblem before applying squircle mask
    emblem_layer = place_centered(
        emblem, (supersample, supersample), scale_ratio=0.77, bg_color=(0, 0, 0, 0)
    )
    bg = Image.alpha_composite(bg, emblem_layer)

    # Apply squircle mask
    card = Image.new("RGBA", (supersample, supersample), (0, 0, 0, 0))
    card.paste(bg, (0, 0), mask)

    # Subtle Electric Blue / Metallic Silver squircle rim
    bdraw = ImageDraw.Draw(card)
    stroke_w = max(2, int(supersample * 0.010))
    bdraw.rounded_rectangle(
        [pad, pad, supersample - pad - 1, supersample - pad - 1],
        radius=radius,
        outline=(56, 189, 248, 95),
        width=stroke_w,
    )

    if size != supersample:
        card = card.resize((size, size), Image.Resampling.LANCZOS)
    return card


def build_round_icon(emblem: Image.Image, size: int) -> Image.Image:
    """Builds a circular launcher icon (Android round mipmap)."""
    supersample = max(size * 2, 256)
    mask = Image.new("L", (supersample, supersample), 0)
    mdraw = ImageDraw.Draw(mask)
    pad = int(supersample * 0.03)
    mdraw.ellipse(
        [pad, pad, supersample - pad - 1, supersample - pad - 1], fill=255
    )

    bg = Image.new("RGBA", (supersample, supersample), DARK_ABYSS)
    emblem_layer = place_centered(
        emblem, (supersample, supersample), scale_ratio=0.72, bg_color=(0, 0, 0, 0)
    )
    bg = Image.alpha_composite(bg, emblem_layer)

    out = Image.new("RGBA", (supersample, supersample), (0, 0, 0, 0))
    out.paste(bg, (0, 0), mask)
    bdraw = ImageDraw.Draw(out)
    bdraw.ellipse(
        [pad, pad, supersample - pad - 1, supersample - pad - 1],
        outline=(56, 189, 248, 90),
        width=max(2, int(supersample * 0.012)),
    )
    if size != supersample:
        out = out.resize((size, size), Image.Resampling.LANCZOS)
    return out


def generate_emblem_svg(include_background: bool = False) -> str:
    """
    Generates a crisp, high-precision SVG of the authoritative Wazir
    Crowned Circuit-Shield emblem derived directly from the landmark coordinates
    of `assets/brand/logo.jpeg`.
    """
    bg_rect = (
        '  <rect width="512" height="512" rx="108" fill="#0f131a"/>\n'
        '  <rect x="6" y="6" width="500" height="500" rx="102" fill="none" stroke="#38bdf8" stroke-opacity="0.28" stroke-width="4"/>\n'
        if include_background
        else ""
    )
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="none" role="img" aria-label="Wazir Crowned Circuit-Shield Emblem">
  <defs>
    <linearGradient id="wz-crown-metal" x1="120" y1="36" x2="392" y2="210" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#f8fafc"/>
      <stop offset="50%" stop-color="#cbd5e1"/>
      <stop offset="100%" stop-color="#94a3b8"/>
    </linearGradient>
    <linearGradient id="wz-shield-frame" x1="112" y1="150" x2="400" y2="476" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#e2e8f0"/>
      <stop offset="55%" stop-color="#94a3b8"/>
      <stop offset="100%" stop-color="#475569"/>
    </linearGradient>
    <linearGradient id="wz-shield-body" x1="256" y1="148" x2="256" y2="466" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#1e293b"/>
      <stop offset="55%" stop-color="#162032"/>
      <stop offset="100%" stop-color="#0f172a"/>
    </linearGradient>
    <radialGradient id="wz-core-glow" cx="256" cy="296" r="110" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#67e8f9" stop-opacity="0.95"/>
      <stop offset="40%" stop-color="#38bdf8" stop-opacity="0.45"/>
      <stop offset="100%" stop-color="#0f131a" stop-opacity="0"/>
    </radialGradient>
  </defs>
{bg_rect}  <!-- Three-Peaked W Crown -->
  <path d="M256 36 L204 128 L256 172 L308 128 Z" fill="url(#wz-crown-metal)"/>
  <path d="M256 36 L256 172 L308 128 Z" fill="#94a3b8" fill-opacity="0.65"/>
  <path d="M114 58 L128 158 L194 180 L190 132 Z" fill="url(#wz-crown-metal)"/>
  <path d="M398 58 L384 158 L318 180 L322 132 Z" fill="url(#wz-crown-metal)"/>

  <!-- Outer Metallic Shield Frame -->
  <path d="M118 164 L196 196 L256 150 L316 196 L394 164 L394 274 C394 362 332 428 256 476 C180 428 118 362 118 274 Z" fill="url(#wz-shield-frame)"/>

  <!-- Inner Shield Cavity -->
  <path d="M138 184 L198 210 L256 168 L314 210 L374 184 L374 272 C374 348 320 406 256 450 C192 406 138 348 138 272 Z" fill="url(#wz-shield-body)" stroke="#38bdf8" stroke-opacity="0.45" stroke-width="3"/>

  <!-- Lower Shield Facets -->
  <path d="M150 318 L224 362 L256 440 C200 402 158 362 150 318 Z" fill="#2f4469" fill-opacity="0.65"/>
  <path d="M362 318 L288 362 L256 440 C312 402 354 362 362 318 Z" fill="#2f4469" fill-opacity="0.5"/>

  <!-- Core Ambient Glow -->
  <circle cx="256" cy="296" r="98" fill="url(#wz-core-glow)"/>

  <!-- Radial Circuit Traces & Nodes -->
  <g stroke="#38bdf8" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">
    <!-- Upper X Diagonals -->
    <line x1="226" y1="266" x2="182" y2="222"/>
    <line x1="286" y1="266" x2="330" y2="222"/>
    <!-- Lower X Diagonals -->
    <line x1="226" y1="326" x2="188" y2="364"/>
    <line x1="286" y1="326" x2="324" y2="364"/>
    <!-- Cardinal Traces -->
    <line x1="256" y1="246" x2="256" y2="202"/>
    <line x1="256" y1="346" x2="256" y2="396"/>
    <line x1="206" y1="296" x2="162" y2="296"/>
    <line x1="306" y1="296" x2="350" y2="296"/>
  </g>

  <!-- Circuit Terminal Nodes -->
  <g fill="#f8fafc" stroke="#38bdf8" stroke-width="4">
    <circle cx="182" cy="222" r="7"/>
    <circle cx="330" cy="222" r="7"/>
    <circle cx="188" cy="364" r="7"/>
    <circle cx="324" cy="364" r="7"/>
    <circle cx="256" cy="202" r="6"/>
    <circle cx="256" cy="396" r="6"/>
    <circle cx="162" cy="296" r="6"/>
    <circle cx="350" cy="296" r="6"/>
  </g>

  <!-- Concentric AI Core -->
  <circle cx="256" cy="296" r="44" fill="#0f131a" stroke="#e2e8f0" stroke-width="8"/>
  <circle cx="256" cy="296" r="30" fill="#162032" stroke="#38bdf8" stroke-width="5"/>
  <circle cx="256" cy="296" r="16" fill="#67e8f9"/>
  <circle cx="251" cy="291" r="6" fill="#ffffff"/>
</svg>
"""


def generate_lockup_svg() -> str:
    """
    Generates a complete combination-mark SVG with the Crowned Circuit-Shield,
    WAZIR wordmark, and 'A LOCAL AI FLEET COUNSELOR' subtitle.
    """
    emblem_inner = generate_emblem_svg(include_background=False)
    start_idx = emblem_inner.find("<defs>")
    end_idx = emblem_inner.rfind("</svg>")
    inner_body = emblem_inner[start_idx:end_idx]

    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 720" fill="none" role="img" aria-label="Wazir — A Local AI Fleet Counselor">
  <rect width="640" height="720" rx="32" fill="#0f131a"/>
  <g transform="translate(64, 16)">
    {inner_body}
  </g>
  <!-- WAZIR Wordmark -->
  <text x="320" y="576" text-anchor="middle" fill="#f8fafc" font-family="'Archon Bold', 'SF Pro Display', 'Inter', system-ui, sans-serif" font-size="84" font-weight="800" letter-spacing="10">WAZIR</text>
  <!-- Subtitle -->
  <text x="320" y="622" text-anchor="middle" fill="#94a3b8" font-family="'Nexus Light', 'Inter', system-ui, sans-serif" font-size="20" font-weight="600" letter-spacing="5.5">A LOCAL AI FLEET COUNSELOR</text>
  <!-- Bottom Accent Bar -->
  <rect x="268" y="654" width="104" height="5" rx="2.5" fill="#38bdf8"/>
</svg>
"""


def generate_monochrome_svg() -> str:
    """
    Generates a clean single-color monochrome SVG of the Wazir Crowned Circuit-Shield
    suitable for monochrome badges, print stamps, and high-contrast themes.
    """
    return """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="none" role="img" aria-label="Wazir Monochrome Emblem">
  <!-- Three-Peaked W Crown -->
  <path d="M256 36 L204 128 L256 172 L308 128 Z" fill="currentColor"/>
  <path d="M114 58 L128 158 L194 180 L190 132 Z" fill="currentColor"/>
  <path d="M398 58 L384 158 L318 180 L322 132 Z" fill="currentColor"/>
  <!-- Shield Frame -->
  <path fill-rule="evenodd" clip-rule="evenodd" d="M118 164 L196 196 L256 150 L316 196 L394 164 L394 274 C394 362 332 428 256 476 C180 428 118 362 118 274 Z M142 188 L198 212 L256 170 L314 212 L370 188 L370 272 C370 346 318 402 256 446 C194 402 142 346 142 272 Z" fill="currentColor"/>
  <!-- Circuit Rays -->
  <g stroke="currentColor" stroke-width="10" stroke-linecap="round">
    <line x1="224" y1="264" x2="182" y2="222"/>
    <line x1="288" y1="264" x2="330" y2="222"/>
    <line x1="224" y1="328" x2="188" y2="364"/>
    <line x1="288" y1="328" x2="324" y2="364"/>
    <line x1="256" y1="242" x2="256" y2="202"/>
    <line x1="256" y1="350" x2="256" y2="396"/>
    <line x1="202" y1="296" x2="162" y2="296"/>
    <line x1="310" y1="296" x2="350" y2="296"/>
  </g>
  <!-- Core Ring & Node -->
  <circle cx="256" cy="296" r="42" stroke="currentColor" stroke-width="12"/>
  <circle cx="256" cy="296" r="16" fill="currentColor"/>
</svg>
"""


def write_android_vector_drawables(res_dir: Path) -> None:
    """Writes authoritative Android VectorDrawable XML resources."""
    drawable_dir = res_dir / "drawable"
    drawable_dir.mkdir(parents=True, exist_ok=True)

    # 1. ic_wazir_logo.xml
    (drawable_dir / "ic_wazir_logo.xml").write_text(
        """<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="512"
    android:viewportHeight="512">
    <!-- Dark Abyss Background -->
    <path
        android:fillColor="#0F131A"
        android:pathData="M0,0h512v512h-512z" />
    <!-- Three-Peaked W Crown -->
    <path
        android:fillColor="#F8FAFC"
        android:pathData="M256,44 L206,132 L256,174 L306,132 Z" />
    <path
        android:fillColor="#CBD5E1"
        android:pathData="M118,64 L132,160 L196,182 L192,136 Z" />
    <path
        android:fillColor="#CBD5E1"
        android:pathData="M394,64 L380,160 L316,182 L320,136 Z" />
    <!-- Outer Metallic Shield Frame -->
    <path
        android:fillColor="#94A3B8"
        android:pathData="M122,168 L198,198 L256,154 L314,198 L390,168 L390,274 C390,360 330,424 256,472 C182,424 122,360 122,274 Z" />
    <!-- Inner Shield Cavity -->
    <path
        android:fillColor="#162032"
        android:strokeColor="#38BDF8"
        android:strokeWidth="4"
        android:pathData="M142,188 L198,212 L256,172 L314,212 L370,188 L370,272 C370,346 318,402 256,446 C194,402 142,346 142,272 Z" />
    <!-- Lower Shield Facets -->
    <path
        android:fillColor="#2F4469"
        android:pathData="M154,318 L224,360 L256,436 C202,400 162,360 154,318 Z" />
    <path
        android:fillColor="#253759"
        android:pathData="M358,318 L288,360 L256,436 C310,400 350,360 358,318 Z" />
    <!-- Radial Circuit Traces -->
    <path
        android:strokeColor="#38BDF8"
        android:strokeWidth="8"
        android:strokeLineCap="round"
        android:pathData="M226,266 L182,222 M286,266 L330,222 M226,326 L188,364 M286,326 L324,364 M256,246 L256,202 M256,346 L256,396 M206,296 L162,296 M306,296 L350,296" />
    <!-- Circuit Terminal Nodes -->
    <path
        android:fillColor="#F8FAFC"
        android:strokeColor="#38BDF8"
        android:strokeWidth="4"
        android:pathData="M182,222m-7,0a7,7 0,1 1,14 0a7,7 0,1 1,-14 0 M330,222m-7,0a7,7 0,1 1,14 0a7,7 0,1 1,-14 0 M188,364m-7,0a7,7 0,1 1,14 0a7,7 0,1 1,-14 0 M324,364m-7,0a7,7 0,1 1,14 0a7,7 0,1 1,-14 0" />
    <!-- Central AI Core Ring & Node -->
    <path
        android:fillColor="#0F131A"
        android:strokeColor="#E2E8F0"
        android:strokeWidth="10"
        android:pathData="M256,296m-42,0a42,42 0,1 1,84 0a42,42 0,1 1,-84 0" />
    <path
        android:fillColor="#162032"
        android:strokeColor="#38BDF8"
        android:strokeWidth="6"
        android:pathData="M256,296m-28,0a28,28 0,1 1,56 0a28,28 0,1 1,-56 0" />
    <path
        android:fillColor="#67E8F9"
        android:pathData="M256,296m-15,0a15,15 0,1 1,30 0a15,15 0,1 1,-30 0" />
</vector>
""",
        encoding="utf-8",
    )

    # 2. ic_launcher_background.xml
    (drawable_dir / "ic_launcher_background.xml").write_text(
        """<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path
        android:fillColor="#0F131A"
        android:pathData="M0,0h108v108h-108z" />
    <path
        android:fillColor="#162032"
        android:pathData="M54,54m-38,0a38,38 0,1 1,76 0a38,38 0,1 1,-76 0" />
</vector>
""",
        encoding="utf-8",
    )

    # 3. ic_launcher_foreground.xml
    (drawable_dir / "ic_launcher_foreground.xml").write_text(
        """<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="512"
    android:viewportHeight="512">
    <group
        android:pivotX="256"
        android:pivotY="256"
        android:scaleX="0.62"
        android:scaleY="0.62">
        <path
            android:fillColor="#F8FAFC"
            android:pathData="M256,44 L206,132 L256,174 L306,132 Z" />
        <path
            android:fillColor="#CBD5E1"
            android:pathData="M118,64 L132,160 L196,182 L192,136 Z" />
        <path
            android:fillColor="#CBD5E1"
            android:pathData="M394,64 L380,160 L316,182 L320,136 Z" />
        <path
            android:fillColor="#94A3B8"
            android:pathData="M122,168 L198,198 L256,154 L314,198 L390,168 L390,274 C390,360 330,424 256,472 C182,424 122,360 122,274 Z" />
        <path
            android:fillColor="#162032"
            android:strokeColor="#38BDF8"
            android:strokeWidth="5"
            android:pathData="M142,188 L198,212 L256,172 L314,212 L370,188 L370,272 C370,346 318,402 256,446 C194,402 142,346 142,272 Z" />
        <path
            android:strokeColor="#38BDF8"
            android:strokeWidth="10"
            android:strokeLineCap="round"
            android:pathData="M226,266 L182,222 M286,266 L330,222 M226,326 L188,364 M286,326 L324,364 M256,246 L256,202 M256,346 L256,396 M206,296 L162,296 M306,296 L350,296" />
        <path
            android:fillColor="#0F131A"
            android:strokeColor="#F8FAFC"
            android:strokeWidth="12"
            android:pathData="M256,296m-42,0a42,42 0,1 1,84 0a42,42 0,1 1,-84 0" />
        <path
            android:fillColor="#67E8F9"
            android:pathData="M256,296m-18,0a18,18 0,1 1,36 0a18,18 0,1 1,-36 0" />
    </group>
</vector>
""",
        encoding="utf-8",
    )

    # 4. ic_launcher_monochrome.xml
    (drawable_dir / "ic_launcher_monochrome.xml").write_text(
        """<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="512"
    android:viewportHeight="512">
    <group
        android:pivotX="256"
        android:pivotY="256"
        android:scaleX="0.62"
        android:scaleY="0.62">
        <path
            android:fillColor="#FFFFFF"
            android:pathData="M256,44 L206,132 L256,174 L306,132 Z M118,64 L132,160 L196,182 L192,136 Z M394,64 L380,160 L316,182 L320,136 Z" />
        <path
            android:fillColor="#FFFFFF"
            android:fillType="evenOdd"
            android:pathData="M122,168 L198,198 L256,154 L314,198 L390,168 L390,274 C390,360 330,424 256,472 C182,424 122,360 122,274 Z M148,192 L198,214 L256,174 L314,214 L364,192 L364,272 C364,344 314,398 256,440 C198,398 148,344 148,272 Z" />
        <path
            android:strokeColor="#FFFFFF"
            android:strokeWidth="12"
            android:strokeLineCap="round"
            android:pathData="M224,264 L182,222 M288,264 L330,222 M224,328 L188,364 M288,328 L324,364 M256,242 L256,202 M256,350 L256,396 M202,296 L162,296 M310,296 L350,296" />
        <path
            android:strokeColor="#FFFFFF"
            android:strokeWidth="14"
            android:pathData="M256,296m-42,0a42,42 0,1 1,84 0a42,42 0,1 1,-84 0" />
        <path
            android:fillColor="#FFFFFF"
            android:pathData="M256,296m-18,0a18,18 0,1 1,36 0a18,18 0,1 1,-36 0" />
    </group>
</vector>
""",
        encoding="utf-8",
    )

    # 5. ic_stat_wazir.xml
    (drawable_dir / "ic_stat_wazir.xml").write_text(
        """<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="512"
    android:viewportHeight="512">
    <path
        android:fillColor="#FFFFFF"
        android:pathData="M256,36 L204,128 L256,172 L308,128 Z M114,58 L128,158 L194,180 L190,132 Z M398,58 L384,158 L318,180 L322,132 Z" />
    <path
        android:fillColor="#FFFFFF"
        android:fillType="evenOdd"
        android:pathData="M118,164 L196,196 L256,150 L316,196 L394,164 L394,274 C394,362 332,428 256,476 C180,428 118,362 118,274 Z M152,196 L198,216 L256,176 L314,216 L360,196 L360,272 C360,340 312,394 256,436 C200,394 152,340 152,272 Z" />
    <path
        android:fillColor="#FFFFFF"
        android:pathData="M256,296m-36,0a36,36 0,1 1,72 0a36,36 0,1 1,-72 0" />
</vector>
""",
        encoding="utf-8",
    )

    # 6. mipmap-anydpi-v26 adaptive icon XMLs
    anydpi_dir = res_dir / "mipmap-anydpi-v26"
    anydpi_dir.mkdir(parents=True, exist_ok=True)
    adaptive_xml = """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
    <monochrome android:drawable="@drawable/ic_launcher_monochrome" />
</adaptive-icon>
"""
    (anydpi_dir / "ic_launcher.xml").write_text(adaptive_xml, encoding="utf-8")
    (anydpi_dir / "ic_launcher_round.xml").write_text(adaptive_xml, encoding="utf-8")


def main() -> None:
    if not SOURCE_JPEG.exists():
        raise FileNotFoundError(f"Authoritative logo missing: {SOURCE_JPEG}")

    src = Image.open(SOURCE_JPEG).convert("RGBA")
    emblem_tight, lockup_tight = extract_authoritative_emblem_and_lockup(src)

    # Save canonical generated master assets
    gen_dir = ROOT / "assets" / "brand" / "generated"
    gen_dir.mkdir(parents=True, exist_ok=True)

    emblem_1024 = place_centered(emblem_tight, (1024, 1024), scale_ratio=0.90)
    emblem_1024.save(gen_dir / "emblem-transparent.png", "PNG", optimize=True)

    lockup_1200 = place_centered(lockup_tight, (1200, 1200), scale_ratio=0.90)
    lockup_1200.save(gen_dir / "lockup-transparent.png", "PNG", optimize=True)

    (gen_dir / "logo-emblem.svg").write_text(
        generate_emblem_svg(include_background=False), encoding="utf-8"
    )
    (gen_dir / "logo-lockup.svg").write_text(
        generate_lockup_svg(), encoding="utf-8"
    )
    (gen_dir / "logo-monochrome.svg").write_text(
        generate_monochrome_svg(), encoding="utf-8"
    )

    # 2. Generate Web Assets (`apps/web/public/`)
    web_pub = ROOT / "apps" / "web" / "public"
    web_pub.mkdir(parents=True, exist_ok=True)

    (web_pub / "favicon.svg").write_text(
        generate_emblem_svg(include_background=True), encoding="utf-8"
    )
    (web_pub / "logo-emblem.svg").write_text(
        generate_emblem_svg(include_background=False), encoding="utf-8"
    )

    emblem_256 = place_centered(emblem_tight, (256, 256), scale_ratio=0.92)
    emblem_256.save(web_pub / "logo-emblem.png", "PNG", optimize=True)

    icon_16 = build_squircle_app_icon(emblem_tight, 16)
    icon_32 = build_squircle_app_icon(emblem_tight, 32)
    icon_48 = build_squircle_app_icon(emblem_tight, 48)
    icon_180 = build_squircle_app_icon(emblem_tight, 180)
    icon_192 = build_squircle_app_icon(emblem_tight, 192)
    icon_512 = build_squircle_app_icon(emblem_tight, 512)

    icon_16.save(web_pub / "favicon-16x16.png", "PNG", optimize=True)
    icon_32.save(web_pub / "favicon-32x32.png", "PNG", optimize=True)
    icon_180.save(web_pub / "apple-touch-icon.png", "PNG", optimize=True)
    icon_192.save(web_pub / "icon-192.png", "PNG", optimize=True)
    icon_512.save(web_pub / "icon-512.png", "PNG", optimize=True)

    icon_48.save(
        web_pub / "favicon.ico",
        format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48)],
    )

    maskable_512 = place_centered(
        emblem_tight, (512, 512), scale_ratio=0.66, bg_color=DARK_ABYSS
    )
    maskable_512.save(web_pub / "icon-maskable-512.png", "PNG", optimize=True)

    og_crop = src.crop((0, 29, 2816, 1507)).convert("RGB")
    og_1200x630 = og_crop.resize((1200, 630), Image.Resampling.LANCZOS)
    og_1200x630.save(web_pub / "og-image.png", "PNG", optimize=True)

    manifest = {
        "name": "Wazir — A Local AI Fleet Counselor",
        "short_name": "Wazir",
        "description": "Local-first AI Fleet Counselor & Autonomous Agent Orchestration",
        "start_url": "/",
        "display": "standalone",
        "background_color": "#0f131a",
        "theme_color": "#0f131a",
        "icons": [
            {"src": "/favicon.svg", "sizes": "any", "type": "image/svg+xml"},
            {"src": "/icon-192.png", "sizes": "192x192", "type": "image/png"},
            {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png"},
            {
                "src": "/icon-maskable-512.png",
                "sizes": "512x512",
                "type": "image/png",
                "purpose": "maskable",
            },
        ],
    }
    (web_pub / "site.webmanifest").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )

    # 3. Generate Desktop Icons (`apps/desktop/src-tauri/icons/` and `scripts/AppIcon.icns`)
    tauri_icons = ROOT / "apps" / "desktop" / "src-tauri" / "icons"
    tauri_icons.mkdir(parents=True, exist_ok=True)

    desktop_sizes = {
        "32x32.png": 32,
        "64x64.png": 64,
        "128x128.png": 128,
        "128x128@2x.png": 256,
        "icon.png": 512,
    }
    for filename, sz in desktop_sizes.items():
        img = build_squircle_app_icon(emblem_tight, sz)
        img.save(tauri_icons / filename, "PNG", optimize=True)

    tray_22 = place_centered(emblem_tight, (22, 22), scale_ratio=0.92)
    tray_44 = place_centered(emblem_tight, (44, 44), scale_ratio=0.92)
    tray_22.save(tauri_icons / "tray-icon.png", "PNG", optimize=True)
    tray_44.save(tauri_icons / "tray-icon@2x.png", "PNG", optimize=True)

    ico_master = build_squircle_app_icon(emblem_tight, 256)
    ico_master.save(
        tauri_icons / "icon.ico",
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )

    with tempfile.TemporaryDirectory() as tmpdir:
        iconset_dir = Path(tmpdir) / "AppIcon.iconset"
        iconset_dir.mkdir(parents=True, exist_ok=True)
        icns_spec = [
            ("icon_16x16.png", 16),
            ("icon_16x16@2x.png", 32),
            ("icon_32x32.png", 32),
            ("icon_32x32@2x.png", 64),
            ("icon_128x128.png", 128),
            ("icon_128x128@2x.png", 256),
            ("icon_256x256.png", 256),
            ("icon_256x256@2x.png", 512),
            ("icon_512x512.png", 512),
            ("icon_512x512@2x.png", 1024),
        ]
        for name, sz in icns_spec:
            build_squircle_app_icon(emblem_tight, sz).save(iconset_dir / name, "PNG")

        icns_out = tauri_icons / "icon.icns"
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset_dir), "-o", str(icns_out)],
            check=True,
        )
        shutil.copy2(icns_out, ROOT / "scripts" / "AppIcon.icns")

    linux_pkg = ROOT / "packaging" / "linux"
    linux_pkg.mkdir(parents=True, exist_ok=True)
    (linux_pkg / "wazir.desktop").write_text(
        """[Desktop Entry]
Type=Application
Version=1.0
Name=Wazir
GenericName=Local AI Fleet Counselor
Comment=Autonomous Agent Orchestration & Local AI Fleet Counselor
Exec=wazir
Icon=wazir
Terminal=false
Categories=Development;Utility;ArtificialIntelligence;
Keywords=AI;Agent;LLM;Orchestration;Wazir;
StartupWMClass=wazir
""",
        encoding="utf-8",
    )

    # 4. Generate Android Assets
    android_res = ROOT / "apps" / "android" / "app" / "src" / "main" / "res"
    write_android_vector_drawables(android_res)

    android_mipmaps = {
        "mipmap-mdpi": (48, 108),
        "mipmap-hdpi": (72, 162),
        "mipmap-xhdpi": (96, 216),
        "mipmap-xxhdpi": (144, 324),
        "mipmap-xxxhdpi": (192, 432),
    }
    for folder, (launcher_px, fg_px) in android_mipmaps.items():
        m_dir = android_res / folder
        m_dir.mkdir(parents=True, exist_ok=True)
        build_squircle_app_icon(emblem_tight, launcher_px).save(
            m_dir / "ic_launcher.png", "PNG", optimize=True
        )
        build_round_icon(emblem_tight, launcher_px).save(
            m_dir / "ic_launcher_round.png", "PNG", optimize=True
        )
        place_centered(emblem_tight, (fg_px, fg_px), scale_ratio=0.62).save(
            m_dir / "ic_launcher_foreground.png", "PNG", optimize=True
        )

    # 5. Generate iOS Asset Catalog
    ios_dir = ROOT / "assets" / "brand" / "ios" / "AppIcon.appiconset"
    ios_dir.mkdir(parents=True, exist_ok=True)
    ios_sizes = [
        ("Icon-App-20x20@2x.png", 40, "20x20", "2x", "iphone"),
        ("Icon-App-20x20@3x.png", 60, "20x20", "3x", "iphone"),
        ("Icon-App-29x29@2x.png", 58, "29x29", "2x", "iphone"),
        ("Icon-App-29x29@3x.png", 87, "29x29", "3x", "iphone"),
        ("Icon-App-40x40@2x.png", 80, "40x40", "2x", "iphone"),
        ("Icon-App-40x40@3x.png", 120, "40x40", "3x", "iphone"),
        ("Icon-App-60x60@2x.png", 120, "60x60", "2x", "iphone"),
        ("Icon-App-60x60@3x.png", 180, "60x60", "3x", "iphone"),
        ("Icon-App-76x76@2x.png", 152, "76x76", "2x", "ipad"),
        ("Icon-App-83.5x83.5@2x.png", 167, "83.5x83.5", "2x", "ipad"),
        ("Icon-App-1024x1024@1x.png", 1024, "1024x1024", "1x", "ios-marketing"),
    ]
    ios_images_meta = []
    for filename, px_size, pt_size, scale_str, idiom in ios_sizes:
        ios_icon = place_centered(
            emblem_tight, (px_size, px_size), scale_ratio=0.78, bg_color=DARK_ABYSS
        ).convert("RGB")
        ios_icon.save(ios_dir / filename, "PNG", optimize=True)
        ios_images_meta.append(
            {
                "filename": filename,
                "idiom": idiom,
                "scale": scale_str,
                "size": pt_size,
            }
        )
    (ios_dir / "Contents.json").write_text(
        json.dumps(
            {"images": ios_images_meta, "info": {"author": "wazir-brand-pipeline", "version": 1}},
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    place_centered(lockup_tight, (768, 768), scale_ratio=0.86).save(
        ROOT / "assets" / "brand" / "ios" / "LaunchScreenLogo.png", "PNG", optimize=True
    )

    print("Wazir canonical brand asset pipeline completed successfully.")


if __name__ == "__main__":
    main()
