import { describe, expect, it } from "vitest";
import {
  applyHomography,
  backprojectToHeight,
  computeHomography,
  intrinsicsFromFov,
  isInSector,
  officialDistance,
  poseFromHomography,
  projectPoint,
  sectorDeviationDeg,
  solveLinear,
  mat3Invert,
  mat3Mul,
  type Vec2,
  type Vec3,
} from "./geometry";
import { buildScene, DEMO_THROW } from "./synth";

describe("linear algebra", () => {
  it("solves a well-conditioned system", () => {
    const x = solveLinear(
      [
        [2, 1, -1],
        [-3, -1, 2],
        [-2, 1, 2],
      ],
      [8, -11, -3],
    );
    expect(x).not.toBeNull();
    expect(x![0]).toBeCloseTo(2, 9);
    expect(x![1]).toBeCloseTo(3, 9);
    expect(x![2]).toBeCloseTo(-1, 9);
  });

  it("reports singular systems instead of returning garbage", () => {
    expect(
      solveLinear(
        [
          [1, 2],
          [2, 4],
        ],
        [3, 6],
      ),
    ).toBeNull();
  });

  it("inverts a 3x3 to identity", () => {
    const m = [2, 0, 1, 1, 3, 2, 1, 1, 3];
    const inv = mat3Invert(m)!;
    const id = mat3Mul(m, inv);
    for (let i = 0; i < 9; i++) {
      expect(id[i]).toBeCloseTo(i % 4 === 0 ? 1 : 0, 9);
    }
  });
});

describe("homography", () => {
  it("maps a known quad exactly", () => {
    const src: Vec2[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 80 },
      { x: 0, y: 80 },
    ];
    const dst: Vec2[] = [
      { x: 10, y: 20 },
      { x: 210, y: 5 },
      { x: 190, y: 190 },
      { x: 30, y: 170 },
    ];
    const H = computeHomography(src, dst)!;
    for (let i = 0; i < 4; i++) {
      const q = applyHomography(H, src[i]);
      expect(q.x).toBeCloseTo(dst[i].x, 6);
      expect(q.y).toBeCloseTo(dst[i].y, 6);
    }
  });

  it("refuses fewer than four correspondences", () => {
    expect(computeHomography([{ x: 0, y: 0 }], [{ x: 1, y: 1 }])).toBeNull();
  });
});

describe("camera pose from a ground homography", () => {
  const scene = buildScene(DEMO_THROW);

  it("recovers the pose well enough to reproject the calibration marks", () => {
    const img = scene.calibration.map((c) => c.image);
    const wld = scene.calibration.map((c) => c.world);
    const Hwi = computeHomography(wld, img)!;
    const K = intrinsicsFromFov(scene.width, scene.height, DEMO_THROW.hfovDeg);
    const pose = poseFromHomography(Hwi, K)!;

    for (let i = 0; i < wld.length; i++) {
      const q = projectPoint(K, pose, { x: wld[i].x, y: wld[i].y, z: 0 })!;
      expect(Math.hypot(q.x - img[i].x, q.y - img[i].y)).toBeLessThan(1.0);
    }
  });

  it("back-projects a pixel onto a known height plane and round-trips", () => {
    const img = scene.calibration.map((c) => c.image);
    const wld = scene.calibration.map((c) => c.world);
    const Hwi = computeHomography(wld, img)!;
    const K = intrinsicsFromFov(scene.width, scene.height, DEMO_THROW.hfovDeg);
    const pose = poseFromHomography(Hwi, K)!;

    const truth: Vec3 = { x: 14, y: -3, z: 6.5 };
    const pixel = projectPoint(K, pose, truth)!;
    const back = backprojectToHeight(pixel, K, pose, truth.z)!;

    expect(back.x).toBeCloseTo(truth.x, 1);
    expect(back.y).toBeCloseTo(truth.y, 1);
    expect(back.z).toBeCloseTo(truth.z, 4);
  });
});

describe("throwing-venue measurement", () => {
  it("measures from the inside edge of the circle, not the centre", () => {
    // Rule 32.17: a mark 60 m from the centre of a 2.5 m circle measures 58.75 m.
    expect(officialDistance({ x: 60, y: 0 }, { x: 0, y: 0 }, 2.5)).toBeCloseTo(58.75, 9);
  });

  it("computes signed sector deviation and legality", () => {
    expect(sectorDeviationDeg({ x: 50, y: 0 }, { x: 0, y: 0 }, 0)).toBeCloseTo(0, 9);
    expect(sectorDeviationDeg({ x: 50, y: 10 }, { x: 0, y: 0 }, 0)).toBeGreaterThan(0);
    expect(isInSector(17.4)).toBe(true);
    expect(isInSector(17.5)).toBe(false);
  });
});
