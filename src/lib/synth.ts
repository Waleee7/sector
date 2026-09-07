/**
 * SECTOR - synthetic venue.
 *
 * A physically simulated throw, rendered to real pixels, filmed by a real
 * pinhole camera model, with real decoys in shot (the athlete, a bird, a
 * swaying branch, sensor noise).
 *
 * This is not a mock. The demo runs the exact same detector, the exact same
 * RANSAC and the exact same solver that a phone video runs. The difference is
 * that here we know the right answer, so the app can show measured-vs-truth
 * error instead of asking anyone to take its word for it.
 *
 * Frames are generated on demand and never retained - the whole point is that
 * this runs on a laptop with a gigabyte free.
 */

import {
  cross3,
  intrinsicsFromFov,
  mat3Vec,
  norm3,
  scale3,
  sub3,
  type CameraPose,
  type Mat3,
  type Vec2,
  type Vec3,
} from "./geometry";
import {
  airDensity,
  implementById,
  simulateFlight,
  type FlightResult,
  type ReleaseState,
} from "./physics";

export type SynthOptions = {
  width: number;
  height: number;
  fps: number;
  hfovDeg: number;
  implementId: string;
  releaseSpeedMs: number;
  releaseAngleDeg: number;
  releaseHeightM: number;
  attitudeDeg: number;
  headwindMs: number;
  /** Degrees off the sector centreline. */
  deviationDeg: number;
  noise: number;
  seed: number;
  /** Venue air, which sets the density the lift and drag are computed against. */
  altitudeM?: number;
  tempC?: number;
};

export const DEMO_THROW: SynthOptions = {
  width: 640,
  height: 360,
  fps: 50,
  hfovDeg: 60,
  implementId: "discus-1.6",
  releaseSpeedMs: 23.4,
  releaseAngleDeg: 35.5,
  releaseHeightM: 1.62,
  attitudeDeg: 27,
  headwindMs: 3.0,
  deviationDeg: -4.2,
  noise: 5,
  seed: 20260818,
};

export const CIRCLE_CENTRE: Vec2 = { x: 0, y: 0 };
export const CENTRELINE_DEG = 0;
const SECTOR_HALF_DEG = 34.92 / 2;

function lookAt(eye: Vec3, target: Vec3): CameraPose {
  const up: Vec3 = { x: 0, y: 0, z: 1 };
  const fwd = sub3(target, eye);
  const f = scale3(fwd, 1 / norm3(fwd));
  const rRaw = cross3(f, up);
  const r = scale3(rRaw, 1 / norm3(rRaw));
  const d = cross3(f, r);
  // Rows: right, down, forward.
  const R: Mat3 = [r.x, r.y, r.z, d.x, d.y, d.z, f.x, f.y, f.z];
  const Rc = mat3Vec(R, eye);
  return { R, t: { x: -Rc.x, y: -Rc.y, z: -Rc.z } };
}

export type SynthScene = {
  opts: SynthOptions;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  K: Mat3;
  pose: CameraPose;
  /** Ground-truth flight in the vertical plane. */
  flight: FlightResult;
  truth: {
    releaseSpeedMs: number;
    releaseAngleDeg: number;
    releaseHeightM: number;
    carryM: number;
    officialDistanceM: number;
    flightTimeS: number;
    apexM: number;
    deviationDeg: number;
    attitudeDeg: number;
  };
  /** Known ground points and their image projections - the "clicked" calibration. */
  calibration: { image: Vec2; world: Vec2; label: string }[];
  worldAt(t: number): Vec3 | null;
  imageAt(t: number): Vec2 | null;
  renderGray(frame: number): Uint8Array;
};

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 16), 0x85ebca6b);
    t = Math.imul(t ^ (t >>> 13), 0xc2b2ae35);
    return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
  };
}

