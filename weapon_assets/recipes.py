"""Weapon recipes: vector geometry for every sprite in the set.

Design space is 200 x 96 with ``y`` pointing down; the weapon sits on
``GROUND = 58`` and the barrel axis is usually around ``AXIS = 20``.  Nothing
here knows about pixels, output sizes or rarities -- a recipe just draws into the
:class:`~weapon_assets.pen.Pen` it is handed, which means the same code renders a
32px inventory icon and a 1024px loading-screen render.
"""
from __future__ import annotations

import math
from typing import Dict, List, Sequence

from .pen import Pen, arc_points

DESIGN = (200.0, 96.0)
GROUND = 58.0
AXIS = 20.0

Pt = Sequence[float]


# --------------------------------------------------------------------------- #
# shared sub-assemblies
# --------------------------------------------------------------------------- #
def grip(p: Pen, x_top: float, y_top: float, x_bot: float, width: float,
         height: float = 24.0, role: str = "grip", lean: float = 0.0,
         texture: bool = True) -> None:
    """A tilted pistol grip, lean given in design units (negative = leaning back)."""
    w_top = width
    w_bot = width * 0.82
    y_bot = y_top + height
    xb = x_bot + lean
    with p.group(role=role, outline=1.4):
        p.poly([(x_top - w_top / 2, y_top), (x_top + w_top / 2, y_top),
                (xb + w_bot / 2, y_bot), (xb - w_bot / 2, y_bot)], role=role)
    if texture:
        n = 7
        for i in range(1, n):
            t = i / n
            y = y_top + height * t
            xa = x_top + (xb - x_top) * t
            half = (w_top + (w_bot - w_top) * t) / 2 - 2.6
            # grooves run across the grip, so they tilt with its axis
            slope = (xb - x_top) / max(1e-3, height)
            p.line([(xa - half, y - half * slope), (xa + half, y + half * slope)],
                   width=1.3, role="grip_dark", outline=False, sheen=False, highlight=False,
                   gradient=False)
    # backstrap highlight
    p.line([(x_top - w_top / 2 + 1, y_top + 1), (xb - w_bot / 2 + 1, y_bot - 1)],
           width=1.2, role="grip", outline=False, sheen=False, highlight=False,
           gradient=False)


def guard(p: Pen, cx: float, cy: float, r: float, thickness: float = 2.4,
          a0: float = 15.0, a1: float = 165.0, role: str = "panel") -> None:
    """Trigger guard arc."""
    pts = arc_points(cx, cy, r, a0, a1, steps=10)
    p.line(pts, width=thickness, role=role, outline=1.2)


def trigger(p: Pen, x: float, y: float, h: float = 7.0) -> None:
    p.poly([(x, y), (x + 2.6, y), (x + 2.0, y + h), (x - 1.0, y + h * 0.9)],
           role="dark", outline=1.0, sheen=False)


def rail(p: Pen, x0: float, y0: float, x1: float, height: float = 6.0,
         slots: int = 7, role: str = "dark") -> None:
    """Picatinny-ish rail with slot notches."""
    p.rect((x0, y0, x1, y0 + height), radius=1.0, role=role, outline=1.3)
    if slots > 0 and (x1 - x0) > 8:
        step = (x1 - x0 - 4) / slots
        for i in range(slots):
            x = x0 + 2.5 + step * (i + 0.5)
            p.rect((x - 0.7, y0 + 1.1, x + 0.7, y0 + height - 1.1), radius=0.6,
                   role="darker", outline=False, sheen=False)


def serrations(p: Pen, x0: float, x1: float, y0: float, y1: float, n: int = 5,
               role: str = "darker") -> None:
    step = (x1 - x0) / max(1, n)
    for i in range(n):
        x = x0 + step * (i + 0.5)
        p.line([(x, y0), (x, y1)], width=1.1, role=role, outline=False, sheen=False,
               highlight=False, gradient=False)


def rivets(p: Pen, points: Sequence[Pt], r: float = 1.0, role: str = "steel") -> None:
    p.dots(points, radius=r, role=role, outline=False, sheen=False, gradient=True)


def vents(p: Pen, x0: float, y0: float, x1: float, y1: float, n: int = 4,
          role: str = "darker") -> None:
    step = (x1 - x0) / n
    for i in range(n):
        x = x0 + step * i
        p.rect((x, y0, x + step * 0.55, y1), radius=0.8, role=role, outline=False,
               sheen=False)


def stock_solid(p: Pen, x0: float, x1: float, y_top: float, y_bot: float,
                butt: float = 6.0, role: str = "wood") -> None:
    """Wooden/composite butt-stock sloping back and down."""
    with p.group(role=role, outline=1.4):
        p.poly([(x1, y_top), (x0 + butt, y_top + 3), (x0, y_bot - 4), (x1, y_bot)], role=role)
    p.rect((x0 - 1, y_top + 3, x0 + butt * 0.55, y_bot - 3), radius=2.0, role="dark",
           outline=1.2, sheen=False)
    p.line([(x0 + butt + 2, y_top + 6), (x1 - 2, y_top + 5)], width=1.0, role="wood_dark",
           outline=False, sheen=False, highlight=False, gradient=False)


