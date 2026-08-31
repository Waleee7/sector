/**
 * SECTOR - trajectory extraction.
 *
 * This is the piece that makes the whole thing work. detect.ts hands us a noisy
 * cloud of blobs - the athlete, a swaying tree, a bird, sensor noise, and
 * somewhere in there, the implement. We never ask "which blob is the discus?".
 * We ask "which SUBSET of these blobs lies on a physically valid flight?".
 *
 * Under a roughly side-on camera the projection of a ballistic arc is, to good
 * approximation, linear in image-x and quadratic in image-y, both parameterised
 * by time. RANSAC over that model rejects everything that is not on an arc, so
 * we can tolerate a detector that is wrong far more often than it is right - and
 * we only need ~5 good frames out of a whole flight.
 */

import { solveLinear } from "./geometry";
import type { Blob, FrameCandidates } from "./detect";

export type TrackPoint = { t: number; frame: number; x: number; y: number; blob: Blob };

export type TrajectoryModel = {
  /** x(t) = x0 + vx * t   (image px, seconds) */
  x0: number;
  vx: number;
  /** y(t) = y0 + vy * t + 0.5 * ay * t^2   (image px, y increases downward) */
  y0: number;
  vy: number;
  ay: number;
};

export type Trajectory = {
  model: TrajectoryModel;
  inliers: TrackPoint[];
  rmsError: number;
  /** Seconds between first and last inlier. */
  durationS: number;
  /** Fraction of frames in the span that produced an inlier. */
  density: number;
};

export type TrackOptions = {
  /** Inlier tolerance in pixels. */
  tolerancePx: number;
  /** Minimum inlier count before a fit is taken seriously. */
  minInliers: number;
  /** Minimum flight duration, seconds. Rejects short-lived noise clusters. */
  minDurationS: number;
  /** Minimum horizontal image speed, px/s. Rejects the near-stationary athlete. */
  minVxPxPerS: number;
  /**
   * Minimum sagitta - how far the arc bows away from the straight line joining
   * its endpoints, in pixels.
   *
   * This is the check that separates a flight from a bird. A bird crossing the
   * frame has a technically positive fitted curvature (noise guarantees it) and
   * can rack up more inliers than the implement, because it is in shot for the
   * whole clip. It cannot fake a bow. For a parabola the sagitta is
   * ay * T^2 / 8, which is scale-aware in a way that a raw threshold on ay is not.
   */
  minSagittaPx: number;
  /** Fraction of frames across the span that must produce an inlier. */
  minDensity: number;
  iterations: number;
  /** Deterministic seed so the same video always yields the same answer. */
  seed: number;
};

export const DEFAULT_TRACK: TrackOptions = {
  tolerancePx: 6,
  minInliers: 8,
  minDurationS: 0.35,
  minVxPxPerS: 40,
  // Measured against the synthetic venue: a real 68 m discus flight bows ~95 px
  // at 640x360, while a swaying bird fakes ~10 px. 24 leaves margin on both
  // sides, including for a short, flat throw.
  minSagittaPx: 24,
  minDensity: 0.25,
  iterations: 3000,
  seed: 0x5ec7,
};

/** How far a fitted arc bows from the chord joining its endpoints, in pixels. */
export function sagittaPx(m: TrajectoryModel, durationS: number): number {
  return Math.abs(0.125 * m.ay * durationS * durationS);
}

/** Deterministic PRNG - reproducible analysis matters more than entropy here. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function flattenCandidates(frames: FrameCandidates[]): TrackPoint[] {
  const out: TrackPoint[] = [];
  for (const f of frames) {
    for (const b of f.blobs) {
      out.push({ t: f.t, frame: f.frame, x: b.x, y: b.y, blob: b });
    }
  }
  return out;
}

/** Least-squares polynomial fit, degree 1 or 2, via normal equations. */
function polyfit(ts: number[], vs: number[], degree: number): number[] | null {
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
  return solveLinear(AtA, Atb);
}

function fitModel(pts: TrackPoint[]): TrajectoryModel | null {
  if (pts.length < 3) return null;
  const ts = pts.map((p) => p.t);
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);

  const fx = polyfit(ts, xs, 1);
  const fy = polyfit(ts, ys, 2);
  if (!fx || !fy) return null;

  return { x0: fx[0], vx: fx[1], y0: fy[0], vy: fy[1], ay: 2 * fy[2] };
}

export function predict(m: TrajectoryModel, t: number): { x: number; y: number } {
  return { x: m.x0 + m.vx * t, y: m.y0 + m.vy * t + 0.5 * m.ay * t * t };
}

