"""Re-skin the set from a reference image.

Point this at concept art, a screenshot or a style-swap palette and it samples the
dominant colours, then assigns them to the roles the renderer uses (``body``,
``panel``, ``steel``, ``accent``, ``energy`` ...).  The geometry never changes, so
you get a whole matching weapon set in your project's palette::

    python -m weapon_assets reference --image refs/concept.png --out dist/refskin --weapons all

Role assignment is a heuristic, not magic -- override anything afterwards with
``palette_overrides`` / ``--set accent=#ff0044``.
"""
from __future__ import annotations

from typing import Dict, List, Optional, Sequence, Tuple

from PIL import Image

from .palettes import darken, hexstr, lighten, mix, saturate

#: roles that come from the sampled colours, in priority order
SAMPLE_ROLES = ("outline", "body", "panel", "steel", "accent", "energy", "grip", "gold")


def _luma(rgb: Sequence[float]) -> float:
    return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]


def _saturation(rgb: Sequence[float]) -> float:
    mx, mn = max(rgb), min(rgb)
    return 0.0 if mx == 0 else (mx - mn) / mx


def sample_colors(image: Image.Image, count: int = 8, ignore_alpha: bool = True,
                  trim: float = 0.02) -> List[Tuple[int, int, int]]:
    """Dominant colours by frequency, most frequent first."""
    img = image.convert("RGBA")
    if ignore_alpha:
        # drop fully transparent pixels (sprite sheets have lots of them)
        background = Image.new("RGBA", img.size, (0, 0, 0, 0))
        flat = Image.alpha_composite(background, img)
        pixels = [p for p in flat.getdata() if p[3] > 24]
        if not pixels:
            pixels = list(flat.getdata())
        img = Image.new("RGBA", (len(pixels), 1))
        img.putdata(pixels)
    quant = img.convert("RGB").quantize(colors=count, method=Image.MEDIANCUT)
    pal = quant.getpalette() or []
    counts = sorted(quant.getcolors() or [], reverse=True)
    total = sum(c for c, _ in counts) or 1
    out: List[Tuple[int, int, int]] = []
    for freq, index in counts:
        if freq / total < trim and out:
            continue
        out.append((pal[index * 3], pal[index * 3 + 1], pal[index * 3 + 2]))
    return out


def palette_from_image(image: Image.Image, name: Optional[str] = None,
                       accent_hint: Optional[Sequence[float]] = None) -> Dict[str, str]:
    """Build palette overrides (role -> hex) from a reference image."""
    colours = sample_colors(image, count=8)
    if not colours:
        return {}
    by_luma = sorted(colours, key=_luma)
    by_sat = sorted(colours, key=_saturation, reverse=True)

    darkest = by_luma[0]
    lightest = by_luma[-1]
    mids = by_luma[1:-1] or [mix(darkest, lightest, 0.5)]
    most_saturated = by_sat[0] if _saturation(by_sat[0]) > 0.25 else None
    accent = tuple(int(c) for c in accent_hint) if accent_hint else (
        most_saturated or mix(mids[0], lightest, 0.5))
    energy = lighten(accent, 0.45) if most_saturated else lighten(accent, 0.35)
    warm = max(colours, key=lambda c: c[0] - c[2])  # reddest = wood / grip
    grip = warm if (warm[0] - warm[2]) > 24 else mix(mids[0], darkest, 0.35)

    body = mids[len(mids) // 2]
    panel = darken(body, 0.28)
    steel = lighten(body, 0.30)
    overrides = {
        "outline": hexstr(darken(darkest, 0.45)),
        "shadow": hexstr(darken(darkest, 0.6)),
        "body": hexstr(body),
        "panel": hexstr(panel),
        "steel": hexstr(steel),
        "steel_dark": hexstr(darken(steel, 0.28)),
        "dark": hexstr(darken(panel, 0.42)),
        "darker": hexstr(darken(panel, 0.62)),
        "accent": hexstr(accent),
        "accent_dark": hexstr(darken(accent, 0.5)),
        "energy": hexstr(energy),
        "energy_dark": hexstr(darken(energy, 0.45)),
        "grip": hexstr(grip),
        "grip_dark": hexstr(darken(grip, 0.35)),
        "wood": hexstr(lighten(grip, 0.18)),
        "wood_dark": hexstr(darken(grip, 0.25)),
        "gold": hexstr(saturate(lighten(accent, 0.15), 0.3)),
        "white": hexstr(lighten(lightest, 0.35)),
    }
    if name:
        overrides["_name"] = name  # type: ignore[assignment]
    return overrides


def palette_from_file(path: str, crop: Optional[Tuple[int, int, int, int]] = None,
                      accent_hint: Optional[Sequence[float]] = None) -> Dict[str, str]:
    with Image.open(path) as im:
        if crop:
            im = im.crop(crop)
        return palette_from_image(im, name=path, accent_hint=accent_hint)


def image_to_weapon(path: str, slug: str, out_path: str, rarity: str = "rare",
                    height: int = 256, variant: str = "side", ss: int = 4,
                    accent_hint: Optional[Sequence[float]] = None) -> str:
    """Render one weapon using the palette sampled from ``path``."""
    from .render import RenderOptions, render

    overrides = {k: v for k, v in palette_from_file(path, accent_hint=accent_hint).items()
                 if not k.startswith("_")}
    sprite = render(RenderOptions(slug, rarity=rarity, height=height, variant=variant,
                                 ss=ss, palette_overrides=overrides))
    sprite.image.save(out_path, "PNG")
    return out_path
