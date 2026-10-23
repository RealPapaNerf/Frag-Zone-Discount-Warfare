# Content formats

Everything the engine plays is a JSON document under `public/data/`, fetched
at runtime and validated on load by `src/data/Content.js`. Nothing is baked
into the bundle, so a future map editor or weapons builder can hand the engine
a document it has never seen.

Every document carries `"schema": 1` and an `"id"` that must match its
filename. `manifest.json` lists what to load — a static host cannot be
globbed, so new files must be registered there.

---

## `manifest.json`

```jsonc
{
  "schema": 1,
  "content": {                       // what to fetch, by folder
    "maps": ["blockout_arena"],
    "weapons": ["rifle", "rocket_launcher"],
    "characters": ["grunt"],
    "modes": ["deathmatch"],
    "mutators": ["low_gravity", "big_heads"],
    "bots": ["easy", "normal", "hard"]
  },
  "defaults": {                      // what the lobby starts on
    "map": "blockout_arena",
    "mode": "deathmatch",
    "character": "grunt",
    "botProfile": "normal",
    "botCount": 3,
    "mutators": [],
    "loadout": ["rifle", "rocket_launcher"]
  }
}
```

---

## `maps/*.json`

Geometry is axis-aligned boxes ("brushes"), which keeps collision exact and
cheap. Positions are centres; sizes are full extents. Y is up, metres.

```jsonc
{
  "schema": 1,
  "id": "blockout_arena",
  "name": "Blockout Arena",
  "gravity": -22,                    // m/s², negative is down
  "killZ": -25,                      // fall below this and you die
  "bounds": { "min": [-32, -25, -32], "max": [32, 40, 32] },

  "environment": {
    "sky": "#121820",
    "fog": { "color": "#121820", "near": 40, "far": 150 },
    "ambient": { "sky": "#8fb6ff", "ground": "#3a3426", "intensity": 1.15 },
    "sun": { "direction": [-0.45, -1, -0.3], "color": "#fff2d8", "intensity": 1.5 }
  },

  "materials": {                     // referenced by brush.material
    "floor": { "color": "#3c4350" }
  },

  "brushes": [
    { "pos": [0, -0.5, 0], "size": [64, 1, 64], "material": "floor" }
  ],

  "jumpPads": [
    { "pos": [14, 0.08, 14], "size": [3, 0.16, 3],
      "launch": [5.26, 22, 5.26],    // velocity set on touch, m/s
      "color": "#36e0ff" }
  ],

  "spawns": [ { "pos": [-27, 0.1, -27], "yaw": 0.785 } ],
  "pickups": [],                     // reserved; nothing reads this yet

  "waypoints": {
    // Most edges are derived: two nodes link if they are close, within a step
    // height of each other, and mutually visible.
    "autoLink": { "maxDistance": 11, "maxStepUp": 1.9,
                  "requireLineOfSight": true, "eyeHeight": 0.9 },
    "nodes": [ { "id": "n0", "pos": [-30, 0, -30], "tags": ["ground"] } ],
    // Traversals geometry cannot imply are listed explicitly.
    "links": [ { "from": "n77", "to": "n76", "kind": "jumppad",
                 "oneWay": true, "cost": 4 } ]
  }
}
```

`tools/gen-blockout-arena.mjs` builds the shipped arena, including sampling
the nav nodes off the geometry. The seeded map generator milestone grows out
of that script.

---

## `weapons/*.json`

