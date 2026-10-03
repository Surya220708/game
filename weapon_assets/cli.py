"""Command line interface: ``python -m weapon_assets <command>``.

Commands
--------
``catalog``  dump the full weapon/stats catalog as JSON
``balance``  print a DPS table for every weapon at a given level
``render``   render weapon sprites for the weapons/rarities/variants you pick
``reference`` re-skin the set from the palette of a reference image
``cards``    render inventory cards
``effects``  render muzzle flashes, projectiles and impacts
``atlas``    pack sprites into atlas.png + atlas.json
``sheet``    contact sheets for QA
``all``      everything, into one output folder
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import List, Optional, Sequence

from . import export, palettes, recipes, reference, render, stats


def _csv(value: Optional[str]) -> Optional[List[str]]:
    if not value:
        return None
    return [v.strip() for v in value.split(",") if v.strip()]


def _ints(value: Optional[str], default: Sequence[int]) -> List[int]:
    if not value:
        return list(default)
    return [int(v) for v in value.split(",") if v.strip()]


def _weapons(args) -> List[str]:
    chosen = _csv(getattr(args, "weapons", None))
    if not chosen or chosen == ["all"]:
        return list(recipes.PAINTERS.keys())
    unknown = [w for w in chosen if w not in recipes.PAINTERS]
    if unknown:
        raise SystemExit(f"unknown weapon(s): {', '.join(unknown)}\n"
                         f"known: {', '.join(recipes.PAINTERS)}")
    return chosen


def _rarities(args) -> List[str]:
    chosen = _csv(getattr(args, "rarities", None)) or ["common"]
    unknown = [r for r in chosen if r not in palettes.RARITIES]
    if unknown:
        raise SystemExit(f"unknown rarity: {', '.join(unknown)}\n"
                         f"known: {', '.join(palettes.RARITY_ORDER)}")
    return chosen


def _progress(label: str):
    last = [0.0]

    def cb(slug: str) -> None:
        now = time.time()
        if now - last[0] > 0.25:
            last[0] = now
            print(f"  {label} {slug} ...", flush=True)

    return cb


# --------------------------------------------------------------------------- #
def cmd_catalog(args) -> int:
    path = export.export_catalog(args.out, level=args.level, rarities=_rarities(args) or
                                 palettes.RARITY_ORDER)
    print(f"catalog -> {path}")
    if args.stdout:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        print(json.dumps({k: v["rolls"] for k, v in data["weapons"].items()}, indent=1)[:4000])
    return 0


def cmd_balance(args) -> int:
    print(stats.balance_report(args.weapon, level=args.level))
    if args.out:
        os.makedirs(args.out, exist_ok=True)
        path = os.path.join(args.out, f"balance_level{args.level}.txt")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(stats.balance_report(args.weapon, level=args.level) + "\n")
        print(f"\nwrote {path}")
    return 0


def cmd_render(args) -> int:
    result = export.export_weapons(
        args.out, slugs=_weapons(args), rarities=_rarities(args),
        sizes=_ints(args.sizes, (64, 128, 256)), variants=_csv(args.variants) or ["side", "side_left", "icon"],
        level=args.level, seed=args.seed, ss=args.ss, cards=args.cards,
        glow=not args.no_glow, template=args.template, progress=_progress("rendering"))
    manifest_path = export.write_manifest(args.out, result.manifest)
    print(f"{len(result.files)} sprites -> {args.out}")
    print(f"manifest -> {manifest_path}")
    return 0


def cmd_cards(args) -> int:
    count = 0
    for slug in _weapons(args):
        for rarity in _rarities(args):
            card = export.item_card(slug, rarity, level=args.level, seed=args.seed,
                                    width=args.width, height=args.height)
            rel = os.path.join("cards", f"{slug}_{rarity}_card.png")
            path = os.path.join(args.out, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            card.save(path, "PNG", optimize=True)
            count += 1
    print(f"{count} cards -> {args.out}")
    return 0


def cmd_effects(args) -> int:
    written = export.export_effects(args.out, names=_csv(args.names),
                                    rarities=_rarities(args),
                                    heights=_ints(args.sizes, (32, 64, 128)), ss=args.ss)
    print(f"{len(written)} effect sprites -> {args.out}")
    return 0


def cmd_atlas(args) -> int:
    img, meta = export.export_atlas(args.out, slugs=_weapons(args), rarities=_rarities(args),
                                    size=args.size, variants=_csv(args.variants) or ["side", "icon"],
                                    level=args.level, ss=args.ss, padding=args.padding,
                                    include_effects=not args.no_effects)
    print(f"atlas -> {img}\nmetadata -> {meta}")
    return 0


def cmd_sheet(args) -> int:
    written = export.export_sheet(args.out, rarities=_rarities(args), cell=args.cell,
                                 cols=args.cols, ss=args.ss)
    for rel in written:
        print(f"sheet -> {os.path.join(args.out, rel)}")
    return 0


def cmd_reference(args) -> int:
    overrides = reference.palette_from_file(args.image, accent_hint=args.accent)
    overrides = {k: v for k, v in overrides.items() if not k.startswith("_")}
    weapons = _weapons(args)
    rarities = _rarities(args)
    written = 0
    for slug in weapons:
        for rarity in rarities:
            for variant in _csv(args.variants) or ["side", "icon"]:
                sprite = render.render(render.RenderOptions(
                    slug, rarity=rarity, height=args.size, variant=variant,
                    square=(variant == "icon"), ss=args.ss, palette_overrides=overrides))
                rel = os.path.join("refskin", f"{slug}_{rarity}_{variant}.png")
                path = os.path.join(args.out, rel)
                os.makedirs(os.path.dirname(path), exist_ok=True)
                sprite.image.save(path, "PNG", optimize=True)
                written += 1
    if args.dump_palette:
        print(json.dumps(overrides, indent=1))

    # a QA sheet proves the whole set matches the reference palette
    sheet_dir = os.path.join(args.out, "refskin")
    os.makedirs(sheet_dir, exist_ok=True)
    for rarity in rarities:
        cell, cols = 220, 4
        rows = (len(weapons) + cols - 1) // cols
        cell_h = int(cell * 0.62)
        from PIL import Image, ImageDraw
        sheet = Image.new("RGBA", (cols * cell, rows * cell_h), (18, 18, 24, 255))
        d = ImageDraw.Draw(sheet)
        for i, slug in enumerate(weapons):
            r, c = divmod(i, cols)
            spr = render.render(render.RenderOptions(
                slug, rarity=rarity, height=cell // 2, variant="side", ss=args.ss,
                palette_overrides=overrides)).image
            scale = min((cell - 20) / spr.width, (cell_h - 34) / spr.height)
            w, h = max(1, int(spr.width * scale)), max(1, int(spr.height * scale))
            spr = spr.resize((w, h), Image.LANCZOS)
            sheet.alpha_composite(spr, (c * cell + (cell - w) // 2,
                                        r * cell_h + 8 + (cell_h - 34 - h) // 2))
            d.text((c * cell + 10, r * cell_h + cell_h - 18), slug, fill=(210, 214, 225, 255))
            d.rectangle((c * cell, r * cell_h, c * cell + cell - 1, r * cell_h + cell_h - 1),
                        outline=(44, 46, 58, 255))
        sheet.save(os.path.join(sheet_dir, f"sheet_{rarity}.png"), "PNG", optimize=True)
    print(f"{written} sprites -> {os.path.join(args.out, 'refskin')}")
    return 0


def cmd_all(args) -> int:
    rarities = _rarities(args) if args.rarities else ["common", "uncommon", "rare",
                                                      "epic", "legendary", "mythic"]
    rarities = [r for r in rarities if r in palettes.RARITIES]
    sizes = _ints(args.sizes, (32, 64, 128, 256, 512))
    variants = _csv(args.variants) or ["side", "side_left", "icon", "silhouette"]
    weapons = _weapons(args)

    print(f"== weapons ({len(weapons)} recipes, rarities: {', '.join(rarities)}) ==")
    result = export.export_weapons(args.out, slugs=weapons, rarities=rarities, sizes=sizes,
                                   variants=variants, level=args.level, seed=args.seed,
                                   ss=args.ss, cards=True, glow=not args.no_glow,
                                   template=args.template, progress=_progress("rendering"))
    export.write_manifest(args.out, result.manifest)
    print(f"   {len(result.files)} sprites")

    print("== effects ==")
    n = len(export.export_effects(args.out, rarities=rarities[:3],
                                  heights=(32, 64, 128), ss=args.ss))
    print(f"   {n} effect sprites")

    if not args.no_atlas:
        print("== atlas ==")
        img, meta = export.export_atlas(args.out, slugs=weapons, rarities=rarities[:3],
                                        size=128, ss=args.ss, padding=2)
        print(f"   {img}")

    print("== sheets ==")
    for rel in export.export_sheet(args.out, rarities=rarities[:3], cell=args.cell,
                                  cols=args.cols, ss=args.ss):
        print(f"   {os.path.join(args.out, rel)}")

    print("== catalog ==")
    print(f"   {export.export_catalog(args.out, level=args.level, rarities=rarities)}")

    path = os.path.join(args.out, "balance.txt")
    os.makedirs(args.out, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        for lvl in (1, 12, 30, 60):
            fh.write(stats.balance_report(level=lvl) + "\n\n")
    print(f"   {path}")
    print(f"\ndone -> {args.out}")
    return 0


# --------------------------------------------------------------------------- #
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m weapon_assets",
        description="Generate weapon sprites, stats and export metadata.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__)
    sub = p.add_subparsers(dest="command", required=True)

    def common(sp, weapons=True, rarities=True, ss=True):
        if weapons:
            sp.add_argument("--weapons", "--weapon", dest="weapons", default="all",
                            help="comma separated slugs, or 'all'")
        if rarities:
            sp.add_argument("--rarities", "--rarity", dest="rarities", default=None,
                            help="comma separated: " + ", ".join(palettes.RARITY_ORDER))
        if ss:
            sp.add_argument("--ss", type=int, default=4, help="supersample factor (default 4)")
        sp.add_argument("--level", type=int, default=12, help="item level for stat rolls")

    sp = sub.add_parser("catalog", help="dump the stats catalog as JSON")
    common(sp)
    sp.add_argument("--out", default="dist")
    sp.add_argument("--stdout", action="store_true", help="also print a sample")
    sp.set_defaults(func=cmd_catalog)

    sp = sub.add_parser("balance", help="print a DPS table")
    sp.add_argument("--weapon", default=None)
    sp.add_argument("--level", type=int, default=12)
    sp.add_argument("--out", default=None)
    sp.set_defaults(func=cmd_balance)

    sp = sub.add_parser("render", help="render weapon sprites")
    common(sp)
    sp.add_argument("--out", default="dist")
    sp.add_argument("--sizes", default="64,128,256", help="pixel heights, comma separated")
    sp.add_argument("--variants", default="side,side_left,icon")
    sp.add_argument("--seed", type=int, default=None)
    sp.add_argument("--template", default=export.DEFAULT_TEMPLATE)
    sp.add_argument("--cards", action="store_true", help="also write item cards")
    sp.add_argument("--no-glow", action="store_true", help="disable bloom")
    sp.set_defaults(func=cmd_render)

    sp = sub.add_parser("reference", help="re-skin the set from a reference image palette")
    common(sp)
    sp.add_argument("--image", required=True, help="reference image to sample")
    sp.add_argument("--out", default="dist")
    sp.add_argument("--size", type=int, default=256)
    sp.add_argument("--variants", default="side,icon")
    sp.add_argument("--accent", type=float, nargs=3, default=None,
                    metavar=("R", "G", "B"), help="force the accent colour, 0-255")
    sp.add_argument("--dump-palette", action="store_true", help="print the sampled roles")
    sp.set_defaults(func=cmd_reference)

    sp = sub.add_parser("cards", help="render inventory cards")
    common(sp)
    sp.add_argument("--out", default="dist")
    sp.add_argument("--width", type=int, default=512)
    sp.add_argument("--height", type=int, default=200)
    sp.add_argument("--seed", type=int, default=None)
    sp.set_defaults(func=cmd_cards)

    sp = sub.add_parser("effects", help="render muzzle flashes / projectiles / impacts")
    common(sp, weapons=False)
    sp.add_argument("--out", default="dist")
    sp.add_argument("--names", default=None, help="comma separated effect names")
    sp.add_argument("--sizes", default="32,64,128")
    sp.set_defaults(func=cmd_effects)

    sp = sub.add_parser("atlas", help="pack sprites into atlas.png + atlas.json")
    common(sp)
    sp.add_argument("--out", default="dist/atlas")
    sp.add_argument("--size", type=int, default=128, help="sprite height inside the atlas")
    sp.add_argument("--variants", default="side,icon")
    sp.add_argument("--padding", type=int, default=2)
    sp.add_argument("--no-effects", action="store_true")
    sp.set_defaults(func=cmd_atlas)

    sp = sub.add_parser("sheet", help="render QA contact sheets")
    common(sp, weapons=False)
    sp.add_argument("--out", default="dist")
    sp.add_argument("--cell", type=int, default=256)
    sp.add_argument("--cols", type=int, default=5)
    sp.set_defaults(func=cmd_sheet)

    sp = sub.add_parser("all", help="everything into one folder")
    common(sp)
    sp.add_argument("--out", default="dist")
    sp.add_argument("--sizes", default="32,64,128,256,512")
    sp.add_argument("--variants", default="side,side_left,icon,silhouette")
    sp.add_argument("--cell", type=int, default=256)
    sp.add_argument("--cols", type=int, default=5)
    sp.add_argument("--seed", type=int, default=None)
    sp.add_argument("--template", default=export.DEFAULT_TEMPLATE)
    sp.add_argument("--no-glow", action="store_true")
    sp.add_argument("--no-atlas", action="store_true")
    sp.set_defaults(func=cmd_all)
    return p


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.func(args) or 0)
    except KeyboardInterrupt:  # pragma: no cover
        print("interrupted", file=sys.stderr)
        return 130
    except (KeyError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