def wire_stock(p: Pen, x_tip: float, x_rear: float, y_top: float, y_bot: float) -> None:
    """Skeletal folding stock: two rails plus a butt plate."""
    p.line([(x_tip, y_top + 3), (x_rear, y_top + 1)], width=2.4, role="dark", outline=1.2)
    p.line([(x_tip, y_bot - 3), (x_rear, y_bot - 1)], width=2.4, role="dark", outline=1.2)
    p.rect((x_rear - 5, y_top - 1, x_rear + 2, y_bot + 1), radius=2.0, role="panel",
           outline=1.3)


def magazine_curved(p: Pen, x: float, y: float, w: float, h: float, curve: float,
                    role: str = "dark") -> None:
    """Banana magazine: sweeps forward as it goes down."""
    steps = 5
    left: List[Pt] = []
    right: List[Pt] = []
    for i in range(steps + 1):
        t = i / steps
        yy = y + h * t
        off = curve * t * t
        left.append((x + off, yy))
        right.append((x + w + off * 0.55, yy))
    with p.group(role=role, outline=1.4):
        p.poly(left + list(reversed(right)), role=role)
    for i in range(3):
        t = 0.25 + i * 0.25
        yy = y + h * t
        off = curve * t * t
        p.line([(x + off + 1, yy), (x + w + off * 0.55 - 1, yy)], width=0.9, role="darker",
               outline=False, sheen=False, highlight=False, gradient=False)


def muzzle_brake(p: Pen, x0: float, x1: float, y0: float, y1: float, slots: int = 3,
                 role: str = "steel") -> None:
    p.rect((x0, y0, x1, y1), radius=1.6, role=role, outline=1.4)
    for i in range(slots):
        t = (i + 0.5) / slots
        x = x0 + (x1 - x0) * t
        p.rect((x - 0.9, y0 - 2.0, x + 0.9, y0 + 1.5), radius=0.6, role="darker",
               outline=False, sheen=False)
        p.rect((x - 0.9, y1 - 1.5, x + 0.9, y1 + 2.0), radius=0.6, role="darker",
               outline=False, sheen=False)


def flame(p: Pen, cx: float, cy: float, length: float, width: float, seed_pts: int = 7) -> None:
    """Wispy pilot flame -- randomised so every export looks hand-drawn."""
    pts: List[Pt] = [(cx, cy - width / 2), (cx, cy + width / 2)]
    for i in range(seed_pts):
        t = (i + 1) / (seed_pts + 1)
        pts.append((cx + length * t, cy + p.rnd(-width * 0.45, width * 0.45) * (1 - t)))
    pts.append((cx + length, cy))
    pts.sort(key=lambda q: math.atan2(q[1] - cy, q[0] - cx) if q[0] > cx else math.pi)
    p.poly([(cx, cy - width / 2)] +
           [(cx + length * ((i + 1) / 5), cy + (width / 2) * math.sin(i * 2.1) * 0.6)
            for i in range(5)] +
           [(cx, cy + width / 2)], role="energy", outline=1.1, light=1.35, dark=0.9)


# --------------------------------------------------------------------------- #
# firearms
# --------------------------------------------------------------------------- #
def pistol(p: Pen) -> None:
    rail(p, 44, 6.5, 104, height=5.0, slots=6)
    # slide + frame
    with p.group(role="body", outline=1.5):
        p.poly([(28, 11), (126, 11), (128, 17), (128, 30), (96, 30), (92, 34), (28, 34)],
               role="body")
    serrations(p, 104, 124, 14, 28, n=5)
    p.rect((88, 15, 104, 22), radius=1.4, role="darker", outline=1.2, sheen=False)  # ejection port
    p.line([(30, 30.5), (90, 30.5)], width=1.2, role="dark", outline=False, sheen=False,
           highlight=False, gradient=False)
    # sights: rear notch + front post
    p.rect((30, 8.5, 40, 12), radius=1.0, role="dark", outline=1.1, sheen=False)
    p.rect((34, 8.0, 36, 12), radius=0.6, role="shadow", outline=False, sheen=False,
           gradient=False)
    p.rect((124, 6.0, 129, 12), radius=1.0, role="dark", outline=1.1, sheen=False)
    # barrel + compensator
    p.rect((124, 15.5, 141, 25.5), radius=2.0, role="steel", outline=1.4)
    p.rect((137, 13, 147, 28), radius=1.8, role="steel_dark", outline=1.3)
    vents(p, 139, 15, 145, 26, n=2, role="darker")
    p.circle((147.6, 20.5), 3.3, role="darker", outline=1.2, sheen=False)
    # frame / dust cover
    p.rect((28, 28, 96, 39), radius=2.4, role="panel", outline=1.4)
    p.rect((34, 31, 58, 36.5), radius=1.4, role="darker", outline=False, sheen=False)
    # hammer spur + beavertail
    p.poly([(24, 22), (25, 13), (31, 9.5), (36.5, 14), (36.5, 20)], role="steel_dark",
           outline=1.3, light=1.3, dark=0.7)
    rivets(p, [(38, 33.5), (30, 33.5), (86, 33.5)])
    # grip, guard, trigger  (grip sits under the rear of the dust cover)
    grip(p, 84, 33, 76, 21, height=25, lean=-8)
    guard(p, 84, 39, 11.6, 2.8, 14, 154)
    trigger(p, 84, 39.5)
    p.line([(82, 46.5), (88, 46.5)], width=1.0, role="dark", outline=False, sheen=False,
           highlight=False, gradient=False)


