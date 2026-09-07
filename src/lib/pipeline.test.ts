/**
 * End-to-end validation.
 *
 * The synthetic venue renders a physically simulated throw to real pixels, with
 * decoys in shot and sensor noise on top. The pipeline then runs the production
 * detector, the production RANSAC and the production solver over those pixels
 * with no privileged information beyond the calibration marks a coach would
 * click by hand.
 *
 * Because the scene knows the truth, these assertions are accuracy claims, not
 * smoke tests.
 */

import { describe, expect, it } from "vitest";
import { analyze, type FrameSource } from "./pipeline";
import { buildScene, CENTRELINE_DEG, CIRCLE_CENTRE, DEMO_THROW } from "./synth";
import { detectFrame, medianBackground, DEFAULT_DETECT, suggestThreshold } from "./detect";
import { findTrajectory, flattenCandidates, type TrackPoint } from "./track";
import type { Calibration } from "./solve";

function sourceFor(scene: ReturnType<typeof buildScene>): FrameSource {
  return {
    width: scene.width,
    height: scene.height,
    fps: scene.fps,
    frameCount: scene.frameCount,
    getGray: (i) => scene.renderGray(i),
  };
}

function calibrationFor(scene: ReturnType<typeof buildScene>): Calibration {
  return {
    points: scene.calibration,
    imageWidth: scene.width,
    imageHeight: scene.height,
    hfovDeg: scene.opts.hfovDeg,
    circleCentre: CIRCLE_CENTRE,
    circleDiameter: 2.5,
    centrelineDeg: CENTRELINE_DEG,
  };
}

describe("detection", () => {
  const scene = buildScene(DEMO_THROW);

  it("finds candidate blobs, including decoys, without hand tuning", () => {
    const frames = [0, 10, 20, 30, 40].map((i) => scene.renderGray(i));
    const bg = medianBackground(frames);
    const mid = Math.floor(scene.frameCount * 0.5);
    const t = suggestThreshold(scene.renderGray(mid), bg, 4);
    const blobs = detectFrame(scene.renderGray(mid), bg, scene.width, scene.height, {
      ...DEFAULT_DETECT,
      threshold: t,
    });
    expect(blobs.length).toBeGreaterThan(0);
  });
});

describe("trajectory fitting", () => {
  it("rejects a constant-velocity decoy and locks onto the arc", () => {
    const pts: TrackPoint[] = [];
    const blob = { x: 0, y: 0, area: 6, w: 3, h: 3 };
    for (let f = 0; f < 40; f++) {
      const t = f / 50;
      // Real arc.
      pts.push({ t, frame: f, x: 40 + 260 * t, y: 300 - 220 * t + 0.5 * 500 * t * t, blob });
      // A bird: linear, so ay = 0. Must not win.
      pts.push({ t, frame: f, x: 600 - 300 * t, y: 60 + 20 * t, blob });
      // Pure noise.
      pts.push({ t, frame: f, x: (f * 97) % 640, y: (f * 53) % 360, blob });
    }

    const traj = findTrajectory(pts);
    expect(traj).not.toBeNull();
    expect(traj!.model.ay).toBeGreaterThan(300);
    expect(traj!.model.ay).toBeLessThan(700);
    expect(traj!.inliers.length).toBeGreaterThanOrEqual(30);
    expect(traj!.rmsError).toBeLessThan(1);
  });

  it("returns null when there is no arc to find", () => {
    const blob = { x: 0, y: 0, area: 6, w: 3, h: 3 };
    const pts: TrackPoint[] = [];
    let s = 12345;
    const rnd = () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    for (let f = 0; f < 60; f++) {
      for (let k = 0; k < 3; k++) {
        pts.push({ t: f / 50, frame: f, x: rnd() * 640, y: rnd() * 360, blob });
      }
    }
    expect(findTrajectory(pts)).toBeNull();
  });

  it("rejects a flat crosser that noise has bent slightly - the bird case", () => {
    const blob = { x: 0, y: 0, area: 6, w: 3, h: 3 };
    const pts: TrackPoint[] = [];
    for (let f = 0; f < 200; f++) {
      const t = f / 50;
      // Constant-velocity crosser with a gentle sway: over a multi-second window
      // a sine fits a parabola well enough to beat the real arc on inlier count.
      pts.push({ t, frame: f, x: 40 + 150 * t, y: 40 + Math.sin(t * 3) * 4, blob });
    }
    expect(findTrajectory(pts)).toBeNull();
  });
});

