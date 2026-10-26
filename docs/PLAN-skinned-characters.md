# Plan: replace box fighters with a skinned, animated character model

Goal: the fighters you see in a match stop being piles of boxes and become a
real rigged, skeletally-animated character — roughly Unreal Tournament '99 /
early Call of Duty fidelity. This is a **render-layer-only** change: hitboxes,
movement, netcode, and everything in `src/engine` are untouched. The repo's
architecture guard (`tools/check-layering.mjs`) enforces this; keep all new
three.js code inside `src/render/` (plus at most one preload call in
`src/client/Game.js`).

Work directly on `main` (solo repo, no PRs — see CLAUDE.md). Run `npm ci`
first in a fresh container, `npm test` before every commit.

## The asset (already committed — do not re-download)

`public/models/soldier.glb` (2.1 MB, glTF 2.0 binary). It is the Soldier from
the three.js examples (r186), originally a Mixamo character ("Vanguard").
Verified contents, parsed from the GLB JSON chunk:

- **Animations:** `Idle`, `Run`, `TPose`, `Walk` (no jump/death/shoot clips).
- **Meshes:** two skinned primitives — `vanguard_Mesh` (body) and
  `vanguard_visor`; materials `VanguardBodyMat` (textured) and
  `Vanguard_VisorMat`. Two skins.
- **Skeleton:** standard Mixamo rig, bones prefixed `mixamorig:` —
  notably `mixamorig:Hips`, `mixamorig:Spine2`, `mixamorig:Neck`,
  `mixamorig:Head`, `mixamorig:RightArm`, `mixamorig:LeftArm`, legs/feet, and
  full finger chains. Root scene node is named `Character`.

Add a credit line to `README.md` (or `CONTENT.md` if there's an existing
credits section): soldier model from the three.js examples (Mixamo), used in
this non-commercial fan project.

## Current state of the render layer (read these first)

