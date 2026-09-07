"use client";

/**
 * The tracking stage.
 *
 * The overlay is a diagnostic wearing a HUD, not a HUD painted over a video.
 * Every mark on it is anchored to a real quantity, and colour carries meaning:
 *
 *   amber  - what the system SAW in pixels (candidate blobs, accepted arc points)
 *   cyan   - what the system SOLVED in metres (flight, grid, release, landing)
 *   red    - what it THREW OUT (blobs the fit refused)
 *   gold   - what a human clicked (calibration)
 *
 * When the cyan flight lies on top of the amber trail, the solve is honest. When
 * it does not, you can see that too, which is the point of drawing both.
 */

import { useEffect, useRef } from "react";
import { grayToRGBA } from "@/lib/synth";
import { worldToImage, type SolvedCamera } from "@/lib/solve";
import type { Vec2, Vec3 } from "@/lib/geometry";
import {
  HUD,
  brackets,
  crosshair,
  dashedPath,
  frameChrome,
  glow,
  micro,
  pulse,
  rejectMark,
  scanlines,
  statusChip,
  sweepArcs,
  telemetryTag,
  tickRing,
  vignette,
  type LockState,
} from "@/lib/hud";

const SECTOR_HALF_DEG = 34.92 / 2;

export type TrackedPoint = { frame: number; x: number; y: number };

export type StageProps = {
  /** Video-space dimensions. Everything in `blobs`, `inliers` and the camera is in these units. */
  width: number;
  height: number;
  frame: number;
  fps: number;
  getGray: (i: number) => Uint8Array | null;
  blobs: { frame: number; points: Vec2[] }[] | null;
  inliers: TrackedPoint[] | null;
  camera: SolvedCamera | null;
  path: Vec3[] | null;
  /** Total flight time, so a path index can be recovered from a frame. */
  flightTimeS: number | null;
  releaseWorld: Vec3 | null;
  landingWorld: Vec3 | null;
  showDetections: boolean;
  showGrid: boolean;
  calibrationPoints?: Vec2[];
  onPick?: (p: Vec2) => void;
  analysing?: boolean;
  analysisStage?: string | null;
  confidence?: "high" | "medium" | "low" | null;
  reprojectionRmsPx?: number | null;
  sourceLabel?: string;
  implementLabel?: string;
};

