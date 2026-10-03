"""Anti-aliased 2D drawing engine on top of Pillow.

Everything is drawn in *design space*: an arbitrary unit grid with ``y`` pointing
down, which the renderer scales up by ``ss`` (supersample) and later downsamples
with LANCZOS -- that is where the smooth edges come from.

Each primitive is composited as an isolated **part** with an optional dark
outline, a vertical gradient, a bevelled top/bottom edge and a soft specular
sheen.  That combination is what makes flat vector shapes read as game art
instead of flat blobs.

Geometry calls can be grouped::

    with pen.group(role="body"):
        pen.poly([(10, 10), (80, 10), (80, 30), (10, 30)])
        pen.rect((80, 12, 110, 28), role="panel")   # ignored, group role wins

so several shapes share one outline and one shading pass.
"""
from __future__ import annotations

import contextlib
import math
import random
from typing import Iterable, List, Sequence, Tuple

from PIL import Image, ImageChops, ImageDraw, ImageFilter

from .palettes import Palette, scale_color

Pt = Tuple[float, float]
Box = Sequence[float]

_MASK = 255


class PartStyle:
    """How a single part is shaded once its silhouette has been rasterised."""

    __slots__ = ("role", "outline", "gradient", "highlight", "sheen", "light", "dark",
                 "outline_color", "rim")

    def __init__(self, role: str = "body", outline=True, gradient=True, highlight=True,
                 sheen=True, light: float = 1.24, dark: float = 0.64,
                 outline_color: str | None = None, rim: bool = True):
        self.role = role
        self.outline = outline
        self.gradient = gradient
        self.highlight = highlight
        self.sheen = sheen
        self.light = light
        self.dark = dark
        self.outline_color = outline_color
        self.rim = rim


