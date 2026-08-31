/**
 * SECTOR - aerodynamic flight fit.
 *
 * Why this file exists, in one number: a 1.6 kg discus released at 23.4 m/s and
 * 35.5 degrees from 1.62 m carries 69 m and hangs for 4.04 s. The SAME release
 * as a pure parabola carries 55 m and hangs for 2.89 s.
 *
 * So when you fit a parabola to a real discus flight, the optimiser cannot
 * change physics - it changes the answer. It inflates release speed and pushes
 * the trajectory further away until a parabola happens to project onto the
 * observed image curve. In testing, that produced 34.9 m/s and 100 m for a throw
 * that was actually 23.4 m/s and 68 m, with a perfectly respectable 1.6 px
 * reprojection residual. A tight image fit and a completely wrong measurement.
 *
 * That is the trap every naive tracker falls into, and it is precisely the thing
 * SECTOR is supposed to get right. So the final solve integrates the real
 * lifting flight and fits release state AND plate attitude to the observed
 * pixels.
 */

import { projectPoint, type Vec3 } from "./geometry";
import {
  flightAccel,
  sampleFlightAt,
  simulateFlight,
  type State,
  type AeroParams,
  type FlightResult,
  type ImplementSpec,
  type ReleaseState,
} from "./physics";
import type { TrackPoint } from "./track";
import type { SolvedCamera } from "./solve";

/** [x0, y0, z0, vx, vy, vz, attitudeDeg] */
export type AeroFlightParams = number[];

export type AeroFit = {
  params: AeroFlightParams;
  rms: number;
  flight: FlightResult;
  release: ReleaseState;
  headingRad: number;
  /** World path from release to ground contact. */
  path: Vec3[];
  landing: Vec3;
  carryM: number;
  flightTimeS: number;
  apexM: number;
  attitudeDeg: number;
};

export type AeroContext = {
  implement: ImplementSpec;
  headwindMs: number;
  airDensity: number;
};

export type ReleasePoint = {
  world: Vec3;
  speed: number;
  angleDeg: number;
  /** Seconds between release and the first frame the detector caught. */
  leadTimeS: number;
};

/**
 * Walk the flight backwards to the actual release.
 *
 * The fit is anchored at the FIRST FRAME THE DETECTOR SAW, which is not the
 * release - on real footage the implement is often already several metres up
 * before it separates from the athlete against the background. Reporting the
 * fitted state as "release" would overstate release height and understate
 * release speed by however long that gap happens to be.
 *
 * So integrate the same dynamics backwards until the flight is at its closest
 * horizontal approach to the circle. That is a defined, calibrated location
 * rather than a guess, and it is where the implement actually left the hand.
 */
export function extrapolateToRelease(
  fit: AeroFit,
  ctx: AeroContext,
  circleCentre: { x: number; y: number },
  circleRadius: number,
): ReleasePoint {
  const aero = {
    implement: ctx.implement,
    attitudeDeg: fit.attitudeDeg,
    headwindMs: ctx.headwindMs,
    airDensity: ctx.airDensity,
  };

  const ux = Math.cos(fit.headingRad);
  const uy = Math.sin(fit.headingRad);
  // Signed distance along the heading, measured from the circle centre.
  const along = (fit.params[0] - circleCentre.x) * ux + (fit.params[1] - circleCentre.y) * uy;

  let st: State = {
    x: along,
    z: fit.params[2],
    vx: fit.params[3] * ux + fit.params[4] * uy,
    vz: fit.params[5],
  };

  // Release is taken at the front rim of the circle. An athlete releases with the
  // arm extended over the front of the circle, so the rim is both the closest
  // defensible landmark and one the calibration already knows the position of.
  const target = circleRadius;
  const dt = -0.002;
  let best = { st, t: 0, d: Math.abs(st.x - target) };

  for (let i = 0; i < 400; i++) {
    const next = step(st, aero, dt);
    // Never walk back below a plausible release height - past that the
    // extrapolation has left the throw and is inventing history.
    if (next.z < 0.9) break;
    st = next;
    const d = Math.abs(st.x - target);
    const t = (i + 1) * dt;
    if (d < best.d) best = { st, t, d };
    if (st.x < target - 0.2) break;
  }

  const r = best.st;
  return {
    world: {
      x: circleCentre.x + r.x * ux,
      y: circleCentre.y + r.x * uy,
      z: r.z,
    },
    speed: Math.hypot(r.vx, r.vz),
    angleDeg: (Math.atan2(r.vz, r.vx) * 180) / Math.PI,
    leadTimeS: -best.t,
  };
}

