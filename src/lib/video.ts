/**
 * Frame extraction from an uploaded clip.
 *
 * Everything happens in the tab. The file is never uploaded anywhere, which is
 * not a marketing line - most throws footage is of minors at a school meet, and
 * the safest place for it is the device it was shot on.
 */

import { toGray } from "./detect";

export type ExtractedClip = {
  width: number;
  height: number;
  fps: number;
  frames: Uint8Array[];
  durationS: number;
};

export type ExtractProgress = (done: number, total: number) => void;

const MAX_WIDTH = 640;
const MAX_FRAMES = 420;

/**
 * Decode by playing the clip muted and capturing each presented frame.
 *
 * `requestVideoFrameCallback` gives the real presentation timestamps, so the
 * frame timing is the file's timing rather than a guess. Where it is missing we
 * fall back to seeking, which is slower but works everywhere.
 */
export async function extractFrames(
  file: File,
  onProgress?: ExtractProgress,
): Promise<ExtractedClip> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";

  try {
    await once(video, "loadedmetadata");

    const scale = Math.min(1, MAX_WIDTH / video.videoWidth);
    const width = Math.max(2, Math.round(video.videoWidth * scale));
    const height = Math.max(2, Math.round(video.videoHeight * scale));
    const duration = video.duration;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Could not create a 2D drawing context.");

    const frames: Uint8Array[] = [];
    const timestamps: number[] = [];

    // Deliberately not the `in` operator: it narrows `video` to a type without
    // the property in the else branch, which makes the seek fallback unreachable
    // as far as the compiler is concerned.
    const hasRVFC =
      typeof (video as unknown as Record<string, unknown>).requestVideoFrameCallback === "function";

    if (hasRVFC) {
      await new Promise<void>((resolve, reject) => {
        const grab = (_now: number, meta: { mediaTime: number }) => {
          ctx.drawImage(video, 0, 0, width, height);
          frames.push(toGray(ctx.getImageData(0, 0, width, height).data, width, height));
          timestamps.push(meta.mediaTime);
          onProgress?.(frames.length, Math.min(MAX_FRAMES, Math.ceil(duration * 60)));
          if (frames.length >= MAX_FRAMES) {
            video.pause();
            resolve();
            return;
          }
          (video as HTMLVideoElement & {
            requestVideoFrameCallback: (cb: typeof grab) => number;
          }).requestVideoFrameCallback(grab);
        };
        (video as HTMLVideoElement & {
          requestVideoFrameCallback: (cb: typeof grab) => number;
        }).requestVideoFrameCallback(grab);
        video.onended = () => resolve();
        video.onerror = () => reject(new Error("The browser could not decode this video."));
        void video.play().catch(reject);
      });
    } else {
      const target = Math.min(MAX_FRAMES, Math.max(2, Math.round(duration * 30)));
      for (let i = 0; i < target; i++) {
        const t = (i / (target - 1)) * Math.max(0, duration - 0.001);
        video.currentTime = t;
        await once(video, "seeked");
        ctx.drawImage(video, 0, 0, width, height);
        frames.push(toGray(ctx.getImageData(0, 0, width, height).data, width, height));
        timestamps.push(t);
        onProgress?.(i + 1, target);
      }
    }

    if (frames.length < 6) {
      throw new Error("Only " + frames.length + " frames decoded - the clip is too short.");
    }

    // Derive frame rate from the captured timestamps rather than assuming 30.
    const span = timestamps[timestamps.length - 1] - timestamps[0];
    const fps = span > 0 ? (frames.length - 1) / span : 30;

    return { width, height, fps, frames, durationS: duration };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function once(el: HTMLElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = () => {
      cleanup();
      resolve();
    };
    const bad = () => {
      cleanup();
      reject(new Error("Video failed to load."));
    };
    const cleanup = () => {
      el.removeEventListener(event, ok);
      el.removeEventListener("error", bad);
    };
    el.addEventListener(event, ok, { once: true });
    el.addEventListener("error", bad, { once: true });
  });
}
