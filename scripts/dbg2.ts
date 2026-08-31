import { buildScene, DEMO_THROW } from "../src/lib/synth";
const scene = buildScene(DEMO_THROW);
const pts: {t:number,x:number,y:number}[] = [];
for (let f = 0; f < scene.frameCount; f++) {
  const t = f / scene.fps;
  const p = scene.imageAt(t);
  if (p && p.x > 0 && p.x < scene.width && p.y > 0 && p.y < scene.height) pts.push({ t, x: p.x, y: p.y });
}
console.log("true discus visible frames:", pts.length, "of", scene.frameCount);
if (pts.length) {
  console.log("first", pts[0].t.toFixed(2), pts[0].x.toFixed(1), pts[0].y.toFixed(1));
  const mid = pts[Math.floor(pts.length/2)];
  console.log("mid  ", mid.t.toFixed(2), mid.x.toFixed(1), mid.y.toFixed(1));
  const l = pts[pts.length-1];
  console.log("last ", l.t.toFixed(2), l.x.toFixed(1), l.y.toFixed(1));
  const ys = pts.map(p=>p.y);
  console.log("y range", Math.min(...ys).toFixed(1), "->", Math.max(...ys).toFixed(1));
  // fit quadratic in t
  const n=pts.length; const t0=pts[0].t;
  let S=[0,0,0,0,0], b=[0,0,0];
  for (const p of pts){ const t=p.t-t0; const pw=[1,t,t*t,t**3,t**4]; for(let i=0;i<5;i++)S[i]+=pw[i]; for(let i=0;i<3;i++)b[i]+=pw[i]*p.y; }
  const A=[[S[0],S[1],S[2]],[S[1],S[2],S[3]],[S[2],S[3],S[4]]];
  // solve 3x3
  const M=A.map((r,i)=>[...r,b[i]]);
  for(let c=0;c<3;c++){let piv=c;for(let r=c+1;r<3;r++)if(Math.abs(M[r][c])>Math.abs(M[piv][c]))piv=r;[M[c],M[piv]]=[M[piv],M[c]];for(let r=0;r<3;r++){if(r===c)continue;const f=M[r][c]/M[c][c];for(let k=c;k<=3;k++)M[r][k]-=f*M[c][k];}}
  const sol=M.map((r,i)=>r[3]/r[i]);
  const ay = 2*sol[2]; const dur = pts[pts.length-1].t - pts[0].t;
  console.log("true arc ay(px/s^2) =", ay.toFixed(1), " duration =", dur.toFixed(2), " sagitta =", (0.125*ay*dur*dur).toFixed(1), "px");
}
