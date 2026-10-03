"""Stat rolling: turn catalog base stats into the final numbers for a drop.

A drop is identified by ``(slug, rarity, level)``.  The roll is:

    final = base * rarity_multiplier * level_multiplier * roll_variance

``roll_variance`` is deterministic per ``seed`` (so the same seed always exports
the same gun) and small (``+/-4%`` by default), which is enough to make two
identical drops feel different without breaking balance.

Everything is plain arithmetic -- no engine required -- so designers can print
tables or dump JSON straight from the CLI.
"""
from __future__ import annotations

import math
import random
from dataclasses import asdict, dataclass, field
from typing import Dict, List, Optional

from . import catalog
from .palettes import RARITIES, RARITY_ORDER

# --------------------------------------------------------------------------- #
# tuning knobs -- this is the whole balance surface
# --------------------------------------------------------------------------- #
MAX_LEVEL = 60

#: how much each rarity tier multiplies the base stats
RARITY_MULT: Dict[str, Dict[str, float]] = {
    "common":    dict(damage=1.00, magazine=1.00, reload=1.00, spread=1.00, crit=1.00),
    "uncommon":  dict(damage=1.18, magazine=1.12, reload=0.96, spread=0.96, crit=1.10),
    "rare":      dict(damage=1.42, magazine=1.26, reload=0.92, spread=0.92, crit=1.25),
    "epic":      dict(damage=1.72, magazine=1.42, reload=0.88, spread=0.88, crit=1.45),
    "legendary": dict(damage=2.10, magazine=1.60, reload=0.84, spread=0.84, crit=1.70),
    "mythic":    dict(damage=2.55, magazine=1.80, reload=0.80, spread=0.80, crit=2.00),
}

#: how many extra stat lines each rarity rolls (cosmetic + affordance for the UI)
PERK_COUNT = {"common": 0, "uncommon": 1, "rare": 2, "epic": 3, "legendary": 4, "mythic": 5}

#: per-level growth for each stat (applied for level-1 steps)
PER_LEVEL = dict(damage=0.035, magazine=0.010, crit=0.002)
ROLL_SPREAD = 0.04

PERK_POOL: List[Dict[str, object]] = [
    {"id": "damage_up", "label": "+{v}% damage", "stat": "damage", "scale": 0.06,
     "weights": {"common": 1.0}},
    {"id": "fire_rate_up", "label": "+{v}% fire rate", "stat": "fire_rate", "scale": 0.05},
    {"id": "mag_up", "label": "+{v}% magazine", "stat": "magazine", "scale": 0.12},
    {"id": "reload_up", "label": "-{v}% reload time", "stat": "reload_time", "scale": 0.08,
     "invert": True},
    {"id": "crit_up", "label": "+{v}% crit chance", "stat": "crit_chance", "scale": 0.06},
    {"id": "crit_dmg_up", "label": "+{v}% crit damage", "stat": "crit_mult", "scale": 0.10},
    {"id": "range_up", "label": "+{v}% effective range", "stat": "range", "scale": 0.10},
    {"id": "spread_down", "label": "-{v}% spread", "stat": "spread", "scale": 0.10,
     "invert": True},
    {"id": "mobility_up", "label": "+{v}% handling", "stat": "mobility", "scale": 0.05},
    {"id": "splash_up", "label": "+{v}% splash damage", "stat": "splash_damage", "scale": 0.10,
     "requires": "splash_damage"},
]


# --------------------------------------------------------------------------- #
@dataclass
class Stats:
    """Final, rolled stats in game units."""

    damage: float = 0.0
    fire_rate: float = 1.0        # shots / second
    magazine: int = 0
    reload_time: float = 0.0      # seconds
    spread: float = 0.0           # degrees, at rest
    range: float = 0.0            # metres before falloff
    projectile_speed: float = 0.0  # m/s (0 = hitscan / melee)
    pellets: int = 1
    crit_chance: float = 0.0
    crit_mult: float = 1.0
    recoil: float = 0.0
    noise: float = 0.0
    mobility: float = 1.0
    splash_radius: float = 0.0
    splash_damage: float = 0.0
    spinup: float = 0.0

    # ---- derived -----------------------------------------------------------
    @property
    def shots_per_second(self) -> float:
        return self.fire_rate

    @property
    def burst_dps(self) -> float:
        """Damage per second ignoring reloads, including average crit gain."""
        crit = 1.0 + self.crit_chance * (self.crit_mult - 1.0)
        return self.damage * self.pellets * self.fire_rate * crit

    @property
    def dps(self) -> float:
        """Sustained DPS including reload downtime."""
        if self.magazine <= 0 or self.fire_rate <= 0:
            return self.burst_dps
        cycle = self.magazine / self.fire_rate + self.reload_time
        return self.magazine * self.damage * self.pellets * self.crit_factor / cycle

    @property
    def crit_factor(self) -> float:
        return 1.0 + self.crit_chance * (self.crit_mult - 1.0)

    @property
    def damage_per_magazine(self) -> float:
        return self.magazine * self.damage * self.pellets * self.crit_factor

    @property
    def time_to_empty(self) -> float:
        return self.magazine / self.fire_rate if self.fire_rate > 0 else 0.0

    def ttk(self, health: float = 100.0, armour: float = 0.0) -> float:
        """Seconds to kill ``health`` HP of a target with flat ``armour`` reduction."""
        per_shot = max(0.01, self.damage * self.pellets * self.crit_factor - armour)
        if self.fire_rate <= 0:
            return math.inf
        shots = math.ceil(health / per_shot)
        # every magazine that runs dry costs a reload
        reloads = max(0, math.ceil(shots / max(1, self.magazine)) - 1)
        return shots / self.fire_rate + reloads * self.reload_time

    def shots_to_kill(self, health: float = 100.0, armour: float = 0.0) -> int:
        per_shot = max(0.01, self.damage * self.pellets * self.crit_factor - armour)
        return math.ceil(health / per_shot)

    def to_dict(self) -> dict:
        d = asdict(self)
        d.update(
            dps=round(self.dps, 2),
            burst_dps=round(self.burst_dps, 2),
            damage_per_magazine=round(self.damage_per_magazine, 1),
            time_to_empty=round(self.time_to_empty, 2),
            ttk_100=round(self.ttk(100.0), 3),
        )
        return d


