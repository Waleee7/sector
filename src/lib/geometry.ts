/**
 * SECTOR - geometry core.
 *
 * Monocular camera geometry for throwing-event analysis.
 *
 * Single-camera 3D is possible here because a throwing venue is a surveyed
 * surface: the circle is 2.135 m (shot/hammer) or 2.500 m (discus) in diameter
 * and the sector is exactly 34.92 degrees. Clicking known points on that plane
 * gives a ground-plane homography, and homography + intrinsics gives full camera
 * pose. After that, any pixel can be back-projected onto any known height plane.
 */

export type Vec2 = { x: number; y: number };
export type Vec3 = { x: number; y: number; z: number };
/** Row-major 3x3. */
export type Mat3 = readonly number[];

export const SECTOR_ANGLE_DEG = 34.92;

/** Circle diameters in metres, per World Athletics Rule 32. */
export const CIRCLE_DIAMETER_M = {
  discus: 2.5,
  hammer: 2.135,
  shot: 2.135,
  weight: 2.135,
} as const;

/* ------------------------------------------------------------------ *
 * Small dense linear algebra. No deps - this ships to the browser.
 * ------------------------------------------------------------------ */

/** Gaussian elimination with partial pivoting. Returns null if singular. */
export function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) return null;
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
  // Full Gauss-Jordan leaves M diagonal, so the solution for row i is the RHS
  // divided by that row's diagonal entry.
  return M.map((row, i) => row[n] / row[i]);
}

export function mat3Mul(a: Mat3, b: Mat3): Mat3 {
  const out = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      for (let k = 0; k < 3; k++) out[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
    }
  }
  return out;
}

export function mat3Vec(m: Mat3, v: Vec3): Vec3 {
  return {
    x: m[0] * v.x + m[1] * v.y + m[2] * v.z,
    y: m[3] * v.x + m[4] * v.y + m[5] * v.z,
    z: m[6] * v.x + m[7] * v.y + m[8] * v.z,
  };
}

export function mat3Transpose(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

export function mat3Invert(m: Mat3): Mat3 | null {
  const a = m[0], b = m[1], c = m[2];
  const d = m[3], e = m[4], f = m[5];
  const g = m[6], h = m[7], i = m[8];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-15) return null;
  const inv = 1 / det;
  return [
    (e * i - f * h) * inv, (c * h - b * i) * inv, (b * f - c * e) * inv,
    (f * g - d * i) * inv, (a * i - c * g) * inv, (c * d - a * f) * inv,
    (d * h - e * g) * inv, (b * g - a * h) * inv, (a * e - b * d) * inv,
  ];
}

export const sub3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale3 = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const norm3 = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const dot3 = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross3 = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

/* ------------------------------------------------------------------ *
 * Homography
 * ------------------------------------------------------------------ */

/**
 * Direct Linear Transform. Maps `src` onto `dst`, normalising h22 to 1.
 * Needs >= 4 correspondences; extras are absorbed as least squares.
 */
export function computeHomography(src: Vec2[], dst: Vec2[]): Mat3 | null {
  if (src.length < 4 || src.length !== dst.length) return null;

  const rows: number[][] = [];
  const rhs: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const x = src[i].x;
    const y = src[i].y;
    const X = dst[i].x;
    const Y = dst[i].y;
    rows.push([x, y, 1, 0, 0, 0, -x * X, -y * X]);
    rhs.push(X);
    rows.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]);
    rhs.push(Y);
  }

  // Normal equations, so the >4-point case is a proper least-squares fit.
  const n = 8;
  const AtA: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  const Atb: number[] = new Array(n).fill(0);
  for (let r = 0; r < rows.length; r++) {
    for (let i = 0; i < n; i++) {
      Atb[i] += rows[r][i] * rhs[r];
      for (let j = 0; j < n; j++) AtA[i][j] += rows[r][i] * rows[r][j];
    }
  }

  const h = solveLinear(AtA, Atb);
  return h ? [...h, 1] : null;
}

export function applyHomography(H: Mat3, p: Vec2): Vec2 {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  return {
    x: (H[0] * p.x + H[1] * p.y + H[2]) / w,
    y: (H[3] * p.x + H[4] * p.y + H[5]) / w,
  };
}

/* ------------------------------------------------------------------ *
 * Camera model
 * ------------------------------------------------------------------ */

/** Pinhole intrinsics from an image size and a horizontal field of view. */
export function intrinsicsFromFov(width: number, height: number, hfovDeg: number): Mat3 {
  const f = width / 2 / Math.tan((hfovDeg * Math.PI) / 180 / 2);
  return [f, 0, width / 2, 0, f, height / 2, 0, 0, 1];
}

export type CameraPose = { R: Mat3; t: Vec3 };

/**
 * Recover pose from a world-plane -> image homography.
 *
 * H = K [r1 r2 t] up to scale. Strip K, rescale so r1 is unit length, then
 * re-orthonormalise (the DLT result is only approximately a rotation).
 */
