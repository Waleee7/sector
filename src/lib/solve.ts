/**
 * SECTOR - monocular 3D flight solve.
 *
 * The trick that removes the second camera:
 *
 *   A ballistic flight has a known vertical acceleration of exactly 9.80665
 *   m/s^2. That constant is a RULER. A monocular view of a moving point is
 *   scale-ambiguous in general, but once you assert that the vertical
 *   acceleration is g, the scale is pinned - and with it the release height, the
 *   release speed and the range.
 *
 * So we do not assume release height and we do not need stereo. We fit the full
 * 6-parameter flight (release position + release velocity) by minimising
 * reprojection error across every inlier frame, with gravity held fixed. Release
 * height falls out as a MEASUREMENT.
 *
 * The honest caveat, surfaced in the UI rather than buried: for an aerodynamic
 * implement the true flight is not purely ballistic, so the ballistic fit is a
 * best-fit arc through a slightly lifted path. We report the reprojection
 * residual so the user can see when that approximation is straining.
 */

import {
  applyHomography,
  backprojectToHeight,
  rayToVerticalPlane,
  computeHomography,
  intrinsicsFromFov,
  officialDistance,
  poseFromHomography,
  projectPoint,
  sectorDeviationDeg,
  sectorMarginDeg,
  isInSector,
  type CameraPose,
  type Mat3,
  type Vec2,
  type Vec3,
} from "./geometry";
import {
  G,
  aeroEfficiency,
  airDensity,
  implementById,
  optimalVacuumAngleDeg,
  rangeUnderWind,
  releaseFromEndpoints,
  vacuumRange,
  type ImplementSpec,
  type ReleaseState,
} from "./physics";
import type { Trajectory, TrackPoint } from "./track";
import { extrapolateToRelease, fitAeroFlight } from "./aerofit";

export type CalibrationPoint = { image: Vec2; world: Vec2; label: string };

export type Calibration = {
  points: CalibrationPoint[];
  imageWidth: number;
  imageHeight: number;
  hfovDeg: number;
  /** Circle centre in world coordinates, metres. */
  circleCentre: Vec2;
  circleDiameter: number;
  /** Bearing of the sector centreline in world degrees. */
  centrelineDeg: number;
};

export type Conditions = {
  headwindMs: number;
  altitudeM: number;
  tempC: number;
};

export const DEFAULT_CONDITIONS: Conditions = { headwindMs: 0, altitudeM: 300, tempC: 22 };

export type SolvedCamera = { K: Mat3; pose: CameraPose; Hiw: Mat3; Hwi: Mat3 };

export function solveCamera(cal: Calibration): SolvedCamera | null {
  if (cal.points.length < 4) return null;
  const img = cal.points.map((p) => p.image);
  const wld = cal.points.map((p) => p.world);

  const Hwi = computeHomography(wld, img);
  const Hiw = computeHomography(img, wld);
  if (!Hwi || !Hiw) return null;

  const K = intrinsicsFromFov(cal.imageWidth, cal.imageHeight, cal.hfovDeg);
  const pose = poseFromHomography(Hwi, K);
  if (!pose) return null;

  return { K, pose, Hiw, Hwi };
}

/** Mean reprojection error of the calibration points themselves, in pixels. */
export function calibrationResidualPx(cal: Calibration, cam: SolvedCamera): number {
  let sum = 0;
  for (const p of cal.points) {
    const q = projectPoint(cam.K, cam.pose, { x: p.world.x, y: p.world.y, z: 0 });
    if (!q) return Number.POSITIVE_INFINITY;
    sum += Math.hypot(q.x - p.image.x, q.y - p.image.y);
  }
  return sum / cal.points.length;
}

/* ------------------------------------------------------------------ *
 * The 6-parameter flight fit
 * ------------------------------------------------------------------ */

/** [x0, y0, z0, vx, vy, vz] in world metres and m/s. */
type FlightParams = number[];

function positionAt(p: FlightParams, t: number): Vec3 {
  return {
    x: p[0] + p[3] * t,
    y: p[1] + p[4] * t,
    z: p[2] + p[5] * t - 0.5 * G * t * t,
  };
}

function reprojectionResiduals(
  p: FlightParams,
  pts: TrackPoint[],
  t0: number,
  cam: SolvedCamera,
): number[] {
  const out: number[] = [];
  for (const obs of pts) {
    const P = positionAt(p, obs.t - t0);
    const q = projectPoint(cam.K, cam.pose, P);
    if (!q) {
      out.push(1e4, 1e4);
      continue;
    }
    out.push(q.x - obs.x, q.y - obs.y);
  }
  return out;
}

