"use client";

/**
 * The video stage.
 *
 * Two colours carry the whole story: orange is what the system SAW in pixels
 * (candidate blobs, the frames it accepted onto the arc), teal is what the
 * system SOLVED in metres (the fitted flight, projected back onto the image).
 * When the teal line lies on top of the orange dots, the solve is honest - and
 * when it does not, you can see that too.
 */

import { useEffect, useRef } from "react";
import { grayToRGBA } from "@/lib/synth";
import { worldToImage, type SolvedCamera } from "@/lib/solve";
import type { Vec2, Vec3 } from "@/lib/geometry";

export type StageProps = {
  width: number;
  height: number;
  frame: number;
  getGray: (i: number) => Uint8Array | null;
  blobs: { frame: number; points: Vec2[] }[] | null;
  inliers: { frame: number; x: number; y: number }[] | null;
  camera: SolvedCamera | null;
  path: Vec3[] | null;
  releaseWorld: Vec3 | null;
  landingWorld: Vec3 | null;
  showDetections: boolean;
  calibrationPoints?: Vec2[];
  onPick?: (p: Vec2) => void;
};

export default function Stage(props: StageProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<ImageData | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { width: W, height: H } = props;
    canvas.width = W;
    canvas.height = H;

    const gray = props.getGray(props.frame);
    if (gray && gray.length === W * H) {
      // Reuse one ImageData and write luma straight into its buffer - a fresh
      // allocation per frame is what makes canvas playback stutter.
      if (!imgRef.current || imgRef.current.width !== W || imgRef.current.height !== H) {
        imgRef.current = ctx.createImageData(W, H);
      }
      grayToRGBA(gray, imgRef.current.data);
      ctx.putImageData(imgRef.current, 0, 0);
    } else {
      ctx.fillStyle = "#0b0f12";
      ctx.fillRect(0, 0, W, H);
    }

    // Cool the footage slightly so the overlay colours separate from it.
    ctx.fillStyle = "rgba(8, 16, 22, 0.30)";
    ctx.fillRect(0, 0, W, H);

    // --- candidate blobs: everything the detector coughed up ---------
    if (props.showDetections && props.blobs) {
      const f = props.blobs.find((b) => b.frame === props.frame);
      if (f) {
        ctx.strokeStyle = "rgba(255, 107, 26, 0.55)";
        ctx.lineWidth = 1;
        for (const p of f.points) {
          ctx.strokeRect(p.x - 5, p.y - 5, 10, 10);
        }
      }
    }

    // --- accepted arc points, drawn as a fading tail ------------------
    if (props.inliers && props.inliers.length) {
      const past = props.inliers.filter((p) => p.frame <= props.frame);
      for (let i = 0; i < past.length; i++) {
        const age = (past.length - i) / Math.max(1, past.length);
        ctx.fillStyle = `rgba(255, 107, 26, ${(0.95 - age * 0.75).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(past[i].x, past[i].y, 2.1, 0, Math.PI * 2);
        ctx.fill();
      }
      const head = past[past.length - 1];
      if (head) {
        ctx.strokeStyle = "rgba(255, 107, 26, 0.9)";
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(head.x, head.y, 8, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // --- the solved flight, projected back onto the image -------------
    if (props.camera && props.path && props.path.length > 1) {
      const cam = props.camera;
      ctx.strokeStyle = "rgba(63, 217, 196, 0.85)";
      ctx.lineWidth = 1.6;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      let started = false;
      for (const P of props.path) {
        const q = worldToImage(cam, P);
        if (!q) continue;
        if (!started) {
          ctx.moveTo(q.x, q.y);
          started = true;
        } else {
          ctx.lineTo(q.x, q.y);
        }
      }
      ctx.stroke();
      ctx.setLineDash([]);

      marker(ctx, cam, props.releaseWorld, "RELEASE", "#3fd9c4");
      marker(ctx, cam, props.landingWorld, "LANDING", "#3fd9c4");
    }

    // --- calibration marks -------------------------------------------
    if (props.calibrationPoints) {
      props.calibrationPoints.forEach((p, i) => {
        ctx.strokeStyle = "#ffc53d";
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(p.x - 7, p.y);
        ctx.lineTo(p.x + 7, p.y);
        ctx.moveTo(p.x, p.y - 7);
        ctx.lineTo(p.x, p.y + 7);
        ctx.stroke();
        ctx.fillStyle = "#ffc53d";
        ctx.font = "600 9px ui-monospace, monospace";
        ctx.fillText(String(i + 1), p.x + 9, p.y - 8);
      });
    }
  }, [props]);

  return (
    <canvas
      ref={ref}
      onClick={
        props.onPick
          ? (e) => {
              const c = ref.current;
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
        height: "auto",
        borderRadius: 10,
        cursor: props.onPick ? "crosshair" : "default",
        imageRendering: "auto",
      }}
    />
  );
}

function marker(
  ctx: CanvasRenderingContext2D,
  cam: SolvedCamera,
  P: Vec3 | null,
  label: string,
  colour: string,
) {
  if (!P) return;
  const q = worldToImage(cam, P);
  if (!q) return;
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.arc(q.x, q.y, 5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(q.x, q.y - 10);
  ctx.lineTo(q.x, q.y - 18);
  ctx.stroke();
  ctx.fillStyle = colour;
  ctx.font = "600 8px ui-monospace, monospace";
  ctx.letterSpacing = "1px";
  ctx.fillText(label, q.x + 4, q.y - 20);
}
