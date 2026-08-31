/**
 * SECTOR - the analysis pipeline.
 *
 * One entry point, driven by a frame source. The synthetic venue and a phone
 * video both satisfy the same interface, which is deliberate: the demo is not a
 * separate code path that could quietly diverge from the real one.
 */

import {
  DEFAULT_DETECT,
  detectFrame,
  medianBackground,
  suggestThreshold,
  type DetectOptions,
  type FrameCandidates,
} from "./detect";
import {
  DEFAULT_TRACK,
  findTrajectoryCandidates,
  flattenCandidates,
  type TrackOptions,
  type Trajectory,
} from "./track";
import {
  DEFAULT_CONDITIONS,
  chooseThrow,
  solveCamera,
  solveWithUncertainty,
  type Calibration,
  type Conditions,
  type Rejection,
  type SolvedCamera,
  type ThrowMetrics,
} from "./solve";

export type FrameSource = {
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  /** Luma buffer for a frame index. May be generated on demand. */
  getGray(index: number): Uint8Array;
};

export type AnalysisResult = {
  candidates: FrameCandidates[];
  /** Every image-space hypothesis RANSAC proposed, strongest first. */
  hypotheses: Trajectory[];
  /** Hypotheses the physics gate threw out, and why. */
  rejected: Rejection[];
  trajectory: Trajectory | null;
  metrics: ThrowMetrics | null;
  speedRange: [number, number] | null;
  distanceRange: [number, number] | null;
  heightRange: [number, number] | null;
  camera: SolvedCamera | null;
  background: Uint8Array;
  thresholdUsed: number;
  blobCount: number;
  elapsedMs: number;
};

export type AnalyzeOptions = {
  detect?: Partial<DetectOptions>;
  track?: Partial<TrackOptions>;
  calibration: Calibration;
  implementId: string;
  conditions?: Conditions;
  releaseHeightSeed?: number;
  /** Frames sampled to build the background model. */
  backgroundSamples?: number;
  onProgress?: (done: number, total: number, stage: string) => void;
};

export function buildBackground(source: FrameSource, samples = 15): Uint8Array {
  const n = Math.max(3, Math.min(samples, source.frameCount));
  const frames: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.floor((i * (source.frameCount - 1)) / Math.max(1, n - 1));
    frames.push(source.getGray(idx));
  }
  return medianBackground(frames);
}

export function analyze(source: FrameSource, opts: AnalyzeOptions): AnalysisResult {
  const started = Date.now();
  const report = opts.onProgress ?? (() => {});

  report(0, source.frameCount, "Building background model");
  const background = buildBackground(source, opts.backgroundSamples ?? 15);

  // Auto-threshold from a mid-flight frame, then let any explicit override win.
  const probe = source.getGray(Math.floor(source.frameCount * 0.55));
  const auto = suggestThreshold(probe, background, 4);
  const detectOpts: DetectOptions = { ...DEFAULT_DETECT, threshold: auto, ...opts.detect };

  const candidates: FrameCandidates[] = [];
  let blobCount = 0;
  for (let i = 0; i < source.frameCount; i++) {
    const gray = source.getGray(i);
    const blobs = detectFrame(gray, background, source.width, source.height, detectOpts);
    blobCount += blobs.length;
    candidates.push({ frame: i, t: i / source.fps, blobs });
    if (i % 10 === 0) report(i, source.frameCount, "Detecting");
  }

  report(source.frameCount, source.frameCount, "Fitting trajectory");
  const trackOpts: TrackOptions = { ...DEFAULT_TRACK, ...opts.track };
  const hypotheses = findTrajectoryCandidates(flattenCandidates(candidates), trackOpts, 6);

  const solveBase = {
    calibration: opts.calibration,
    implementId: opts.implementId,
    conditions: opts.conditions ?? DEFAULT_CONDITIONS,
    releaseHeightSeed: opts.releaseHeightSeed,
  };

  report(source.frameCount, source.frameCount, "Solving 3D flight");
  const chosen = chooseThrow(hypotheses, solveBase);

  const trajectory: Trajectory | null = chosen.trajectory;
  let metrics: ThrowMetrics | null = chosen.metrics;
  let speedRange: [number, number] | null = null;
  let distanceRange: [number, number] | null = null;
  let heightRange: [number, number] | null = null;

  if (trajectory && metrics) {
    const solved = solveWithUncertainty({ ...solveBase, trajectory }, metrics);
    if (solved) {
      metrics = solved.best;
      speedRange = solved.speedRange;
      distanceRange = solved.distanceRange;
      heightRange = solved.heightRange;
    }
  }

  return {
    candidates,
    hypotheses,
    rejected: chosen.rejected,
    trajectory,
    metrics,
    speedRange,
    distanceRange,
    heightRange,
    camera: solveCamera(opts.calibration),
    background,
    thresholdUsed: detectOpts.threshold,
    blobCount,
    elapsedMs: Date.now() - started,
  };
}
