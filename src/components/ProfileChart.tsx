"use client";

/**
 * Flight profile: the measured lifting flight against the parabola the same
 * release would have flown in a vacuum.
 *
 * This chart is the argument. The gap between the two curves is not error - it
 * is the distance the plate bought with lift, and on a well-struck discus it is
 * worth double-digit metres.
 */

import { G } from "@/lib/physics";
import type { Vec3 } from "@/lib/geometry";

export type ProfileChartProps = {
  path: Vec3[];
  release: Vec3;
  releaseSpeedMs: number;
  releaseAngleDeg: number;
  vacuumRangeM: number;
  aero: boolean;
};

const W = 560;
const H = 220;
const PAD_L = 34;
const PAD_R = 14;
const PAD_T = 14;
const PAD_B = 26;

export default function ProfileChart(p: ProfileChartProps) {
  const measured = p.path.map((q) => ({
    d: Math.hypot(q.x - p.release.x, q.y - p.release.y),
    z: q.z,
  }));

  // The same release, without air.
  const rad = (p.releaseAngleDeg * Math.PI) / 180;
  const vx = p.releaseSpeedMs * Math.cos(rad);
  const vz = p.releaseSpeedMs * Math.sin(rad);
  const tEnd = (vz + Math.sqrt(Math.max(0, vz * vz + 2 * G * p.release.z))) / G;
  const vacuum: { d: number; z: number }[] = [];
  for (let i = 0; i <= 80; i++) {
    const t = (tEnd * i) / 80;
    vacuum.push({ d: vx * t, z: Math.max(0, p.release.z + vz * t - 0.5 * G * t * t) });
  }

  const maxD = Math.max(...measured.map((m) => m.d), ...vacuum.map((m) => m.d)) * 1.03;
  const maxZ = Math.max(...measured.map((m) => m.z), ...vacuum.map((m) => m.z)) * 1.14;

  const X = (d: number) => PAD_L + (d / maxD) * (W - PAD_L - PAD_R);
  const Y = (z: number) => H - PAD_B - (z / maxZ) * (H - PAD_T - PAD_B);

  const line = (pts: { d: number; z: number }[]) =>
    pts.map((q, i) => `${i === 0 ? "M" : "L"} ${X(q.d).toFixed(1)} ${Y(q.z).toFixed(1)}`).join(" ");

  const gain = measured[measured.length - 1].d - vacuum[vacuum.length - 1].d;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }} role="img"
      aria-label="Flight height against distance, measured versus vacuum">
      <defs>
        <linearGradient id="gain" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(63,217,196,0.20)" />
          <stop offset="100%" stopColor="rgba(63,217,196,0.02)" />
        </linearGradient>
      </defs>

      {[0, 0.25, 0.5, 0.75, 1].map((f) => (
        <g key={f}>
          <line
            x1={PAD_L}
            y1={Y(maxZ * f)}
            x2={W - PAD_R}
            y2={Y(maxZ * f)}
            stroke="rgba(232,237,234,0.07)"
            strokeWidth="1"
          />
          <text
            x={PAD_L - 6}
            y={Y(maxZ * f) + 3}
            fill="rgba(120,135,139,0.9)"
            fontSize="8"
            fontFamily="ui-monospace, monospace"
            textAnchor="end"
          >
            {(maxZ * f).toFixed(0)}
          </text>
        </g>
      ))}

      <path d={`${line(measured)} L ${X(measured[measured.length - 1].d)} ${Y(0)} L ${X(0)} ${Y(0)} Z`} fill="url(#gain)" />

      <path d={line(vacuum)} fill="none" stroke="rgba(232,237,234,0.42)" strokeWidth="1.4" strokeDasharray="4 4" />
      <path d={line(measured)} fill="none" stroke="#3fd9c4" strokeWidth="2" />

      <circle cx={X(measured[measured.length - 1].d)} cy={Y(0)} r="3.5" fill="#3fd9c4" />
      <circle cx={X(vacuum[vacuum.length - 1].d)} cy={Y(0)} r="3" fill="rgba(232,237,234,0.55)" />

      {p.aero && Math.abs(gain) > 0.4 && (
        <>
          <line
            x1={X(vacuum[vacuum.length - 1].d)}
            y1={Y(0) - 4}
            x2={X(measured[measured.length - 1].d)}
            y2={Y(0) - 4}
            stroke="#3fd9c4"
            strokeWidth="1"
          />
          <text
            x={(X(vacuum[vacuum.length - 1].d) + X(measured[measured.length - 1].d)) / 2}
            y={Y(0) - 9}
            fill="#3fd9c4"
            fontSize="9"
            fontFamily="ui-monospace, monospace"
            textAnchor="middle"
          >
            {gain > 0 ? "+" : ""}
            {gain.toFixed(1)} m
          </text>
        </>
      )}

      <text x={PAD_L} y={H - 8} fill="rgba(120,135,139,0.9)" fontSize="8" fontFamily="ui-monospace, monospace">
        0
      </text>
      <text
        x={W - PAD_R}
        y={H - 8}
        fill="rgba(120,135,139,0.9)"
        fontSize="8"
        fontFamily="ui-monospace, monospace"
        textAnchor="end"
      >
        {maxD.toFixed(0)} m
      </text>

      <g transform={`translate(${PAD_L + 6}, ${PAD_T + 4})`}>
        <line x1="0" y1="0" x2="16" y2="0" stroke="#3fd9c4" strokeWidth="2" />
        <text x="21" y="3" fill="rgba(232,237,234,0.8)" fontSize="8.5" fontFamily="ui-monospace, monospace">
          measured flight
        </text>
        <line x1="0" y1="12" x2="16" y2="12" stroke="rgba(232,237,234,0.42)" strokeWidth="1.4" strokeDasharray="4 4" />
        <text x="21" y="15" fill="rgba(232,237,234,0.55)" fontSize="8.5" fontFamily="ui-monospace, monospace">
          same release, no air
        </text>
      </g>
    </svg>
  );
}
