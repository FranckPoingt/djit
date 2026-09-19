/**
 * CamelotWheel — read-only Camelot wheel SVG visualisation.
 *
 * - Outer ring: major keys (xB)
 * - Inner ring: minor keys (xA)
 * - Highlighted segments: keys passed via `highlightedKeys` prop
 */
import { useMemo } from "react";

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
const SEGMENT_COUNT = 12;

// Camelot colours — mapped by number (1–12) using the classic Mixed in Key palette
const SEGMENT_COLORS: Record<number, string> = {
  1: "#f5c518", // yellow
  2: "#f5a623", // amber
  3: "#f47b20", // orange
  4: "#e8523a", // red-orange
  5: "#d0021b", // red
  6: "#9b59b6", // purple
  7: "#3498db", // blue
  8: "#1a9bc4", // teal-blue
  9: "#1abc9c", // teal
  10: "#27ae60", // green
  11: "#8bc34a", // lime
  12: "#cddc39", // yellow-green
};

type RingSegment = {
  number: number; // 1–12
  mode: "A" | "B"; // A = minor (inner), B = major (outer)
  label: string; // e.g. "4A"
  note: string; // musical note name abbreviation
};

// Full label map (Mixed in Key canonical mapping)
const MUSICAL_NOTES: Record<string, string> = {
  "1A": "Am",
  "1B": "C",
  "2A": "Em",
  "2B": "G",
  "3A": "Bm",
  "3B": "D",
  "4A": "F#m",
  "4B": "A",
  "5A": "C#m",
  "5B": "E",
  "6A": "G#m",
  "6B": "B",
  "7A": "Ebm",
  "7B": "F#",
  "8A": "Bbm",
  "8B": "Db",
  "9A": "Fm",
  "9B": "Ab",
  "10A": "Cm",
  "10B": "Eb",
  "11A": "Gm",
  "11B": "Bb",
  "12A": "Dm",
  "12B": "F",
};

function buildSegments(): RingSegment[] {
  const segs: RingSegment[] = [];
  for (let n = 1; n <= 12; n++) {
    for (const mode of ["A", "B"] as const) {
      const label = `${n}${mode}`;
      segs.push({ number: n, mode, label, note: MUSICAL_NOTES[label] ?? "" });
    }
  }
  return segs;
}

const ALL_SEGMENTS = buildSegments();

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;
const FULL = 2 * Math.PI;
const SLICE = FULL / SEGMENT_COUNT; // radians per Camelot number

/** Polar to cartesian. Angle 0 = top (12 o'clock). */
function polar(cx: number, cy: number, r: number, angle: number) {
  const a = angle - Math.PI / 2; // rotate so 0 = top
  return {
    x: cx + r * Math.cos(a),
    y: cy + r * Math.sin(a),
  };
}

/** SVG arc path for one segment. */
function arcPath(
  cx: number,
  cy: number,
  r1: number,
  r2: number,
  startAngle: number,
  endAngle: number,
  gap = 0.025, // radians of gap between segments
): string {
  const sa = startAngle + gap / 2;
  const ea = endAngle - gap / 2;
  const p1 = polar(cx, cy, r1, sa);
  const p2 = polar(cx, cy, r2, sa);
  const p3 = polar(cx, cy, r2, ea);
  const p4 = polar(cx, cy, r1, ea);
  const largeArc = ea - sa > Math.PI ? 1 : 0;
  return [
    `M ${p1.x} ${p1.y}`,
    `L ${p2.x} ${p2.y}`,
    `A ${r2} ${r2} 0 ${largeArc} 1 ${p3.x} ${p3.y}`,
    `L ${p4.x} ${p4.y}`,
    `A ${r1} ${r1} 0 ${largeArc} 0 ${p1.x} ${p1.y}`,
    "Z",
  ].join(" ");
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type CamelotWheelProps = {
  /** Camelot key strings to highlight (e.g. ["4A", "5A"]) */
  highlightedKeys?: string[];
  /** Diameter in px */
  size?: number;
};

export const CamelotWheel = ({
  highlightedKeys = [],
  size = 300,
}: CamelotWheelProps) => {
  const cx = size / 2;
  const cy = size / 2;
  const outerR = size * 0.48;
  const midR = size * 0.32;
  const innerR = size * 0.14;

  const highlightSet = useMemo(
    () => new Set(highlightedKeys.map((k) => k.trim().toUpperCase())),
    [highlightedKeys],
  );

  const rendered = useMemo(() => {
    return ALL_SEGMENTS.map((seg) => {
      const startAngle = ((seg.number - 1) / SEGMENT_COUNT) * FULL;
      const endAngle = (seg.number / SEGMENT_COUNT) * FULL;
      const midAngle = (startAngle + endAngle) / 2;

      const isOuter = seg.mode === "B";
      const r1 = isOuter ? midR : innerR;
      const r2 = isOuter ? outerR : midR;

      const highlighted = highlightSet.has(seg.label);
      const baseColor = SEGMENT_COLORS[seg.number] ?? "#888";
      const fill = highlighted ? baseColor : `${baseColor}55`;
      const stroke = highlighted ? "#fff" : "rgba(255,255,255,0.15)";
      const strokeWidth = highlighted ? 1.5 : 0.5;

      const labelR = (r1 + r2) / 2;
      const labelPos = polar(cx, cy, labelR, midAngle);

      const numR = labelR + (isOuter ? -10 : 10) * (size / 300);
      const numPos = polar(cx, cy, numR, midAngle);

      const fontSize = size * 0.038;
      const numFontSize = size * 0.028;

      const path = arcPath(cx, cy, r1, r2, startAngle, endAngle);

      return (
        <g key={seg.label}>
          <path
            d={path}
            fill={fill}
            stroke={stroke}
            strokeWidth={strokeWidth}
          />
          {/* Camelot label e.g. "4A" */}
          <text
            x={labelPos.x}
            y={labelPos.y}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize={fontSize}
            fontWeight={highlighted ? 700 : 400}
            fill={highlighted ? "#fff" : "rgba(255,255,255,0.75)"}
            style={{ fontFamily: "var(--font-label)", userSelect: "none" }}
          >
            {seg.label}
          </text>
          {/* Musical note */}
          <text
            x={numPos.x}
            y={numPos.y + fontSize * 0.9}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize={numFontSize}
            fill={
              highlighted ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.45)"
            }
            style={{ fontFamily: "var(--font-mono)", userSelect: "none" }}
          >
            {seg.note}
          </text>
        </g>
      );
    });
  }, [cx, cy, outerR, midR, innerR, highlightSet, size]);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-label="Camelot Wheel"
    >
      {/* dark background disc */}
      <circle cx={cx} cy={cy} r={outerR + 2} fill="#1a1a1f" />
      {rendered}
      {/* inner hub */}
      <circle cx={cx} cy={cy} r={innerR} fill="#111113" />
      <text
        x={cx}
        y={cy}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={size * 0.055}
        fontWeight={700}
        fill="rgba(255,255,255,0.35)"
        style={{ fontFamily: "var(--font-label)", userSelect: "none" }}
      >
        KEY
      </text>
    </svg>
  );
};

export default CamelotWheel;
