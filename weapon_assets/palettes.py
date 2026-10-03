"""Colour palettes and the small colour helpers used by the sprite renderer.

A palette maps *role* names (``body``, ``accent``, ``energy`` ...) to colours, so
weapon recipes never hard-code a hex value: swap the palette and the same
geometry comes out as a grey "common" pistol or a gold "legendary" one.
"""
from __future__ import annotations

from typing import Dict, Mapping, Tuple

RGB = Tuple[int, int, int]

HEX = str


# --------------------------------------------------------------------------- #
# colour helpers
# --------------------------------------------------------------------------- #
def parse(color) -> RGB:
    """Accept ``"#aabbcc"``, ``"abc"`` or an ``(r, g, b)`` tuple -> (r, g, b)."""
    if isinstance(color, (tuple, list)):
        return (int(color[0]), int(color[1]), int(color[2]))
    c = str(color).lstrip("#")
    if len(c) == 3:
        c = "".join(ch * 2 for ch in c)
    if len(c) != 6:
        raise ValueError(f"cannot parse colour: {color!r}")
    return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


def clamp8(v: float) -> int:
    return 0 if v < 0 else 255 if v > 255 else int(round(v))


def scale_color(color, factor: float) -> RGB:
    """Multiply a colour's brightness (values > 1 lighten, < 1 darken)."""
    r, g, b = parse(color)
    return (clamp8(r * factor), clamp8(g * factor), clamp8(b * factor))


def lighten(color, amount: float = 0.25) -> RGB:
    r, g, b = parse(color)
    return (clamp8(r + (255 - r) * amount), clamp8(g + (255 - g) * amount), clamp8(b + (255 - b) * amount))


def darken(color, amount: float = 0.25) -> RGB:
    return scale_color(color, 1.0 - amount)


def mix(a, b, t: float) -> RGB:
    """Linear blend: ``t=0`` -> a, ``t=1`` -> b."""
    ra, ga, ba = parse(a)
    rb, gb, bb = parse(b)
    return (clamp8(ra + (rb - ra) * t), clamp8(ga + (gb - ga) * t), clamp8(ba + (bb - ba) * t))


def saturate(color, amount: float) -> RGB:
    """Push a colour away from / towards its own grey (``amount`` ~ -1..2)."""
    r, g, b = parse(color)
    grey = 0.299 * r + 0.587 * g + 0.114 * b
    f = 1.0 + amount
    return (clamp8(grey + (r - grey) * f), clamp8(grey + (g - grey) * f), clamp8(grey + (b - grey) * f))


def hexstr(color) -> str:
    r, g, b = parse(color)
    return "#{:02x}{:02x}{:02x}".format(r, g, b)


# --------------------------------------------------------------------------- #
# base material palette (the "steel and wood" of the set)
# --------------------------------------------------------------------------- #
BASE: Dict[str, HEX] = {
    "outline": "#141019",   # near-black used for every silhouette border
    "shadow": "#0b0910",
    "body": "#9aa3b0",      # main receiver metal
    "panel": "#6f7784",     # secondary / darker plate
    "steel": "#c3cad6",     # barrels, blades
    "steel_dark": "#7d8592",
    "dark": "#3a3b45",      # hardware, rails, bores
    "darker": "#25262d",
    "grip": "#7c4f33",      # rubber grip / pistol grip
    "grip_dark": "#5a3823",
    "wood": "#a2663d",      # stock and handguard furniture
    "wood_dark": "#6f3f24",
    "accent": "#6f7784",
    "accent_dark": "#4b525d",
    "gold": "#d8a63c",
    "white": "#eef2f8",
    "energy": "#8fe8ff",
    "energy_dark": "#3fa9cc",
}


# role -> fallback colours, filled in when a rarity does not define them
_DERIVED: Dict[str, str] = {
    "accent_dark": "accent",
    "energy_dark": "energy",
    "grip_dark": "grip",
}


# --------------------------------------------------------------------------- #
# rarities: each one re-tints accent / energy / trim of the same geometry
# --------------------------------------------------------------------------- #
RARITIES: Dict[str, dict] = {
    "common": {
        "label": "Common",
        "tier": 1,
        "accent": "#767e8a",
        "energy": "#9fd8e8",
        "gold": "#a9adb6",
        "panel": "#6f7784",
        "badge": "#8b929e",
    },
    "uncommon": {
        "label": "Uncommon",
        "tier": 2,
        "accent": "#3f9a4d",
        "energy": "#87f49b",
        "gold": "#b7c25a",
        "panel": "#5d7364",
        "badge": "#4caf50",
    },
    "rare": {
        "label": "Rare",
        "tier": 3,
        "accent": "#3a6fd8",
        "energy": "#7fd2ff",
        "gold": "#8fb6e8",
        "panel": "#546a92",
        "badge": "#4a8df0",
    },
    "epic": {
        "label": "Epic",
        "tier": 4,
        "accent": "#8a45d8",
        "energy": "#c98cff",
        "gold": "#b98ae0",
        "panel": "#6a5590",
        "badge": "#a05cf0",
    },
    "legendary": {
        "label": "Legendary",
        "tier": 5,
        "accent": "#d18a22",
        "energy": "#ffc65c",
        "gold": "#f0c04a",
        "panel": "#8d7240",
        "badge": "#f0a91e",
    },
    "mythic": {
        "label": "Mythic",
        "tier": 6,
        "accent": "#c8352f",
        "energy": "#ff7a5c",
        "gold": "#e05a4a",
        "panel": "#7c3b3b",
        "badge": "#e23b32",
    },
}

RARITY_ORDER = list(RARITIES.keys())


class Palette(Mapping[str, RGB]):
    """A role -> colour mapping, with derived roles filled in automatically."""

    def __init__(self, colours: Mapping[str, object]):
        self._c: Dict[str, RGB] = {k: parse(v) for k, v in colours.items()}

    def __getitem__(self, role: str) -> RGB:
        try:
            return self._c[role]
        except KeyError:
            if role in _DERIVED and _DERIVED[role] in self._c:
                return scale_color(self._c[_DERIVED[role]], 0.55)
            return self._c["body"]

    def __iter__(self):
        return iter(self._c)

    def __len__(self) -> int:
        return len(self._c)

    def rgba(self, role: str, alpha: int = 255) -> Tuple[int, int, int, int]:
        r, g, b = self[role]
        return (r, g, b, alpha)

    def with_overrides(self, **overrides) -> "Palette":
        merged = dict(self._c)
        merged.update({k: v for k, v in overrides.items() if v is not None})
        return Palette(merged)

    def as_hex(self) -> Dict[str, str]:
        return {k: hexstr(v) for k, v in self._c.items()}


def build(rarity: str = "common", **overrides) -> Palette:
    """Build the palette for a rarity, optionally overriding single roles."""
    if rarity not in RARITIES:
        raise KeyError(f"unknown rarity {rarity!r}; pick one of {RARITY_ORDER}")
    colours = dict(BASE)
    colours.update({k: v for k, v in RARITIES[rarity].items() if k in BASE or k == "accent"})
    # energy_dark / grip_dark track their parents
    colours["energy_dark"] = darken(colours["energy"], 0.45)
    colours["grip_dark"] = darken(colours["grip"], 0.35)
    colours["accent_dark"] = darken(colours["accent"], 0.45)
    colours["outline"] = mix(colours["outline"], colours["accent"], 0.18)
    colours.update({k: v for k, v in overrides.items() if v is not None})
    return Palette(colours)