def revolver(p: Pen) -> None:
    # frame + barrel
    with p.group(role="body", outline=1.5):
        p.poly([(44, 10), (122, 10), (126, 15), (126, 31), (44, 31), (40, 22)], role="body")
    p.rect((118, 13.5, 168, 26.5), radius=2.2, role="steel", outline=1.4)
    p.rect((120, 11.5, 166, 15), radius=1.2, role="steel_dark", outline=1.1)  # top rib
    p.circle((167.4, 20.0), 3.6, role="darker", outline=1.2, sheen=False)     # bore
    p.rect((112, 26, 152, 32), radius=2.0, role="panel", outline=1.3)  # underlug
    p.rect((152, 24, 166, 27.5), radius=1.2, role="steel_dark", outline=1.1)  # ejector rod
    p.rect((148, 10, 156, 14), radius=1.0, role="steel_dark", outline=1.2)  # front sight
    p.poly([(40, 8), (54, 8), (56, 14), (42, 16)], role="steel_dark", outline=1.3)  # hammer spur
    p.rect((52, 12, 58, 20), radius=1.4, role="dark", outline=1.2)  # hammer
    # cylinder: fluted body, chamber mouths, crane pin
    p.rect((76, 11, 114, 33), radius=6.0, role="panel", outline=1.5)
    for i in range(4):
        cx = 84 + i * 7.4
        p.rect((cx - 1.7, 13, cx + 1.7, 31), radius=1.6, role="dark", outline=False,
               sheen=False, light=1.1, dark=0.8)
    for i in range(4):
        cx = 84 + i * 7.4
        p.circle((cx, 22), 2.9, role="darker", outline=1.1, sheen=False)
        p.circle((cx - 0.5, 21.0), 1.2, role="steel_dark", outline=False, sheen=False,
                 gradient=False)
    p.rect((112, 12, 116, 32), radius=1.4, role="steel_dark", outline=1.2)
    p.circle((114, 22), 2.6, role="steel", outline=1.1, gradient=False, sheen=False)  # crane pin
    p.glow((84, 22), 9, "energy", 0.16)
    # grip
    grip(p, 66, 30, 56, 23, height=27, lean=-10)
    p.rect((56, 32, 76, 38), radius=2.0, role="grip_dark", outline=1.2, sheen=False)
    guard(p, 70, 38, 13.0, 2.6, 8, 150)
    trigger(p, 70, 39)
    rivets(p, [(48, 26), (48, 16)], 0.9)


def shotgun(p: Pen) -> None:
    # stock + receiver
    stock_solid(p, 14, 62, 14, 38, butt=7)
    with p.group(role="body", outline=1.5):
        p.poly([(56, 9), (124, 9), (128, 15), (128, 37), (56, 38)], role="body")
    rail(p, 62, 29.5, 116, height=5.0, slots=6)
    p.rect((64, 14, 100, 20), radius=1.4, role="darker", outline=1.1, sheen=False)
    serrations(p, 100, 122, 13, 33, n=4)
    # barrel + tube magazine
    p.rect((122, 11.5, 188, 24.5), radius=2.6, role="steel", outline=1.4)
    p.rect((122, 26, 178, 34), radius=2.4, role="panel", outline=1.3)
    p.rect((176, 9.5, 189, 26.5), radius=1.8, role="steel_dark", outline=1.3)  # choke
    vents(p, 178, 12, 186, 24, n=3, role="darker")
    p.circle((188.5, 18), 3.4, role="darker", outline=1.2, sheen=False)
    p.rect((158, 7, 164, 12), radius=1.0, role="steel_dark", outline=1.2)  # bead sight
    # pump handle
    with p.group(role="wood", outline=1.4):
        p.rect((136, 24, 172, 40), radius=4.0, role="wood")
    for i in range(5):
        x = 140 + i * 7
        p.rect((x, 26, x + 3.2, 38), radius=1.4, role="wood_dark", outline=False, sheen=False)
    # grip + trigger
    grip(p, 74, 36, 68, 18, height=22, lean=-7)
    guard(p, 70, 40, 11.5, 2.4, 8, 150)
    trigger(p, 70, 41)
    rivets(p, [(60, 22), (60, 32), (120, 18), (120, 31)])


