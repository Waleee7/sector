import { buildScene, DEMO_THROW, CIRCLE_CENTRE, CENTRELINE_DEG } from "../src/lib/synth";
import { buildBackground } from "../src/lib/pipeline";
import { detectFrame, DEFAULT_DETECT, suggestThreshold } from "../src/lib/detect";
import { findTrajectoryCandidates, flattenCandidates } from "../src/lib/track";
const scene = buildScene(DEMO_THROW);
const src = { width: scene.width, height: scene.height, fps: scene.fps, frameCount: scene.frameCount, getGray: (i:number)=>scene.renderGray(i) };
const bg = buildBackground(src, 15);
const thr = suggestThreshold(scene.renderGray(Math.floor(scene.frameCount*0.55)), bg, 4);
const cands = [];
for (let i=0;i<scene.frameCount;i++) cands.push({frame:i,t:i/scene.fps,blobs:detectFrame(scene.renderGray(i),bg,scene.width,scene.height,{...DEFAULT_DETECT,threshold:thr})});
console.log("threshold",thr,"total blobs",cands.reduce((a,c)=>a+c.blobs.length,0));
const hyps = findTrajectoryCandidates(flattenCandidates(cands), undefined, 6);
for (const h of hyps) {
  const f=h.inliers[0], l=h.inliers[h.inliers.length-1];
  // how many inliers are actually the discus?
  let good=0;
  for (const p of h.inliers){ const t=scene.imageAt(p.t); if(t&&Math.hypot(t.x-p.x,t.y-p.y)<5) good++; }
  console.log(`inliers=${h.inliers.length} discus=${good} rms=${h.rmsError.toFixed(2)} t=[${f.t.toFixed(2)},${l.t.toFixed(2)}] ay=${h.model.ay.toFixed(0)}`);
}