class Pen:
    """Draws one sprite into a supersampled RGBA canvas."""

    def __init__(self, design_size: Sequence[float], palette: Palette, ss: int = 4,
                 outline_width: float = 1.4, seed: int | None = None):
        self.design = (float(design_size[0]), float(design_size[1]))
        self.palette = palette
        self.ss = int(ss)
        self.outline_width = float(outline_width)
        self.size = (int(round(self.design[0] * self.ss)), int(round(self.design[1] * self.ss)))
        self.sprite = Image.new("RGBA", self.size, (0, 0, 0, 0))
        self.glow_layer = Image.new("RGBA", self.size, (0, 0, 0, 0))
        self._stack: List[Image.Image] = []
        self.rng = random.Random(seed)
        self._glow_dirty = False
        #: multiplier applied to every glow() call; drop it to keep blooms subtle
        self.glow_scale = 1.0

    # ------------------------------------------------------------------ #
    # random helpers (used by recipes for rivets, vents, speckle ...)
    # ------------------------------------------------------------------ #
    def rnd(self, a: float = 0.0, b: float = 1.0) -> float:
        return self.rng.uniform(a, b)

    def rndi(self, a: int, b: int) -> int:
        return self.rng.randint(a, b)

    def pick(self, seq):
        return self.rng.choice(list(seq))

    def chance(self, p: float) -> bool:
        return self.rng.random() < p

    # ------------------------------------------------------------------ #
    # coordinate helpers
    # ------------------------------------------------------------------ #
    def _pts(self, points: Iterable[Sequence[float]]) -> List[Tuple[float, float]]:
        s = self.ss
        return [(float(p[0]) * s, float(p[1]) * s) for p in points]

    def _box(self, box: Box) -> Tuple[float, float, float, float]:
        s = self.ss
        x0, y0, x1, y1 = box
        return (x0 * s, y0 * s, x1 * s, y1 * s)

    def _w(self, width: float) -> int:
        return max(1, int(round(width * self.ss)))

    # ------------------------------------------------------------------ #
    # part plumbing
    # ------------------------------------------------------------------ #
    def _emit(self, painter, style: PartStyle) -> None:
        top = self._stack[-1] if self._stack else None
        if top is not None:
            painter(ImageDraw.Draw(top))
            return
        mask = Image.new("L", self.size, 0)
        painter(ImageDraw.Draw(mask))
        self._flush(mask, style)

    @contextlib.contextmanager
    def group(self, **style_kw):
        """Merge several primitives into one outlined + shaded part."""
        if self._stack:
            raise RuntimeError("Pen.group() cannot be nested")
        style = PartStyle(**style_kw)
        mask = Image.new("L", self.size, 0)
        self._stack.append(mask)
        try:
            yield self
        finally:
            self._stack.pop()
            self._flush(mask, style)

    def _flush(self, mask: Image.Image, style: PartStyle) -> None:
        """Outline and shade one part, working only on its own bounding box.

        Filtering a 800x384 canvas once per part dominates the render time, so the
        mask is cropped to its bbox (plus outline padding) first and the result is
        composited back at an offset.
        """
        bbox = mask.getbbox()
        if bbox is None:
            return
        width = 0.0
        if style.outline:
            width = float(style.outline) if isinstance(style.outline, (int, float)) \
                else self.outline_width
        pad = int(math.ceil(width * self.ss)) + 2
        x0 = max(0, bbox[0] - pad)
        y0 = max(0, bbox[1] - pad)
        x1 = min(self.size[0], bbox[2] + pad)
        y1 = min(self.size[1], bbox[3] + pad)
        sub = mask.crop((x0, y0, x1, y1))

        if width > 0:
            border = self._dilate(sub, width * self.ss)
            colour = self.palette[style.outline_color or "outline"]
            outline_img = Image.new("RGBA", sub.size, (*colour, 255))
            outline_img.putalpha(border)
            self.sprite.alpha_composite(outline_img, (x0, y0))
        fill = self._shaded(sub, style)
        self.sprite.alpha_composite(fill, (x0, y0))

    # ------------------------------------------------------------------ #
    # raster effects
    # ------------------------------------------------------------------ #
    def _dilate(self, mask: Image.Image, radius_px: float) -> Image.Image:
        """8-connected dilation by ``radius_px`` (cheap, iterative 3x3 max)."""
        steps = int(round(radius_px))
        if steps <= 0:
            return mask
        steps = min(steps, 40)
        out = mask
        for _ in range(steps):
            out = out.filter(ImageFilter.MaxFilter(3))
        return out

    def _shifted(self, mask: Image.Image, dy: int) -> Image.Image:
        w, h = mask.size
        return mask.transform((w, h), Image.AFFINE, (1, 0, 0, 0, 1, dy),
                              resample=Image.NEAREST, fillcolor=0)

    def _shaded(self, mask: Image.Image, style: PartStyle) -> Image.Image:
        """Shade one part: gradient fill, bevel, sheen.

        ``mask`` is the part's own (already cropped) mask; the returned image has
        the same size so the caller can alpha-composite it back at an offset.
        """
        bbox = mask.getbbox()
        if bbox is None:
            return Image.new("RGBA", mask.size, (0, 0, 0, 0))
        x0, y0, x1, y1 = bbox
        bw, bh = x1 - x0, y1 - y0
        sub = mask.crop(bbox)
        colour = self.palette[style.role]

        part = Image.new("RGBA", (bw, bh), (0, 0, 0, 0))
        if style.gradient and bh > 2:
            grad = Image.new("RGB", (1, bh))
            grad.putdata([scale_color(colour,
                                      style.light + (style.dark - style.light) * (y / (bh - 1)))
                          for y in range(bh)])
            part.paste(grad.resize((bw, bh), Image.BILINEAR), (0, 0))
        else:
            part.paste(Image.new("RGB", (bw, bh), colour), (0, 0))
        part.putalpha(sub)

        if style.highlight and bh >= 3:
            bevel = max(1, int(round(self.ss * 0.9)))
            top_edge = ImageChops.subtract(sub, self._shifted(sub, -bevel))
            bot_edge = ImageChops.subtract(sub, self._shifted(sub, bevel))
            part.paste(Image.new("RGB", (bw, bh), scale_color(colour, style.light * 1.14)),
                       (0, 0), top_edge)
            part.paste(Image.new("RGB", (bw, bh), scale_color(colour, style.dark * 0.82)),
                       (0, 0), bot_edge)

        if style.sheen and bw > 10 and bh > 5:
            band = Image.new("L", (bw, bh), 0)
            bd = ImageDraw.Draw(band)
            lean = bh * 0.6
            bd.polygon([(bw * 0.16 - lean, bh), (bw * 0.16 + lean, bh),
                        (bw * 0.60, 0), (bw * 0.40, 0)], fill=_MASK)
            band = band.filter(ImageFilter.GaussianBlur(max(1.0, bh * 0.07 + self.ss * 0.4)))
            sheen_mask = ImageChops.multiply(band, sub).point(lambda v: int(v * 0.13))
            part.paste(Image.new("RGB", (bw, bh), (255, 255, 255)), (0, 0), sheen_mask)

        out = Image.new("RGBA", mask.size, (0, 0, 0, 0))
        out.paste(part, (x0, y0))
        return out

    # ------------------------------------------------------------------ #
    # primitives (all coordinates are in design space)
    # ------------------------------------------------------------------ #
    def poly(self, points: Iterable[Sequence[float]], **style_kw) -> None:
        pts = self._pts(points)
        self._emit(lambda d: d.polygon(pts, fill=_MASK), PartStyle(**style_kw))

    def rect(self, box: Box, radius: float = 0.0, **style_kw) -> None:
        b = self._box(box)
        if radius > 0:
            r = radius * self.ss
            self._emit(lambda d: d.rounded_rectangle(b, radius=r, fill=_MASK), PartStyle(**style_kw))
        else:
            self._emit(lambda d: d.rectangle(b, fill=_MASK), PartStyle(**style_kw))

    def ellipse(self, box: Box, **style_kw) -> None:
        b = self._box(box)
        self._emit(lambda d: d.ellipse(b, fill=_MASK), PartStyle(**style_kw))

    def circle(self, center: Sequence[float], r: float, **style_kw) -> None:
        cx = float(center[0]); cy = float(center[1])
        self.ellipse((cx - r, cy - r, cx + r, cy + r), **style_kw)

    def ring(self, center: Sequence[float], r_outer: float, thickness: float, **style_kw) -> None:
        cx = float(center[0]); cy = float(center[1])
        r_inner = max(0.0, r_outer - thickness)
        outer = self._box((cx - r_outer, cy - r_outer, cx + r_outer, cy + r_outer))
        inner = self._box((cx - r_inner, cy - r_inner, cx + r_inner, cy + r_inner))

        def painter(d: ImageDraw.ImageDraw) -> None:
            d.ellipse(outer, fill=_MASK)
            d.ellipse(inner, fill=0)

        self._emit(painter, PartStyle(**style_kw))

    def line(self, points: Iterable[Sequence[float]], width: float = 1.5, cap: str = "round",
             **style_kw) -> None:
        pts = self._pts(points)
        w = self._w(width)

        def painter(d: ImageDraw.ImageDraw) -> None:
            d.line(pts, fill=_MASK, width=w, joint="curve")
            if cap == "round" and len(pts) > 1:
                r = w / 2.0
                for (x, y) in (pts[0], pts[-1]):
                    d.ellipse((x - r, y - r, x + r, y + r), fill=_MASK)

        self._emit(painter, PartStyle(**style_kw))

    def arc(self, box: Box, start: float, end: float, width: float = 2.0, **style_kw) -> None:
        b = self._box(box)
        w = self._w(width)

        def painter(d: ImageDraw.ImageDraw) -> None:
            d.arc(b, start, end, fill=_MASK, width=w)

        self._emit(painter, PartStyle(**style_kw))

    def dots(self, points: Iterable[Sequence[float]], radius: float = 0.8, **style_kw) -> None:
        pts = self._pts(points)
        r = radius * self.ss

        def painter(d: ImageDraw.ImageDraw) -> None:
            for (x, y) in pts:
                d.ellipse((x - r, y - r, x + r, y + r), fill=_MASK)

        self._emit(painter, PartStyle(**style_kw))

    # ------------------------------------------------------------------ #
    # glow (bloom, composited with a screen blend when the sprite is finished)
    # ------------------------------------------------------------------ #
    def glow(self, center: Sequence[float], radius: float, role: str = "energy",
             strength: float = 0.85) -> None:
        scale = max(0.0, float(self.glow_scale))
        if scale <= 0.0:
            return
        strength *= scale
        radius *= 0.72 + 0.28 * scale
        cx, cy = float(center[0]) * self.ss, float(center[1]) * self.ss
        r = float(radius) * self.ss
        size = int(2 * r) + 4
        grad = Image.radial_gradient("L").resize((size, size), Image.BILINEAR)
        # quadratic falloff: a soft bloom instead of a solid disc
        alpha = grad.point(lambda v: max(0, min(255, int(((255 - v) / 255.0) ** 2 * 255.0 * strength))))
        blob = Image.new("RGBA", (size, size), (*self.palette[role], 255))
        blob.putalpha(alpha)
        self.glow_layer.alpha_composite(blob, (int(cx - size / 2), int(cy - size / 2)))
        self._glow_dirty = True

    # ------------------------------------------------------------------ #
    # finishing
    # ------------------------------------------------------------------ #
    def finish(self, glow_blur: float = 2.4) -> Image.Image:
        """Return the supersampled RGBA sprite with the glow screened on top."""
        sprite = self.sprite
        if self._glow_dirty and self.glow_layer.getbbox() is not None:
            blurred = self.glow_layer.filter(ImageFilter.GaussianBlur(max(0.5, glow_blur * self.ss * 0.35)))
            s = sprite.split()
            g = blurred.split()
            rgb = ImageChops.screen(Image.merge("RGB", s[:3]), Image.merge("RGB", g[:3]))
            alpha = ImageChops.lighter(s[3], g[3])
            sprite = Image.merge("RGBA", (*rgb.split(), alpha))
        return sprite


