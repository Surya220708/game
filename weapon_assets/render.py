"""Rendering: turn a recipe + a palette into a finished PNG, at any size.

The pipeline for one sprite is:

1. rasterise the recipe into a supersampled canvas (``ss``x, default 4x)
2. screen-blend the accumulated glow layer
3. crop to the artwork (or centre it in a square canvas)
4. downsample with LANCZOS to the requested pixel height

Because the recipe is resolution independent, ``height=32`` and ``height=1024``
are the same code path -- only the LANCZOS box filter does the work.

Anchors (muzzle, grip, barrel axis) travel with the sprite: they come out in
pixel coordinates *of the exported image* and in normalised 0..1 coordinates, so
a game can spawn a projectile at the muzzle without hard-coding offsets.
"""
from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Dict, Optional, Sequence, Tuple

from PIL import Image, ImageChops, ImageDraw, ImageFilter

from . import palettes, recipes
from .pen import Pen

VARIANTS = ("side", "side_left", "top_down", "silhouette", "outline", "icon")


@dataclass
class RenderOptions:
    slug: str
    rarity: str = "common"
    height: int = 128
    variant: str = "side"
    ss: int = 4
    seed: Optional[int] = None
    padding: float = 2.0          # design units of transparent margin
    palette_overrides: Optional[Dict[str, str]] = None
    square: bool = False          # pad to a square canvas (icons)
    glow: bool = True
    glow_strength: float = 0.42   # bloom multiplier (1.0 = exactly as authored)

    def key(self) -> str:
        return f"{self.slug}|{self.rarity}|{self.variant}|{self.height}|{self.seed}"


@dataclass
class Sprite:
    image: Image.Image
    slug: str
    rarity: str
    variant: str
    height: int
    anchors_px: Dict[str, Tuple[float, float]] = field(default_factory=dict)
    anchors_uv: Dict[str, Tuple[float, float]] = field(default_factory=dict)
    design_bbox: Tuple[float, float, float, float] = (0, 0, 0, 0)
    scale: float = 1.0

    @property
    def size(self) -> Tuple[int, int]:
        return self.image.size

    @property
    def width(self) -> int:
        return self.image.size[0]

    def to_meta(self) -> dict:
        return {
            "slug": self.slug, "rarity": self.rarity, "variant": self.variant,
            "w": self.image.size[0], "h": self.image.size[1], "height": self.height,
            "anchors_px": {k: [round(v[0], 2), round(v[1], 2)] for k, v in self.anchors_px.items()},
            "anchors_uv": {k: [round(v[0], 4), round(v[1], 4)] for k, v in self.anchors_uv.items()},
            "scale": round(self.scale, 5),
        }


# --------------------------------------------------------------------------- #
# step 1-2: design-space sprite
# --------------------------------------------------------------------------- #
def design_sprite(opts: RenderOptions) -> Image.Image:
    palette = palettes.build(opts.rarity, **(opts.palette_overrides or {}))
    seed = opts.seed if opts.seed is not None else f"{opts.slug}:{opts.rarity}"
    pen = Pen(recipes.DESIGN, palette, ss=opts.ss, seed=seed)
    pen.glow_scale = opts.glow_strength
    recipes.paint(opts.slug, pen)
    if not opts.glow:
        pen.glow_layer = Image.new("RGBA", pen.size, (0, 0, 0, 0))
        pen._glow_dirty = False
    return pen.finish()


def _bbox_of(img: Image.Image, pad: float) -> Tuple[int, int, int, int]:
    box = img.getbbox()
    if box is None:
        w, h = img.size
        return 0, 0, w, h
    x0, y0, x1, y1 = box
    x0 = max(0, int(x0 - pad))
    y0 = max(0, int(y0 - pad))
    x1 = min(img.size[0], int(x1 + pad))
    y1 = min(img.size[1], int(y1 + pad))
    return x0, y0, x1, y1


