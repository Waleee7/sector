/// <reference lib="webworker" />
/**
 * Analysis worker.
 *
 * The full solve integrates a lifting flight a few hundred times. That is
 * multiple seconds of arithmetic, and it does not belong on the thread that is
 * drawing the interface.
 */

import { analyze, type FrameSource } from "./pipeline";
import { buildScene, type SynthOptions } from "./synth";
import type { Calibration, Conditions, ThrowMetrics } from "./solve";
import type { Vec2 } from "./geometry";

export type WorkerRequest =
  | {
      kind: "demo";
      opts: SynthOptions;
      calibration: Calibration;
      implementId: string;
      conditions: Conditions;
    }
  | {
      kind: "frames";
      width: number;
      height: number;
      fps: number;
      frames: ArrayBuffer[];
      calibration: Calibration;
      implementId: string;
      conditions: Conditions;
    };

export type WorkerResponse =
  | { kind: "progress"; done: number; total: number; stage: string }
  | {
      kind: "done";
      metrics: ThrowMetrics | null;
      inliers: { frame: number; x: number; y: number }[];
      blobs: { frame: number; points: Vec2[] }[];
      rejectedHypotheses: { inliers: number; reason: string }[];
      hypothesisCount: number;
      blobCount: number;
      thresholdUsed: number;
      speedRange: [number, number] | null;
      distanceRange: [number, number] | null;
      heightRange: [number, number] | null;
      elapsedMs: number;
    }
  | { kind: "error"; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  try {
    let source: FrameSource;

    if (req.kind === "demo") {
      const scene = buildScene(req.opts);
      source = {
        width: scene.width,
        height: scene.height,
        fps: scene.fps,
        frameCount: scene.frameCount,
        getGray: (i) => scene.renderGray(i),
      };
    } else {
      const frames = req.frames.map((b) => new Uint8Array(b));
      source = {
        width: req.width,
        height: req.height,
        fps: req.fps,
        frameCount: frames.length,
        getGray: (i) => frames[i],
      };
    }

    const result = analyze(source, {
      calibration: req.calibration,
      implementId: req.implementId,
      conditions: req.conditions,
      onProgress: (done, total, stage) => {
        const msg: WorkerResponse = { kind: "progress", done, total, stage };
        ctx.postMessage(msg);
      },
    });

    const msg: WorkerResponse = {
      kind: "done",
      metrics: result.metrics,
      inliers:
        result.trajectory?.inliers.map((p) => ({ frame: p.frame, x: p.x, y: p.y })) ?? [],
      blobs: result.candidates.map((c) => ({
        frame: c.frame,
        points: c.blobs.map((b) => ({ x: b.x, y: b.y })),
      })),
      rejectedHypotheses: result.rejected,
      hypothesisCount: result.hypotheses.length,
      blobCount: result.blobCount,
      thresholdUsed: result.thresholdUsed,
      speedRange: result.speedRange,
      distanceRange: result.distanceRange,
      heightRange: result.heightRange,
      elapsedMs: result.elapsedMs,
    };
    ctx.postMessage(msg);
  } catch (err) {
    const msg: WorkerResponse = {
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    };
    ctx.postMessage(msg);
  }
};
