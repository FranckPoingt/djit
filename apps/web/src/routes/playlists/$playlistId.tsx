import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { createRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import {
  useAddTracksToPlaylist,
  useDeletePlaylist,
  type HarmonizeDiagnostics,
  usePlaylistDetail,
  useReorderPlaylist,
  useRemoveTrackFromPlaylist,
} from "../../hooks/usePlaylists";
import { useHarmonizePlaylist } from "../../hooks/usePlaylists";
import { useTrackWaveform } from "../../hooks/useTrackWaveform";
import { createApiUrl } from "../../lib/api";
import { useLibraryStore } from "../../stores/libraryStore";
import { HarmonizeModal } from "../../components/playlists/HarmonizeModal";
import { TrackArtwork } from "../../components/media/TrackArtwork";
import { WaveformStrip } from "../../components/media/WaveformStrip";

import { rootRoute } from "../__root";

const META_BADGE_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  height: 20,
  padding: "0 8px",
  borderRadius: 999,
  background: "var(--color-bg-surface)",
  border: "1px solid var(--color-border-subtle)",
  color: "var(--color-text-muted)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--font-size-xs)",
  letterSpacing: "var(--letter-spacing-label)",
  whiteSpace: "nowrap",
};

type PlaylistTrack = {
  id: number;
  title: string;
  artist: string;
  genre?: string | null;
  duration_seconds?: number | null;
  bpm?: number | null;
  key_camelot?: string | null;
  analysis_status?: string;
  triage_decision?: string;
};

type TransitionCategory =
  | "perfect_match"
  | "energy_boost_plus"
  | "energy_boost_plus_plus"
  | "energy_boost_plus_plus_plus"
  | "energy_drop_minus"
  | "energy_drop_minus_minus"
  | "energy_drop_minus_minus_minus"
  | "mood_change"
  | "unscored";

type PlaylistTransitionDiagnostic = {
  from_track_id: number;
  to_track_id: number;
  category: TransitionCategory;
  label: string;
  compatibility: number;
};

const parseCamelot = (key: string | null | undefined) => {
  if (!key) return null;
  const value = key.trim().toUpperCase();
  if (value.length < 2) return null;
  const mode = value.slice(-1);
  const n = Number(value.slice(0, -1));
  if (
    !Number.isInteger(n) ||
    n < 1 ||
    n > 12 ||
    (mode !== "A" && mode !== "B")
  ) {
    return null;
  }
  return { n, mode };
};

const transitionCategory = (
  fromKey: string | null | undefined,
  toKey: string | null | undefined,
): TransitionCategory => {
  const a = parseCamelot(fromKey);
  const b = parseCamelot(toKey);
  if (!a || !b) return "unscored";
  if (a.n === b.n && a.mode === b.mode) return "perfect_match";
  if (a.n === b.n && a.mode !== b.mode) return "mood_change";
  const delta = (b.n - a.n + 12) % 12;
  if (delta === 1) return "energy_boost_plus";
  if (delta === 2) return "energy_boost_plus_plus";
  if (delta === 3) return "energy_boost_plus_plus_plus";
  if (delta === 11) return "energy_drop_minus";
  if (delta === 10) return "energy_drop_minus_minus";
  if (delta === 9) return "energy_drop_minus_minus_minus";
  return "unscored";
};

const transitionLabel = (category: TransitionCategory) => {
  switch (category) {
    case "perfect_match":
      return "Perfect";
    case "energy_boost_plus":
      return "+";
    case "energy_boost_plus_plus":
      return "++";
    case "energy_boost_plus_plus_plus":
      return "+++";
    case "energy_drop_minus":
      return "-";
    case "energy_drop_minus_minus":
      return "--";
    case "energy_drop_minus_minus_minus":
      return "---";
    case "mood_change":
      return "Relative";
    default:
      return "?";
  }
};

const transitionCompatibility = (category: TransitionCategory) => {
  switch (category) {
    case "perfect_match":
      return 1;
    case "energy_boost_plus":
    case "energy_drop_minus":
      return 0.8;
    case "energy_boost_plus_plus":
    case "energy_drop_minus_minus":
      return 0.6;
    case "mood_change":
      return 0.58;
    case "energy_boost_plus_plus_plus":
    case "energy_drop_minus_minus_minus":
      return 0.35;
    default:
      return 0;
  }
};

