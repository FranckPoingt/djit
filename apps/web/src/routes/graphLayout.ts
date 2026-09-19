import type { GraphNode } from "api-client";
import type { EdgeType } from "../hooks/useGraph";

type ParsedCamelot = {
  num: number;
  mode: "A" | "B";
};

export type GraphPosition = {
  x: number;
  y: number;
};

export type FocusCompatibility =
  | "exact"
  | "compatible"
  | "unknown-bpm"
  | "bpm-mismatch"
  | "key-mismatch"
  | "unknown-key";

export type MixCandidate = {
  track: GraphNode;
  relation: "Same key" | "Relative" | "Adjacent";
  bpmDifference: number;
  score: number;
};

export type MixDirection = "build_up" | "cruise" | "cooldown";

const FULL_TURN = Math.PI * 2;
const SECTOR_ANGLE = FULL_TURN / 12;
const OUTER_BASE_RADIUS = 4.8;
const INNER_BASE_RADIUS = 2;
const BPM_RADIUS_SPAN = 0.9;
const SAME_KEY_LAYER_RADIUS = 0.24;
const UNKNOWN_ROW_Y = 6.2;
const UNKNOWN_ROW_WIDTH = 8;
const UNKNOWN_COLUMN_GAP = 1.05;
const UNKNOWN_ROW_GAP = 0.85;

export const DEFAULT_ACTIVE_EDGE_TYPES: EdgeType[] = ["key", "bpm"];

export function parseCamelot(
  key: string | null | undefined,
): ParsedCamelot | null {
  if (!key) return null;
  const normalized = key.trim().toUpperCase();
  if (normalized.length < 2) return null;
  const mode = normalized.slice(-1);
  const num = Number(normalized.slice(0, -1));
  if (
    !Number.isFinite(num) ||
    num < 1 ||
    num > 12 ||
    (mode !== "A" && mode !== "B")
  ) {
    return null;
  }
  return { num, mode } as ParsedCamelot;
}

export function getHarmonicCompanionKeys(
  key: string | null | undefined,
): string[] {
  const parsed = parseCamelot(key);
  if (!parsed) return [];
  const previous = parsed.num === 1 ? 12 : parsed.num - 1;
  const next = parsed.num === 12 ? 1 : parsed.num + 1;
  return [
    `${parsed.num}${parsed.mode}`,
    `${parsed.num}${parsed.mode === "A" ? "B" : "A"}`,
    `${previous}${parsed.mode}`,
    `${next}${parsed.mode}`,
  ];
}

export function isWithinBpmTolerance(
  leftBpm: number | null | undefined,
  rightBpm: number | null | undefined,
  tolerance: number,
): boolean {
  if (
    leftBpm == null ||
    rightBpm == null ||
    !Number.isFinite(leftBpm) ||
    !Number.isFinite(rightBpm)
  ) {
    return false;
  }
  const average = (leftBpm + rightBpm) / 2;
  if (average <= 0) return false;
  const percentDiff = (Math.abs(leftBpm - rightBpm) / average) * 100;
  return percentDiff <= tolerance;
}

export function getTrackCompatibility(
  anchor: GraphNode | null | undefined,
  candidate: GraphNode | null | undefined,
  bpmTolerance: number,
): FocusCompatibility {
  if (!anchor || !candidate) return "unknown-key";
  if (anchor.id === candidate.id) return "exact";

  const left = parseCamelot(anchor.key_camelot);
  const right = parseCamelot(candidate.key_camelot);
  if (!left || !right) return "unknown-key";

  const sameKey = left.num === right.num && left.mode === right.mode;
  const relative = left.num === right.num && left.mode !== right.mode;
  const adjacent =
    left.mode === right.mode &&
    (Math.abs(left.num - right.num) === 1 ||
      Math.abs(left.num - right.num) === 11);

  if (!sameKey && !relative && !adjacent) return "key-mismatch";
  if (anchor.bpm == null || candidate.bpm == null) return "unknown-bpm";

  return isWithinBpmTolerance(anchor.bpm, candidate.bpm, bpmTolerance)
    ? "compatible"
    : "bpm-mismatch";
}

