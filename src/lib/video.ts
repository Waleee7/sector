/**
 * Frame extraction from an uploaded clip.
 *
 * Everything happens in the tab. The file is never uploaded anywhere, which is
 * not a marketing line - most throws footage is of minors at a school meet, and
 * the safest place for it is the device it was shot on.
 *
 * Two things this has to get right that the obvious implementation does not:
 *
 *   1. The video element survives extraction. The analyser works on luma, but a
 *      tracker you cannot watch against the real footage is a toy, so the
 *      decoded element is handed back for playback and the overlay is drawn on
 *      top of the actual colour frames.
 *
 *   2. Long clips are strided, not truncated. Capping at N frames from the start
 *      of a twenty second clip captures the wind-up and misses the throw
 *      entirely, and the failure looks like "no arc found" rather than like the
 *      bug it is.
 */

import { toGray } from "./detect";

export type ExtractedClip = {
  width: number;
  height: number;
  /** Effective sample rate after striding, which is what the solver must use. */
  fps: number;
  frames: Uint8Array[];
  /** Media time of each captured frame, so playback can seek to it exactly. */
  timestamps: number[];
  durationS: number;
  /** The decoded element, still live, for colour playback under the overlay. */
  video: HTMLVideoElement;
  /** Revokes the object URL and detaches the element. */
  release: () => void;
};

export type ExtractProgress = (done: number, total: number) => void;

const MAX_WIDTH = 640;
/** Luma frames are ~230 KB each at 640x360; 360 of them is about 83 MB. */
const MAX_FRAMES = 360;
const METADATA_TIMEOUT_MS = 15_000;
const SEEK_TIMEOUT_MS = 6_000;
/** No presented frame for this long means playback has stalled, not finished. */
const STALL_MS = 2_500;
/**
 * The seek path costs a seek and a decode per frame, so it gets a smaller
 * budget than playback capture. 180 samples still puts 60+ points on a two
 * second flight, which is far more than the fit needs.
 */
const SEEK_MAX_FRAMES = 180;
/** How long a decoded frame takes to reach the canvas after `seeked` fires. */
const PAINT_SETTLE_MS = 90;

/** Maps a MediaError onto something a person can act on. */
function decodeError(video: HTMLVideoElement): Error {
  const err = video.error;
  if (!err) return new Error("The browser could not decode this video.");
  switch (err.code) {
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return new Error(
        "This browser cannot decode that file — the container or codec is unsupported, or the file is damaged. " +
          "The usual culprit is an iPhone clip recorded as HEVC (H.265), which Chrome on Windows only plays with " +
          "the HEVC extension installed: switch Settings → Camera → Formats → Most Compatible, or export as H.264 MP4.",
      );
    case MediaError.MEDIA_ERR_DECODE:
      return new Error("The file started to decode and then failed — it may be truncated or corrupt.");
    case MediaError.MEDIA_ERR_ABORTED:
      return new Error("Decoding was cancelled before it finished.");
    case MediaError.MEDIA_ERR_NETWORK:
      return new Error("The file could not be read from disk.");
    default:
      return new Error(err.message || "The browser could not decode this video.");
  }
}

/** Resolves on `event`, rejects on `error`, rejects on timeout. */
function once(video: HTMLVideoElement, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener(event, ok);
      video.removeEventListener("error", bad);
    };
    const ok = () => {
      cleanup();
      resolve();
    };
    const bad = () => {
      cleanup();
      reject(decodeError(video));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `The browser stopped responding while reading this file (no "${event}" in ${Math.round(timeoutMs / 1000)}s). ` +
            "A very large or unusual clip can do this — try a shorter export.",
        ),
      );
    }, timeoutMs);
    video.addEventListener(event, ok, { once: true });
    video.addEventListener("error", bad, { once: true });
  });
}

/**
 * Force a real duration out of a container that reports Infinity.
 *
 * Anything produced by MediaRecorder - which includes every clip screen-recorded
 * or trimmed in a browser tool - carries no duration in its header. Seeking past
 * the end makes the browser scan to the last cluster and fill it in. Without
 * this the clip looks infinitely long, the stride maths is meaningless and the
 * seek fallback has nothing to divide by.
 */
async function resolveDuration(video: HTMLVideoElement): Promise<number> {
  if (isFinite(video.duration) && video.duration > 0) return video.duration;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      video.removeEventListener("durationchange", check);
      video.removeEventListener("seeked", check);
      resolve();
    };
    const check = () => {
      if (isFinite(video.duration) && video.duration > 0) done();
    };
    const timer = setTimeout(done, 4000);
    video.addEventListener("durationchange", check);
    video.addEventListener("seeked", check);
    video.currentTime = 1e7;
  });
  try {
    video.currentTime = 0;
  } catch {
    /* some containers refuse the rewind; the seek path re-seeks anyway */
  }
  const d = video.duration;
  // The seek-past-the-end trick sometimes leaves a nonsense value behind, and
  // every frame budget below is derived from this number. An hour is far more
  // than any throw clip; beyond that, treat it as unknown.
  return isFinite(d) && d > 0 && d < 3600 ? d : 0;
}

type RVFCVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
};

export async function extractFrames(
  file: File,
  onProgress?: ExtractProgress,
): Promise<ExtractedClip> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video") as RVFCVideo;
  video.src = url;
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.crossOrigin = "anonymous";
  // In the document, because Chrome throttles rendering for detached media and
  // requestVideoFrameCallback then never fires. Parked off-screen rather than
  // hidden: `display:none` and `visibility:hidden` are throttled too.
  video.style.cssText =
    "position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;";
  document.body.appendChild(video);

  const release = () => {
    try {
      video.pause();
    } catch {
      /* already detached */
    }
    video.removeAttribute("src");
    video.load();
    video.remove();
    URL.revokeObjectURL(url);
  };

  try {
    await once(video, "loadedmetadata", METADATA_TIMEOUT_MS);

    if (!video.videoWidth || !video.videoHeight) {
      throw new Error(
        "That file has no video track the browser can read — an audio-only file, or a container it does not understand.",
      );
    }

    const duration = await resolveDuration(video);
    const scale = Math.min(1, MAX_WIDTH / video.videoWidth);
    const width = Math.max(2, Math.round(video.videoWidth * scale));
    const height = Math.max(2, Math.round(video.videoHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Could not create a 2D drawing context.");

    const frames: Uint8Array[] = [];
    const timestamps: number[] = [];

    /** Cheap sampled signature, enough to tell two decoded frames apart. */
    const signature = (buf: Uint8Array) => {
      let h = 2166136261;
      const step = Math.max(1, Math.floor(buf.length / 1500));
      for (let i = 0; i < buf.length; i += step) h = Math.imul(h ^ buf[i], 16777619);
      return h >>> 0;
    };

    const readFrame = () => {
      ctx.drawImage(video, 0, 0, width, height);
      return toGray(ctx.getImageData(0, 0, width, height).data, width, height);
    };

    const grab = (t: number) => {
      frames.push(readFrame());
      timestamps.push(t);
    };

    // Deliberately not the `in` operator: it narrows `video` to a type without
    // the property in the else branch, which makes the seek fallback unreachable
    // as far as the compiler is concerned.
    const rvfc = video.requestVideoFrameCallback?.bind(video);

    if (rvfc) {
      // Stride so the budget spans the whole clip rather than its first seconds.
      // Assume 60 fps until the real presentation times say otherwise.
      const assumedFrames = duration > 0 ? duration * 60 : MAX_FRAMES;
      const stride = Math.max(1, Math.ceil(assumedFrames / MAX_FRAMES));
      const expected = Math.min(MAX_FRAMES, Math.ceil(assumedFrames / stride));
      let seen = 0;

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          try {
            video.pause();
          } catch {
            /* nothing to pause */
          }
          resolve();
        };
        const fail = (e: Error) => {
          if (settled) return;
          settled = true;
          reject(e);
        };

        // Watchdog. A throttled or occluded tab stops presenting frames, and
        // without this the promise simply never settles: the progress bar sits
        // at 13/360 for ever. Bailing hands control to the coverage check
        // below, which redoes the job by seeking.
        let lastFrameAt = performance.now();
        const watchdog = setInterval(() => {
          if (settled) return clearInterval(watchdog);
          if (performance.now() - lastFrameAt > STALL_MS) {
            clearInterval(watchdog);
            finish();
          }
        }, 400);

        const step = (_now: number, meta: { mediaTime: number }) => {
          if (settled) return;
          lastFrameAt = performance.now();
          if (seen % stride === 0) {
            grab(meta.mediaTime);
            onProgress?.(frames.length, expected);
          }
          seen++;
          if (frames.length >= MAX_FRAMES) return finish();
          rvfc(step);
        };

        rvfc(step);
        video.onended = finish;
        video.onerror = () => fail(decodeError(video));
        video.play().catch((e: unknown) => {
          // Autoplay policy should not bite a muted video, but if it does the
          // seek path below still works, so fall through rather than failing.
          if (frames.length === 0) fail(e instanceof Error ? e : new Error(String(e)));
        });
      });
    }

    // Seek fallback.
    //
    // Not just "rVFC is missing": playback-based capture also silently
    // under-delivers when the tab is throttled or the decoder drops frames, and
    // a handful of samples spread over a two second flight looks exactly like a
    // clip with no throw in it. So the real test is coverage - did we actually
    // sample across the clip - and anything short of that is redone by seeking,
    // which is slower but deterministic.
    const covered =
      timestamps.length > 1 ? timestamps[timestamps.length - 1] - timestamps[0] : 0;
    // Three ways playback capture can under-deliver, and all of them look
    // identical downstream: too few frames outright, frames clustered in part
    // of the clip, or frames spread correctly but far too sparse in time
    // because the decoder dropped most of them. A flight lasts a couple of
    // seconds, so twenty samples a second is the floor worth fitting an arc to.
    const thin =
      frames.length < 24 ||
      (duration > 0.5 && (covered < duration * 0.6 || frames.length < duration * 20));

    if (thin) {
      frames.length = 0;
      timestamps.length = 0;
      if (duration <= 0) {
        throw new Error("The clip reports no duration, so its frames cannot be addressed.");
      }
      video.pause();
      const target = Math.min(SEEK_MAX_FRAMES, Math.max(24, Math.round(duration * 30)));
      for (let i = 0; i < target; i++) {
        const t = (i / (target - 1)) * Math.max(0, duration - 0.001);
        video.currentTime = t;
        await once(video, "seeked", SEEK_TIMEOUT_MS);
        // Measured, not guessed: a paint reliably lands within ~90 ms of the
        // seek completing, and reading before that returns the previous frame.
        await new Promise((r) => setTimeout(r, PAINT_SETTLE_MS));

        // `seeked` means the seek finished, not that the new frame has been
        // painted, and the browsers differ on how long that takes. Rather than
        // guess a delay, read the frame and check it actually changed - the
        // failure this prevents is silent and total, because a clip of N
        // identical frames diffs to nothing and reports "no throw found".
        let buf = readFrame();
        for (let retry = 0; retry < 4; retry++) {
          if (frames.length === 0 || signature(buf) !== signature(frames[frames.length - 1])) break;
          await new Promise((r) => setTimeout(r, 50));
          buf = readFrame();
        }
        frames.push(buf);
        timestamps.push(t);
        onProgress?.(i + 1, target);
      }
    }

    if (frames.length < 12) {
      throw new Error(
        `Only ${frames.length} frames decoded. The clip is too short, or the browser could not step through it.`,
      );
    }

    // A decoder that hands back the same picture repeatedly produces a clip that
    // is technically valid and completely untrackable. Better to say so than to
    // let the analyser report an empty sky.
    if (framesAreStatic(frames, width, height)) {
      throw new Error(
        "The decoder returned the same picture for every frame, so there is no motion to track. " +
          "Re-exporting the clip as H.264 MP4 usually fixes it.",
      );
    }

    // Frame rate from the captured presentation times, not an assumption.
    const span = timestamps[timestamps.length - 1] - timestamps[0];
    const fps = span > 0 ? (frames.length - 1) / span : 30;

    video.currentTime = timestamps[0];
    return { width, height, fps, frames, timestamps, durationS: duration, video, release };
  } catch (err) {
    release();
    throw err;
  }
}