export function buildScene(o: SynthOptions = DEMO_THROW): SynthScene {
  const spec = implementById(o.implementId);
  const rho = airDensity(o.altitudeM ?? 300, o.tempC ?? 22);
  const release: ReleaseState = {
    speed: o.releaseSpeedMs,
    angleDeg: o.releaseAngleDeg,
    heightM: o.releaseHeightM,
  };
  const flight = simulateFlight(
    release,
    { implement: spec, attitudeDeg: o.attitudeDeg, headwindMs: o.headwindMs, airDensity: rho },
    0.002,
  );

  const bearing = ((CENTRELINE_DEG + o.deviationDeg) * Math.PI) / 180;
  const dirX = Math.cos(bearing);
  const dirY = Math.sin(bearing);
  // Release happens over the front rim with the arm extended, not at the centre
  // of the circle. This matches the anchor the solver extrapolates back to.
  const releaseOffset = 1.25;

  const worldAt = (t: number): Vec3 | null => {
    if (t < 0 || t > flight.flightTimeS) return null;
    const s = sampleFlight(flight, t);
    const d = releaseOffset + s.x;
    return { x: CIRCLE_CENTRE.x + d * dirX, y: CIRCLE_CENTRE.y + d * dirY, z: s.z };
  };

  const landing = worldAt(flight.flightTimeS) as Vec3;
  const radial = Math.hypot(landing.x - CIRCLE_CENTRE.x, landing.y - CIRCLE_CENTRE.y);

  // Camera: side-on, downrange, tripod height. The standard way a coach films.
  // Frame the whole flight plus a margin behind the circle, so the circle - the
  // thing the calibration depends on - is never clipped to the edge.
  const midX = (releaseOffset + flight.rangeM) / 2;
  const standBack = Math.max(52, flight.rangeM * 0.95);
  const eye: Vec3 = {
    x: CIRCLE_CENTRE.x + (midX - 5) * dirX,
    y: CIRCLE_CENTRE.y - standBack,
    z: 2.4,
  };
  const target: Vec3 = { x: CIRCLE_CENTRE.x + (midX - 5) * dirX, y: CIRCLE_CENTRE.y, z: 6.2 };
  const pose = lookAt(eye, target);
  const K = intrinsicsFromFov(o.width, o.height, o.hfovDeg);

  const project = (P: Vec3): Vec2 | null => {
    const c = mat3Vec(pose.R, P);
    const cz = c.z + pose.t.z;
    if (cz <= 0.01) return null;
    const cx = c.x + pose.t.x;
    const cy = c.y + pose.t.y;
    const p = mat3Vec(K, { x: cx, y: cy, z: cz });
    return { x: p.x / p.z, y: p.y / p.z };
  };

  const imageAt = (t: number): Vec2 | null => {
    const P = worldAt(t);
    return P ? project(P) : null;
  };

  // Calibration marks a coach can actually identify on video: the circle rim and
  // the painted sector lines.
  const r = 1.25;
  const calWorld: { world: Vec2; label: string }[] = [
    { world: { x: r, y: 0 }, label: "Circle rim - front" },
    { world: { x: -r, y: 0 }, label: "Circle rim - back" },
    { world: { x: 0, y: r }, label: "Circle rim - left" },
    { world: { x: 0, y: -r }, label: "Circle rim - right" },
  ];
  for (const dist of [35, 55]) {
    for (const sign of [1, -1]) {
      const a = ((CENTRELINE_DEG + sign * SECTOR_HALF_DEG) * Math.PI) / 180;
      calWorld.push({
        world: { x: dist * Math.cos(a), y: dist * Math.sin(a) },
        label: `Sector line ${sign > 0 ? "left" : "right"} @ ${dist} m`,
      });
    }
  }
  const calibration = calWorld
    .map((c) => {
      const img = project({ x: c.world.x, y: c.world.y, z: 0 });
      return img ? { image: img, world: c.world, label: c.label } : null;
    })
    .filter((v): v is { image: Vec2; world: Vec2; label: string } => v !== null);

  // Pre-roll so there is clean background before the implement appears.
  const preRollS = 0.5;
  const frameCount = Math.ceil((flight.flightTimeS + preRollS + 0.25) * o.fps);

  const scene: SynthScene = {
    opts: o,
    width: o.width,
    height: o.height,
    fps: o.fps,
    frameCount,
    K,
    pose,
    flight,
    truth: {
      releaseSpeedMs: o.releaseSpeedMs,
      releaseAngleDeg: o.releaseAngleDeg,
      releaseHeightM: o.releaseHeightM,
      carryM: flight.rangeM + releaseOffset,
      officialDistanceM: radial - 1.25,
      flightTimeS: flight.flightTimeS,
      apexM: flight.apexM,
      deviationDeg: o.deviationDeg,
      attitudeDeg: o.attitudeDeg,
    },
    calibration,
    worldAt: (t) => worldAt(t - preRollS),
    imageAt: (t) => imageAt(t - preRollS),
    renderGray: (frame) => render(frame),
  };

  function render(frame: number): Uint8Array {
    const { width: W, height: H } = o;
    const buf = new Uint8Array(W * H);
    const t = frame / o.fps;
    const rand = rng(o.seed + frame * 7919);

    // Horizon from the camera model: project a distant ground point.
    const far = project({ x: CIRCLE_CENTRE.x + 400 * dirX, y: CIRCLE_CENTRE.y + 400 * dirY, z: 0 });
    const horizonY = far ? Math.max(0, Math.min(H - 1, far.y)) : H * 0.45;

    // Sky: bright at the horizon, deeper overhead, with soft banding so it does
    // not read as one flat slab of grey.
    for (let y = 0; y < horizonY; y++) {
      const f = y / Math.max(1, horizonY);
      const band = Math.sin(f * 7.5) * 3 + Math.sin(f * 2.1 + 1.4) * 5;
      const base = 132 + f * 58 + band;
      for (let x = 0; x < W; x++) buf[y * W + x] = base;
    }
    // Grass: darker than sky, with mowing stripes running downrange. The stripes
    // are static, so the median background model absorbs them completely.
    for (let y = Math.max(0, Math.floor(horizonY)); y < H; y++) {
      const d = (y - horizonY) / Math.max(1, H - horizonY);
      const base = 60 + d * 30;
      for (let x = 0; x < W; x++) {
        const stripe = Math.sin((x / W) * 26 + d * 2.2) > 0 ? 9 : -9;
        buf[y * W + x] = base + stripe * (0.35 + d * 0.65);
      }
    }

    // The stand: pale concrete terracing with dark speckle for the crowd.
    //
    // Pale rather than dark, and the reason is the detector rather than the
    // art direction. A discus renders at luma 22; if the terrace sat at the
    // same tone as the grass the implement would lose contrast every time it
    // crossed the skyline, and detections would drop out at exactly the two
    // moments - release and landing - that the solve leans on hardest.
    //
    // All of it is static, so the median background model subtracts a crowd of
    // ten thousand people to zero and the detector never sees a spectator.
    const standH = H * 0.17;
    const standTop = Math.max(0, horizonY - standH);
    for (let y = Math.floor(standTop); y < horizonY; y++) {
      const f = (y - standTop) / Math.max(1, standH);
      for (let x = 0; x < W; x++) {
        const speck = staticHash(x, y) * 44 - 22;
        // Terrace steps: banding that runs with the rake of the seating.
        const step = Math.sin(f * 26) > 0 ? 5 : -5;
        buf[y * W + x] = Math.max(0, Math.min(255, 100 + f * 14 + step + speck * (0.55 + f * 0.55)));
      }
    }
    // Roof lip along the top of the terrace, and stanchions down its face.
    for (let x = 0; x < W; x++) {
      for (let k = 0; k < 3; k++) {
        const y = Math.floor(standTop) + k;
        if (y >= 0 && y < H) buf[y * W + x] = k === 0 ? 46 : 62;
      }
    }
    for (let x = 0; x < W; x += 34) {
      for (let y = Math.floor(standTop) + 3; y < horizonY; y++) {
        if (y >= 0 && y < H) buf[y * W + x] = 64;
      }
    }
    // Floodlight masts on the skyline. Silhouette only - two dark verticals and
    // a head - but they are what makes a grey band read as a stadium.
    for (const mx of [Math.round(W * 0.17), Math.round(W * 0.81)]) {
      const mastTop = Math.max(0, Math.floor(standTop) - Math.round(H * 0.15));
      for (let y = mastTop; y < standTop; y++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = mx + dx;
          if (x >= 0 && x < W && y >= 0 && y < H) buf[y * W + x] = dx === 0 ? 52 : 84;
        }
      }
      for (let dx = -9; dx <= 9; dx++) {
        for (let dy = 0; dy < 5; dy++) {
          const x = mx + dx;
          const y = mastTop + dy;
          if (x >= 0 && x < W && y >= 0 && y < H) buf[y * W + x] = 196;
        }
      }
    }
    // Rail at the front of the terrace, and its shadow on the grass.
    for (let x = 0; x < W; x++) {
      const yr = Math.floor(horizonY) - 1;
      if (yr >= 0 && yr < H) buf[yr * W + x] = 178;
      const ys = Math.floor(horizonY) + 1;
      if (ys >= 0 && ys < H) buf[ys * W + x] = 40;
    }

    // Painted lines: sector edges and the circle, so the scene is calibratable
    // by eye the way a real venue is.
    for (const sign of [1, -1]) {
      const a = ((CENTRELINE_DEG + sign * SECTOR_HALF_DEG) * Math.PI) / 180;
      let prev: Vec2 | null = null;
      for (let d = 2; d <= 80; d += 1) {
        const q = project({ x: d * Math.cos(a), y: d * Math.sin(a), z: 0 });
        if (prev && q) drawLine(buf, W, H, prev, q, 206, 1);
        prev = q;
      }
    }
    // Distance ticks on the sector lines - a real venue is marked, and they give
    // the eye something to judge scale against.
    for (const sign of [1, -1]) {
      const a = ((CENTRELINE_DEG + sign * SECTOR_HALF_DEG) * Math.PI) / 180;
      for (let d = 10; d <= 70; d += 10) {
        const inner = project({ x: d * Math.cos(a), y: d * Math.sin(a), z: 0 });
        const outer = project({ x: (d + 1.4) * Math.cos(a), y: (d + 1.4) * Math.sin(a), z: 0 });
        if (inner && outer) drawLine(buf, W, H, inner, outer, 214, 1);
      }
    }

    // The circle: a concrete pad with a bright rim, filled from the inside out so
    // the rim stays the brightest thing on the ground.
    for (let rr = r; rr > 0; rr -= 0.12) {
      let prevFill: Vec2 | null = null;
      for (let a = 0; a <= 360; a += 8) {
        const rad = (a * Math.PI) / 180;
        const q = project({ x: rr * Math.cos(rad), y: rr * Math.sin(rad), z: 0 });
        if (prevFill && q) drawLine(buf, W, H, prevFill, q, 126, 1);
        prevFill = q;
      }
    }
    let prevRim: Vec2 | null = null;
    for (let a = 0; a <= 360; a += 4) {
      const rad = (a * Math.PI) / 180;
      const q = project({ x: r * Math.cos(rad), y: r * Math.sin(rad), z: 0 });
      if (prevRim && q) drawLine(buf, W, H, prevRim, q, 236, 1);
      prevRim = q;
    }

    // The cage. Uprights at 7 m on the bearings a real discus cage occupies -
    // wide of the sector, never across it - plus the top cable between them.
    // Static furniture, so the background model absorbs it, but it gives the
    // frame the silhouette anyone who has stood in a ring will recognise.
    const cagePosts: (Vec2 | null)[] = [];
    for (const degOff of [52, 84, 116, 148, -52, -84, -116, -148]) {
      const a = (degOff * Math.PI) / 180;
      const foot = project({ x: 7 * Math.cos(a), y: 7 * Math.sin(a), z: 0 });
      const top = project({ x: 7 * Math.cos(a), y: 7 * Math.sin(a), z: 4.6 });
      if (foot && top) {
        drawLine(buf, W, H, foot, top, 158, 0);
        cagePosts.push(top);
      } else {
        cagePosts.push(null);
      }
    }
    for (let i = 0; i < cagePosts.length - 1; i++) {
      const a = cagePosts[i];
      const b = cagePosts[i + 1];
      // Skip the join that would run straight across the throwing sector.
      if (a && b && Math.abs(a.x - b.x) < W * 0.6) drawLine(buf, W, H, a, b, 132, 0);
    }

    // Athlete: winds up, releases, follows through. Large and non-compact, so
    // mostly filtered by area - but its fragments are honest noise.
    const tt = t - preRollS;
    const phase = Math.max(-0.9, Math.min(0.6, tt));
    const sway = Math.sin(phase * 6.5) * 0.55;
    const stand = project({
      x: CIRCLE_CENTRE.x + (0.2 + sway * 0.35) * dirX + sway * 0.2,
      y: CIRCLE_CENTRE.y + sway * 0.5,
      z: 0.95,
    });
    if (stand) {
      const sc = 1400 / Math.max(4, distanceTo(eye, { x: 0, y: 0, z: 1 }));
      // Torso, head and a swinging arm. Bigger and less compact than the
      // implement, so area rejection removes it - but its edges still produce
      // honest false positives for the trajectory fit to discard.
      fillEllipse(buf, W, H, stand.x, stand.y, sc * 0.0092, sc * 0.026, 30);
      fillEllipse(buf, W, H, stand.x, stand.y - sc * 0.031, sc * 0.0062, sc * 0.0072, 26);
      const armA = { x: stand.x, y: stand.y - sc * 0.012 };
      const armB = {
        x: stand.x + Math.cos(phase * 6.5) * sc * 0.019,
        y: stand.y - sc * 0.012 - Math.sin(phase * 6.5) * sc * 0.012,
      };
      drawLine(buf, W, H, armA, armB, 28, 0);
    }

    // Bird: constant-velocity crosser. Fits a line, never a parabola - it is
    // there to be rejected by the ay > 0 test.
    const birdX = 40 + t * 92;
    const birdY = 40 + Math.sin(t * 3) * 4;
    if (birdX < W - 6) fillEllipse(buf, W, H, birdX, birdY, 3.2, 2.0, 86);

    // Branch: oscillates, so short windows of it genuinely look parabolic.
    const brX = W - 34 + Math.sin(t * 9) * 5;
    const brY = horizonY - 26 + Math.cos(t * 11) * 4;
    fillEllipse(buf, W, H, brX, brY, 3.6, 3.0, 34);

    // The implement.
    const impPos = imageAt(tt);
    if (impPos) {
      const P = worldAt(tt) as Vec3;
      const dist = distanceTo(eye, P);
      // A 1.6 kg discus plate is ~0.21 m across.
      const px = (0.21 * (K[0] as number)) / Math.max(1, dist);
      const rx = Math.max(1.4, px / 2);
      // Motion blur: smear along the image-space velocity.
      const nxt = imageAt(tt + 1 / o.fps);
      const blur = nxt ? Math.hypot(nxt.x - impPos.x, nxt.y - impPos.y) * 0.42 : 0;
      fillEllipse(buf, W, H, impPos.x, impPos.y, rx + blur, Math.max(1.1, rx * 0.55), 22);
    }

    if (o.noise > 0) {
      for (let i = 0; i < buf.length; i++) {
        buf[i] = Math.max(0, Math.min(255, buf[i] + (rand() - 0.5) * 2 * o.noise));
      }
    }

    return buf;
  }

  return scene;
}

