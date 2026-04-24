# Hairline Root Cause Analysis

## Root Cause

The hairlines are caused by the interaction of THREE factors:

### 1. GPU Linear Interpolation of Per-Vertex B Channel
Cliff proximity is encoded per-vertex as `B = heightLevel * 0.1 + cliffProximity * 0.09`. The GPU linearly interpolates this across triangle surfaces.

### 2. Non-Linear fract() Decode
The shader decodes: `cliffProximity = fract(rawB * 10 + 0.001) / 0.9`. The `fract()` function is non-linear with respect to interpolation. At triangle boundaries where vertices have different encoded values, the interpolated result decoded via `fract()` produces proximity values that don't correspond to either vertex's actual proximity.

### 3. proxFade Using Interpolated Proximity in the Blend
`proxFade = smoothstep(0.0, 0.3, cliffProximity)` uses the artifact-prone interpolated proximity value to directly modulate the cliff rock blend strength. At triangle boundary pixels, the wrong proximity → wrong proxFade → different blend amount than neighboring pixels → visible hairline.

## Why steepness > 0.003 in the Gate Helps
Steepness is computed per-fragment from the interpolated normal, which IS continuous across surfaces. It naturally confines cliff rock to steep faces. Without it, the gate depends solely on proximity (which has interpolation artifacts) → hairlines everywhere.

## Why Removing steepness from Gate Makes It Worse
Every fragment with proximity > 0.01 enters the cliff block. The code-path discontinuity (inside vs outside the if block) at the proximity boundary creates visible lines because proximity is not smoothly interpolated.

## Fix
Remove `proxFade` from the blend entirely. The gate (`cliffProximity > 0.01`) already prevents cliff rock on zero-proximity fragments. Inside the gate, steepness alone controls the blend amount. Steepness is per-fragment and continuous → no interpolation artifacts.

The `midBlend` (smoothstep 0.5-1.0 on proximity) for the upper/lower cliff convergence is acceptable because it operates deep inside the cliff zone where all vertices have high proximity and the artifacts are minimal.
