/**
 * SECTOR - HUD primitives.
 *
 * Canvas drawing for the tracking overlay, kept separate from React so the
 * whole overlay is one pure function of (frame, analysis) and can be reasoned
 * about without a component in the way.
 *
 * Two rules run through all of it:
 *
 *   1. Colour carries meaning. Amber is what the system SAW in pixels. Cyan is
 *      what the system SOLVED in metres. Red is what it THREW OUT. Gold is what
 *      a human clicked. Nothing is coloured for decoration.
 *
 *   2. Every mark is anchored to a real quantity. The reticle is sized by the
 *      implement's projected diameter, the lead line by its image velocity, the
 *      grid by the solved camera. There is no ornament that would still draw if
 *      the solve were wrong - which is what makes the overlay a diagnostic
 *      rather than a skin.
 */

import type { Vec2 } from "./geometry";

export const HUD = {
  chrome: "#4fe3ff",
  chromeDim: "rgba(79, 227, 255, 0.30)",
  chromeFaint: "rgba(79, 227, 255, 0.12)",
  signal: "#ff7a18",
  verify: "#3fd9c4",
  reject: "#ff4d5e",
  gold: "#ffc53d",
  chalk: "#e8edea",
} as const;

export type LockState =
  | "standby"
  | "scanning"
  | "acquiring"
  | "locked"
  | "resolved"
  | "unverified";

export const MONO = "ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, monospace";

/** Enable additive glow for a block of drawing, then restore. */
export function glow(ctx: CanvasRenderingContext2D, colour: string, blur: number, fn: () => void) {
  ctx.save();
  ctx.shadowColor = colour;
  ctx.shadowBlur = blur;
  fn();
  ctx.restore();
}

export function micro(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  colour: string,
  size = 9,
  align: CanvasTextAlign = "left",
) {
  ctx.save();
  ctx.font = `600 ${size}px ${MONO}`;
  ctx.fillStyle = colour;
  ctx.textAlign = align;
  ctx.letterSpacing = "0.09em";
  ctx.fillText(text, x, y);
  ctx.restore();
}

/**
 * Four corner brackets around a box, with a gap in the middle of each edge.
 *
 * `tension` in [0,1] closes the brackets as the tracker gains confidence: an
 * open bracket reads as searching, a tight one as locked, and the transition
 * between them is the only animation on screen that is not driven by the
 * footage itself.
 */
export function brackets(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  half: number,
  colour: string,
  tension: number,
  lineWidth = 1.4,
) {
  const arm = half * (0.30 + 0.34 * (1 - tension));
  const off = half * (1 + 0.55 * (1 - tension));
  ctx.save();
  ctx.strokeStyle = colour;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "square";
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const) {
    const x = cx + sx * off;
    const y = cy + sy * off;
    ctx.beginPath();
    ctx.moveTo(x, y + sy * -arm);
    ctx.lineTo(x, y);
    ctx.lineTo(x + sx * -arm, y);
    ctx.stroke();
  }
  ctx.restore();
}

/** A ring of tick marks, rotating with `phase`. Reads as an active sensor. */
export function tickRing(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  colour: string,
  phase: number,
  count = 24,
) {
  ctx.save();
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1;
  for (let i = 0; i < count; i++) {
    const a = phase + (i / count) * Math.PI * 2;
    // Every sixth tick is long: it gives the ring a readable rotation rate.
    const len = i % 6 === 0 ? radius * 0.22 : radius * 0.1;
    const c = Math.cos(a);
    const s = Math.sin(a);
    ctx.beginPath();
    ctx.moveTo(cx + c * radius, cy + s * radius);
    ctx.lineTo(cx + c * (radius + len), cy + s * (radius + len));
    ctx.stroke();
  }
  ctx.restore();
}

/** Two opposed arcs sweeping around the reticle while acquiring. */
export function sweepArcs(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  colour: string,
  phase: number,
) {
  ctx.save();
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1.6;
  ctx.lineCap = "round";
  for (const base of [0, Math.PI]) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius, base + phase, base + phase + 0.78);
    ctx.stroke();
  }
  ctx.restore();
}

/** Crosshair with a hole in the middle, so it never hides the thing it marks. */
export function crosshair(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  reach: number,
  hole: number,
  colour: string,
) {
  ctx.save();
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx - reach, cy);
  ctx.lineTo(cx - hole, cy);
  ctx.moveTo(cx + hole, cy);
  ctx.lineTo(cx + reach, cy);
  ctx.moveTo(cx, cy - reach);
  ctx.lineTo(cx, cy - hole);
  ctx.moveTo(cx, cy + hole);
  ctx.lineTo(cx, cy + reach);
  ctx.stroke();
  ctx.restore();
}

/**
 * Leader line from the tracked point to a telemetry block.
 *
 * The elbow flips to whichever side has room, so the readout never runs off
 * the frame when the implement is near an edge.
 */