def smg(p: Pen) -> None:
    wire_stock(p, 48, 12, 16, 40)
    with p.group(role="body", outline=1.5):
        p.poly([(44, 11), (130, 11), (134, 17), (134, 36), (44, 38)], role="body")
    rail(p, 62, 5.5, 122, height=5.5, slots=8)
    p.rect((94, 13, 126, 22), radius=1.6, role="darker", outline=1.2, sheen=False)
    serrations(p, 96, 128, 24, 34, n=4)
    # barrel + brake
    p.rect((130, 15, 168, 31), radius=2.6, role="steel", outline=1.4)
    muzzle_brake(p, 164, 182, 11, 35, slots=3)
    p.circle((182, 23), 3.6, role="darker", outline=1.2, sheen=False)
    p.rect((124, 8, 132, 15), radius=1.2, role="dark", outline=1.2)  # front sight
    p.circle((86, 9), 3.4, role="dark", outline=1.2, gradient=False)  # charging handle
    # magazine
    magazine_curved(p, 76, 36, 18, 34, -7.0, role="dark")
    # grip + trigger
    grip(p, 60, 36, 52, 21, height=24, lean=-8)
    guard(p, 78, 40, 12.0, 2.4, 8, 150)
    trigger(p, 78, 41)
    rivets(p, [(50, 18), (50, 32), (116, 16), (116, 32)])


def rifle(p: Pen) -> None:
    stock_solid(p, 10, 60, 14, 38, butt=8)
    with p.group(role="body", outline=1.5):
        p.poly([(54, 10), (126, 10), (130, 16), (130, 36), (54, 38)], role="body")
    rail(p, 60, 4.5, 118, height=5.5, slots=8)
    p.rect((96, 12, 128, 21), radius=1.6, role="darker", outline=1.2, sheen=False)
    # handguard
    with p.group(role="panel", outline=1.4):
        p.rect((126, 13, 172, 33), radius=4.0, role="panel")
    vents(p, 132, 18, 166, 23, n=4, role="darker")
    vents(p, 132, 25, 166, 30, n=4, role="darker")
    # barrel + brake
    p.rect((168, 18, 190, 26.5), radius=2.2, role="steel", outline=1.4)
    muzzle_brake(p, 182, 196, 14, 30, slots=3)
    p.circle((196.5, 20.5), 3.4, role="darker", outline=1.2, sheen=False)
    p.rect((154, 6, 160, 13), radius=1.2, role="steel_dark", outline=1.2)  # front sight post
    p.rect((92, 4, 106, 8), radius=1.2, role="dark", outline=1.2)  # rear sight
    serrations(p, 108, 126, 12, 34, n=3)
    # magazine (banana)
    magazine_curved(p, 72, 36, 20, 32, -8.5, role="dark")
    grip(p, 58, 36, 50, 21, height=25, lean=-9)
    guard(p, 76, 40, 12.5, 2.6, 8, 150)
    trigger(p, 76, 41)
    rivets(p, [(58, 18), (58, 32), (122, 17), (122, 31)])


def sniper(p: Pen) -> None:
    stock_solid(p, 8, 62, 12, 40, butt=9)
    p.rect((16, 8, 46, 16), radius=3.0, role="dark", outline=1.3)  # cheek riser
    with p.group(role="body", outline=1.5):
        p.poly([(54, 12), (128, 12), (132, 18), (132, 34), (54, 36)], role="body")
    # scope
    p.rect((56, 0.5, 118, 11), radius=5.0, role="darker", outline=1.4)
    p.rect((58, 2.5, 116, 6.0), radius=2.0, role="dark", outline=False, sheen=False)
    p.circle((118, 5.7), 5.4, role="dark", outline=1.3, gradient=False)
    p.circle((118.6, 5.7), 3.6, role="energy", outline=False, sheen=False, gradient=True)
    p.glow((118.6, 5.7), 9, "energy", 0.45)
    p.rect((70, 10, 78, 15), radius=1.4, role="dark", outline=1.2)
    p.rect((100, 10, 108, 15), radius=1.4, role="dark", outline=1.2)
    p.circle((68, 5.7), 3.0, role="steel_dark", outline=1.2, gradient=False)  # turret
    # barrel + brake
    p.rect((126, 17, 186, 24.5), radius=2.2, role="steel", outline=1.4)
    muzzle_brake(p, 178, 192, 13, 28.5, slots=3)
    p.circle((192.4, 20.5), 3.2, role="darker", outline=1.2, sheen=False)
    # magazine + bipod
    magazine_curved(p, 84, 34, 18, 16, -1.5, role="dark")
    p.line([(148, 27), (136, 54)], width=2.2, role="dark", outline=1.2)
    p.line([(148, 27), (160, 54)], width=2.2, role="dark", outline=1.2)
    p.line([(133, 54), (139, 54)], width=2.0, role="steel_dark", outline=1.1)
    p.line([(157, 54), (163, 54)], width=2.0, role="steel_dark", outline=1.1)
    grip(p, 60, 34, 52, 20, height=26, lean=-9)
    guard(p, 78, 38, 12.5, 2.6, 8, 150)
    trigger(p, 78, 39)
    rivets(p, [(62, 18), (62, 30), (124, 18), (124, 30)])


