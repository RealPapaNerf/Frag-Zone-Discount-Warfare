# Duct Tape Mode — Rule Spec

**Game:** Frag Zone: Discount Combat
**Mode flavor:** The devs are against violent video games. Every weapon is a "project." The announcer is a home-improvement show host. The kill feed says "Dallin's project was tested on Brother."
**Status:** Draft v0.1 — implement in phases (see bottom)

---

## 1. Premise

Nobody spawns with a gun. Everyone spawns with a roll of duct tape. Items are scattered around the map. Any item can kill on its own. Taping two items together makes a contraption that is more lethal than either part. The more items you tape together, the more lethal — and the more unstable — the contraption becomes.

The comedy comes from the match arc: scavenger hunt → garage inventions → everyone carrying a bomb → the map littered with half-exploded super-weapons that people loot off each other.

The fairness comes from instability and drops: the player winning is the one most likely to blow themselves up, and when they do, their parts become loot for everyone else.

---

## 2. Player Start State

| Field | Value |
|---|---|
| Primary | Duct Tape (roll) |
| Tape charges | 3 |
| Inventory slots | 2 items (held in hands) + 1 contraption |
| Health | 100 |

**Duct Tape (roll)** — melee weapon. Never breaks. Low damage (15). Swing rate 1.2/s. It is always available even with 0 charges; charges only gate *taping*, not swinging.

---

## 3. Items

Items are tiered by **how dumb they are**, not how strong. Dumber = higher tier. Each item has:

- `name`
- `tier` (1–3)
- `solo_damage` — what it does when swung/used by itself
- `solo_verb` — how it attacks alone (melee / lob / spray)
- `projectile` — what it fires when it becomes the "ammo" of a contraption
- `verb_bias` — which verbs it prefers when it becomes the "engine" of a contraption
- `spawn_weight`

### Tier 1 — Garage shelf (common)
| Item | solo_damage | solo_verb | projectile | verb_bias |
|---|---|---|---|---|
| Toaster | 20 | melee | hot toast | launches, burns |
| Broom | 15 | melee | bristles | spins |
| Rake | 20 | melee | tines | spins |
| Garden hose | 10 | spray (water, pushes) | water | sprays |
| Fire extinguisher | 15 | spray (blinds) | foam | sprays, launches |
| Plunger | 15 | melee (sticks) | plunger | launches |
| Bucket | 10 | melee | bucket | launches |
| Extension cord | 10 | melee (whip) | plug | zaps |

### Tier 2 — Shed (uncommon)
| Item | solo_damage | solo_verb | projectile | verb_bias |
|---|---|---|---|---|
| Leaf blower | 20 (push) | spray (push) | air | sprays, launches |
| Weed whacker | 35 | melee (sustained) | line | spins |
| Car battery | 40 | melee | sparks | zaps |
| Propane tank | 50 (explodes on 3rd hit) | melee | fireball | burns |
| Trampoline | 10 | deploy | player (self) | launches |
| Bug zapper | 30 | melee | arc | zaps |
| Pressure washer | 25 | spray | water jet | sprays |

### Tier 3 — Appliance (rare, 1–2 per map)
| Item | solo_damage | solo_verb | projectile | verb_bias |
|---|---|---|---|---|
| Lawn mower | 60 | melee (push) | blades | spins |
| Water heater | 70 | melee (very slow) | scalding water | sprays, burns |
| Chest freezer | 50 | melee (slow) | ice | launches |
| Riding mower | drivable | vehicle | mower | spins |

Spawn rule: Tier 1 items respawn 20s after pickup. Tier 2 respawn 45s. Tier 3 do not respawn — once they're in play, they're in play (and get scattered on drops).

---

## 4. Taping (Combining)

**Input:** hold both items (one in each hand), hold TAPE for 2.0 seconds.

- You are **vulnerable** while taping: movement speed 50%, can't attack, tape sound plays loudly (audible 20m).
- Costs 1 tape charge.
- Result: a **contraption** of `size = 2`.
- Taping a contraption + an item: `size += 1`. Max size 4.
- Taping two contraptions together: **not allowed** (keeps it readable). Show "too much tape" message.

### Engine and ammo
When two things are taped:
- The **engine** is the item with the stronger `verb_bias` (ties → the higher tier, then the one in your left hand).
- The **ammo** is the other item. Its `projectile` is what comes out.

Example: Leaf blower (engine, *sprays/launches*) + Lawn mower (ammo, *blades*) = **a leaf blower that shoots mowers.** Rake (engine? no — Car battery wins on verb_bias) → Car battery engine, Rake ammo = **electrified rake that zaps tines.**

### Verb table
The engine picks a verb from its bias list. Each verb defines firing behavior:

| Verb | Behavior | Base damage mult |
|---|---|---|
| shoots | single projectile, straight, 1 per 0.8s | 1.0x |
| sprays | cone, short range, continuous | 0.6x (per tick) |
| launches | arcing lob, splash on impact | 1.3x |
| zaps | hitscan chain to nearest 2 enemies | 0.9x |
| burns | projectile leaves a fire pool for 4s | 0.8x + DoT |
| spins | melee AoE around you, continuous | 1.1x |
| inflates | target swells for 3s then pops (delayed kill) | 1.5x, 3s delay |

### Damage formula
```
damage = (engine.solo_damage + ammo.solo_damage) * verb.mult * size_mult
size_mult: size 2 = 1.0, size 3 = 1.4, size 4 = 1.8
```

