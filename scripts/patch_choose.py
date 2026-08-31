import io

p = r'C:\Users\oluda\sector\src\lib\solve.ts'
s = io.open(p, encoding='utf-8').read()

start = s.index('/**\n * Physical plausibility gate.')
end = s.index('/** Project a world point to the image, for drawing the solved arc back on video. */')

new = r'''/**
 * Physical plausibility, applied to the AERODYNAMIC solution.
 *
 * These are the envelope of a human throwing an implement. Note carefully where
 * they are applied: never to the ballistic screening pass. The ballistic model is
 * known to be wrong for a discus - it inflates release speed by roughly half -
 * so judging it against real-world bounds throws away good hypotheses. That bug
 * cost a correct 169-frame arc during development.
 */
export const PLAUSIBLE = {
  releaseHeightM: [0.6, 2.9] as [number, number],
  releaseSpeedMs: [7, 50] as [number, number],
  releaseAngleDeg: [8, 62] as [number, number],
  minOfficialDistanceM: 3,
  maxReprojectionPx: 3,
};

export function isPlausibleThrow(m: ThrowMetrics): boolean {
  return (
    m.releaseHeightM >= PLAUSIBLE.releaseHeightM[0] &&
    m.releaseHeightM <= PLAUSIBLE.releaseHeightM[1] &&
    m.releaseSpeedMs >= PLAUSIBLE.releaseSpeedMs[0] &&
    m.releaseSpeedMs <= PLAUSIBLE.releaseSpeedMs[1] &&
    m.releaseAngleDeg >= PLAUSIBLE.releaseAngleDeg[0] &&
    m.releaseAngleDeg <= PLAUSIBLE.releaseAngleDeg[1] &&
    m.officialDistanceM >= PLAUSIBLE.minOfficialDistanceM &&
    m.reprojectionRmsPx <= PLAUSIBLE.maxReprojectionPx
  );
}

export type Rejection = { inliers: number; reason: string };

export type ChoiceResult = {
  trajectory: Trajectory | null;
  metrics: ThrowMetrics | null;
  /** Always populated, including when nothing survived - this is the diagnostic. */
  rejected: Rejection[];
};

/**
 * RANSAC proposes, physics disposes - in two stages, for cost reasons.
 *
 * Stage one is a cheap parabola solve whose ONLY job is to ask "could this be a
 * flight at all?". A bird crossing above the horizon back-projects to nothing on
 * a plane below the camera, so it fails here, which is exactly what we want and
 * all we want. The numbers it produces are not trusted for anything else.
 *
 * Stage two runs the full aerodynamic solve, strongest hypothesis first, and
 * stops at the first one that is both a good fit and a physically sane throw.
 * In the normal case that is a single expensive solve.
 */
export function chooseThrow(
  candidates: Trajectory[],
  base: Omit<SolveInput, "trajectory">,
): ChoiceResult {
  const rejected: Rejection[] = [];
  const survivors: Trajectory[] = [];

  for (const trajectory of candidates) {
    const screen = solveThrow({ ...base, trajectory }, "fast");
    if (!screen) {
      rejected.push({ inliers: trajectory.inliers.length, reason: "no valid 3D solution" });
      continue;
    }
    // Deliberately loose: only reject what cannot be a throw under ANY model.
    if (screen.officialDistanceM < PLAUSIBLE.minOfficialDistanceM) {
      rejected.push({
        inliers: trajectory.inliers.length,
        reason: "lands inside the circle",
      });
      continue;
    }
    if (screen.reprojectionRmsPx > 12) {
      rejected.push({
        inliers: trajectory.inliers.length,
        reason: "reprojection " + screen.reprojectionRmsPx.toFixed(1) + " px",
      });
      continue;
    }
    survivors.push(trajectory);
  }

  survivors.sort((a, b) => b.inliers.length - a.inliers.length);

  let fallback: { trajectory: Trajectory; metrics: ThrowMetrics } | null = null;

  for (const trajectory of survivors.slice(0, 3)) {
    const metrics = solveThrow({ ...base, trajectory }, "full");
    if (!metrics) {
      rejected.push({ inliers: trajectory.inliers.length, reason: "aerodynamic fit failed" });
      continue;
    }
    if (isPlausibleThrow(metrics)) {
      return { trajectory, metrics, rejected };
    }
    rejected.push({
      inliers: trajectory.inliers.length,
      reason: describeImplausibility(metrics),
    });
    if (!fallback || metrics.reprojectionRmsPx < fallback.metrics.reprojectionRmsPx) {
      fallback = { trajectory, metrics };
    }
  }

  // Nothing was clean. Return the best fit we have rather than nothing, but the
  // confidence flags on it will already be telling the user why.
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

# Uncertainty: do not re-solve the winner, it is already known.
s = s.replace('''export function solveWithUncertainty(input: SolveInput): {
  best: ThrowMetrics;
  speedRange: [number, number];
  distanceRange: [number, number];
  heightRange: [number, number];
} | null {
  const best = solveThrow(input);
  if (!best) return null;''', '''export function solveWithUncertainty(
  input: SolveInput,
  known?: ThrowMetrics,
): {
  best: ThrowMetrics;
  speedRange: [number, number];
  distanceRange: [number, number];
  heightRange: [number, number];
} | null {
  // Reuse the already-solved winner where we have it: each full solve integrates
  // a few hundred flights, and re-doing the centre case is pure waste.
  const best = known ?? solveThrow(input);
  if (!best) return null;''')

io.open(p, 'w', encoding='utf-8').write(s)

p2 = r'C:\Users\oluda\sector\src\lib\pipeline.ts'
s2 = io.open(p2, encoding='utf-8').read()
s2 = s2.replace('const solved = solveWithUncertainty({ ...solveBase, trajectory });',
                'const solved = solveWithUncertainty({ ...solveBase, trajectory }, metrics);')
io.open(p2, 'w', encoding='utf-8').write(s2)
print("patched")