export function poseFromHomography(Hwi: Mat3, K: Mat3): CameraPose | null {
  const Kinv = mat3Invert(K);
  if (!Kinv) return null;
  const M = mat3Mul(Kinv, Hwi);

  const c0: Vec3 = { x: M[0], y: M[3], z: M[6] };
  const c1: Vec3 = { x: M[1], y: M[4], z: M[7] };
  const c2: Vec3 = { x: M[2], y: M[5], z: M[8] };

  const n0 = norm3(c0);
  const n1 = norm3(c1);
  if (n0 < 1e-12 || n1 < 1e-12) return null;
  let lambda = 2 / (n0 + n1);

  // The camera must sit in front of the plane, not behind it.
  if (c2.z * lambda < 0) lambda = -lambda;

  let r1 = scale3(c0, lambda);
  let r2 = scale3(c1, lambda);
  const t = scale3(c2, lambda);

  // Gram-Schmidt.
  const r1n = norm3(r1);
  if (r1n < 1e-12) return null;
  r1 = scale3(r1, 1 / r1n);
  r2 = sub3(r2, scale3(r1, dot3(r1, r2)));
  const r2n = norm3(r2);
  if (r2n < 1e-12) return null;
  r2 = scale3(r2, 1 / r2n);
  const r3 = cross3(r1, r2);

  return {
    R: [r1.x, r2.x, r3.x, r1.y, r2.y, r3.y, r1.z, r2.z, r3.z],
    t,
  };
}

export function projectPoint(K: Mat3, pose: CameraPose, P: Vec3): Vec2 | null {
  const c = mat3Vec(pose.R, P);
  const cam: Vec3 = { x: c.x + pose.t.x, y: c.y + pose.t.y, z: c.z + pose.t.z };
  if (cam.z <= 1e-9) return null;
  const p = mat3Vec(K, cam);
  return { x: p.x / p.z, y: p.y / p.z };
}

/**
 * Back-project a pixel onto the horizontal plane z = height.
 *
 * This is the move that makes one camera enough: the release point sits on a
 * known height plane above the circle, the landing point sits on z = 0, and
 * gravity supplies the rest.
 */
export function backprojectToHeight(
  pixel: Vec2,
  K: Mat3,
  pose: CameraPose,
  height: number,
): Vec3 | null {
  const Kinv = mat3Invert(K);
  if (!Kinv) return null;
  const Rt = mat3Transpose(pose.R);
  const a = mat3Vec(Rt, mat3Vec(Kinv, { x: pixel.x, y: pixel.y, z: 1 }));
  const b = mat3Vec(Rt, pose.t);
  if (Math.abs(a.z) < 1e-12) return null;
  const s = (height + b.z) / a.z;
  if (s <= 0) return null;
  return { x: s * a.x - b.x, y: s * a.y - b.y, z: s * a.z - b.z };
}

/**
 * Intersect a pixel's viewing ray with the VERTICAL plane containing two ground
 * points.
 *
 * Needed because back-projecting to an assumed height plane fails exactly when
 * it matters: once the implement is above the camera, a ray aimed upward never
 * reaches a plane below it, and the solve returns nothing. But the flight is
 * planar, and we already know two points of that plane in world coordinates -
 * the circle and the landing mark. Intersecting with the plane recovers a point
 * at its true height without assuming what that height is.
 */
export function rayToVerticalPlane(
  pixel: Vec2,
  K: Mat3,
  pose: CameraPose,
  planeA: Vec2,
  planeB: Vec2,
): Vec3 | null {
  const Kinv = mat3Invert(K);
  if (!Kinv) return null;
  const Rt = mat3Transpose(pose.R);
  const dir = mat3Vec(Rt, mat3Vec(Kinv, { x: pixel.x, y: pixel.y, z: 1 }));
  const b = mat3Vec(Rt, pose.t);
  const eye: Vec3 = { x: -b.x, y: -b.y, z: -b.z };

  const dx = planeB.x - planeA.x;
  const dy = planeB.y - planeA.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  // Horizontal normal of the vertical plane.
  const n: Vec3 = { x: dy / len, y: -dx / len, z: 0 };

  const denom = dot3(n, dir);
  if (Math.abs(denom) < 1e-9) return null;
  const s = (n.x * (planeA.x - eye.x) + n.y * (planeA.y - eye.y)) / denom;
  if (s <= 0) return null;

  return { x: s * dir.x + eye.x, y: s * dir.y + eye.y, z: s * dir.z + eye.z };
}

/* ------------------------------------------------------------------ *
 * Throwing-venue measurement
 * ------------------------------------------------------------------ */

/**
 * Official distance per World Athletics Rule 32.17: measured from the nearest
 * mark to the inside edge of the circle, along a line through the centre.
 * So: radial distance from centre, minus the circle radius.
 */
export function officialDistance(
  landing: Vec2,
  circleCentre: Vec2,
  circleDiameter: number,
): number {
  const radial = Math.hypot(landing.x - circleCentre.x, landing.y - circleCentre.y);
  return radial - circleDiameter / 2;
}

/**
 * Signed angle off the sector centreline, in degrees. Positive = left of centre.
 * Beyond +/- 17.46 deg the throw is out of sector; every degree off centre is
 * distance donated to the sector line.
 */
export function sectorDeviationDeg(
  landing: Vec2,
  circleCentre: Vec2,
  centrelineDeg: number,
): number {
  const dx = landing.x - circleCentre.x;
  const dy = landing.y - circleCentre.y;
  const bearing = (Math.atan2(dy, dx) * 180) / Math.PI;
  let d = bearing - centrelineDeg;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

export function isInSector(deviationDeg: number): boolean {
  return Math.abs(deviationDeg) <= SECTOR_ANGLE_DEG / 2 + 1e-9;
}

/**
 * Distance lost to sector deviation: how much further the same throw would have
 * measured if it had been struck down the centreline. Radial distance is
 * preserved, so nothing is actually lost on a legal throw - but the margin to
 * the sector line is what an athlete is really spending.
 */
export function sectorMarginDeg(deviationDeg: number): number {
  return SECTOR_ANGLE_DEG / 2 - Math.abs(deviationDeg);
}
