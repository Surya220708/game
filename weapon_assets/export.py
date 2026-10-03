"""Export pipeline: PNG files, a JSON manifest, texture atlases and item cards.

The manifest is the contract with your engine: it carries the catalog entry, the
rolled stats for every rarity/level you exported, the palette in hex, and the
muzzle/grip anchors both in pixels of the exported PNG and normalised 0..1.
"""
from __future__ import annotations

import json
import math
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Optional, Sequence, Tuple

from PIL import Image, ImageDraw, ImageFont

from . import catalog, effects, palettes, render, stats as stats_mod
from .render import RenderOptions, Sprite

DEFAULT_TEMPLATE = "{kind}/{slug}/{slug}_{rarity}_{variant}_{height}px"
MANIFEST_NAME = "weapon_assets.json"


# --------------------------------------------------------------------------- #
# fonts
# --------------------------------------------------------------------------- #
_FONT_CANDIDATES = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    "C:/Windows/Fonts/segoeuib.ttf",
)


def font(size: int, bold: bool = True) -> ImageFont.ImageFont:
    candidates = _FONT_CANDIDATES if bold else _FONT_CANDIDATES[1:]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    try:  # Pillow >= 10.1 ships a scalable default
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


# --------------------------------------------------------------------------- #
# naming / paths
# --------------------------------------------------------------------------- #
def safe(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", str(text)).strip("_").lower()


def build_name(template: str, kind: str, slug: str, rarity: str, variant: str,
               height: int, level: int = 1, seed: Optional[int] = None, extra: str = "") -> str:
    name = template.format(kind=kind, slug=slug, rarity=rarity, variant=variant,
                           height=str(height), level=f"lvl{level}",
                           seed=seed if seed is not None else "0",
                           extra=extra, name=safe(slug))
    return "/".join(safe(part) if i else part for i, part in enumerate(name.split("/")))


@dataclass
class ExportResult:
    files: List[str] = field(default_factory=list)
    manifest: dict = field(default_factory=dict)
    out_dir: str = ""

    def __str__(self) -> str:  # pragma: no cover - convenience only
        return f"wrote {len(self.files)} files to {self.out_dir}"


# --------------------------------------------------------------------------- #
# manifest
# --------------------------------------------------------------------------- #
def weapon_manifest_entry(slug: str, rarities: Sequence[str], level: int,
                          anchors: Optional[dict] = None, files: Optional[dict] = None,
                          palette_hex: Optional[dict] = None) -> dict:
    entry = catalog.get(slug)
    rolls = {}
    for rarity in rarities:
        w = stats_mod.build(slug, rarity, level)
        rolls[rarity] = w.to_dict()
    return {
        "slug": slug,
        "name": entry["name"],
        "class": entry["cls"],
        "tier": entry["tier"],
        "archetype": entry["archetype"],
        "ammo": entry["ammo"],
        "desc": entry["desc"],
        "traits": list(entry.get("traits", [])),
        "base_stats": {k: v for k, v in entry["base"].items()},
        "rolls": rolls,
        "anchors": anchors or {},
        "files": files or {},
        "palette": palette_hex or {},
        "fx": {
            "flash": effects.flash_for(entry["fx"]),
            "projectile": effects.projectile_for(entry["fx"]),
        },
    }


def build_manifest(entries: Sequence[dict], rarity_range: Sequence[str],
                   sizes: Sequence[int], level: int, template: str,
                   extra: Optional[dict] = None) -> dict:
    return {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "generator": "weapon_assets",
        "version": "1.0.0",
        "level": level,
        "rarities": list(rarity_range),
        "palette_rarities": {r: {k: v for k, v in palettes.RARITIES[r].items()}
                             for r in rarity_range},
        "sizes": [f"{s}px" for s in sizes],
        "name_template": template,
        "conventions": {
            "origin": "top-left, +y down",
            "facing": "'side' faces right, 'side_left' faces left",
            "anchors": "anchors_px are pixels inside the exported PNG; "
                       "anchors_uv are 0..1 relative to the PNG",
            "pivot": "bottom-left of the sprite bounding box",
            "units": "design space is 200x96 with the bore at y=20..25; "
                     "'unit_to_px' converts design units to pixels",
        },
        "weapons": {e["slug"]: e for e in entries},
        **(extra or {}),
    }


# --------------------------------------------------------------------------- #
# atlas packing (shelf / skyline hybrid, deterministic)
# --------------------------------------------------------------------------- #
def pack_atlas(sprites: Sequence[Tuple[str, Image.Image]], padding: int = 2,
               max_width: int = 2048) -> Tuple[Image.Image, dict]:
    """Shelf-pack images into one atlas; returns the atlas and frame metadata."""
    items = sorted(((name, img) for name, img in sprites),
                   key=lambda kv: -kv[1].size[1])
    if not items:
        return Image.new("RGBA", (1, 1), (0, 0, 0, 0)), {"frames": {}}

    widths = [img.size[0] + padding for _, img in items]
    total = sum(widths)
    guess = max(max(widths) + padding, math.ceil(math.sqrt(total) * 1.15))
    atlas_w = min(max_width, max(64, int(guess)))

    frames: Dict[str, dict] = {}
    placements: List[Tuple[str, Image.Image, int, int]] = []
    x = y = shelf_h = 0
    for name, img in items:
        w, h = img.size
        if x + w + padding > atlas_w:
            x = 0
            y += shelf_h + padding
            shelf_h = 0
        placements.append((name, img, x, y))
        frames[name] = {"x": x, "y": y, "w": w, "h": h}
        x += w + padding
        shelf_h = max(shelf_h, h + padding)
    atlas_h = y + shelf_h + padding
    atlas_w = max(atlas_w, max((f["x"] + f["w"] for f in frames.values()), default=1))

    atlas = Image.new("RGBA", (atlas_w, atlas_h), (0, 0, 0, 0))
    for name, img, px, py in placements:
        atlas.alpha_composite(img, (px, py))

    meta = {
        "meta": {"app": "weapon_assets", "version": "1.0.0", "image": "atlas.png",
                 "size": {"w": atlas_w, "h": atlas_h}, "scale": "1"},
        "frames": {name: {"frame": {"x": f["x"], "y": f["y"], "w": f["w"], "h": f["h"]},
                          "rotated": False, "trimmed": False,
                          "spriteSourceSize": {"x": 0, "y": 0, "w": f["w"], "h": f["h"]},
                          "sourceSize": {"w": f["w"], "h": f["h"]}}
                   for name, f in frames.items()},
    }
    return atlas, meta


# --------------------------------------------------------------------------- #
# item cards
# --------------------------------------------------------------------------- #
def _wrap(draw: ImageDraw.ImageDraw, text: str, fnt, max_w: float,
          max_lines: int = 2) -> List[str]:
    """Greedy word wrap that ellipsises instead of overflowing the column."""
    words = text.split()
    lines: List[str] = []
    cur = ""
    for i, word in enumerate(words):
        trial = f"{cur} {word}".strip()
        if cur and draw.textlength(trial, font=fnt) > max_w:
            lines.append(cur)
            cur = word
            if len(lines) >= max_lines:
                break
        else:
            cur = trial
    if cur and len(lines) < max_lines:
        lines.append(cur)
    consumed = " ".join(lines)
    if len(consumed) < len(text):
        lines[-1] = lines[-1].rstrip(" .,") + "..."
    return lines


def item_card(slug: str, rarity: str, level: int = 1, width: int = 512, height: int = 200,
              seed: Optional[int] = None, ss: int = 4) -> Image.Image:
    """A lore/inventory card: rarity frame, sprite, rolled stats and perks.

    Layout is proportional, so the card stays readable at any size: name /
    subtitle / perks down the left, stat block top-right, sprite bottom-right,
    rarity pips along the bottom-left.
    """
    item = stats_mod.build(slug, rarity, level, seed=seed)
    pal = palettes.build(rarity)
    accent = pal["accent"]
    pad = max(12, int(min(width, height) * 0.11))
    card = Image.new("RGBA", (width, height), (14, 15, 20, 255))
    d = ImageDraw.Draw(card)

    for y in range(height):  # background gradient
        t = y / max(1, height - 1)
        d.line([(0, y), (width, y)],
               fill=(int(14 + 12 * t), int(15 + 12 * t), int(20 + 16 * t), 255))
    band = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    bd = ImageDraw.Draw(band)
    bar = max(3, int(height * 0.03))
    bd.rectangle((0, 0, width, bar), fill=(*accent, 255))
    bd.rectangle((0, height - bar, width, height), fill=(*pal["accent_dark"], 255))
    bd.ellipse((-height, -height, height, height), fill=(*accent, 26))
    card.alpha_composite(band)
    d.rectangle((0, 0, width - 1, height - 1), outline=(*pal["accent_dark"], 255))

    f_name = font(max(12, int(height * 0.15)))
    f_sub = font(max(9, int(height * 0.082)), bold=False)
    f_stat = font(max(10, int(height * 0.088)))

    # ---- left column: identity, description, perks --------------------------
    col_w = int(width * 0.47)
    d.text((pad, int(height * 0.07)), item.name, font=f_name, fill=(240, 243, 250, 255))
    d.text((pad, int(height * 0.245)),
           f"{item.rarity_label} {item.cls.title()}  |  tier {item.tier}  |  lvl {item.level}",
           font=f_sub, fill=(*accent, 255))

    line_h = int(height * 0.085)
    desc_y = int(height * 0.38)
    desc_lines = _wrap(d, item.desc, f_sub, col_w - pad, max_lines=2)
    d.multiline_text((pad, desc_y), "\n".join(desc_lines), font=f_sub,
                     fill=(158, 164, 178, 255), spacing=int(height * 0.025))

    has_perks = bool(item.perks)
    perks = [p["text"] for p in item.perks[:2]] if has_perks else list(item.traits[:2])
    perk_y = desc_y + len(desc_lines) * line_h + int(height * 0.03)
    perk_colour = pal["energy"] if has_perks else (150, 156, 170)
    for i, text in enumerate(perks):
        d.text((pad, perk_y + i * line_h), ("+ " if has_perks else "- ") + text,
               font=f_sub, fill=(*perk_colour, 255))

    # ---- right column: stat block -------------------------------------------
    sx = int(width * 0.53)
    stat_lines = [
        ("DPS", f"{item.stats.dps:,.1f}"),
        ("DMG", f"{item.stats.damage:,.1f}" + (f" x{item.stats.pellets}"
                                               if item.stats.pellets > 1 else "")),
        ("RPS", f"{item.stats.fire_rate:,.2f}"),
        ("MAG", f"{item.stats.magazine}" if item.stats.magazine else "-"),
        ("PWR", f"{item.power_score:,}"),
    ]
    row = int(height * 0.115)
    for i, (key, value) in enumerate(stat_lines):
        y = int(height * 0.10) + i * row
        d.text((sx, y), key, font=f_sub, fill=(146, 152, 166, 255))
        d.text((sx + int(width * 0.115), y - 2), value, font=f_stat,
               fill=(238, 241, 248, 255))

    # ---- sprite, bottom-right ------------------------------------------------
    box = (int(width * 0.50), int(height * 0.64), width - pad, int(height * 0.94))
    sprite = render.render(RenderOptions(slug, rarity=rarity, height=max(16, box[3] - box[1]),
                                        variant="side", ss=ss)).image
    scale = min((box[2] - box[0]) / sprite.width, (box[3] - box[1]) / sprite.height)
    w = max(1, int(sprite.width * scale))
    h = max(1, int(sprite.height * scale))
    sprite = sprite.resize((w, h), Image.LANCZOS)
    card.alpha_composite(sprite, (box[0] + (box[2] - box[0] - w) // 2,
                                 box[1] + (box[3] - box[1] - h) // 2))

    # ---- rarity pips, bottom-left -------------------------------------------
    pip_r = max(3, int(height * 0.032))
    for i in range(palettes.RARITIES[rarity]["tier"]):
        cx = pad + i * int(pip_r * 3.2)
        cy = height - pad - pip_r
        d.ellipse((cx, cy, cx + pip_r * 2, cy + pip_r * 2), fill=(*accent, 255))
    return card


# --------------------------------------------------------------------------- #
# top level
# --------------------------------------------------------------------------- #
def export_weapons(out_dir: str, slugs: Optional[Sequence[str]] = None,
                   rarities: Sequence[str] = ("common",),
                   sizes: Sequence[int] = (64, 128, 256),
                   variants: Sequence[str] = ("side", "side_left", "icon"),
                   level: int = 12, seed: Optional[int] = None,
                   template: str = DEFAULT_TEMPLATE, ss: int = 4,
                   cards: bool = True, glow: bool = True,
                   palette_overrides: Optional[Dict[str, str]] = None,
                   progress=None) -> ExportResult:
    """Render the whole set and write PNGs + a manifest."""
    os.makedirs(out_dir, exist_ok=True)
    slugs = list(slugs or catalog.slugs())
    result = ExportResult(out_dir=out_dir)
    entries = []

    for slug in slugs:
        sprite_files: Dict[str, dict] = {}
        anchors: Dict[str, dict] = {}
        sprite_cache: List[Tuple[str, Image.Image]] = []
        for rarity in rarities:
            for size in sizes:
                for variant in variants:
                    opts = RenderOptions(slug=slug, rarity=rarity, height=size,
                                         variant=variant, ss=ss, seed=seed,
                                         square=(variant == "icon"), glow=glow,
                                         palette_overrides=palette_overrides)
                    sprite: Sprite = render.render(opts)
                    rel = build_name(template, "weapons", slug, rarity, variant, size,
                                     level=level, seed=seed) + ".png"
                    path = os.path.join(out_dir, rel)
                    os.makedirs(os.path.dirname(path), exist_ok=True)
                    sprite.image.save(path, "PNG", optimize=True)
                    result.files.append(rel)
                    anchors[f"{rarity}_{variant}_{size}"] = {
                        "file": rel, "anchors_px": sprite.to_meta()["anchors_px"],
                        "anchors_uv": sprite.to_meta()["anchors_uv"], "size": list(sprite.size),
                    }
                    sprite_files.setdefault(rarity, {})[f"{variant}_{size}"] = rel
                    if size == max(sizes) and variant in ("side", "top_down"):
                        sprite_cache.append((f"{slug}_{rarity}_{variant}", sprite.image))
        if cards:
            for rarity in rarities:
                card = item_card(slug, rarity, level=level, seed=seed)
                rel = build_name(template, "cards", slug, rarity, "card", 200) + ".png"
                path = os.path.join(out_dir, rel)
                os.makedirs(os.path.dirname(path), exist_ok=True)
                card.save(path, "PNG", optimize=True)
                result.files.append(rel)
        entries.append(weapon_manifest_entry(slug, rarities, level, anchors=anchors,
                                             files=sprite_files,
                                             palette_hex=palettes.build(rarities[0]).as_hex()))
        if progress:
            progress(slug)
    result.manifest = build_manifest(entries, rarities, sizes, level, template)
    return result


def export_effects(out_dir: str, names: Optional[Sequence[str]] = None,
                   rarities: Sequence[str] = ("common",),
                   heights: Sequence[int] = (32, 64, 128), ss: int = 4) -> List[str]:
    """Write muzzle flashes / projectiles / impacts as PNGs."""
    os.makedirs(out_dir, exist_ok=True)
    names = list(names or effects.EFFECTS.keys())
    written: List[str] = []
    for name in names:
        for rarity in rarities:
            for h in heights:
                img = effects.render_effect(name, rarity=rarity, height=h, ss=ss)
                rel = os.path.join("effects", f"{name}_{rarity}_{h}px.png")
                path = os.path.join(out_dir, rel)
                os.makedirs(os.path.dirname(path), exist_ok=True)
                img.save(path, "PNG", optimize=True)
                written.append(rel)
    return written


def export_atlas(out_dir: str, slugs: Optional[Sequence[str]] = None,
                 rarities: Sequence[str] = ("common", "rare", "legendary"),
                 size: int = 128, variants: Sequence[str] = ("side", "icon"),
                 level: int = 12, ss: int = 4, padding: int = 2,
                 include_effects: bool = True) -> Tuple[str, str]:
    """Pack the requested sprites into ``atlas.png`` + ``atlas.json``."""
    os.makedirs(out_dir, exist_ok=True)
    slugs = list(slugs or catalog.slugs())
    sprites: List[Tuple[str, Image.Image]] = []
    for slug in slugs:
        for rarity in rarities:
            for variant in variants:
                s = render.render(RenderOptions(slug, rarity=rarity, height=size,
                                                variant=variant, ss=ss,
                                                square=(variant == "icon")))
                sprites.append((f"{slug}_{rarity}_{variant}", s.image))
    if include_effects:
        for name in effects.EFFECTS:
            for rarity in rarities:
                img = effects.render_effect(name, rarity=rarity, height=size, ss=ss)
                sprites.append((f"{name}_{rarity}", img))
    atlas, meta = pack_atlas(sprites, padding=padding)
    img_path = os.path.join(out_dir, "atlas.png")
    json_path = os.path.join(out_dir, "atlas.json")
    atlas.save(img_path, "PNG", optimize=True)
    with open(json_path, "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=1)
    return img_path, json_path


def export_sheet(out_dir: str, rarities: Sequence[str] = ("common", "rare", "legendary"),
                 cell: int = 256, cols: int = 5, ss: int = 4) -> List[str]:
    """One contact sheet per rarity, for eyeballing the whole set."""
    os.makedirs(out_dir, exist_ok=True)
    written = []
    for rarity in rarities:
        sheet = render.contact_sheet(catalog.slugs(), rarity=rarity, cell=cell, cols=cols)
        rel = os.path.join("sheets", f"sheet_{rarity}.png")
        path = os.path.join(out_dir, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        sheet.save(path, "PNG", optimize=True)
        written.append(rel)
    return written


def write_manifest(out_dir: str, manifest: dict, name: str = MANIFEST_NAME) -> str:
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, name)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=1, sort_keys=False)
    return path


def export_catalog(out_dir: str, level: int = 12,
                   rarities: Sequence[str] = palettes.RARITY_ORDER) -> str:
    """Describer-only export: stats for every weapon x rarity, no images."""
    os.makedirs(out_dir, exist_ok=True)
    entries = [weapon_manifest_entry(s, rarities, level) for s in catalog.slugs()]
    data = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "level": level,
        "rarities": list(rarities),
        "balance_constants": {
            "max_level": stats_mod.MAX_LEVEL,
            "rarity_mult": stats_mod.RARITY_MULT,
            "per_level": stats_mod.PER_LEVEL,
            "roll_spread": stats_mod.ROLL_SPREAD,
            "perk_count": stats_mod.PERK_COUNT,
            "perk_pool": stats_mod.PERK_POOL,
        },
        "weapons": {e["slug"]: e for e in entries},
    }
    path = os.path.join(out_dir, "catalog.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=1)
    return path