/**
 * Position-only hash, deliberately independent of the frame number.
 *
 * Anything textured with this is identical in every frame, which is what makes
 * a crowd of ten thousand people cost the detector nothing: the median
 * background sees the same value every time and subtracts it to zero.
 */
function staticHash(x: number, y: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function distanceTo(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Linear interpolation into the RK4 sample list. */
function sampleFlight(f: FlightResult, t: number): { x: number; z: number } {
  const s = f.samples;
  if (t <= s[0].t) return { x: s[0].x, z: s[0].z };
  const lastS = s[s.length - 1];
  if (t >= lastS.t) return { x: lastS.x, z: lastS.z };
  let lo = 0;
  let hi = s.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = s[lo];
  const b = s[hi];
  const u = (t - a.t) / Math.max(1e-9, b.t - a.t);
  return { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u };
}

function fillEllipse(
  buf: Uint8Array,
  W: number,
  H: number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  value: number,
): void {
  const x0 = Math.max(0, Math.floor(cx - rx));
  const x1 = Math.min(W - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(H - 1, Math.ceil(cy + ry));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x - cx) / Math.max(0.001, rx);
      const dy = (y - cy) / Math.max(0.001, ry);
      if (dx * dx + dy * dy <= 1) buf[y * W + x] = value;
    }
  }
}

function drawLine(
  buf: Uint8Array,
  W: number,
  H: number,
  a: Vec2,
  b: Vec2,
  value: number,
  thickness: number,
): void {
  const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y));
  for (let i = 0; i <= steps; i++) {
    const u = steps === 0 ? 0 : i / steps;
    const x = Math.round(a.x + (b.x - a.x) * u);
    const y = Math.round(a.y + (b.y - a.y) * u);
    for (let dy = -thickness; dy <= thickness; dy++) {
      for (let dx = -thickness; dx <= thickness; dx++) {
        const px = x + dx;
        const py = y + dy;
        if (px >= 0 && px < W && py >= 0 && py < H) buf[py * W + px] = value;
      }
    }
  }
}

/** Expand a luma buffer to RGBA for canvas display. */
export function grayToRGBA(gray: Uint8Array, out?: Uint8ClampedArray): Uint8ClampedArray {
  const rgba = out ?? new Uint8ClampedArray(gray.length * 4);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    const v = gray[i];
    rgba[p] = v;
    rgba[p + 1] = v;
    rgba[p + 2] = v;
    rgba[p + 3] = 255;
  }
  return rgba;
}