const buildPlaylistDiagnostics = (
  tracks: PlaylistTrack[],
): HarmonizeDiagnostics => {
  if (tracks.length <= 1) {
    return {
      transitions: [],
      compatibility_score: 100,
      risky_jumps: 0,
      energy_trend: "flat",
    };
  }

  const transitions: PlaylistTransitionDiagnostic[] = [];
  let trendScore = 0;
  let risky = 0;

  for (let i = 0; i < tracks.length - 1; i += 1) {
    const current = tracks[i];
    const next = tracks[i + 1];
    const category = transitionCategory(current.key_camelot, next.key_camelot);
    const compatibility = transitionCompatibility(category);
    transitions.push({
      from_track_id: current.id,
      to_track_id: next.id,
      category,
      label: transitionLabel(category),
      compatibility,
    });
    if (
      category === "energy_boost_plus" ||
      category === "energy_boost_plus_plus" ||
      category === "energy_boost_plus_plus_plus"
    ) {
      trendScore += 1;
    }
    if (
      category === "energy_drop_minus" ||
      category === "energy_drop_minus_minus" ||
      category === "energy_drop_minus_minus_minus"
    ) {
      trendScore -= 1;
    }
    if (
      category === "energy_boost_plus_plus_plus" ||
      category === "energy_drop_minus_minus_minus" ||
      category === "unscored"
    ) {
      risky += 1;
    }
  }

  const score =
    transitions.reduce((acc, t) => acc + t.compatibility, 0) /
    transitions.length;
  const energy_trend =
    trendScore >= 2
      ? "rising"
      : trendScore <= -2
        ? "falling"
        : trendScore === 0
          ? "flat"
          : "mixed";

  return {
    transitions,
    compatibility_score: Math.round(score * 1000) / 10,
    risky_jumps: risky,
    energy_trend,
  };
};

const TRANSITION_COLORS: Record<TransitionCategory, string> = {
  perfect_match: "var(--color-keep)",
  energy_boost_plus: "#86efac",
  energy_boost_plus_plus: "#4ade80",
  energy_boost_plus_plus_plus: "#22c55e",
  energy_drop_minus: "#fcd34d",
  energy_drop_minus_minus: "#f59e0b",
  energy_drop_minus_minus_minus: "#ef4444",
  mood_change: "#60a5fa",
  unscored: "var(--color-text-disabled)",
};

type SortableTrackRowProps = {
  track: PlaylistTrack;
  index: number;
  totalCount: number;
  isReordering: boolean;
  isRemoving: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
  onDoubleClick: () => void;
  formatDuration: (s: number | null) => string;
  formatBpm: (v: number | null | undefined) => string;
};