@dataclass
class RolledWeapon:
    """A concrete item: catalog entry + rarity + level + rolled stats + perks."""

    slug: str
    name: str
    cls: str
    archetype: str
    ammo: str
    fx: str
    desc: str
    rarity: str
    tier: int
    level: int
    stats: Stats
    perks: List[dict] = field(default_factory=list)
    traits: List[str] = field(default_factory=list)
    palette: Dict[str, str] = field(default_factory=dict)
    assets: Dict[str, str] = field(default_factory=dict)

    @property
    def rarity_label(self) -> str:
        return RARITIES[self.rarity]["label"]

    @property
    def power_score(self) -> int:
        """A single number for UI sorting: DPS blended with burst and range."""
        s = self.stats
        reach = 1.0 + min(s.range, 120.0) / 240.0
        return int(round(math.sqrt(max(s.dps, 0.0) * self.stats.burst_dps) * reach / 3.0))

    def to_dict(self) -> dict:
        return {
            "slug": self.slug, "name": self.name, "class": self.cls,
            "archetype": self.archetype, "ammo": self.ammo, "fx": self.fx,
            "desc": self.desc, "rarity": self.rarity, "rarity_label": self.rarity_label,
            "tier": self.tier, "level": self.level, "stats": self.stats.to_dict(),
            "perks": self.perks, "traits": self.traits, "palette": self.palette,
            "power_score": self.power_score, "assets": self.assets,
        }


# --------------------------------------------------------------------------- #
def _level_scale(level: int, per_level: float) -> float:
    level = max(1, min(MAX_LEVEL, int(level)))
    return 1.0 + per_level * (level - 1)


def roll_stats(slug: str, rarity: str = "common", level: int = 1,
               seed: Optional[int] = None, perks: bool = True,
               variance: float = ROLL_SPREAD) -> Stats:
    """Roll the final stats for one drop."""
    entry = catalog.get(slug)
    if rarity not in RARITIES:
        raise KeyError(f"unknown rarity {rarity!r}; pick one of {RARITY_ORDER}")
    base = dict(entry["base"])
    mult = RARITY_MULT[rarity]
    rng = random.Random(seed if seed is not None else f"{slug}:{rarity}:{level}")

    def jitter(stat: str, value: float) -> float:
        if value == 0 or variance <= 0:
            return value
        return value * (1.0 + rng.uniform(-variance, variance))

    out = {}
    for key, value in base.items():
        if key in ("pellets", "falloff"):
            out[key] = value
            continue
        v = float(value)
        if key == "damage":
            v *= mult["damage"] * _level_scale(level, PER_LEVEL["damage"])
        elif key == "magazine":
            v *= mult["magazine"] * _level_scale(level, PER_LEVEL["magazine"])
        elif key == "reload_time":
            v *= mult["reload"] if v > 0 else 1.0
        elif key == "spread":
            v *= mult["spread"]
        elif key == "crit_chance":
            v *= mult["crit"] * _level_scale(level, PER_LEVEL["crit"])
        elif key in ("splash_damage",):
            v *= mult["damage"] * _level_scale(level, PER_LEVEL["damage"])
        v = jitter(key, v)
        out[key] = v

    stats = Stats(
        damage=round(out.pop("damage"), 2),
        fire_rate=round(out.pop("fire_rate"), 3),
        magazine=int(round(out.pop("magazine"))),
        reload_time=round(out.pop("reload_time", 0.0), 3),
        spread=round(out.pop("spread"), 3),
        range=round(out.pop("range", 0.0), 2),
        projectile_speed=round(out.pop("projectile_speed", 0.0), 1),
        pellets=int(out.pop("pellets", 1)),
        crit_chance=round(min(0.95, out.pop("crit_chance", 0.0)), 4),
        crit_mult=round(out.pop("crit_mult", 1.0), 3),
        recoil=round(out.pop("recoil", 0.0), 2),
        noise=round(out.pop("noise", 0.0), 2),
        mobility=round(out.pop("mobility", 1.0), 3),
        splash_radius=round(out.pop("splash_radius", 0.0), 2),
        splash_damage=round(out.pop("splash_damage", 0.0), 2),
        spinup=round(out.pop("spinup", 0.0), 2),
    )
    if perks:
        apply_perks(stats, slug, rarity, rng)
    return stats


