import io

# ------------------------------------------------------------------ solve.ts
p = r'C:\Users\oluda\sector\src\lib\solve.ts'
s = io.open(p, encoding='utf-8').read()

start = s.index('export type Rejection = { inliers: number; reason: string };')
end = s.index('/** Project a world point to the image, for drawing the solved arc back on video. */')

new = r'''export type Rejection = { inliers: number; reason: string };

export type ChoiceResult = {
  trajectory: Trajectory | null;
  metrics: ThrowMetrics | null;
  /** Always populated, including when nothing survived - this is the diagnostic. */
  rejected: Rejection[];
};

/**
 * Cheap feasibility check - pure geometry, no optimiser.
 *
 * This exists because the obvious approach (screen with a fast parabola solve)
 * is wrong twice over: the parabola model is inaccurate for a discus, AND its
 * optimiser can simply fail on a perfectly good arc, which silently discards the
 * best hypothesis. Screening must therefore ask only what geometry alone can
 * answer.
 *
 * A bird fails here for a solid reason rather than a numerical one: it flies
 * above the horizon, so the ray through its last observation points upward and
 * never meets the ground plane. Nothing that never lands is a throw.
 */
function feasibility(
  trajectory: Trajectory,
  cam: SolvedCamera,
  cal: Calibration,
): { ok: true; landing: Vec2 } | { ok: false; reason: string } {
  const pts = trajectory.inliers;
  if (pts.length < 4) return { ok: false, reason: "too few frames on the arc" };

  const last = pts[pts.length - 1];
  const ground = backprojectToHeight({ x: last.x, y: last.y }, cam.K, cam.pose, 0);
  if (!ground) return { ok: false, reason: "never reaches the ground - above the horizon" };

  const radial = Math.hypot(ground.x - cal.circleCentre.x, ground.y - cal.circleCentre.y);
  if (radial < cal.circleDiameter / 2 + 3) return { ok: false, reason: "lands inside the circle" };
  if (radial > 200) return { ok: false, reason: radial.toFixed(0) + " m from the circle" };

  const first = pts[0];
  const start = rayToVerticalPlane(
    { x: first.x, y: first.y },
    cam.K,
    cam.pose,
    cal.circleCentre,
    { x: ground.x, y: ground.y },
  );
  if (!start) return { ok: false, reason: "start point is not in the plane of flight" };
  if (start.z < -1 || start.z > 45) {
    return { ok: false, reason: "starts at " + start.z.toFixed(1) + " m" };
  }

  return { ok: true, landing: { x: ground.x, y: ground.y } };
}

/**
 * RANSAC proposes, physics disposes.
 *
 * Geometry screens out what cannot be a flight; the full aerodynamic solve then
 * runs on the strongest surviving hypotheses and the first physically sane
 * result wins. In the normal case that is one expensive solve.
 */
export function chooseThrow(
  candidates: Trajectory[],
  base: Omit<SolveInput, "trajectory">,
): ChoiceResult {
  const rejected: Rejection[] = [];
  const cam = solveCamera(base.calibration);
  if (!cam) return { trajectory: null, metrics: null, rejected };

  const survivors: Trajectory[] = [];
  for (const trajectory of candidates) {
    const f = feasibility(trajectory, cam, base.calibration);
    if (f.ok) survivors.push(trajectory);
    else rejected.push({ inliers: trajectory.inliers.length, reason: f.reason });
  }

  survivors.sort((a, b) => b.inliers.length - a.inliers.length);

  let fallback: { trajectory: Trajectory; metrics: ThrowMetrics } | null = null;

  for (const trajectory of survivors.slice(0, 3)) {
    const metrics = solveThrow({ ...base, trajectory }, "full");
    if (!metrics) {
      rejected.push({ inliers: trajectory.inliers.length, reason: "aerodynamic fit failed" });
      continue;
    }
    if (isPlausibleThrow(metrics)) return { trajectory, metrics, rejected };

    rejected.push({ inliers: trajectory.inliers.length, reason: describeImplausibility(metrics) });
    if (!fallback || metrics.reprojectionRmsPx < fallback.metrics.reprojectionRmsPx) {
      fallback = { trajectory, metrics };
    }
  }

  // Nothing clean. Return the best fit rather than nothing - its confidence flags
  // already say why it should not be trusted.
  return {
    trajectory: fallback?.trajectory ?? null,
    metrics: fallback?.metrics ?? null,
    rejected,
  };
}

function describeImplausibility(m: ThrowMetrics): string {
  if (m.reprojectionRmsPx > PLAUSIBLE.maxReprojectionPx)
    return "reprojection " + m.reprojectionRmsPx.toFixed(1) + " px";
  if (m.releaseHeightM < PLAUSIBLE.releaseHeightM[0] || m.releaseHeightM > PLAUSIBLE.releaseHeightM[1])
    return "release height " + m.releaseHeightM.toFixed(2) + " m";
  if (m.releaseSpeedMs < PLAUSIBLE.releaseSpeedMs[0] || m.releaseSpeedMs > PLAUSIBLE.releaseSpeedMs[1])
    return "release speed " + m.releaseSpeedMs.toFixed(1) + " m/s";
  if (m.releaseAngleDeg < PLAUSIBLE.releaseAngleDeg[0] || m.releaseAngleDeg > PLAUSIBLE.releaseAngleDeg[1])
    return "release angle " + m.releaseAngleDeg.toFixed(1) + " deg";
  return "distance " + m.officialDistanceM.toFixed(1) + " m";
}

'''

