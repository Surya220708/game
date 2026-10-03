"""Muzzle flashes, projectiles and impacts -- the other half of a weapon set.

A weapon sprite on its own looks static in engine.  These effects use the same
:class:`~weapon_assets.pen.Pen` and the same rarity palette, so a legendary rifle
gets gold tracers with no extra authoring.

All effects are drawn in their own design space with the *origin* at the point
that should be pinned to the weapon's muzzle anchor (or to the projectile's
centre for ``impact``).
"""
from __future__ import annotations

from typing import Tuple

from PIL import Image

from . import palettes
from .pen import Pen, arc_points

DESIGN = (128.0, 64.0)
ORIGIN = (10.0, 32.0)


def _pen(design, rarity="common", ss=4, seed=None, overrides=None) -> Pen:
    palette = palettes.build(rarity, **(overrides or {}))
    return Pen(design, palette, ss=ss, seed=seed)


# --------------------------------------------------------------------------- #
# muzzle flashes (origin bottom-left-ish, flash extends to the right)
# --------------------------------------------------------------------------- #
def flash_bullet(p: Pen) -> None:
    p.poly([(8, 32), (46, 12), (34, 30), (52, 34), (32, 38), (44, 54), (8, 32)],
           role="energy", outline=1.2, light=1.6, dark=1.1)
    p.circle((12, 32), 9.0, role="energy", outline=1.2, light=1.7, dark=1.2, gradient=False)
    p.circle((10, 32), 4.6, role="white", outline=False, sheen=False, gradient=False)
    p.glow((14, 32), 26, "energy", 1.0)


def flash_heavy(p: Pen) -> None:
    p.poly([(6, 32), (62, 6), (44, 30), (72, 33), (42, 38), (60, 58), (6, 32)],
           role="energy", outline=1.3, light=1.6, dark=1.05)
    p.poly([(8, 32), (30, 20), (26, 32), (34, 40), (8, 32)], role="white", outline=False,
           sheen=False, light=1.5, dark=1.1)
    p.glow((18, 32), 34, "energy", 1.0)
    p.glow((40, 32), 22, "energy", 0.7)


def flash_energy(p: Pen) -> None:
    p.poly([(8, 32), (54, 18), (40, 30), (58, 33), (40, 37), (52, 47), (8, 32)],
           role="energy", outline=1.2, light=1.7, dark=1.15)
    p.ring((14, 32), 13.0, 3.2, role="white", outline=1.0)
    for i in range(3):
        pts = [(16 + i * 9, 32 + p.rnd(-5, 5)) for _ in range(2)]
        p.line(pts, width=1.6, role="energy_dark", outline=False, sheen=False, gradient=False)
    p.glow((16, 32), 30, "energy", 1.05)


def flash_plasma(p: Pen) -> None:
    p.circle((18, 32), 13.0, role="energy", outline=1.3, light=1.5, dark=0.95)
    p.circle((18, 32), 7.0, role="white", outline=False, sheen=False, gradient=False)
    for i in range(6):
        a = i * 60 + 15
        pts = arc_points(18, 32, 15 + p.rnd(0, 8), a, a + 26, steps=4)
        p.line(pts, width=2.4, role="energy", outline=False, sheen=False, gradient=False)
    p.glow((20, 32), 40, "energy", 1.1)


def flash_rocket(p: Pen) -> None:
    p.poly([(6, 32), (58, 14), (40, 30), (66, 33), (40, 38), (56, 52), (6, 32)],
           role="energy", outline=1.3, light=1.6, dark=1.0)
    p.poly([(4, 32), (34, 22), (30, 32), (36, 42), (4, 32)], role="white",
           outline=False, sheen=False, light=1.5, dark=1.15)
    for i in range(6):
        p.circle((20 + p.rnd(0, 26), 32 + p.rnd(-12, 12)), p.rnd(2.0, 4.4), role="dark",
                 outline=False, sheen=False, gradient=False)
    p.glow((22, 32), 42, "energy", 1.0)


