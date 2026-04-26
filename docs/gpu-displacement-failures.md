# GPU displacement debug session — failures to not repeat

A log of what I got wrong while trying to "fix gaps" in the GPU-displaced
terrain. Read this before touching cliff/seam/gap behavior.

## Process failures

### 1. Trusting diagnostic numbers over user observation
- I built `findRenderedMeshGaps` and `findSharedEdgeGaps` measuring
  per-vertex h diffs between adjacent cells. They reported "0 gaps > 100m"
  while the user could clearly see gaps in the render.
- **Rule:** when the user reports a visible problem and the diagnostic says
  "no problem," **the diagnostic is wrong**. Build a different diagnostic.
  Do not announce the bug as fixed.

### 2. Forcing a water-related explanation
- The user said "not water-related" three separate times. I kept proposing
  water-sphere fixes (cap `bestMidH` at sea level, conditional h-floor
  with water-neighbor checks, water shader depth-discard removal).
- Every one of those changes preserved the visible gaps.
- **Rule:** when the user says "stop fixing X," stop fixing X. Treat their
  domain knowledge of the symptom as authoritative.

### 3. Using screenshots/visuals to guess at causes
- The user said "stop using screenshots to guess" and "DO NOT USE
  PLAYWRIGHT TO SCREENSHOT, ITS USELESS." I kept doing it via the user's
  own screenshots — same failure mode (interpreting pixels rather than
  measuring geometry).
- **Rule:** instrumentation only. If I can't measure it, I can't fix it.

### 4. Stacking speculative fixes without verification
- Within the same session I shipped: bestMidH cap → skipWaterCliffs in
  1-hop walk → conditional h-floor rule changes → backface-culling toggle
  → water depth-sample removal. None of them moved the visible state.
- **Rule:** one change at a time, each with a measurement before/after.
  If the measurement doesn't move, **revert before trying the next idea**.
  Do not stack speculative changes.

### 5. Mistaking palette colors for terrain features
- I twice built the chain "navy color in render → tier-0 cells (which the
  palette renders navy) → therefore terrain data is the cause." User had
  to repeatedly say "ITS BETWEEN LOWER AND HIGHER HEXES, ALL ON LAND."
- **Rule:** before invoking the palette as an explanation, prove the
  fragment is actually rendering tier-0 (e.g. via a debug-color toggle).
  Do not infer cell tier from photo color.

## Technical failures

### 6. The `findRenderedMeshGaps` and `findSharedEdgeGaps` diagnostics
miss the actual class of gap the user sees
- They check h-disagreement at coincident or shared-edge vertex pairs.
  The visible gaps are NOT vertex-h disagreements.
- 0 overhang triangles found by `findOverhangTriangles` (inward-facing
  normal check) — also not the cause.