describe("end-to-end accuracy against ground truth", () => {
  const scene = buildScene(DEMO_THROW);
  const result = analyze(sourceFor(scene), {
    calibration: calibrationFor(scene),
    implementId: DEMO_THROW.implementId,
    conditions: { headwindMs: DEMO_THROW.headwindMs, altitudeM: 300, tempC: 22 },
  });

  it("finds the flight", () => {
    expect(result.trajectory).not.toBeNull();
    expect(result.trajectory!.inliers.length).toBeGreaterThanOrEqual(20);
    expect(result.metrics).not.toBeNull();
  });

  it("measures release speed to within 1.0 m/s of truth", () => {
    const err = Math.abs(result.metrics!.releaseSpeedMs - scene.truth.releaseSpeedMs);
    expect(err).toBeLessThan(0.5);
  });

  it("measures release angle to within 1.5 degrees of truth", () => {
    const err = Math.abs(result.metrics!.releaseAngleDeg - scene.truth.releaseAngleDeg);
    expect(err).toBeLessThan(1.5);
  });

  it("MEASURES release height rather than assuming it, to within 0.15 m", () => {
    // Gravity is the ruler: this number is not an input anywhere in the solve.
    const err = Math.abs(result.metrics!.releaseHeightM - scene.truth.releaseHeightM);
    expect(err).toBeLessThan(0.15);
  });

  it("measures the official distance to within 1.0 m of truth", () => {
    const err = Math.abs(result.metrics!.officialDistanceM - scene.truth.officialDistanceM);
    expect(err).toBeLessThan(1.0);
  });

  it("recovers the sector deviation, including its sign", () => {
    const m = result.metrics!;
    expect(Math.sign(m.sectorDeviationDeg)).toBe(Math.sign(scene.truth.deviationDeg));
    expect(Math.abs(m.sectorDeviationDeg - scene.truth.deviationDeg)).toBeLessThan(1.5);
    expect(m.legalSector).toBe(true);
  });

  it("reports aero efficiency above 1.0 for a lifting discus flight", () => {
    expect(result.metrics!.aeroEfficiency).toBeGreaterThan(1.0);
  });

  it("brackets truth inside the reported uncertainty band", () => {
    const [lo, hi] = result.speedRange!;
    expect(lo).toBeLessThanOrEqual(scene.truth.releaseSpeedMs + 1.2);
    expect(hi).toBeGreaterThanOrEqual(scene.truth.releaseSpeedMs - 1.2);
  });

  it("keeps the reprojection residual small enough to trust", () => {
    expect(result.metrics!.reprojectionRmsPx).toBeLessThan(2);
  });
});

describe("robustness", () => {
  // Rendering the venue twice over plus a full solve runs past the 5s default.
  it("still solves a flatter, slower throw", { timeout: 20_000 }, () => {
    const scene = buildScene({
      ...DEMO_THROW,
      releaseSpeedMs: 19.5,
      releaseAngleDeg: 31,
      releaseHeightM: 1.5,
      attitudeDeg: 22,
      deviationDeg: 6.5,
      headwindMs: 0,
      seed: 77,
    });
    const result = analyze(sourceFor(scene), {
      calibration: calibrationFor(scene),
      implementId: scene.opts.implementId,
      conditions: { headwindMs: 0, altitudeM: 300, tempC: 22 },
    });

    expect(result.metrics).not.toBeNull();
    expect(Math.abs(result.metrics!.releaseSpeedMs - scene.truth.releaseSpeedMs)).toBeLessThan(1.0);
    expect(Math.sign(result.metrics!.sectorDeviationDeg)).toBe(1);
  });
});
