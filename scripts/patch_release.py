import io

# ---------------------------------------------------------------- geometry
p = r'C:\Users\oluda\sector\src\lib\geometry.ts'
s = io.open(p, encoding='utf-8').read()
anchor = '/* ------------------------------------------------------------------ *\n * Throwing-venue measurement'
add = r'''/**
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

'''
assert anchor in s
s = s.replace(anchor, add + anchor)
io.open(p, 'w', encoding='utf-8').write(s)

# ---------------------------------------------------------------- physics
p = r'C:\Users\oluda\sector\src\lib\physics.ts'
s = io.open(p, encoding='utf-8').read()
s = s.replace('function accel(s: State, p: AeroParams): { ax: number; az: number } {',
              'export function flightAccel(s: State, p: AeroParams): { ax: number; az: number } {')
s = s.replace('type State = { x: number; z: number; vx: number; vz: number };',
              'export type State = { x: number; z: number; vx: number; vz: number };')
s = s.replace('    const a = accel(st, p);', '    const a = flightAccel(st, p);')
assert 'export function flightAccel' in s
io.open(p, 'w', encoding='utf-8').write(s)

# ---------------------------------------------------------------- aerofit
p = r'C:\Users\oluda\sector\src\lib\aerofit.ts'
s = io.open(p, encoding='utf-8').read()
s = s.replace('''import {
  sampleFlightAt,
  simulateFlight,''', '''import {
  flightAccel,
  sampleFlightAt,
  simulateFlight,
  type State,''')

s = s.replace('''export type AeroContext = {
  implement: ImplementSpec;
  headwindMs: number;
  airDensity: number;
};''', '''export type AeroContext = {
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

  const dt = -0.002;
  let best = { st, t: 0, d: Math.abs(st.x) };

  for (let i = 0; i < 600; i++) {
    st = step(st, aero, dt);
    const d = Math.abs(st.x);
    const t = (i + 1) * dt;
    if (d < best.d) best = { st, t, d };
    // Past the circle, or descended into the ground going backwards: stop.
    if (st.x < -0.4 || st.z < 0.4) break;
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
}''')
io.open(p, 'w', encoding='utf-8').write(s)
print("geometry/physics/aerofit patched")
