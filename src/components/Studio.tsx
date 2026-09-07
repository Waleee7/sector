"use client";

/**
 * SECTOR studio.
 *
 * Three modes, one pipeline. RANGE renders a throw you design, ARCHIVE renders
 * a reconstruction of a published mark, TRACK takes your own video - and all
 * three hand their frames to the same `analyze()` behind the same FrameSource
 * interface. There is no demo code path that could quietly diverge from the
 * real one, which is the only reason the error numbers mean anything.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Stage from "./Stage";
import Metrics from "./Metrics";
import PlanView from "./PlanView";
import ProfileChart from "./ProfileChart";
import { buildScene, CENTRELINE_DEG, CIRCLE_CENTRE, DEMO_THROW, type SynthOptions } from "@/lib/synth";
import { IMPLEMENTS, implementById } from "@/lib/physics";
import { CASE_FILES, caseFileById, reconstruct, type CaseFile } from "@/lib/casefiles";
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

type Mode = "range" | "archive" | "track";

type Result = Extract<WorkerResponse, { kind: "done" }>;

const RIM_LABELS = [
  "Front of the circle rim (toward the sector)",
  "Back of the circle rim",
  "Left edge of the circle rim",
  "Right edge of the circle rim",
];

const MODE_LABEL: Record<Mode, string> = {
  range: "Range",
  archive: "Archive",
  track: "Track",
};

export default function Studio() {
  const [mode, setMode] = useState<Mode>("archive");
  const [opts, setOpts] = useState<SynthOptions>(DEMO_THROW);
  const [caseId, setCaseId] = useState<string>(CASE_FILES[0].id);
  const [archiveWind, setArchiveWind] = useState(0);
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
  const [showGrid, setShowGrid] = useState(true);

  const workerRef = useRef<Worker | null>(null);

  const activeCase = useMemo(() => caseFileById(caseId) ?? CASE_FILES[0], [caseId]);

  /**
   * The reconstruction: the release this model requires to produce the published
   * mark, in that venue's air, with no wind. It is what the physics demands, not
   * a measurement of the athlete - which is why the wind slider then moves the
   * venue rather than the reconstruction.
   */
  const recon = useMemo(() => reconstruct(activeCase), [activeCase]);

  const archiveOpts: SynthOptions = useMemo(
    () => ({
      ...DEMO_THROW,
      implementId: activeCase.implementId,
      releaseSpeedMs: recon.release.speed,
      releaseAngleDeg: recon.release.angleDeg,
      releaseHeightM: recon.release.heightM,
      attitudeDeg: recon.attitudeDeg,
      headwindMs: archiveWind,
      // Straight down the centreline: the mark is public, the line it was thrown
      // on is not, and inventing one would be inventing data.
      deviationDeg: 0,
      altitudeM: activeCase.altitudeM,
      tempC: activeCase.tempC,
      seed: 4242,
    }),
    [activeCase, recon, archiveWind],
  );

  const synthOpts: SynthOptions | null =
    mode === "range"
      ? { ...opts, implementId, headwindMs: conditions.headwindMs }
      : mode === "archive"
        ? archiveOpts
        : null;

  const scene = useMemo(() => (synthOpts ? buildScene(synthOpts) : null), [synthOpts]);

  /** Conditions the solver is told about. They must match the venue's own air. */
  const solveConditions: Conditions = useMemo(() => {
    if (mode === "archive") {
      return { headwindMs: archiveWind, altitudeM: activeCase.altitudeM, tempC: activeCase.tempC };
    }
    return conditions;
  }, [mode, archiveWind, activeCase, conditions]);

  const activeImplementId = mode === "archive" ? activeCase.implementId : implementId;

  const source = useMemo(() => {
    if (scene) {
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
  }, [scene, clip]);

  const calibration: Calibration | null = useMemo(() => {
    if (scene) {
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
  }, [scene, clip, picks, implementId]);

  const camera = useMemo(() => (calibration ? solveCamera(calibration) : null), [calibration]);
  const calResidual = useMemo(
    () => (calibration && camera ? calibrationResidualPx(calibration, camera) : null),
    [calibration, camera],
  );

  useEffect(() => {
    setFrame(0);
    setResult(null);
    setPlaying(false);
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

    if (synthOpts) {
      const req: WorkerRequest = {
        kind: "demo",
        opts: synthOpts,
        calibration,
        implementId: activeImplementId,
        conditions: solveConditions,
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
        implementId: activeImplementId,
        conditions: solveConditions,
      };
      worker.postMessage(req, buffers);
    }
  }, [calibration, source, synthOpts, clip, activeImplementId, solveConditions]);

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
  const spec = implementById(activeImplementId);

  const sourceLabel =
    mode === "archive"
      ? `ARCHIVE · ${activeCase.athlete.toUpperCase()}`
      : mode === "range"
        ? "SYNTHETIC RANGE"
        : "YOUR FOOTAGE";

  return (
    <main className="field" style={{ padding: "26px 18px 72px" }}>
      <div style={{ maxWidth: 1280, margin: "0 auto", position: "relative", zIndex: 1 }}>
        <Header />

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", margin: "22px 0 14px" }}>
          <div className="tabbar" role="tablist" aria-label="Source mode">
            {(["archive", "range", "track"] as Mode[]).map((k) => (
              <button
                key={k}
                role="tab"
                aria-selected={mode === k}
                data-on={mode === k}
                className="tab"
                onClick={() => setMode(k)}
              >
                {MODE_LABEL[k]}
              </button>
            ))}
          </div>
          <div style={{ flex: 1 }} />
          <Toggle on={showDetections} onClick={() => setShowDetections((s) => !s)}>
            Candidates
          </Toggle>
          <Toggle on={showGrid} onClick={() => setShowGrid((s) => !s)}>
            Range grid
          </Toggle>
        </div>

        <p className="label label-dim" style={{ margin: "0 0 16px", letterSpacing: "0.14em", lineHeight: 1.7 }}>
          {mode === "archive"
            ? "Published marks, reconstructed from the physics and re-measured by the tracker"
            : mode === "range"
              ? "Design a release · the venue renders it · the analyser sees only pixels"
              : "Your video, decoded and analysed in this tab · nothing is uploaded"}
        </p>

        <div className="studio-grid" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.62fr) minmax(0, 1fr)", gap: 16 }}>
          {/* ---------------- Stage ---------------- */}
          <section className="plate plate-lit plate-rule boot" style={{ padding: 14, minWidth: 0, alignSelf: "start" }}>
            {source ? (
              <>
                <Stage
                  width={source.width}
                  height={source.height}
                  frame={frame}
                  fps={source.fps}
                  getGray={source.getGray}
                  blobs={showDetections ? (result?.blobs ?? null) : null}
                  inliers={result?.inliers ?? null}
                  camera={camera}
                  path={m?.path ?? null}
                  flightTimeS={m?.flightTimeS ?? null}
                  releaseWorld={m?.releaseWorld ?? null}
                  landingWorld={m?.landingWorld ?? null}
                  showDetections={showDetections}
                  showGrid={showGrid}
                  analysing={running}
                  analysisStage={progress?.stage ?? null}
                  confidence={m?.confidence ?? null}
                  reprojectionRmsPx={m?.reprojectionRmsPx ?? null}
                  sourceLabel={sourceLabel}
                  implementLabel={spec.label}
                  calibrationPoints={mode === "track" ? picks : undefined}
                  onPick={
                    mode === "track" && picks.length < 4 ? (p) => setPicks((prev) => [...prev, p]) : undefined
                  }
                />

                <Transport
                  playing={playing}
                  frame={frame}
                  frameCount={source.frameCount}
                  fps={source.fps}
                  onToggle={() => setPlaying((p) => !p)}
                  onSeek={(f) => {
                    setPlaying(false);
                    setFrame(f);
                  }}
                />

                <div className="hair" style={{ marginTop: 13, paddingTop: 13 }}>
                  {mode === "track" && picks.length < 4 ? (
                    <CalibrationPrompt index={picks.length} onUndo={() => setPicks((p) => p.slice(0, -1))} />
                  ) : (
                    <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                      <button className="btn btn-primary" onClick={run} disabled={running || !calibration}>
                        {running ? "Analysing…" : "Run tracker"}
                      </button>
                      {mode === "track" && (
                        <button className="btn" onClick={() => setPicks([])}>
                          Re-calibrate
                        </button>
                      )}
                      {calResidual !== null && isFinite(calResidual) && (
                        <span className="num" style={{ fontSize: 11, color: calResidual > 3 ? "var(--gold)" : "var(--muted)" }}>
                          calibration residual {calResidual.toFixed(2)} px
                        </span>
                      )}
                    </div>
                  )}

                  {progress && (
                    <div style={{ marginTop: 13 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                        <span className="label" style={{ color: "var(--chrome)" }}>
                          {progress.stage}
                        </span>
                        <span className="num" style={{ fontSize: 10, color: "var(--muted)" }}>
                          {Math.round((progress.done / Math.max(1, progress.total)) * 100)}%
                        </span>
                      </div>
                      <div className="scanbar" />
                    </div>
                  )}

                  {result && <PipelineLog r={result} />}
                </div>

                {m && (
                  <div className="hair settle" style={{ marginTop: 14, paddingTop: 14 }}>
                    <PanelTitle>Plan view</PanelTitle>
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
              </>
            ) : (
              <Dropzone onFile={onFile} decoding={decoding} error={uploadError} />
            )}
          </section>

          {/* ---------------- Rail ---------------- */}
          <section style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0, alignSelf: "start" }}>
            {mode === "archive" && (
              <ArchivePanel
                cases={CASE_FILES}
                active={activeCase}
                onSelect={setCaseId}
                recon={recon}
                wind={archiveWind}
                onWind={setArchiveWind}
                venueDistanceM={scene?.truth.officialDistanceM ?? null}
                measuredM={m?.officialDistanceM ?? null}
              />
            )}

            {mode !== "archive" && (
              <div className="plate" style={{ padding: 15 }}>
                <PanelTitle>Implement &amp; conditions</PanelTitle>
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
            )}

            {mode === "range" && (
              <div className="plate" style={{ padding: 15 }}>
                <PanelTitle>Ground truth — design a throw</PanelTitle>
                <p style={{ fontSize: 11.5, color: "var(--muted)", lineHeight: 1.65, margin: "0 0 14px" }}>
                  Set a release and the venue simulates and renders it. The analyser sees only pixels —
                  no access to these values — so the error it reports is real.
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

          </section>
        </div>

        {/* ---------------- Readout ---------------- */}
        {m && (
          <div style={{ display: "grid", gap: 16, marginTop: 16 }}>
            <div className="plate plate-rule settle" style={{ padding: 17 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 15, flexWrap: "wrap" }}>
                <PanelTitle inline>Measurement</PanelTitle>
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
                truth={scene ? scene.truth : null}
              />
            </div>

            <div className="plate" style={{ padding: 17 }}>
              <PanelTitle>Flight profile</PanelTitle>
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

        {result && !m && <NoThrow r={result} />}

        <Footer />
      </div>

      <style>{`
        @media (max-width: 940px) {
          .studio-grid { grid-template-columns: minmax(0, 1fr) !important; }
        }
      `}</style>
    </main>
  );
}

/* ------------------------------------------------------------------ */

function Header() {
  return (
    <header className="boot">
      <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
        <h1 className="wordmark" style={{ fontSize: "clamp(38px, 7vw, 62px)", margin: 0, lineHeight: 0.92 }}>
          SECTOR
        </h1>
        <span className="label" style={{ color: "var(--signal)" }}>
          monocular flight tracking
        </span>
      </div>
      <p style={{ fontSize: 14.5, color: "var(--muted)", lineHeight: 1.7, margin: "13px 0 0", maxWidth: 740 }}>
        One camera, no markers, nothing uploaded. Release velocity, release angle, release height and
        Rule&nbsp;32 distance, solved from the arc itself — using gravity as the ruler and the
        implement&apos;s own aerodynamics as the model.
      </p>
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginTop: 14 }}>
        <Stat k="Pipeline" v="Detect → RANSAC → Solve → Integrate" />
        <Stat k="Runtime deps" v="next · react · react-dom" />
        <Stat k="Video leaves the tab" v="Never" />
      </div>
    </header>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div className="label label-dim" style={{ fontSize: 9 }}>
        {k}
      </div>
      <div className="num" style={{ fontSize: 11.5, color: "var(--chrome)", marginTop: 3 }}>
        {v}
      </div>
    </div>
  );
}

function PanelTitle({ children, inline }: { children: React.ReactNode; inline?: boolean }) {
  return (
    <div
      className="label"
      style={{
        color: "var(--chrome)",
        marginBottom: inline ? 0 : 12,
        display: "flex",
        alignItems: "center",
        gap: 7,
      }}
    >
      <span className="dot" style={{ color: "var(--chrome)" }} />
      {children}
    </div>
  );
}

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className="tab"
      data-on={on}
      style={{ border: "1px solid var(--line)" }}
    >
      {children}
    </button>
  );
}

function Transport({
  playing,
  frame,
  frameCount,
  fps,
  onToggle,
  onSeek,
}: {
  playing: boolean;
  frame: number;
  frameCount: number;
  fps: number;
  onToggle: () => void;
  onSeek: (f: number) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
      <button className="btn" style={{ minWidth: 52 }} onClick={onToggle} aria-label={playing ? "Pause" : "Play"}>
        {playing ? "❚❚" : "▶"}
      </button>
      <input
        type="range"
        aria-label="Timeline"
        min={0}
        max={Math.max(0, frameCount - 1)}
        value={frame}
        onChange={(e) => onSeek(Number(e.target.value))}
      />
      <span className="num" style={{ fontSize: 11, color: "var(--muted)", whiteSpace: "nowrap" }}>
        {(frame / fps).toFixed(2)}s
      </span>
    </div>
  );
}

function PipelineLog({ r }: { r: Result }) {
  const rows: [string, string][] = [
    ["blobs", `${r.blobCount} @ threshold ${r.thresholdUsed}`],
    ["hypotheses", `${r.hypothesisCount} proposed`],
    ["gate", `${r.rejectedHypotheses.length} rejected by physics`],
    ["arc", `${r.inliers.length} frames accepted`],
    ["elapsed", `${(r.elapsedMs / 1000).toFixed(1)}s`],
  ];
  return (
    <div style={{ marginTop: 13, display: "flex", flexWrap: "wrap", gap: "4px 20px" }}>
      {rows.map(([k, v]) => (
        <span key={k} className="num" style={{ fontSize: 10.5, color: "var(--muted-2)" }}>
          <span style={{ color: "var(--chrome)", opacity: 0.65 }}>{k}</span> {v}
        </span>
      ))}
    </div>
  );
}

/* ---------------- Archive ---------------- */

function ArchivePanel({
  cases,
  active,
  onSelect,
  recon,
  wind,
  onWind,
  venueDistanceM,
  measuredM,
}: {
  cases: CaseFile[];
  active: CaseFile;
  onSelect: (id: string) => void;
  recon: ReturnType<typeof reconstruct>;
  wind: number;
  onWind: (v: number) => void;
  venueDistanceM: number | null;
  measuredM: number | null;
}) {
  return (
    <>
      <div className="plate plate-lit" style={{ padding: 15 }}>
        <PanelTitle>Case files</PanelTitle>
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {cases.map((c) => {
            const on = c.id === active.id;
            return (
              <button
                key={c.id}
                onClick={() => onSelect(c.id)}
                style={{
                  textAlign: "left",
                  cursor: "pointer",
                  padding: "10px 11px",
                  minHeight: 44,
                  background: on ? "rgba(79,227,255,0.10)" : "transparent",
                  border: `1px solid ${on ? "var(--line-strong)" : "transparent"}`,
                  color: "inherit",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: on ? "var(--chalk)" : "var(--muted)",
                      letterSpacing: "-0.01em",
                    }}
                  >
                    {c.athlete}
                    {c.personal && (
                      <span className="label" style={{ color: "var(--signal)", marginLeft: 7, fontSize: 8.5 }}>
                        author
                      </span>
                    )}
                  </span>
                  <span className="num display" style={{ fontSize: 14, color: on ? "var(--signal)" : "var(--muted-2)" }}>
                    {c.markM.toFixed(2)}
                  </span>
                </div>
                <div className="label label-dim" style={{ fontSize: 8.5, marginTop: 4, letterSpacing: "0.12em" }}>
                  {c.event}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="plate" style={{ padding: 15 }}>
        <PanelTitle>Reconstruction</PanelTitle>
        <p style={{ fontSize: 11.5, color: "var(--muted)", lineHeight: 1.65, margin: "0 0 12px" }}>
          {active.note}
        </p>

        <div className="kv">
          <span className="label">Venue</span>
          <span className="num" style={{ fontSize: 11, color: "var(--chalk)", textAlign: "right" }}>
            {active.venue}
          </span>
        </div>
        <div className="kv">
          <span className="label">Date</span>
          <span className="num" style={{ fontSize: 11, color: "var(--chalk)" }}>
            {active.date}
          </span>
        </div>
        <div className="kv">
          <span className="label">Published mark</span>
          <span className="num display" style={{ fontSize: 15, color: "var(--gold)" }}>
            {active.markM.toFixed(2)} m
          </span>
        </div>
        <div className="kv">
          <span className="label">Release required</span>
          <span className="num display" style={{ fontSize: 15, color: "var(--verify)" }}>
            {recon.release.speed.toFixed(2)} m/s
          </span>
        </div>
        <div className="kv">
          <span className="label">At angle</span>
          <span className="num" style={{ fontSize: 12, color: "var(--chalk)" }}>
            {recon.release.angleDeg.toFixed(1)}° · plate {recon.attitudeDeg.toFixed(0)}°
          </span>
        </div>
        <div className="kv">
          <span className="label">Lift is worth</span>
          <span className="num" style={{ fontSize: 12, color: "var(--signal)" }}>
            +{(active.markM - recon.vacuumRangeM).toFixed(1)} m over vacuum
          </span>
        </div>

        <div className="hair" style={{ marginTop: 13, paddingTop: 13 }}>
          <Slider
            label="Venue headwind"
            unit="m/s"
            min={-4}
            max={10}
            step={0.5}
            value={wind}
            onChange={onWind}
          />
          <p style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.6, margin: "0 0 12px" }}>
            The release is fixed. Only the air moves — and a discus is a wing, so into a headwind it
            flies further. This is why athletes travel to Ramona.
          </p>

          <div className="kv">
            <span className="label">Venue produced</span>
            <span className="num" style={{ fontSize: 13, color: "var(--chalk)" }}>
              {venueDistanceM != null ? `${venueDistanceM.toFixed(2)} m` : "—"}
            </span>
          </div>
          <div className="kv">
            <span className="label">SECTOR measured</span>
            <span className="num display" style={{ fontSize: 15, color: measuredM != null ? "var(--signal)" : "var(--muted-2)" }}>
              {measuredM != null ? `${measuredM.toFixed(2)} m` : "run the tracker"}
            </span>
          </div>
        </div>

        <p style={{ fontSize: 10.5, color: "var(--muted-2)", lineHeight: 1.65, margin: "13px 0 0" }}>
          This is a reconstruction, not a measurement of the throw. SECTOR solves for the release this
          model needs to reach a published mark, renders that flight, then measures it back — so the
          error you see is the tracker&apos;s, not the athlete&apos;s.{" "}
          <a href={active.source} target="_blank" rel="noopener noreferrer">
            Source
          </a>
        </p>
      </div>
    </>
  );
}

/* ---------------- Bits ---------------- */

function NoThrow({ r }: { r: Result }) {
  return (
    <div className="plate" style={{ padding: 17, marginTop: 16 }}>
      <div className="label" style={{ color: "var(--gold)" }}>
        No throw found
      </div>
      <p style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.75, marginTop: 9 }}>
        {r.hypothesisCount} arc hypotheses were proposed and every one was rejected as physically
        impossible. That is the system refusing to invent a measurement rather than reporting a bird.
      </p>
      {r.rejectedHypotheses.length > 0 && (
        <ul style={{ margin: "10px 0 0", paddingLeft: 17 }}>
          {r.rejectedHypotheses.map((x, i) => (
            <li key={i} className="num" style={{ fontSize: 11, color: "var(--muted-2)", lineHeight: 1.8 }}>
              {x.inliers} frames — {x.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Footer() {
  return (
    <footer className="hair" style={{ marginTop: 34, paddingTop: 18 }}>
      <p style={{ fontSize: 11.5, color: "var(--muted-2)", lineHeight: 1.8, margin: 0, maxWidth: 790 }}>
        Training and film analysis, not officiating. SECTOR is not a certified measuring device and does
        not replace a steel tape or an official&apos;s call. Archive reconstructions are model output
        from published marks, not measurements of those throws. All video is decoded and analysed in
        your browser — nothing is uploaded to a server.
      </p>
    </footer>
  );
}

function Badge({ confidence }: { confidence: ThrowMetrics["confidence"] }) {
  const map = {
    high: { c: "var(--verify)", t: "HIGH CONFIDENCE" },
    medium: { c: "var(--gold)", t: "MEDIUM CONFIDENCE" },
    low: { c: "var(--reject)", t: "LOW CONFIDENCE" },
  } as const;
  const s = map[confidence];
  return (
    <span className="label" style={{ color: s.c, border: `1px solid ${s.c}`, padding: "4px 9px", fontSize: 9 }}>
      {s.t}
    </span>
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
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span className="label">{label}</span>
        <span className="num" style={{ fontSize: 11.5, color: "var(--chalk)" }}>
          {value.toFixed(step < 1 ? 2 : 0)} {unit}
        </span>
      </div>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function CalibrationPrompt({ index, onUndo }: { index: number; onUndo: () => void }) {
  return (
    <div>
      <div className="label" style={{ color: "var(--gold)" }}>
        Calibration — point {index + 1} of 4
      </div>
      <p style={{ fontSize: 12.5, color: "var(--chalk)", lineHeight: 1.65, margin: "8px 0 0" }}>
        Click: <strong>{RIM_LABELS[index]}</strong>
      </p>
      <p style={{ fontSize: 11.5, color: "var(--muted)", lineHeight: 1.65, margin: "7px 0 0" }}>
        The circle is a surveyed object of known diameter, so four points on its rim pin the ground
        plane and recover the camera. Scrub to a frame where the rim is clearly visible first.
      </p>
      {index > 0 && (
        <button className="btn" style={{ marginTop: 12 }} onClick={onUndo}>
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
        padding: "58px 24px",
        textAlign: "center",
        background: "var(--ink-2)",
      }}
    >
      <div className="display" style={{ fontSize: 18, marginBottom: 10 }}>
        {decoding ?? "Drop a throw video here"}
      </div>
      <p style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.75, maxWidth: 450, margin: "0 auto 18px" }}>
        Film side-on from a tripod with the circle and the whole flight in frame. Keep the camera
        still — the background model assumes it. 60 fps or better is worth the storage.
      </p>
      <label className="btn" style={{ cursor: "pointer", display: "inline-flex" }}>
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
      {error && <p style={{ fontSize: 12, color: "var(--reject)", marginTop: 16 }}>{error}</p>}
    </div>
  );
}