def minigun(p: Pen) -> None:
    # rotating barrel cluster
    for i in range(6):
        y = 8.0 + i * 4.3
        role = "steel" if i % 2 == 0 else "steel_dark"
        p.rect((102, y, 176, y + 3.5), radius=1.6, role=role, outline=1.2)
    p.rect((108, 5.5, 117, 39.5), radius=3.0, role="panel", outline=1.4)   # bearing collars
    p.rect((137, 5.5, 147, 39.5), radius=3.0, role="panel", outline=1.4)
    # muzzle: collar face with visible bores
    p.rect((172, 4.5, 183, 40.5), radius=3.4, role="dark", outline=1.4)
    p.ellipse((177, 6, 193, 39), role="steel", outline=1.4, light=1.3, dark=0.72)
    p.circle((188.0, 12.5), 3.1, role="darker", outline=1.1, sheen=False)
    p.circle((189.2, 22.5), 3.6, role="darker", outline=1.1, sheen=False)
    p.circle((188.0, 32.5), 3.1, role="darker", outline=1.1, sheen=False)
    p.glow((196, 22.5), 12, "energy", 0.35)
    # receiver / drive motor
    with p.group(role="body", outline=1.5):
        p.poly([(48, 9), (104, 8), (108, 14), (108, 38), (48, 39), (44, 33), (44, 15)], role="body")
    p.rect((52, 12.5, 100, 18), radius=2.0, role="darker", outline=1.2, sheen=False)
    p.rect((52, 30.5, 100, 36), radius=2.0, role="darker", outline=1.2, sheen=False)
    p.circle((76, 24), 8.6, role="panel", outline=1.4, gradient=True)
    p.circle((76, 24), 3.6, role="darker", outline=1.2, sheen=False)
    p.line([(66, 24), (70, 24)], width=1.6, role="steel", outline=False, sheen=False,
           highlight=False, gradient=False)
    p.glow((76, 24), 11, "energy", 0.22)
    # feed chute + ammo belt into the drum
    p.rect((52, 37, 84, 50), radius=3.0, role="dark", outline=1.4)
    for i in range(4):
        x = 56 + i * 7.2
        p.rect((x, 39, x + 3.4, 48), radius=1.4, role="gold", outline=1.0, sheen=False,
               light=1.2, dark=0.85)
    for i in range(3):
        x = 62 + i * 7.0
        p.poly([(x, 50), (x + 5.6, 50), (x + 8.6, 58), (x + 3.0, 58)], role="gold",
               outline=1.0, sheen=False, light=1.2, dark=0.85)
    p.circle((84, 63), 15.5, role="panel", outline=1.5, gradient=True)
    p.ring((84, 63), 12.0, 2.4, role="steel_dark", outline=False)
    p.circle((84, 63), 5.4, role="darker", outline=1.2, sheen=False)
    p.circle((84, 63), 2.2, role="steel", outline=False, sheen=False, gradient=False)
    # spade grips with a rear mounting plate
    p.rect((18, 11, 44, 35), radius=3.0, role="panel", outline=1.4)
    p.rect((22, 12.5, 40, 17), radius=1.6, role="darker", outline=1.1, sheen=False)
    grip(p, 25, 14, 21, 12, height=19, lean=-2, texture=False)
    grip(p, 39, 14, 35, 12, height=19, lean=-2, texture=False)
    guard(p, 32, 41, 14.0, 2.8, 12, 150)
    trigger(p, 33, 42)
    rivets(p, [(50, 21), (50, 33), (104, 21), (104, 34)], 0.9)


