# SECTOR

**Monocular flight tracking and release analytics for the throwing events.**

One camera. No markers, no sensors, nothing uploaded. Point a phone at the ring, click four points on the rim, and SECTOR recovers the release velocity, release angle, release height, sector deviation and Rule 32 distance — from the arc itself, using gravity as the ruler and the implement's own aerodynamics as the model.

![The SECTOR studio](docs/studio.png)

---

## Why this exists

A discus coach has two numbers after a throw: how far it went, and a stopwatch guess at everything else. The things that actually decide the distance — how fast it left the hand, at what angle, from what height, at what plate attitude — are invisible without a $20k optical system or a motion-capture lab.

But those numbers are already in the video. A thrown implement is a body in free flight with known mass and known drag. If you can find its pixels across enough frames and you know where the camera is, the physics is over-determined: there is exactly one release state that produces that arc. SECTOR solves for it.

## What it measures

| | |
|---|---|
| Release velocity | m/s at the instant of release |
| Release angle | degrees above horizontal |
| **Release height** | **measured, not assumed** — see below |
| Plate attitude | angle of attack inferred from the lift the flight actually generated |
| Sector deviation | degrees off the centreline, signed, with a legal/illegal call |
| Official distance | Rule 32 — circle inside edge to the mark, not release-to-landing |
| Aero efficiency | measured range ÷ vacuum range for the same release |
| Optimal angle | and how many degrees the athlete was off it |
| Wind counterfactual | the same release under different headwinds |

Release height being *measured* is the part most tools get wrong. Everyone else asks for the athlete's height and adds an offset. SECTOR never receives it: gravity fixes the scale of the arc in the image, the camera solve fixes the scale of the world, and the release height falls out of the intersection. It is a check on the whole solve, not an input to it.

Every result also carries the ballistic comparison — what a parabola-only tracker would have reported for the same pixels — so you can see exactly how much the aerodynamic model is doing.

## How it works

```
frames ─→ median background ─→ blob detection ─→ RANSAC parabola + physics gate
                                                            │
   4 clicked rim points ─→ homography + camera pose ─────────┤
                                                            ▼
                                            back-project arc into world
                                                            │
                        aerodynamic flight sim (lift/drag vs α, ρ from altitude+temp)
                                                            │
                                                            ▼
                                            release state + Rule 32 distance
```

**Detection is deliberately dumb.** A discus in flight is 5–15 px across, moving at 25 m/s, and motion-blurred into a smear — there is no texture left for an appearance detector to recognise. So SECTOR doesn't try. It subtracts a per-pixel *median* background (median, not mean, so the thrower is deleted rather than smeared into a ghost), accepts dozens of false positives per frame, and lets the physics decide.

**The trajectory fit is where the intelligence sits.** RANSAC proposes parabolas over every candidate blob; the gate then throws out anything whose implied vertical acceleration isn't gravity. A bird crossing the frame fits a parabola beautifully over a short window — it dies on `ay ≈ 0`. There is a regression test for exactly that, and for the nastier case where a slow sine-wave sway makes a flat crosser out-fit the real arc on inlier count.

**The camera solve** takes four points on the ring rim — a known 2.5 m circle at a known orientation to the sector centreline — and recovers intrinsics and pose. Reprojection residual is reported in the UI, so you can see immediately whether your clicks were good enough to trust the answer.

**The flight model** is a proper integration, not a parabola: lift and drag coefficients as functions of angle of attack, air density from altitude and temperature. Shot and hammer run ballistic (`aero: false`); discus and javelin run aerodynamic. Supported implements cover discus 2.0/1.6/1.0 kg, shot 7.26/5.44/4.0 kg, hammer 7.26 kg and the 800 g javelin.

## The demo validates itself

The hard part of a tool like this is proving it works when you have no ground truth. SECTOR's demo mode is the answer.