export function telemetryTag(
  ctx: CanvasRenderingContext2D,
  anchor: Vec2,
  rows: { k: string; v: string }[],
  colour: string,
  frameW: number,
  frameH: number,
  scale: number,
) {
  const padX = 7 * scale;
  const rowH = 12 * scale;
  const boxW = 92 * scale;
  const boxH = rows.length * rowH + padX;
  const flipX = anchor.x > frameW * 0.6 ? -1 : 1;
  const flipY = anchor.y < frameH * 0.42 ? 1 : -1;

  const elbowX = anchor.x + flipX * 22 * scale;
  const elbowY = anchor.y + flipY * 20 * scale;
  const boxX = flipX > 0 ? elbowX + 8 * scale : elbowX - 8 * scale - boxW;
  const boxY = flipY > 0 ? elbowY : elbowY - boxH;

  ctx.save();
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  ctx.moveTo(anchor.x + flipX * 9 * scale, anchor.y + flipY * 9 * scale);
  ctx.lineTo(elbowX, elbowY);
  ctx.lineTo(flipX > 0 ? boxX : boxX + boxW, elbowY);
  ctx.stroke();

  ctx.globalAlpha = 1;
  ctx.fillStyle = "rgba(4, 10, 16, 0.82)";
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.globalAlpha = 0.55;
  ctx.strokeRect(boxX, boxY, boxW, boxH);
  ctx.globalAlpha = 1;

  // A short accent rule on the leading edge, so the block reads as attached.
  ctx.fillStyle = colour;
  ctx.fillRect(flipX > 0 ? boxX : boxX + boxW - 2 * scale, boxY, 2 * scale, boxH);

  rows.forEach((r, i) => {
    const y = boxY + padX + i * rowH + 1 * scale;
    micro(ctx, r.k, boxX + padX + 2 * scale, y, "rgba(232,237,234,0.50)", 8 * scale);
    micro(ctx, r.v, boxX + boxW - padX, y, colour, 9.5 * scale, "right");
  });
  ctx.restore();
}

/** Dashed polyline through projected points, skipping nulls. */
export function dashedPath(
  ctx: CanvasRenderingContext2D,
  pts: (Vec2 | null)[],
  colour: string,
  width: number,
  dash: number[],
  alpha = 1,
) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.lineJoin = "round";
  ctx.beginPath();
  let started = false;
  for (const p of pts) {
    if (!p) continue;
    if (!started) {
      ctx.moveTo(p.x, p.y);
      started = true;
    } else ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
  ctx.restore();
}

/** A candidate the physics gate discarded. Small, dim, and crossed out. */
export function rejectMark(ctx: CanvasRenderingContext2D, p: Vec2, s: number, alpha: number) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = HUD.reject;
  ctx.lineWidth = 1;
  ctx.strokeRect(p.x - s, p.y - s, s * 2, s * 2);
  ctx.beginPath();
  ctx.moveTo(p.x - s * 0.55, p.y - s * 0.55);
  ctx.lineTo(p.x + s * 0.55, p.y + s * 0.55);
  ctx.moveTo(p.x + s * 0.55, p.y - s * 0.55);
  ctx.lineTo(p.x - s * 0.55, p.y + s * 0.55);
  ctx.stroke();
  ctx.restore();
}

/** Expanding ring, used once at release and once at landing. */
export function pulse(
  ctx: CanvasRenderingContext2D,
  p: Vec2,
  t: number,
  colour: string,
  maxR: number,
) {
  if (t < 0 || t > 1) return;
  ctx.save();
  ctx.globalAlpha = (1 - t) * 0.8;
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1.6 * (1 - t) + 0.4;
  ctx.beginPath();
  ctx.arc(p.x, p.y, maxR * t, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/** Frame furniture: corner ticks and an edge scale. Pure chrome, no data. */
export function frameChrome(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  scale: number,
  colour: string,
) {
  const m = 6 * scale;
  const arm = 13 * scale;
  ctx.save();
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1;
  for (const [sx, sy] of [
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
  ] as const) {
    const x = sx > 0 ? m : W - m;
    const y = sy > 0 ? m : H - m;
    ctx.beginPath();
    ctx.moveTo(x, y + sy * arm);
    ctx.lineTo(x, y);
    ctx.lineTo(x + sx * arm, y);
    ctx.stroke();
  }
  // Edge scale down the left, purely to give the frame a measured feel.
  ctx.globalAlpha = 0.5;
  for (let i = 0; i <= 10; i++) {
    const y = m + ((H - m * 2) * i) / 10;
    const len = i % 5 === 0 ? 7 * scale : 3.5 * scale;
    ctx.beginPath();
    ctx.moveTo(m, y);
    ctx.lineTo(m + len, y);
    ctx.stroke();
  }
  ctx.restore();
}

/** Horizontal scanline wash. Cheap, and it sells the sensor-feed read. */
export function scanlines(ctx: CanvasRenderingContext2D, W: number, H: number, scale: number) {
  ctx.save();
  ctx.globalAlpha = 0.055;
  ctx.fillStyle = "#000";
  const step = Math.max(2, Math.round(2 * scale));
  for (let y = 0; y < H; y += step * 2) ctx.fillRect(0, y, W, step);
  ctx.restore();
}

/** Corner-darkening, so the eye goes to the middle where the flight is. */
export function vignette(ctx: CanvasRenderingContext2D, W: number, H: number) {
  const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.75);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,0.38)");
  ctx.save();
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

/** Status word plus a segmented confidence bar. */
export function statusChip(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  label: string,
  colour: string,
  filled: number,
  scale: number,
  segments = 10,
) {
  micro(ctx, label, x, y, colour, 9.5 * scale);
  const barY = y + 5 * scale;
  const segW = 4.5 * scale;
  const gap = 2 * scale;
  ctx.save();
  for (let i = 0; i < segments; i++) {
    const on = i / segments < filled;
    ctx.fillStyle = on ? colour : "rgba(232,237,234,0.14)";
    ctx.globalAlpha = on ? 1 : 0.7;
    ctx.fillRect(x + i * (segW + gap), barY, segW, 3 * scale);
  }
  ctx.restore();
}