function step(s: State, p: AeroParams, dt: number): State {
  const d = (st: State) => {
    const a = flightAccel(st, p);
    return { x: st.vx, z: st.vz, vx: a.ax, vz: a.az };
  };
  const add = (st: State, k: State, f: number): State => ({
    x: st.x + k.x * f,
    z: st.z + k.z * f,
    vx: st.vx + k.vx * f,
    vz: st.vz + k.vz * f,
  });
  const k1 = d(s);
  const k2 = d(add(s, k1, dt / 2));
  const k3 = d(add(s, k2, dt / 2));
  const k4 = d(add(s, k3, dt));
  return {
    x: s.x + (dt / 6) * (k1.x + 2 * k2.x + 2 * k3.x + k4.x),
    z: s.z + (dt / 6) * (k1.z + 2 * k2.z + 2 * k3.z + k4.z),
    vx: s.vx + (dt / 6) * (k1.vx + 2 * k2.vx + 2 * k3.vx + k4.vx),
    vz: s.vz + (dt / 6) * (k1.vz + 2 * k2.vz + 2 * k3.vz + k4.vz),
  };
}

function toRelease(p: AeroFlightParams): { release: ReleaseState; headingRad: number } {
  const vh = Math.hypot(p[3], p[4]);
  const speed = Math.hypot(vh, p[5]);
  return {
    release: {
      speed,
      angleDeg: (Math.atan2(p[5], vh) * 180) / Math.PI,
      heightM: p[2],
    },
    headingRad: Math.atan2(p[4], p[3]),
  };
}

function simulate(p: AeroFlightParams, ctx: AeroContext, dt: number): FlightResult {
  const { release } = toRelease(p);
  const aero: AeroParams = {
    implement: ctx.implement,
    attitudeDeg: p[6],
    headwindMs: ctx.headwindMs,
    airDensity: ctx.airDensity,
  };
  return simulateFlight(release, aero, dt);
}

function worldAt(
  p: AeroFlightParams,
  flight: FlightResult,
  headingRad: number,
  t: number,
): Vec3 {
  const s = sampleFlightAt(flight, t);
  return {
    x: p[0] + s.x * Math.cos(headingRad),
    y: p[1] + s.x * Math.sin(headingRad),
    z: s.z,
  };
}

function residuals(
  p: AeroFlightParams,
  pts: TrackPoint[],
  t0: number,
  cam: SolvedCamera,
  ctx: AeroContext,
  dt: number,
): number[] {
  const flight = simulate(p, ctx, dt);
  const { headingRad } = toRelease(p);
  const out: number[] = [];
  for (const obs of pts) {
    const P = worldAt(p, flight, headingRad, obs.t - t0);
    const q = projectPoint(cam.K, cam.pose, P);
    if (!q) {
      out.push(1e4, 1e4);
      continue;
    }
    out.push(q.x - obs.x, q.y - obs.y);
  }
  return out;
}

function sumSq(v: number[]): number {
  let s = 0;
  for (const x of v) s += x * x;
  return s;
}

function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-14) return null;
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
  return M.map((row, i) => row[n] / row[i]);
}

/**
 * Levenberg-Marquardt over the aerodynamic model.
 *
 * Attitude is frozen for non-aero implements (a shot has no angle of attack), so
 * the problem drops to six parameters and runs correspondingly faster.
 */