### Size effects
| Size | Effect |
|---|---|
| 2 | Contraption. Fires per verb. |
| 3 | **Full auto.** Fire rate ×3 regardless of verb. |
| 4 | **Recursion.** The contraption fires the size-3 version of itself as a projectile. The projectile fires in flight. (Generic rule: a tier-N weapon fires tier-(N-1) weapons.) |

### Name generation
`"{engine.name} that {verb} {ammo.name}s"` — e.g. "Leaf Blower that launches Toasters." Size 3 appends " (FULL AUTO)". Size 4 appends " (that shoots itself)". Show the generated name on pickup and in the kill feed.

---

## 5. Jank (the fairness lever)

Every contraption has a **jank chance** rolled on every trigger pull:

| Size | Jank chance |
|---|---|
| 2 | 10% |
| 3 | 25% |
| 4 | 50% |

**Jank outcomes** (roll on the jank table when it fires):

| Weight | Outcome |
|---|---|
| 40% | **Backfire** — fires in the opposite direction. |
| 35% | **Falls apart** — contraption splits into its components, which scatter 2–4m on the floor. Anyone can grab them. You're left holding the tape. |
| 25% | **Goes off in your hands** — full damage to self (and splash if verb has splash). |

The size-4 death machine is a bomb you are carrying. That is the point.

Optional tuning knob: `jank_scaling_by_rank` — the player in 1st place gets +5% jank on everything. Default **off**; turn on if the good brother still dominates.

---

## 6. Tape Economy

- Starting charges: 3.
- Tape rolls spawn around the map (Tier 1 spawn rate). Pickup = +3 charges, max 6.
- **Untape (sabotage):** hitting an enemy's *contraption* with your tape roll (melee) knocks the top item off it. The item drops at their feet. Costs 0 charges. This is the losing player's point-blank answer to a super-weapon.
  - Only works if you hit the weapon hitbox (aim at the gun, not the body). Generous hitbox.
  - Their contraption drops one size. If it was size 2 it becomes two loose items.

---

## 7. Death and Drops

- On death you **do not keep your contraption.**
- Your contraption drops **where you died, intact, with its current size.**
- Your two held items (if any) drop beside it.
- You respawn with: duct tape, 3 charges (not your previous count), nothing else.
- Dropped contraptions despawn after 60s if nobody picks them up.
- Dropped contraptions have a visible tag: `"{owner}'s project"` and a size badge.

This makes a kill a **loot drop of your brother's genius.** He has to decide whether to run back for it before someone else does.

---

## 8. Match Flow (expected arc)

| Phase | ~Time | What's happening |
|---|---|---|
| Scavenger | 0–1:30 | Everyone's running around with brooms and plungers. Tape melee duels. |
| Garage | 1:30–4:00 | First contraptions. Size 2 and 3 appear. First backfires. |
| Litter | 4:00+ | Size 4s exist. They blow up. The map is covered in other people's parts. People are running around with other people's inventions. |

Match length: 8 minutes default, or first to 20 "project tests."

---

## 9. Scoring

- Kill ("project tested"): +1
- Kill with a size-4: +2 (you earned the risk)
- Kill with the duct tape roll alone: +3 ("built from scratch")
- Killed by your own jank: −1, and the announcer says something encouraging.
- Untape an enemy's size-4: +1

---

## 10. HUD / Flavor

- Weapon slot label says **PROJECT**, never "weapon."
- Jank chance shown on the contraption as a little "stability" meter in the style of a hardware-store price tag.
- Kill feed: `"{killer}'s project was tested on {victim}"`.
- Self-kill: `"{player}'s project needs more tape"`.
- Announcer: home improvement host. Lines on size 4: "Now THAT'S a weekend project." On backfire: "Measure twice."
- Taping animation: the player actually wraps tape around the two objects. It looks bad. Good.

---

## 11. Open Questions / Tuning Notes

- [ ] Should untape have a small cooldown so you can't just stand there chipping?
- [ ] Is size 4 recursion readable in practice, or should it cap at 3 + a "mega" tier?
- [ ] Does the first-place player need the extra jank, or do drops alone balance it?
- [ ] Trampoline + fire extinguisher = jetpack — does "launches self" need its own verb (`yeets`)?
- [ ] Propane tank: explodes on the 3rd *hit as ammo*? Or on the 3rd *time you're hit while holding it*? (Leaning: both.)
- [ ] Should Tier 3 items have a pickup animation long enough to get you killed? (Yes, probably.)
- [ ] Sister handicap: does she start with 6 charges and lower jank? Hide it in "Grandma Mode."

---

## 12. Implementation Phases

**Phase 1 — Core loop (playable with bots)**
- Duct tape melee
- 6 Tier-1 items, solo attacks only
- Taping two items → contraption with `shoots` verb only
- Death drops contraption intact
- Scoring: kills only

**Phase 2 — The system**
- Full verb table
- Engine/ammo resolution
- Size 3 full auto
- Jank table (all 3 outcomes)
- Tape economy + untape

**Phase 3 — Dumb stuff**
- Size 4 recursion
- Tier 2 and 3 items
- Name generation in kill feed
- Announcer lines
- Taping animation

**Phase 4 — Balance pass**
- Play it with the sister. Add `jank_scaling_by_rank` if needed. Tune drop despawn.

---

## 13. Reuse Notes

The **verb table + engine/ammo resolution** is the same engine the general Weapons Builder needs. Build it once as a standalone module (`contraption.js` / whatever) so Clearance Bin (stapler → staple gun → stapler gun → stapler gun gun) and Construction Zone (mulcher → mulcher cannon) use the same recursion rule.
