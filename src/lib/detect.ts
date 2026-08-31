/**
 * SECTOR - implement detection.
 *
 * A discus in flight is 5-15 px across, moving at 25 m/s, and motion-blurred
 * into a smear. Appearance detectors (YOLO and friends) are the wrong tool: they
 * are trained on objects with texture, and there is no texture left.
 *
 * So we do not try to recognise the implement at all. We subtract a static
 * background, accept dozens of false-positive blobs per frame, and let the
 * physics in track.ts decide which of them lie on a real trajectory. Detection
 * is deliberately dumb; the trajectory fit is where the intelligence sits.
 *
 * Everything here is plain typed arrays so it runs identically in a worker, in
 * the main thread, and in vitest under node.
 */

export type Blob = {
  x: number;
  y: number;
  area: number;
  w: number;
  h: number;
};

export type FrameCandidates = {
  frame: number;
  t: number;
  blobs: Blob[];
};

/** ITU-R BT.601 luma. */
export function toGray(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114) / 1000;
  }
  return out;
}

/**
 * Per-pixel median across sampled frames.
 *
 * Median rather than mean specifically because the thrower is in shot: a mean
 * background smears a ghost of the athlete across the circle, a median deletes
 * them as long as they are not stationary in more than half the samples.
 */
export function medianBackground(frames: Uint8Array[]): Uint8Array {
  if (frames.length === 0) return new Uint8Array(0);
  const n = frames.length;
  const len = frames[0].length;
  const out = new Uint8Array(len);
  // Insertion sort into a reused buffer: n is ~15, and allocating a fresh array
  // per pixel across a quarter-million pixels is the difference between this
  // finishing instantly and janking the tab.
  const bucket = new Uint8Array(n);
  const mid = n >> 1;
  for (let i = 0; i < len; i++) {
    for (let f = 0; f < n; f++) {
      const v = frames[f][i];
      let j = f - 1;
      while (j >= 0 && bucket[j] > v) {
        bucket[j + 1] = bucket[j];
        j--;
      }
      bucket[j + 1] = v;
    }
    out[i] = bucket[mid];
  }
  return out;
}

/** Absolute difference against the background, thresholded to a binary mask. */
export function diffMask(gray: Uint8Array, bg: Uint8Array, threshold: number): Uint8Array {
  const out = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    out[i] = Math.abs(gray[i] - bg[i]) >= threshold ? 1 : 0;
  }
  return out;
}

/**
 * Suggest a threshold from the difference statistics: mean + k*sigma.
 * Saves the user from hunting a slider on their first run.
 */
export function suggestThreshold(gray: Uint8Array, bg: Uint8Array, k = 4): number {
  let sum = 0;
  let sumSq = 0;
  const n = gray.length;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(gray[i] - bg[i]);
    sum += d;
    sumSq += d * d;
  }
  const mean = sum / n;
  const sd = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  return Math.max(8, Math.min(90, Math.round(mean + k * sd)));
}

/** 4-neighbour erode. Kills single-pixel sensor noise. */
export function erode(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      out[i] =
        mask[i] && mask[i - 1] && mask[i + 1] && mask[i - w] && mask[i + w] ? 1 : 0;
    }
  }
  return out;
}

/** 4-neighbour dilate. Reconnects a blur smear that erode fragmented. */
export function dilate(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (mask[i] || mask[i - 1] || mask[i + 1] || mask[i - w] || mask[i + w]) out[i] = 1;
    }
  }
  return out;
}

export function open(mask: Uint8Array, w: number, h: number): Uint8Array {
  return dilate(erode(mask, w, h), w, h);
}

/**
 * Connected components, 8-connectivity, iterative flood fill.
 * Iterative and not recursive because a large blob would blow the JS stack.
 */
export function connectedComponents(
  mask: Uint8Array,
  w: number,
  h: number,
  minArea: number,
  maxArea: number,
): Blob[] {
  const seen = new Uint8Array(mask.length);
  const blobs: Blob[] = [];
  const stack: number[] = [];

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;

    stack.length = 0;
    stack.push(start);
    seen[start] = 1;

    let area = 0;
    let sx = 0;
    let sy = 0;
    let minX = w;
    let maxX = -1;
    let minY = h;
    let maxY = -1;

    while (stack.length) {
      const i = stack.pop() as number;
      const x = i % w;
      const y = (i / w) | 0;
      area++;
      sx += x;
      sy += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const j = ny * w + nx;
          if (mask[j] && !seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        }
      }
    }

    if (area >= minArea && area <= maxArea) {
      blobs.push({
        x: sx / area,
        y: sy / area,
        area,
        w: maxX - minX + 1,
        h: maxY - minY + 1,
      });
    }
  }

  return blobs;
}

export type DetectOptions = {
  threshold: number;
  minArea: number;
  maxArea: number;
  /** Drop blobs whose bounding box is wildly non-compact - usually the athlete. */
  maxAspect: number;
  /** Ignore everything below this fraction of frame height (crowd, ground clutter). */
  ignoreBelow?: number;
  /**
   * Morphological opening before component labelling. OFF by default, and that
   * default is load-bearing.
   *
   * Opening is the reflex denoiser for a difference mask, but the implement is
   * 4-6 px across at range, so a single erode pass deletes exactly the object we
   * are hunting. Measured against the synthetic venue: recall falls from 100% to
   * 20% with opening on. Small-area rejection in connectedComponents does the
   * denoising job without eating the signal. Turn this on only for heavily
   * grained footage, and check recall when you do.
   */
  morphOpen?: boolean;
};

export const DEFAULT_DETECT: DetectOptions = {
  threshold: 26,
  minArea: 4,
  maxArea: 900,
  maxAspect: 6,
  ignoreBelow: 1,
  morphOpen: false,
};

export function detectFrame(
  gray: Uint8Array,
  bg: Uint8Array,
  w: number,
  h: number,
  opts: DetectOptions,
): Blob[] {
  const raw = diffMask(gray, bg, opts.threshold);
  const mask = opts.morphOpen ? open(raw, w, h) : raw;
  const blobs = connectedComponents(mask, w, h, opts.minArea, opts.maxArea);
  const cutoff = (opts.ignoreBelow ?? 1) * h;
  return blobs.filter((b) => {
    const aspect = Math.max(b.w, b.h) / Math.max(1, Math.min(b.w, b.h));
    return aspect <= opts.maxAspect && b.y <= cutoff;
  });
}
