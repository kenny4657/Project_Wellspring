# Project Wellspring — Engineering Notes for Claude Code

This file is the onboarding doc for future Claude Code sessions. Read this
first before touching anything in `src/lib/engine/`.

## What this project is

A Babylon.js 9.0 hex-grid planet renderer. The user is migrating it from a
per-hex-prism mesh (legacy, ~19.68M verts) to a shader-driven smooth sphere
(target: 1M+ hexes at 60 fps). Both renderers coexist behind a render-mode
dropdown so we can ship the rewrite incrementally.

The migration follows the 8-phase plan in
**`docs/shader-globe-transition-plan.md`** — that file is the source of truth
for what each phase delivers and why. Read it before starting any phase work.

## Phase status (as of last session)

| Phase | Status | Result doc |
|---|---|---|
| 0 — De-risk & instrument (perf, render-mode dropdown, reference snapshots) | DONE | — |
| 1 — Hex data textures (terrain/height/owner RGBA8) | DONE + audited | — |
| 2 — GLSL `worldPosToHexId` spike | DONE + audited | `docs/phase2-spike-result.md` |
| 3 — Smooth icosphere base mesh + flat material | DONE + audited | — |
| 4 — Port terrain shading to texture-driven | DONE + audited + visual fixes | `docs/phase4-result.md` |
| 5 — Vertex displacement (Strategy 3) | DONE + audited | `docs/phase5-6-result.md` |
| 6 — Cliff-face noise + stratification | DONE + audited | `docs/phase5-6-result.md` |
| 7 — Painting + click reconciliation | NOT STARTED | — |
| 8 — Optimize for 1M-hex scale | NOT STARTED | — |