const SortableTrackRow = ({
  track,
  index,
  totalCount,
  isReordering,
  isRemoving,
  onMoveUp,
  onMoveDown,
  onRemove,
  onDoubleClick,
  formatDuration,
  formatBpm,
}: SortableTrackRowProps) => {
  const { data: waveform } = useTrackWaveform(
    track.id,
    28,
    true,
    `${track.title}|${track.duration_seconds ?? ""}`,
  );
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: track.id });

  return (
    <div
      ref={setNodeRef}
      onDoubleClick={onDoubleClick}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        border: "1px solid var(--color-border-subtle)",
        borderRadius: "var(--radius-sm)",
        padding: "var(--space-2) var(--space-3)",
        cursor: "pointer",
        transform: CSS.Transform.toString(transform),
        transition: transition
          ? transition.replace(
              /transform [^,;]+/,
              "transform 320ms cubic-bezier(0.22,1,0.36,1)",
            )
          : undefined,
        opacity: isDragging ? 0.4 : 1,
        background: isDragging
          ? "var(--color-bg-surface)"
          : "var(--color-bg-sidebar)",
        boxShadow: isDragging ? "0 4px 12px rgba(0,0,0,0.3)" : "none",
        position: "relative",
        zIndex: isDragging ? 1 : "auto",
      }}
      title="Double-click to play"
    >
      {/* Drag handle */}
      <div
        {...attributes}
        {...listeners}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 20,
          flexShrink: 0,
          marginRight: "var(--space-2)",
          cursor: isDragging ? "grabbing" : "grab",
          color: "var(--color-text-faint)",
          fontSize: 14,
          lineHeight: 1,
          userSelect: "none",
          touchAction: "none",
        }}
        title="Drag to reorder"
      >
        ⠿
      </div>

      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
        }}
      >
        <TrackArtwork
          trackId={track.id}
          title={track.title}
          artist={track.artist}
          size={34}
          borderRadius={6}
        />
        <div style={{ minWidth: 0, flex: 1 }}>
          <p
            style={{
              color: "var(--color-text-primary)",
              fontSize: "var(--font-size-base)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {track.title}
          </p>
          <p
            style={{
              color: "var(--color-text-muted)",
              fontSize: "var(--font-size-sm)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {track.artist}
          </p>

          <div
            style={{
              marginTop: "2px",
              display: "flex",
              flexWrap: "wrap",
              gap: "6px",
            }}
          >
            <span style={META_BADGE_STYLE}>
              {track.genre || "Unknown genre"}
            </span>
            <span style={META_BADGE_STYLE}>
              {formatDuration(track.duration_seconds ?? null)}
            </span>
            <span style={META_BADGE_STYLE}>
              {track.key_camelot || "No key"}
            </span>
            <span style={META_BADGE_STYLE}>{formatBpm(track.bpm)} BPM</span>
          </div>
        </div>

        <div
          style={{
            width: 144,
            height: 12,
            flexShrink: 0,
            marginRight: "var(--space-2)",
          }}
        >
          {waveform?.points?.length ? (
            <WaveformStrip
              points={waveform.points}
              width={144}
              height={12}
              baseColor="var(--color-waveform-idle)"
              progressColor="var(--color-waveform-played)"
            />
          ) : null}
        </div>
      </div>
      <div
        style={{
          width: 1,
          height: 24,
          background: "var(--color-border)",
          marginRight: "var(--space-2)",
          flexShrink: 0,
        }}
      />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-1)",
        }}
      >
        <button
          type="button"
          disabled={index === 0 || isReordering}
          onClick={(event) => {
            event.stopPropagation();
            onMoveUp();
          }}
          className="btn btn-ghost"
          style={{ height: 26 }}
        >
          ▲
        </button>
        <button
          type="button"
          disabled={index === totalCount - 1 || isReordering}
          onClick={(event) => {
            event.stopPropagation();
            onMoveDown();
          }}
          className="btn btn-ghost"
          style={{ height: 26 }}
        >
          ▼
        </button>
        <button
          type="button"
          disabled={isRemoving}
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          className="btn btn-ghost"
          style={{ height: 26, color: "var(--color-problem)" }}
        >
          ✕
        </button>
      </div>
    </div>
  );
};

