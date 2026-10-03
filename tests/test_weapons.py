"""Test suite for the weapon asset generator (stdlib unittest, no pytest needed).

    python -m unittest discover -s tests -v

Rendering tests use ``ss=2`` and small sizes so the whole suite stays fast.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from PIL import Image  # noqa: E402

from weapon_assets import catalog, effects, export, palettes, recipes, render, stats  # noqa: E402


class TestCatalog(unittest.TestCase):
    def test_every_catalog_entry_has_a_recipe_and_anchors(self):
        for slug in catalog.slugs():
            self.assertIn(slug, recipes.PAINTERS, f"{slug} has no painter")
            self.assertIn(slug, recipes.ANCHORS, f"{slug} has no anchors")

    def test_every_recipe_is_in_the_catalog(self):
        for slug in recipes.PAINTERS:
            self.assertIn(slug, catalog.WEAPONS, f"{slug} is not in the catalog")

    def test_required_base_stats(self):
        required = {"damage", "fire_rate", "magazine", "reload_time", "spread", "range",
                    "pellets", "crit_chance", "crit_mult"}
        for slug, entry in catalog.WEAPONS.items():
            missing = required - set(entry["base"])
            self.assertFalse(missing, f"{slug} is missing base stats: {missing}")
            self.assertIn(entry["archetype"], catalog.ARCHETYPES)
            self.assertGreater(entry["base"]["damage"], 0)

    def test_unknown_weapon_raises(self):
        with self.assertRaises(KeyError):
            catalog.get("banana_cannon")


class TestStats(unittest.TestCase):
    def test_deterministic_for_a_seed(self):
        a = stats.build("rifle", "epic", 24, seed=99)
        b = stats.build("rifle", "epic", 24, seed=99)
        self.assertEqual(a.to_dict()["stats"], b.to_dict()["stats"])

    def test_different_seeds_differ(self):
        a = stats.build("rifle", "rare", 10, seed=1).stats.damage
        b = stats.build("rifle", "rare", 10, seed=2).stats.damage
        self.assertNotEqual(a, b)

    def test_rarity_increases_power(self):
        prev = 0.0
        for rarity in palettes.RARITY_ORDER:
            w = stats.build("rifle", rarity, 10, seed=5)
            self.assertGreater(w.stats.damage, prev, f"{rarity} should hit harder")
            prev = w.stats.damage
        powers = [stats.build("rifle", r, 10, seed=5).power_score
                  for r in palettes.RARITY_ORDER]
        self.assertEqual(powers, sorted(powers), "power score must climb with rarity")

    def test_level_scaling_and_clamping(self):
        low = stats.build("smg", "rare", 1, seed=3).stats.damage
        high = stats.build("smg", "rare", 50, seed=3).stats.damage
        self.assertGreater(high, low)
        self.assertEqual(stats.build("smg", "rare", 999, seed=3).level, stats.MAX_LEVEL)
        self.assertEqual(stats.build("smg", "rare", 0, seed=3).level, 1)

    def test_perk_counts_follow_rarity(self):
        for rarity, expected in stats.PERK_COUNT.items():
            w = stats.build("rifle", rarity, 12, seed=11)
            self.assertEqual(len(w.perks), expected, f"{rarity} perk count")

    def test_magazine_stays_a_positive_int(self):
        for rarity in palettes.RARITY_ORDER:
            for slug in catalog.slugs():
                w = stats.build(slug, rarity, 30, seed=2)
                self.assertIsInstance(w.stats.magazine, int)
                if catalog.get(slug)["base"]["magazine"] > 0:
                    self.assertGreater(w.stats.magazine, 0)
                self.assertGreaterEqual(w.stats.damage, 0)

    def test_derived_metrics_are_sane(self):
        w = stats.build("smg", "rare", 15, seed=8)
        s = w.stats
        self.assertGreater(s.burst_dps, s.dps, "reloads must lower sustained dps")
        self.assertGreater(s.dps, 0)
        self.assertGreaterEqual(s.shots_to_kill(100), 1)
        self.assertGreater(s.ttk(100), 0)
        self.assertGreater(s.damage_per_magazine, 0)

    def test_melee_weapons_do_not_divide_by_zero(self):
        for slug in ("shock_baton", "rocket_hammer"):
            s = stats.build(slug, "mythic", 40, seed=4).stats
            self.assertTrue(s.dps > 0 or s.burst_dps > 0)
            self.assertNotEqual(s.ttk(100), float("nan"))

    def test_unknown_rarity_raises(self):
        with self.assertRaises(KeyError):
            stats.build("rifle", "ultra", 1)

    def test_balance_report_renders(self):
        report = stats.balance_report(level=5)
        self.assertIn("weapon", report)
        self.assertIn("rifle", report)


class TestPalettes(unittest.TestCase):
    def test_parse_accepts_short_and_long_hex(self):
        self.assertEqual(palettes.parse("#abc"), (170, 187, 204))
        self.assertEqual(palettes.parse("aabbcc"), (170, 187, 204))
        self.assertEqual(palettes.parse((1, 2, 3)), (1, 2, 3))

    def test_every_rarity_builds_and_differs(self):
        seen = set()
        for rarity in palettes.RARITY_ORDER:
            pal = palettes.build(rarity)
            for role in ("outline", "body", "accent", "energy", "grip"):
                self.assertIn(role, pal.as_hex())
            seen.add(pal.as_hex()["accent"])
        self.assertEqual(len(seen), len(palettes.RARITY_ORDER))

    def test_overrides_win(self):
        pal = palettes.build("rare", accent="#123456")
        self.assertEqual(pal.as_hex()["accent"], "#123456")

    def test_colour_helpers(self):
        self.assertEqual(palettes.lighten("#000000", 0.5), (128, 128, 128))
        self.assertEqual(palettes.darken("#ffffff", 0.5), (128, 128, 128))
        self.assertEqual(palettes.mix("#000000", "#ffffff", 1.0), (255, 255, 255))
        self.assertEqual(palettes.clamp8(-5), 0)
        self.assertEqual(palettes.clamp8(300), 255)


class TestRender(unittest.TestCase):
    def setUp(self):
        self.slugs = catalog.slugs()

    def test_every_weapon_renders_non_empty_at_every_size(self):
        for slug in self.slugs:
            for height in (24, 96):
                sprite = render.render(render.RenderOptions(slug, height=height, ss=2))
                self.assertIsNotNone(sprite.image.getbbox(), f"{slug}@{height} is blank")
                self.assertEqual(sprite.image.size[1], height)
                self.assertEqual(sprite.image.mode, "RGBA")

    def test_anchors_land_inside_the_canvas(self):
        for slug in self.slugs:
            sprite = render.render(render.RenderOptions(slug, height=128, ss=2))
            w, h = sprite.image.size
            self.assertIn("muzzle", sprite.anchors_px)
            self.assertIn("grip", sprite.anchors_px)
            for name, (x, y) in sprite.anchors_px.items():
                self.assertTrue(-w * 0.2 <= x <= w * 1.2, f"{slug}/{name} x={x} outside {w}")
                self.assertTrue(-h * 0.2 <= y <= h * 1.2, f"{slug}/{name} y={y} outside {h}")
            for name, (u, v) in sprite.anchors_uv.items():
                self.assertTrue(0.0 <= u <= 1.0 and 0.0 <= v <= 1.0)

    def test_active_canvas_is_tighter_than_the_design_canvas(self):
        sprite = render.render(render.RenderOptions("pistol", height=64, ss=2))
        self.assertLessEqual(sprite.design_bbox[0], 30.0)
        self.assertGreaterEqual(sprite.design_bbox[2], 130.0)

    def test_variants(self):
        for variant in render.VARIANTS:
            sprite = render.render(render.RenderOptions("rifle", height=96, variant=variant, ss=2))
            self.assertIsNotNone(sprite.image.getbbox(), f"variant {variant} is blank")
        icon = render.render(render.RenderOptions("rifle", height=96, variant="icon",
                                                 square=True, ss=2))
        self.assertEqual(icon.image.size[0], icon.image.size[1], "icons must be square")

    def test_left_variant_is_mirrored(self):
        right = render.render(render.RenderOptions("rifle", height=96, variant="side", ss=2))
        left = render.render(render.RenderOptions("rifle", height=96, variant="side_left", ss=2))
        # a left-facing sprite must put its muzzle near the left edge, and vice versa
        self.assertLess(left.anchors_px["muzzle"][0], left.image.size[0] * 0.1)
        self.assertGreater(right.anchors_px["muzzle"][0], right.image.size[0] * 0.9)

    def test_rarity_changes_pixels(self):
        a = render.render(render.RenderOptions("rifle", rarity="common", height=64, ss=2)).image
        b = render.render(render.RenderOptions("rifle", rarity="legendary", height=64, ss=2)).image
        self.assertNotEqual(a.tobytes(), b.tobytes())

    def test_glow_can_be_disabled(self):
        on = render.render(render.RenderOptions("plasma_cannon", height=96, ss=2)).image
        off = render.render(render.RenderOptions("plasma_cannon", height=96, ss=2,
                                                glow=False)).image
        self.assertNotEqual(on.tobytes(), off.tobytes())

    def test_render_is_deterministic(self):
        a = render.render(render.RenderOptions("rocket_hammer", height=64, ss=2, seed=7)).image
        b = render.render(render.RenderOptions("rocket_hammer", height=64, ss=2, seed=7)).image
        self.assertEqual(a.tobytes(), b.tobytes())

    def test_unknown_recipe_and_variant_raise(self):
        with self.assertRaises(KeyError):
            render.render(render.RenderOptions("nope", height=32, ss=2))
        with self.assertRaises(KeyError):
            render.render(render.RenderOptions("rifle", height=32, variant="sideways", ss=2))

    def test_contact_sheet_contains_every_weapon(self):
        sheet = render.contact_sheet(self.slugs, cell=100, cols=4, ss=2)
        self.assertEqual(sheet.size[0], 400)
        self.assertIsNotNone(sheet.getbbox())


class TestEffects(unittest.TestCase):
    def test_all_effects_render(self):
        for name in effects.EFFECTS:
            img = effects.render_effect(name, rarity="legendary", height=32, ss=2)
            self.assertIsNotNone(img.getbbox(), f"{name} is blank")

    def test_fx_mapping_covers_every_weapon(self):
        for slug, entry in catalog.WEAPONS.items():
            self.assertIn(entry["fx"], effects.FX_FLASH, f"{slug} has no flash")
            if entry["archetype"] in ("projectile", "explosive", "beam"):
                self.assertIn(entry["fx"], effects.FX_PROJECTILE, f"{slug} has no projectile")


class TestExport(unittest.TestCase):
    def test_name_template(self):
        name = export.build_name(export.DEFAULT_TEMPLATE, "weapons", "rocket_hammer",
                                 "legendary", "side", 256, level=12)
        self.assertEqual(name, "weapons/rocket_hammer/rocket_hammer_legendary_side_256px")

    def test_export_weapons_writes_files_and_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = export.export_weapons(tmp, slugs=["pistol", "rifle"],
                                          rarities=["common", "rare"], sizes=[64],
                                          variants=["side", "icon"], level=10, ss=2,
                                          cards=True)
            for rel in result.files:
                self.assertTrue(os.path.exists(os.path.join(tmp, rel)), rel)
            manifest_path = export.write_manifest(tmp, result.manifest)
            with open(manifest_path, encoding="utf-8") as fh:
                data = json.load(fh)
            self.assertEqual(set(data["weapons"]), {"pistol", "rifle"})
            entry = data["weapons"]["rifle"]
            self.assertIn("common", entry["rolls"])
            self.assertIn("anchors_px", entry["anchors"]["common_side_64"])
            self.assertEqual(entry["fx"]["flash"], "flash_bullet")

    def test_item_card(self):
        card = export.item_card("sniper", "legendary", level=44, width=320, height=140)
        self.assertEqual(card.size, (320, 140))
        self.assertIsNotNone(card.getbbox())

    def test_atlas_pack_places_everything_without_overlap(self):
        sprites = [(f"s{i}", Image.new("RGBA", (20 + i, 10 + i), (255, 0, 0, 255)))
                   for i in range(12)]
        atlas, meta = export.pack_atlas(sprites, padding=1)
        self.assertEqual(len(meta["frames"]), 12)
        boxes = []
        for name, fr in meta["frames"].items():
            f = fr["frame"]
            self.assertLessEqual(f["x"] + f["w"], atlas.size[0])
            self.assertLessEqual(f["y"] + f["h"], atlas.size[1])
            boxes.append((f["x"], f["y"], f["x"] + f["w"], f["y"] + f["h"]))
        for i, a in enumerate(boxes):
            for b in boxes[i + 1:]:
                overlap = not (a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1])
                self.assertFalse(overlap, f"frames overlap: {a} vs {b}")

    def test_export_atlas_and_sheet_and_catalog(self):
        with tempfile.TemporaryDirectory() as tmp:
            img, meta = export.export_atlas(tmp, slugs=["pistol"], rarities=["rare"],
                                            size=48, ss=2, include_effects=True)
            self.assertTrue(os.path.exists(img))
            with open(meta, encoding="utf-8") as fh:
                self.assertIn("frames", json.load(fh))
            sheets = export.export_sheet(tmp, rarities=["rare"], cell=100, cols=4, ss=2)
            self.assertEqual(len(sheets), 1)
            cat = export.export_catalog(tmp, level=7, rarities=["common", "rare"])
            with open(cat, encoding="utf-8") as fh:
                data = json.load(fh)
            self.assertEqual(data["level"], 7)
            self.assertIn("balance_constants", data)


class TestReference(unittest.TestCase):
    def test_palette_sampled_from_an_image(self):
        from weapon_assets import reference

        img = Image.new("RGBA", (32, 32), (180, 180, 190, 255))
        for x in range(0, 32, 4):  # a noisy accent stripe
            for y in range(0, 32, 4):
                img.putpixel((x, y), (220, 40, 60, 255))
        overrides = reference.palette_from_image(img)
        self.assertIn("body", overrides)
        self.assertIn("accent", overrides)
        pal = palettes.build("rare", **{k: v for k, v in overrides.items()
                                        if not k.startswith("_")})
        self.assertNotEqual(pal.as_hex()["accent"], palettes.build("rare").as_hex()["accent"])


class TestCli(unittest.TestCase):
    def test_render_and_balance_commands(self):
        from weapon_assets.cli import main

        with tempfile.TemporaryDirectory() as tmp:
            code = main(["render", "--weapons", "pistol", "--rarities", "rare",
                         "--sizes", "48", "--variants", "side", "--ss", "2", "--out", tmp])
            self.assertEqual(code, 0)
            self.assertTrue(os.path.exists(os.path.join(tmp, export.MANIFEST_NAME)))
            code = main(["balance", "--level", "3"])
            self.assertEqual(code, 0)

    def test_unknown_weapon_exits_with_error(self):
        from weapon_assets.cli import main

        with self.assertRaises(SystemExit):
            main(["render", "--weapons", "nope", "--ss", "2", "--out",
                  tempfile.mkdtemp()])


if __name__ == "__main__":
    unittest.main(verbosity=2)