**Recent visual-quality work** (commits after Phase 5+6 audit) addressed
several "doesn't look like the original" issues. The most recent commit is
`8b9c36d` ("Phase 5+6: dFdx normals, water-flatten, boundary-noise — match
legacy quality"). Five structural fixes landed:
1. `dFdx/dFdy` surface normals so the legacy `GLSL_CLIFF_RENDERING` chunk's
   `steepness > 0.003` gate fires (slab-rock cliff texture renders).
2. Water hex tops collapse to `WATER_FLAT_DEPTH = -0.001R` so water surface
   reads smooth (no stair steps between deep/shallow).
3. Inline water rendering moved to AFTER cliff/beach overlays via string-
   spliced `GLSL_BEACH_OVERLAY_NO_CLOSE` so the legacy chunks don't paint
   rock textures over water hex tops. Sharp coast boundary.
4. **Boundary-noise perturbation** of the hex lookup position in fragment
   shader — colors now follow noise-bent boundaries instead of the perfect
   60° hex edges. Coastlines look wavy.
5. Phase 6 cliff noise tuned: freq 6 → 40, amp 0.005 → 0.010, mesh
   subdivisions 80 → 100 (600k verts).

## Open issues (queued from user feedback)

1. **Low-poly faceted terrain** — `dFdx/dFdy` gives per-triangle facet
   normals, so adjacent triangles within a hex face have visibly different
   shading. Legacy uses smooth per-vertex normals. The fix is queued: compute
   analytic normals in the VERTEX shader by sampling the displacement
   function at two tangent offset positions per vertex (`phase5AndPhase6Displacement`
   called 3x — own + 2 offsets — then cross product). Pass smooth normal as
   varying, fragment uses it. ~3x vertex shader cost; need to verify FPS holds.
   See the queued todo from the last session.

2. **Water sphere not reattached.** Babylon's depth renderer uses an
   un-displaced vertex shader, so water-sphere depth-occlusion would discard
   everywhere. Phase 8 work — write a custom displacement-aware depth
   material. Documented in `globe.ts:applyRenderMode` shader-preview branch.

3. **Phase 7 click-reconciliation not done.** GLSL face-grid lookup
   disagrees with CPU `pickHex` (nearest-center) at ~18% of fragments —
   boundary clicks paint a different cell than the visible one. Plan
   recommends adding a 6-neighbor refinement to GLSL via a per-cell-center
   RGBA32F texture. See Phase 7 in the plan + `docs/phase2-spike-result.md`.

## Architecture

### Render modes

Three render modes selectable via `engine.setRenderMode()`:
- **`shader-preview`** — DEFAULT. Phase 3 smooth icosphere with the full
  Phase 4–6 shader. Page lands here out of the box. Builds in ~3 s.
- **`legacy`** — original per-hex-prism mesh + water-sphere. **LAZY-BUILT**
  on first switch (`ensureLegacyBuilt()`); ~17 s extra wait the first
  time, cached after. Until built, `legacy` is null and the per-frame
  uniform pushes / `setHexTerrain` / `setGridVisible` / `setTerrainSettings`
  / perf overlay all short-circuit. Bit-for-bit unchanged through this
  rewrite once built.
- **`shader-debug`** — same icosphere with `shader-globe-debug-material`.
  Used by `scripts/phase2-verify.mjs` for hex-ID verification (raw-bit
  encoded pixels). FXAA off in this mode so the verifier can read pixels.

### Key files

```
src/lib/engine/
  globe.ts                          # GlobeEngine: scene, camera, render-mode
                                    # toggle, render loop, public API
  shader-globe-mesh.ts              # CreateIcoSphere (subdivisions=100,
                                    # 600k verts, 200k tri). flat=false.
  shader-globe-material.ts          # Phase 4+5+6 material: hex lookup,
                                    # vertex displacement, biome shading.
                                    # Imports legacy GLSL chunks from
                                    # terrain-material.ts; adds
                                    # GLSL_HEX_HELPERS shared between
                                    # vertex and fragment.
  shader-globe-debug-material.ts    # Phase 2 verifier material. Output
                                    # modes 0-5: hex-ID hash, face index,
                                    # (i,j) heatmap, raw ID bits, terrain
                                    # from texture, height from texture.
  hex-data-textures.ts              # Phase 1: 3 RGBA8 textures keyed by
                                    # hexId (terrain/height/owner). Layout
                                    # x=id%size, y=floor(id/size).
  hex-id-lookup.ts                  # Phase 2: builds the lookup texture +
                                    # face data. Includes the CPU mirror
                                    # `pickHexByFaceGrid` for verification.
  icosphere.ts                      # Hex-grid generator. Now exports
                                    # generateIcoHexGridWithFaces for the
                                    # shader pipeline (face vertices,
                                    # faceGrid, ico vertices for pentagons).
  terrain-material.ts               # Legacy ShaderMaterial. GLSL chunks
                                    # are EXPORTED from here so
                                    # shader-globe-material can re-use
                                    # them verbatim.
  globe-mesh.ts                     # Legacy per-hex-prism mesh.
                                    # buildGlobeMesh / updateCellTerrain.
  water-material.ts                 # Legacy water-sphere shader.
                                    # `deepColor`/`shallowColor` consts
                                    # (0.08,0.18,0.35) and (0.15,0.35,0.55)
                                    # are reused by shader-globe-material.
  hex-borders.ts                    # LEVEL_HEIGHTS = [-0.020, -0.008, 0,
                                    # 0.005, 0.010] (fractions of R) and
                                    # classifyEdge for cliff classification.
                                    # Mirrored in shader-globe-material's
                                    # `tierHeight` and steep-cliff logic.
  perf-gpu-timer.ts                 # Phase 0: safer
                                    # EXT_disjoint_timer_query_webgl2
                                    # wrapper. Off by default; enable via
                                    # ?gputime=1.
  benchmark.ts                      # Phase 0: 8-waypoint orbit benchmark.
                                    # 16s, logs min/median/p99/mean.

scripts/
  snapshot-references.mjs           # Capture 4 reference screenshots
                                    # (top-down, near-horizon, equator,
                                    # polar) to docs/reference-screenshots/.
  phase2-verify.mjs                 # GLSL hex ID vs CPU 3-way comparison.
                                    # Uses shader-debug mode + raw ID bits.
  phase1-3-verify.mjs               # Phase 1 byte integrity (CPU + GPU
                                    # readback) + Phase 3 flat-color check.
  phase4-verify.mjs                 # 4-camera side-by-side legacy vs
                                    # shader-preview composites. Saves to
                                    # docs/phase4-screenshots/.
                                    # KEEP THE NAME -- not phase-specific.

docs/
  shader-globe-transition-plan.md   # SOURCE OF TRUTH. 8-phase plan with
                                    # decisions and risk register.
  phase2-spike-result.md            # Phase 2 spike conclusions
                                    # (gnomonic projection, pentagons).
  phase4-result.md                  # Phase 4 deliverable summary.
  phase5-6-result.md                # Phase 5+6 deliverable summary.
  reference-screenshots/            # Phase 0 frozen baselines.
  phase4-screenshots/               # Side-by-side composites
                                    # (regenerated each verifier run).
```

### How the shader pipeline works

Everything keys off `worldPosToHexId(P)`. Given a unit-sphere point P:

1. **Pentagon check**: 12 dot products against icosahedron vertices. If
   `dot(P, vert) > pentagonThreshold`, return that pentagon's cellId.
2. **Face find**: 20 dot products against face centroids; pick max.
3. **Gnomonic projection**: project P along the ray from origin onto the
   face's planar triangle. Compute planar barycentric of the projection.
4. **(i, j) recovery**: invert `icosphere.ts:barycentric()` formula.
   `cz = l3 * sqrt(3)/2; cx = l2 - 0.5*(1-l3)`. Snap to grid.
5. **Lookup**: `hexLookup` RGBA8 texture at pixel `(face*gridSize + j, i)`.
   Decode 16-bit cellId from RG channels. Sentinel `0xFFFF` = no-hex.

The CPU mirror `pickHexByFaceGrid` in `hex-id-lookup.ts` does the same math
in JS for verification and for the click-reconciliation work in Phase 7.

### GLSL chunk system

`shader-globe-material.ts` builds its fragment by concatenating named GLSL
strings, importing the legacy chunks from `terrain-material.ts` verbatim:

```
GLSL_NOISE                  (legacy: precision, lighting/palette uniforms,
                             varyings, snoise, hash, slabMap)
GLSL_PHASE4_UNIFORMS        (Phase 1/2/4/6 uniforms + vSpherePos varying)
GLSL_COASTAL_CONSTANTS      (legacy: beach/cliff tunable defines)
GLSL_SCRATCHY               (legacy: triplanarScratchy helpers)
GLSL_PALETTE                (legacy: palShore/Grass/Hill/Snow + computeTerrainColor)
GLSL_HEX_HELPERS            (Phase 2/4: computeHexLookup, sampleHexData,
                             neighborIdAtEdge, tierHeight,
                             phase5AndPhase6Displacement)
GLSL_MAIN_SETUP_NEW         (Phase 4 main(): boundary-noise perturbation,
                             6-neighbor scan, palette computation)
GLSL_CLIFF_RENDERING        (legacy: water-cliff blend, slab-rock texture,
                             cliff-foot sand)
GLSL_BEACH_OVERLAY_NO_CLOSE (legacy beach overlay with trailing `}` stripped)
GLSL_WATER_OVERRIDE_LAST    (Phase 4: inline water rendering AFTER cliff/
                             beach so they don't paint over water tops)
"\n}\n"                     (closes the else block)
GLSL_LIGHTING               (legacy: ambient + diffuse + cam light + spec)
```