def available_perks(slug: str, rarity: str) -> List[dict]:
    entry = catalog.get(slug)
    base = entry["base"]
    return [p for p in PERK_POOL if "requires" not in p or base.get(p["requires"], 0) > 0]


def roll_perks(slug: str, rarity: str, seed: Optional[int] = None) -> List[dict]:
    """Roll ``PERK_COUNT[rarity]`` distinct perks for this weapon."""
    count = PERK_COUNT[rarity]
    if count <= 0:
        return []
    rng = random.Random(f"perks:{slug}:{rarity}:{seed}")
    pool = available_perks(slug, rarity)
    rng.shuffle(pool)
    perks = []
    for p in pool[:count]:
        magnitude = p["scale"] * rng.uniform(0.8, 1.35)
        perks.append({
            "id": p["id"],
            "stat": p["stat"],
            "amount": round(magnitude, 4),
            "invert": bool(p.get("invert", False)),
            "text": p["label"].format(v=int(round(magnitude * 100))),
        })
    return perks


def apply_perks(stats: Stats, slug: str, rarity: str, rng: random.Random) -> List[dict]:
    """Apply rolled perks in place and return them."""
    perks = roll_perks(slug, rarity, seed=str(rng.random()))
    for p in perks:
        cur = getattr(stats, p["stat"], 0.0)
        if cur == 0:
            continue
        new = cur / (1.0 + p["amount"]) if p["invert"] else cur * (1.0 + p["amount"])
        if p["stat"] == "magazine":
            new = int(round(new))
        else:
            new = round(new, 3)
        setattr(stats, p["stat"], new)
    return perks


def build(slug: str, rarity: str = "common", level: int = 1,
          seed: Optional[int] = None) -> RolledWeapon:
    """Full item: stats + perks + palette colours, ready to render or serialise."""
    from .palettes import build as build_palette

    entry = catalog.get(slug)
    stats = roll_stats(slug, rarity, level, seed=seed, perks=False)
    rng = random.Random(seed if seed is not None else f"{slug}:{rarity}:{level}")
    perks = apply_perks(stats, slug, rarity, rng)
    pal = build_palette(rarity)
    return RolledWeapon(
        slug=slug, name=entry["name"], cls=entry["cls"], archetype=entry["archetype"],
        ammo=entry["ammo"], fx=entry["fx"], desc=entry["desc"], rarity=rarity,
        tier=int(entry["tier"]), level=max(1, min(MAX_LEVEL, int(level))), stats=stats,
        perks=perks, traits=list(entry.get("traits", [])), palette=pal.as_hex(),
    )


# --------------------------------------------------------------------------- #
def balance_report(slug: Optional[str] = None, level: int = 12) -> str:
    """A monospace table of every weapon's sustained DPS at a given level."""
    rows = []
    slugs = [slug] if slug else catalog.slugs()
    for s in slugs:
        for rarity in ("common", "rare", "legendary"):
            w = build(s, rarity, level, seed=7)
            st = w.stats
            rows.append((w.tier, s, rarity, st.dps, st.damage, st.fire_rate, st.magazine,
                         st.reload_time, st.range, st.spread, w.power_score))
    header = (f"{'tier':>4} {'weapon':<16} {'rarity':<10} {'dps':>8} {'dmg':>8} "
              f"{'rps':>6} {'mag':>5} {'rld':>5} {'rng':>5} {'spr':>5} {'pwr':>6}")
    lines = [f"Balance @ level {level}", header, "-" * len(header)]
    for r in sorted(rows):
        lines.append(f"{r[0]:>4} {r[1]:<16} {r[2]:<10} {r[3]:>8.1f} {r[4]:>8.1f} "
                     f"{r[5]:>6.2f} {r[6]:>5} {r[7]:>5.2f} {r[8]:>5.1f} {r[9]:>5.2f} {r[10]:>6}")
    return "\n".join(lines)


def dps_curve(slug: str, rarity: str = "common", level: int = 1,
              target_health: float = 100.0) -> Dict[str, float]:
    """Handy for tuning: the rolled numbers that matter for a single drop."""
    w = build(slug, rarity, level)
    s = w.stats
    return {
        "dps": round(s.dps, 2),
        "burst_dps": round(s.burst_dps, 2),
        "shots_to_kill": s.shots_to_kill(target_health),
        "ttk": round(s.ttk(target_health), 3),
        "damage_per_magazine": round(s.damage_per_magazine, 1),
        "power_score": w.power_score,
    }
