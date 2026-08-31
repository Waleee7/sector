import io

p = r'C:\Users\oluda\sector\src\lib\solve.ts'
s = io.open(p, encoding='utf-8').read()

# ---------------------------------------------------------------- new initialiser
anchor = '/* ------------------------------------------------------------------ *\n * End-to-end'
init_fn = r'''/* ------------------------------------------------------------------ *
 * Initialisation
 * ------------------------------------------------------------------ */

export type PlaneInit = {
  params: FlightParams;
  /** Along-sector distance of the first and last observation, metres. */
  spanM: number;
  startHeightM: number;
};

/**
 * Build a world-space starting guess without assuming anything about which part
 * of the flight was detected.
 *
 * Earlier versions assumed the first inlier was the release and the last was the
 * landing. Both are false in practice: the detector picks the implement up once
 * it separates from the athlete against the background, and RANSAC's image-space
 * parabola is only an approximation, so it systematically drops frames at the
 * end of the arc where perspective bends the curve hardest. Assuming otherwise
 * produced back-projections with no solution at all and silently discarded the
 * best hypothesis.
 *
 * Instead: a throw travels down its sector, and calibration already knows where
 * the sector points. Intersect every observation's ray with the vertical plane
 * through the circle along the sector centreline. That yields a real
 * (distance, height) pair per frame with no endpoint assumptions, and fitting
 * those directly gives a release state to hand the optimiser - which is then
 * free to rotate the flight off the centreline.
 */
export function initialiseFromSectorPlane(
  pts: TrackPoint[],
  cam: SolvedCamera,
  cal: Calibration,
): PlaneInit | null {
  if (pts.length < 4) return null;

  const bearing = (cal.centrelineDeg * Math.PI) / 180;
  const ux = Math.cos(bearing);
  const uy = Math.sin(bearing);
  const far: Vec2 = { x: cal.circleCentre.x + ux * 50, y: cal.circleCentre.y + uy * 50 };

  const t0 = pts[0].t;
  const ts: number[] = [];
  const alongs: number[] = [];
  const heights: number[] = [];

  for (const p of pts) {
    const P = rayToVerticalPlane({ x: p.x, y: p.y }, cam.K, cam.pose, cal.circleCentre, far);
    if (!P) continue;
    const along = (P.x - cal.circleCentre.x) * ux + (P.y - cal.circleCentre.y) * uy;
    if (!isFinite(along) || !isFinite(P.z)) continue;
    ts.push(p.t - t0);
    alongs.push(along);
    heights.push(P.z);
  }

  if (ts.length < 4) return null;

  const lin = fitPoly(ts, alongs, 1);
  const quad = fitPoly(ts, heights, 2);
  if (!lin || !quad) return null;

  const vAlong = lin[1];
  if (!(vAlong > 1)) return null;

  return {
    params: [
      cal.circleCentre.x + lin[0] * ux,
      cal.circleCentre.y + lin[0] * uy,
      quad[0],
      vAlong * ux,
      vAlong * uy,
      quad[1],
    ],
    spanM: alongs[alongs.length - 1] - alongs[0],
    startHeightM: quad[0],
  };
}

/** Least squares polynomial fit via normal equations. */
function fitPoly(ts: number[], vs: number[], degree: number): number[] | null {
  const n = degree + 1;
  const AtA: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  const Atb: number[] = new Array(n).fill(0);
  for (let k = 0; k < ts.length; k++) {
    const powers: number[] = [];
    let p = 1;
    for (let i = 0; i < n; i++) {
      powers.push(p);
      p *= ts[k];
    }
    for (let i = 0; i < n; i++) {
      Atb[i] += powers[i] * vs[k];
      for (let j = 0; j < n; j++) AtA[i][j] += powers[i] * powers[j];
    }
  }
  return solveLinearLocal(AtA, Atb);
}

'''
assert anchor in s
s = s.replace(anchor, init_fn + anchor, 1)

# ---------------------------------------------------------------- use it in solveThrow
old = s[s.index('  // --- closed-form initialisation -------------------------------------'):s.index('  // --- parabola fit: initialiser, screener, and cautionary tale --------')]
new = '''  // --- world-space initialisation --------------------------------------
  const seed = initialiseFromSectorPlane(pts, cam, input.calibration);
  if (!seed) return null;
  const init: FlightParams = seed.params;

'''
s = s.replace(old, new)

# seedHeight / first / last are no longer used by the initialiser
s = s.replace('''  const t0 = pts[0].t;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const seedHeight = input.releaseHeightSeed ?? 1.65;
''', '''  const t0 = pts[0].t;
''')

# ---------------------------------------------------------------- feasibility
old_feas_start = s.index('/**\n * Cheap feasibility check - pure geometry, no optimiser.')
old_feas_end = s.index('/**\n * RANSAC proposes, physics disposes.')
new_feas = r'''/**
 * Cheap feasibility check - pure geometry, no optimiser.
 *
 * Screening must only ask what geometry alone can answer. It must NOT assume the
 * detected arc starts at the release or ends at the landing, and it must not run
 * an optimiser that can fail on a perfectly good hypothesis.
 *
 * A bird fails here on the substance rather than on numerics: projected into the
 * sector plane it either travels the wrong way, sits at an impossible height, or
 * covers no ground at all.
 */
function feasibility(
  trajectory: Trajectory,
  cam: SolvedCamera,
  cal: Calibration,
): { ok: true } | { ok: false; reason: string } {
  const seed = initialiseFromSectorPlane(trajectory.inliers, cam, cal);
  if (!seed) return { ok: false, reason: "no coherent path down the sector" };
  if (seed.spanM < 5) {
    return { ok: false, reason: "covers only " + seed.spanM.toFixed(1) + " m of ground" };
  }
  if (seed.spanM > 160) {
    return { ok: false, reason: "spans " + seed.spanM.toFixed(0) + " m - not a throw" };
  }
  if (seed.startHeightM < -2 || seed.startHeightM > 45) {
    return { ok: false, reason: "starts at " + seed.startHeightM.toFixed(1) + " m" };
  }
  return { ok: true };
}

'''
s = s[:old_feas_start] + new_feas + s[old_feas_end:]

s = s.replace('''    const f = feasibility(trajectory, cam, base.calibration);
    if (f.ok) survivors.push(trajectory);''', '''    const f = feasibility(trajectory, cam, base.calibration);
    if (f.ok) survivors.push(trajectory);''')

io.open(p, 'w', encoding='utf-8').write(s)
print("initialiser replaced")