```jsonc
{
  "schema": 1,
  "id": "rocket_launcher",
  "name": "Discount Rocket Launcher",
  "slot": 2,

  "fire": {
    "type": "projectile",            // "hitscan" | "projectile"
    "rpm": 70,
    "auto": false,                   // held trigger repeats?
    "pellets": 1,
    "spreadDeg": 0,
    "spreadDegMoving": 2.1,          // hitscan only
    "range": 400,
    "damage": 92,                    // direct hit
    "headshotMultiplier": 1.0,
    "knockback": 6.0,                // m/s along the shot
    "falloff": { "startDistance": 45, "endDistance": 180, "minScale": 0.55 }
  },

  "projectile": {                    // required when type is "projectile"
    "speed": 42, "radius": 0.22, "gravityScale": 0, "lifetime": 6,
    "spawnOffset": [0.18, -0.12, -0.6], "color": "#ff7a2f"
  },

  "splash": {                        // optional radial damage
    "radius": 5.6,
    "damage": 88,                    // at the epicentre
    "minDamage": 14,                 // at the edge
    "knockback": 17.5,               // m/s at the epicentre
    "minKnockback": 4.0,
    "selfDamageScale": 0.45,         // you take less from your own blast...
    "selfKnockbackScale": 1.0,       // ...but the full shove. Rocket jumps.
    "upBias": 0.35                   // lifts the knockback vector
  },

  "ammo": { "max": 30, "start": 12, "perShot": 1 },
  "recoil": { "pitch": 2.2, "yaw": 0.4, "recovery": 6.0 },
  "view": { "shape": "launcher", "color": "#6f7a66", "accent": "#ff7a2f",
            "offset": [0.28, -0.26, -0.44], "muzzle": [0, 0.04, -0.72], "kick": 0.11 },
  "tracer": { "color": "#9fe9ff", "width": 0.025, "life": 0.07 },
  "onHit": []                        // reserved for the weapons builder
}
```

Splash damage falls off linearly and is blocked by line of sight, so cover
works. Self-damage is scaled down while self-knockback is not — that pairing
is what makes rocket jumping worth the health.

### `view` — what the thing looks like

`view.parts` is a list of primitives, and it is the only description of an
item's shape anywhere: the weapon in your hands, the same weapon dropped on
the floor, and a deployable trap are all built from it by
`src/render/parts.js`. A new item needs no renderer code.

**Every shape is given by its bounding box.** `size: [x, y, z]` means the
same thing whatever `shape` is, so a sphere of `[0.2, 0.1, 0.2]` is an
ellipsoid 20cm across and 10cm tall. You never work out a radius. Weapons
point down −Z, and the grip sits near the origin.

```jsonc
{ "shape": "cylinder",       // box (default) | cylinder | cone | disc
                             // sphere | capsule | torus | wedge | decal
  "size": [0.15, 0.15, 0.62],
  "pos": [0, 0, -0.26],
  "axis": "z",               // long axis of a round shape; default z
  "taper": 0.17,             // diameter of the far (−axis) end
  "arc": 195, "arcStart": 173, // part-cylinder, in degrees: a saw guard
  "tube": 0.018,             // torus only: thickness of the ring
  "rot": [0, -24, 0],        // degrees
  "facing": "nx",            // aim a flat part; composes with rot
  "color": "accent",         // "body" | "accent" | any CSS colour
  "finish": "metal",         // matte (default) | plastic | metal | glow
  "opacity": 0.45,
  "segments": 8 }
```

`wedge` is a triangular prism — full width at −Y, tapering to an edge at +Y,
extruded along Z. That is a knife blade; rolled over with `rot` it is a roof,
a ramp or an axe bevel.

A `decal` is text or packaging art on a canvas, laid on the surface of the
part under it. It is where most of the comedy lands, because a silhouette can
say "handheld kitchen gadget" and only the word GINSU says which one.

```jsonc
{ "shape": "decal", "size": [0.15, 0.038], "pos": [0.0075, 0.012, -0.24],
  "facing": "px",            // which way it looks
  "text": "GINSU",           // or "lines": ["CAUTION", "WET FLOOR"]
  "color": "#39414b", "bg": null, "outline": null,
  "font": "condensed",       // condensed | sans | serif | script
  "style": "burst",          // burst | holes | ribs | slip
  "markColor": "#1b1b1b", "count": 7,
  "width": 256, "height": 128 }
```

`style` draws art behind the text: `burst` is a retail starburst, `holes` a
cheese-grater field, `ribs` grill grates or vents, and `slip` the little man
going over backwards off a wet floor sign.

Two rules the models are built to, both learned the hard way:

- **The player sees the item's left flank.** The view model is held to the
  right of the camera, so a joke on the front of a thing — a doorbell's
  button, a rotisserie's window — is invisible in first person. Put it on
  `nx` as well, or turn the whole item with `view.rot`.
- **Big items are held further away.** `ViewModel` measures the built model
  and pushes anything that would run off the edge of the screen back until
  it fits, so a rotisserie oven and a paring knife are both legible. It only
  ever pushes away, so an item that already fits keeps its authored pose.
  `view.fit` tunes the margin, and `"fit": false` opts out.

`view.shape` (`"rifle"` or `"launcher"`) is the fallback for a weapon with no
parts list.

---