The brace structure is **load-bearing**: `GLSL_MAIN_SETUP_NEW` opens
`void main() { ... } else { ...`; `GLSL_BEACH_OVERLAY_NO_CLOSE` ends with
the cliff body but NOT a closing `}` (we strip it via regex);
`GLSL_WATER_OVERRIDE_LAST` runs at end of else; the literal `}` closes else;
`GLSL_LIGHTING` ends with `}` to close `main()`. If you change this order
or any chunk's brace count, the shader won't compile.

### Vertex shader composition

```
GLSL_PHASE4_UNIFORMS        (shared with fragment)
GLSL_NOISE_VERTEX_SUBSET()  (just snoise, no uniform/varying decls)
GLSL_HEX_HELPERS            (shared with fragment)
+ vertex main() with phase5AndPhase6Displacement and gl_Position write
```

The fragment imports `GLSL_NOISE` (full chunk with uniforms + varyings).
The vertex uses a SUBSET that only includes snoise functions, to avoid
duplicate uniform declarations.

`varying vec4 vColor` is declared by both — the legacy `GLSL_NOISE` chunk
declares it for the legacy material's needs, and the vertex must declare a
matching `out vec4 vColor` for WebGL2 to link (we write `vec4(0.0)`; the
fragment never reads it).

## Conventions and pitfalls (the things I learned the hard way)

### Babylon WebGL2 quirks

- **Backticks in GLSL comments break esbuild.** Don't write
  ``// `time` is the uniform`` — esbuild parses the backtick inside the TS
  template literal as a string boundary. Use plain text instead.
- **`setFloats(name, [a, b, c])` does NOT work for `vec3` uniforms.** It
  calls `glUniform1fv` which only works for arrays. Use `setVector3` for
  bare `vec3` uniforms.
- **`varying vec4 vColor;` in fragment requires a matching out in vertex.**
  Babylon's WebGL2 path translates `varying` to `in`/`out`, and link fails
  if the vertex doesn't declare it. We write a dummy value.
