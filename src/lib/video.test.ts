/**
 * The pure parts of the upload path.
 *
 * Frame extraction itself needs a browser, but the two decisions that decide
 * whether an uploaded clip is usable do not - and both of them have already
 * been wrong once in a way that surfaced as "no throw found" rather than as a
 * decoding problem, which is the worst kind of bug to ship.
 */

import { describe, expect, it } from "vitest";
import { frameAtTime, framesAreStatic } from "./video";

const W = 64;
const H = 36;

/** A frame with per-pixel noise, the way a real decoded frame always looks. */
function noisy(seed: number): Uint8Array {
  const buf = new Uint8Array(W * H);
  let a = seed >>> 0;
  for (let i = 0; i < buf.length; i++) {
    a = (Math.imul(a ^ (a >>> 15), 2246822519) + 1) >>> 0;
    buf[i] = 90 + (a % 7);
  }
  return buf;
}

/** A still scene where only a handful of pixels move - i.e. a throw. */
function stillSceneWithDot(base: Uint8Array, x: number): Uint8Array {
  const buf = base.slice();
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const px = x + dx;
      const py = 12 + dy;
      if (px >= 0 && px < W) buf[py * W + px] = 12;
    }
  }
  return buf;
}

describe("frameAtTime", () => {
  const ts = [0, 0.1, 0.2, 0.35, 0.5];

  it("clamps outside the captured range", () => {
    expect(frameAtTime(ts, -5)).toBe(0);
    expect(frameAtTime(ts, 99)).toBe(4);
    expect(frameAtTime([], 1)).toBe(0);
  });

  it("returns the nearest sample, not the preceding one", () => {
    expect(frameAtTime(ts, 0.19)).toBe(2);
    expect(frameAtTime(ts, 0.21)).toBe(2);
    expect(frameAtTime(ts, 0.29)).toBe(3);
  });

  it("handles the uneven spacing a strided clip produces", () => {
    const uneven = [0, 0.03, 0.9, 0.92, 2.4];
    expect(frameAtTime(uneven, 0.5)).toBe(2);
    expect(frameAtTime(uneven, 1.5)).toBe(3);
    expect(frameAtTime(uneven, 2.0)).toBe(4);
  });
});

describe("framesAreStatic", () => {
  it("flags a decode that returned one picture over and over", () => {
    const one = noisy(7);
    const frames = Array.from({ length: 40 }, () => one);
    expect(framesAreStatic(frames, W, H)).toBe(true);
  });

  it("does NOT flag a still camera with a small moving implement", () => {
    // The regression that matters. Averaged over the frame this clip differs by
    // about 0.01, so any mean-difference test rejects exactly the footage this
    // app exists to measure.
    const base = noisy(11);
    const frames = Array.from({ length: 40 }, (_, i) => stillSceneWithDot(base, 4 + i));
    expect(framesAreStatic(frames, W, H)).toBe(false);
  });

  it("does not flag ordinary noisy footage", () => {
    const frames = Array.from({ length: 40 }, (_, i) => noisy(100 + i));
    expect(framesAreStatic(frames, W, H)).toBe(false);
  });

  it("tolerates a few duplicated frames from a dropped-frame capture", () => {
    const frames: Uint8Array[] = [];
    for (let i = 0; i < 40; i++) frames.push(noisy(200 + Math.floor(i / 2)));
    expect(framesAreStatic(frames, W, H)).toBe(false);
  });

  it("says nothing about a clip too short to judge", () => {
    expect(framesAreStatic([noisy(1), noisy(1)], W, H)).toBe(false);
  });
});