function lm(
  init: AeroFlightParams,
  pts: TrackPoint[],
  t0: number,
  cam: SolvedCamera,
  ctx: AeroContext,
  iterations: number,
  dt: number,
): { params: AeroFlightParams; cost: number } {
  const free = ctx.implement.aero ? 7 : 6;
  const step = [2e-3, 2e-3, 2e-3, 3e-3, 3e-3, 3e-3, 0.05];

  let params = [...init];
  let lambda = 1e-2;
  let res = residuals(params, pts, t0, cam, ctx, dt);
  let cost = sumSq(res);

  for (let iter = 0; iter < iterations; iter++) {
    const m = res.length;
    const J: number[][] = Array.from({ length: m }, () => new Array(free).fill(0));

    for (let j = 0; j < free; j++) {
      const up = [...params];
      const dn = [...params];
      up[j] += step[j];
      dn[j] -= step[j];
      const ru = residuals(up, pts, t0, cam, ctx, dt);
      const rd = residuals(dn, pts, t0, cam, ctx, dt);
      for (let i = 0; i < m; i++) J[i][j] = (ru[i] - rd[i]) / (2 * step[j]);
    }

    const JtJ: number[][] = Array.from({ length: free }, () => new Array(free).fill(0));
    const Jtr: number[] = new Array(free).fill(0);
    for (let i = 0; i < m; i++) {
      for (let a = 0; a < free; a++) {
        Jtr[a] += J[i][a] * res[i];
        for (let b = 0; b < free; b++) JtJ[a][b] += J[i][a] * J[i][b];
      }
    }

    let improved = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      const A = JtJ.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) : v)));
      const delta = solve(
        A,
        Jtr.map((v) => -v),
      );
      if (!delta) {
        lambda *= 10;
        continue;
      }
      const trial = [...params];
      for (let j = 0; j < free; j++) trial[j] += delta[j];
      // Keep attitude physical: a plate past +/-60 deg is not a throw.
      if (free === 7) trial[6] = Math.max(-30, Math.min(60, trial[6]));

      const rTrial = residuals(trial, pts, t0, cam, ctx, dt);
      const cTrial = sumSq(rTrial);
      if (cTrial < cost) {
        params = trial;
        res = rTrial;
        cost = cTrial;
        lambda = Math.max(1e-9, lambda / 3);
        improved = true;
        break;
      }
      lambda *= 10;
    }
    if (!improved) break;
  }

  return { params, cost };
}

/**
 * Fit the lifting flight.
 *
 * The ballistic solution is a poor starting point for an aero implement - it is
 * wrong by 50% on speed, in a known direction - so we multi-start across a small
 * spread of velocity scalings and initial attitudes and keep the best basin. The
 * coarse pass uses a large integration step; the winner is polished at full
 * resolution.
 */
export function fitAeroFlight(
  ballistic: number[],
  pts: TrackPoint[],
  t0: number,
  cam: SolvedCamera,
  ctx: AeroContext,
): AeroFit | null {
  if (pts.length < 4) return null;

  const attitudes = ctx.implement.aero ? [14, 30] : [0];
  const scales = ctx.implement.aero ? [0.62, 0.8, 1.0] : [1.0];

  let best: { params: AeroFlightParams; cost: number } | null = null;

  for (const att of attitudes) {
    for (const scale of scales) {
      const init: AeroFlightParams = [
        ballistic[0],
        ballistic[1],
        ballistic[2],
        ballistic[3] * scale,
        ballistic[4] * scale,
        ballistic[5] * scale,
        att,
      ];
      const out = lm(init, pts, t0, cam, ctx, 26, 0.01);
      if (!best || out.cost < best.cost) best = out;
    }
  }
  if (!best) return null;

  // Polish the winning basin at full integration resolution.
  const polished = lm(best.params, pts, t0, cam, ctx, 40, 0.003);
  const params = polished.cost < best.cost ? polished.params : best.params;

  const flight = simulate(params, ctx, 0.002);
  const { release, headingRad } = toRelease(params);

  const path: Vec3[] = [];
  const steps = 96;
  for (let i = 0; i <= steps; i++) {
    path.push(worldAt(params, flight, headingRad, (flight.flightTimeS * i) / steps));
  }
  const landing = path[path.length - 1];

  const finalRes = residuals(params, pts, t0, cam, ctx, 0.003);
  const rms = Math.sqrt(sumSq(finalRes) / Math.max(1, finalRes.length / 2));

  return {
    params,
    rms,
    flight,
    release,
    headingRad,
    path,
    landing,
    carryM: Math.hypot(landing.x - params[0], landing.y - params[1]),
    flightTimeS: flight.flightTimeS,
    apexM: flight.apexM,
    attitudeDeg: params[6],
  };
}