function sumSq(v: number[]): number {
  let s = 0;
  for (const x of v) s += x * x;
  return s;
}

/**
 * Levenberg-Marquardt with numeric central-difference Jacobians.
 * Six parameters and a few dozen observations - a hand-rolled solver is faster
 * to run and easier to audit than pulling in a matrix library.
 */
function levenbergMarquardt(
  init: FlightParams,
  pts: TrackPoint[],
  t0: number,
  cam: SolvedCamera,
  iterations = 60,
): { params: FlightParams; rms: number } {
  const n = init.length;
  let params = [...init];
  let lambda = 1e-3;
  let residuals = reprojectionResiduals(params, pts, t0, cam);
  let cost = sumSq(residuals);

  const step = [1e-3, 1e-3, 1e-3, 1e-3, 1e-3, 1e-3];

  for (let iter = 0; iter < iterations; iter++) {
    const m = residuals.length;
    const J: number[][] = Array.from({ length: m }, () => new Array(n).fill(0));

    for (let j = 0; j < n; j++) {
      const up = [...params];
      const dn = [...params];
      up[j] += step[j];
      dn[j] -= step[j];
      const ru = reprojectionResiduals(up, pts, t0, cam);
      const rd = reprojectionResiduals(dn, pts, t0, cam);
      for (let i = 0; i < m; i++) J[i][j] = (ru[i] - rd[i]) / (2 * step[j]);
    }

    const JtJ: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    const Jtr: number[] = new Array(n).fill(0);
    for (let i = 0; i < m; i++) {
      for (let a = 0; a < n; a++) {
        Jtr[a] += J[i][a] * residuals[i];
        for (let b = 0; b < n; b++) JtJ[a][b] += J[i][a] * J[i][b];
      }
    }

    let improved = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      const A = JtJ.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) : v)));
      const delta = solveLinearLocal(A, Jtr.map((v) => -v));
      if (!delta) {
        lambda *= 10;
        continue;
      }
      const trial = params.map((v, i) => v + delta[i]);
      const rTrial = reprojectionResiduals(trial, pts, t0, cam);
      const cTrial = sumSq(rTrial);
      if (cTrial < cost) {
        params = trial;
        residuals = rTrial;
        cost = cTrial;
        lambda = Math.max(1e-9, lambda / 3);
        improved = true;
        break;
      }
      lambda *= 10;
    }
    if (!improved) break;
  }

  return { params, rms: Math.sqrt(cost / Math.max(1, residuals.length / 2)) };
}

function solveLinearLocal(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-14) return null;
    const swap = M[col];
    M[col] = M[pivot];
    M[pivot] = swap;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/* ------------------------------------------------------------------ *
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

/* ------------------------------------------------------------------ *
 * End-to-end
 * ------------------------------------------------------------------ */

export type ThrowMetrics = {
  releaseSpeedMs: number;
  releaseAngleDeg: number;
  releaseHeightM: number;
  flightTimeS: number;
  apexM: number;
  /** Horizontal distance travelled by the implement, release point to landing. */
  carryM: number;
  /** Rule-32 measurement: circle inside edge to the mark. */
  officialDistanceM: number;
  sectorDeviationDeg: number;
  sectorMarginDeg: number;
  legalSector: boolean;
  aeroEfficiency: number;
  vacuumRangeM: number;
  attitudeDeg: number | null;
  optimalAngleDeg: number;
  angleErrorDeg: number;
  releaseWorld: Vec3;
  landingWorld: Vec3;
  /** World-space flight path, for the 3D and plan views. */
  path: Vec3[];
  reprojectionRmsPx: number;
  confidence: "high" | "medium" | "low";
  notes: string[];
  windCounterfactual: { headwindMs: number; rangeM: number }[];
  /** Which dynamics produced these numbers. */
  model: "aerodynamic" | "ballistic";
  /** What a parabola-only tracker would have reported for the same pixels. */
  ballisticComparison: { releaseSpeedMs: number; officialDistanceM: number };
};

export type SolveInput = {
  trajectory: Trajectory;
  calibration: Calibration;
  implementId: string;
  conditions: Conditions;
  /** Seed for release height, metres. Refined by the fit, not trusted. */
  releaseHeightSeed?: number;
};

export type SolveMode = "fast" | "full";

/**
 * `fast` fits a parabola only - cheap, and good enough to tell a throw from a
 * bird, which is all hypothesis screening needs. `full` then integrates the real
 * lifting flight, and that is the number a human is shown.
 */