const PlaylistDetailPage = () => {
  const { playlistId } = playlistDetailRoute.useParams();
  const numericPlaylistId = Number(playlistId);
  const selectedTrackIds = useLibraryStore((state) => state.selectedTrackIds);
  const setSelectedTrackIds = useLibraryStore(
    (state) => state.setSelectedTrackIds,
  );
  const setPlaybackQueueTrackIds = useLibraryStore(
    (state) => state.setPlaybackQueueTrackIds,
  );
  const requestTrackPlayback = useLibraryStore(
    (state) => state.requestTrackPlayback,
  );
  const {
    data: playlist,
    isLoading,
    error,
  } = usePlaylistDetail(numericPlaylistId);
  const { mutateAsync: addTracks, isPending: isAdding } =
    useAddTracksToPlaylist();
  const { mutateAsync: removeTrack, isPending: isRemoving } =
    useRemoveTrackFromPlaylist();
  const { mutateAsync: reorder, isPending: isReordering } =
    useReorderPlaylist();
  const { mutateAsync: deletePlaylist, isPending: isDeleting } =
    useDeletePlaylist();
  const { mutateAsync: harmonize, isPending: isHarmonizing } =
    useHarmonizePlaylist();
  const [showHarmonize, setShowHarmonize] = useState(false);
  const [lastHarmonizeDiagnostics, setLastHarmonizeDiagnostics] =
    useState<HarmonizeDiagnostics | null>(null);

  const trackIds = useMemo(
    () => playlist?.tracks.map((track) => track.id) ?? [],
    [playlist?.tracks],
  );
  const playlistDiagnostics = useMemo(
    () => buildPlaylistDiagnostics(playlist?.tracks ?? []),
    [playlist?.tracks],
  );

  type ExportStatus = "idle" | "picking" | "copying" | "done" | "error";
  const [exportStatus, setExportStatus] = useState<ExportStatus>("idle");
  const [exportResult, setExportResult] = useState<{
    destination: string;
    copied: number;
    skipped: number;
    provisional: number;
    playlist_path: string | null;
    manifest_path: string | null;
    errors: string[];
  } | null>(null);

  const handleExportToFolder = async () => {
    setExportStatus("picking");
    setExportResult(null);
    try {
      const pickRes = await fetch(createApiUrl("/library/pick-folder"));
      const pick = await pickRes.json();
      if (!pick.folder_path) {
        setExportStatus("idle");
        return;
      }
      setExportStatus("copying");
      const copyRes = await fetch(
        createApiUrl(`/playlists/${numericPlaylistId}/extract`),
        {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          playlist_id: numericPlaylistId,
          destination_path: pick.folder_path,
        }),
        },
      );
      if (!copyRes.ok) throw new Error(await copyRes.text());
      const result = await copyRes.json();
      setExportResult(result);
      setExportStatus("done");
    } catch {
      setExportStatus("error");
    }
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = trackIds.indexOf(Number(active.id));
    const newIndex = trackIds.indexOf(Number(over.id));
    const next = arrayMove(trackIds, oldIndex, newIndex);
    void reorder({ playlistId: numericPlaylistId, trackIds: next });
  };

  const formatDuration = (seconds: number | null) => {
    if (!seconds || seconds <= 0) {
      return "-";
    }
    const total = Math.floor(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    }
    return `${minutes}:${String(secs).padStart(2, "0")}`;
  };

  const formatBpm = (value: number | null | undefined) => {
    if (value === null || value === undefined || !Number.isFinite(value)) {
      return "—";
    }
    return String(Math.round(value));
  };

  return (
    <>
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
          {playlist?.name
            ? playlist.name.toUpperCase()
            : `PLAYLIST #${playlistId}`}
        </span>
        {playlist && (
          <span
            style={{
              fontFamily: "var(--font-label)",
              fontSize: "var(--font-size-xs)",
              color: "var(--color-text-faint)",
            }}
          >
            {playlist.track_count} tracks ·{" "}
            {formatDuration(playlist.duration_seconds)} · BPM{" "}
            {formatBpm(playlist.bpm_min)} — {formatBpm(playlist.bpm_max)}
          </span>
        )}
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "var(--space-6)" }}>
        {error ? (
          <p
            style={{
              fontFamily: "var(--font-label)",
              fontSize: "var(--font-size-sm)",
              color: "var(--color-problem)",
              marginBottom: "var(--space-4)",
            }}
          >
            FAILED TO LOAD PLAYLIST
          </p>
        ) : null}

        {isLoading ? (
          <p
            style={{
              fontFamily: "var(--font-label)",
              fontSize: "var(--font-size-sm)",
              color: "var(--color-text-faint)",
              letterSpacing: "var(--letter-spacing-label)",
            }}
          >
            LOADING…
          </p>
        ) : null}

        {playlist ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-4)",
            }}
          >
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "var(--space-2)",
              }}
            >
              <button
                type="button"
                disabled={selectedTrackIds.length === 0 || isAdding}
                onClick={() =>
                  addTracks({
                    playlistId: numericPlaylistId,
                    trackIds: selectedTrackIds,
                  })
                }
                className="btn btn-primary"
                style={{ height: 30 }}
              >
                Add selected tracks ({selectedTrackIds.length})
              </button>

              <button
                type="button"
                disabled={
                  !playlist || playlist.track_count < 2 || isHarmonizing
                }
                onClick={() => setShowHarmonize(true)}
                className="btn btn-secondary"
                style={{ height: 30 }}
              >
                ♫ Harmonize
              </button>

              <Link
                to="/graph"
                search={{ playlistId: numericPlaylistId }}
                className="btn btn-secondary"
                style={{ height: 30 }}
              >
                View in graph
              </Link>

              <button
                type="button"
                disabled={
                  exportStatus === "picking" ||
                  exportStatus === "copying" ||
                  trackIds.length === 0
                }
                onClick={() => void handleExportToFolder()}
                className="btn btn-secondary"
                style={{ height: 30 }}
              >
                {exportStatus === "picking"
                  ? "Selecting folder…"
                  : exportStatus === "copying"
                    ? "Copying…"
                    : "Extract to folder"}
              </button>

              <button
                type="button"
                onClick={async () => {
                  const detectRes = await fetch(
                    createApiUrl("/export/engine-dj/detect-path"),
                  );
                  const detect = await detectRes.json();
                  await fetch(createApiUrl("/export/engine-dj"), {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      playlist_id: numericPlaylistId,
                      engine_library_path: detect.path,
                    }),
                  });
                }}
                className="btn btn-secondary"
                style={{ height: 30 }}
              >
                Export playlist (Engine DJ)
              </button>

              <button
                type="button"
                disabled={isDeleting}
                onClick={async () => {
                  await deletePlaylist(numericPlaylistId);
                  window.location.href = "/playlists";
                }}
                className="btn btn-secondary"
                style={{ height: 30, color: "var(--color-problem)" }}
              >
                Delete playlist
              </button>
            </div>

            {exportStatus === "done" && exportResult ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-3)",
                  padding: "var(--space-2) var(--space-3)",
                  background: "var(--color-bg-surface)",
                  border: "1px solid var(--color-border-subtle)",
                  borderRadius: "var(--radius-sm)",
                  fontFamily: "var(--font-label)",
                  fontSize: "var(--font-size-xs)",
                  letterSpacing: "var(--letter-spacing-label)",
                  color: "var(--color-text-muted)",
                }}
              >
                <span style={{ color: "var(--color-keep)" }}>✓</span>
                <span>
                  {exportResult.copied} COPIED · {exportResult.skipped} SKIPPED
                </span>
                {exportResult.provisional > 0 ? (
                  <span style={{ color: "var(--color-maybe)" }}>
                    {exportResult.provisional} PROVISIONAL
                  </span>
                ) : null}
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: "var(--color-text-faint)",
                    maxWidth: 320,
                  }}
                  title={exportResult.destination}
                >
                  → {exportResult.destination}
                </span>
                {exportResult.errors.length > 0 ? (
                  <span style={{ color: "var(--color-problem)" }}>
                    {exportResult.errors.length} FAILED
                  </span>
                ) : null}
                {exportResult.playlist_path ? (
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      color: "var(--color-text-faint)",
                      maxWidth: 220,
                    }}
                    title={exportResult.playlist_path}
                  >
                    M3U8
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={() => setExportStatus("idle")}
                  className="btn btn-ghost"
                  style={{ height: 20, marginLeft: "auto" }}
                >
                  ✕
                </button>
              </div>
            ) : null}
            {exportStatus === "error" ? (
              <p
                style={{
                  fontFamily: "var(--font-label)",
                  fontSize: "var(--font-size-xs)",
                  color: "var(--color-problem)",
                  letterSpacing: "var(--letter-spacing-label)",
                }}
              >
                EXPORT FAILED ·{" "}
                <button
                  type="button"
                  onClick={() => setExportStatus("idle")}
                  className="btn btn-ghost"
                  style={{ height: 18 }}
                >
                  DISMISS
                </button>
              </p>
            ) : null}

            <div
              style={{
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-lg)",
                padding: "var(--space-4)",
                background: "var(--color-bg-sidebar)",
              }}
            >
              <p
                style={{
                  fontFamily: "var(--font-label)",
                  fontSize: "var(--font-size-xs)",
                  color: "var(--color-text-muted)",
                  letterSpacing: "var(--letter-spacing-label)",
                  marginBottom: "var(--space-3)",
                }}
              >
                {playlist.track_count} TRACKS ·{" "}
                {formatDuration(playlist.duration_seconds)} · BPM{" "}
                {formatBpm(playlist.bpm_min)} — {formatBpm(playlist.bpm_max)}
              </p>

              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "var(--space-2)",
                  marginBottom: "var(--space-3)",
                }}
              >
                <span style={META_BADGE_STYLE}>
                  COMPAT {playlistDiagnostics.compatibility_score.toFixed(1)}%
                </span>
                <span style={META_BADGE_STYLE}>
                  TREND {playlistDiagnostics.energy_trend.toUpperCase()}
                </span>
                <span style={META_BADGE_STYLE}>
                  RISKY JUMPS {playlistDiagnostics.risky_jumps}
                </span>
                {lastHarmonizeDiagnostics ? (
                  <span
                    style={{
                      ...META_BADGE_STYLE,
                      color: "var(--color-accent)",
                    }}
                  >
                    LAST HARMONIZE{" "}
                    {lastHarmonizeDiagnostics.compatibility_score.toFixed(1)}%
                  </span>
                ) : null}
              </div>

              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--space-2)",
                }}
              >
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleDragEnd}
                >
                  <SortableContext
                    items={trackIds}
                    strategy={verticalListSortingStrategy}
                  >
                    {playlist.tracks.map((track, index) => {
                      const transition = playlistDiagnostics.transitions[index];
                      return (
                        <div
                          key={track.id}
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: "var(--space-1)",
                          }}
                        >
                          <SortableTrackRow
                            track={track}
                            index={index}
                            totalCount={playlist.tracks.length}
                            isReordering={isReordering}
                            isRemoving={isRemoving}
                            formatDuration={formatDuration}
                            formatBpm={formatBpm}
                            onDoubleClick={() => {
                              setPlaybackQueueTrackIds(trackIds);
                              const nextSelectedTrackIds = [
                                ...selectedTrackIds.filter(
                                  (id) => id !== track.id,
                                ),
                                track.id,
                              ];
                              setSelectedTrackIds(nextSelectedTrackIds);
                              requestTrackPlayback(track.id);
                            }}
                            onMoveUp={() => {
                              const next = [...trackIds];
                              [next[index - 1], next[index]] = [
                                next[index],
                                next[index - 1],
                              ];
                              void reorder({
                                playlistId: numericPlaylistId,
                                trackIds: next,
                              });
                            }}
                            onMoveDown={() => {
                              const next = [...trackIds];
                              [next[index + 1], next[index]] = [
                                next[index],
                                next[index + 1],
                              ];
                              void reorder({
                                playlistId: numericPlaylistId,
                                trackIds: next,
                              });
                            }}
                            onRemove={() => {
                              void removeTrack({
                                playlistId: numericPlaylistId,
                                trackId: track.id,
                              });
                            }}
                          />
                          {transition ? (
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "center",
                              }}
                            >
                              <span
                                style={{
                                  ...META_BADGE_STYLE,
                                  height: 18,
                                  padding: "0 6px",
                                  color:
                                    TRANSITION_COLORS[
                                      transition.category as TransitionCategory
                                    ] ?? "var(--color-text-disabled)",
                                }}
                                title={`${transition.from_track_id} → ${transition.to_track_id} (${Math.round(transition.compatibility * 100)}% compatibility)`}
                              >
                                {transition.label}
                              </span>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </SortableContext>
                </DndContext>

                {playlist.tracks.length === 0 ? (
                  <p
                    style={{
                      fontFamily: "var(--font-label)",
                      fontSize: "var(--font-size-sm)",
                      color: "var(--color-text-faint)",
                      letterSpacing: "var(--letter-spacing-label)",
                      padding: "var(--space-3)",
                    }}
                  >
                    NO TRACKS IN THIS PLAYLIST YET
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {showHarmonize && playlist ? (
        <HarmonizeModal
          playlistName={playlist.name}
          trackKeys={playlist.tracks.map((t) => t.key_camelot)}
          isLoading={isHarmonizing}
          onClose={() => setShowHarmonize(false)}
          onConfirm={async (opts) => {
            const response = await harmonize({
              playlistId: numericPlaylistId,
              options: opts,
            });
            setLastHarmonizeDiagnostics(response.diagnostics);
            setShowHarmonize(false);
          }}
        />
      ) : null}
    </>
  );
};

export const playlistDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "playlists/$playlistId",
  component: PlaylistDetailPage,
});