- `src/render/ActorView.js` — the whole box-fighter: five rigid chunks
  (head/torso/2 arms/2 legs), one `MeshLambertMaterial` with `vertexColors`
  plus a face texture, procedural walk cycle driven by `snap.vel`, and these
  public APIs that **must keep working**: `setHeadScale(scale)`, `flashHit()`,
  `setStatus(effects, defs)` (emissive tint + `depthTest=false` see-through for
  the Bedazzler), `update(snap, pos, dt)`, `dispose()`, the `hidden` flag
  (local player's body invisible in first person), and the `faceUrl` /
  `face.setImage` dance used by `Renderer.applyFaces()`.
- `src/render/Renderer.js` — constructs `ActorView` synchronously in
  `syncActors()`. No shadow maps, pixel ratio capped, targets integrated GPUs.
- `src/client/Game.js` — `Game.start()` has a `BootProgress` step pipeline
  (`progress.run('Spawning fighters', ...)`) — the natural place to await a
  model preload. The per-frame call is `view.update(actor, pos, dt)` with
  interpolated positions.
- `src/render/charTexture.js` — generates the face texture (expressions:
  idle/hurt/angry/dead) and loads player face photos.
- Characters/content: `src/data/Content.js` defines characters with
  `appearance` colors and `hitbox` (incl. `eyeHeight`); `headScale` comes from
  the rule set (big-heads mode scales the head to mirror the real hitbox).

## Implementation steps

### 1. `src/render/CharacterModel.js` (new)

- Import `GLTFLoader` from `three/addons/loaders/GLTFLoader.js` and
  `SkeletonUtils` (`clone`) from `three/addons/utils/SkeletonUtils.js`. The
  `three` npm package (0.186.x) ships both under `three/addons/...` via its
  `exports` map — no new dependency.
- `export function preloadCharacterModel()` → loads `'models/soldier.glb'`
  once (module-level promise cache), resolves to `{ scene, animations }` or
  `null` on failure. **The URL must be relative** (`models/soldier.glb`, no
  leading slash) because `vite.config.js` uses `base: './'` for GitHub Pages
  subpath deploys. In the dev server and built site, `public/` contents are
  served at the root, so a relative URL from the page resolves correctly for
  `index.html`. (The editor page doesn't draw actors; don't preload there.)
- `export function instantiateCharacter()` → `SkeletonUtils.clone(scene)` —
  **never** plain `.clone()`, which breaks skinned meshes — plus per-instance
  material clones (see step 3). Return `null` if not loaded, so callers fall
  back to boxes.

### 2. `ActorView` grows a skinned path, keeps the box path as fallback

In the constructor, try `instantiateCharacter()`:

- **If it returns null** (load failed, or tests/editor contexts): build the
  existing box fighter unchanged. Do not delete the box code.
- **If it returns a model:**
  - Parent it under `this.body` (the yaw group) so facing keeps working.
  - **Orientation:** the box fighters face **−Z** (nose at negative z in the
    head geometry, weapon arm forward). Mixamo models face **+Z**, so rotate
    the model root `rotation.y = Math.PI`. Verify in the smoke screenshot —
    if fighters run backwards, this is the line that's wrong.
  - **Scale:** compute from the model's bounding box
    (`new THREE.Box3().setFromObject(model)`) against the character's hitbox
    height from content (`character.hitbox` — the box fighter stands ~1.8
    units: head pivot at y=1.62 + half-head). Scale uniformly so the model
    height matches the hitbox height; bake it on the model root. Don't
    hardcode a magic number without measuring.
  - Set `frustumCulled = false` on the skinned meshes — animated skins
    otherwise pop out of view when their static bounding sphere leaves the
    frustum.
  - **Animation:** one `THREE.AnimationMixer` per view. Create actions for
    `Idle`, `Walk`, `Run`, all `.play()`ed with weights (the three.js Soldier
    example's pattern). In `update()`, map horizontal speed
    (`Math.hypot(snap.vel.x, snap.vel.z)`) to weights: ~0 → Idle, mid → Walk,
    fast (near 8, the existing swing cap) → Run; lerp weights by `dt` so
    transitions ease. There is no jump clip: when `!snap.grounded`, freeze the
    mixer (don't call `mixer.update`) or drop timeScale to ~0.2 — pick
    whichever reads better in the smoke run.
  - **Per-frame bone overrides go AFTER `mixer.update(dt)`** (the mixer
    overwrites bone transforms every frame):
    - Head pitch: `mixamorig:Head` (or `Neck`) `rotation.x` from
      `-snap.pitch * 0.6` — note sign may flip vs. the box version because of
      the 180° model rotation; verify visually.
    - Big-heads: `setHeadScale(s)` stores the scale; apply it to the
      `mixamorig:Head` bone's scale each frame post-mixer. Bone scale
      propagates to the finger-level children only through the head's own
      subtree, which is what we want.
    - Weapon arm: optionally pose `mixamorig:RightArm` rotation so the right
      arm levels forward (the box version pins `armR.rotation.x = -0.9`).
      Nice-to-have; skip if it fights the animations badly.
  - `update()` keeps the exact same contract: set `group.position` from the
    interpolated `pos`, `body.rotation.y = snap.yaw`, visibility from
    `snap.alive && !this.hidden`, and early-return when hidden/dead (also skip
    `mixer.update` then).

### 3. Hit flash, status tints, see-through — port onto the skinned materials

- Clone the GLTF materials per actor (in `instantiateCharacter`) and collect
  them in an array on the view. `flashHit()` / `setStatus()` /the emissive
  pulse in `update()` then loop over that array setting `emissive` exactly as
  the single-material code does today. The materials are `MeshStandardMaterial`
  and have `.emissive`; works the same.
- See-through (`throughWalls`): set `depthTest = false` +
  `needsUpdate = true` on each material and `renderOrder = 10` on the group —
  same as today, just looped.
- **Face photos/expressions:** not portable to the modeled head — keep the
  `this.face` texture object alive (other code calls `view.face.setImage` /
  `setExpression`) but don't map it onto the soldier. Either keep creating the
  `makeCharacterTexture` object and simply not use its texture (cheapest), or
  stub those methods. `Renderer.applyFaces()` and the expression calls must not
  throw. Leave a TODO noting face support could return as a decal/billboard.
- **Per-player distinction:** the soldier's one texture makes everyone
  identical. Cheap prototype move: multiply `VanguardBodyMat`'s clone `.color`
  by the character's `look.accent ?? look.body` at ~50% strength
  (`new THREE.Color(accent).lerp(white, 0.5)`), so each character keeps a
  readable hue without turning to mud. Visor material stays untouched.

### 4. Preload wiring

In `Game.start()`, add a progress step before `syncActors` (around the
existing `'Spawning fighters'` step):

```js
await progress.run('Loading fighter model', () => preloadCharacterModel());
```

Import from `../render/CharacterModel.js`. A failed load resolves `null` (no
throw) and the game falls back to boxes — a Chromebook on a flaky connection
still gets a match. `Renderer.syncActors` needs no changes since `ActorView`
decides internally.

Check whether the weapons page (`weapons.html` → `src/weaponshop/`) or editor
construct `ActorView`; if they do, they'll just get the box fallback (fine).

### 5. Verify

1. `npm test` — must stay green (262 tests). The sim tests never touch the
   renderer, so failures here mean you leaked imports; the layering guard
   will also catch `src/render` importing `../client/`.
2. `npm run smoke` — builds, plays a real match in Chromium, screenshots.
   The repo pins playwright 1.56 in devDependencies; the container has a
   pre-installed Chromium — if playwright can't find a browser, launch with
   `executablePath: '/opt/pw-browsers/chromium'` (check `tools/smoke.mjs`
   for where launch happens) rather than running `playwright install`.
3. Eyeball the screenshot for: soldiers visible (not T-posing — T-pose means
   the mixer isn't updating), facing their movement direction (not
   backwards), feet on the floor (not sunk/floating — scale/origin issue;
   the Mixamo origin is between the feet, so the group position from the sim,
   which is the actor's feet position, should need no y offset — verify),
   and head pitch not inverted.
4. Send the screenshot to the user.

### 6. Commit

Straight to `main`, no branch, no PR. Write the commit message like a PR
description: what changed, the asset provenance/credit, what was deliberately
left behind (face photos, per-vertex color customization), and the fallback
behavior. Include whatever attribution footer the session's system reminder
specifies.

## Known risks / judgment calls

- **Death animation:** none exists in this GLB and corpses are hidden today
  (`group.visible = snap.alive`), so nothing is lost. Don't invent a ragdoll.
- **Mixer vs. interpolation:** `update()` receives render-frame `dt`; the
  mixer wants exactly that. No sim coupling.
- **Memory:** one shared GLTF, cloned skeletons per actor, cloned materials
  per actor. `dispose()` must dispose the cloned materials (geometry is
  shared with the cached scene — do NOT dispose geometry per-view, or
  dispose it only when you own it; simplest: dispose materials only, same as
  the box path disposes its material but note box path also leaves GEO_CACHE
  geometries alive forever, which is the existing precedent).
- **Performance:** ~8 fighters × 2 skinned meshes with full finger bones is
  fine on integrated GPUs, but the `medium`/`low` quality tiers exist — if
  smoke-run perf looks bad, an acceptable escape hatch is boxes on `low`.
  Don't build that unless needed.
- **If the model looks wrong in some unfixable way** (shading, scale,
  uncanny): fall back to reporting findings rather than forcing it; the box
  path still works and the user can pick a different asset pack next.