def flash_melee(p: Pen) -> None:
    pts = arc_points(12, 32, 30, -62, 62, steps=18)
    p.line(pts, width=5.0, role="energy", outline=1.3, light=1.6, dark=1.0)
    pts2 = arc_points(12, 32, 40, -44, 44, steps=16)
    p.line(pts2, width=2.4, role="energy_dark", outline=False, sheen=False, gradient=False)
    p.glow((18, 32), 34, "energy", 0.9)


FLASHES = {
    "flash_bullet": flash_bullet,
    "flash_heavy": flash_heavy,
    "flash_energy": flash_energy,
    "flash_plasma": flash_plasma,
    "flash_rocket": flash_rocket,
    "flash_melee": flash_melee,
}

#: weapon catalog ``fx`` key -> muzzle flash recipe
FX_FLASH = {
    "bullet": "flash_bullet",
    "bullet_heavy": "flash_heavy",
    "pellet": "flash_bullet",
    "bolt_energy": "flash_energy",
    "beam_ion": "flash_energy",
    "rocket": "flash_rocket",
    "plasma": "flash_plasma",
    "arc": "flash_melee",
    "shockwave": "flash_melee",
}


# --------------------------------------------------------------------------- #
# projectiles (origin at centre)
# --------------------------------------------------------------------------- #
def proj_bullet(p: Pen) -> None:
    p.poly([(2, 4), (26, 4), (32, 8), (26, 12), (2, 12)], role="gold", outline=1.2,
           light=1.5, dark=0.75)
    p.line([(4, 8), (24, 8)], width=1.2, role="white", outline=False, sheen=False,
           gradient=False)


def proj_pellet(p: Pen) -> None:
    p.circle((10, 8), 5.0, role="gold", outline=1.2, light=1.5, dark=0.75)
    p.circle((8.4, 6.4), 1.8, role="white", outline=False, sheen=False, gradient=False)


def proj_bolt(p: Pen) -> None:
    p.poly([(2, 5), (26, 6), (34, 9), (26, 12), (2, 11)], role="energy", outline=1.2,
           light=1.6, dark=1.05)
    p.line([(4, 8.5), (26, 9)], width=2.0, role="white", outline=False, sheen=False,
           gradient=False)
    p.glow((18, 8.5), 16, "energy", 1.0)


def proj_plasma(p: Pen) -> None:
    p.circle((17, 17), 12.0, role="energy", outline=1.3, light=1.5, dark=0.9)
    p.circle((17, 17), 6.0, role="white", outline=False, sheen=False, gradient=False)
    p.glow((17, 17), 26, "energy", 1.05)


def proj_rocket(p: Pen) -> None:
    p.poly([(2, 14), (20, 4), (34, 9), (34, 19), (20, 24), (2, 14)], role="steel",
           outline=1.3, light=1.4, dark=0.7)
    p.poly([(34, 9), (44, 14), (34, 19)], role="dark", outline=1.2, light=1.3, dark=0.8)
    p.poly([(20, 4), (26, 0), (30, 8)], role="steel_dark", outline=1.1)
    p.poly([(20, 24), (26, 28), (30, 20)], role="steel_dark", outline=1.1)
    p.poly([(2, 10), (-8, 14), (2, 18)], role="energy", outline=False, light=1.5,
           dark=1.0, sheen=False)
    p.glow((-2, 14), 20, "energy", 0.95)


def proj_arc(p: Pen) -> None:
    pts = []
    for i in range(7):
        pts.append((4 + i * 5, 14 + p.rnd(-6, 6)))
    p.line(pts, width=3.0, role="energy", outline=1.1, light=1.6, dark=1.0)
    p.glow((18, 14), 20, "energy", 0.9)


PROJECTILES = {
    "proj_bullet": (proj_bullet, (36.0, 16.0)),
    "proj_pellet": (proj_pellet, (20.0, 16.0)),
    "proj_bolt": (proj_bolt, (38.0, 18.0)),
    "proj_plasma": (proj_plasma, (34.0, 34.0)),
    "proj_rocket": (proj_rocket, (48.0, 28.0)),
    "proj_arc": (proj_arc, (40.0, 28.0)),
}