def rocket_launcher(p: Pen) -> None:
    # venturi exhaust
    with p.group(role="dark", outline=1.5):
        p.poly([(30, 7), (8, 1), (8, 43), (30, 37)], role="dark")
    p.ellipse((4, 6, 16, 38), role="darker", outline=1.3, gradient=True)
    # main tube
    with p.group(role="panel", outline=1.5):
        p.rect((24, 6, 182, 38), radius=8.0, role="panel")
    p.rect((24, 6, 182, 13), radius=5.0, role="dark", outline=False, sheen=False)
    p.rect((24, 31, 182, 38), radius=5.0, role="dark", outline=False, sheen=False)
    for x in (60, 104, 148):
        p.rect((x, 4, x + 7, 40), radius=2.6, role="dark", outline=1.3)
    # warhead nose
    p.poly([(182, 4), (196, 21), (182, 38)], role="steel", outline=1.4, light=1.35, dark=0.7)
    p.line([(184, 10), (192, 19)], width=1.4, role="steel_dark", outline=False, sheen=False,
           highlight=False, gradient=False)
    p.circle((192, 21), 4.0, role="dark", outline=1.2, sheen=False)
    p.glow((192, 21), 11, "energy", 0.35)
    # sights, shoulder rest, grip
    p.rect((86, 0, 108, 7), radius=2.0, role="dark", outline=1.3)
    p.rect((94, 0, 98, 11), radius=1.0, role="steel_dark", outline=1.1)
    p.rect((34, 38, 74, 50), radius=3.0, role="dark", outline=1.4)
    vents(p, 40, 41, 68, 47, n=3, role="darker")
    grip(p, 100, 36, 92, 20, height=24, lean=-8)
    guard(p, 118, 40, 12.0, 2.4, 8, 150)
    trigger(p, 118, 41)
    rivets(p, [(46, 12), (46, 32), (130, 12), (130, 32)])


# --------------------------------------------------------------------------- #
# energy weapons
# --------------------------------------------------------------------------- #
def energy_pistol(p: Pen) -> None:
    rail(p, 50, 6.0, 106, height=5.0, slots=6)
    with p.group(role="panel", outline=1.5):
        p.poly([(34, 11), (120, 11), (124, 17), (124, 30), (92, 30), (88, 34), (34, 34)], role="panel")
    # heat fins
    for i in range(5):
        x = 58 + i * 8
        p.rect((x, 3.5, x + 4.0, 11), radius=1.2, role="steel_dark", outline=1.2)
    # barrel + emitter
    p.rect((118, 15, 142, 28), radius=2.6, role="steel", outline=1.4)
    p.ring((140, 21.5), 8.4, 4.0, role="steel_dark", outline=1.4)
    p.circle((140, 21.5), 4.6, role="energy", outline=1.2, light=1.4, dark=0.95, gradient=False)
    p.glow((140, 21.5), 14, "energy", 0.85)
    # energy cell
    p.rect((50, 27, 88, 43), radius=4.0, role="dark", outline=1.4)
    p.rect((54, 30.5, 84, 39.5), radius=2.4, role="energy", outline=False, light=1.35,
           dark=0.95)
    p.glow((69, 35), 16, "energy", 0.45)
    for i in range(3):
        x = 54 + i * 10.5
        p.line([(x, 30), (x, 40)], width=1.0, role="darker", outline=False, sheen=False,
               highlight=False, gradient=False)
    # grip + trigger
    grip(p, 74, 33, 66, 21, height=25, lean=-9)
    guard(p, 66, 38, 12.4, 2.6, 8, 150)
    trigger(p, 66, 39)
    p.line([(88, 24), (108, 22.5)], width=1.6, role="energy_dark", outline=False,
           sheen=False, highlight=False, gradient=False)


def plasma_cannon(p: Pen) -> None:
    # spine heat vanes
    for i in range(4):
        x = 50 + i * 17
        p.rect((x, 0.5, x + 10, 8), radius=2.0, role="steel_dark", outline=1.3)
        p.line([(x + 2.5, 3), (x + 7.5, 3)], width=1.2, role="darker", outline=False,
               sheen=False, highlight=False, gradient=False)
    with p.group(role="body", outline=1.5):
        p.poly([(38, 7), (128, 7), (134, 14), (134, 42), (38, 44)], role="body")
    # machined side plates + panel breaks
    p.rect((44, 13, 122, 21), radius=2.4, role="darker", outline=1.2, sheen=False)
    p.rect((44, 34, 122, 40), radius=2.4, role="darker", outline=1.2, sheen=False)
    p.rect((70, 22, 116, 33), radius=2.0, role="panel", outline=1.2, sheen=False)
    for x in (78, 92, 106):
        p.line([(x, 23.5), (x, 31.5)], width=1.0, role="darker", outline=False, sheen=False,
               highlight=False, gradient=False)
    rivets(p, [(48, 17), (48, 37), (62, 27), (128, 27)], 1.0)
    # accelerator tube: dark core channel wrapped in visible coils
    p.rect((124, 15, 168, 35), radius=3.0, role="steel", outline=1.4)
    p.rect((128, 19.5, 164, 30.5), radius=2.4, role="dark", outline=1.2, sheen=False)
    for i in range(4):
        x = 131 + i * 9.0
        p.ring((x, 25), 10.6, 3.4, role="steel_dark", outline=1.3)
        p.line([(x - 3, 17.5), (x + 3, 17.5)], width=1.0, role="darker", outline=False,
               sheen=False, highlight=False, gradient=False)
    p.line([(132, 25), (162, 25)], width=2.2, role="energy", outline=False, light=1.35,
           dark=0.95, gradient=False, sheen=False)
    # muzzle emitter
    p.ring((172, 25), 11.0, 5.0, role="steel", outline=1.5)
    p.circle((172, 25), 6.4, role="energy", outline=1.3, light=1.4, dark=0.95, gradient=False)
    p.glow((172, 25), 20, "energy", 0.80)
    # plasma canister slung under the barrel
    p.rect((92, 34, 148, 56), radius=7.0, role="dark", outline=1.5)
    p.rect((97, 38, 143, 52), radius=4.0, role="energy", outline=False, light=1.28, dark=0.9)
    for i in range(3):
        x = 106 + i * 12
        p.rect((x, 36, x + 2.6, 54), radius=1.2, role="darker", outline=False, sheen=False)
    p.glow((120, 45), 15, "energy", 0.20)
    # pistol grip + trigger
    grip(p, 62, 41, 54, 21, height=24, lean=-8)
    guard(p, 82, 44, 12.6, 2.6, 8, 152)
    trigger(p, 82, 45)
    rivets(p, [(56, 30), (68, 30), (80, 30), (92, 30), (104, 30), (116, 30)], 1.0)


