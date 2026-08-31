import { buildScene, DEMO_THROW, CIRCLE_CENTRE, CENTRELINE_DEG } from "../src/lib/synth";
import { analyze } from "../src/lib/pipeline";
import type { Calibration } from "../src/lib/solve";

const scene = buildScene(DEMO_THROW);
const cal: Calibration = {
  points: scene.calibration,
  imageWidth: scene.width, imageHeight: scene.height, hfovDeg: scene.opts.hfovDeg,
  circleCentre: CIRCLE_CENTRE, circleDiameter: 2.5, centrelineDeg: CENTRELINE_DEG,
};
const r = analyze({ width: scene.width, height: scene.height, fps: scene.fps, frameCount: scene.frameCount, getGray: (i) => scene.renderGray(i) },
  { calibration: cal, implementId: DEMO_THROW.implementId, conditions: { headwindMs: DEMO_THROW.headwindMs, altitudeM: 300, tempC: 22 } });

console.log("hypotheses:", r.hypotheses.length, "rejected:", JSON.stringify(r.rejected));
if (!r.metrics) { console.log("NO METRICS"); process.exit(0); }
const m = r.metrics, T = scene.truth;
const row = (k: string, got: number, want: number, u: string, dp = 2) =>
  console.log(`${k.padEnd(20)} got ${got.toFixed(dp).padStart(8)} ${u.padEnd(4)} truth ${want.toFixed(dp).padStart(8)}  err ${(got-want).toFixed(dp)}`);
row("release speed", m.releaseSpeedMs, T.releaseSpeedMs, "m/s");
row("release angle", m.releaseAngleDeg, T.releaseAngleDeg, "deg");
row("release height", m.releaseHeightM, T.releaseHeightM, "m");
row("official distance", m.officialDistanceM, T.officialDistanceM, "m");
row("flight time", m.flightTimeS, T.flightTimeS, "s");
row("apex", m.apexM, T.apexM, "m");
row("sector dev", m.sectorDeviationDeg, T.deviationDeg, "deg");
console.log("aero efficiency", m.aeroEfficiency.toFixed(3), "| attitude", m.attitudeDeg?.toFixed(1), "truth", T.attitudeDeg);
console.log("reproj rms", m.reprojectionRmsPx.toFixed(2), "px | confidence", m.confidence, "| inliers", r.trajectory!.inliers.length);
console.log("elapsed", r.elapsedMs, "ms");