# --------------------------------------------------------------------------- #
# geometry helpers used by the weapon recipes
# --------------------------------------------------------------------------- #
def arc_points(cx: float, cy: float, r: float, a0: float, a1: float, steps: int = 14,
               squash: float = 1.0) -> List[Pt]:
    """Points along a circular arc, angles in degrees (0 = east, clockwise)."""
    out: List[Pt] = []
    for i in range(steps + 1):
        a = math.radians(a0 + (a1 - a0) * i / steps)
        out.append((cx + r * math.cos(a), cy + r * math.sin(a) * squash))
    return out


def crescent(cx: float, cy: float, r_out: float, r_in: float, a0: float, a1: float,
             steps: int = 14, squash: float = 1.0) -> List[Pt]:
    """Closed polygon of a crescent between two arcs -- used for blades."""
    outer = arc_points(cx, cy, r_out, a0, a1, steps, squash)
    inner = arc_points(cx, cy, r_in, a1, a0, steps, squash)
    return outer + inner


def taper(x0: float, y0: float, x1: float, y1: float, w0: float, w1: float) -> List[Pt]:
    """A trapezoid from (x0,y0) to (x1,y1) with widths w0 -> w1 (horizontal-ish)."""
    if abs(x1 - x0) >= abs(y1 - y0):
        return [(x0, y0 - w0 / 2), (x1, y1 - w1 / 2), (x1, y1 + w1 / 2), (x0, y0 + w0 / 2)]
    return [(x0 - w0 / 2, y0), (x1 - w1 / 2, y1), (x1 + w1 / 2, y1), (x0 + w0 / 2, y0)]
