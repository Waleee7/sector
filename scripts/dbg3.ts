import { buildScene, DEMO_THROW } from "../src/lib/synth";
import { buildBackground } from "../src/lib/pipeline";
import { detectFrame, DEFAULT_DETECT, suggestThreshold, connectedComponents, diffMask, open } from "../src/lib/detect";

const scene = buildScene(DEMO_THROW);
const src = { width: scene.width, height: scene.height, fps: scene.fps, frameCount: scene.frameCount, getGray: (i:number)=>scene.renderGray(i) };
const bg = buildBackground(src, 15);
const thr = suggestThreshold(scene.renderGray(Math.floor(scene.frameCount*0.55)), bg, 4);
console.log("threshold", thr);

let hitOpen = 0, hitRaw = 0, visible = 0;
for (let f = 0; f < scene.frameCount; f++) {
  const truth = scene.imageAt(f / scene.fps);
  if (!truth || truth.x < 2 || truth.x > scene.width-2 || truth.y < 2 || truth.y > scene.height-2) continue;
  visible++;
  const gray = scene.renderGray(f);
  const withOpen = detectFrame(gray, bg, scene.width, scene.height, { ...DEFAULT_DETECT, threshold: thr });
  if (withOpen.some(b => Math.hypot(b.x-truth.x, b.y-truth.y) < 4)) hitOpen++;
  const rawMask = diffMask(gray, bg, thr);
  const raw = connectedComponents(rawMask, scene.width, scene.height, DEFAULT_DETECT.minArea, DEFAULT_DETECT.maxArea);
  if (raw.some(b => Math.hypot(b.x-truth.x, b.y-truth.y) < 4)) hitRaw++;
}
console.log(`discus visible in ${visible} frames`);
console.log(`detected WITH morphological open : ${hitOpen}  (${(100*hitOpen/visible).toFixed(0)}%)`);
console.log(`detected WITHOUT open            : ${hitRaw}  (${(100*hitRaw/visible).toFixed(0)}%)`);