export function rankMixCandidates(
  anchor: GraphNode | null | undefined,
  nodes: GraphNode[],
  bpmTolerance: number,
  direction: MixDirection = "cruise",
): MixCandidate[] {
  const anchorKey = parseCamelot(anchor?.key_camelot);
  if (!anchor || !anchorKey || anchor.bpm == null) return [];

  return nodes
    .filter(
      (track) =>
        track.id !== anchor.id &&
        getTrackCompatibility(anchor, track, bpmTolerance) === "compatible",
    )
    .map((track) => {
      const key = parseCamelot(track.key_camelot)!;
      const relation =
        key.num === anchorKey.num
          ? key.mode === anchorKey.mode
            ? "Same key"
            : "Relative"
          : "Adjacent";
      const bpmDifference =
        (Math.abs(track.bpm! - anchor.bpm!) /
          ((track.bpm! + anchor.bpm!) / 2)) *
        100;
      const relationPenalty =
        relation === "Same key" ? 0 : relation === "Relative" ? 4 : 8;
      const score = Math.max(
        0,
        Math.round(
          100 -
            relationPenalty -
            (bpmDifference / Math.max(bpmTolerance, 1)) * 20,
        ),
      );
      return {
        track,
        relation,
        bpmDifference: Number(bpmDifference.toFixed(1)),
        score,
      } satisfies MixCandidate;
    })
    .sort((left, right) => {
      if (direction !== "cruise") {
        const sign = direction === "build_up" ? 1 : -1;
        const directionFit = (candidate: MixCandidate) =>
          (((candidate.track.bpm! - anchor.bpm!) / anchor.bpm!) * 100 +
            (anchor.energy != null && candidate.track.energy != null
              ? (candidate.track.energy - anchor.energy) * 0.75
              : 0)) *
          sign;
        const directionDifference = directionFit(right) - directionFit(left);
        if (directionDifference !== 0) return directionDifference;
      }
      return right.score - left.score || left.track.id - right.track.id;
    });
}

function compareNodes(left: GraphNode, right: GraphNode): number {
  const leftBpm = left.bpm ?? Number.POSITIVE_INFINITY;
  const rightBpm = right.bpm ?? Number.POSITIVE_INFINITY;
  if (leftBpm !== rightBpm) return leftBpm - rightBpm;
  return left.id - right.id;
}

function toPolar(radius: number, angle: number): GraphPosition {
  const rotated = angle - Math.PI / 2;
  return {
    x: Number((Math.cos(rotated) * radius).toFixed(4)),
    y: Number((-Math.sin(rotated) * radius).toFixed(4)),
  };
}

function normalizeBpm(nodes: GraphNode[]): { min: number; max: number } | null {
  const bpms = nodes
    .map((node) => node.bpm)
    .filter((bpm): bpm is number => bpm != null && Number.isFinite(bpm));
  if (bpms.length === 0) return null;
  return { min: Math.min(...bpms), max: Math.max(...bpms) };
}

function getBpmFraction(
  node: GraphNode,
  range: { min: number; max: number } | null,
) {
  if (!range || node.bpm == null || !Number.isFinite(node.bpm)) return 0.5;
  if (range.max === range.min) return 0.5;
  return Math.max(
    0,
    Math.min(1, (node.bpm - range.min) / (range.max - range.min)),
  );
}

function spreadOffset(index: number, step: number): number {
  if (index === 0) return 0;
  const layer = Math.ceil(index / 2);
  const direction = index % 2 === 1 ? -1 : 1;
  return direction * layer * step;
}

export function buildCamelotLayout(
  nodes: GraphNode[],
): Map<number, GraphPosition> {
  const positions = new Map<number, GraphPosition>();
  const bpmRange = normalizeBpm(nodes);
  const keyedGroups = new Map<string, GraphNode[]>();
  const unknownNodes: GraphNode[] = [];

  for (const node of nodes) {
    const parsed = parseCamelot(node.key_camelot);
    if (!parsed) {
      unknownNodes.push(node);
      continue;
    }
    const key = `${parsed.num}${parsed.mode}`;
    const bucket = keyedGroups.get(key) ?? [];
    bucket.push(node);
    keyedGroups.set(key, bucket);
  }

  for (const [key, group] of keyedGroups) {
    const parsed = parseCamelot(key);
    if (!parsed) continue;

    const baseAngle = (parsed.num - 1) * SECTOR_ANGLE;
    const baseRadius =
      parsed.mode === "A" ? INNER_BASE_RADIUS : OUTER_BASE_RADIUS;

    [...group].sort(compareNodes).forEach((node, indexWithinKey) => {
      const bpmFraction = getBpmFraction(node, bpmRange);
      const radialOffset = (bpmFraction - 0.5) * BPM_RADIUS_SPAN;
      const radialLayer =
        Math.floor(indexWithinKey / 6) * SAME_KEY_LAYER_RADIUS;
      const angularJitter = spreadOffset(
        indexWithinKey % 6,
        SECTOR_ANGLE * 0.032,
      );
      const position = toPolar(
        baseRadius + radialOffset + radialLayer,
        baseAngle + angularJitter,
      );
      positions.set(node.id, position);
    });
  }

  unknownNodes
    .slice()
    .sort(compareNodes)
    .forEach((node, index) => {
      const column = index % UNKNOWN_ROW_WIDTH;
      const row = Math.floor(index / UNKNOWN_ROW_WIDTH);
      const centeredColumn = column - (UNKNOWN_ROW_WIDTH - 1) / 2;
      positions.set(node.id, {
        x: Number((centeredColumn * UNKNOWN_COLUMN_GAP).toFixed(4)),
        y: Number((-(UNKNOWN_ROW_Y + row * UNKNOWN_ROW_GAP)).toFixed(4)),
      });
    });

  return positions;
}