export function solveThrow(input: SolveInput, mode: SolveMode = "full"): ThrowMetrics | null {
  const cam = solveCamera(input.calibration);
  if (!cam) return null;

  const spec = implementById(input.implementId);
  const pts = input.trajectory.inliers;
  if (pts.length < 4) return null;

  const t0 = pts[0].t;

  // --- world-space initialisation --------------------------------------
  const seed = initialiseFromSectorPlane(pts, cam, input.calibration);
  if (!seed) return null;
  const init: FlightParams = seed.params;

  // --- parabola fit: initialiser, screener, and cautionary tale --------
  const ball = levenbergMarquardt(init, pts, t0, cam);
  const rho = airDensity(input.conditions.altitudeM, input.conditions.tempC);
  const aeroCtx = {
    implement: spec,
    headwindMs: input.conditions.headwindMs,
    airDensity: rho,
  };

  const ballisticSummary = summariseBallistic(ball.params, input);
  if (!ballisticSummary) return null;

  // --- the real solve --------------------------------------------------
  const aero = mode === "full" ? fitAeroFlight(ball.params, pts, t0, cam, aeroCtx) : null;

  let release: Vec3;
  let vx: number;
  let vy: number;
  let vz: number;
  let tLand: number;
  let landing: Vec3;
  let path: Vec3[];
  let apexM: number;
  let rms: number;
  let attitudeDeg: number | null;
  let model: "aerodynamic" | "ballistic";

  if (aero) {
    // Walk back from the first detected frame to the actual release.
    const rel = extrapolateToRelease(
      aero,
      aeroCtx,
      input.calibration.circleCentre,
      input.calibration.circleDiameter / 2,
    );
    release = rel.world;
    const relRad = (rel.angleDeg * Math.PI) / 180;
    const vh = rel.speed * Math.cos(relRad);
    vx = vh * Math.cos(aero.headingRad);
    vy = vh * Math.sin(aero.headingRad);
    vz = rel.speed * Math.sin(relRad);
    tLand = aero.flightTimeS + rel.leadTimeS;
    landing = aero.landing;
    path = aero.path;
    apexM = aero.apexM;
    rms = aero.rms;
    attitudeDeg = spec.aero ? aero.attitudeDeg : null;
    model = "aerodynamic";
  } else {
    const b = ballisticSummary;
    release = b.release;
    vx = b.vx;
    vy = b.vy;
    vz = b.vz;
    tLand = b.tLand;
    landing = b.landing;
    path = b.path;
    apexM = b.apexM;
    rms = ball.rms;
    attitudeDeg = null;
    model = "ballistic";
  }

  const horizSpeed = Math.hypot(vx, vy);
  const speed = Math.hypot(horizSpeed, vz);
  const angleDeg = (Math.atan2(vz, horizSpeed) * 180) / Math.PI;
  const carry = Math.hypot(landing.x - release.x, landing.y - release.y);

  const releaseState: ReleaseState = { speed, angleDeg, heightM: release.z };
  const vacRange = vacuumRange(releaseState);

  const official = officialDistance(
    { x: landing.x, y: landing.y },
    input.calibration.circleCentre,
    input.calibration.circleDiameter,
  );
  const deviation = sectorDeviationDeg(
    { x: landing.x, y: landing.y },
    input.calibration.circleCentre,
    input.calibration.centrelineDeg,
  );

  const windCounterfactual =
    spec.aero && mode === "full"
      ? [-4, -2, 0, 2, 4, 6].map((headwindMs) => ({
          headwindMs,
          rangeM: rangeUnderWind(
            releaseState,
            { implement: spec, attitudeDeg: attitudeDeg ?? 28, airDensity: rho },
            headwindMs,
          ),
        }))
      : [];

  const optimal = optimalVacuumAngleDeg(speed, release.z);

  const notes: string[] = [];
  let confidence: ThrowMetrics["confidence"] = "high";
  const calResid = calibrationResidualPx(input.calibration, cam);

  if (rms > 4) {
    confidence = "low";
    notes.push(
      "Reprojection residual " +
        rms.toFixed(1) +
        " px is high - the detections may include off-arc noise, or the camera is close to the plane of flight.",
    );
  } else if (rms > 2) {
    confidence = "medium";
    notes.push("Reprojection residual " + rms.toFixed(1) + " px - usable, not tight.");
  }
  if (calResid > 3) {
    confidence = confidence === "high" ? "medium" : "low";
    notes.push(
      "Calibration points reproject at " +
        calResid.toFixed(1) +
        " px. Re-click the circle rim, or correct the field of view.",
    );
  }
  if (pts.length < 10) {
    confidence = confidence === "high" ? "medium" : confidence;
    notes.push(
      "Only " + pts.length + " frames on the arc. More frames tighten every number below.",
    );
  }
  if (release.z < 0.9 || release.z > 2.6) {
    notes.push(
      "Solved release height " +
        release.z.toFixed(2) +
        " m is outside the plausible band - treat the speed with suspicion.",
    );
    confidence = "low";
  }
  if (model === "ballistic" && spec.aero) {
    notes.push(
      "Fell back to a ballistic fit for an aerodynamic implement. These numbers will read high - treat them as a lower-confidence estimate.",
    );
    confidence = "low";
  }

  return {
    releaseSpeedMs: speed,
    releaseAngleDeg: angleDeg,
    releaseHeightM: release.z,
    flightTimeS: tLand,
    apexM,
    carryM: carry,
    officialDistanceM: official,
    sectorDeviationDeg: deviation,
    sectorMarginDeg: sectorMarginDeg(deviation),
    legalSector: isInSector(deviation),
    aeroEfficiency: aeroEfficiency(carry, releaseState),
    vacuumRangeM: vacRange,
    attitudeDeg,
    optimalAngleDeg: optimal,
    angleErrorDeg: angleDeg - optimal,
    releaseWorld: release,
    landingWorld: landing,
    path,
    reprojectionRmsPx: rms,
    confidence,
    notes,
    windCounterfactual,
    model,
    ballisticComparison: {
      releaseSpeedMs: ballisticSummary.speed,
      officialDistanceM: ballisticSummary.official,
    },
  };
}