def _silhouette(img: Image.Image, colour, alpha: int = 255) -> Image.Image:
    out = Image.new("RGBA", img.size, (*colour, 255))
    mask = img.split()[3].point(lambda v: (v * alpha) // 255)
    out.putalpha(mask)
    return out


def _outline_only(img: Image.Image, colour, width: int = 3) -> Image.Image:
    alpha = img.split()[3].point(lambda v: 255 if v > 40 else 0)
    grown = alpha
    for _ in range(max(1, width)):
        grown = grown.filter(ImageFilter.MaxFilter(3))
    edge = ImageChops.subtract(grown, alpha)
    out = Image.new("RGBA", img.size, (*colour, 255))
    out.putalpha(edge)
    return out


def _top_down(img: Image.Image, axis_px: float) -> Image.Image:
    """Stylised top-down view.

    The recipes are authored in profile, so a true top-down would need a second
    set of geometry.  Instead the profile is mirrored about the barrel axis and
    unioned with itself, which yields a symmetric body that reads correctly from
    above (and keeps the grip footprint).  Swap in real top-down recipes via
    ``recipes.PAINTERS`` if you need authored views.
    """
    flipped = img.transpose(Image.FLIP_TOP_BOTTOM)
    dy = int(round(2 * axis_px - img.size[1]))
    w, h = img.size
    shifted = flipped.transform((w, h), Image.AFFINE, (1, 0, 0, 0, 1, dy),
                                resample=Image.BICUBIC, fillcolor=(0, 0, 0, 0))
    base = img.copy()
    base.alpha_composite(shifted)
    return base


# --------------------------------------------------------------------------- #
# design cache
# --------------------------------------------------------------------------- #
#: Rasterising a recipe at ss=4 costs ~100ms+.  Every size and every export of the
#: same (slug, rarity, variant) shares one rasterised design, so a full 5-size
#: export renders each weapon once instead of five times.
_DESIGN_CACHE: "OrderedDict[str, Image.Image]" = OrderedDict()
_DESIGN_CACHE_MAX = 48   # ~1.2 MB per entry at ss=4


def _cache_key(opts: RenderOptions) -> str:
    overrides = tuple(sorted((opts.palette_overrides or {}).items()))
    return ("|".join([opts.slug, opts.rarity, opts.variant, str(opts.ss),
                      str(opts.seed), str(opts.glow), str(opts.glow_strength),
                      str(opts.padding), str(overrides)]))


def clear_cache() -> None:
    """Drop the design cache (call if you mutate palettes or recipes at runtime)."""
    _DESIGN_CACHE.clear()


def cache_info() -> dict:
    return {"entries": len(_DESIGN_CACHE), "max": _DESIGN_CACHE_MAX}


def _design_for(opts: RenderOptions, anchors_design: dict, colour: palettes.Palette):
    """Return the variant-processed, supersampled design image (cached)."""
    key = _cache_key(opts)
    cached = _DESIGN_CACHE.get(key)
    if cached is not None:
        _DESIGN_CACHE.move_to_end(key)
        return cached

    ss = opts.ss
    design = design_sprite(opts)
    # variant treatment happens in supersampled design space so edges stay smooth
    if opts.variant == "side_left":
        design = design.transpose(Image.FLIP_LEFT_RIGHT)
    elif opts.variant == "top_down":
        design = _top_down(design, anchors_design.get("axis", 20.0) * ss)
    elif opts.variant == "silhouette":
        design = _silhouette(design, colour["outline"])
    elif opts.variant == "outline":
        design = _outline_only(design, colour["accent"], width=max(1, int(ss * 0.7)))

    _DESIGN_CACHE[key] = design
    if len(_DESIGN_CACHE) > _DESIGN_CACHE_MAX:
        _DESIGN_CACHE.popitem(last=False)
    return design


# --------------------------------------------------------------------------- #
# step 3-4: pixel sprite
# --------------------------------------------------------------------------- #
def render(opts: RenderOptions) -> Sprite:
    if opts.variant not in VARIANTS:
        raise KeyError(f"unknown variant {opts.variant!r}; pick one of {VARIANTS}")
    slug = opts.slug
    if slug not in recipes.PAINTERS:
        raise KeyError(f"no recipe for {slug!r}")
    anchors_design = recipes.ANCHORS.get(slug, {"muzzle": (100.0, 20.0),
                                                "grip": (70.0, 40.0), "axis": 20.0})

    ss = opts.ss
    colour = palettes.build(opts.rarity, **(opts.palette_overrides or {}))
    design = _design_for(opts, anchors_design, colour)

    crop = _bbox_of(design, opts.padding * ss)
    art = design.crop(crop)

    # scale so the artwork height hits the requested pixel height
    target_h = max(1, int(opts.height))
    scale = target_h / art.size[1] if art.size[1] else 1.0
    target_w = max(1, int(round(art.size[0] * scale)))
    art = art.resize((target_w, target_h), Image.LANCZOS)

    canvas_w, canvas_h = target_w, target_h
    offset = (0, 0)
    if opts.square:
        side = max(target_w, target_h)
        canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        offset = ((side - target_w) // 2, (side - target_h) // 2)
        canvas.alpha_composite(art, offset)
        art = canvas
        canvas_w = canvas_h = side

    # design -> pixel transform.  ``scale`` maps supersampled pixels to output
    # pixels, so going from design units to output pixels needs ``ss * scale``.
    cx0, cy0 = crop[0] / ss, crop[1] / ss
    unit = ss * scale
    anchors_px: Dict[str, Tuple[float, float]] = {}
    anchors_uv: Dict[str, Tuple[float, float]] = {}
    design_w = recipes.DESIGN[0]
    mirror_axis = float(anchors_design.get("axis", 20.0))

    def to_design_space(name: str, ax: float, ay: float) -> Tuple[float, float]:
        """Map a time-of-authoring anchor into the (possibly transformed) design."""
        if opts.variant == "side_left":
            return (design_w - ax, ay)
        if opts.variant == "top_down" and name == "muzzle":
            # the barrel sits on the mirror line, so only it needs re-mapping; the
            # grip keeps its authored position below the bore
            return (ax, 2.0 * mirror_axis - ay)
        return (ax, ay)

    for name, value in anchors_design.items():
        if isinstance(value, (int, float)):        # scalar anchor, e.g. "axis": 21.5
            px = (0.0, (float(value) - cy0) * unit + offset[1])
        else:
            ax, ay = to_design_space(name, float(value[0]), float(value[1]))
            px = ((ax - cx0) * unit + offset[0], (ay - cy0) * unit + offset[1])
        anchors_px[name] = px
        anchors_uv[name] = (min(1.0, max(0.0, px[0] / canvas_w)),
                            min(1.0, max(0.0, px[1] / canvas_h)))

    return Sprite(image=art, slug=slug, rarity=opts.rarity, variant=opts.variant,
                  height=opts.height, anchors_px=anchors_px, anchors_uv=anchors_uv,
                  design_bbox=(cx0, cy0, crop[2] / ss, crop[3] / ss), scale=scale)


def render_set(slug: str, rarity: str = "common", height: int = 128,
               variants: Sequence[str] = ("side",), seed: Optional[int] = None,
               ss: int = 4, palette_overrides: Optional[Dict[str, str]] = None) -> Dict[str, Sprite]:
    """Render several variants of one weapon (cached by key inside the caller)."""
    out: Dict[str, Sprite] = {}
    for v in variants:
        opts = RenderOptions(slug=slug, rarity=rarity, height=height, variant=v, ss=ss,
                             seed=seed, palette_overrides=palette_overrides,
                             square=(v == "icon"))
        out[v] = render(opts)
    return out


def contact_sheet(slugs: Sequence[str], rarity: str = "common", cell: int = 256,
                  cols: int = 4, background=(18, 18, 24, 255),
                  label: bool = True, ss: int = 4) -> Image.Image:
    """A QA sheet: every weapon fitted inside its cell, grid-aligned.

    Cells are 16:9-ish boxes; each sprite is rendered large and LANCZOS-fitted so
    wide weapons never bleed into the neighbouring cell.
    """
    rows = (len(slugs) + cols - 1) // cols
    cell_h = int(cell * 0.62) if label else cell
    pad = max(4, cell // 24)
    sheet = Image.new("RGBA", (cols * cell, rows * cell_h), background)
    draw = ImageDraw.Draw(sheet)
    for i, slug in enumerate(slugs):
        r, c = divmod(i, cols)
        sprite = render(RenderOptions(slug=slug, rarity=rarity, height=max(64, cell // 2),
                                     variant="side", square=False, ss=ss)).image
        box_w, box_h = cell - 2 * pad, cell_h - 2 * pad - (16 if label else 0)
        scale = min(box_w / sprite.width, box_h / sprite.height)
        w = max(1, int(round(sprite.width * scale)))
        h = max(1, int(round(sprite.height * scale)))
        fitted = sprite.resize((w, h), Image.LANCZOS)
        x = c * cell + (cell - w) // 2
        y = r * cell_h + pad + (box_h - h) // 2
        sheet.alpha_composite(fitted, (x, y))
        if label:
            tw = draw.textlength(slug)
            draw.text((c * cell + (cell - tw) / 2, r * cell_h + cell_h - 20), slug,
                      fill=(210, 214, 225, 255))
        draw.rectangle((c * cell, r * cell_h, c * cell + cell - 1, r * cell_h + cell_h - 1),
                       outline=(44, 46, 58, 255))
    return sheet
