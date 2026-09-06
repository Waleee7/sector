/**
 * The accuracy table in the README, regenerated.
 *
 * Each case builds a synthetic venue from a known release, renders it to real
 * pixels with decoys and sensor noise, and runs the production pipeline over
 * those pixels. Nothing in the analysis path can see `scene.truth`, so the
 * errors printed here are measurement errors, not bookkeeping.
 *
 * Run `npm run accuracy` to print the table.
 */

import { describe, expect, it } from "vitest";
import { analyze, type FrameSource } from "./pipeline";
import { buildScene, CENTRELINE_DEG, CIRCLE_CENTRE, DEMO_THROW } from "./synth";
import type { Calibration } from "./solve";

type Scene = ReturnType<typeof buildScene>;

function sourceFor(s: Scene): FrameSource {
  return {
    width: s.width,
    height: s.height,
    fps: s.fps,
    frameCount: s.frameCount,
    getGray: (i) => s.renderGray(i),
  };
}

function calibrationFor(s: Scene): Calibration {
  return {
    points: s.calibration,
    imageWidth: s.width,
    imageHeight: s.height,
    hfovDeg: s.opts.hfovDeg,
    circleCentre: CIRCLE_CENTRE,
    circleDiameter: 2.5,
    centrelineDeg: CENTRELINE_DEG,
  };
}

const CASES = [
  { name: "reference throw", opts: DEMO_THROW },
  {
    name: "flat and slow",
    opts: {
      ...DEMO_THROW,
      releaseSpeedMs: 19.5,
      releaseAngleDeg: 31,
      releaseHeightM: 1.5,
      attitudeDeg: 22,
      deviationDeg: 6.5,
      headwindMs: 0,
      seed: 77,
    },
  },
  {
    name: "fast, steep, into 5 m/s",
    opts: {
      ...DEMO_THROW,
      releaseSpeedMs: 25.5,
      releaseAngleDeg: 38,
      releaseHeightM: 1.75,
      attitudeDeg: 30,
      deviationDeg: -8,
      headwindMs: 5,
      seed: 21,
    },
  },
];

// Tolerances the whole chain must hold across every case. Deliberately looser
// than the errors we actually see, so a real regression trips them but ordinary
// numerical drift does not.
const TOLERANCE = {
  speedMs: 0.5,
  angleDeg: 1.5,
  heightM: 0.15,
  distanceM: 1.0,
  deviationDeg: 1.5,
  reprojectionPx: 2.0,
};

describe("accuracy against synthetic ground truth", () => {
  for (const c of CASES) {
    it(
      `${c.name}: recovers the release from pixels alone`,
      () => {
        const scene = buildScene(c.opts as Parameters<typeof buildScene>[0]);
        const result = analyze(sourceFor(scene), {
          calibration: calibrationFor(scene),
          implementId: scene.opts.implementId,
          conditions: { headwindMs: scene.opts.headwindMs, altitudeM: 300, tempC: 22 },
        });

        expect(result.metrics).not.toBeNull();
        const m = result.metrics!;
        const t = scene.truth;

        const err = {
          speed: Math.abs(m.releaseSpeedMs - t.releaseSpeedMs),
          angle: Math.abs(m.releaseAngleDeg - t.releaseAngleDeg),
          height: Math.abs(m.releaseHeightM - t.releaseHeightM),
          distance: Math.abs(m.officialDistanceM - t.officialDistanceM),
          deviation: Math.abs(m.sectorDeviationDeg - t.deviationDeg),
        };

        console.log(
          [
            ``,
            `  ${c.name}  (truth: ${t.officialDistanceM.toFixed(2)} m)`,
            `    release speed   ${m.releaseSpeedMs.toFixed(2)} m/s   err ${err.speed.toFixed(3)}`,
            `    release angle   ${m.releaseAngleDeg.toFixed(2)}°     err ${err.angle.toFixed(3)}`,
            `    release height  ${m.releaseHeightM.toFixed(2)} m     err ${err.height.toFixed(3)}`,
            `    official dist   ${m.officialDistanceM.toFixed(2)} m    err ${err.distance.toFixed(3)}`,
            `    sector dev      ${m.sectorDeviationDeg.toFixed(2)}°     err ${err.deviation.toFixed(3)}`,
            `    reprojection    ${m.reprojectionRmsPx.toFixed(2)} px    inliers ${result.trajectory!.inliers.length}`,
          ].join("\n"),
        );

        expect(err.speed).toBeLessThan(TOLERANCE.speedMs);
        expect(err.angle).toBeLessThan(TOLERANCE.angleDeg);
        expect(err.height).toBeLessThan(TOLERANCE.heightM);
        expect(err.distance).toBeLessThan(TOLERANCE.distanceM);
        expect(err.deviation).toBeLessThan(TOLERANCE.deviationDeg);
        expect(m.reprojectionRmsPx).toBeLessThan(TOLERANCE.reprojectionPx);
        expect(Math.sign(m.sectorDeviationDeg)).toBe(Math.sign(t.deviationDeg));
      },
      20_000,
    );
  }
});