/**
 * The parabola answer, kept so the UI can show what a naive tracker would have
 * claimed for the same pixels. On a discus the gap is routinely 10 m/s and 30 m.
 */
function summariseBallistic(
  p: FlightParams,
  input: SolveInput,
): {
  release: Vec3;
  vx: number;
  vy: number;
  vz: number;
  tLand: number;
  landing: Vec3;
  path: Vec3[];
  apexM: number;
  speed: number;
  official: number;
} | null {
  const release: Vec3 = { x: p[0], y: p[1], z: p[2] };
  const vx = p[3];
  const vy = p[4];
  const vz = p[5];

  const disc = vz * vz + 2 * G * release.z;
  if (disc < 0) return null;
  const tLand = (vz + Math.sqrt(disc)) / G;
  if (!(tLand > 0) || tLand > 15) return null;

  const landing = positionAt(p, tLand);
  const path: Vec3[] = [];
  const steps = 96;
  for (let i = 0; i <= steps; i++) path.push(positionAt(p, (tLand * i) / steps));

  return {
    release,
    vx,
    vy,
    vz,
    tLand,
    landing,
    path,
    apexM: release.z + (vz * vz) / (2 * G),
    speed: Math.hypot(vx, vy, vz),
    official: officialDistance(
      { x: landing.x, y: landing.y },
      input.calibration.circleCentre,
      input.calibration.circleDiameter,
    ),
  };
}

/**
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

/** Project a world point to the image, for drawing the solved arc back on video. */
export function worldToImage(cam: SolvedCamera, P: Vec3): Vec2 | null {
  return projectPoint(cam.K, cam.pose, P);
}

/** Ground pixel -> world metres, for the plan view and manual landing checks. */
export function imageGroundToWorld(cam: SolvedCamera, p: Vec2): Vec2 {
  return applyHomography(cam.Hiw, p);
}

/**
 * Honest error bars. Field of view is the least trustworthy input - it is either
 * guessed or read off EXIF - so we re-solve at +/- 8% and report the spread
 * rather than printing a single number to two decimals and pretending.
 */
export function solveWithUncertainty(
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
  if (!best) return null;

  const variants: ThrowMetrics[] = [best];
  for (const scale of [0.92, 1.08]) {
    const alt = solveThrow({
      ...input,
      calibration: { ...input.calibration, hfovDeg: input.calibration.hfovDeg * scale },
    });
    if (alt) variants.push(alt);
  }

  const span = (f: (m: ThrowMetrics) => number): [number, number] => {
    const vals = variants.map(f);
    return [Math.min(...vals), Math.max(...vals)];
  };

  return {
    best,
    speedRange: span((m) => m.releaseSpeedMs),
    distanceRange: span((m) => m.officialDistanceM),
    heightRange: span((m) => m.releaseHeightM),
  };
}

export type { ImplementSpec };
export { releaseFromEndpoints };