**Synthetic Venue** lets you *design* a throw — set the release speed, angle, height, plate attitude and sector deviation on sliders. The venue then simulates that flight and renders it to actual pixels: a grey field, motion-blurred implement, decoy blobs in shot, sensor noise on top. The analyser is handed those pixels and nothing else — it has no access to the sliders. So the error it reports is a real measurement error, on a throw whose answer is known exactly.

The same harness is part of the test suite — three cases, tolerance-enforced, so a regression in any stage of the chain fails the build. `npm run accuracy` reproduces this table:

| Case | Truth | Speed err | Angle err | Height err | Distance err | Reproj. |
|---|---|---|---|---|---|---|
| Reference throw | 68.14 m | 0.011 m/s | 0.092° | 0.013 m | 0.039 m | 0.20 px |
| Flat and slow | 41.08 m | 0.040 m/s | 0.071° | 0.012 m | 0.118 m | 0.21 px |
| Fast, steep, 5 m/s headwind | 83.39 m | 0.004 m/s | 0.044° | 0.015 m | 0.000 m | 0.21 px |

The demo and your footage go through the same `analyze()` entry point behind one `FrameSource` interface — the demo is not a separate code path that could quietly diverge from the real one.

## Honest limitations

- **Validated against a synthetic renderer, not against surveyed real throws.** The numbers above prove the detection → RANSAC → camera solve → physics chain is correct end to end. They do not yet prove the renderer models a real phone camera closely enough. Field validation against taped marks is the next milestone, and until it's done, treat real-footage output as a training aid.
- **No lens distortion model.** A pinhole camera is assumed. Wide-angle phone footage will bias the solve near the frame edges.
- **Rolling shutter is unmodelled.** Most phones skew fast horizontal motion; this is not yet corrected for.
- **The camera must be static** and the ring rim must be visible in frame for calibration.
- **Not an officiating device.** It does not replace a steel tape or an official's call.

## Privacy

Video is decoded and analysed entirely in the browser — `requestVideoFrameCallback` into a canvas, then straight into a Web Worker. Nothing is uploaded, and there is no server to upload it to.

That is a design constraint, not a marketing line: most throws footage is of minors at a school meet, and the safest place for it is the device it was shot on.

## Stack

Next.js 16 · React 19 · TypeScript · Tailwind 4 · Web Workers · Vitest

Runtime dependencies: `next`, `react`, `react-dom`. That's the whole list. No OpenCV, no TensorFlow, no solver library — the background subtraction, connected-component labelling, RANSAC, homography decomposition, RK4 integration and the aerodynamic fit are all written here, in plain typed arrays, so they run identically in a worker, on the main thread, and in Node under Vitest.

```
src/lib/
  detect.ts     background subtraction, thresholding, blob extraction
  track.ts      RANSAC parabola fitting with the gravity gate
  geometry.ts   vectors, matrices, homography
  solve.ts      camera pose, world back-projection, throw metrics
  physics.ts    implements, lift/drag, flight integration, air density
  aerofit.ts    fits release state to the observed arc
  synth.ts      the synthetic venue — ground truth generator
  pipeline.ts   one entry point, driven by a FrameSource
  video.ts      in-browser frame extraction
  worker.ts     off-main-thread analysis
```

## Running it

```bash
npm install
npm run dev        # http://localhost:3000 — opens in Synthetic Venue mode
npm test           # 38 tests
npm run accuracy   # prints the accuracy table above
npm run build
```

No API keys, no environment variables, no backend.

## Roadmap

- [ ] Field validation against surveyed marks — the blocking milestone
- [ ] Lens distortion estimation from the ring ellipse
- [ ] Rolling-shutter correction
- [ ] Multi-throw sessions with release-consistency trends
- [ ] Hammer wire dynamics (currently modelled as a point mass)

---

Built by [Josh Dare](https://github.com/Waleee7) — CS at Life University, NCAA thrower. The reason release height is measured instead of assumed is that I got tired of tools asking me how tall I am.

MIT licensed.
