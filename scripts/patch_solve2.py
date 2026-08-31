import io

p = r'C:\Users\oluda\sector\src\lib\solve.ts'
s = io.open(p, encoding='utf-8').read()

s = s.replace('import { fitAeroFlight } from "./aerofit";',
              'import { extrapolateToRelease, fitAeroFlight } from "./aerofit";')
s = s.replace('  backprojectToHeight,\n', '  backprojectToHeight,\n  rayToVerticalPlane,\n')

old = '''  // --- closed-form initialisation -------------------------------------
  const P0guess = backprojectToHeight({ x: first.x, y: first.y }, cam.K, cam.pose, seedHeight);
  const P1guess = backprojectToHeight({ x: last.x, y: last.y }, cam.K, cam.pose, 0);
  if (!P0guess || !P1guess) return null;'''
new = '''  // --- closed-form initialisation -------------------------------------
  // The landing mark is on the ground, and a downward ray always reaches it.
  const P1guess = backprojectToHeight({ x: last.x, y: last.y }, cam.K, cam.pose, 0);
  if (!P1guess) return null;

  // The first observed point is NOT assumed to be at any particular height -
  // once the implement is above the camera, that assumption has no solution.
  // Instead intersect its ray with the vertical plane through the circle and the
  // landing mark, which is the plane the flight lies in.
  const P0guess =
    rayToVerticalPlane(
      { x: first.x, y: first.y },
      cam.K,
      cam.pose,
      input.calibration.circleCentre,
      { x: P1guess.x, y: P1guess.y },
    ) ?? backprojectToHeight({ x: first.x, y: first.y }, cam.K, cam.pose, seedHeight);
  if (!P0guess) return null;'''
assert old in s
s = s.replace(old, new)

# Report state at release, not at first detection.
old2 = '''  if (aero) {
    release = { x: aero.params[0], y: aero.params[1], z: aero.params[2] };
    vx = aero.params[3];
    vy = aero.params[4];
    vz = aero.params[5];
    tLand = aero.flightTimeS;'''
new2 = '''  if (aero) {
    // Walk back from the first detected frame to the actual release.
    const rel = extrapolateToRelease(aero, aeroCtx, input.calibration.circleCentre);
    release = rel.world;
    const relRad = (rel.angleDeg * Math.PI) / 180;
    const vh = rel.speed * Math.cos(relRad);
    vx = vh * Math.cos(aero.headingRad);
    vy = vh * Math.sin(aero.headingRad);
    vz = rel.speed * Math.sin(relRad);
    tLand = aero.flightTimeS + rel.leadTimeS;'''
assert old2 in s
s = s.replace(old2, new2)

io.open(p, 'w', encoding='utf-8').write(s)
print("solve.ts patched")