def laser_smg(p: Pen) -> None:
    wire_stock(p, 50, 14, 18, 38)
    with p.group(role="body", outline=1.5):
        p.poly([(46, 13), (124, 13), (128, 19), (128, 38), (46, 40)], role="body")
    # heat sink fins
    for i in range(7):
        x = 58 + i * 9
        p.rect((x, 5, x + 4.5, 13), radius=1.4, role="steel_dark", outline=1.2)
    p.rect((54, 6.5, 120, 12), radius=2.0, role="dark", outline=1.3)
    # emitter
    p.rect((122, 17, 156, 34), radius=3.0, role="steel", outline=1.4)
    p.line([(126, 25.5), (150, 25.5)], width=3.0, role="energy", outline=False, light=1.4,
           dark=0.95, gradient=False)
    for i in range(3):
        p.ring((146 + i * 5, 25.5), 7.6 - i * 1.2, 2.6, role="steel_dark", outline=1.2)
    p.circle((156, 25.5), 4.2, role="energy", outline=1.2, light=1.4, dark=0.95, gradient=False)
    p.glow((156, 25.5), 18, "energy", 0.9)
    # battery
    p.rect((54, 38, 104, 58), radius=5.0, role="dark", outline=1.4)
    p.rect((58, 41.5, 100, 54.5), radius=3.0, role="energy", outline=False, light=1.3, dark=0.9)
    p.glow((79, 48), 18, "energy", 0.35)
    for i in range(4):
        x = 62 + i * 11
        p.line([(x, 42), (x, 54)], width=1.0, role="darker", outline=False, sheen=False,
               highlight=False, gradient=False)
    p.line([(104, 46), (120, 33)], width=2.2, role="energy_dark", outline=False,
           sheen=False, highlight=False, gradient=False)
    grip(p, 62, 38, 54, 21, height=24, lean=-8)
    guard(p, 80, 42, 12.0, 2.4, 8, 150)
    trigger(p, 80, 43)
    p.circle((90, 9), 3.2, role="dark", outline=1.2, gradient=False)


# --------------------------------------------------------------------------- #
# melee / heavy
# --------------------------------------------------------------------------- #
def shock_baton(p: Pen) -> None:
    # pommel
    p.circle((36, 21), 8.0, role="steel", outline=1.4, gradient=True)
    p.circle((36, 21), 3.0, role="darker", outline=1.2, sheen=False)
    p.line([(24, 21), (30, 21)], width=2.0, role="steel_dark", outline=1.1)
    # shaft + grip wrap
    p.rect((36, 16, 152, 26), radius=3.0, role="dark", outline=1.4)
    p.rect((58, 15, 100, 27), radius=3.0, role="grip", outline=1.3)
    for i in range(6):
        x = 62 + i * 6.2
        p.line([(x, 16), (x + 4.0, 26)], width=1.2, role="grip_dark", outline=False,
               sheen=False, highlight=False, gradient=False)
    for i in range(6):
        x = 106 + i * 6.5
        p.rect((x, 14.5, x + 2.6, 27.5), radius=1.0, role="panel", outline=1.1)
    # contact head
    with p.group(role="steel", outline=1.5):
        p.poly([(148, 7), (178, 5), (178, 37), (148, 35)], role="steel")
    p.rect((148, 7, 155, 35), radius=1.6, role="steel_dark", outline=1.2)
    p.rect((156, 12, 174, 30), radius=2.0, role="dark", outline=1.2, sheen=False)
    # prongs: top and bottom tines
    for y0, y1 in ((5.0, 0.5), (32.5, 37.0)):
        p.poly([(178, y0), (192, y1 + 1.5), (192, y1 + 5.0), (178, y0 + 4.0)],
               role="steel_dark", outline=1.3, light=1.3, dark=0.72)
    # energy arcs jumping between the tines
    for k in range(3):
        y = 11.0 + k * 5.0
        pts = [(178 + 13 * (i / 8), y + p.rnd(-2.0, 2.0)) for i in range(9)]
        p.line(pts, width=2.2, role="energy", outline=False, light=1.5, dark=1.0,
               gradient=False, sheen=False)
    p.glow((186, 21), 15, "energy", 0.75)
    p.glow((66, 21), 13, "energy", 0.25)


