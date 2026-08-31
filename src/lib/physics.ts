/**
 * SECTOR - flight physics.
 *
 * Shot and hammer are effectively ballistic: a 7.26 kg sphere barely notices the
 * air. Discus and javelin are not projectiles at all - they are airfoils. A
 * discus generates lift, has an angle of attack, stalls, and (the famous
 * counter-intuitive result) flies FURTHER into a headwind, because what matters
 * is airspeed over the plate, not groundspeed.
 *
 * A naive parabola fit is therefore wrong by metres on a discus. This module
 * carries both models so the difference between them can be reported as a
 * coaching number rather than hidden as an error.
 */

import type { Vec2 } from "./geometry";

export const G = 9.80665;
/** Sea-level air density at 15 C, kg/m^3. */
export const RHO_SEA_LEVEL = 1.225;

export type ImplementSpec = {
  id: string;
  label: string;
  massKg: number;
  /** Reference area for aero, m^2. Zero means "treat as ballistic". */
  areaM2: number;
  aero: boolean;
  circle: "discus" | "shot" | "hammer" | "weight" | "javelin";
};

/**
 * Competition implements. Discus plate diameters per World Athletics Rule 32:
 * 219-221 mm for the 2 kg, 180-182 mm for the 1 kg. High school boys in the US
 * throw the 1.6 kg.
 */
export const IMPLEMENTS: ImplementSpec[] = [
  { id: "discus-2.0", label: "Discus 2.0 kg (senior men)", massKg: 2.0, areaM2: 0.0380, aero: true, circle: "discus" },
  { id: "discus-1.6", label: "Discus 1.6 kg (HS boys)", massKg: 1.6, areaM2: 0.0346, aero: true, circle: "discus" },
  { id: "discus-1.0", label: "Discus 1.0 kg (women)", massKg: 1.0, areaM2: 0.0256, aero: true, circle: "discus" },
  { id: "shot-7.26", label: "Shot 7.26 kg (senior men)", massKg: 7.26, areaM2: 0.0113, aero: false, circle: "shot" },
  { id: "shot-5.44", label: "Shot 12 lb (HS boys)", massKg: 5.44, areaM2: 0.0095, aero: false, circle: "shot" },
  { id: "shot-4.0", label: "Shot 4.0 kg (women)", massKg: 4.0, areaM2: 0.0079, aero: false, circle: "shot" },
  { id: "hammer-7.26", label: "Hammer 7.26 kg", massKg: 7.26, areaM2: 0.0113, aero: false, circle: "hammer" },
  { id: "javelin-0.8", label: "Javelin 800 g", massKg: 0.8, areaM2: 0.0050, aero: true, circle: "javelin" },
];

export function implementById(id: string): ImplementSpec {
  return IMPLEMENTS.find((i) => i.id === id) ?? IMPLEMENTS[0];
}

/* ------------------------------------------------------------------ *
 * Discus aerodynamics
 * ------------------------------------------------------------------ */

/**
 * Lift coefficient vs angle of attack, radians.
 *
 * Ganslen-style approximation with endpoints matched to published wind-tunnel
 * values: CL peaks near +/-0.9 to 1.0 around 27-30 deg and falls away past
 * stall. Not a substitute for a real polar - it is a defensible first model and
 * every coefficient here is meant to be re-fit against measured throws.
 */
export function liftCoefficient(alphaRad: number): number {
  const a = clampAlpha(alphaRad);
  return 1.05 * Math.sin(2 * a);
}

/**
 * Drag coefficient vs angle of attack, radians.
 * CD ~ 0.06 edge-on, ~1.1 broadside, which brackets the published range.
 */
export function dragCoefficient(alphaRad: number): number {
  const a = clampAlpha(alphaRad);
  return 0.06 + 1.05 * ((1 - Math.cos(2 * a)) / 2);
}

function clampAlpha(alphaRad: number): number {
  // Fold into [-pi/2, pi/2]; a plate is symmetric front-to-back.
  let a = alphaRad;
  while (a > Math.PI / 2) a -= Math.PI;
  while (a < -Math.PI / 2) a += Math.PI;
  return a;
}

/* ------------------------------------------------------------------ *
 * Vacuum ballistics - closed form, no iteration
 * ------------------------------------------------------------------ */

export type ReleaseState = {
  /** Horizontal distance from the release point, metres. */
  speed: number;
  /** Degrees above horizontal. */
  angleDeg: number;
  /** Metres above the ground plane. */
  heightM: number;
};

/**
 * Given release point, landing point and flight time, the release velocity is
 * fully determined under gravity alone. This is the anchor solve: no optimiser,
 * no initial guess, no way for it to quietly diverge.
 */
