# What The User Actually Wants — Coastal Cliff

## Current State (83a75a4)
- Water hex ramps up to meet cliff — geometry works, no gap
- Cliff has cliff rock texture — steepBlend * proxFade, same as all cliffs
- Beach overlay applies after cliff rock
- FXAA handles hairlines
- No special water hex path (heightLevel branch removed)

## The Problem
There is a visible LINE at the bottom of the coastal cliff where cliff rock fades out and sand begins. This line exists because:
- The cliff rock is drawn via steepBlend which depends on geometric steepness
- At the bottom of the cliff, steepness transitions from high to low over just a few triangles
- The cliff rock color (dark brown) and beach color (yellow sand) are very different
- When cliff rock drops from even 5% to 0%, that small amount of dark rock over light sand is visible as a dark line

## What The User Said (Verbatim Quotes)
1. "The coast needs to blend with the cliff and adjacent hexes"
2. "JUST FUCKING MAKE IT LOOK NATURAL"
3. "I WANT THE CLIFF TO BE FUCKING CLIFF! WHY WOULD I WANT THE CLIFF TO BE SAND?" — cliff stays cliff colored, don't make it sandy
4. "The cliff color not fading out like they should at the very bottom" — then corrected:
5. "IT FADED OUT BUT IT LEAVE A LINE OF DARK COLOR AT THE VERY EDGE" — the cliff DOES fade, but the last remnant of dark color before it disappears is visible as a line
6. "Remake the transition from cliff to ocean the same way that other cliffs and terrain does it" — use steepBlend * proxFade (done at 83a75a4)
7. "The coast needs to fade up like others land tiles do too" — the water side should also have cliff texture fading naturally

## What The User Does NOT Want
- Cliff turning sandy (coastFade blending rock toward beach)
- Cliff rock painted on flat beach (proxBlend, wider proximity)
- Dark lines on flat beach from proximity-based cliff rock
- Any changes that make it worse by extending cliff rock further

## The Actual Root Cause
The LINE is not from the shader formula. It's from the GEOMETRY. The water hex ramp transitions from steep (near the cliff edge) to flat (near the water) too abruptly. The steepness contour follows the geometry. Where steepness drops below ~0.003, cliff rock disappears. That contour IS the line.

On LAND-LAND cliffs, this line doesn't exist (or is less visible) because:
1. Both sides have the same base terrain color (green grass), so when cliff rock fades out, the underlying color is similar
2. The cliff ramp is symmetric — both hexes contribute equal steep faces

On COASTAL cliffs, the water hex side has a gentle coast ramp (cosine over full hexRadius) while the land side has a steep cliff ramp (parabolic over 0.2 hexRadius). The water side's gentler slope means steepness drops off sooner → cliff rock ends sooner → more of the transition zone shows the underlying sand/terrain color → visible line.

## What Needs to Happen
The water hex's coast ramp (from computeSurfaceHeight) needs to be STEEPER near the cliff edge so that steepness stays high enough for cliff rock to cover the full transition zone. This is NOT about making the cliff ramp wider or the proximity larger — it's about making the GEOMETRY steeper at the cliff base on the water side.

Currently the water hex uses a cosine ramp over the full hexRadius for its coast edges. Near a coastal cliff, this ramp should be compressed/steepened so the surface rises more sharply, creating steep faces that steepBlend covers with cliff rock.
