"""The weapon catalog: names, classes, archetypes and *base* stats (level 1).

These are designer-facing numbers, not final ones: :mod:`weapon_assets.stats`
applies rarity tier and item level on top of them.
"""
from __future__ import annotations

from typing import Dict

# archetypes decide how the game should spawn/apply the weapon
ARCHETYPES = ("hitscan", "projectile", "beam", "melee", "explosive")

# damage falloff shapes
FALLOFF = ("flat", "linear", "sharp")

# fx keys map to the projectile / muzzle-flash art in effects.py
WEAPONS: Dict[str, dict] = {
    "pistol": {
        "name": "M9 Sidearm",
        "cls": "pistol",
        "tier": 1,
        "archetype": "hitscan",
        "ammo": "9mm",
        "fx": "bullet",
        "desc": "Standard-issue service pistol. Reliable, light, unremarkable.",
        "base": dict(damage=18, fire_rate=4.2, magazine=15, reload_time=1.9, spread=1.9,
                     range=32, projectile_speed=95, pellets=1, crit_chance=0.10,
                     crit_mult=2.0, falloff="linear", noise=6.0, recoil=1.0, mobility=1.00),
        "traits": ["Fast swap", "+10% move speed while equipped"],
    },
    "revolver": {
        "name": "Peacemaker .45",
        "cls": "revolver",
        "tier": 2,
        "archetype": "hitscan",
        "ammo": ".45 Long",
        "fx": "bullet_heavy",
        "desc": "Six rounds, hand-cannon recoil, and a very loud argument.",
        "base": dict(damage=52, fire_rate=1.6, magazine=6, reload_time=2.8, spread=1.2,
                     range=40, projectile_speed=105, pellets=1, crit_chance=0.22,
                     crit_mult=2.4, falloff="linear", noise=11.0, recoil=3.0, mobility=0.96),
        "traits": ["Ricochet on critical hits", "+35% headshot damage"],
    },
    "smg": {
        "name": "Vector-9",
        "cls": "smg",
        "tier": 2,
        "archetype": "projectile",
        "ammo": "9mm",
        "fx": "bullet",
        "desc": "Folds flat into a thigh holster. Empties a mag in the time it takes to blink.",
        "base": dict(damage=9, fire_rate=12.5, magazine=33, reload_time=1.7, spread=3.4,
                     range=20, projectile_speed=70, pellets=1, crit_chance=0.05,
                     crit_mult=1.7, falloff="sharp", noise=7.0, recoil=0.8, mobility=1.05),
        "traits": ["+18% fire rate while moving", "Reload cancels are 25% faster"],
    },
    "shotgun": {
        "name": "Trench 12",
        "cls": "shotgun",
        "tier": 2,
        "archetype": "projectile",
        "ammo": "12ga",
        "fx": "pellet",
        "desc": "Eight pellets of persuasion per trigger pull. Mind the reload.",
        "base": dict(damage=11, fire_rate=1.2, magazine=6, reload_time=3.1, spread=6.5,
                     range=12, projectile_speed=55, pellets=8, crit_chance=0.08,
                     crit_mult=1.8, falloff="sharp", noise=13.0, recoil=5.0, mobility=0.92),
        "traits": ["+40% damage inside 5m", "Staggers light enemies"],
    },
    "rifle": {
        "name": "Avtomat-74",
        "cls": "rifle",
        "tier": 3,
        "archetype": "projectile",
        "ammo": "5.45mm",
        "fx": "bullet",
        "desc": "The all-rounder. Nothing it does badly, nothing it does best.",
        "base": dict(damage=24, fire_rate=8.5, magazine=30, reload_time=2.4, spread=2.4,
                     range=42, projectile_speed=120, pellets=1, crit_chance=0.12,
                     crit_mult=2.0, falloff="linear", noise=9.0, recoil=1.8, mobility=1.00),
        "traits": ["First 5 shots have 40% less spread", "Select fire: semi / auto"],
    },
    "energy_pistol": {
        "name": "Voltmark E-9",
        "cls": "pistol",
        "tier": 3,
        "archetype": "projectile",
        "ammo": "Cell",
        "fx": "bolt_energy",
        "desc": "Sidearm rebuilt around a rechargeable cell. No brass, no bang, no mercy.",
        "base": dict(damage=34, fire_rate=6.0, magazine=20, reload_time=2.1, spread=1.6,
                     range=36, projectile_speed=150, pellets=1, crit_chance=0.15,
                     crit_mult=2.1, falloff="linear", noise=4.0, recoil=1.2, mobility=1.02),
        "traits": ["Overcharge: 3s of +50% damage after a kill", "Projectiles pierce 1 target"],
    },
    "laser_smg": {
        "name": "Ion Repeater",
        "cls": "smg",
        "tier": 4,
        "archetype": "beam",
        "ammo": "Cell",
        "fx": "beam_ion",
        "desc": "Continuous beam that ramps: hold the trigger and the damage climbs.",
        "base": dict(damage=15, fire_rate=14.0, magazine=90, reload_time=2.6, spread=1.1,
                     range=34, projectile_speed=200, pellets=1, crit_chance=0.10,
                     crit_mult=1.8, falloff="flat", noise=5.0, recoil=0.2, mobility=1.03),
        "traits": ["Ramps to +60% damage over 2s", "Beam reflects off energy shields"],
    },
    "sniper": {
        "name": "Longshot .338",
        "cls": "sniper",
        "tier": 4,
        "archetype": "hitscan",
        "ammo": ".338 Lapua",
        "fx": "bullet_heavy",
        "desc": "One shot, one very long conversation with the respawn timer.",
        "base": dict(damage=260, fire_rate=0.85, magazine=5, reload_time=3.4, spread=0.4,
                     range=120, projectile_speed=400, pellets=1, crit_chance=0.35,
                     crit_mult=2.6, falloff="flat", noise=16.0, recoil=8.0, mobility=0.82),
        "traits": ["Scope: 6x zoom, breath hold", "Headshots pierce through one target"],
    },
    "rocket_launcher": {
        "name": "Havoc RPG",
        "cls": "launcher",
        "tier": 4,
        "archetype": "explosive",
        "ammo": "Rocket 80mm",
        "fx": "rocket",
        "desc": "Area denial in a shoulder tube. Backblast is not a suggestion.",
        "base": dict(damage=240, fire_rate=0.9, magazine=1, reload_time=3.6, spread=0.6,
                     range=80, projectile_speed=42, pellets=1, crit_chance=0.05,
                     crit_mult=1.5, falloff="flat", noise=18.0, recoil=9.0, mobility=0.80,
                     splash_radius=3.6, splash_damage=140),
        "traits": ["140 splash damage in 3.6m", "Self-damage reduced 60%"],
    },
    "plasma_cannon": {
        "name": "Nova Lance",
        "cls": "launcher",
        "tier": 5,
        "archetype": "explosive",
        "ammo": "Plasma cell",
        "fx": "plasma",
        "desc": "Superheated plasma in a magnetic bottle. The bottle is the expensive part.",
        "base": dict(damage=190, fire_rate=1.4, magazine=4, reload_time=3.2, spread=1.0,
                     range=60, projectile_speed=38, pellets=1, crit_chance=0.10,
                     crit_mult=1.9, falloff="flat", noise=15.0, recoil=6.5, mobility=0.84,
                     splash_radius=4.4, splash_damage=180),
        "traits": ["Splash applies burning for 4s", "Charge shot: 2.2x damage, knockback"],
    },
    "minigun": {
        "name": "Vulcan M134",
        "cls": "minigun",
        "tier": 5,
        "archetype": "projectile",
        "ammo": "7.62mm",
        "fx": "bullet",
        "desc": "Spin-up time, then a wall of lead. You will not be aiming by the end.",
        "base": dict(damage=14, fire_rate=22.0, magazine=200, reload_time=5.2, spread=4.6,
                     range=45, projectile_speed=130, pellets=1, crit_chance=0.06,
                     crit_mult=1.8, falloff="linear", noise=20.0, recoil=0.6, mobility=0.62,
                     spinup=0.9),
        "traits": ["0.9s spin-up, then full rate", "Cannot sprint while firing"],
    },
    "shock_baton": {
        "name": "Arc Baton",
        "cls": "melee",
        "tier": 1,
        "archetype": "melee",
        "ammo": "Cell",
        "fx": "arc",
        "desc": "Riot baton with a charged tip. Chained lightning, no reload.",
        "base": dict(damage=55, fire_rate=2.2, magazine=0, reload_time=0.0, spread=0.0,
                     range=2.6, projectile_speed=0, pellets=1, crit_chance=0.20,
                     crit_mult=2.0, falloff="flat", noise=2.0, recoil=0.0, mobility=1.12),
        "traits": ["Chains to 2 nearby enemies for 45%", "Sprint attack: gap close 6m"],
    },
    "rocket_hammer": {
        "name": "Thunderfall",
        "cls": "melee",
        "tier": 5,
        "archetype": "melee",
        "ammo": "Fuel",
        "fx": "shockwave",
        "desc": "Rocket-assisted sledgehammer. The recoil is the intended feature.",
        "base": dict(damage=320, fire_rate=0.75, magazine=3, reload_time=4.0, spread=0.0,
                     range=3.4, projectile_speed=0, pellets=1, crit_chance=0.25,
                     crit_mult=2.2, falloff="flat", noise=19.0, recoil=10.0, mobility=0.74,
                     splash_radius=2.8, splash_damage=180),
        "traits": ["Ground slam: 2.8m shockwave", "Heavy attacks knock enemies airborne"],
    },
}


def slugs():
    return list(WEAPONS.keys())


def get(slug: str) -> dict:
    try:
        return WEAPONS[slug]
    except KeyError:
        raise KeyError(f"unknown weapon {slug!r}; known: {sorted(WEAPONS)}") from None