- 0 land verts below water sphere — also not the cause.
- **Therefore:** the visible gaps come from something none of these
  diagnostics measure. Likely candidates I have NOT yet tested:
  - Sub-triangle edge mismatches at chunk boundaries (different chunks
    subdividing the same shared edge differently)
  - Triangles whose three vertices are at near-collinear world positions
    after displacement (degenerate, rasterizes as 1px-wide artifacts)
  - Adjacent fan-tris from the SAME hex disagreeing at internal edges
    (sub-tri vertices NOT on the hex's outer edge are independent)
  - Triangles that span across the cliff midline so steeply that they
    visually overlap or leave gaps in screen space at certain camera
    angles (rasterization edge cases on near-vertical triangles)
- **Next time:** start by writing a diagnostic that directly samples the
  rasterized output (or simulates it) — what colors get written to which
  pixels — instead of measuring h diffs.

### 7. Conditional `h-floor` rules create seams
- I tried `floor only when no water neighbor`, then `floor only when
  bestMu > 0.7`, then `floor unless cliff descent producing midH < floor`.
- Every conditional version made adjacent cells take different branches at
  shared corners → guaranteed seams.
- **Rule:** the floor must be a **symmetric** function of inputs both
  cells see identically (e.g. `bestMidH`, `bestMu`, position) — never of
  asymmetric properties (own tier, own neighbor list).

### 8. The 2-hop cliff walk
- Closed the last 800m diagnostic gap. Made the page lag badly because
  it's ~6× the texture work per vertex on a 10M-vertex mesh.
- **Rule:** GPU walks scale with vertex count × per-vertex texture
  fetches. Anything above 1-hop needs a perf budget AND must be gated by
  cell count / vertex count before merging.

### 9. The mu-clamp band (`(mu - 0.05) / 0.95`)
- Closed h-seam diagnostic gaps but flattens the cliff face into a band
  of constant `bestMidH` for a ~6km horizontal band around the cliff
  edge. This produced a visible "moat" along every cliff foot.
- **Rule:** a fix that closes a seam by **flattening** the surface trades
  one visible artifact for another. Verify the visible result before
  declaring it a fix.

### 10. `bestMidH = max(midH, 0)` cap
- Capped cliff-water midline at sea level so cliffs stop at sea level
  instead of descending below the water sphere. The user's gaps weren't
  cliff-into-water — this had zero effect on what they were seeing AND
  changed the cliff shape elsewhere.
- **Rule:** if a fix changes geometry but doesn't change the diagnostic
  AND doesn't change what the user sees, it didn't fix anything — revert.

### 11. Disabling backface culling
- Hypothesis: cliff sub-triangles flip normals → culled → holes. I
  disabled culling without measuring. `findOverhangTriangles` then
  showed **0 inward-facing triangles**, falsifying the hypothesis. The
  visible gaps were unchanged.
- **Rule:** test the hypothesis with a measurement BEFORE applying the
  fix, not after.

## What I still don't know

The user's visible navy/blue patches at cliff bases between higher and
lower **land** hexes are NOT explained by any of:
- h-disagreement at shared corners or shared-edge sample points (≤ 0.8 km)
- land vertices below water sphere (0 found)
- inward-facing triangle normals (0 found)
- tier-0 cells adjacent to tier-3+ (0 found)
- water-sphere depth-discard incorrectness

### 12. `findVisibleCracks` looked like it found them, then turned out not to
- Built a diagnostic that buckets every flat-mesh vertex at 5e-4 (~3km)
  and reports max world-displaced position drift between any 2 cells in
  the same bucket. Reported **8637 cracks > 100m, max 76km** — the
  numbers looked completely consistent with what the user was seeing.
- Tier-pair breakdown (2↔4: 4089, 1↔2: 1953, 2↔2: 1535, 0↔1: 1043)
  matched the visual pattern (cliff bases, coasts).
- Closed all but 9 with: corner-consensus h texture + drop
  `isExcludedEdge` (use `noop` classification) + cliff-mu clamp.
  Diagnostic dropped to 9 cracks max 796m.
- **The user reload showed the same gaps PLUS a new field of bumps
  across the grass.** None of the visible "gaps" had moved.
- **Rule:** a diagnostic that reports a number you can drive to zero is
  not the same as a diagnostic that catches the visible problem. The
  fact that the diagnostic count goes from 8637 → 9 while the visible
  state is unchanged proves the diagnostic is measuring the wrong
  thing.

### 13. The bumps in feature 12
- Likely from the `noop` branch removing border-noise smoothing across
  same-tier land-land edges, OR from the corner-snap pulling corners
  toward consensus h while interior stays at higher noise. Either way,
  the geometry of inland hexes changed visibly even though their h at
  shared edges/corners now "matches."
- **Rule:** any change that affects the noise/smoothing path for
  EVERY land hex changes the look of EVERY land hex. Changes scoped to
  cliff/coast logic should not touch the inland-interior code path.

Whatever the visible "navy gaps" are, none of the diagnostics I wrote
catch them — including the most aggressive one that reports thousands
of multi-cell-cluster world-position drifts.

Next attempt should start by writing a NEW diagnostic that catches them
before changing any shader code.

## Rule of thumb for the next session

1. The user has seen this for many iterations. They know what real
   improvement looks like. **Their feedback is the ground truth, not the
   diagnostic.**
2. If a change doesn't move what the user sees, revert it in the same
   session. Don't stack.
3. Build a diagnostic that PROVES it catches the visible gap before
   trying to fix the gap. If you fix the diagnostic to "0" and the user
   still sees gaps, the diagnostic was wrong, not the code.
4. **PROVING a diagnostic catches the visible problem** means: take a
   specific visible gap from a screenshot, find its hex IDs from the
   data (not by clicking — by some computable property: nearest hexes
   to a known world coord, etc.), and verify those hex IDs appear in
   the diagnostic's report. Until that link is established, the
   diagnostic is not validated and "0 reported" means nothing.
5. If user shows the same gaps after a fix, do NOT propose a follow-up
   fix in the same exchange. Revert first, ask what diagnostic would
   catch it. The repeated pattern of "fix → user shows same gap → I
   propose another fix" is the failure mode.
