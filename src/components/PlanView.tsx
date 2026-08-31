"use client";

/**
 * Plan view - the sector from above.
 *
 * Distance is only half of a throw. The other half is where in the 34.92 degree
 * wedge it landed, because every degree off the centreline is margin an athlete
 * is spending against the sector line without getting anything back for it.
 */

import { SECTOR_ANGLE_DEG, type Vec2 } from "@/lib/geometry";

export type PlanViewProps = {
  landing: Vec2 | null;
  circleCentre: Vec2;
  centrelineDeg: number;
  officialDistanceM: number;
  deviationDeg: number;
  legal: boolean;
};

const W = 340;
const H = 300;

export default function PlanView(p: PlanViewProps) {
  const maxDist = Math.max(20, Math.ceil(((p.officialDistanceM || 60) * 1.18) / 10) * 10);
  const originX = W / 2;
  const originY = H - 26;
  const scale = (H - 56) / maxDist;

  // Sector opens upward on screen; world bearing 0 maps to screen "up".
  const toXY = (distM: number, bearingDeg: number) => {
    const a = ((bearingDeg - p.centrelineDeg) * Math.PI) / 180;
    return {
      x: originX + Math.sin(a) * distM * scale,
      y: originY - Math.cos(a) * distM * scale,
    };
  };

  const half = SECTOR_ANGLE_DEG / 2;
  const left = toXY(maxDist, p.centrelineDeg - half);
  const right = toXY(maxDist, p.centrelineDeg + half);

  const rings: number[] = [];
  for (let d = 10; d <= maxDist; d += 10) rings.push(d);

  const landingPt =
    p.landing && p.officialDistanceM > 0
      ? toXY(p.officialDistanceM, p.centrelineDeg + p.deviationDeg)
      : null;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }} role="img"
      aria-label="Plan view of the throwing sector with the landing point">
      <defs>
        <linearGradient id="sectorFill" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor="rgba(63,217,196,0.16)" />
          <stop offset="100%" stopColor="rgba(63,217,196,0.02)" />
        </linearGradient>
      </defs>

      <path
        d={`M ${originX} ${originY} L ${left.x} ${left.y} A ${maxDist * scale} ${maxDist * scale} 0 0 1 ${right.x} ${right.y} Z`}
        fill="url(#sectorFill)"
        stroke="rgba(63,217,196,0.35)"
        strokeWidth="1"
      />

      {rings.map((d) => {
        const l = toXY(d, p.centrelineDeg - half);
        const r = toXY(d, p.centrelineDeg + half);
        return (
          <g key={d}>
            <path
              d={`M ${l.x} ${l.y} A ${d * scale} ${d * scale} 0 0 1 ${r.x} ${r.y}`}
              fill="none"
              stroke="rgba(232,237,234,0.10)"
              strokeWidth="1"
            />
            <text
              x={r.x + 5}
              y={r.y + 3}
              fill="rgba(120,135,139,0.9)"
              fontSize="8"
              fontFamily="ui-monospace, monospace"
            >
              {d}
            </text>
          </g>
        );
      })}

      <line
        x1={originX}
        y1={originY}
        x2={toXY(maxDist, p.centrelineDeg).x}
        y2={toXY(maxDist, p.centrelineDeg).y}
        stroke="rgba(232,237,234,0.22)"
        strokeWidth="1"
        strokeDasharray="3 5"
      />

      {landingPt && (
        <>
          <line
            x1={originX}
            y1={originY}
            x2={landingPt.x}
            y2={landingPt.y}
            stroke={p.legal ? "rgba(255,107,26,0.55)" : "rgba(255,77,77,0.6)"}
            strokeWidth="1.2"
          />
          <circle
            cx={landingPt.x}
            cy={landingPt.y}
            r="11"
            fill="none"
            stroke={p.legal ? "rgba(255,107,26,0.35)" : "rgba(255,77,77,0.45)"}
            strokeWidth="1"
          />
          <circle cx={landingPt.x} cy={landingPt.y} r="4" fill={p.legal ? "#ff6b1a" : "#ff4d4d"} />
        </>
      )}

      <circle cx={originX} cy={originY} r="7" fill="none" stroke="rgba(232,237,234,0.5)" strokeWidth="1.4" />
      <text
        x={originX}
        y={originY + 20}
        fill="rgba(120,135,139,0.95)"
        fontSize="8"
        fontFamily="ui-monospace, monospace"
        textAnchor="middle"
        letterSpacing="1"
      >
        CIRCLE
      </text>
      <text
        x={10}
        y={16}
        fill="rgba(120,135,139,0.95)"
        fontSize="8.5"
        fontFamily="ui-monospace, monospace"
        letterSpacing="1"
      >
        SECTOR {SECTOR_ANGLE_DEG}°
      </text>
    </svg>
  );
}
