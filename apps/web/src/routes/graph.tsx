import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { createRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import Sigma from "sigma";
import Graph from "graphology";
import { createNodeImageProgram } from "@sigma/node-image";
import type {
  GraphNode,
  GraphEdge,
  PaginatedTracksResponse,
  TrackSummary,
} from "api-client";
import CamelotWheel from "../components/playlists/CamelotWheel";
import {
  TrackMetadataEditor,
  type TrackMetadataPatch,
} from "../components/tracks/TrackMetadataEditor";
import { useGraph, type EdgeType } from "../hooks/useGraph";
import {
  useAddTracksToPlaylist,
  useCreatePlaylist,
  useDeletePlaylist,
  useHarmonizePlaylist,
  usePlaylistDetail,
  usePlaylists,
  useOrderPlaylist,
  useFindPlaylistPath,
  type HarmonizePlaylistRequest,
  type OrderPlaylistRequest,
} from "../hooks/usePlaylists";
import { useLibraryStore } from "../stores/libraryStore";
import { useUpdateTrack } from "../hooks/useUpdateTrack";
import {
  buildCamelotLayout,
  DEFAULT_ACTIVE_EDGE_TYPES,
  getHarmonicCompanionKeys,
  getTrackCompatibility,
  parseCamelot,
  rankMixCandidates,
} from "./graphLayout";
import { rootRoute } from "./__root";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EDGE_COLORS: Record<EdgeType, string> = {
  key: "#7c3aed", // violet — harmonic
  bpm: "#0ea5e9", // sky — tempo
  genre: "#16a34a", // green — genre
  energy: "#f59e0b", // amber — energy
  mood: "#ec4899", // pink — mood
  artist: "#64748b", // slate — artist
};

type RouteProfile = "build_up" | "cruise" | "cooldown";

function invertProfile(profile: RouteProfile): RouteProfile {
  if (profile === "build_up") return "cooldown";
  if (profile === "cooldown") return "build_up";
  return "cruise";
}

const GENRE_PALETTE = [
  "#7c3aed",
  "#0ea5e9",
  "#16a34a",
  "#f59e0b",
  "#ec4899",
  "#ef4444",
  "#06b6d4",
  "#84cc16",
  "#f97316",
  "#a855f7",
];

const KEY_COLORS: Record<string, string> = {
  "1A": "#6d28d9",
  "2A": "#7c3aed",
  "3A": "#8b5cf6",
  "4A": "#a78bfa",
  "5A": "#818cf8",
  "6A": "#60a5fa",
  "7A": "#38bdf8",
  "8A": "#22d3ee",
  "9A": "#2dd4bf",
  "10A": "#34d399",
  "11A": "#4ade80",
  "12A": "#86efac",
  "1B": "#e879f9",
  "2B": "#f472b6",
  "3B": "#fb7185",
  "4B": "#f87171",
  "5B": "#fb923c",
  "6B": "#fbbf24",
  "7B": "#a3e635",
  "8B": "#4ade80",
  "9B": "#34d399",
  "10B": "#2dd4bf",
  "11B": "#38bdf8",
  "12B": "#818cf8",
};

const DISCOVERY_LIMIT = 60;
const DISCOVERY_POOL_LIMIT = 5000;
const DISCOVERY_BPM_TOLERANCE = 5;
const DISCOVERY_DECISIONS = new Set(["unheard", "keep", "maybe"]);

type DiscoveryScope = {
  seed: TrackSummary;
  trackIds: number[];
};

function discoveryTrackParams(limit: number): URLSearchParams {
  const params = new URLSearchParams({ limit: String(limit) });
  for (const status of ["done", "overridden"])
    params.append("analysis_status", status);
  return params;
}

async function fetchTrackPage(
  params: URLSearchParams,
): Promise<PaginatedTracksResponse> {
  const response = await fetch(`/api/v1/tracks?${params}`);
  if (!response.ok) throw new Error("Failed to load discovery tracks");
  return response.json();
}

async function fetchDiscoveryPool(): Promise<TrackSummary[]> {
  return (
    await fetchTrackPage(discoveryTrackParams(DISCOVERY_POOL_LIMIT))
  ).items.filter((track) => track.bpm != null && track.key_camelot != null);
}

function searchDiscoveryTracks(
  tracks: TrackSummary[],
  query: string,
): TrackSummary[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  return tracks
    .filter(
      (track) =>
        track.title.toLowerCase().includes(normalized) ||
        track.artist.toLowerCase().includes(normalized),
    )
    .slice(0, 8);
}

function buildDiscoveryScope(
  seed: TrackSummary,
  tracks: TrackSummary[],
): DiscoveryScope {
  if (seed.bpm == null || !seed.key_camelot)
    return { seed, trackIds: [seed.id] };

  const seedBpm = seed.bpm;
  const bpmDelta = seedBpm * (DISCOVERY_BPM_TOLERANCE / 100);
  const compatibleKeys = new Set(getHarmonicCompanionKeys(seed.key_camelot));
  const candidates = new Map<number, TrackSummary>([[seed.id, seed]]);
  for (const track of tracks)
    if (
      DISCOVERY_DECISIONS.has(track.triage_decision) &&
      track.bpm != null &&
      Math.abs(track.bpm - seedBpm) <= bpmDelta &&
      track.key_camelot &&
      compatibleKeys.has(track.key_camelot)
    )
      candidates.set(track.id, track);

  const trackIds = [...candidates.values()]
    .sort(
      (left, right) =>
        Math.abs((left.bpm ?? seedBpm) - seedBpm) -
          Math.abs((right.bpm ?? seedBpm) - seedBpm) ||
        left.id - right.id,
    )
    .slice(0, DISCOVERY_LIMIT)
    .map((track) => track.id);

  return { seed, trackIds };
}

function randomDiscoveryScope(tracks: TrackSummary[]): DiscoveryScope {
  const choices = tracks.filter((track) =>
    DISCOVERY_DECISIONS.has(track.triage_decision),
  );
  const seed = choices[Math.floor(Math.random() * choices.length)];
  if (!seed) throw new Error("No analyzed tracks available for discovery");
  return buildDiscoveryScope(seed, tracks);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deriveNodeColor(node: GraphNode): string {
  return node.key_camelot
    ? (KEY_COLORS[node.key_camelot] ?? "#94a3b8")
    : "#94a3b8";
}

function deriveNodeSize(_node: GraphNode): number {
  return 6;
}

function formatTrackOptionLabel(node: GraphNode): string {
  return `${node.title} — ${node.artist} (#${node.id})`;
}

function findLocalPath(
  edges: GraphEdge[],
  startId: number,
  endId: number,
): number[] | null {
  if (startId === endId) return [startId];

  const adjacency = new Map<number, number[]>();
  for (const edge of edges) {
    const src = edge.source;
    const dst = edge.target;
    const srcList = adjacency.get(src) ?? [];
    srcList.push(dst);
    adjacency.set(src, srcList);

    const dstList = adjacency.get(dst) ?? [];
    dstList.push(src);
    adjacency.set(dst, dstList);
  }

  const queue: number[] = [startId];
  const visited = new Set<number>([startId]);
  const parent = new Map<number, number | null>([[startId, null]]);

  while (queue.length > 0) {
    const current = queue.shift();
    if (current == null) break;
    if (current === endId) {
      const path: number[] = [];
      let cursor: number | null = current;
      while (cursor != null) {
        path.push(cursor);
        cursor = parent.get(cursor) ?? null;
      }
      return path.reverse();
    }

    const next = adjacency.get(current) ?? [];
    for (const candidate of next) {
      if (visited.has(candidate)) continue;
      visited.add(candidate);
      parent.set(candidate, current);
      queue.push(candidate);
    }
  }

  return null;
}

function applySetLengthConstraint(
  ids: number[],
  targetLength: number | null,
  keepFirst: boolean,
  keepLast: boolean,
): number[] {
  if (targetLength == null || targetLength <= 0) return ids;
  if (ids.length <= targetLength) return ids;

  if (keepFirst && keepLast && targetLength >= 2) {
    const middleCount = targetLength - 2;
    return [ids[0], ...ids.slice(1, 1 + middleCount), ids[ids.length - 1]];
  }

  if (keepFirst && targetLength >= 1) {
    return ids.slice(0, targetLength);
  }

  if (keepLast && targetLength >= 1) {
    return ids.slice(ids.length - targetLength);
  }

  return ids.slice(0, targetLength);
}

function isCamelotAdjacent(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = parseCamelot(a);
  const right = parseCamelot(b);
  if (!left || !right) return false;
  if (left.num === right.num && left.mode === right.mode) return true;
  if (left.num === right.num && left.mode !== right.mode) return true;
  if (
    left.mode === right.mode &&
    (Math.abs(left.num - right.num) === 1 ||
      Math.abs(left.num - right.num) === 11)
  ) {
    return true;
  }
  return false;
}

function transitionCost(
  a: GraphNode | undefined,
  b: GraphNode | undefined,
  bpmTol: number,
): number {
  if (!a || !b) return Number.POSITIVE_INFINITY;

  let cost = 0;

  if (a.key_camelot && b.key_camelot) {
    if (a.key_camelot === b.key_camelot) {
      cost += 0;
    } else if (isCamelotAdjacent(a.key_camelot, b.key_camelot)) {
      cost += 0.25;
    } else {
      return Number.POSITIVE_INFINITY;
    }
  } else {
    cost += 0.35;
  }

  if (a.bpm != null && b.bpm != null) {
    const avg = (a.bpm + b.bpm) / 2;
    if (avg > 0) {
      const pctDiff = (Math.abs(a.bpm - b.bpm) / avg) * 100;
      if (pctDiff > Math.max(bpmTol * 1.5, 8)) {
        return Number.POSITIVE_INFINITY;
      }
      cost += (pctDiff / Math.max(bpmTol, 1)) * 0.35;
    }
  } else {
    cost += 0.25;
  }

  if (a.energy != null && b.energy != null) {
    cost += Math.abs(a.energy - b.energy) * 0.1;
  }

  return cost;
}

function transitionCostRelaxed(
  a: GraphNode | undefined,
  b: GraphNode | undefined,
  bpmTol: number,
): number {
  if (!a || !b) return Number.POSITIVE_INFINITY;

  let cost = 0;

  if (a.key_camelot && b.key_camelot) {
    if (a.key_camelot === b.key_camelot) {
      cost += 0;
    } else if (isCamelotAdjacent(a.key_camelot, b.key_camelot)) {
      cost += 0.25;
    } else {
      cost += 0.8;
    }
  } else {
    cost += 0.45;
  }

  if (a.bpm != null && b.bpm != null) {
    const avg = (a.bpm + b.bpm) / 2;
    if (avg > 0) {
      const pctDiff = (Math.abs(a.bpm - b.bpm) / avg) * 100;
      cost += (pctDiff / Math.max(bpmTol, 1)) * 0.5;
    }
  } else {
    cost += 0.35;
  }

  if (a.energy != null && b.energy != null) {
    cost += Math.abs(a.energy - b.energy) * 0.1;
  } else {
    cost += 0.2;
  }

  return cost;
}

function profileEdgeBias(
  a: GraphNode | undefined,
  b: GraphNode | undefined,
  profile: RouteProfile,
): number {
  if (!a || !b) return 0;

  let bias = 0;

  if (a.bpm != null && b.bpm != null) {
    if (profile === "build_up") {
      bias += b.bpm >= a.bpm ? -0.08 : 0.12;
    } else if (profile === "cooldown") {
      bias += b.bpm <= a.bpm ? -0.08 : 0.12;
    } else {
      bias += Math.min(Math.abs(a.bpm - b.bpm) / 40, 0.18);
    }
  }

  if (a.energy != null && b.energy != null) {
    if (profile === "build_up") {
      bias += b.energy >= a.energy ? -0.07 : 0.1;
    } else if (profile === "cooldown") {
      bias += b.energy <= a.energy ? -0.07 : 0.1;
    } else {
      bias += Math.abs(a.energy - b.energy) * 0.04;
    }
  }

  return bias;
}

function chooseAutoAnchor(
  startId: number,
  allNodeIds: number[],
  nodeById: Map<number, GraphNode>,
  excludedSet: Set<number>,
  profile: RouteProfile,
  bpmTol: number,
): number | null {
  const startNode = nodeById.get(startId);
  if (!startNode) return null;

  let bestId: number | null = null;
  let bestCost = Number.POSITIVE_INFINITY;

  for (const candidateId of allNodeIds) {
    if (candidateId === startId || excludedSet.has(candidateId)) continue;
    const candidateNode = nodeById.get(candidateId);
    if (!candidateNode) continue;

    let cost = transitionCostRelaxed(startNode, candidateNode, bpmTol);

    if (profile === "build_up") {
      if (
        startNode.bpm != null &&
        candidateNode.bpm != null &&
        candidateNode.bpm < startNode.bpm
      ) {
        cost += 0.35;
      }
      if (
        startNode.energy != null &&
        candidateNode.energy != null &&
        candidateNode.energy < startNode.energy
      ) {
        cost += 0.35;
      }
    } else if (profile === "cooldown") {
      if (
        startNode.bpm != null &&
        candidateNode.bpm != null &&
        candidateNode.bpm > startNode.bpm
      ) {
        cost += 0.35;
      }
      if (
        startNode.energy != null &&
        candidateNode.energy != null &&
        candidateNode.energy > startNode.energy
      ) {
        cost += 0.35;
      }
    }

    cost += profileEdgeBias(startNode, candidateNode, profile);

    if (cost < bestCost) {
      bestCost = cost;
      bestId = candidateId;
    }
  }

  return bestId;
}

function expandSetLengthConstraint(
  ids: number[],
  targetLength: number | null,
  allNodeIds: number[],
  nodeById: Map<number, GraphNode>,
  excludedSet: Set<number>,
  keepFirst: boolean,
  keepLast: boolean,
  bpmTol: number,
  profile: RouteProfile,
): number[] {
  if (targetLength == null || targetLength <= 0) return ids;
  if (ids.length >= targetLength) {
    return applySetLengthConstraint(ids, targetLength, keepFirst, keepLast);
  }

  const next = [...ids];
  const remaining = new Set(
    allNodeIds.filter((id) => !next.includes(id) && !excludedSet.has(id)),
  );

  const findBestInsertion = (
    candidates: Set<number>,
    scorer: (
      a: GraphNode | undefined,
      b: GraphNode | undefined,
      tol: number,
    ) => number,
  ): { candidate: number; index: number; cost: number } | null => {
    let bestCandidate: number | null = null;
    let bestIndex = -1;
    let bestCost = Number.POSITIVE_INFINITY;

    for (const candidate of candidates) {
      const candidateNode = nodeById.get(candidate);
      if (!candidateNode) continue;

      const startIndex = keepFirst ? 1 : 0;
      const endIndexExclusive = keepLast ? next.length : next.length + 1;

      for (
        let insertAt = startIndex;
        insertAt < endIndexExclusive;
        insertAt++
      ) {
        const prevNode =
          insertAt > 0 ? nodeById.get(next[insertAt - 1]) : undefined;
        const nextNode =
          insertAt < next.length ? nodeById.get(next[insertAt]) : undefined;

        const leftCost = prevNode ? scorer(prevNode, candidateNode, bpmTol) : 0;
        const rightCost = nextNode
          ? scorer(candidateNode, nextNode, bpmTol)
          : 0;
        const baseline =
          prevNode && nextNode ? scorer(prevNode, nextNode, bpmTol) : 0;
        const biasLeft = prevNode
          ? profileEdgeBias(prevNode, candidateNode, profile)
          : 0;
        const biasRight = nextNode
          ? profileEdgeBias(candidateNode, nextNode, profile)
          : 0;
        const biasBaseline =
          prevNode && nextNode
            ? profileEdgeBias(prevNode, nextNode, profile)
            : 0;
        const insertionCost =
          leftCost + rightCost - baseline + biasLeft + biasRight - biasBaseline;

        if (Number.isFinite(insertionCost) && insertionCost < bestCost) {
          bestCost = insertionCost;
          bestCandidate = candidate;
          bestIndex = insertAt;
        }
      }
    }

    if (bestCandidate == null || bestIndex < 0) {
      return null;
    }

    return { candidate: bestCandidate, index: bestIndex, cost: bestCost };
  };

  while (next.length < targetLength && remaining.size > 0) {
    // First pass: strict transitions only.
    let best = findBestInsertion(remaining, transitionCost);

    // Second pass: relaxed scoring to still reach requested length.
    if (!best) {
      best = findBestInsertion(remaining, transitionCostRelaxed);
    }

    if (!best) {
      break;
    }

    next.splice(best.index, 0, best.candidate);
    remaining.delete(best.candidate);
  }

  return applySetLengthConstraint(next, targetLength, keepFirst, keepLast);
}

// ---------------------------------------------------------------------------
// GraphPage
// ---------------------------------------------------------------------------

const GraphPage = () => {
  const { playlistId } = graphRoute.useSearch();
  const queryClient = useQueryClient();
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const initializedPlaylistIdRef = useRef<number | null>(null);
  const hoverNodeRef = useRef<string | null>(null);
  const baseNodeStyleRef = useRef<Map<number, { size: number; color: string }>>(
    new Map(),
  );
  const selectedIdsRef = useRef<Set<number>>(new Set());
  const selectedOrderRef = useRef<number[]>([]);
  const activeRouteIdsRef = useRef<number[]>([]);
  const activeRouteNodeIdsRef = useRef<Set<number>>(new Set());
  const activeRouteEdgeKeysRef = useRef<Set<string>>(new Set());

  const [showSelectionPanel, setShowSelectionPanel] = useState(false);
  const [showNetwork, setShowNetwork] = useState(false);
  const [trackSearch, setTrackSearch] = useState("");
  const [trackSearchResults, setTrackSearchResults] = useState<TrackSummary[]>(
    [],
  );
  const [trackSearchMessage, setTrackSearchMessage] = useState<string | null>(
    null,
  );
  const [discoveryPool, setDiscoveryPool] = useState<TrackSummary[] | null>(
    null,
  );
  const [editingTrack, setEditingTrack] = useState<TrackSummary | null>(null);
  const [mixKeyScope, setMixKeyScope] = useState<"same" | "harmonic">(
    "harmonic",
  );
  const [bpmTol, setBpmTol] = useState(DISCOVERY_BPM_TOLERANCE);
  const [pendingBpmTol, setPendingBpmTol] = useState(
    DISCOVERY_BPM_TOLERANCE,
  );
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [newPlaylistName, setNewPlaylistName] = useState(
    () => `Mix ${new Date().toISOString().slice(0, 10)}`,
  );
  const [targetPlaylistId, setTargetPlaylistId] = useState("");
  const [playlistActionMessage, setPlaylistActionMessage] = useState<
    string | null
  >(null);
  const [excludedTrackIds, setExcludedTrackIds] = useState<number[]>([]);
  const [targetSetLengthInput, setTargetSetLengthInput] = useState<string>("");
  const [lockFirst, setLockFirst] = useState(true);
  const [lockLast, setLockLast] = useState(true);
  const [harmonizeProfile, setHarmonizeProfile] = useState<
    "build_up" | "cruise" | "cooldown"
  >("cruise");
  const [orderWeights, setOrderWeights] = useState({
    key: 0.5,
    bpm: 0.3,
    energy: 0.2,
  });

  const requestTrackPlayback = useLibraryStore((s) => s.requestTrackPlayback);
  const setPlaybackQueueTrackIds = useLibraryStore(
    (s) => s.setPlaybackQueueTrackIds,
  );
  const selectedTrackIds = useLibraryStore((s) => s.selectedTrackIds);
  const setSelectedTrackIds = useLibraryStore((s) => s.setSelectedTrackIds);
  const [libraryScopeTrackIds] = useState(() =>
    playlistId == null ? selectedTrackIds : [],
  );
  const [discoveryData, setDiscoveryData] = useState<DiscoveryScope | null>(
    null,
  );
  const [discoveryError, setDiscoveryError] = useState<Error | null>(null);
  const [isDiscoveryLoading, setIsDiscoveryLoading] = useState(false);
  const { data: playlists = [] } = usePlaylists();
  const createPlaylistMutation = useCreatePlaylist();
  const deletePlaylistMutation = useDeletePlaylist();
  const harmonizePlaylistMutation = useHarmonizePlaylist();
  const addTracksToPlaylistMutation = useAddTracksToPlaylist();
  const orderPlaylistMutation = useOrderPlaylist();
  const findPathMutation = useFindPlaylistPath();
  const updateTrackMutation = useUpdateTrack();
  const playlistQuery = usePlaylistDetail(playlistId ?? 0);
  const playlistTrackIds = useMemo(
    () => playlistQuery.data?.tracks.map((track) => track.id) ?? [],
    [playlistQuery.data?.tracks],
  );
  const needsDiscovery = playlistId == null && libraryScopeTrackIds.length === 0;
  const refreshDiscovery = useCallback(async () => {
    setIsDiscoveryLoading(true);
    setDiscoveryError(null);
    try {
      const tracks = discoveryPool ?? (await fetchDiscoveryPool());
      if (!discoveryPool) setDiscoveryPool(tracks);
      setDiscoveryData(randomDiscoveryScope(tracks));
    } catch (error) {
      setDiscoveryError(
        error instanceof Error ? error : new Error("Discovery failed"),
      );
    } finally {
      setIsDiscoveryLoading(false);
    }
  }, [discoveryPool]);
  const runTrackSearch = useCallback(() => {
    const query = trackSearch.trim();
    if (!query || !discoveryPool) return;
    setTrackSearchMessage(null);
    const results = searchDiscoveryTracks(discoveryPool, query);
    setTrackSearchResults(results);
    if (results.length === 0)
      setTrackSearchMessage("No analyzed tracks match that search.");
  }, [discoveryPool, trackSearch]);
  const scopeTrackIds = playlistId != null
    ? playlistTrackIds
    : libraryScopeTrackIds.length > 0
      ? libraryScopeTrackIds
      : (discoveryData?.trackIds ?? []);

  const graphQuery = useGraph({
    types: DEFAULT_ACTIVE_EDGE_TYPES,
    bpmTol,
    filterIds: scopeTrackIds.length > 0 ? scopeTrackIds : [-1],
    enabled:
      (playlistId == null || playlistQuery.isSuccess) &&
      (!needsDiscovery || discoveryData != null),
  });
  const graphData = graphQuery.data;
  const isLoading =
    graphQuery.isLoading ||
    (isDiscoveryLoading && discoveryData == null) ||
    (playlistId != null && playlistQuery.isLoading);
  const error = graphQuery.error ?? playlistQuery.error ?? discoveryError;

  const graphNodes = graphData?.nodes ?? [];
  const graphNodeById = useMemo(() => {
    return new Map(graphNodes.map((node) => [node.id, node]));
  }, [graphNodes]);
  const mixTrackById = useMemo(
    () =>
      new Map(
        [...(discoveryPool ?? []), ...graphNodes].map((track) => [
          track.id,
          track,
        ]),
      ),
    [discoveryPool, graphNodes],
  );

  const excludedTrackSet = useMemo(
    () => new Set(excludedTrackIds),
    [excludedTrackIds],
  );
  const targetSetLength = useMemo(() => {
    if (targetSetLengthInput.trim().length === 0) return null;
    const parsed = Number(targetSetLengthInput);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.floor(parsed);
  }, [targetSetLengthInput]);
  const actionTrackIds = useMemo(
    () =>
      selectedTrackIds.filter(
        (id) => mixTrackById.has(id) && !excludedTrackSet.has(id),
      ),
    [selectedTrackIds, mixTrackById, excludedTrackSet],
  );
  const pathStartTrackId = actionTrackIds[0] ?? null;
  const pathEndTrackId = actionTrackIds[actionTrackIds.length - 1] ?? null;
  const startTrack =
    pathStartTrackId != null ? graphNodeById.get(pathStartTrackId) : undefined;
  const endTrack =
    pathEndTrackId != null ? graphNodeById.get(pathEndTrackId) : undefined;
  const activeTracks = useMemo(
    () =>
      actionTrackIds
        .map((id) => mixTrackById.get(id))
        .filter((track): track is GraphNode => track != null),
    [actionTrackIds, mixTrackById],
  );
  const focusTrack = useMemo(
    () =>
      actionTrackIds.length === 1
        ? (mixTrackById.get(actionTrackIds[0]) ?? null)
        : null,
    [actionTrackIds, mixTrackById],
  );
  const mixAnchor = playlistId
    ? (graphNodeById.get(playlistTrackIds[0]) ?? graphNodes[0] ?? null)
    : (mixTrackById.get(actionTrackIds.at(-1) ?? -1) ??
      mixTrackById.get(discoveryData?.seed.id ?? -1) ??
      graphNodes[0] ??
      null);
  const mixCandidates = useMemo(
    () =>
      rankMixCandidates(
        mixAnchor,
        playlistId ? graphNodes : (discoveryPool ?? graphNodes),
        bpmTol,
        harmonizeProfile,
      ).filter(
        (candidate) =>
          !actionTrackIds.includes(candidate.track.id) &&
          (mixKeyScope === "harmonic" || candidate.relation === "Same key"),
      ),
    [
      actionTrackIds,
      bpmTol,
      discoveryPool,
      graphNodes,
      harmonizeProfile,
      mixKeyScope,
      mixAnchor,
      playlistId,
    ],
  );
  const chartTracks = useMemo(() => {
    const ordered = playlistId
      ? playlistTrackIds
          .map((id) => graphNodeById.get(id))
          .filter((track): track is GraphNode => track != null)
      : [mixAnchor, ...mixCandidates.slice(0, 59)].filter(
          (track): track is GraphNode => track != null,
        );
    const usable = ordered.filter(
      (track) => track.bpm != null && parseCamelot(track.key_camelot) != null,
    );
    if (usable.length === 0)
      return {
        minBpm: 0,
        maxBpm: 0,
        points: [] as { track: GraphNode; x: number; y: number }[],
      };
    const bpms = usable.map((track) => track.bpm!);
    const minBpm = Math.min(...bpms);
    const maxBpm = Math.max(...bpms);
    const bpmSpan = Math.max(maxBpm - minBpm, 1);
    return {
      minBpm,
      maxBpm,
      points: usable.map((track, index) => {
        const key = parseCamelot(track.key_camelot)!;
        const x = playlistId
          ? 44 + (index / Math.max(usable.length - 1, 1)) * 332
          : 44 + ((track.bpm! - minBpm) / bpmSpan) * 332;
        const y = playlistId
          ? 210 - ((track.bpm! - minBpm) / bpmSpan) * 170
          : 210 - ((key.num - 1) / 11) * 170;
        return { track, x, y };
      }),
    };
  }, [graphNodeById, mixAnchor, mixCandidates, playlistId, playlistTrackIds]);
  const playlistTransitions = useMemo(() => {
    if (!playlistId) return [];
    return playlistTrackIds.slice(0, -1).map((trackId, index) => {
      const from = graphNodeById.get(trackId);
      const to = graphNodeById.get(playlistTrackIds[index + 1]);
      return {
        from,
        to,
        compatibility: getTrackCompatibility(from, to, bpmTol),
      };
    });
  }, [bpmTol, graphNodeById, playlistId, playlistTrackIds]);
  const focusKey =
    hoveredNode?.key_camelot ?? activeTracks[0]?.key_camelot ?? null;
  const wheelHighlightedKeys = useMemo(
    () => getHarmonicCompanionKeys(focusKey),
    [focusKey],
  );
  const previewTrack = useCallback(
    (track: GraphNode) => {
      queryClient.setQueryData(["track", track.id], track);
      requestTrackPlayback(track.id);
    },
    [queryClient, requestTrackPlayback],
  );
  const chooseMixTrack = useCallback(
    (track: GraphNode, replace: boolean) => {
      setTrackSearch(`${track.title} — ${track.artist}`);
      setTrackSearchResults([]);
      setTrackSearchMessage(null);
      setSelectedTrackIds(
        replace
          ? [track.id]
          : selectedTrackIds.includes(track.id)
            ? selectedTrackIds
            : [...selectedTrackIds, track.id],
      );
      previewTrack(track);
    },
    [previewTrack, selectedTrackIds, setSelectedTrackIds],
  );
  const addTrackToMix = useCallback(
    (track: GraphNode) => {
      setSelectedTrackIds(
        selectedTrackIds.includes(track.id)
          ? selectedTrackIds
          : [...selectedTrackIds, track.id],
      );
      previewTrack(track);
    },
    [previewTrack, selectedTrackIds, setSelectedTrackIds],
  );
  const saveTrackMetadata = useCallback(
    async (payload: TrackMetadataPatch) => {
      if (!editingTrack) return;
      await updateTrackMutation.mutateAsync({
        trackId: editingTrack.id,
        payload,
      });
      setDiscoveryPool((tracks) =>
        tracks?.map((track) =>
          track.id === editingTrack.id ? { ...track, ...payload } : track,
        ) ?? null,
      );
      setEditingTrack(null);
    },
    [editingTrack, updateTrackMutation],
  );
  useEffect(() => {
    setShowSelectionPanel(false);
    if (playlistId == null) initializedPlaylistIdRef.current = null;
  }, [playlistId]);

  useEffect(() => {
    if (playlistId == null || !playlistQuery.isSuccess) return;
    if (initializedPlaylistIdRef.current === playlistId) return;
    initializedPlaylistIdRef.current = playlistId;
    setSelectedTrackIds(playlistTrackIds);
  }, [
    playlistId,
    playlistQuery.isSuccess,
    playlistTrackIds,
    setSelectedTrackIds,
  ]);

  useEffect(() => {
    if (needsDiscovery && discoveryData == null) void refreshDiscovery();
  }, [discoveryData, needsDiscovery, refreshDiscovery]);

  useEffect(() => {
    if (!needsDiscovery || !discoveryData) return;
    setSelectedTrackIds([discoveryData.seed.id]);
  }, [discoveryData, needsDiscovery, setSelectedTrackIds]);

  const applySelectionStyling = useCallback(() => {
    const sigma = sigmaRef.current;
    if (!sigma) return;

    const selectedIds = selectedIdsRef.current;
    const baseStyles = baseNodeStyleRef.current;
    const activeRouteNodeIds = activeRouteNodeIdsRef.current;
    const hasActiveRoute = activeRouteNodeIds.size > 1;
    const focusTrackId =
      selectedIds.size === 1 ? ([...selectedIds][0] ?? null) : null;
    const focusAnchor =
      focusTrackId != null ? (graphNodeById.get(focusTrackId) ?? null) : null;

    sigma.setSetting("nodeReducer", (nodeId, data) => {
      const trackId = Number(nodeId);
      const base = baseStyles.get(trackId);

      if (hasActiveRoute && !activeRouteNodeIds.has(trackId)) {
        return {
          ...data,
          size: (base?.size ?? data.size) * 0.85,
          color: "#334155",
          zIndex: 0,
        };
      }

      if (!selectedIds.has(trackId)) {
        if (focusAnchor) {
          const compatibility = getTrackCompatibility(
            focusAnchor,
            graphNodeById.get(trackId),
            bpmTol,
          );
          if (compatibility === "compatible") {
            return {
              ...data,
              size: (base?.size ?? data.size) * 1.05,
              zIndex: 1,
            };
          }
          if (compatibility === "unknown-bpm") {
            return {
              ...data,
              size: (base?.size ?? data.size) * 0.8,
              color: "#64748b",
              zIndex: 0,
            };
          }
          if (compatibility === "bpm-mismatch") {
            return {
              ...data,
              size: (base?.size ?? data.size) * 0.55,
              color: "#334155",
              zIndex: 0,
            };
          }
          return {
            ...data,
            size: (base?.size ?? data.size) * 0.35,
            color: "#1e293b",
            zIndex: 0,
          };
        }
        return data;
      }

      return {
        ...data,
        size: (base?.size ?? data.size) * 1.35,
        color: "#f8fafc",
        zIndex: 2,
      };
    });

    sigma.setSetting("edgeReducer", (_edgeId, data) => {
      const sourceId = Number(data.sourceId);
      const targetId = Number(data.targetId);
      const isRouteEdge =
        activeRouteEdgeKeysRef.current.has(`${sourceId}->${targetId}`) ||
        activeRouteEdgeKeysRef.current.has(`${targetId}->${sourceId}`);

      if (isRouteEdge) {
        return {
          ...data,
          hidden: false,
          color: "#f8fafc",
          size: 4,
          zIndex: 3,
        };
      }

      if (hasActiveRoute) {
        return {
          ...data,
          hidden: false,
          color: "#334155",
          size: 1,
          zIndex: 0,
        };
      }

      const edgeKind = data.edgeKind as EdgeType | undefined;
      if (focusTrackId != null && focusAnchor) {
        const otherTrackId =
          sourceId === focusTrackId
            ? targetId
            : targetId === focusTrackId
              ? sourceId
              : null;

        if (otherTrackId == null) {
          return {
            ...data,
            hidden: true,
            zIndex: 0,
          };
        }

        const compatibility = getTrackCompatibility(
          focusAnchor,
          graphNodeById.get(otherTrackId),
          bpmTol,
        );

        if (compatibility === "compatible") {
          return {
            ...data,
            hidden: false,
            color: edgeKind === "bpm" ? "#22d3ee" : "#f8fafc",
            size: edgeKind === "bpm" ? 2.8 : 2,
            zIndex: 2,
          };
        }

        if (compatibility === "unknown-bpm") {
          return {
            ...data,
            hidden: false,
            color: "rgba(148, 163, 184, 0.28)",
            size: 0.8,
            zIndex: 0,
          };
        }

        if (compatibility === "bpm-mismatch") {
          return {
            ...data,
            hidden: false,
            color: "rgba(71, 85, 105, 0.26)",
            size: 0.45,
            zIndex: 0,
          };
        }

        return {
          ...data,
          hidden: true,
          zIndex: 0,
        };
      }

      if (edgeKind === "key") {
        return {
          ...data,
          hidden: false,
          color: "rgba(148, 163, 184, 0.2)",
          size: 0.7,
          zIndex: 0,
        };
      }

      if (edgeKind === "bpm") {
        return {
          ...data,
          hidden: true,
          zIndex: 0,
        };
      }

      if (edgeKind) {
        return {
          ...data,
          hidden: true,
          zIndex: 0,
        };
      }

      return {
        ...data,
        hidden: false,
        zIndex: 0,
      };
    });
    sigma.refresh();
  }, [bpmTol, graphNodeById]);

  // Build and render graph when data or visual options change
  useEffect(() => {
    if (!showNetwork || !containerRef.current || !graphData) return;

    // Destroy previous instance
    if (sigmaRef.current) {
      sigmaRef.current.kill();
      sigmaRef.current = null;
    }

    const graph = new Graph({ type: "undirected", multi: true });
    baseNodeStyleRef.current.clear();
    const camelotPositions = buildCamelotLayout(graphData.nodes);

    for (const node of graphData.nodes) {
      const baseSize = deriveNodeSize(node);
      const baseColor = deriveNodeColor(node);
      const position = camelotPositions?.get(node.id);
      baseNodeStyleRef.current.set(node.id, {
        size: baseSize,
        color: baseColor,
      });
      graph.addNode(String(node.id), {
        label: node.title,
        size: baseSize,
        color: baseColor,
        image: `/api/v1/audio/${node.id}/cover`,
        type: "image",
        x: position?.x ?? Math.random(),
        y: position?.y ?? Math.random(),
        _data: node,
      });
    }

    for (let i = 0; i < graphData.edges.length; i++) {
      const edge = graphData.edges[i];
      graph.addEdge(String(edge.source), String(edge.target), {
        color: EDGE_COLORS[edge.type],
        size: 1,
        type: "line",
        edgeKind: edge.type,
        weight: edge.weight,
        sourceId: edge.source,
        targetId: edge.target,
      });
    }

    const NodeImageProg = createNodeImageProgram({
      imageAttribute: "image",
      drawingMode: "background",
      keepWithinCircle: true,
      padding: 0.1,
    });

    const sigma = new Sigma(graph, containerRef.current, {
      renderLabels: false,
      renderEdgeLabels: false,
      defaultEdgeColor: "#334155",
      defaultNodeColor: "#94a3b8",
      defaultNodeType: "image",
      nodeProgramClasses: { image: NodeImageProg },
      // Hover labels are drawn on a light chip by sigma's default hover renderer,
      // so use a dark label color for strong contrast.
      labelColor: { color: "#0f172a" },
      labelSize: 12,
      labelWeight: "600",
    });

    // Hover
    sigma.on("enterNode", ({ node, event }) => {
      hoverNodeRef.current = node;
      const nodeData = graph.getNodeAttribute(node, "_data") as GraphNode;
      setHoveredNode(nodeData);
      const me = event.original as MouseEvent;
      setTooltipPos({ x: me.clientX, y: me.clientY });
    });
    sigma.on("leaveNode", () => {
      hoverNodeRef.current = null;
      setHoveredNode(null);
    });
    // Only dismiss tooltip when interacting outside nodes; hiding on generic
    // body movement can cause enter/leave flicker while still hovering.
    sigma.on("clickStage", () => {
      hoverNodeRef.current = null;
      setHoveredNode(null);
    });

    sigma.on("clickNode", ({ node, event }) => {
      const trackId = parseInt(node, 10);
      const mouseEvent = event.original as MouseEvent;
      const isAdditiveSelect =
        mouseEvent.shiftKey || mouseEvent.metaKey || mouseEvent.ctrlKey;

      // Always play clicked track from graph.
      queryClient.setQueryData(
        ["track", trackId],
        graph.getNodeAttribute(node, "_data"),
      );
      requestTrackPlayback(trackId);
      if (playlistId == null) setShowSelectionPanel(true);

      // Plain click focuses one node. Shift/Cmd/Ctrl toggles in multi-select set.
      if (!isAdditiveSelect) {
        setSelectedTrackIds([trackId]);
        return;
      }

      const next = [...selectedOrderRef.current];
      const index = next.indexOf(trackId);
      if (index >= 0) {
        next.splice(index, 1);
      } else {
        next.push(trackId);
      }
      setSelectedTrackIds(next);
    });

    sigmaRef.current = sigma;
    applySelectionStyling();

    return () => {
      sigma.kill();
      sigmaRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    graphData,
    playlistId,
    queryClient,
    requestTrackPlayback,
    setSelectedTrackIds,
    showNetwork,
    applySelectionStyling,
  ]);

  useEffect(() => {
    selectedIdsRef.current = new Set(selectedTrackIds);
    selectedOrderRef.current = selectedTrackIds;
    activeRouteIdsRef.current = actionTrackIds;
    activeRouteNodeIdsRef.current = new Set(actionTrackIds);

    const graphEdges = graphData?.edges ?? [];
    const directEdgeSet = new Set(
      graphEdges.map((edge) => `${edge.source}->${edge.target}`),
    );
    const routeEdgeKeys = new Set<string>();

    for (let i = 0; i < actionTrackIds.length - 1; i += 1) {
      const from = actionTrackIds[i];
      const to = actionTrackIds[i + 1];
      if (
        directEdgeSet.has(`${from}->${to}`) ||
        directEdgeSet.has(`${to}->${from}`)
      ) {
        routeEdgeKeys.add(`${from}->${to}`);
        continue;
      }

      const localPath = findLocalPath(graphEdges, from, to);
      if (localPath && localPath.length > 1) {
        for (let j = 0; j < localPath.length - 1; j += 1) {
          routeEdgeKeys.add(`${localPath[j]}->${localPath[j + 1]}`);
        }
      } else {
        routeEdgeKeys.add(`${from}->${to}`);
      }
    }

    activeRouteEdgeKeysRef.current = routeEdgeKeys;
    applySelectionStyling();
  }, [selectedTrackIds, actionTrackIds, graphData, applySelectionStyling]);

  const isPlaylistActionBusy =
    createPlaylistMutation.isPending ||
    deletePlaylistMutation.isPending ||
    harmonizePlaylistMutation.isPending ||
    addTracksToPlaylistMutation.isPending ||
    orderPlaylistMutation.isPending ||
    findPathMutation.isPending;

  const orderSelectedTracks = useCallback(async () => {
    if (actionTrackIds.length < 2) {
      setPlaylistActionMessage("Need at least 2 non-excluded tracks to order.");
      return;
    }

    setPlaylistActionMessage(null);
    try {
      // Harmonizer works on a playlist resource, so create a temp playlist,
      // harmonize it, then apply the ordered IDs back to graph selection.
      const tempName = `__graph_harmonize_${Date.now()}`;
      const tempPlaylist = await createPlaylistMutation.mutateAsync({
        name: tempName,
      });

      try {
        await addTracksToPlaylistMutation.mutateAsync({
          playlistId: tempPlaylist.id,
          trackIds: actionTrackIds,
        });

        const harmonizeOptions: HarmonizePlaylistRequest = {
          lock_first: lockFirst,
          lock_last: lockLast,
          bpm_weight: orderWeights.bpm,
          bpm_tolerance: Math.max(3, bpmTol),
          profile: harmonizeProfile,
        };
        const harmonized = await harmonizePlaylistMutation.mutateAsync({
          playlistId: tempPlaylist.id,
          options: harmonizeOptions,
        });

        if (harmonized.track_ids.length > 0) {
          const constrained = expandSetLengthConstraint(
            harmonized.track_ids,
            targetSetLength,
            graphNodes.map((node) => node.id),
            graphNodeById,
            excludedTrackSet,
            lockFirst,
            lockLast,
            bpmTol,
            harmonizeProfile,
          );
          setSelectedTrackIds(constrained);
          setPlaylistActionMessage(
            `Harmonized ${constrained.length} tracks (score ${Math.round(harmonized.diagnostics.compatibility_score)}).`,
          );
        } else {
          throw new Error("empty harmonizer result");
        }
      } finally {
        // Best-effort cleanup of temp playlist.
        try {
          await deletePlaylistMutation.mutateAsync(tempPlaylist.id);
        } catch {
          // Ignore cleanup errors; ordering already applied.
        }
      }
    } catch {
      // Fallback to graph-order endpoint if harmonizer path fails.
      try {
        const payload: OrderPlaylistRequest = {
          track_ids: actionTrackIds,
          key_weight: orderWeights.key,
          bpm_weight: orderWeights.bpm,
          energy_weight: orderWeights.energy,
        };
        const result = await orderPlaylistMutation.mutateAsync(payload);
        const constrained = expandSetLengthConstraint(
          result.ordered_track_ids,
          targetSetLength,
          graphNodes.map((node) => node.id),
          graphNodeById,
          excludedTrackSet,
          lockFirst,
          lockLast,
          bpmTol,
          harmonizeProfile,
        );
        setSelectedTrackIds(constrained);
        setPlaylistActionMessage(
          `Ordered ${constrained.length} tracks by graph flow.`,
        );
      } catch {
        setPlaylistActionMessage("Could not order tracks.");
      }
    }
  }, [
    actionTrackIds,
    graphNodes,
    excludedTrackSet,
    graphData,
    lockFirst,
    lockLast,
    harmonizeProfile,
    targetSetLength,
    orderWeights,
    bpmTol,
    createPlaylistMutation,
    addTracksToPlaylistMutation,
    harmonizePlaylistMutation,
    deletePlaylistMutation,
    orderPlaylistMutation,
    setSelectedTrackIds,
  ]);

  const findPathBetweenTracks = useCallback(async () => {
    if (actionTrackIds.length < 1) {
      setPlaylistActionMessage("Select at least 1 track in the active route.");
      return;
    }

    setPlaylistActionMessage(null);
    const stitched: number[] = [];
    let usedFallbackLegs = 0;

    const startId = actionTrackIds[0] ?? null;
    const endId = actionTrackIds[actionTrackIds.length - 1] ?? null;
    if (startId == null) {
      setPlaylistActionMessage("No valid start track selected.");
      return;
    }

    const waypointIds = actionTrackIds.filter((trackId, idx) => {
      if (!lockFirst && idx === 0) return false;
      if (!lockLast && idx === actionTrackIds.length - 1) return false;
      return true;
    });

    let routeWaypoints =
      waypointIds.length >= 2 ? [...waypointIds] : [...actionTrackIds];

    if (actionTrackIds.length === 1) {
      const autoEnd = chooseAutoAnchor(
        actionTrackIds[0],
        graphNodes.map((node) => node.id),
        graphNodeById,
        excludedTrackSet,
        harmonizeProfile,
        bpmTol,
      );
      routeWaypoints =
        autoEnd != null ? [actionTrackIds[0], autoEnd] : [actionTrackIds[0]];
    } else if (
      waypointIds.length < 2 &&
      startId != null &&
      endId != null &&
      startId !== endId
    ) {
      if (lockFirst && !lockLast) {
        const autoEnd = chooseAutoAnchor(
          startId,
          graphNodes.map((node) => node.id),
          graphNodeById,
          excludedTrackSet,
          harmonizeProfile,
          bpmTol,
        );
        routeWaypoints =
          autoEnd != null ? [startId, autoEnd] : [startId, endId];
      } else if (!lockFirst && lockLast) {
        const autoStart = chooseAutoAnchor(
          endId,
          graphNodes.map((node) => node.id),
          graphNodeById,
          excludedTrackSet,
          invertProfile(harmonizeProfile),
          bpmTol,
        );
        routeWaypoints =
          autoStart != null ? [autoStart, endId] : [startId, endId];
      } else {
        routeWaypoints = [startId, endId];
      }
    }

    for (let i = 0; i < routeWaypoints.length - 1; i += 1) {
      const legStart = routeWaypoints[i];
      const legEnd = routeWaypoints[i + 1];

      let legPath: number[] | null = null;
      try {
        const result = await findPathMutation.mutateAsync({
          start_id: legStart,
          end_id: legEnd,
          key_weight: orderWeights.key,
          bpm_weight: orderWeights.bpm,
          energy_weight: orderWeights.energy,
          bpm_tolerance: Math.max(3, bpmTol),
          profile: harmonizeProfile,
        });
        if (result.found && result.path && result.path.length > 1) {
          legPath = result.path;
        }
      } catch {
        // Ignore and fall through to local fallback.
      }

      if (!legPath) {
        const local = graphData
          ? findLocalPath(
              graphData.edges.filter((edge) => {
                if (edge.source === legStart || edge.target === legStart)
                  return true;
                if (edge.source === legEnd || edge.target === legEnd)
                  return true;
                return (
                  !excludedTrackSet.has(edge.source) &&
                  !excludedTrackSet.has(edge.target)
                );
              }),
              legStart,
              legEnd,
            )
          : null;
        if (local && local.length > 1) {
          legPath = local;
          usedFallbackLegs += 1;
        }
      }

      if (!legPath) {
        legPath = [legStart, legEnd];
        usedFallbackLegs += 1;
      }

      if (i === 0) {
        stitched.push(...legPath);
      } else {
        stitched.push(...legPath.slice(1));
      }
    }

    if (stitched.length === 0 && routeWaypoints.length === 1) {
      stitched.push(routeWaypoints[0]);
    }

    const collapsed = stitched.filter(
      (id, idx) => idx === 0 || id !== stitched[idx - 1],
    );
    const cleaned = collapsed.filter((id) => !excludedTrackSet.has(id));
    const minTarget = routeWaypoints.length;
    const effectiveTargetLength =
      targetSetLength == null ? null : Math.max(targetSetLength, minTarget);
    const constrained = expandSetLengthConstraint(
      cleaned,
      effectiveTargetLength,
      graphNodes.map((node) => node.id),
      graphNodeById,
      excludedTrackSet,
      lockFirst,
      lockLast,
      bpmTol,
      harmonizeProfile,
    );

    setSelectedTrackIds(constrained);
    if (usedFallbackLegs > 0) {
      setPlaylistActionMessage(
        `Built route with ${constrained.length} tracks. ${usedFallbackLegs} segment${usedFallbackLegs > 1 ? "s" : ""} used fallback links.`,
      );
    } else if (actionTrackIds.length === 1) {
      setPlaylistActionMessage(
        `Built ${harmonizeProfile.replace("_", " ")} route from one anchor (${constrained.length} tracks).`,
      );
    } else {
      setPlaylistActionMessage(
        `Built route through all selected waypoints (${constrained.length} tracks).`,
      );
    }
  }, [
    actionTrackIds,
    excludedTrackSet,
    targetSetLength,
    lockFirst,
    lockLast,
    orderWeights,
    harmonizeProfile,
    findPathMutation,
    setSelectedTrackIds,
    graphData,
    graphNodes,
    graphNodeById,
    bpmTol,
  ]);

  const removeTrackFromSelection = useCallback(
    (trackId: number) => {
      setSelectedTrackIds(selectedTrackIds.filter((id) => id !== trackId));
    },
    [selectedTrackIds, setSelectedTrackIds],
  );

  const moveTrackInSelection = useCallback(
    (trackId: number, delta: -1 | 1) => {
      const index = selectedTrackIds.indexOf(trackId);
      if (index < 0) return;
      const nextIndex = index + delta;
      if (nextIndex < 0 || nextIndex >= selectedTrackIds.length) return;

      const next = [...selectedTrackIds];
      const [item] = next.splice(index, 1);
      next.splice(nextIndex, 0, item);
      setSelectedTrackIds(next);
    },
    [selectedTrackIds, setSelectedTrackIds],
  );

  const excludeTrack = useCallback(
    (trackId: number) => {
      setExcludedTrackIds((prev) =>
        prev.includes(trackId) ? prev : [...prev, trackId],
      );
      setSelectedTrackIds(selectedTrackIds.filter((id) => id !== trackId));
    },
    [selectedTrackIds, setSelectedTrackIds],
  );

  const playRouteFromIndex = useCallback(
    (startIndex: number) => {
      const route = activeTracks.map((track) => track.id).slice(startIndex);
      const firstTrackId = route[0];
      if (!firstTrackId) return;
      setPlaybackQueueTrackIds(route);
      requestTrackPlayback(firstTrackId);
    },
    [activeTracks, requestTrackPlayback, setPlaybackQueueTrackIds],
  );

  const createPlaylistFromSelection = useCallback(async () => {
    if (actionTrackIds.length === 0) {
      setPlaylistActionMessage("No non-excluded tracks to add.");
      return;
    }

    const name =
      newPlaylistName.trim() ||
      `Graph Set ${new Date().toISOString().slice(0, 10)}`;
    setPlaylistActionMessage(null);

    try {
      const playlist = await createPlaylistMutation.mutateAsync({ name });
      const addResult = await addTracksToPlaylistMutation.mutateAsync({
        playlistId: playlist.id,
        trackIds: actionTrackIds,
      });
      setTargetPlaylistId(String(playlist.id));
      setPlaylistActionMessage(
        `Created "${playlist.name}" and added ${addResult.added} tracks.`,
      );
    } catch {
      setPlaylistActionMessage(
        "Could not create playlist from selected tracks.",
      );
    }
  }, [
    addTracksToPlaylistMutation,
    actionTrackIds,
    createPlaylistMutation,
    newPlaylistName,
  ]);

  const addSelectionToPlaylist = useCallback(async () => {
    if (actionTrackIds.length === 0) {
      setPlaylistActionMessage("No non-excluded tracks to add.");
      return;
    }

    const playlistId = Number(targetPlaylistId);
    if (!Number.isFinite(playlistId) || playlistId <= 0) {
      setPlaylistActionMessage("Pick a target playlist first.");
      return;
    }

    setPlaylistActionMessage(null);
    try {
      const addResult = await addTracksToPlaylistMutation.mutateAsync({
        playlistId,
        trackIds: actionTrackIds,
      });
      const playlistName =
        playlists.find((playlist) => playlist.id === playlistId)?.name ||
        "playlist";
      setPlaylistActionMessage(
        `Added ${addResult.added} tracks to "${playlistName}".`,
      );
    } catch {
      setPlaylistActionMessage("Could not add selected tracks to playlist.");
    }
  }, [
    addTracksToPlaylistMutation,
    actionTrackIds,
    playlists,
    targetPlaylistId,
  ]);

  const nodeCount = graphData?.nodes.length ?? 0;
  const edgeCount = graphData?.edges.length ?? 0;

  return (
    <>
      {/* Topbar */}
      <div className="djit-topbar">
        <span
          style={{
            fontFamily: "var(--font-label)",
            fontSize: "var(--font-size-sm)",
            fontWeight: 700,
            letterSpacing: "var(--letter-spacing-caps)",
            color: "var(--color-text-secondary)",
          }}
        >
          {showNetwork
            ? "EXPLORE NETWORK"
            : playlistQuery.data
              ? "PLAYLIST MIX MAP"
              : "MIX MAP"}
        </span>
        {playlistQuery.data ? (
          <a
            href={`/playlists/${playlistQuery.data.id}`}
            style={{
              fontFamily: "var(--font-label)",
              fontSize: "var(--font-size-xs)",
              color: "var(--color-accent)",
              textDecoration: "none",
            }}
          >
            ← {playlistQuery.data.name}
          </a>
        ) : null}
        {!isLoading && (
          <span
            style={{
              fontFamily: "var(--font-label)",
              fontSize: "var(--font-size-xs)",
              color: "var(--color-text-faint)",
            }}
          >
            {showNetwork
              ? `${nodeCount} tracks · ${edgeCount} links`
              : `${mixCandidates.length} compatible next tracks`}
            {showNetwork && graphData?.truncated && " · truncated to 2000"}
          </span>
        )}
        <button
          type="button"
          onClick={() => {
            setShowNetwork((current) => !current);
            setShowSelectionPanel(false);
          }}
          className="btn btn-secondary"
          style={{ height: 26 }}
        >
          {showNetwork ? "MIX MAP" : "SHOW NETWORK"}
        </button>
        {showNetwork && actionTrackIds.length > 0 && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              marginLeft: "auto",
            }}
          >
            <span
              style={{
                fontFamily: "var(--font-label)",
                fontSize: "var(--font-size-xs)",
                color: "var(--color-text-secondary)",
              }}
            >
              {actionTrackIds.length} selected
            </span>
            {!showSelectionPanel ? (
              <button
                type="button"
                onClick={() => {
                  setShowNetwork(true);
                  setShowSelectionPanel(true);
                }}
                className="btn btn-secondary"
                style={{ height: 26 }}
              >
                EDIT ROUTE
              </button>
            ) : null}
          </div>
        )}
      </div>

      {needsDiscovery ? (
        <form
          className="djit-filter-row"
          onSubmit={(event) => {
            event.preventDefault();
            void runTrackSearch();
          }}
        >
          <span className="library-filter-summary">FIND TRACKS</span>
          <div style={{ position: "relative" }}>
            <input
              type="search"
              className="library-search"
              value={trackSearch}
              onChange={(event) => {
                setTrackSearch(event.target.value);
                setTrackSearchResults([]);
                setTrackSearchMessage(null);
              }}
              placeholder="Search title or artist"
              aria-label="Search for a starting track"
              disabled={!discoveryPool}
            />
            {trackSearchResults.length > 0 || trackSearchMessage ? (
              <div
                style={{
                  position: "absolute",
                  zIndex: 10,
                  top: "calc(100% + 6px)",
                  left: 0,
                  width: "min(520px, calc(100vw - 300px))",
                  padding: 6,
                  border: "1px solid var(--color-border)",
                  background: "var(--color-bg-sidebar)",
                  boxShadow: "var(--pixel-shadow)",
                }}
              >
                {trackSearchResults.map((track) => (
                  <div
                    key={track.id}
                    style={{
                      width: "100%",
                      padding: "8px 10px",
                      borderBottom: "1px solid var(--color-border-subtle)",
                      display: "grid",
                      gridTemplateColumns: "minmax(0, 1fr) auto auto",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    <span style={{ minWidth: 0 }}>
                      <strong
                        style={{
                          display: "block",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {track.title}
                      </strong>
                      <span
                        style={{
                          display: "block",
                          marginTop: 2,
                          color: "var(--color-text-faint)",
                          fontSize: "var(--font-size-xs)",
                        }}
                      >
                        {track.artist} · {track.bpm?.toFixed(1)} BPM ·{" "}
                        {track.key_camelot}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{ height: 26 }}
                      onClick={() => chooseMixTrack(track, true)}
                    >
                      START
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={{ height: 26 }}
                      disabled={selectedTrackIds.includes(track.id)}
                      onClick={() => chooseMixTrack(track, false)}
                    >
                      + ADD
                    </button>
                  </div>
                ))}
                {trackSearchMessage ? (
                  <p
                    style={{
                      margin: 0,
                      padding: 8,
                      color: "var(--color-text-faint)",
                      fontSize: "var(--font-size-xs)",
                    }}
                  >
                    {trackSearchMessage}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
          <button
            type="submit"
            className="btn btn-secondary"
            style={{ height: 30 }}
            disabled={!trackSearch.trim() || !discoveryPool}
          >
            SEARCH
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ height: 30 }}
            disabled={isDiscoveryLoading}
            onClick={() => void refreshDiscovery()}
          >
            SURPRISE ME
          </button>
        </form>
      ) : null}

      {/* Body */}
      <div
        style={{
          flex: 1,
          display: "flex",
          overflow: "hidden",
          position: "relative",
        }}
      >
        {/* Controls panel */}
        {showNetwork ? (
          <aside
          style={{
            width: 220,
            flexShrink: 0,
            borderRight: "1px solid var(--color-border)",
            padding: "var(--space-4)",
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-5)",
          }}
        >
          <div>
            <p
              style={{
                fontFamily: "var(--font-label)",
                fontSize: "var(--font-size-xs)",
                color: "var(--color-text-faint)",
                letterSpacing: "var(--letter-spacing-label)",
                marginBottom: "var(--space-2)",
              }}
            >
              HARMONIC FOCUS
            </p>
            <div
              style={{
                border: "1px solid var(--color-border)",
                borderRadius: 10,
                padding: "var(--space-2)",
                background:
                  "color-mix(in srgb, var(--color-surface) 76%, transparent)",
              }}
            >
              <div style={{ display: "flex", justifyContent: "center" }}>
                <CamelotWheel
                  highlightedKeys={wheelHighlightedKeys}
                  size={172}
                />
              </div>
              <p
                style={{
                  marginTop: "var(--space-2)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--font-size-xs)",
                  color: "var(--color-text-secondary)",
                  textAlign: "center",
                }}
              >
                {focusKey
                  ? `${focusKey} + harmonic neighbors`
                  : "Hover or select a keyed track"}
              </p>
              {focusTrack ? (
                <p
                  style={{
                    marginTop: 4,
                    fontFamily: "var(--font-label)",
                    fontSize: "var(--font-size-xs)",
                    color: "var(--color-text-faint)",
                    textAlign: "center",
                    lineHeight: 1.3,
                  }}
                >
                  BPM mismatches beyond {bpmTol}% shrink back so the viable
                  transitions stay readable.
                </p>
              ) : null}
            </div>
          </div>

          {/* BPM tolerance */}
          <div>
            <p
              style={{
                fontFamily: "var(--font-label)",
                fontSize: "var(--font-size-xs)",
                color: "var(--color-text-faint)",
                letterSpacing: "var(--letter-spacing-label)",
                marginBottom: "var(--space-2)",
              }}
            >
              BPM TOLERANCE · {pendingBpmTol}%
            </p>
            <input
              type="range"
              min={1}
              max={20}
              value={pendingBpmTol}
              onChange={(e) => setPendingBpmTol(Number(e.target.value))}
              onMouseUp={() => setBpmTol(pendingBpmTol)}
              onTouchEnd={() => setBpmTol(pendingBpmTol)}
              style={{ width: "100%", accentColor: "var(--color-accent)" }}
            />
          </div>
          </aside>
        ) : null}

        {/* Network */}
        {showNetwork ? (
          <div
          style={{
            flex: 1,
            position: "relative",
            background: "var(--color-bg)",
          }}
        >
          {isLoading && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 10,
                background: "var(--color-bg)",
              }}
            >
              <span
                style={{
                  fontFamily: "var(--font-label)",
                  fontSize: "var(--font-size-sm)",
                  color: "var(--color-text-faint)",
                  letterSpacing: "var(--letter-spacing-label)",
                }}
              >
                BUILDING GRAPH…
              </span>
            </div>
          )}
          {error && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <span
                style={{
                  fontFamily: "var(--font-label)",
                  fontSize: "var(--font-size-sm)",
                  color: "var(--color-problem)",
                }}
              >
                FAILED TO LOAD GRAPH
              </span>
            </div>
          )}
          {!isLoading && !error && nodeCount === 0 ? (
            <div
              style={{
                position: "absolute",
                inset: 0,
                zIndex: 10,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: "var(--space-2)",
                pointerEvents: "none",
              }}
            >
              <strong
                style={{
                  fontFamily: "var(--font-label)",
                  fontSize: "var(--font-size-sm)",
                  color: "var(--color-text-secondary)",
                  letterSpacing: "var(--letter-spacing-label)",
                }}
              >
                {playlistId == null
                  ? "NO COMPATIBLE TRACKS FOUND"
                  : "THIS PLAYLIST IS EMPTY"}
              </strong>
              <span
                style={{
                  maxWidth: 360,
                  fontFamily: "var(--font-label)",
                  fontSize: "var(--font-size-xs)",
                  color: "var(--color-text-faint)",
                  lineHeight: 1.4,
                  textAlign: "center",
                }}
              >
                {playlistId == null
                  ? "Try Surprise me again, or analyze more tracks so DJ-IT has reliable Key and BPM data."
                  : "Add tracks to the playlist, then return here to inspect its transitions."}
              </span>
            </div>
          ) : null}

          {/* Floating selection actions */}
          {showSelectionPanel &&
            (actionTrackIds.length > 0 ||
              excludedTrackIds.length > 0 ||
              playlistActionMessage) && (
            <div
              style={{
                position: "absolute",
                top: "var(--space-4)",
                right: "var(--space-4)",
                bottom: "var(--space-4)",
                width: "min(420px, calc(100% - var(--space-8)))",
                maxWidth: "calc(100% - var(--space-8))",
                zIndex: 25,
                border: "1px solid var(--color-border)",
                borderRadius: 10,
                padding: "var(--space-3)",
                boxSizing: "border-box",
                background:
                  "color-mix(in srgb, var(--color-surface) 92%, transparent)",
                backdropFilter: "blur(4px)",
                boxShadow: "0 12px 30px rgba(0, 0, 0, 0.28)",
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-2)",
                overflowY: "auto",
                overflowX: "hidden",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <p
                  style={{
                    fontFamily: "var(--font-label)",
                    fontSize: "var(--font-size-xs)",
                    color: "var(--color-text-faint)",
                    letterSpacing: "var(--letter-spacing-label)",
                  }}
                >
                  GRAPH SELECTION
                </p>
                <button
                  type="button"
                  onClick={() => setShowSelectionPanel(false)}
                  className="btn btn-ghost"
                  style={{ height: 22 }}
                  aria-label="Close route editor"
                >
                  ✕
                </button>
              </div>
              <p
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--font-size-sm)",
                  color: "var(--color-text-primary)",
                }}
              >
                {actionTrackIds.length} active · {excludedTrackIds.length}{" "}
                excluded
              </p>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <p
                  style={{
                    fontFamily: "var(--font-label)",
                    fontSize: "var(--font-size-xs)",
                    color: "var(--color-text-faint)",
                  }}
                >
                  Set length is measured in tracks.
                </p>
                {excludedTrackIds.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => setExcludedTrackIds([])}
                    disabled={isPlaylistActionBusy}
                    style={{
                      border: "none",
                      background: "transparent",
                      color: "var(--color-text-faint)",
                      fontFamily: "var(--font-label)",
                      fontSize: 10,
                      cursor: isPlaylistActionBusy ? "not-allowed" : "pointer",
                    }}
                  >
                    CLEAR EXCLUDES
                  </button>
                ) : null}
              </div>

              <div
                style={{
                  border: "1px solid var(--color-border)",
                  borderRadius: 8,
                  padding: "var(--space-2)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--space-2)",
                  maxHeight: 180,
                  overflow: "auto",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                  }}
                >
                  <p
                    style={{
                      fontFamily: "var(--font-label)",
                      fontSize: "var(--font-size-xs)",
                      color: "var(--color-text-faint)",
                      letterSpacing: "var(--letter-spacing-label)",
                    }}
                  >
                    ACTIVE ROUTE
                  </p>
                  <button
                    type="button"
                    onClick={() => playRouteFromIndex(0)}
                    disabled={isPlaylistActionBusy || activeTracks.length === 0}
                    style={{
                      height: 22,
                      width: 22,
                      borderRadius: 4,
                      border: "1px solid var(--color-border)",
                      background: "transparent",
                      color: "var(--color-text-primary)",
                      fontFamily: "var(--font-label)",
                      fontSize: 10,
                      cursor:
                        isPlaylistActionBusy || activeTracks.length === 0
                          ? "not-allowed"
                          : "pointer",
                      lineHeight: 1,
                    }}
                    title="Play route from top"
                  >
                    ▶
                  </button>
                </div>
                {activeTracks.length === 0 ? (
                  <p
                    style={{
                      fontFamily: "var(--font-label)",
                      fontSize: "var(--font-size-xs)",
                      color: "var(--color-text-faint)",
                    }}
                  >
                    Shift/Cmd-click tracks to build your set.
                  </p>
                ) : (
                  activeTracks.map((track, index) => (
                    <div
                      key={track.id}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr auto auto auto auto auto",
                        gap: 4,
                        alignItems: "center",
                        minWidth: 0,
                      }}
                    >
                      <p
                        style={{
                          fontFamily: "var(--font-label)",
                          fontSize: "var(--font-size-xs)",
                          color: "var(--color-text-secondary)",
                          lineHeight: 1.2,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          minWidth: 0,
                        }}
                        title={`${index + 1}. ${track.title} — ${track.artist}`}
                      >
                        {index + 1}. {track.title} — {track.artist}
                      </p>
                      <button
                        type="button"
                        onClick={() => playRouteFromIndex(index)}
                        disabled={isPlaylistActionBusy}
                        style={{
                          height: 22,
                          width: 22,
                          borderRadius: 4,
                          border: "1px solid var(--color-border)",
                          background: "transparent",
                          color: "var(--color-text-primary)",
                          fontFamily: "var(--font-label)",
                          fontSize: 10,
                          cursor: isPlaylistActionBusy
                            ? "not-allowed"
                            : "pointer",
                          lineHeight: 1,
                        }}
                        title="Play from here"
                      >
                        ▶
                      </button>
                      <button
                        type="button"
                        onClick={() => moveTrackInSelection(track.id, -1)}
                        disabled={isPlaylistActionBusy || index === 0}
                        style={{
                          height: 22,
                          width: 22,
                          borderRadius: 4,
                          border: "1px solid var(--color-border)",
                          background: "transparent",
                          color: "var(--color-text-faint)",
                          fontFamily: "var(--font-label)",
                          fontSize: 10,
                          cursor:
                            isPlaylistActionBusy || index === 0
                              ? "not-allowed"
                              : "pointer",
                          lineHeight: 1,
                        }}
                        title="Move up"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        onClick={() => moveTrackInSelection(track.id, 1)}
                        disabled={
                          isPlaylistActionBusy ||
                          index === activeTracks.length - 1
                        }
                        style={{
                          height: 22,
                          width: 22,
                          borderRadius: 4,
                          border: "1px solid var(--color-border)",
                          background: "transparent",
                          color: "var(--color-text-faint)",
                          fontFamily: "var(--font-label)",
                          fontSize: 10,
                          cursor:
                            isPlaylistActionBusy ||
                            index === activeTracks.length - 1
                              ? "not-allowed"
                              : "pointer",
                          lineHeight: 1,
                        }}
                        title="Move down"
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        onClick={() => removeTrackFromSelection(track.id)}
                        disabled={isPlaylistActionBusy}
                        style={{
                          height: 22,
                          borderRadius: 4,
                          border: "1px solid var(--color-border)",
                          background: "transparent",
                          color: "var(--color-text-faint)",
                          fontFamily: "var(--font-label)",
                          fontSize: 10,
                          cursor: isPlaylistActionBusy
                            ? "not-allowed"
                            : "pointer",
                          lineHeight: 1,
                        }}
                        title="Remove from route"
                      >
                        🗑
                      </button>
                      <button
                        type="button"
                        onClick={() => excludeTrack(track.id)}
                        disabled={isPlaylistActionBusy}
                        style={{
                          height: 22,
                          borderRadius: 4,
                          border: "1px solid var(--color-border)",
                          background: "transparent",
                          color: "var(--color-problem)",
                          fontFamily: "var(--font-label)",
                          fontSize: 10,
                          cursor: isPlaylistActionBusy
                            ? "not-allowed"
                            : "pointer",
                          lineHeight: 1,
                        }}
                        title="Exclude from future reruns"
                      >
                        ⊘
                      </button>
                    </div>
                  ))
                )}
              </div>

              <div
                style={{
                  border: "1px solid var(--color-border)",
                  borderRadius: 8,
                  padding: "var(--space-2)",
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 8,
                }}
              >
                <label
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                    fontFamily: "var(--font-label)",
                    fontSize: "var(--font-size-xs)",
                    color: "var(--color-text-faint)",
                  }}
                >
                  SET LENGTH (TRACKS)
                  <input
                    value={targetSetLengthInput}
                    onChange={(e) => setTargetSetLengthInput(e.target.value)}
                    placeholder="No limit"
                    inputMode="numeric"
                    disabled={isPlaylistActionBusy}
                    style={{
                      width: "100%",
                      padding: "6px 8px",
                      borderRadius: 6,
                      border: "1px solid var(--color-border)",
                      background: "var(--color-bg)",
                      color: "var(--color-text-primary)",
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--font-size-xs)",
                    }}
                  />
                </label>

                <label
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                    fontFamily: "var(--font-label)",
                    fontSize: "var(--font-size-xs)",
                    color: "var(--color-text-faint)",
                  }}
                >
                  PROFILE
                  <select
                    value={harmonizeProfile}
                    onChange={(e) =>
                      setHarmonizeProfile(
                        e.target.value as "build_up" | "cruise" | "cooldown",
                      )
                    }
                    disabled={isPlaylistActionBusy}
                    style={{
                      width: "100%",
                      padding: "6px 8px",
                      borderRadius: 6,
                      border: "1px solid var(--color-border)",
                      background: "var(--color-bg)",
                      color: "var(--color-text-primary)",
                      fontFamily: "var(--font-label)",
                      fontSize: "var(--font-size-xs)",
                    }}
                  >
                    <option value="build_up">Build Up</option>
                    <option value="cruise">Cruise</option>
                    <option value="cooldown">Cooldown</option>
                  </select>
                </label>

                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontFamily: "var(--font-label)",
                    fontSize: "var(--font-size-xs)",
                    color: "var(--color-text-secondary)",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={lockFirst}
                    onChange={(e) => setLockFirst(e.target.checked)}
                    disabled={isPlaylistActionBusy}
                  />
                  LOCK FIRST
                </label>

                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontFamily: "var(--font-label)",
                    fontSize: "var(--font-size-xs)",
                    color: "var(--color-text-secondary)",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={lockLast}
                    onChange={(e) => setLockLast(e.target.checked)}
                    disabled={isPlaylistActionBusy}
                  />
                  LOCK LAST
                </label>
              </div>

              <input
                value={newPlaylistName}
                onChange={(e) => setNewPlaylistName(e.target.value)}
                placeholder="New playlist name"
                disabled={isPlaylistActionBusy || actionTrackIds.length === 0}
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  borderRadius: 6,
                  border: "1px solid var(--color-border)",
                  background: "var(--color-bg)",
                  color: "var(--color-text-primary)",
                  fontFamily: "var(--font-label)",
                  fontSize: "var(--font-size-xs)",
                }}
              />

              <button
                type="button"
                onClick={() => {
                  void createPlaylistFromSelection();
                }}
                disabled={isPlaylistActionBusy || actionTrackIds.length === 0}
                style={{
                  height: 32,
                  borderRadius: 6,
                  border: "1px solid var(--color-border)",
                  background: "var(--color-accent)",
                  color: "var(--color-bg)",
                  fontFamily: "var(--font-label)",
                  fontSize: "var(--font-size-xs)",
                  fontWeight: 700,
                  cursor:
                    isPlaylistActionBusy || actionTrackIds.length === 0
                      ? "not-allowed"
                      : "pointer",
                  opacity:
                    isPlaylistActionBusy || actionTrackIds.length === 0
                      ? 0.5
                      : 1,
                }}
              >
                CREATE PLAYLIST
              </button>

              <select
                value={targetPlaylistId}
                onChange={(e) => setTargetPlaylistId(e.target.value)}
                disabled={isPlaylistActionBusy || playlists.length === 0}
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  borderRadius: 6,
                  border: "1px solid var(--color-border)",
                  background: "var(--color-bg)",
                  color: "var(--color-text-primary)",
                  fontFamily: "var(--font-label)",
                  fontSize: "var(--font-size-xs)",
                }}
              >
                <option value="">Add to existing…</option>
                {playlists.map((playlist) => (
                  <option key={playlist.id} value={String(playlist.id)}>
                    {playlist.name}
                  </option>
                ))}
              </select>

              <button
                type="button"
                onClick={() => {
                  void addSelectionToPlaylist();
                }}
                disabled={
                  isPlaylistActionBusy ||
                  actionTrackIds.length === 0 ||
                  targetPlaylistId.trim().length === 0
                }
                style={{
                  height: 32,
                  borderRadius: 6,
                  border: "1px solid var(--color-border)",
                  background: "var(--color-bg)",
                  color: "var(--color-text-primary)",
                  fontFamily: "var(--font-label)",
                  fontSize: "var(--font-size-xs)",
                  fontWeight: 700,
                  cursor:
                    isPlaylistActionBusy ||
                    actionTrackIds.length === 0 ||
                    targetPlaylistId.trim().length === 0
                      ? "not-allowed"
                      : "pointer",
                  opacity:
                    isPlaylistActionBusy ||
                    actionTrackIds.length === 0 ||
                    targetPlaylistId.trim().length === 0
                      ? 0.5
                      : 1,
                }}
              >
                ADD TO PLAYLIST
              </button>

              <button
                type="button"
                onClick={() => setSelectedTrackIds([])}
                disabled={isPlaylistActionBusy || selectedTrackIds.length === 0}
                style={{
                  height: 28,
                  borderRadius: 6,
                  border: "1px dashed var(--color-border)",
                  background: "transparent",
                  color: "var(--color-text-faint)",
                  fontFamily: "var(--font-label)",
                  fontSize: "var(--font-size-xs)",
                  cursor:
                    isPlaylistActionBusy || selectedTrackIds.length === 0
                      ? "not-allowed"
                      : "pointer",
                  opacity:
                    isPlaylistActionBusy || selectedTrackIds.length === 0
                      ? 0.5
                      : 1,
                }}
              >
                CLEAR SELECTION
              </button>

              {/* Divider */}
              <div
                style={{
                  height: "1px",
                  background: "var(--color-border)",
                  margin: "var(--space-2) 0",
                }}
              />

              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--space-2)",
                }}
              >
                <p
                  style={{
                    fontFamily: "var(--font-label)",
                    fontSize: "var(--font-size-xs)",
                    color: "var(--color-text-faint)",
                    lineHeight: 1.25,
                  }}
                >
                  Active pool: {actionTrackIds.length} track
                  {actionTrackIds.length === 1 ? "" : "s"}
                </p>
                {startTrack && endTrack ? (
                  <>
                    <p
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "var(--font-size-xs)",
                        color: "var(--color-text-secondary)",
                        lineHeight: 1.25,
                      }}
                    >
                      Start: {formatTrackOptionLabel(startTrack)}
                    </p>
                    <p
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "var(--font-size-xs)",
                        color: "var(--color-text-secondary)",
                        lineHeight: 1.25,
                      }}
                    >
                      End: {formatTrackOptionLabel(endTrack)}
                    </p>
                  </>
                ) : null}

                <button
                  type="button"
                  onClick={() => void orderSelectedTracks()}
                  disabled={isPlaylistActionBusy || actionTrackIds.length < 2}
                  style={{
                    height: 32,
                    borderRadius: 6,
                    border: "1px solid var(--color-border)",
                    background: "var(--color-bg)",
                    color: "var(--color-text-primary)",
                    fontFamily: "var(--font-label)",
                    fontSize: "var(--font-size-xs)",
                    fontWeight: 700,
                    cursor:
                      isPlaylistActionBusy || actionTrackIds.length < 2
                        ? "not-allowed"
                        : "pointer",
                    opacity:
                      isPlaylistActionBusy || actionTrackIds.length < 2
                        ? 0.5
                        : 1,
                  }}
                >
                  💫 SMART ORDER (HARMONIZER)
                </button>

                <button
                  type="button"
                  onClick={() => void findPathBetweenTracks()}
                  disabled={isPlaylistActionBusy || actionTrackIds.length < 1}
                  style={{
                    height: 32,
                    borderRadius: 6,
                    border: "1px solid var(--color-border)",
                    background: "var(--color-accent)",
                    color: "var(--color-bg)",
                    fontFamily: "var(--font-label)",
                    fontSize: "var(--font-size-xs)",
                    fontWeight: 700,
                    cursor:
                      isPlaylistActionBusy || actionTrackIds.length < 1
                        ? "not-allowed"
                        : "pointer",
                    opacity:
                      isPlaylistActionBusy || actionTrackIds.length < 1
                        ? 0.5
                        : 1,
                  }}
                >
                  🛤️ FIND PATH (START → END)
                </button>
              </div>

              {playlistActionMessage ? (
                <p
                  style={{
                    fontFamily: "var(--font-label)",
                    fontSize: "var(--font-size-xs)",
                    color: "var(--color-text-secondary)",
                    lineHeight: 1.3,
                  }}
                >
                  {playlistActionMessage}
                </p>
              ) : null}
            </div>
          )}

            <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
          </div>
        ) : (
          <div
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              background: "var(--color-bg)",
            }}
          >
            {isLoading ? (
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontFamily: "var(--font-label)",
                  color: "var(--color-text-faint)",
                }}
              >
                BUILDING MIX MAP…
              </div>
            ) : error ? (
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontFamily: "var(--font-label)",
                  color: "var(--color-problem)",
                }}
              >
                FAILED TO LOAD MIX MAP
              </div>
            ) : (
              <>
                <section
                  style={{
                    order: 1,
                    flex: 1,
                    minWidth: 0,
                    padding: "var(--space-5)",
                    overflowY: "auto",
                  }}
                >
                  {playlistId == null ? (
                    <div
                      style={{
                        marginBottom: "var(--space-5)",
                        padding: "var(--space-4)",
                        border: "1px solid var(--color-border)",
                        borderRadius: 10,
                        background: "var(--color-surface)",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "var(--space-3)",
                          marginBottom: "var(--space-3)",
                        }}
                      >
                        <div>
                          <p
                            style={{
                              margin: 0,
                              fontFamily: "var(--font-label)",
                              fontSize: "var(--font-size-xs)",
                              color: "var(--color-text-faint)",
                              letterSpacing: "var(--letter-spacing-label)",
                            }}
                          >
                            YOUR MIX · {activeTracks.length}{" "}
                            {activeTracks.length === 1 ? "TRACK" : "TRACKS"}
                          </p>
                          <p
                            style={{
                              margin: "4px 0 0",
                              fontFamily: "var(--font-label)",
                              fontSize: "var(--font-size-xs)",
                              color: "var(--color-text-secondary)",
                            }}
                          >
                            Find must-play tracks, add compatible suggestions,
                            then save the sequence.
                          </p>
                        </div>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          style={{ height: 26 }}
                          disabled={activeTracks.length === 0}
                          onClick={() => setSelectedTrackIds([])}
                        >
                          CLEAR
                        </button>
                      </div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          overflowX: "auto",
                          paddingBottom: "var(--space-2)",
                        }}
                      >
                        {activeTracks.length === 0 ? (
                          <span
                            style={{
                              color: "var(--color-text-faint)",
                              fontFamily: "var(--font-label)",
                              fontSize: "var(--font-size-xs)",
                            }}
                          >
                            Search above and choose START or + ADD.
                          </span>
                        ) : (
                          activeTracks.map((track, index) => {
                            const previous = activeTracks[index - 1];
                            const compatible =
                              index === 0 ||
                              getTrackCompatibility(previous, track, bpmTol) ===
                                "compatible";
                            return (
                              <span
                                key={track.id}
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: 6,
                                  flexShrink: 0,
                                }}
                              >
                                {index > 0 ? (
                                  <span
                                    title={
                                      compatible
                                        ? "Compatible transition"
                                        : "This transition needs attention"
                                    }
                                    style={{
                                      color: compatible
                                        ? "var(--color-keep)"
                                        : "var(--color-problem)",
                                    }}
                                  >
                                    {compatible ? "→" : "⚠"}
                                  </span>
                                ) : null}
                                <span
                                  style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    border:
                                      index === activeTracks.length - 1
                                        ? "1px solid var(--color-accent)"
                                        : "1px solid var(--color-border)",
                                    borderRadius: 6,
                                    overflow: "hidden",
                                  }}
                                >
                                  <button
                                    type="button"
                                    onClick={() => previewTrack(track)}
                                    style={{
                                      width: 230,
                                      padding: "9px 10px",
                                      border: 0,
                                      background: "transparent",
                                      color: "var(--color-text-primary)",
                                      fontFamily: "var(--font-label)",
                                      fontSize: "var(--font-size-xs)",
                                      textAlign: "left",
                                      cursor: "pointer",
                                    }}
                                    title={`${track.title} — ${track.artist} · ${track.bpm?.toFixed(1)} BPM · ${track.key_camelot ?? "—"}`}
                                  >
                                    <strong
                                      style={{
                                        display: "block",
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        whiteSpace: "nowrap",
                                      }}
                                    >
                                      {index + 1}. {track.title}
                                    </strong>
                                    <span
                                      style={{
                                        display: "block",
                                        marginTop: 3,
                                        color: "var(--color-text-secondary)",
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        whiteSpace: "nowrap",
                                      }}
                                    >
                                      {track.artist}
                                    </span>
                                    <span
                                      style={{
                                        display: "block",
                                        marginTop: 5,
                                        color: "var(--color-text-faint)",
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        whiteSpace: "nowrap",
                                      }}
                                    >
                                      {track.bpm?.toFixed(1) ?? "—"} BPM ·{" "}
                                      {track.key_camelot ?? "—"} ·{" "}
                                      {track.genre ?? "No genre"} · Intensity{" "}
                                      {track.energy ?? "—"}
                                    </span>
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      removeTrackFromSelection(track.id)
                                    }
                                    aria-label={`Remove ${track.title} from mix`}
                                    style={{
                                      padding: "7px 8px",
                                      border: 0,
                                      borderLeft:
                                        "1px solid var(--color-border)",
                                      background: "transparent",
                                      color: "var(--color-text-faint)",
                                      cursor: "pointer",
                                    }}
                                  >
                                    ×
                                  </button>
                                </span>
                              </span>
                            );
                          })
                        )}
                      </div>
                      <div
                        style={{
                          display: "flex",
                          gap: "var(--space-2)",
                          alignItems: "center",
                          marginTop: "var(--space-2)",
                        }}
                      >
                        <input
                          value={newPlaylistName}
                          onChange={(event) =>
                            setNewPlaylistName(event.target.value)
                          }
                          aria-label="Playlist name"
                          style={{
                            flex: 1,
                            minWidth: 0,
                            height: 30,
                            padding: "0 var(--space-2)",
                            border: "1px solid var(--color-border)",
                            background: "var(--color-bg-input)",
                            color: "var(--color-text-primary)",
                          }}
                        />
                        <button
                          type="button"
                          className="btn btn-primary"
                          style={{ height: 30 }}
                          disabled={
                            isPlaylistActionBusy || activeTracks.length === 0
                          }
                          onClick={() => void createPlaylistFromSelection()}
                        >
                          SAVE AS PLAYLIST
                        </button>
                      </div>
                      {playlistActionMessage ? (
                        <p
                          style={{
                            margin: "var(--space-2) 0 0",
                            color: "var(--color-text-secondary)",
                            fontFamily: "var(--font-label)",
                            fontSize: "var(--font-size-xs)",
                          }}
                        >
                          {playlistActionMessage}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      justifyContent: "space-between",
                      gap: "var(--space-3)",
                      marginBottom: "var(--space-4)",
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <p
                        style={{
                          fontFamily: "var(--font-label)",
                          fontSize: "var(--font-size-xs)",
                          color: "var(--color-text-faint)",
                          letterSpacing: "var(--letter-spacing-label)",
                          marginBottom: 4,
                        }}
                      >
                        {playlistId ? "PLAYLIST TRACKS" : "COMPATIBLE AFTER"}
                      </p>
                      <h2
                        style={{
                          margin: 0,
                          fontFamily: "var(--font-label)",
                          fontSize: "var(--font-size-lg)",
                          color: "var(--color-text-primary)",
                        }}
                      >
                        {mixAnchor
                          ? `${mixAnchor.title} — ${mixAnchor.artist}`
                          : "Choose a track"}
                      </h2>
                      <p
                        style={{
                          marginTop: 4,
                          fontFamily: "var(--font-label)",
                          fontSize: "var(--font-size-xs)",
                          color: "var(--color-text-faint)",
                        }}
                      >
                        {playlistId
                          ? "Preview tracks in this playlist."
                          : `Every suggestion below is compatible with this track: harmonic key and within ${bpmTol}% BPM. Preview it or add it next.`}
                      </p>
                    </div>
                  </div>

                  {playlistId == null ? (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "flex-end",
                        gap: "var(--space-4)",
                        flexWrap: "wrap",
                        marginBottom: "var(--space-4)",
                        padding: "var(--space-3)",
                        border: "1px solid var(--color-border-subtle)",
                        background: "var(--color-bg-row-alt)",
                      }}
                    >
                      <div>
                        <span className="library-filter-summary">
                          DIRECTION
                        </span>
                        <div
                          className="review-mode-bar"
                          style={{ marginTop: 6 }}
                        >
                          {(
                            [
                              ["build_up", "BUILD UP"],
                              ["cruise", "CRUISE"],
                              ["cooldown", "COOL DOWN"],
                            ] as const
                          ).map(([value, label]) => (
                            <button
                              key={value}
                              type="button"
                              className={
                                harmonizeProfile === value
                                  ? "review-mode-button active"
                                  : "review-mode-button"
                              }
                              onClick={() => setHarmonizeProfile(value)}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div>
                        <span className="library-filter-summary">KEY</span>
                        <div
                          className="review-mode-bar"
                          style={{ marginTop: 6 }}
                        >
                          {(
                            [
                              ["same", "SAME KEY"],
                              ["harmonic", "HARMONIC"],
                            ] as const
                          ).map(([value, label]) => (
                            <button
                              key={value}
                              type="button"
                              className={
                                mixKeyScope === value
                                  ? "review-mode-button active"
                                  : "review-mode-button"
                              }
                              onClick={() => setMixKeyScope(value)}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div>
                        <span className="library-filter-summary">
                          BPM RANGE
                        </span>
                        <div
                          className="review-mode-bar"
                          style={{ marginTop: 6 }}
                        >
                          {[3, 5, 8].map((value) => (
                            <button
                              key={value}
                              type="button"
                              className={
                                bpmTol === value
                                  ? "review-mode-button active"
                                  : "review-mode-button"
                              }
                              onClick={() => {
                                setBpmTol(value);
                                setPendingBpmTol(value);
                              }}
                            >
                              {value}%
                            </button>
                          ))}
                        </div>
                      </div>
                      <span
                        style={{
                          color: "var(--color-text-faint)",
                          fontFamily: "var(--font-label)",
                          fontSize: "var(--font-size-xs)",
                        }}
                      >
                        {harmonizeProfile === "build_up"
                          ? "Favors rising tempo and intensity."
                          : harmonizeProfile === "cooldown"
                            ? "Favors falling tempo and intensity."
                            : "Favors the closest musical fit."}
                      </span>
                    </div>
                  ) : null}

                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                    }}
                  >
                    {mixCandidates.slice(0, 20).map((candidate, index) => {
                      return (
                        <div
                          key={candidate.track.id}
                          style={{
                            width: "100%",
                            display: "grid",
                            gridTemplateColumns: playlistId
                              ? "minmax(0, 1fr)"
                              : "minmax(0, 1fr) 38px 96px",
                            alignItems: "center",
                            gap: 6,
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => previewTrack(candidate.track)}
                            style={{
                              width: "100%",
                              display: "grid",
                              gridTemplateColumns:
                                "52px minmax(0, 1fr) 74px 52px 72px",
                              alignItems: "center",
                              gap: "var(--space-3)",
                              padding: "10px 12px",
                              borderRadius: 8,
                              border: "1px solid var(--color-border)",
                              background: "var(--color-surface)",
                              color: "var(--color-text-primary)",
                              textAlign: "left",
                              cursor: "pointer",
                            }}
                          >
                          <span
                            style={{
                              fontFamily: "var(--font-label)",
                              fontSize: "var(--font-size-xs)",
                              color:
                                candidate.score >= 90
                                  ? "var(--color-keep)"
                                  : "var(--color-text-secondary)",
                            }}
                          >
                            {candidate.score >= 95
                              ? "GREAT"
                              : candidate.score >= 88
                                ? "GOOD"
                                : "OK"}
                          </span>
                          <span style={{ minWidth: 0 }}>
                            <strong
                              style={{
                                display: "block",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                fontFamily: "var(--font-label)",
                                fontSize: "var(--font-size-sm)",
                              }}
                            >
                              {index + 1}. {candidate.track.title}
                            </strong>
                            <span
                              style={{
                                display: "block",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                fontFamily: "var(--font-label)",
                                fontSize: "var(--font-size-xs)",
                                color: "var(--color-text-faint)",
                              }}
                            >
                              {candidate.track.artist}
                            </span>
                          </span>
                          <span
                            style={{
                              fontFamily: "var(--font-mono)",
                              fontSize: "var(--font-size-xs)",
                              color: "var(--color-text-secondary)",
                            }}
                          >
                            {candidate.track.bpm?.toFixed(1)}
                            <small
                              style={{ display: "block", opacity: 0.7 }}
                            >
                              Δ {candidate.bpmDifference}%
                            </small>
                          </span>
                          <span
                            style={{
                              fontFamily: "var(--font-mono)",
                              fontSize: "var(--font-size-sm)",
                              color:
                                KEY_COLORS[candidate.track.key_camelot ?? ""] ??
                                "var(--color-text-secondary)",
                            }}
                          >
                            {candidate.track.key_camelot ?? "—"}
                          </span>
                          <span
                            style={{
                              fontFamily: "var(--font-label)",
                              fontSize: "var(--font-size-xs)",
                              color: "var(--color-text-faint)",
                            }}
                          >
                            {candidate.relation}
                          </span>
                          </button>
                          {playlistId == null ? (
                            <details
                              style={{ position: "relative", height: 38 }}
                            >
                              <summary
                                className="btn btn-ghost"
                                title="More track actions"
                                style={{
                                  width: 38,
                                  height: 38,
                                  padding: 0,
                                  listStyle: "none",
                                  cursor: "pointer",
                                }}
                              >
                                •••
                              </summary>
                              <div
                                style={{
                                  position: "absolute",
                                  top: 42,
                                  right: 0,
                                  zIndex: 4,
                                  width: 124,
                                  padding: 6,
                                  border: "1px solid var(--color-border)",
                                  borderRadius: 6,
                                  background: "var(--color-bg-sidebar)",
                                  boxShadow: "0 12px 30px rgba(0, 0, 0, 0.35)",
                                }}
                              >
                                <button
                                  type="button"
                                  className="btn btn-ghost"
                                  style={{ width: "100%", whiteSpace: "nowrap" }}
                                  onClick={(event) => {
                                    event.currentTarget
                                      .closest("details")
                                      ?.removeAttribute("open");
                                    setEditingTrack(
                                      discoveryPool?.find(
                                        (track) =>
                                          track.id === candidate.track.id,
                                      ) ?? null,
                                    );
                                  }}
                                >
                                  CLEAN UP
                                </button>
                              </div>
                            </details>
                          ) : null}
                          {playlistId == null ? (
                            <button
                              type="button"
                              className="btn btn-secondary"
                              style={{ height: 38, whiteSpace: "nowrap" }}
                              onClick={() => addTrackToMix(candidate.track)}
                            >
                              ADD NEXT
                            </button>
                          ) : null}
                        </div>
                      );
                    })}
                    {mixCandidates.length === 0 ? (
                      <p
                        style={{
                          padding: "var(--space-5)",
                          border: "1px solid var(--color-border)",
                          borderRadius: 8,
                          fontFamily: "var(--font-label)",
                          color: "var(--color-text-faint)",
                        }}
                      >
                        No compatible suggestions after this track at {bpmTol}%
                        BPM tolerance.
                      </p>
                    ) : null}
                  </div>
                </section>

                <aside
                  style={{
                    order: 2,
                    width: "auto",
                    flexShrink: 0,
                    padding: "var(--space-3) var(--space-5)",
                    borderBottom: "1px solid var(--color-border)",
                    overflow: "hidden",
                  }}
                >
                  <p
                    style={{
                      fontFamily: "var(--font-label)",
                      fontSize: "var(--font-size-xs)",
                      color: "var(--color-text-faint)",
                      letterSpacing: "var(--letter-spacing-label)",
                      marginBottom: "var(--space-2)",
                    }}
                  >
                    {playlistId ? "PLAYLIST BPM FLOW" : "BPM × CAMELOT MAP"}
                  </p>
                  <div
                    style={{
                      border: "1px solid var(--color-border)",
                      borderRadius: 10,
                      padding: "var(--space-2)",
                      background: "var(--color-surface)",
                    }}
                  >
                    <svg
                      viewBox="0 0 400 240"
                      role="img"
                      aria-label={
                        playlistId
                          ? "Playlist BPM flow by track order"
                          : "Tracks plotted by BPM and Camelot number"
                      }
                      style={{ width: "100%", height: 145 }}
                    >
                      {Array.from({ length: playlistId ? 5 : 12 }, (_, i) => {
                        const y = playlistId ? 40 + i * 42.5 : 210 - i * 15.45;
                        return (
                          <g key={i}>
                            <line
                              x1="44"
                              x2="376"
                              y1={y}
                              y2={y}
                              stroke="var(--color-border)"
                              strokeWidth="1"
                            />
                            {!playlistId ? (
                              <text
                                x="28"
                                y={y + 3}
                                fill="var(--color-text-faint)"
                                fontSize="9"
                                textAnchor="middle"
                              >
                                {i + 1}
                              </text>
                            ) : null}
                          </g>
                        );
                      })}
                      {playlistId && chartTracks.points.length > 1 ? (
                        <polyline
                          points={chartTracks.points
                            .map(({ x, y }) => `${x},${y}`)
                            .join(" ")}
                          fill="none"
                          stroke="var(--color-text-faint)"
                          strokeWidth="1.5"
                        />
                      ) : null}
                      {chartTracks.points.map(({ track, x, y }) => {
                        const key = parseCamelot(track.key_camelot);
                        const selected = track.id === mixAnchor?.id;
                        const color = deriveNodeColor(track);
                        return key?.mode === "B" ? (
                          <rect
                            key={track.id}
                            x={x - (selected ? 5 : 3.5)}
                            y={y - (selected ? 5 : 3.5)}
                            width={selected ? 10 : 7}
                            height={selected ? 10 : 7}
                            rx="1"
                            fill={color}
                            stroke={selected ? "white" : "none"}
                            strokeWidth="2"
                          >
                            <title>{`${track.title} — ${track.artist} · ${track.bpm?.toFixed(1)} BPM · ${track.key_camelot}`}</title>
                          </rect>
                        ) : (
                          <circle
                            key={track.id}
                            cx={x}
                            cy={y}
                            r={selected ? 5 : 3.5}
                            fill={color}
                            stroke={selected ? "white" : "none"}
                            strokeWidth="2"
                          >
                            <title>{`${track.title} — ${track.artist} · ${track.bpm?.toFixed(1)} BPM · ${track.key_camelot}`}</title>
                          </circle>
                        );
                      })}
                      <text
                        x="44"
                        y="232"
                        fill="var(--color-text-faint)"
                        fontSize="9"
                      >
                        {playlistId ? "1" : chartTracks.minBpm.toFixed(1)}
                      </text>
                      <text
                        x="376"
                        y="232"
                        fill="var(--color-text-faint)"
                        fontSize="9"
                        textAnchor="end"
                      >
                        {playlistId
                          ? String(chartTracks.points.length)
                          : chartTracks.maxBpm.toFixed(1)}
                      </text>
                    </svg>
                    <div
                      style={{
                        display: "flex",
                        gap: "var(--space-3)",
                        justifyContent: "center",
                        fontFamily: "var(--font-label)",
                        fontSize: "var(--font-size-xs)",
                        color: "var(--color-text-faint)",
                      }}
                    >
                      <span>● Minor (A)</span>
                      <span>■ Major (B)</span>
                    </div>
                  </div>

                  {playlistTransitions.length > 0 ? (
                    <div style={{ marginTop: "var(--space-4)" }}>
                      <p
                        style={{
                          fontFamily: "var(--font-label)",
                          fontSize: "var(--font-size-xs)",
                          color: "var(--color-text-faint)",
                          letterSpacing: "var(--letter-spacing-label)",
                          marginBottom: 6,
                        }}
                      >
                        TRANSITION STRIP
                      </p>
                      <div style={{ display: "flex", gap: 2 }}>
                        {playlistTransitions.map((transition, index) => {
                          const color =
                            transition.compatibility === "compatible"
                              ? "var(--color-keep)"
                              : transition.compatibility === "bpm-mismatch"
                                ? "var(--color-maybe)"
                                : transition.compatibility === "key-mismatch"
                                  ? "var(--color-problem)"
                                  : "var(--color-text-faint)";
                          return (
                            <span
                              key={`${transition.from?.id}-${transition.to?.id}-${index}`}
                              title={`${transition.from?.title ?? "Unknown"} → ${transition.to?.title ?? "Unknown"}: ${transition.compatibility.replace("-", " ")}`}
                              style={{
                                flex: 1,
                                height: 12,
                                minWidth: 3,
                                borderRadius: 2,
                                background: color,
                              }}
                            />
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </aside>
              </>
            )}
          </div>
        )}

        {/* Hover tooltip */}
        {hoveredNode && (
          <div
            style={{
              position: "fixed",
              left: tooltipPos.x + 14,
              top: tooltipPos.y + 14,
              zIndex: 100,
              background: "#f8fafc",
              border: "1px solid #cbd5e1",
              borderRadius: 6,
              padding: "var(--space-2) var(--space-3)",
              pointerEvents: "none",
              maxWidth: 240,
              boxShadow: "0 10px 24px rgba(2, 6, 23, 0.22)",
            }}
          >
            <p
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--font-size-xs)",
                color: "#0f172a",
                fontWeight: 600,
                marginBottom: 2,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {hoveredNode.title}
            </p>
            <p
              style={{
                fontFamily: "var(--font-label)",
                fontSize: "var(--font-size-xs)",
                color: "#334155",
                marginBottom: 4,
              }}
            >
              {hoveredNode.artist}
            </p>
            <div
              style={{
                display: "flex",
                gap: "var(--space-3)",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--font-size-xs)",
                color: "#475569",
              }}
            >
              {hoveredNode.bpm != null && (
                <span>{hoveredNode.bpm.toFixed(1)} BPM</span>
              )}
              {hoveredNode.key_camelot && (
                <span>{hoveredNode.key_camelot}</span>
              )}
              {hoveredNode.energy != null && <span>E{hoveredNode.energy}</span>}
            </div>
            {hoveredNode.key_camelot && (
              <p
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--font-size-xs)",
                  color: "#475569",
                  marginTop: 4,
                }}
              >
                Fits with{" "}
                {getHarmonicCompanionKeys(hoveredNode.key_camelot).join(" · ")}
              </p>
            )}
            {hoveredNode.genre && (
              <p
                style={{
                  fontFamily: "var(--font-label)",
                  fontSize: "var(--font-size-xs)",
                  color: "#64748b",
                  marginTop: 2,
                }}
              >
                {hoveredNode.genre}
              </p>
            )}
          </div>
        )}
      </div>
      {editingTrack ? (
        <TrackMetadataEditor
          key={editingTrack.id}
          track={editingTrack}
          isSaving={updateTrackMutation.isPending}
          onClose={() => setEditingTrack(null)}
          onSave={(payload) => void saveTrackMetadata(payload)}
        />
      ) : null}
    </>
  );
};

export const graphRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/graph",
  validateSearch: (search: Record<string, unknown>) => {
    const playlistId = Number(search.playlistId);
    return Number.isInteger(playlistId) && playlistId > 0
      ? { playlistId }
      : { playlistId: undefined };
  },
  component: GraphPage,
});
