import io

p = r'C:\Users\oluda\sector\src\lib\solve.ts'
s = io.open(p, encoding='utf-8').read()

start = s.index('export function solveThrow(input: SolveInput): ThrowMetrics | null {')
end = s.index('/**\n * Physical plausibility gate.')

new = r'''export type SolveMode = "fast" | "full";

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
  const first = pts[0];
  const last = pts[pts.length - 1];
  const seedHeight = input.releaseHeightSeed ?? 1.65;

  // --- closed-form initialisation -------------------------------------
  const P0guess = backprojectToHeight({ x: first.x, y: first.y }, cam.K, cam.pose, seedHeight);
  const P1guess = backprojectToHeight({ x: last.x, y: last.y }, cam.K, cam.pose, 0);
  if (!P0guess || !P1guess) return null;

  const tSpan = Math.max(1e-3, last.t - first.t);
  const init: FlightParams = [
    P0guess.x,
    P0guess.y,
    P0guess.z,
    (P1guess.x - P0guess.x) / tSpan,
    (P1guess.y - P0guess.y) / tSpan,
    (P1guess.z - P0guess.z) / tSpan + 0.5 * G * tSpan,
  ];

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
    release = { x: aero.params[0], y: aero.params[1], z: aero.params[2] };
    vx = aero.params[3];
    vy = aero.params[4];
    vz = aero.params[5];
    tLand = aero.flightTimeS;
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

'''

s = s[:start] + new + s[end:]

s = s.replace('''  notes: string[];
  windCounterfactual: { headwindMs: number; rangeM: number }[];
};''', '''  notes: string[];
  windCounterfactual: { headwindMs: number; rangeM: number }[];
  /** Which dynamics produced these numbers. */
  model: "aerodynamic" | "ballistic";
  /** What a parabola-only tracker would have reported for the same pixels. */
  ballisticComparison: { releaseSpeedMs: number; officialDistanceM: number };
};''')

s = s.replace('import type { Trajectory, TrackPoint } from "./track";',
              'import type { Trajectory, TrackPoint } from "./track";\nimport { fitAeroFlight } from "./aerofit";')

s = s.replace('    const metrics = solveThrow({ ...base, trajectory });',
              '    // Screening only needs to separate a throw from a bird, so use the cheap fit.\n    const metrics = solveThrow({ ...base, trajectory }, "fast");')

s = s.replace('  inferAttitudeDeg,\n', '')

io.open(p, 'w', encoding='utf-8').write(s)
print("patched solve.ts")
