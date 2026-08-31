import { buildScene, DEMO_THROW, CIRCLE_CENTRE, CENTRELINE_DEG } from "../src/lib/synth";
import { solveCamera, type Calibration } from "../src/lib/solve";
import { backprojectToHeight, mat3Vec, mat3Transpose, projectPoint } from "../src/lib/geometry";

const scene = buildScene(DEMO_THROW);
const cal: Calibration = { points: scene.calibration, imageWidth: scene.width, imageHeight: scene.height,
  hfovDeg: scene.opts.hfovDeg, circleCentre: CIRCLE_CENTRE, circleDiameter: 2.5, centrelineDeg: CENTRELINE_DEG };
const cam = solveCamera(cal)!;

const trueEye = mat3Vec(mat3Transpose(scene.pose.R), scene.pose.t);
const recEye  = mat3Vec(mat3Transpose(cam.pose.R), cam.pose.t);
console.log("true camera centre :", {x:-trueEye.x, y:-trueEye.y, z:-trueEye.z});
console.log("recovered centre   :", {x:-recEye.x, y:-recEye.y, z:-recEye.z});
console.log("true R :", scene.pose.R.map(v=>+v.toFixed(4)).join(","));
console.log("rec  R :", cam.pose.R.map(v=>+v.toFixed(4)).join(","));

// Decisive test: project an elevated point with the TRUE camera, back-project with the RECOVERED one.
for (const P of [{x:20,y:0,z:10},{x:40,y:-3,z:6},{x:5,y:2,z:1.65}]) {
  const pix = projectPoint(scene.K, scene.pose, P)!;
  const back = backprojectToHeight(pix, cam.K, cam.pose, P.z);
  console.log(`P=(${P.x},${P.y},${P.z}) -> pix(${pix.x.toFixed(1)},${pix.y.toFixed(1)}) -> back`,
    back ? `(${back.x.toFixed(2)},${back.y.toFixed(2)},${back.z.toFixed(2)})` : "NULL");
}