## `characters/*.json`

```jsonc
{
  "schema": 1,
  "id": "grunt",
  "name": "Grunt",
  "health": 100,
  "armor": 0,
  "hitbox": { "radius": 0.42, "height": 1.78, "eyeHeight": 1.6, "headHeight": 0.34 },
  "move": {
    "maxSpeed": 10.2, "crouchSpeed": 4.6,
    "groundAccel": 11, "airAccel": 1.6, "airMaxSpeed": 2.4,
    "friction": 7.5, "stepHeight": 0.52, "jumpVelocity": 9.6
  },
  "appearance": { "body": "#4d6fa8", "head": "#d9b48a",
                  "accent": "#ffd34d", "faceTexture": null }
}
```

`appearance.faceTexture` is where the character designer's photo-on-face will
land.

---

## `deployables/*.json`

A deployable's `view` takes the same `parts` list as a weapon, built by the
same code, except that it stands on the floor: `y: 0` is the ground, so parts
sit above it. A definition with no parts list falls back to the old coloured
box so it still appears while it is being drawn.

---

## `modes/*.json` and `mutators/*.json`

A mode is a bag of rule values. A mutator is an ordered list of patches
against that bag. Stacking two mutators is applying two patch lists in
sequence — there is no mode class anywhere in the engine.

```jsonc
// modes/deathmatch.json
{
  "schema": 1, "id": "deathmatch", "name": "Deathmatch",
  "rules": {
    "teams": false, "friendlyFire": false,
    "scoreLimit": 25, "timeLimitSec": 600, "respawnDelaySec": 1.6,
    "scorePerKill": 1, "scorePerSuicide": -1
  },
  "mutators": []                     // mutators this mode always implies
}
```

```jsonc
// mutators/low_gravity.json
{
  "schema": 1, "id": "low_gravity", "name": "Low Gravity",
  "description": "Moon rules.",
  "patches": [
    { "path": "gravityScale", "op": "mul", "value": 0.42 },
    { "path": "airAccelScale", "op": "mul", "value": 1.6 }
  ]
}
```

`op` is one of `set`, `add`, `mul`, `min`, `max`, `toggle`. A `path` that is
not a known rule throws on load rather than being ignored, so a typo in a
mutator is loud instead of mysterious.

The full rule set, with defaults, is `DEFAULT_RULES` in
`src/engine/rules/RuleSet.js`:

| Rule | Meaning |
| --- | --- |
| `teams`, `friendlyFire` | team play toggles |
| `scoreLimit`, `timeLimitSec`, `respawnDelaySec` | match flow |
| `scorePerKill`, `scorePerSuicide` | scoring |
| `gravityScale`, `moveSpeedScale`, `jumpScale`, `airAccelScale` | physics multipliers |
| `damageScale`, `knockbackScale`, `selfDamage`, `headshots` | combat |
| `startHealth`, `maxHealth`, `infiniteAmmo` | loadout |
| `headScale`, `bodyScale` | model *and* hitbox scale |
| `forcedLoadout` | `null`, or an array of weapon ids that overrides the player's pick |

---

## `bots/*.json`

Difficulty is entirely data. Every handicap that makes a bot beatable lives
here.

```jsonc
{
  "schema": 1, "id": "normal", "name": "normal",
  "reactionTimeSec": [0.24, 0.40],   // delay before a new target may be shot at
  "aimErrorDeg": [2.2, 5.0],         // cone the aim is offset into, per target
  "aimDriftHz": 0.8,                 // how fast that offset rotates
  "aimTrackSpeed": 5.0,              // how fast the aim swings onto a target
  "fireConeDeg": 9,                  // how settled the aim must be to shoot
  "rocketLeadSkill": 0.55,           // 0 = never leads, 1 = perfect lead
  "fovDeg": 140, "viewRange": 95,
  "forgetTargetSec": 2.6, "repathSec": 1.2,
  "strafeChance": 0.65, "strafeSwitchSec": [0.6, 1.8],
  "jumpChance": 0.1,
  "preferredRange": [9, 34], "rocketMinRange": 7,
  "perceptionIntervalSec": 0.1
}
```

The shipped profiles measure roughly 6.6 / 16.6 / 33.2 damage per second
against a standing target at mid range — a number `tests/bots.test.mjs`
asserts the ordering of, so retuning a profile cannot silently flatten the
difficulty curve.