function residual(m: TrajectoryModel, p: TrackPoint): number {
  const q = predict(m, p.t);
  return Math.hypot(q.x - p.x, q.y - p.y);
}

/**
 * One point per frame: when several blobs in a frame fit the model, the closest
 * one wins. Prevents a cluster of noise in a single frame from inflating the
 * inlier count and beating a genuine arc.
 */
function gatherInliers(m: TrajectoryModel, pts: TrackPoint[], tol: number): TrackPoint[] {
  const best = new Map<number, { p: TrackPoint; r: number }>();
  for (const p of pts) {
    const r = residual(m, p);
    if (r > tol) continue;
    const cur = best.get(p.frame);
    if (!cur || r < cur.r) best.set(p.frame, { p, r });
  }
  return Array.from(best.values())
    .map((v) => v.p)
    .sort((a, b) => a.t - b.t);
}

function evaluate(
  m: TrajectoryModel,
  pts: TrackPoint[],
  opts: TrackOptions,
  frameCount: number,
): Trajectory | null {
  // Image y grows downward, so a real flight must show positive vertical
  // acceleration. This single check throws out most of the noise fits.
  if (!(m.ay > 0)) return null;
  if (Math.abs(m.vx) < opts.minVxPxPerS) return null;

  const inliers = gatherInliers(m, pts, opts.tolerancePx);
  if (inliers.length < opts.minInliers) return null;

  const durationS = inliers[inliers.length - 1].t - inliers[0].t;
  if (durationS < opts.minDurationS) return null;

  // A flight bows. A bird does not.
  if (sagittaPx(m, durationS) < opts.minSagittaPx) return null;

  const spanFrames = inliers[inliers.length - 1].frame - inliers[0].frame + 1;
  const density = inliers.length / Math.max(1, Math.min(spanFrames, frameCount));
  if (density < opts.minDensity) return null;

  let sumSq = 0;
  for (const p of inliers) {
    const r = residual(m, p);
    sumSq += r * r;
  }

  return {
    model: m,
    inliers,
    rmsError: Math.sqrt(sumSq / inliers.length),
    durationS,
    density,
  };
}

/**
 * RANSAC + reweighted refit. Samples triples from distinct frames, keeps the
 * hypothesis with the most inliers, then refits on the full inlier set twice so
 * the final model is not hostage to the three seed points.
 */
/** Overlap between two inlier sets, for de-duplicating near-identical hypotheses. */
function jaccard(a: Trajectory, b: Trajectory): number {
  const key = (p: TrackPoint) => `${p.frame}:${Math.round(p.x)}:${Math.round(p.y)}`;
  const sa = new Set(a.inliers.map(key));
  let shared = 0;
  for (const p of b.inliers) if (sa.has(key(p))) shared++;
  return shared / (sa.size + b.inliers.length - shared);
}

function refine(t: Trajectory, pts: TrackPoint[], opts: TrackOptions, frames: number): Trajectory {
  let cur = t;
  for (let pass = 0; pass < 2; pass++) {
    const m = fitModel(cur.inliers);
    if (!m) break;
    const cand = evaluate(m, pts, opts, frames);
    if (!cand) break;
    cur = cand;
  }
  return cur;
}

/**
 * Return the top-K structurally distinct hypotheses rather than a single winner.
 *
 * Inlier count alone is not enough to identify the implement. A decoy that is in
 * shot for the whole clip - a bird, a flag, a car on a distant road - can out-vote
 * the implement, and a fit can even chain a decoy's early points to the
 * implement's late ones when their image velocities happen to be similar.
 *
 * So this layer does not decide. It proposes, and solve.ts rejects whatever is
 * not physically realisable as a throw. That division of labour is the whole
 * design: pixels suggest, gravity decides.
 */