/**
 * True when the decoder handed back the same picture over and over.
 *
 * The obvious test - average absolute difference between frames - is exactly
 * wrong for this app, and dangerously so. A discus is about twenty pixels of a
 * two hundred thousand pixel frame, so a perfectly good throw clip averages out
 * to a difference of roughly 0.01 and any threshold that catches a frozen
 * decode also rejects real footage.
 *
 * So this asks the only question that has a clean answer: were the frames
 * *bit identical*? Two real decoded frames essentially never are, because
 * sensor and compression noise differ everywhere. Duplicates are exact.
 */
export function framesAreStatic(frames: Uint8Array[], width: number, height: number): boolean {
  const n = frames.length;
  if (n < 4) return false;
  const len = Math.min(width * height, frames[0].length);
  const step = Math.max(1, Math.floor(len / 2000));

  const sig = (buf: Uint8Array) => {
    let h = 2166136261;
    for (let i = 0; i < len; i += step) h = Math.imul(h ^ buf[i], 16777619);
    return h >>> 0;
  };

  const pairs = Math.min(12, n - 1);
  let identical = 0;
  for (let k = 0; k < pairs; k++) {
    const i = Math.floor((k * (n - 2)) / Math.max(1, pairs - 1));
    if (sig(frames[i]) === sig(frames[i + 1])) identical++;
  }
  // A few repeats are normal - a phone dropping frames, or a genuinely still
  // moment before the wind-up. Nearly all of them means the decode froze.
  return identical >= pairs * 0.85;
}

/**
 * Nearest captured frame for a media time.
 *
 * Timestamps are ascending, so this is a binary search - and it has to be a
 * search rather than `t * fps` because a strided or variable-frame-rate clip
 * has no constant spacing to multiply by.
 */
export function frameAtTime(timestamps: number[], t: number): number {
  if (timestamps.length === 0) return 0;
  if (t <= timestamps[0]) return 0;
  const last = timestamps.length - 1;
  if (t >= timestamps[last]) return last;
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (timestamps[mid] <= t) lo = mid;
    else hi = mid;
  }
  return t - timestamps[lo] <= timestamps[hi] - t ? lo : hi;
}
