"use client";

/**
 * The readout.
 *
 * Rule followed throughout: never print a number to more precision than the
 * method earns. Where an uncertainty band exists it is shown next to the value,
 * not tucked into a footnote, because a coach deciding whether to change a cue
 * needs to know whether 0.4 m/s is a result or a rounding artefact.
 */

import type { ThrowMetrics } from "@/lib/solve";

export type MetricsProps = {
  m: ThrowMetrics;
  speedRange: [number, number] | null;
  distanceRange: [number, number] | null;
  heightRange: [number, number] | null;
  truth?: {
    releaseSpeedMs: number;
    releaseAngleDeg: number;
    releaseHeightM: number;
    officialDistanceM: number;
  } | null;
};

function band(r: [number, number] | null, dp: number): string | null {
  if (!r) return null;
  const half = (r[1] - r[0]) / 2;
  if (!isFinite(half) || half < 0.005) return null;
  return "±" + half.toFixed(dp);
}

function Tile({
  label,
  value,
  unit,
  sub,
  accent,
  delay,
}: {
  label: string;
  value: string;
  unit?: string;
  sub?: string | null;
  accent?: "signal" | "verify" | "warn" | "bad";
  delay: number;
}) {
  const colour =
    accent === "signal"
      ? "var(--signal)"
      : accent === "warn"
        ? "var(--warn)"
        : accent === "bad"
          ? "var(--bad)"
          : accent === "verify"
            ? "var(--verify)"
            : "var(--chalk)";
  return (
    <div
      className="settle"
      style={{
        padding: "13px 14px",
        borderRadius: 11,
        background: "var(--ink-2)",
        border: "1px solid var(--line)",
        animationDelay: `${delay}ms`,
      }}
    >
      <div className="label">{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 5, marginTop: 7 }}>
        <span className="num display" style={{ fontSize: 25, color: colour, lineHeight: 1 }}>
          {value}
        </span>
        {unit && (
          <span className="num" style={{ fontSize: 11, color: "var(--muted)" }}>
            {unit}
          </span>
        )}
      </div>
      {sub && (
        <div className="num" style={{ fontSize: 10, color: "var(--muted-2)", marginTop: 5 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

export default function Metrics({ m, speedRange, distanceRange, heightRange, truth }: MetricsProps) {
  const err = (got: number, want: number, dp: number) =>
    truth ? `truth ${want.toFixed(dp)} · err ${(got - want >= 0 ? "+" : "") + (got - want).toFixed(dp)}` : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(148px, 1fr))",
          gap: 10,
        }}
      >
        <Tile
          label="Release velocity"
          value={m.releaseSpeedMs.toFixed(1)}
          unit="m/s"
          accent="verify"
          delay={0}
          sub={err(m.releaseSpeedMs, truth?.releaseSpeedMs ?? 0, 2) ?? band(speedRange, 1)}
        />
        <Tile
          label="Release angle"
          value={m.releaseAngleDeg.toFixed(1)}
          unit="°"
          accent="verify"
          delay={40}
          sub={
            err(m.releaseAngleDeg, truth?.releaseAngleDeg ?? 0, 2) ??
            `optimum ${m.optimalAngleDeg.toFixed(1)}° · ${m.angleErrorDeg >= 0 ? "+" : ""}${m.angleErrorDeg.toFixed(1)}°`
          }
        />
        <Tile
          label="Release height"
          value={m.releaseHeightM.toFixed(2)}
          unit="m"
          accent="verify"
          delay={80}
          sub={err(m.releaseHeightM, truth?.releaseHeightM ?? 0, 2) ?? (band(heightRange, 2) ?? "measured, not assumed")}
        />
        <Tile
          label="Rule 32 distance"
          value={m.officialDistanceM.toFixed(2)}
          unit="m"
          accent="signal"
          delay={120}
          sub={err(m.officialDistanceM, truth?.officialDistanceM ?? 0, 2) ?? band(distanceRange, 2)}
        />
        <Tile
          label="Flight time"
          value={m.flightTimeS.toFixed(2)}
          unit="s"
          delay={160}
          sub={`apex ${m.apexM.toFixed(1)} m`}
        />
        <Tile
          label="Sector deviation"
          value={(m.sectorDeviationDeg >= 0 ? "+" : "") + m.sectorDeviationDeg.toFixed(1)}
          unit="°"
          accent={m.legalSector ? (Math.abs(m.sectorDeviationDeg) > 12 ? "warn" : undefined) : "bad"}
          delay={200}
          sub={
            m.legalSector
              ? `${m.sectorMarginDeg.toFixed(1)}° of margin to the line`
              : "OUT OF SECTOR — foul"
          }
        />
        <Tile
          label="Aero efficiency"
          value={m.aeroEfficiency.toFixed(3)}
          unit="×"
          accent={m.aeroEfficiency > 1 ? "verify" : undefined}
          delay={240}
          sub={`vacuum range ${m.vacuumRangeM.toFixed(1)} m`}
        />
        {m.attitudeDeg !== null && (
          <Tile
            label="Plate attitude"
            value={m.attitudeDeg.toFixed(1)}
            unit="°"
            delay={280}
            sub="inferred from flight"
          />
        )}
      </div>

      {/* The comparison that justifies the whole approach. */}
      {m.model === "aerodynamic" && (
        <div
          style={{
            padding: "12px 14px",
            borderRadius: 11,
            border: "1px solid rgba(255,197,61,0.22)",
            background: "rgba(255,197,61,0.05)",
          }}
        >
          <div className="label" style={{ color: "var(--warn)" }}>
            What a parabola tracker would have told you
          </div>
          <div
            className="num"
            style={{ fontSize: 12.5, color: "var(--chalk)", marginTop: 7, lineHeight: 1.65 }}
          >
            {m.ballisticComparison.releaseSpeedMs.toFixed(1)} m/s ·{" "}
            {m.ballisticComparison.officialDistanceM.toFixed(1)} m
            <span style={{ color: "var(--muted)" }}>
              {"  →  off by "}
              {(m.ballisticComparison.releaseSpeedMs - m.releaseSpeedMs >= 0 ? "+" : "") +
                (m.ballisticComparison.releaseSpeedMs - m.releaseSpeedMs).toFixed(1)}{" "}
              m/s and{" "}
              {(m.ballisticComparison.officialDistanceM - m.officialDistanceM >= 0 ? "+" : "") +
                (m.ballisticComparison.officialDistanceM - m.officialDistanceM).toFixed(1)}{" "}
              m
            </span>
          </div>
          <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 6, lineHeight: 1.6 }}>
            A discus is an airfoil, not a projectile. Fit it with a parabola and the optimiser
            inflates release speed until the curve happens to match the pixels — with a
            respectable-looking residual and a badly wrong answer.
          </div>
        </div>
      )}

      {m.windCounterfactual.length > 0 && (
        <div style={{ padding: "12px 14px", borderRadius: 11, background: "var(--ink-2)", border: "1px solid var(--line)" }}>
          <div className="label">Same release, different wind</div>
          <div style={{ display: "flex", gap: 6, marginTop: 10, alignItems: "flex-end" }}>
            {m.windCounterfactual.map((w) => {
              const best = Math.max(...m.windCounterfactual.map((x) => x.rangeM));
              const worst = Math.min(...m.windCounterfactual.map((x) => x.rangeM));
              const f = best > worst ? (w.rangeM - worst) / (best - worst) : 0.5;
              return (
                <div key={w.headwindMs} style={{ flex: 1, textAlign: "center" }}>
                  <div
                    style={{
                      height: 8 + f * 44,
                      borderRadius: 4,
                      background:
                        w.headwindMs === 0
                          ? "var(--signal)"
                          : `rgba(63,217,196,${(0.25 + f * 0.6).toFixed(2)})`,
                    }}
                  />
                  <div className="num" style={{ fontSize: 9, color: "var(--muted)", marginTop: 5 }}>
                    {w.rangeM.toFixed(0)}
                  </div>
                  <div className="num" style={{ fontSize: 8.5, color: "var(--muted-2)" }}>
                    {w.headwindMs > 0 ? `+${w.headwindMs}` : w.headwindMs}
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 9, lineHeight: 1.55 }}>
            Headwind is positive. A discus gains distance into a moderate headwind — what matters is
            airspeed over the plate, not groundspeed.
          </div>
        </div>
      )}

      {m.notes.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {m.notes.map((n, i) => (
            <div
              key={i}
              style={{
                fontSize: 11.5,
                color: "var(--muted)",
                lineHeight: 1.6,
                paddingLeft: 11,
                borderLeft: "2px solid var(--line-strong)",
              }}
            >
              {n}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