- **Babylon's depth renderer doesn't apply custom vertex displacement.**
  If you put a displaced mesh in `depthTexture.renderList`, the captured
  depth is the un-displaced sphere. The water-sphere then thinks land is
  always behind it and discards everywhere. Need a custom displacement-
  aware depth material — Phase 8 work.
- **Headless Chromium throttles rAF.** FPS readings via `engine.perf.fps`
  in headless Playwright are unreliable (typically reports 1–13). For real
  perf numbers run the verifier with `chromium.launch({ headless: false,
  args: ['--disable-background-timer-throttling'] })`. Real-browser FPS
  is consistently 60.

### Code patterns

- **Don't bypass the legacy chunk system.** When porting another part of
  the legacy shader, EXPORT the chunk from `terrain-material.ts` and import
  it. Don't rewrite — the user has tuned those values and you'll regress
  the look.
- **Tier height in fragment AND vertex must match `LEVEL_HEIGHTS`.** They
  appear in two places (`tierHeight()` in `GLSL_HEX_HELPERS` and the inline
  `if (heightLevel == 0) tierH = -0.020 * planetRadius` in
  `GLSL_MAIN_SETUP_NEW`). If you change one, change the other.
- **Cliff trigger uses LEGACY criteria** from `hex-borders.ts:classifyEdge`:
  steep cliff = land-land gap ≥ 2 OR water↔land where land tier > 2.
  Don't use "any different heightLevel" — that over-paints cliff outlines
  on every hex border.
- **`trueHeightDelta` for Phase 6 noise uses tier-table heights**, not the
  flattened-water heights. Otherwise water-to-tier-2 land has delta=0 and
  cliff noise never fires at coastlines.
- **Boundary-noise perturbation amplitude** must stay below the hex apothem
  in unit-sphere terms (`0.5/(res+1) ≈ 0.012` at res=40). 0.004 is the
  current default — keeps most fragments in their own hex while wiggling
  boundaries within ~30% of apothem.
- **Don't apply interior noise to water hexes.** They're flattened to
  `WATER_FLAT_DEPTH` and additional noise re-introduces the stair-step
  appearance.

### Audit-flagged limitations (queued for Phase 8 polish)

- Vertex normals are radial-out from displaced position; should use
  finite-difference smooth normals (queued).
- Pentagons skip the row-parity-dependent neighbor offsets (~12 hexes).
- Cross-face neighbor lookup adds one extra `findFace` per fragment at
  face seams (~2% of fragments). Acceptable.
- Strata bands are computed from `strategyH` (smooth Strategy 3 height
  before noise) — gives clean horizontal lines but means strata follow
  the underlying tier transition, not the noise-bumped surface.

## How to run things

```sh
# Dev server
npm run dev            # Vite on port 5173 (auto-picks 5174 if in use)

# Visual regression — needs dev server running
node scripts/phase4-verify.mjs           # 4 cameras, legacy vs shader-preview
node scripts/phase2-verify.mjs           # GLSL hex ID 3-way comparison
node scripts/phase1-3-verify.mjs         # Phase 1 GPU readback + Phase 3 flat sphere

# Reference screenshots (re-run only when legacy art changes)
DEV_URL=http://localhost:5174 node scripts/snapshot-references.mjs

# Type check
npx tsc --noEmit       # ignore the topojson-client error, it's preexisting
```

## Workflow conventions (from user memory)

- **Commit after EVERY meaningful change.** Don't batch.
- **Push to `origin` after every commit** (memory says always push to GitHub
  after every stopping point).
- **Use subagents to audit phase work.** When the user says "audit" they
  expect parallel general-purpose agents — typically one for GLSL/code
  correctness and one for visual regression.
- **The user prefers to be asked before bundling phases.** When asked
  "what's next?", recommend a single phase or tightly-coupled pair (e.g.,
  5+6). Don't unilaterally run 3+ phases together.

## Things to NOT do

- Don't restart the user's dev server with `pkill -f vite` — it interrupts
  their workflow. Just leave the existing one running.
- Don't add `--no-verify` or skip hooks. The user's hooks are intentional.
- Don't mass-rename or refactor outside the phase you're working on.
- Don't introduce new abstractions (factories, strategy patterns, etc.)
  unless the phase plan calls for them. Three similar lines is better
  than a premature abstraction here.
- Don't claim "looks identical" when it doesn't. The user has good visual
  judgment and will catch over-claims; be honest about the gap.