export function findTrajectoryCandidates(
  pts: TrackPoint[],
  opts: TrackOptions = DEFAULT_TRACK,
  k = 6,
): Trajectory[] {
  if (pts.length < opts.minInliers) return [];

  const rand = mulberry32(opts.seed);
  const byFrame = new Map<number, TrackPoint[]>();
  for (const p of pts) {
    const arr = byFrame.get(p.frame);
    if (arr) arr.push(p);
    else byFrame.set(p.frame, [p]);
  }
  const frames = Array.from(byFrame.keys()).sort((a, b) => a - b);
  if (frames.length < 3) return [];

  const pool: Trajectory[] = [];
  const POOL_CAP = 60;

  for (let iter = 0; iter < opts.iterations; iter++) {
    const i0 = (rand() * frames.length) | 0;
    const i1 = (rand() * frames.length) | 0;
    const i2 = (rand() * frames.length) | 0;
    if (i0 === i1 || i1 === i2 || i0 === i2) continue;
    const idx = [i0, i1, i2].sort((a, b) => a - b);
    if (idx[2] - idx[0] < 2) continue;

    const sample: TrackPoint[] = [];
    for (const i of idx) {
      const cands = byFrame.get(frames[i]) as TrackPoint[];
      sample.push(cands[(rand() * cands.length) | 0]);
    }

    const m = fitModel(sample);
    if (!m) continue;
    const cand = evaluate(m, pts, opts, frames.length);
    if (!cand) continue;

    pool.push(cand);
    if (pool.length > POOL_CAP) {
      pool.sort((a, b) => b.inliers.length - a.inliers.length || a.rmsError - b.rmsError);
      pool.length = Math.floor(POOL_CAP / 2);
    }
  }

  pool.sort((a, b) => b.inliers.length - a.inliers.length || a.rmsError - b.rmsError);

  const picked: Trajectory[] = [];
  for (const cand of pool) {
    if (picked.some((p) => jaccard(p, cand) > 0.6)) continue;
    picked.push(refine(cand, pts, opts, frames.length));
    if (picked.length >= k) break;
  }
  return picked;
}

export function findTrajectory(
  pts: TrackPoint[],
  opts: TrackOptions = DEFAULT_TRACK,
): Trajectory | null {
  if (pts.length < opts.minInliers) return null;

  const rand = mulberry32(opts.seed);
  const byFrame = new Map<number, TrackPoint[]>();
  for (const p of pts) {
    const arr = byFrame.get(p.frame);
    if (arr) arr.push(p);
    else byFrame.set(p.frame, [p]);
  }
  const frames = Array.from(byFrame.keys()).sort((a, b) => a - b);
  if (frames.length < 3) return null;

  let best: Trajectory | null = null;

  for (let iter = 0; iter < opts.iterations; iter++) {
    // Three distinct frames, spread out - a triple from adjacent frames barely
    // constrains the curvature.
    const i0 = (rand() * frames.length) | 0;
    const i1 = (rand() * frames.length) | 0;
    const i2 = (rand() * frames.length) | 0;
    if (i0 === i1 || i1 === i2 || i0 === i2) continue;
    const idx = [i0, i1, i2].sort((a, b) => a - b);
    if (idx[2] - idx[0] < 2) continue;

    const sample: TrackPoint[] = [];
    for (const i of idx) {
      const cands = byFrame.get(frames[i]) as TrackPoint[];
      sample.push(cands[(rand() * cands.length) | 0]);
    }

    const m = fitModel(sample);
    if (!m) continue;
    const cand = evaluate(m, pts, opts, frames.length);
    if (!cand) continue;

    if (
      !best ||
      cand.inliers.length > best.inliers.length ||
      (cand.inliers.length === best.inliers.length && cand.rmsError < best.rmsError)
    ) {
      best = cand;
    }
  }

  if (!best) return null;

  // Refit on inliers, twice. Cheap, and it measurably tightens the release solve.
  let refined = best;
  for (let pass = 0; pass < 2; pass++) {
    const m = fitModel(refined.inliers);
    if (!m) break;
    const cand = evaluate(m, pts, opts, frames.length);
    if (!cand) break;
    refined = cand;
  }

  return refined;
}

/**
 * Multiple flights in one clip - a whole flight of throwers filmed from one
 * tripod. Finds the strongest arc, removes its inliers, and goes again.
 */
export function findTrajectories(
  pts: TrackPoint[],
  opts: TrackOptions = DEFAULT_TRACK,
  maxCount = 8,
): Trajectory[] {
  const out: Trajectory[] = [];
  let pool = pts;

  for (let i = 0; i < maxCount; i++) {
    const traj = findTrajectory(pool, opts);
    if (!traj) break;
    out.push(traj);
    const used = new Set(traj.inliers.map((p) => `${p.frame}:${p.x.toFixed(2)}:${p.y.toFixed(2)}`));
    const spanLo = traj.inliers[0].t;
    const spanHi = traj.inliers[traj.inliers.length - 1].t;
    pool = pool.filter(
      (p) =>
        !used.has(`${p.frame}:${p.x.toFixed(2)}:${p.y.toFixed(2)}`) &&
        (p.t < spanLo - 0.1 || p.t > spanHi + 0.1),
    );
    if (pool.length < opts.minInliers) break;
  }

  return out.sort((a, b) => a.inliers[0].t - b.inliers[0].t);
}
