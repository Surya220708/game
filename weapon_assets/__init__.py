"""Procedural weapon assets: sprites, stats and export metadata from pure Python.

Quick start
-----------
>>> from weapon_assets import render, stats
>>> sprite = render.render(render.RenderOptions("rifle", rarity="epic", height=256))
>>> sprite.image.save("rifle_epic.png")
>>> sprite.anchors_px["muzzle"]
(247.1, 61.9)
>>> item = stats.build("rifle", "epic", level=24, seed=1234)
>>> round(item.stats.dps, 1)
661.4
>>> item.perks[0]["text"]
'+8% damage'

Command line
------------
    python -m weapon_assets render --weapon rifle --rarity epic --size 256 --out dist/
    python -m weapon_assets all --out dist/

See ``README.md`` for the full option list.
"""
from __future__ import annotations

from . import catalog, effects, palettes, recipes, reference, render, stats
from . import export as export_mod

__all__ = ["catalog", "effects", "palettes", "recipes", "reference", "render",
           "stats", "export_mod"]
__version__ = "1.0.0"
