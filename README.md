# OPERATION BLACKOUT

A browser-based tactical first-person shooter built from scratch with Three.js.
Hold Forward Outpost **EAGLE-7** against escalating waves of attackers.

Everything you see and hear is generated at runtime: procedural canvas textures,
procedurally built weapons, soldiers, terrain and structures, and a WebAudio
synthesiser for every gunshot, footstep and explosion. There are no external
asset files.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production bundle in dist/
npm run smoke      # headless gameplay smoke test (no browser required)
```

## Controls

| Action | Keyboard / mouse | Touch |
| --- | --- | --- |
| Move | `W` `A` `S` `D` | left stick (push fully to sprint) |
| Look | mouse (click to capture) | drag the right half of the screen |
| Fire | left mouse | fire button |
| Aim down sights | right mouse | ADS button |
| Reload | `R` | reload button |
| Grenade | `G` | grenade button |
| Jump / crouch | `Space` / `Ctrl` (`C` toggles) | jump / crouch buttons |
| Swap weapon | `1` `2` `3` or `Q` | swap button |
| Pause | `Esc` | pause from the HUD |

Arrow keys also turn the camera, which makes the game playable with a keyboard
alone.

## Gameplay

- Wave survival: 15-second intermissions, escalating enemy types — riflemen,
  breachers, heavies and tower marksmen.
- Four loadouts (assault, breacher, recon, support), each with a primary and an
  M9 sidearm. Kills award score; headshots count double damage.
- Explosive fuel drums chain-detonate, ammo/health/armor pickups drop from
  attackers, and a streak reward resupplies you every five kills.
- Radar, compass, kill feed, hit markers, damage direction indicator and
  suppression vignette are drawn on a DOM/canvas HUD.
- Graphics options (quality preset, render scale, FOV, sensitivity, aim assist,
  touch forcing) persist to `localStorage`.

## Architecture

```
src/
  core/      Utils, Settings, procedural Textures, WebAudio engine, Input
  world/     CollisionWorld, Map (Outpost EAGLE-7), NavGrid flow field, Environment
  render/    RenderSystem (renderer + post stack), PassthroughPass (view model)
  fx/        pooled particles, decals, tracers, explosions, shells
  weapons/   Viewmodel (procedural guns), WeaponSystem (ballistics, ammo, ADS)
  entities/  Player, Enemy (AI), Projectile (grenades, pickups)
  ui/        HUD, Screens
  game/      Game (wave director, pools, scoring, HUD state)
tools/
  smoke.mjs  headless test harness: DOM stub + 150 s scripted firefight
```

The AI shares a single flow field (`world/NavGrid.js`) rebuilt a few times a
second, so attackers route through the gates and around buildings without a
per-agent navmesh.

## Testing

`npm run smoke` boots the whole simulation inside a Node DOM stub, runs 150
simulated seconds of scripted combat (a bot that holds the compound, aims down
sights, bursts, reloads, swaps weapons, throws grenades and detonates barrels)
and asserts ~40 invariants: materials, level geometry, collision, navigation,
weapon state, ammo, AI states, wave progression and the menu/settings wiring.
`SEED=<n> npm run smoke` makes a run deterministic.