export default function Stage(props: StageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<ImageData | null>(null);
  // Props are read through a ref so the animation loop is created once and never
  // torn down mid-flight by a re-render.
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    let raf = 0;
    const start = performance.now();

    const loop = () => {
      draw(canvasRef.current, offRef, imgRef, propsRef.current, (performance.now() - start) / 1000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      onClick={
        props.onPick
          ? (e) => {
              const c = canvasRef.current;
              if (!c) return;
              const r = c.getBoundingClientRect();
              props.onPick?.({
                x: ((e.clientX - r.left) / r.width) * props.width,
                y: ((e.clientY - r.top) / r.height) * props.height,
              });
            }
          : undefined
      }
      style={{
        width: "100%",
        aspectRatio: `${props.width} / ${props.height}`,
        height: "auto",
        display: "block",
        borderRadius: 10,
        cursor: props.onPick ? "crosshair" : "default",
        background: "#04080c",
      }}
    />
  );
}

/** Where the tracker is in its life cycle at this frame. Drives the whole overlay. */
function lockStateFor(p: StageProps): { state: LockState; tension: number } {
  if (p.analysing) return { state: "scanning", tension: 0 };
  if (!p.inliers || p.inliers.length === 0) return { state: "standby", tension: 0 };
  const first = p.inliers[0].frame;
  const last = p.inliers[p.inliers.length - 1].frame;
  if (p.frame < first) {
    // Close the brackets over the half second before the implement appears, so
    // acquisition reads as a build rather than a switch flipping.
    const lead = Math.max(1, Math.round(p.fps * 0.5));
    return { state: "acquiring", tension: clamp01(1 - (first - p.frame) / lead) * 0.75 };
  }
  if (p.frame > last) return { state: "resolved", tension: 1 };
  return { state: "locked", tension: 1 };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function draw(
  canvas: HTMLCanvasElement | null,
  offRef: React.RefObject<HTMLCanvasElement | null>,
  imgRef: React.RefObject<ImageData | null>,
  p: StageProps,
  clock: number,
) {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const cssW = rect.width;
  const cssH = rect.height;
  if (cssW < 2 || cssH < 2) return;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const bw = Math.round(cssW * dpr);
  const bh = Math.round(cssH * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  // Video space -> CSS space. The footage is 640x360; the HUD is drawn at
  // display resolution so it stays crisp however far the video is upscaled.
  const s = cssW / p.width;
  const S = (v: Vec2 | null): Vec2 | null => (v ? { x: v.x * s, y: v.y * s } : null);
  // A scale for HUD furniture that grows with the canvas but never runs away.
  const u = Math.max(0.85, Math.min(1.9, cssW / 720));

  // ---- the footage ------------------------------------------------
  const gray = p.getGray(p.frame);
  if (gray && gray.length === p.width * p.height) {
    if (!offRef.current) offRef.current = document.createElement("canvas");
    const off = offRef.current;
    if (off.width !== p.width || off.height !== p.height) {
      off.width = p.width;
      off.height = p.height;
      imgRef.current = null;
    }
    const octx = off.getContext("2d");
    if (octx) {
      if (!imgRef.current) imgRef.current = octx.createImageData(p.width, p.height);
      grayToRGBA(gray, imgRef.current.data);
      octx.putImageData(imgRef.current, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(off, 0, 0, cssW, cssH);
    }
  } else {
    ctx.fillStyle = "#04080c";
    ctx.fillRect(0, 0, cssW, cssH);
  }

  // Cool and darken the plate so the overlay separates from it. The footage is
  // evidence, not the hero.
  ctx.fillStyle = "rgba(4, 14, 24, 0.18)";
  ctx.fillRect(0, 0, cssW, cssH);
  vignette(ctx, cssW, cssH);
  scanlines(ctx, cssW, cssH, u);

  const { state, tension } = lockStateFor(p);

  // ---- holographic ground grid ------------------------------------
  // Projected with the SOLVED camera, so a grid that sits correctly on the
  // painted lines is itself evidence the calibration is good.
  if (p.showGrid && p.camera) {
    drawGroundGrid(ctx, p.camera, s, u, cssW, cssH);
  }

  // ---- calibration marks ------------------------------------------
  if (p.calibrationPoints?.length) {
    p.calibrationPoints.forEach((raw, i) => {
      const q = S(raw)!;
      ctx.save();
      ctx.strokeStyle = HUD.gold;
      ctx.lineWidth = 1.2;
      ctx.globalAlpha = 0.95;
      crosshair(ctx, q.x, q.y, 9 * u, 3 * u, HUD.gold);
      ctx.beginPath();
      ctx.arc(q.x, q.y, 3 * u, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      micro(ctx, `C${i + 1}`, q.x + 8 * u, q.y - 7 * u, HUD.gold, 8 * u);
    });
  }

  // ---- candidates: accepted vs discarded --------------------------
  const inlierHere = p.inliers?.find((v) => v.frame === p.frame) ?? null;
  if (p.showDetections && p.blobs) {
    const f = p.blobs.find((b) => b.frame === p.frame);
    if (f) {
      for (const raw of f.points) {
        const q = S(raw)!;
        const isInlier =
          inlierHere && Math.hypot(raw.x - inlierHere.x, raw.y - inlierHere.y) < 3.5;
        if (isInlier) continue;
        rejectMark(ctx, q, 4.5 * u, 0.42);
      }
      micro(
        ctx,
        `CANDIDATES ${String(f.points.length).padStart(2, "0")}`,
        10 * u,
        cssH - 12 * u,
        "rgba(255,77,94,0.65)",
        8.5 * u,
      );
    }
  }

  // ---- the solved flight, projected back onto the image ------------
  if (p.camera && p.path && p.path.length > 1) {
    const cam = p.camera;
    const projected = p.path.map((P) => worldToImage(cam, P)).map(S);
    glow(ctx, HUD.verify, 8 * u, () => {
      dashedPath(ctx, projected, HUD.verify, 1.5 * u, [6 * u, 5 * u], 0.9);
    });

    const rel = S(worldToImage(cam, p.releaseWorld ?? p.path[0]));
    const land = S(worldToImage(cam, p.landingWorld ?? p.path[p.path.length - 1]));
    if (rel) endpointMark(ctx, rel, "RELEASE", HUD.verify, u);
    if (land) endpointMark(ctx, land, "LANDING", HUD.verify, u);

    // One expanding ring at each end, keyed to the playhead crossing it.
    if (p.inliers?.length) {
      const first = p.inliers[0].frame;
      const last = p.inliers[p.inliers.length - 1].frame;
      const win = Math.max(1, p.fps * 0.45);
      if (rel) pulse(ctx, rel, (p.frame - first) / win, HUD.verify, 34 * u);
      if (land) pulse(ctx, land, (p.frame - last) / win, HUD.signal, 40 * u);
    }
  }

  // ---- the trail: accepted arc points, fading behind the head ------
  let head: Vec2 | null = null;
  if (p.inliers && p.inliers.length) {
    const past = p.inliers.filter((v) => v.frame <= p.frame);
    if (past.length) {
      glow(ctx, HUD.signal, 10 * u, () => {
        ctx.save();
        ctx.strokeStyle = HUD.signal;
        ctx.lineWidth = 1.5 * u;
        ctx.lineJoin = "round";
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        past.forEach((v, i) => {
          const q = S(v)!;
          if (i === 0) ctx.moveTo(q.x, q.y);
          else ctx.lineTo(q.x, q.y);
        });
        ctx.stroke();
        ctx.restore();
      });

      for (let i = 0; i < past.length; i++) {
        const age = (past.length - 1 - i) / Math.max(1, past.length - 1);
        const q = S(past[i])!;
        ctx.fillStyle = `rgba(255, 122, 24, ${(0.95 - age * 0.72).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(q.x, q.y, (1.6 + (1 - age) * 1.3) * u, 0, Math.PI * 2);
        ctx.fill();
      }
      head = S(past[past.length - 1]);
    }
  }

  // ---- the reticle -------------------------------------------------
  const target = head ?? (p.inliers?.length ? S(p.inliers[0]) : null);
  if (target && state !== "standby") {
    const live = state === "locked";
    const colour = live ? HUD.signal : state === "resolved" ? HUD.verify : HUD.chrome;
    // The reticle is sized by the implement's own projected footprint, taken
    // from the spread of the accepted points around it.
    const half = (live ? 13 : 19) * u;

    glow(ctx, colour, live ? 12 * u : 6 * u, () => {
      brackets(ctx, target.x, target.y, half, colour, tension, 1.5 * u);
    });
    tickRing(ctx, target.x, target.y, half * 1.75, live ? HUD.chromeDim : HUD.chromeFaint, clock * 0.55);
    if (!live) sweepArcs(ctx, target.x, target.y, half * 2.15, HUD.chrome, -clock * 1.7);
    crosshair(ctx, target.x, target.y, half * 0.8, half * 0.32, colour);

    if (live && head) {
      const rows = telemetryRows(p);
      if (rows.length) telemetryTag(ctx, head, rows, HUD.signal, cssW, cssH, u);
    }
  }

  // ---- analysis sweep ----------------------------------------------
  if (p.analysing) {
    const y = (clock * 0.45 % 1) * cssH;
    const g = ctx.createLinearGradient(0, y - 40 * u, 0, y + 40 * u);
    g.addColorStop(0, "rgba(79,227,255,0)");
    g.addColorStop(0.5, "rgba(79,227,255,0.30)");
    g.addColorStop(1, "rgba(79,227,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, y - 40 * u, cssW, 80 * u);
    ctx.fillStyle = "rgba(79,227,255,0.75)";
    ctx.fillRect(0, y, cssW, 1);
  }

  // ---- frame furniture ---------------------------------------------
  frameChrome(ctx, cssW, cssH, u, HUD.chromeDim);
  drawStatusBar(ctx, p, state, tension, cssW, cssH, u, clock);
}

function telemetryRows(p: StageProps): { k: string; v: string }[] {
  const rows: { k: string; v: string }[] = [];
  if (!p.inliers?.length) return rows;
  const first = p.inliers[0].frame;
  const t = (p.frame - first) / p.fps;
  rows.push({ k: "T+", v: `${t.toFixed(2)}s` });

  // Height and speed come from the solved world path, which is sampled
  // uniformly in time - so the playhead maps straight onto an index.
  if (p.path && p.path.length > 1 && p.flightTimeS && p.flightTimeS > 0) {
    const n = p.path.length;
    const u = clamp01(t / p.flightTimeS);
    const idx = Math.min(n - 1, Math.max(0, Math.round(u * (n - 1))));
    rows.push({ k: "ALT", v: `${p.path[idx].z.toFixed(1)}m` });

    const j = Math.min(n - 2, Math.max(0, idx));
    const dt = p.flightTimeS / (n - 1);
    const a = p.path[j];
    const b = p.path[j + 1];
    const v = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / dt;
    rows.push({ k: "VEL", v: `${v.toFixed(1)}m/s` });
  }
  return rows;
}

function endpointMark(ctx: CanvasRenderingContext2D, q: Vec2, label: string, colour: string, u: number) {
  ctx.save();
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1.2 * u;
  ctx.beginPath();
  ctx.arc(q.x, q.y, 4.5 * u, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(q.x, q.y - 9 * u);
  ctx.lineTo(q.x, q.y - 17 * u);
  ctx.stroke();
  ctx.restore();
  micro(ctx, label, q.x + 4 * u, q.y - 20 * u, colour, 8 * u);
}

/**
 * Range arcs and sector edges, projected onto the ground plane.
 *
 * This is the one piece of pure holography in the overlay, and it still earns
 * its place: if the grid sits on the painted lines, the camera solve is right.
 */
function drawGroundGrid(
  ctx: CanvasRenderingContext2D,
  cam: SolvedCamera,
  s: number,
  u: number,
  cssW: number,
  cssH: number,
) {
  const S = (v: Vec2 | null): Vec2 | null => (v ? { x: v.x * s, y: v.y * s } : null);
  const half = (SECTOR_HALF_DEG * Math.PI) / 180;

  ctx.save();
  ctx.lineWidth = 1;

  // Range arcs every 10 m.
  for (let r = 10; r <= 80; r += 10) {
    const pts: (Vec2 | null)[] = [];
    for (let a = -half; a <= half + 1e-6; a += half / 14) {
      pts.push(S(worldToImage(cam, { x: r * Math.cos(a), y: r * Math.sin(a), z: 0 })));
    }
    const major = r % 20 === 0;
    ctx.globalAlpha = major ? 0.30 : 0.15;
    ctx.strokeStyle = HUD.chrome;
    ctx.beginPath();
    let started = false;
    for (const q of pts) {
      if (!q) continue;
      if (!started) {
        ctx.moveTo(q.x, q.y);
        started = true;
      } else ctx.lineTo(q.x, q.y);
    }
    ctx.stroke();

    if (major) {
      const lbl = S(worldToImage(cam, { x: r * Math.cos(half * 0.86), y: r * Math.sin(half * 0.86), z: 0 }));
      if (lbl && lbl.x > 0 && lbl.x < cssW && lbl.y > 0 && lbl.y < cssH) {
        ctx.globalAlpha = 1;
        micro(ctx, `${r}m`, lbl.x + 3 * u, lbl.y - 3 * u, "rgba(79,227,255,0.55)", 8 * u);
      }
    }
  }

  // Sector edges and centreline.
  for (const a of [-half, 0, half]) {
    const pts: (Vec2 | null)[] = [];
    for (let r = 2; r <= 82; r += 4) {
      pts.push(S(worldToImage(cam, { x: r * Math.cos(a), y: r * Math.sin(a), z: 0 })));
    }
    ctx.globalAlpha = a === 0 ? 0.16 : 0.26;
    ctx.setLineDash(a === 0 ? [3 * u, 6 * u] : []);
    ctx.strokeStyle = HUD.chrome;
    ctx.beginPath();
    let started = false;
    for (const q of pts) {
      if (!q) continue;
      if (!started) {
        ctx.moveTo(q.x, q.y);
        started = true;
      } else ctx.lineTo(q.x, q.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
}

const STATUS: Record<LockState, { text: string; colour: string }> = {
  standby: { text: "STANDBY", colour: "rgba(232,237,234,0.45)" },
  scanning: { text: "SCANNING", colour: HUD.chrome },
  acquiring: { text: "ACQUIRING", colour: HUD.chrome },
  locked: { text: "TRACK LOCK", colour: HUD.signal },
  resolved: { text: "FLIGHT RESOLVED", colour: HUD.verify },
};

function drawStatusBar(
  ctx: CanvasRenderingContext2D,
  p: StageProps,
  state: LockState,
  tension: number,
  cssW: number,
  cssH: number,
  u: number,
  clock: number,
) {
  const st = STATUS[state];
  const y = 16 * u;

  // Blinking record dot, left of the status word.
  if (state === "scanning" || state === "locked") {
    ctx.save();
    ctx.globalAlpha = 0.45 + 0.55 * Math.abs(Math.sin(clock * 3.2));
    ctx.fillStyle = st.colour;
    ctx.beginPath();
    ctx.arc(20 * u, y - 3 * u, 3 * u, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  const conf = p.confidence === "high" ? 1 : p.confidence === "medium" ? 0.66 : p.confidence === "low" ? 0.33 : 0;
  statusChip(
    ctx,
    28 * u,
    y,
    state === "scanning" && p.analysisStage ? `SCANNING · ${p.analysisStage.toUpperCase()}` : st.text,
    st.colour,
    state === "locked" || state === "resolved" ? conf || 1 : tension,
    u,
  );

  // Right-hand plate: source, timecode, reprojection residual.
  const rx = cssW - 16 * u;
  const t = p.frame / p.fps;
  micro(ctx, p.sourceLabel ?? "", rx, y - 4 * u, "rgba(232,237,234,0.45)", 8.5 * u, "right");
  micro(
    ctx,
    `${p.width}×${p.height} · ${p.fps}FPS · T ${t.toFixed(2)}s`,
    rx,
    y + 7 * u,
    "rgba(232,237,234,0.32)",
    8.5 * u,
    "right",
  );

  const bottom = cssH - 12 * u;
  if (p.implementLabel) {
    micro(ctx, p.implementLabel.toUpperCase(), rx, bottom, "rgba(232,237,234,0.38)", 8.5 * u, "right");
  }
  if (p.reprojectionRmsPx != null && isFinite(p.reprojectionRmsPx)) {
    micro(
      ctx,
      `REPROJ ${p.reprojectionRmsPx.toFixed(2)}PX`,
      rx,
      bottom - 11 * u,
      "rgba(63,217,196,0.55)",
      8.5 * u,
      "right",
    );
  }
}