#: weapon catalog ``fx`` key -> projectile recipe.  Beams use the bolt sprite as
#: their cross-section: stretch it along the beam axis and scroll its UVs.
FX_PROJECTILE = {
    "beam_ion": "proj_bolt",
    "bullet": "proj_bullet",
    "bullet_heavy": "proj_bullet",
    "pellet": "proj_pellet",
    "bolt_energy": "proj_bolt",
    "rocket": "proj_rocket",
    "plasma": "proj_plasma",
    "arc": "proj_arc",
}


# --------------------------------------------------------------------------- #
# impacts
# --------------------------------------------------------------------------- #
def impact_spark(p: Pen) -> None:
    for i in range(9):
        a = i * 40 + p.rnd(-8, 8)
        r = p.rnd(10, 22)
        pts = arc_points(24, 24, r, a, a + 12, steps=4)
        p.line(pts, width=p.rnd(1.6, 3.0), role="energy", outline=1.0, light=1.7,
               dark=1.1, gradient=False, sheen=False)
    p.circle((24, 24), 6.5, role="white", outline=1.1, sheen=False, gradient=False)
    p.glow((24, 24), 22, "energy", 1.0)


def impact_ring(p: Pen) -> None:
    p.ring((24, 22), 21.0, 3.6, role="energy", outline=1.2, light=1.5, dark=1.0)
    p.ring((24, 22), 13.0, 2.4, role="energy_dark", outline=False)
    p.ellipse((6, 10, 42, 34), role="energy", outline=False, light=1.4, dark=1.0)
    p.glow((24, 22), 30, "energy", 0.8)


EFFECTS = {
    **{k: (v, DESIGN) for k, v in FLASHES.items()},
    **{k: (v, d) for k, (v, d) in PROJECTILES.items()},
    "impact_spark": (impact_spark, (48.0, 48.0)),
    "impact_ring": (impact_ring, (48.0, 44.0)),
}

#: which point of the design canvas is pinned to the muzzle / projectile centre
EFFECT_ORIGINS = {
    "impact_spark": (24.0, 24.0),
    "impact_ring": (24.0, 22.0),
}


def effect_origin(name: str, design) -> Tuple[float, float]:
    if name in EFFECT_ORIGINS:
        return EFFECT_ORIGINS[name]
    if name.startswith("flash"):
        return ORIGIN
    if name.startswith("proj"):
        return (design[0] / 2.0, design[1] / 2.0)
    return (design[0] / 2.0, design[1] / 2.0)


def render_effect(name: str, rarity: str = "common", height: int = 64, ss: int = 4,
                  seed=None, palette_overrides=None) -> Image.Image:
    """Render one effect sprite, cropped tightly to its artwork."""
    from .render import _bbox_of

    fn, design = EFFECTS[name]
    pen = _pen(design, rarity, ss=ss, seed=seed if seed is not None else name,
               overrides=palette_overrides)
    fn(pen)
    img = pen.finish()
    # effects are additive in engine, so trim hard and keep the glow bloom
    crop = _bbox_of(img, 1.0 * ss)
    art = img.crop(crop)
    scale = height / art.size[1] if art.size[1] else 1.0
    return art.resize((max(1, int(round(art.size[0] * scale))), max(1, height)), Image.LANCZOS)


def effect_origin_uv(name: str) -> Tuple[float, float]:
    """Where the origin sits inside the *cropped* effect sprite (0..1)."""
    design = EFFECTS[name][1]
    ox, oy = effect_origin(name, design)
    # cropping is tight around the drawn art; flash art starts near the origin
    if name.startswith("flash"):
        return (0.06, 0.5)
    return (max(0.0, min(1.0, ox / design[0])), max(0.0, min(1.0, oy / design[1])))


def flash_for(fx: str) -> str:
    return FX_FLASH.get(fx, "flash_bullet")


def projectile_for(fx: str) -> str:
    return FX_PROJECTILE.get(fx, "proj_bullet")