export function releaseFromEndpoints(
  releaseHeightM: number,
  horizontalRangeM: number,
  flightTimeS: number,
): ReleaseState {
  const vx = horizontalRangeM / flightTimeS;
  const vz = (0 - releaseHeightM) / flightTimeS + 0.5 * G * flightTimeS;
  return {
    speed: Math.hypot(vx, vz),
    angleDeg: (Math.atan2(vz, vx) * 180) / Math.PI,
    heightM: releaseHeightM,
  };
}

/** Horizontal range of the same release in a vacuum. */
export function vacuumRange(release: ReleaseState): number {
  const rad = (release.angleDeg * Math.PI) / 180;
  const vx = release.speed * Math.cos(rad);
  const vz = release.speed * Math.sin(rad);
  const disc = vz * vz + 2 * G * release.heightM;
  if (disc < 0) return 0;
  const t = (vz + Math.sqrt(disc)) / G;
  return vx * t;
}

/** Peak height above the ground plane, vacuum. */
export function vacuumApex(release: ReleaseState): number {
  const rad = (release.angleDeg * Math.PI) / 180;
  const vz = release.speed * Math.sin(rad);
  return release.heightM + (vz * vz) / (2 * G);
}

/** The classic result: optimal vacuum angle drops below 45 deg as height rises. */
export function optimalVacuumAngleDeg(speed: number, heightM: number): number {
  // tan(theta) = v / sqrt(v^2 + 2gh). At h = 0 this is 45 deg; every centimetre
  // of release height pulls it lower, which is why throwers are coached under 45.
  const denom = Math.sqrt(speed * speed + 2 * G * Math.max(0, heightM));
  if (denom < 1e-9) return 45;
  return (Math.atan(speed / denom) * 180) / Math.PI;
}

/* ------------------------------------------------------------------ *
 * Aerodynamic flight - RK4 in the vertical plane
 * ------------------------------------------------------------------ */

export type AeroParams = {
  implement: ImplementSpec;
  /** Attitude of the plate relative to horizontal, degrees. Spin holds it roughly fixed. */
  attitudeDeg: number;
  /** Positive = headwind (blowing back at the thrower), m/s. */
  headwindMs: number;
  airDensity: number;
};

export type FlightSample = { t: number; x: number; z: number; vx: number; vz: number; alphaDeg: number };

export type FlightResult = {
  samples: FlightSample[];
  rangeM: number;
  flightTimeS: number;
  apexM: number;
};

export type State = { x: number; z: number; vx: number; vz: number };

export function flightAccel(s: State, p: AeroParams): { ax: number; az: number } {
  if (!p.implement.aero) return { ax: 0, az: -G };

  // Airspeed = groundspeed plus headwind. A headwind raises airspeed over the
  // plate, which is why it can lengthen a discus throw.
  const arx = s.vx + p.headwindMs;
  const arz = s.vz;
  const v = Math.hypot(arx, arz);
  if (v < 1e-6) return { ax: 0, az: -G };

  const flightPath = Math.atan2(arz, arx);
  const attitude = (p.attitudeDeg * Math.PI) / 180;
  const alpha = attitude - flightPath;

  const q = 0.5 * p.airDensity * p.implement.areaM2 * v * v;
  const drag = q * dragCoefficient(alpha);
  const lift = q * liftCoefficient(alpha);

  // Drag opposes relative airflow; lift is perpendicular to it.
  const ux = arx / v;
  const uz = arz / v;
  const fx = -drag * ux - lift * uz;
  const fz = -drag * uz + lift * ux;

  return { ax: fx / p.implement.massKg, az: fz / p.implement.massKg - G };
}

/** RK4 integration to ground contact, with a linear crossing refinement. */
export function simulateFlight(
  release: ReleaseState,
  p: AeroParams,
  dt = 0.002,
  maxTime = 20,
): FlightResult {
  const rad = (release.angleDeg * Math.PI) / 180;
  let s: State = {
    x: 0,
    z: release.heightM,
    vx: release.speed * Math.cos(rad),
    vz: release.speed * Math.sin(rad),
  };

  const samples: FlightSample[] = [];
  let t = 0;
  let apex = s.z;

  const push = (st: State, time: number) => {
    const arx = st.vx + (p.implement.aero ? p.headwindMs : 0);
    const alpha = p.implement.aero
      ? (p.attitudeDeg * Math.PI) / 180 - Math.atan2(st.vz, arx)
      : 0;
    samples.push({ t: time, x: st.x, z: st.z, vx: st.vx, vz: st.vz, alphaDeg: (alpha * 180) / Math.PI });
  };
  push(s, 0);

  while (t < maxTime) {
    const prev = s;
    s = rk4Step(s, p, dt);
    t += dt;
    if (s.z > apex) apex = s.z;

    if (s.z <= 0) {
      // Linear interpolation to the ground crossing.
      const frac = prev.z / (prev.z - s.z);
      const hit: State = {
        x: prev.x + (s.x - prev.x) * frac,
        z: 0,
        vx: prev.vx + (s.vx - prev.vx) * frac,
        vz: prev.vz + (s.vz - prev.vz) * frac,
      };
      const tHit = t - dt + dt * frac;
      push(hit, tHit);
      return { samples, rangeM: hit.x, flightTimeS: tHit, apexM: apex };
    }
    if (samples.length < 4000) push(s, t);
  }

  return { samples, rangeM: s.x, flightTimeS: t, apexM: apex };
}