s = s[:start] + new + s[end:]

# Release anchor: the front rim of the circle.
s = s.replace('const rel = extrapolateToRelease(aero, aeroCtx, input.calibration.circleCentre);',
              'const rel = extrapolateToRelease(\n      aero,\n      aeroCtx,\n      input.calibration.circleCentre,\n      input.calibration.circleDiameter / 2,\n    );')

io.open(p, 'w', encoding='utf-8').write(s)

# ------------------------------------------------------------------ aerofit.ts
p = r'C:\Users\oluda\sector\src\lib\aerofit.ts'
s = io.open(p, encoding='utf-8').read()

s = s.replace('''export function extrapolateToRelease(
  fit: AeroFit,
  ctx: AeroContext,
  circleCentre: { x: number; y: number },
): ReleasePoint {''', '''export function extrapolateToRelease(
  fit: AeroFit,
  ctx: AeroContext,
  circleCentre: { x: number; y: number },
  circleRadius: number,
): ReleasePoint {''')

s = s.replace('''  const dt = -0.002;
  let best = { st, t: 0, d: Math.abs(st.x) };

  for (let i = 0; i < 600; i++) {
    st = step(st, aero, dt);
    const d = Math.abs(st.x);
    const t = (i + 1) * dt;
    if (d < best.d) best = { st, t, d };
    // Past the circle, or descended into the ground going backwards: stop.
    if (st.x < -0.4 || st.z < 0.4) break;
  }''', '''  // Release is taken at the front rim of the circle. An athlete releases with the
  // arm extended over the front of the circle, so the rim is both the closest
  // defensible landmark and one the calibration already knows the position of.
  const target = circleRadius;
  const dt = -0.002;
  let best = { st, t: 0, d: Math.abs(st.x - target) };

  for (let i = 0; i < 400; i++) {
    const next = step(st, aero, dt);
    // Never walk back below a plausible release height - past that the
    // extrapolation has left the throw and is inventing history.
    if (next.z < 0.9) break;
    st = next;
    const d = Math.abs(st.x - target);
    const t = (i + 1) * dt;
    if (d < best.d) best = { st, t, d };
    if (st.x < target - 0.2) break;
  }''')

io.open(p, 'w', encoding='utf-8').write(s)

# ------------------------------------------------------------------ synth.ts
p = r'C:\Users\oluda\sector\src\lib\synth.ts'
s = io.open(p, encoding='utf-8').read()
s = s.replace('''  // Release happens at the front of the circle, not its centre.
  const releaseOffset = 0.85;''', '''  // Release happens over the front rim with the arm extended, not at the centre
  // of the circle. This matches the anchor the solver extrapolates back to.
  const releaseOffset = 1.25;''')
io.open(p, 'w', encoding='utf-8').write(s)
print("patched choose + release anchor + synth")
