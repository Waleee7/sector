"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Stage from "./Stage";
import Metrics from "./Metrics";
import PlanView from "./PlanView";
import ProfileChart from "./ProfileChart";
import { buildScene, CENTRELINE_DEG, CIRCLE_CENTRE, DEMO_THROW, type SynthOptions } from "@/lib/synth";
import { IMPLEMENTS, implementById } from "@/lib/physics";
import {
  solveCamera,
  calibrationResidualPx,
  type Calibration,
  type Conditions,
  type ThrowMetrics,
} from "@/lib/solve";
import { CIRCLE_DIAMETER_M, type Vec2 } from "@/lib/geometry";
import { extractFrames, type ExtractedClip } from "@/lib/video";
import type { WorkerRequest, WorkerResponse } from "@/lib/worker";

type Mode = "demo" | "upload";

type Result = Extract<WorkerResponse, { kind: "done" }>;

const RIM_LABELS = [
  "Front of the circle rim (toward the sector)",
  "Back of the circle rim",
  "Left edge of the circle rim",
  "Right edge of the circle rim",
];

export default function Studio() {
  const [mode, setMode] = useState<Mode>("demo");
  const [opts, setOpts] = useState<SynthOptions>(DEMO_THROW);
  const [conditions, setConditions] = useState<Conditions>({
    headwindMs: DEMO_THROW.headwindMs,
    altitudeM: 300,
    tempC: 22,
  });
  const [implementId, setImplementId] = useState(DEMO_THROW.implementId);

  const [clip, setClip] = useState<ExtractedClip | null>(null);
  const [picks, setPicks] = useState<Vec2[]>([]);
  const [decoding, setDecoding] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [result, setResult] = useState<Result | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; stage: string } | null>(null);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [showDetections, setShowDetections] = useState(true);

  const workerRef = useRef<Worker | null>(null);

  const scene = useMemo(
    () => (mode === "demo" ? buildScene({ ...opts, implementId, headwindMs: conditions.headwindMs }) : null),
    [mode, opts, implementId, conditions.headwindMs],
  );

  const source = useMemo(() => {
    if (mode === "demo" && scene) {
      return {
        width: scene.width,
        height: scene.height,
        fps: scene.fps,
        frameCount: scene.frameCount,
        getGray: (i: number) => (i >= 0 && i < scene.frameCount ? scene.renderGray(i) : null),
      };
    }
    if (clip) {
      return {
        width: clip.width,
        height: clip.height,
        fps: clip.fps,
        frameCount: clip.frames.length,
        getGray: (i: number) => clip.frames[i] ?? null,
      };
    }
    return null;
  }, [mode, scene, clip]);

  const calibration: Calibration | null = useMemo(() => {
    if (mode === "demo" && scene) {
      return {
        points: scene.calibration,
        imageWidth: scene.width,
        imageHeight: scene.height,
        hfovDeg: scene.opts.hfovDeg,
        circleCentre: CIRCLE_CENTRE,
        circleDiameter: 2.5,
        centrelineDeg: CENTRELINE_DEG,
      };
    }
    if (clip && picks.length >= 4) {
      const spec = implementById(implementId);
      const dia =
        spec.circle === "javelin" ? 2.5 : CIRCLE_DIAMETER_M[spec.circle as keyof typeof CIRCLE_DIAMETER_M];
      const r = dia / 2;
      const world: Vec2[] = [
        { x: r, y: 0 },
        { x: -r, y: 0 },
        { x: 0, y: r },
        { x: 0, y: -r },
      ];
      return {
        points: picks.slice(0, 4).map((image, i) => ({ image, world: world[i], label: RIM_LABELS[i] })),
        imageWidth: clip.width,
        imageHeight: clip.height,
        hfovDeg: 62,
        circleCentre: { x: 0, y: 0 },
        circleDiameter: dia,
        centrelineDeg: 0,
      };
    }
    return null;
  }, [mode, scene, clip, picks, implementId]);

  const camera = useMemo(() => (calibration ? solveCamera(calibration) : null), [calibration]);
  const calResidual = useMemo(
    () => (calibration && camera ? calibrationResidualPx(calibration, camera) : null),
    [calibration, camera],
  );

  // Reset the timeline whenever the underlying footage changes.
  useEffect(() => {
    setFrame(0);
    setResult(null);
  }, [source]);

  useEffect(() => {
    if (!playing || !source) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      if (now - last >= 1000 / source.fps) {
        last = now;
        setFrame((f) => (f + 1) % source.frameCount);
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, source]);

  useEffect(() => () => workerRef.current?.terminate(), []);

  const run = useCallback(() => {
    if (!calibration || !source) return;
    setRunning(true);
    setResult(null);
    setProgress({ done: 0, total: source.frameCount, stage: "Starting" });

    workerRef.current?.terminate();
    const worker = new Worker(new URL("../lib/worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.kind === "progress") {
        setProgress({ done: msg.done, total: msg.total, stage: msg.stage });
      } else if (msg.kind === "done") {
        setResult(msg);
        setRunning(false);
        setProgress(null);
        setFrame(0);
        setPlaying(true);
      } else {
        setUploadError(msg.message);
        setRunning(false);
        setProgress(null);
      }
    };

    if (mode === "demo" && scene) {
      const req: WorkerRequest = {
        kind: "demo",
        opts: scene.opts,
        calibration,
        implementId,
        conditions,
      };
      worker.postMessage(req);
    } else if (clip) {
      const buffers = clip.frames.map((f) => f.buffer.slice(0) as ArrayBuffer);
      const req: WorkerRequest = {
        kind: "frames",
        width: clip.width,
        height: clip.height,
        fps: clip.fps,
        frames: buffers,
        calibration,
        implementId,
        conditions,
      };
      worker.postMessage(req, buffers);
    }
  }, [calibration, source, mode, scene, clip, implementId, conditions]);

  const onFile = useCallback(async (file: File) => {
    setUploadError(null);
    setDecoding("Decoding video…");
    setResult(null);
    setPicks([]);
    try {
      const c = await extractFrames(file, (d, t) => setDecoding(`Decoding video… ${d}/${t} frames`));
      setClip(c);
      setDecoding(null);
    } catch (err) {
      setClip(null);
      setDecoding(null);
      setUploadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const m: ThrowMetrics | null = result?.metrics ?? null;
  const spec = implementById(implementId);

  return (
    <main className="sector-bg" style={{ minHeight: "100vh", padding: "26px 18px 70px" }}>
      <div style={{ maxWidth: 1240, margin: "0 auto" }}>
        <Header />

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1.55fr) minmax(0, 1fr)",
            gap: 16,
            marginTop: 22,
          }}
          className="sector-grid"
        >
          {/* ---------------- Stage column ---------------- */}
          <section className="panel" style={{ padding: 14, minWidth: 0 }}>
            <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
              <Seg active={mode === "demo"} onClick={() => setMode("demo")}>
                Synthetic venue
              </Seg>
              <Seg active={mode === "upload"} onClick={() => setMode("upload")}>
                Your footage
              </Seg>
              <div style={{ flex: 1 }} />
              <button className="btn" onClick={() => setShowDetections((s) => !s)} style={{ padding: "7px 12px", fontSize: 11 }}>
                {showDetections ? "Hide" : "Show"} detections
              </button>
            </div>

            {source ? (
              <>
                <Stage
                  width={source.width}
                  height={source.height}
                  frame={frame}
                  getGray={source.getGray}
                  blobs={showDetections ? (result?.blobs ?? null) : null}
                  inliers={result?.inliers ?? null}
                  camera={camera}
                  path={m?.path ?? null}
                  releaseWorld={m?.releaseWorld ?? null}
                  landingWorld={m?.landingWorld ?? null}
                  showDetections={showDetections}
                  calibrationPoints={mode === "upload" ? picks : undefined}
                  onPick={
                    mode === "upload" && picks.length < 4
                      ? (p) => setPicks((prev) => [...prev, p])
                      : undefined
                  }
                />

                <div style={{ display: "flex", alignItems: "center", gap: 11, marginTop: 11 }}>
                  <button className="btn" style={{ padding: "7px 13px" }} onClick={() => setPlaying((p) => !p)}>
                    {playing ? "❚❚" : "▶"}
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={source.frameCount - 1}
                    value={frame}
                    onChange={(e) => {
                      setPlaying(false);
                      setFrame(Number(e.target.value));
                    }}
                  />
                  <span className="num" style={{ fontSize: 11, color: "var(--muted)", whiteSpace: "nowrap" }}>
                    {(frame / source.fps).toFixed(2)}s
                  </span>
                </div>

                <div className="hairline" style={{ marginTop: 13, paddingTop: 12 }}>
                  {mode === "upload" && picks.length < 4 ? (
                    <CalibrationPrompt index={picks.length} onUndo={() => setPicks((p) => p.slice(0, -1))} />
                  ) : (
                    <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                      <button className="btn btn-primary" onClick={run} disabled={running || !calibration}>
                        {running ? "Analysing…" : "Analyse flight"}
                      </button>
                      {mode === "upload" && (
                        <button className="btn" style={{ padding: "9px 14px", fontSize: 12 }} onClick={() => setPicks([])}>
                          Re-calibrate
                        </button>
                      )}
                      {calResidual !== null && isFinite(calResidual) && (
                        <span className="num" style={{ fontSize: 11, color: calResidual > 3 ? "var(--warn)" : "var(--muted)" }}>
                          calibration residual {calResidual.toFixed(2)} px
                        </span>
                      )}
                    </div>
                  )}

                  {progress && (
                    <div style={{ marginTop: 12 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                        <span className="label">{progress.stage}</span>
                        <span className="num" style={{ fontSize: 10, color: "var(--muted)" }}>
                          {Math.round((progress.done / Math.max(1, progress.total)) * 100)}%
                        </span>
                      </div>
                      <div style={{ height: 3, background: "var(--ink-2)", borderRadius: 2, overflow: "hidden", position: "relative" }}>
                        <div
                          style={{
                            height: "100%",
                            width: `${(progress.done / Math.max(1, progress.total)) * 100}%`,
                            background: "var(--signal)",
                            transition: "width 200ms linear",
                          }}
                        />
                      </div>
                    </div>
                  )}

                  {result && (
                    <div className="num" style={{ fontSize: 10.5, color: "var(--muted-2)", marginTop: 11, lineHeight: 1.7 }}>
                      {result.blobCount} candidate blobs · threshold {result.thresholdUsed} ·{" "}
                      {result.hypothesisCount} hypotheses · {result.rejectedHypotheses.length} rejected by physics ·{" "}
                      {result.inliers.length} frames on the arc · {(result.elapsedMs / 1000).toFixed(1)}s
                    </div>
                  )}
                </div>
              </>
            ) : (
              <Dropzone onFile={onFile} decoding={decoding} error={uploadError} />
            )}
          </section>

          {/* ---------------- Control column ---------------- */}
          <section style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
            <div className="panel" style={{ padding: 15 }}>
              <div className="label" style={{ marginBottom: 12 }}>
                Implement & conditions
              </div>
              <Field label="Implement">
                <select value={implementId} onChange={(e) => setImplementId(e.target.value)}>
                  {IMPLEMENTS.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.label}
                    </option>
                  ))}
                </select>
              </Field>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
                <Field label="Headwind m/s">
                  <input
                    type="number"
                    step="0.5"
                    value={conditions.headwindMs}
                    onChange={(e) => setConditions((c) => ({ ...c, headwindMs: Number(e.target.value) }))}
                  />
                </Field>
                <Field label="Temp °C">
                  <input
                    type="number"
                    value={conditions.tempC}
                    onChange={(e) => setConditions((c) => ({ ...c, tempC: Number(e.target.value) }))}
                  />
                </Field>
              </div>
            </div>

            {mode === "demo" && (
              <div className="panel" style={{ padding: 15 }}>
                <div className="label" style={{ marginBottom: 4 }}>
                  Ground truth — design a throw
                </div>
                <p style={{ fontSize: 11.5, color: "var(--muted)", lineHeight: 1.6, margin: "0 0 13px" }}>
                  Set a release, and the venue simulates and renders it. The analyser then sees only
                  pixels — no access to these values — so the error it reports is real.
                </p>
                <Slider label="Release velocity" unit="m/s" min={14} max={30} step={0.1} value={opts.releaseSpeedMs}
                  onChange={(v) => setOpts((o) => ({ ...o, releaseSpeedMs: v }))} />
                <Slider label="Release angle" unit="°" min={22} max={45} step={0.5} value={opts.releaseAngleDeg}
                  onChange={(v) => setOpts((o) => ({ ...o, releaseAngleDeg: v }))} />
                <Slider label="Release height" unit="m" min={1.2} max={2.2} step={0.01} value={opts.releaseHeightM}
                  onChange={(v) => setOpts((o) => ({ ...o, releaseHeightM: v }))} />
                {spec.aero && (
                  <Slider label="Plate attitude" unit="°" min={0} max={45} step={0.5} value={opts.attitudeDeg}
                    onChange={(v) => setOpts((o) => ({ ...o, attitudeDeg: v }))} />
                )}
                <Slider label="Sector deviation" unit="°" min={-16} max={16} step={0.1} value={opts.deviationDeg}
                  onChange={(v) => setOpts((o) => ({ ...o, deviationDeg: v }))} />
              </div>
            )}

            {m && (
              <div className="panel" style={{ padding: 15 }}>
                <div className="label" style={{ marginBottom: 10 }}>
                  Plan view
                </div>
                <PlanView
                  landing={{ x: m.landingWorld.x, y: m.landingWorld.y }}
                  circleCentre={calibration?.circleCentre ?? { x: 0, y: 0 }}
                  centrelineDeg={calibration?.centrelineDeg ?? 0}
                  officialDistanceM={m.officialDistanceM}
                  deviationDeg={m.sectorDeviationDeg}
                  legal={m.legalSector}
                />
              </div>
            )}
          </section>
        </div>

        {/* ---------------- Results ---------------- */}
        {m && (
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 16, marginTop: 16 }}>
            <div className="panel" style={{ padding: 17 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 15, flexWrap: "wrap" }}>
                <div className="label">Measurement</div>
                <Badge confidence={m.confidence} />
                <span className="num" style={{ fontSize: 10.5, color: "var(--muted-2)" }}>
                  {m.model === "aerodynamic" ? "aerodynamic flight model" : "ballistic fallback"} ·{" "}
                  {m.reprojectionRmsPx.toFixed(2)} px reprojection
                </span>
              </div>
              <Metrics
                m={m}
                speedRange={result?.speedRange ?? null}
                distanceRange={result?.distanceRange ?? null}
                heightRange={result?.heightRange ?? null}
                truth={mode === "demo" && scene ? scene.truth : null}
              />
            </div>

            <div className="panel" style={{ padding: 17 }}>
              <div className="label" style={{ marginBottom: 12 }}>
                Flight profile
              </div>
              <ProfileChart
                path={m.path}
                release={m.releaseWorld}
                releaseSpeedMs={m.releaseSpeedMs}
                releaseAngleDeg={m.releaseAngleDeg}
                vacuumRangeM={m.vacuumRangeM}
                aero={spec.aero}
              />
            </div>
          </div>
        )}

        {result && !m && (
          <div className="panel" style={{ padding: 17, marginTop: 16 }}>
            <div className="label" style={{ color: "var(--warn)" }}>
              No throw found
            </div>
            <p style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.7, marginTop: 9 }}>
              {result.hypothesisCount} arc hypotheses were proposed and every one was rejected as
              physically impossible. That is the system refusing to invent a measurement rather than
              reporting a bird.
            </p>
            {result.rejectedHypotheses.length > 0 && (
              <ul style={{ margin: "10px 0 0", paddingLeft: 17 }}>
                {result.rejectedHypotheses.map((r, i) => (
                  <li key={i} className="num" style={{ fontSize: 11, color: "var(--muted-2)", lineHeight: 1.8 }}>
                    {r.inliers} frames — {r.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <Footer />
      </div>

      <style>{`
        @media (max-width: 900px) {
          .sector-grid { grid-template-columns: minmax(0, 1fr) !important; }
        }
      `}</style>
    </main>
  );
}

/* ------------------------------------------------------------------ */

function Header() {
  return (
    <header>
      <div style={{ display: "flex", alignItems: "baseline", gap: 13, flexWrap: "wrap" }}>
        <h1 className="display" style={{ fontSize: 34, margin: 0, letterSpacing: "-0.045em" }}>
          SECTOR
        </h1>
        <span className="label" style={{ color: "var(--signal)" }}>
          v0 · throws flight analysis
        </span>
      </div>
      <p style={{ fontSize: 14, color: "var(--muted)", lineHeight: 1.65, margin: "10px 0 0", maxWidth: 720 }}>
        One camera, no markers, nothing uploaded. Release velocity, release angle, release height and
        Rule&nbsp;32 distance, solved from the arc itself — using gravity as the ruler and the
        implement&apos;s own aerodynamics as the model.
      </p>
    </header>
  );
}

function Footer() {
  return (
    <footer className="hairline" style={{ marginTop: 30, paddingTop: 17 }}>
      <p style={{ fontSize: 11.5, color: "var(--muted-2)", lineHeight: 1.75, margin: 0, maxWidth: 760 }}>
        Training and film analysis, not officiating. SECTOR is not a certified measuring device and
        does not replace a steel tape or an official&apos;s call. All video is decoded and analysed in
        your browser — nothing is uploaded to a server.
      </p>
    </footer>
  );
}

function Badge({ confidence }: { confidence: ThrowMetrics["confidence"] }) {
  const map = {
    high: { c: "var(--verify)", t: "HIGH CONFIDENCE" },
    medium: { c: "var(--warn)", t: "MEDIUM CONFIDENCE" },
    low: { c: "var(--bad)", t: "LOW CONFIDENCE" },
  } as const;
  const s = map[confidence];
  return (
    <span
      className="label"
      style={{ color: s.c, border: `1px solid ${s.c}`, borderRadius: 20, padding: "3px 9px", fontSize: 9 }}
    >
      {s.t}
    </span>
  );
}

function Seg({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="label"
      style={{
        padding: "7px 13px",
        borderRadius: 8,
        cursor: "pointer",
        border: `1px solid ${active ? "var(--signal)" : "var(--line)"}`,
        background: active ? "var(--signal-dim)" : "transparent",
        color: active ? "var(--signal)" : "var(--muted)",
      }}
    >
      {children}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block" }}>
      <div className="label" style={{ marginBottom: 6 }}>
        {label}
      </div>
      {children}
    </label>
  );
}

function Slider({
  label,
  unit,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div style={{ marginBottom: 13 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
        <span className="label">{label}</span>
        <span className="num" style={{ fontSize: 11.5, color: "var(--chalk)" }}>
          {value.toFixed(step < 1 ? 2 : 0)} {unit}
        </span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

function CalibrationPrompt({ index, onUndo }: { index: number; onUndo: () => void }) {
  return (
    <div>
      <div className="label" style={{ color: "var(--warn)" }}>
        Calibration — point {index + 1} of 4
      </div>
      <p style={{ fontSize: 12.5, color: "var(--chalk)", lineHeight: 1.65, margin: "8px 0 0" }}>
        Click: <strong>{RIM_LABELS[index]}</strong>
      </p>
      <p style={{ fontSize: 11.5, color: "var(--muted)", lineHeight: 1.6, margin: "7px 0 0" }}>
        The circle is a surveyed object of known diameter, so four points on its rim pin the ground
        plane and recover the camera. Scrub to a frame where the rim is clearly visible first.
      </p>
      {index > 0 && (
        <button className="btn" style={{ marginTop: 11, padding: "7px 12px", fontSize: 11 }} onClick={onUndo}>
          Undo last point
        </button>
      )}
    </div>
  );
}

function Dropzone({
  onFile,
  decoding,
  error,
}: {
  onFile: (f: File) => void;
  decoding: string | null;
  error: string | null;
}) {
  return (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
      style={{
        border: "1px dashed var(--line-strong)",
        borderRadius: 12,
        padding: "54px 24px",
        textAlign: "center",
        background: "var(--ink-2)",
      }}
    >
      <div className="display" style={{ fontSize: 17, marginBottom: 9 }}>
        {decoding ?? "Drop a throw video here"}
      </div>
      <p style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.7, maxWidth: 440, margin: "0 auto 17px" }}>
        Film side-on from a tripod with the circle and the whole flight in frame. Keep the camera
        still — the background model assumes it. 60 fps or better is worth the storage.
      </p>
      <label className="btn" style={{ cursor: "pointer" }}>
        Choose video
        <input
          type="file"
          accept="video/*"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
          }}
        />
      </label>
      {error && (
        <p style={{ fontSize: 12, color: "var(--bad)", marginTop: 15 }}>{error}</p>
      )}
    </div>
  );
}