function rk4Step(s: State, p: AeroParams, dt: number): State {
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

/**
 * Aero efficiency: measured range divided by the range the SAME release would
 * have produced in a vacuum.
 *
 * For shot and hammer this sits just under 1.0 (drag only takes). For a
 * well-struck discus it goes ABOVE 1.0 - the plate is generating net lift and
 * buying distance. That single number is the whole discus coaching conversation,
 * which today is conducted by eyeball.
 */
export function aeroEfficiency(measuredRangeM: number, release: ReleaseState): number {
  const vac = vacuumRange(release);
  return vac > 0 ? measuredRangeM / vac : 0;
}

/**
 * Search plate attitude for the one that reproduces the observed range, given a
 * known release. Answers "what was my angle of attack?" from flight alone.
 * Returns null when no attitude in range explains the throw.
 */
export function inferAttitudeDeg(
  release: ReleaseState,
  measuredRangeM: number,
  base: Omit<AeroParams, "attitudeDeg">,
  searchLo = -20,
  searchHi = 60,
): number | null {
  // Range is NOT monotonic in attitude - it climbs to a peak near the optimum
  // and falls away past stall, so a plain bisection cannot bracket a root and
  // there are generally two attitudes that produce the same distance. Scan for
  // sign changes, refine each, then take the root nearest a typical release
  // attitude (the pre-stall branch is the one a thrower is actually on).
  const f = (att: number) =>
    simulateFlight(release, { ...base, attitudeDeg: att }, 0.004).rangeM - measuredRangeM;

  const step = 1;
  const samples: { att: number; val: number }[] = [];
  for (let a = searchLo; a <= searchHi + 1e-9; a += step) samples.push({ att: a, val: f(a) });

  const roots: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (a.val === 0) roots.push(a.att);
    if (a.val * b.val >= 0) continue;

    let lo = a.att;
    let hi = b.att;
    let flo = a.val;
    for (let k = 0; k < 30; k++) {
      const mid = (lo + hi) / 2;
      const fm = f(mid);
      if (Math.abs(fm) < 0.005) {
        lo = mid;
        hi = mid;
        break;
      }
      if (flo * fm <= 0) {
        hi = mid;
      } else {
        lo = mid;
        flo = fm;
      }
    }
    roots.push((lo + hi) / 2);
  }

  if (roots.length === 0) {
    // No exact root: the observed range may exceed anything the model can
    // produce. Fall back to the closest achievable attitude if it is close.
    let best = samples[0];
    for (const s of samples) if (Math.abs(s.val) < Math.abs(best.val)) best = s;
    return Math.abs(best.val) < 1.5 ? best.att : null;
  }

  const NOMINAL = 25;
  return roots.reduce((a, b) => (Math.abs(a - NOMINAL) <= Math.abs(b - NOMINAL) ? a : b));
}

/**
 * "What would this throw have measured under different conditions?" - the
 * counterfactual that makes headwind advice concrete.
 */
export function rangeUnderWind(
  release: ReleaseState,
  base: Omit<AeroParams, "headwindMs">,
  headwindMs: number,
): number {
  return simulateFlight(release, { ...base, headwindMs }, 0.004).rangeM;
}

/** Air density from altitude and temperature - Atlanta in July is not sea level at 15 C. */
export function airDensity(altitudeM: number, tempC: number): number {
  const p = 101325 * Math.pow(1 - 2.25577e-5 * altitudeM, 5.25588);
  return p / (287.058 * (tempC + 273.15));
}

export function xzToVec2(x: number, z: number): Vec2 {
  return { x, y: z };
}

/** Linear interpolation into an RK4 sample list, clamped at both ends. */
export function sampleFlightAt(f: FlightResult, t: number): { x: number; z: number } {
  const s = f.samples;
  if (s.length === 0) return { x: 0, z: 0 };
  if (t <= s[0].t) return { x: s[0].x, z: s[0].z };
  const last = s[s.length - 1];
  if (t >= last.t) return { x: last.x, z: last.z };
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