def rocket_hammer(p: Pen) -> None:
    # head block
    with p.group(role="panel", outline=1.5):
        p.rect((124, 2, 184, 44), radius=5.0, role="panel")
    p.rect((176, 4, 189, 42), radius=3.0, role="steel", outline=1.4)
    p.rect((124, 2, 184, 9), radius=4.0, role="dark", outline=False, sheen=False)
    # hazard chevrons on the striking face
    for i in range(3):
        x = 128 + i * 11.5
        p.poly([(x, 36), (x + 6.5, 36), (x + 10.5, 13), (x + 4.0, 13)], role="gold",
               outline=False, sheen=False, light=1.22, dark=0.86, gradient=False)
    # exhaust ports
    for i in range(3):
        y = 15 + i * 9.0
        p.ring((166, y), 5.6, 2.8, role="dark", outline=1.3)
        p.circle((166, y), 3.0, role="energy", outline=1.1, light=1.4, dark=0.95,
                 gradient=False)
        p.glow((166, y), 10, "energy", 0.5)
    # spike + neck + guard
    p.poly([(186, 14), (198, 23), (186, 32)], role="steel_dark", outline=1.4, light=1.3,
           dark=0.75)
    p.rect((110, 15, 130, 31), radius=3.0, role="steel", outline=1.4)
    p.rect((102, 9, 114, 37), radius=3.0, role="steel_dark", outline=1.4)
    # handle
    with p.group(role="grip", outline=1.4):
        p.poly([(46, 17), (108, 15), (108, 31), (46, 29)], role="grip")
    for i in range(7):
        x = 54 + i * 8
        p.line([(x, 17.5), (x - 3, 29.5)], width=1.4, role="grip_dark", outline=False,
               sheen=False, highlight=False, gradient=False)
    # pommel + thong
    p.circle((40, 23), 8.4, role="steel", outline=1.4, gradient=True)
    p.circle((40, 23), 3.2, role="darker", outline=1.2, sheen=False)
    p.line([(32, 26), (24, 34)], width=2.0, role="dark", outline=1.1)


# --------------------------------------------------------------------------- #
# catalog of paint functions
# --------------------------------------------------------------------------- #
PAINTERS: Dict[str, object] = {
    "pistol": pistol,
    "revolver": revolver,
    "shotgun": shotgun,
    "smg": smg,
    "rifle": rifle,
    "sniper": sniper,
    "minigun": minigun,
    "rocket_launcher": rocket_launcher,
    "energy_pistol": energy_pistol,
    "plasma_cannon": plasma_cannon,
    "laser_smg": laser_smg,
    "shock_baton": shock_baton,
    "rocket_hammer": rocket_hammer,
}

# Where the barrel ends / where a hand holds the weapon, in design space.
ANCHORS: Dict[str, dict] = {
    "pistol": {"muzzle": (144.5, 20.0), "grip": (74.0, 45.0), "axis": 20.0},
    "revolver": {"muzzle": (168.0, 20.0), "grip": (60.0, 45.0), "axis": 20.0},
    "shotgun": {"muzzle": (188.0, 18.0), "grip": (72.0, 43.0), "axis": 18.0},
    "smg": {"muzzle": (182.0, 23.0), "grip": (56.0, 45.0), "axis": 23.0},
    "rifle": {"muzzle": (196.0, 22.0), "grip": (54.0, 45.0), "axis": 22.0},
    "sniper": {"muzzle": (192.0, 20.5), "grip": (56.0, 45.0), "axis": 20.5},
    "minigun": {"muzzle": (194.0, 22.5), "grip": (32.0, 24.0), "axis": 22.5},
    "rocket_launcher": {"muzzle": (192.0, 21.0), "grip": (96.0, 46.0), "axis": 21.0},
    "energy_pistol": {"muzzle": (144.0, 21.5), "grip": (68.0, 45.0), "axis": 21.5},
    "plasma_cannon": {"muzzle": (178.0, 25.0), "grip": (56.0, 46.0), "axis": 25.0},
    "laser_smg": {"muzzle": (160.0, 25.5), "grip": (56.0, 46.0), "axis": 25.5},
    "shock_baton": {"muzzle": (190.0, 21.0), "grip": (78.0, 21.0), "axis": 21.0},
    "rocket_hammer": {"muzzle": (198.0, 23.0), "grip": (72.0, 23.0), "axis": 23.0},
}


def paint(slug: str, pen: Pen) -> None:
    try:
        fn = PAINTERS[slug]
    except KeyError:
        raise KeyError(f"no recipe named {slug!r}; known: {sorted(PAINTERS)}") from None
    fn(pen)  # type: ignore[operator]
