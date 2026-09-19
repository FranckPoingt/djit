import { useState, useMemo, useRef, useEffect } from "react";
import type { CSSProperties } from "react";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  useReactTable,
  SortingState,
  ColumnFiltersState,
  ColumnSizingState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { InfiniteData } from "@tanstack/react-query";
import type {
  TrackBulkUpdate,
  TrackSummary,
  TrackUpdate,
  PaginatedTracksResponse,
} from "api-client";

import { useLibraryStore } from "../../stores/libraryStore";
import { useTracks, flattenPages } from "../../hooks/useTracks";
import { useUpdateTrack } from "../../hooks/useUpdateTrack";
import { useBulkUpdate } from "../../hooks/useBulkUpdate";
import { useAddTracksToPlaylist, usePlaylists } from "../../hooks/usePlaylists";
import { TRACKS_QUERY_KEY, tracksQueryKey } from "../../hooks/useTracks";
import { createApiUrl } from "../../lib/api";
import { useQueueStore } from "../../stores/queueStore";
import { TrackArtwork } from "../media/TrackArtwork";

// CSS class mapping for div-based flex table cells
const COL_CLASS: Record<string, string> = {
  checkbox: "col-check",
  title: "col-title",
  artist: "col-artist",
  genre: "col-genre",
  energy: "col-energy",
  bpm: "col-bpm",
  key_camelot: "col-key",
  triage_decision: "col-status",
  duration_seconds: "col-dur",
  playlist_memberships: "col-artist",
};

// Inline styles for columns with no dedicated CSS class
const COL_STYLE: Record<string, CSSProperties> = {
  analysis_status: { width: 100, flexShrink: 0 },
  bpm_confidence: { width: 68, flexShrink: 0 },
};

const EDIT_INPUT: CSSProperties = {
  background: "var(--color-bg-input)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-sm)",
  color: "var(--color-text-primary)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--font-size-base)",
  padding: "2px var(--space-2)",
  outline: "none",
};

const TRIAGE_DECISIONS = ["unheard", "keep", "maybe", "reject", "problem"] as const;
type TriageDecisionValue = (typeof TRIAGE_DECISIONS)[number];

const TRIAGE_LABELS: Record<TriageDecisionValue, string> = {
  unheard: "Unsorted",
  keep: "Keep",
  maybe: "Maybe",
  reject: "Reject",
  problem: "Problem",
};

const ANALYSIS_LABELS: Record<string, string> = {
  not_analyzed: "Ready",
  pending: "Queued",
  analyzing: "Analyzing",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
  overridden: "Manual",
};

const LEGACY_AUTO_MOODS = new Set([
  "Dark",
  "Deep",
  "Driving",
  "Euphoric",
  "Hypnotic",
  "Peak Time",
  "Uplifting",
  "Warm",
]);

const EMPTY_FILTERS = {
  triageDecision: [],
  analysisStatus: [],
  keyCamelot: null,
  mood: null,
  energyMin: null,
  energyMax: null,
  bpmMin: null,
  bpmMax: null,
};

const getTriageChipClass = (decision: string) => {
  if (decision === "keep") return "chip chip-keep";
  if (decision === "maybe") return "chip chip-maybe";
  if (decision === "reject") return "chip chip-reject";
  if (decision === "problem") return "chip chip-problem";
  return "chip chip-pending";
};

const genreStyleCache = new Map<string, CSSProperties>();

const getGenreChipStyle = (genre: string): CSSProperties => {
  const cached = genreStyleCache.get(genre);
  if (cached) {
    return cached;
  }

  // Stable hue per genre name for consistent coloring across renders.
  let hash = 0;
  for (let i = 0; i < genre.length; i += 1) {
    hash = (hash * 31 + genre.charCodeAt(i)) >>> 0;
  }

  const hue = hash % 360;
  const style: CSSProperties = {
    background: `hsl(${hue} 35% 20%)`,
    color: `hsl(${hue} 70% 78%)`,
    border: `1px solid hsl(${hue} 45% 35%)`,
  };

  genreStyleCache.set(genre, style);
  return style;
};

const columnHelper = createColumnHelper<TrackSummary>();

interface HeaderCheckboxProps {
  filteredIds: number[];
  selectedIds: number[];
  onSelectAll: (ids: number[]) => void;
  onDeselectAll: (ids: number[]) => void;
}

const HeaderCheckbox = ({
  filteredIds,
  selectedIds,
  onSelectAll,
  onDeselectAll,
}: HeaderCheckboxProps) => {
  const allSelected =
    filteredIds.length > 0 &&
    filteredIds.every((id) => selectedIds.includes(id));
  const someSelected =
    !allSelected && filteredIds.some((id) => selectedIds.includes(id));
  return (
    <input
      type="checkbox"
      ref={(el) => {
        if (el) el.indeterminate = someSelected;
      }}
      checked={allSelected}
      onChange={() =>
        allSelected ? onDeselectAll(filteredIds) : onSelectAll(filteredIds)
      }
      style={{ cursor: "pointer" }}
    />
  );
};

interface EditingState {
  trackId: number;
  field: string;
  value: string;
}

interface TrackStackedCellProps {
  track: TrackSummary;
  editingCell: EditingState | null;
  setEditingCell: React.Dispatch<React.SetStateAction<EditingState | null>>;
  handleSaveEdit: () => void;
  handleKeyDown: (e: React.KeyboardEvent) => void;
  isPlaylistExpanded: boolean;
  onTogglePlaylist: () => void;
}

const TrackStackedCell = ({
  track,
  editingCell,
  setEditingCell,
  handleSaveEdit,
  handleKeyDown,
  isPlaylistExpanded,
  onTogglePlaylist,
}: TrackStackedCellProps) => {
  const memberships = track.playlist_memberships ?? [];
  const countLabel = memberships.length === 1 ? "playlist" : "playlists";
  const isGenreEditing =
    editingCell?.trackId === track.id && editingCell?.field === "genre";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: "var(--space-2)",
        minWidth: 0,
        width: "100%",
      }}
    >
      <div style={{ alignSelf: "center", flexShrink: 0 }}>
        <TrackArtwork
          trackId={track.id}
          title={track.title}
          artist={track.artist}
          size={38}
          borderRadius={6}
        />
      </div>
      <div
        style={{
          minWidth: 0,
          flex: 1,
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
        <span
          style={{
            color: "var(--color-text-secondary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            display: "block",
            fontSize: "var(--font-size-sm)",
          }}
          title={track.artist}
        >
          {track.artist}
        </span>
        <span
          style={{
            color: "var(--color-text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            display: "block",
            lineHeight: 1.2,
          }}
          title={track.title}
        >
          {track.title}
        </span>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            minHeight: 18,
          }}
        >
          {isGenreEditing && editingCell ? (
            <input
              autoFocus
              type="text"
              value={editingCell.value}
              onChange={(e) =>
                setEditingCell({ ...editingCell, value: e.target.value })
              }
              onBlur={handleSaveEdit}
              onKeyDown={handleKeyDown}
              onClick={(e) => e.stopPropagation()}
              style={{ ...EDIT_INPUT, width: 110 }}
              placeholder="Genre"
            />
          ) : track.genre ? (
            <span
              className="chip chip-genre"
              onDoubleClick={() =>
                setEditingCell({
                  trackId: track.id,
                  field: "genre",
                  value: track.genre ?? "",
                })
              }
              style={{ ...getGenreChipStyle(track.genre), cursor: "pointer" }}
              title="Double-click to edit genre"
            >
              {track.genre}
            </span>
          ) : (
            <span
              onDoubleClick={() =>
                setEditingCell({ trackId: track.id, field: "genre", value: "" })
              }
              style={{
                color: "var(--color-text-disabled)",
                cursor: "pointer",
                fontSize: "var(--font-size-sm)",
              }}
              title="Double-click to set genre"
            >
              genre: none
            </span>
          )}
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
            gap: 4,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {memberships.length === 0 ? (
            <span
              style={{
                color: "var(--color-text-disabled)",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--font-size-sm)",
              }}
            >
              not in playlist
            </span>
          ) : (
            <>
              <button
                type="button"
                onClick={onTogglePlaylist}
                style={{
                  border: "none",
                  background: "transparent",
                  color: "var(--color-text-secondary)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--font-size-sm)",
                  padding: 0,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
                title={
                  isPlaylistExpanded
                    ? "Hide playlist names"
                    : "Show playlist names"
                }
              >
                {isPlaylistExpanded ? "▾" : "▸"} in {memberships.length}{" "}
                {countLabel}
              </button>
              {isPlaylistExpanded ? (
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "var(--space-1)",
                  }}
                >
                  {memberships.map((membership) => (
                    <Link
                      key={membership.id}
                      to="/playlists/$playlistId"
                      params={{ playlistId: String(membership.id) }}
                      className="chip chip-genre"
                      style={{ textDecoration: "none" }}
                      title={`Open playlist ${membership.name}`}
                    >
                      {membership.name}
                    </Link>
                  ))}
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export const TrackGrid = () => {
  const queryClient = useQueryClient();
  const {
    data,
    isLoading,
    isFetchingNextPage,
    fetchNextPage,
    hasNextPage,
    error,
  } = useTracks();
  const tracks = useMemo(() => flattenPages(data?.pages), [data?.pages]);
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
  const filters = useLibraryStore((state) => state.gridFilters);
  const setFilters = useLibraryStore((state) => state.setGridFilters);
  const sorting = useLibraryStore((state) => state.gridSorting);
  const setSorting = useLibraryStore((state) => state.setGridSorting);
  const librarySearch = useLibraryStore((state) => state.librarySearch);
  const libraryFolderPath = useLibraryStore((state) => state.libraryFolderPath);
  const libraryScrollOffset = useLibraryStore(
    (state) => state.libraryScrollOffset,
  );
  const setLibraryScrollOffset = useLibraryStore(
    (state) => state.setLibraryScrollOffset,
  );
  const setLibrarySearch = useLibraryStore((state) => state.setLibrarySearch);
  const { mutate: updateTrack } = useUpdateTrack();
  const { mutateAsync: bulkUpdateTracks, isPending: isBulkUpdating } =
    useBulkUpdate();
  const { data: playlists = [] } = usePlaylists();
  const { mutateAsync: addTracksToPlaylist, isPending: isAddingToPlaylist } =
    useAddTracksToPlaylist();
  const seedPending = useQueueStore((state) => state.seedPending);

  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({});
  const [editingCell, setEditingCell] = useState<EditingState | null>(null);
  const [bulkGenreValue, setBulkGenreValue] = useState("");
  const [bulkPlaylistId, setBulkPlaylistId] = useState("");
  const [bulkFeedback, setBulkFeedback] = useState<string | null>(null);
  const [bulkFeedbackIsError, setBulkFeedbackIsError] = useState(false);
  const [isQueueingAnalysis, setIsQueueingAnalysis] = useState(false);
  const [expandedPlaylistRows, setExpandedPlaylistRows] = useState<number[]>(
    [],
  );
  const tableContainerRef = useRef<HTMLDivElement | null>(null);
  const hasRestoredScrollRef = useRef(false);
  const lastSavedScrollRef = useRef(libraryScrollOffset);
  const activeTracksQueryKey = useMemo(
    () =>
      tracksQueryKey(
        librarySearch,
        libraryFolderPath,
        filters,
        sorting,
      ),
    [filters, libraryFolderPath, librarySearch, sorting],
  );

  const isPlaylistRowExpanded = (trackId: number) =>
    expandedPlaylistRows.includes(trackId);

  const togglePlaylistRow = (trackId: number) => {
    setExpandedPlaylistRows((current) =>
      current.includes(trackId)
        ? current.filter((id) => id !== trackId)
        : [...current, trackId],
    );
  };

  const selectedPlaylistId = useMemo(() => {
    if (playlists.length === 0) {
      return null;
    }

    if (bulkPlaylistId.length > 0) {
      const parsed = Number(bulkPlaylistId);
      if (playlists.some((playlist) => playlist.id === parsed)) {
        return parsed;
      }
    }

    return playlists[0].id;
  }, [bulkPlaylistId, playlists]);

  const selectedPlaylistValue =
    selectedPlaylistId !== null ? String(selectedPlaylistId) : "";

  const runBulkUpdate = async (payload: Omit<TrackBulkUpdate, "track_ids">) => {
    if (selectedTrackIds.length === 0) {
      return;
    }

    setBulkFeedback(null);
    setBulkFeedbackIsError(false);

    try {
      const result = await bulkUpdateTracks({
        track_ids: selectedTrackIds,
        ...payload,
      });

      setSelectedTrackIds([]);
      if (
        payload.triage_decision &&
        filters.triageDecision.length === 1 &&
        filters.triageDecision[0] === "unheard"
      ) {
        setBulkFeedback(`${result.updated} updated. Hidden by UNHEARD filter.`);
      } else {
        setBulkFeedback(`${result.updated} tracks updated.`);
      }
    } catch {
      setBulkFeedbackIsError(true);
      setBulkFeedback("Bulk update failed. Please retry.");
    }
  };

  const queueAnalysis = async (trackIds: number[]) => {
    if (trackIds.length === 0 || isQueueingAnalysis) return;
    setIsQueueingAnalysis(true);
    try {
      const response = await fetch(createApiUrl("/analysis/queue"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          track_ids: trackIds,
          mode: "fast",
          scope: "selected",
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to queue analysis");
      }

      const payload = (await response.json()) as {
        requested?: number;
        queued?: number;
        skipped?: number;
        queued_track_ids?: number[];
        skipped_track_ids?: number[];
      };
      const queuedCount =
        typeof payload.queued === "number" ? payload.queued : trackIds.length;
      const skippedCount =
        typeof payload.skipped === "number" ? payload.skipped : 0;
      const queuedTrackIds =
        Array.isArray(payload.queued_track_ids) &&
        payload.queued_track_ids.length > 0
          ? payload.queued_track_ids
          : queuedCount > 0
          ? trackIds
          : [];
      const skippedTrackIds = Array.isArray(payload.skipped_track_ids)
        ? payload.skipped_track_ids
        : [];

      if (queuedCount > 0) {
        seedPending(queuedTrackIds);
      }

      if (queuedCount > 0 || skippedCount > 0) {
        const queuedText =
          queuedCount === 1 ? "1 track queued" : `${queuedCount} tracks queued`;
        const skippedText =
          skippedCount === 1
            ? "1 skipped over 12 min"
            : `${skippedCount} skipped over 12 min`;
        setBulkFeedback(skippedCount > 0 ? `${queuedText}; ${skippedText}.` : `${queuedText}.`);
        setBulkFeedbackIsError(false);
      } else {
        setBulkFeedback("No tracks needed analysis.");
        setBulkFeedbackIsError(false);
      }

      queryClient.setQueryData<
        InfiniteData<PaginatedTracksResponse> | undefined
      >(activeTracksQueryKey, (current) => {
        if (!current) return current;
        const queuedIds = new Set(queuedTrackIds);
        const skippedIds = new Set(skippedTrackIds);
        return {
          ...current,
          pages: current.pages.map((page) => ({
            ...page,
            items: page.items.map((track) =>
              queuedIds.has(track.id)
                ? { ...track, analysis_status: "pending" }
                : skippedIds.has(track.id)
                  ? { ...track, analysis_status: "skipped" }
                  : track,
            ),
          })),
        };
      });

      setSelectedTrackIds([]);
      void queryClient.invalidateQueries({ queryKey: TRACKS_QUERY_KEY });
    } finally {
      setIsQueueingAnalysis(false);
    }
  };

  const isLaunchFocusActive =
    filters.triageDecision.length === 1 &&
    filters.triageDecision[0] === "unheard" &&
    filters.analysisStatus.length === 0 &&
    filters.keyCamelot === null &&
    filters.mood === null &&
    filters.energyMin === null &&
    filters.energyMax === null &&
    filters.bpmMin === null &&
    filters.bpmMax === null;

  const availableKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const track of tracks) {
      if (track.key_camelot) {
        keys.add(track.key_camelot);
      }
    }
    return [...keys].sort((a, b) => a.localeCompare(b));
  }, [tracks]);

  const handleSaveEdit = () => {
    if (!editingCell) return;

    const payload: TrackUpdate = {};
    const field = editingCell.field as keyof TrackUpdate;

    if (field === "bpm") {
      const bpmValue = parseFloat(editingCell.value);
      payload.bpm = isNaN(bpmValue) ? null : bpmValue;
    } else if (field === "key_camelot") {
      payload.key_camelot = editingCell.value || null;
    } else if (field === "genre") {
      payload.genre = editingCell.value || null;
    } else if (field === "mood") {
      payload.mood = editingCell.value || null;
    } else if (field === "energy") {
      const energyValue = parseInt(editingCell.value, 10);
      payload.energy = isNaN(energyValue) ? null : energyValue;
    } else if (field === "triage_decision") {
      payload.triage_decision = (editingCell.value as any) || null;
    }

    updateTrack({ trackId: editingCell.trackId, payload });
    setEditingCell(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSaveEdit();
    } else if (e.key === "Escape") {
      setEditingCell(null);
    }
  };

  const hasActiveTextSelection = () => {
    const selection = window.getSelection();
    return Boolean(
      selection &&
      !selection.isCollapsed &&
      selection.toString().trim().length > 0,
    );
  };

  const filteredData = useMemo(() => {
    return tracks.filter((track) => {
      if (
        filters.triageDecision.length > 0 &&
        !filters.triageDecision.includes(track.triage_decision)
      )
        return false;
      if (
        filters.analysisStatus.length > 0 &&
        !filters.analysisStatus.includes(track.analysis_status)
      )
        return false;
      if (
        filters.keyCamelot !== null &&
        track.key_camelot !== filters.keyCamelot
      )
        return false;
      if (filters.mood !== null && track.mood !== filters.mood) return false;
      if (
        filters.energyMin !== null &&
        (track.energy ?? -1) < filters.energyMin
      )
        return false;
      if (
        filters.energyMax !== null &&
        (track.energy ?? 11) > filters.energyMax
      )
        return false;
      if (filters.bpmMin !== null && (track.bpm ?? 0) < filters.bpmMin)
        return false;
      if (filters.bpmMax !== null && (track.bpm ?? 0) > filters.bpmMax)
        return false;
      return true;
    });
  }, [tracks, filters]);

  const filteredIds = useMemo(
    () => filteredData.map((t) => t.id),
    [filteredData],
  );
  const activeFilterCount =
    filters.triageDecision.length +
    filters.analysisStatus.length +
    Number(filters.keyCamelot !== null) +
    Number(filters.mood !== null) +
    Number(filters.energyMin !== null || filters.energyMax !== null) +
    Number(filters.bpmMin !== null || filters.bpmMax !== null);

  const columns = [
    columnHelper.display({
      id: "checkbox",
      size: 40,
      minSize: 34,
      maxSize: 60,
      header: () => (
        <HeaderCheckbox
          filteredIds={filteredIds}
          selectedIds={selectedTrackIds}
          onSelectAll={(ids) =>
            setSelectedTrackIds([...new Set([...selectedTrackIds, ...ids])])
          }
          onDeselectAll={(ids) =>
            setSelectedTrackIds(
              selectedTrackIds.filter((id) => !ids.includes(id)),
            )
          }
        />
      ),
      cell: ({ row }) => {
        const id = row.original.id;
        const checked = selectedTrackIds.includes(id);
        return (
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => {
              e.stopPropagation();
              setSelectedTrackIds(
                checked
                  ? selectedTrackIds.filter((x) => x !== id)
                  : [...selectedTrackIds, id],
              );
            }}
            onClick={(e) => e.stopPropagation()}
            style={{ cursor: "pointer" }}
          />
        );
      },
    }),
    columnHelper.accessor("title", {
      header: "TRACK",
      size: 360,
      minSize: 250,
      cell: (info) => (
        <TrackStackedCell
          track={info.row.original}
          editingCell={editingCell}
          setEditingCell={setEditingCell}
          handleSaveEdit={handleSaveEdit}
          handleKeyDown={handleKeyDown}
          isPlaylistExpanded={isPlaylistRowExpanded(info.row.original.id)}
          onTogglePlaylist={() => togglePlaylistRow(info.row.original.id)}
        />
      ),
    }),
    columnHelper.accessor("energy", {
      header: "INTENSITY",
      size: 128,
      minSize: 100,
      cell: (info) => {
        const track = info.row.original;
        const isLegacyEstimate =
          track.analysis_status !== "overridden" &&
          LEGACY_AUTO_MOODS.has(track.mood ?? "");
        const isEditing =
          editingCell?.trackId === track.id && editingCell?.field === "energy";

        if (isEditing) {
          return (
            <input
              autoFocus
              type="number"
              min={0}
              max={10}
              step={1}
              value={editingCell.value}
              onChange={(e) =>
                setEditingCell({ ...editingCell, value: e.target.value })
              }
              onBlur={handleSaveEdit}
              onKeyDown={handleKeyDown}
              onClick={(e) => e.stopPropagation()}
              style={{ ...EDIT_INPUT, width: 50 }}
            />
          );
        }

        if (isLegacyEstimate) {
          return (
            <span
              style={{
                color: "var(--color-text-faint)",
                fontFamily: "var(--font-label)",
                fontSize: "var(--font-size-xs)",
                letterSpacing: "var(--letter-spacing-label)",
              }}
              title="Replacing the old automatic mood/energy estimate"
            >
              RECALIBRATING
            </span>
          );
        }

        const level = track.energy ?? 0;
        return track.energy !== null ? (
          <div
            onDoubleClick={() =>
              setEditingCell({
                trackId: track.id,
                field: "energy",
                value: String(track.energy),
              })
            }
            style={{
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
            title="Rhythm and dynamics intensity estimate — double-click to correct"
          >
            <div className="energy-bar">
              {[1, 2, 3, 4, 5].map((i) => (
                <span
                  key={i}
                  className={i <= Math.round(level / 2) ? "active" : ""}
                />
              ))}
            </div>
            <span
              style={{
                color: "var(--color-text-secondary)",
                fontFamily: "var(--font-mono)",
                fontSize: 10,
              }}
            >
              {level}/10
            </span>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                color:
                  track.analysis_status === "overridden"
                    ? "var(--color-accent)"
                    : "var(--color-text-faint)",
              }}
              title={
                track.analysis_status === "overridden"
                  ? "Manual / overridden"
                  : "Analysis derived"
              }
            >
              {track.analysis_status === "overridden" ? "MAN" : "AUTO"}
            </span>
          </div>
        ) : (
          <span
            onDoubleClick={() =>
              setEditingCell({ trackId: track.id, field: "energy", value: "" })
            }
            style={{ color: "var(--color-text-disabled)", cursor: "pointer" }}
          >
            —
          </span>
        );
      },
    }),
    columnHelper.accessor("bpm", {
      header: "BPM",
      size: 90,
      minSize: 70,
      cell: (info) => {
        const track = info.row.original;
        const isEditing =
          editingCell?.trackId === track.id && editingCell?.field === "bpm";

        if (isEditing) {
          return (
            <input
              autoFocus
              type="number"
              step="0.1"
              value={editingCell.value}
              onChange={(e) =>
                setEditingCell({ ...editingCell, value: e.target.value })
              }
              onBlur={handleSaveEdit}
              onKeyDown={handleKeyDown}
              onClick={(e) => e.stopPropagation()}
              style={{ ...EDIT_INPUT, width: 60 }}
            />
          );
        }

        return (
          <span
            onDoubleClick={() =>
              setEditingCell({
                trackId: track.id,
                field: "bpm",
                value: String(track.bpm ?? ""),
              })
            }
            style={{
              color: "var(--color-text-primary)",
              cursor: "pointer",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {track.bpm ? String(Math.round(track.bpm)) : "—"}
          </span>
        );
      },
    }),
    columnHelper.accessor("bpm_confidence", {
      header: "CONF",
      size: 90,
      minSize: 68,
      cell: (info) => {
        const confidence = info.getValue();
        const isLow = (confidence ?? 1) < 0.5;
        return (
          <span
            style={{
              color: isLow ? "var(--color-problem)" : "var(--color-text-faint)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--font-size-sm)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {confidence ? `${(confidence * 100).toFixed(0)}%` : "—"}
          </span>
        );
      },
    }),
    columnHelper.accessor("key_camelot", {
      header: "KEY",
      size: 90,
      minSize: 68,
      cell: (info) => {
        const track = info.row.original;
        const isEditing =
          editingCell?.trackId === track.id &&
          editingCell?.field === "key_camelot";
        const isOverridden = track.analysis_status === "overridden";

        if (isEditing) {
          return (
            <input
              autoFocus
              type="text"
              value={editingCell.value}
              onChange={(e) =>
                setEditingCell({ ...editingCell, value: e.target.value })
              }
              onBlur={handleSaveEdit}
              onKeyDown={handleKeyDown}
              onClick={(e) => e.stopPropagation()}
              style={{ ...EDIT_INPUT, width: 50 }}
              placeholder="5A"
            />
          );
        }

        return (
          <span
            onDoubleClick={() =>
              setEditingCell({
                trackId: track.id,
                field: "key_camelot",
                value: track.key_camelot ?? "",
              })
            }
            style={{
              color: isOverridden
                ? "var(--color-accent)"
                : "var(--color-text-primary)",
              fontWeight: isOverridden ? 700 : undefined,
              cursor: "pointer",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {track.key_camelot ?? "—"}
          </span>
        );
      },
    }),
    columnHelper.accessor("triage_decision", {
      header: "TRIAGE",
      size: 110,
      minSize: 90,
      cell: (info) => {
        const track = info.row.original;
        const isEditing =
          editingCell?.trackId === track.id &&
          editingCell?.field === "triage_decision";

        if (isEditing) {
          return (
            <select
              autoFocus
              value={editingCell.value}
              onChange={(e) =>
                setEditingCell({ ...editingCell, value: e.target.value })
              }
              onBlur={handleSaveEdit}
              onKeyDown={handleKeyDown}
              onClick={(e) => e.stopPropagation()}
              style={{
                background: "var(--color-bg-input)",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-sm)",
                color: "var(--color-text-primary)",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--font-size-sm)",
                padding: "2px var(--space-1)",
                outline: "none",
              }}
            >
              {TRIAGE_DECISIONS.map((decision) => (
                <option key={decision} value={decision}>
                  {TRIAGE_LABELS[decision]}
                </option>
              ))}
            </select>
          );
        }

        return (
          <span
            className={getTriageChipClass(track.triage_decision)}
            onDoubleClick={() =>
              setEditingCell({
                trackId: track.id,
                field: "triage_decision",
                value: track.triage_decision,
              })
            }
            style={{ cursor: "pointer" }}
          >
            {TRIAGE_LABELS[track.triage_decision as TriageDecisionValue] ??
              track.triage_decision}
          </span>
        );
      },
    }),
    columnHelper.accessor("analysis_status", {
      header: "ANALYSIS",
      size: 110,
      minSize: 90,
      cell: (info) => {
        const status = info.getValue();
        return (
          <span
            className={
              status === "overridden"
                ? "chip chip-genre"
                : status === "skipped"
                  ? "chip chip-keep"
                : status === "not_analyzed" || status === "pending"
                  ? "chip chip-pending"
                : status === "failed"
                  ? "chip chip-problem"
                  : "chip chip-done"
            }
          >
            {ANALYSIS_LABELS[status] ?? status}
          </span>
        );
      },
    }),
  ];

  const table = useReactTable({
    data: filteredData,
    columns,
    getRowId: (row) => String(row.id),
    state: {
      sorting,
      columnFilters,
      columnSizing,
    },
    onSortingChange: (updater) => {
      const nextSorting =
        typeof updater === "function"
          ? updater(sorting as SortingState)
          : updater;
      setSorting(nextSorting);
    },
    onColumnFiltersChange: setColumnFilters,
    onColumnSizingChange: setColumnSizing,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    columnResizeMode: "onChange",
    enableColumnResizing: true,
    meta: {
      selectedRows: selectedTrackIds,
      updateSelection: setSelectedTrackIds,
    },
  });
  const tableMinWidth = `calc(${table.getTotalSize()}px + (2 * var(--space-6)))`;

  const tableRows = table.getRowModel().rows;
  const rowVirtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => tableContainerRef.current,
    estimateSize: () => 78,
    overscan: 8,
  });

  useEffect(() => {
    const container = tableContainerRef.current;
    if (!container || hasRestoredScrollRef.current || isLoading) return;
    container.scrollTop = libraryScrollOffset;
    hasRestoredScrollRef.current = true;
  }, [isLoading, libraryScrollOffset, tracks.length]);

  // Fetch next page when scrolled within 400px of the bottom.
  useEffect(() => {
    const container = tableContainerRef.current;
    if (!container) return;
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      if (Math.abs(scrollTop - lastSavedScrollRef.current) >= 120) {
        lastSavedScrollRef.current = scrollTop;
        setLibraryScrollOffset(scrollTop);
      }
      if (!hasNextPage || isFetchingNextPage) return;
      if (scrollHeight - scrollTop - clientHeight < 400) {
        void fetchNextPage();
      }
    };
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, setLibraryScrollOffset]);

  if (isLoading) {
    return (
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--color-text-faint)",
          fontFamily: "var(--font-label)",
          fontSize: "var(--font-size-sm)",
          letterSpacing: "var(--letter-spacing-label)",
        }}
      >
        LOADING…
      </div>
    );
  }

  if (error) {
    return (
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--color-problem)",
          fontFamily: "var(--font-label)",
          fontSize: "var(--font-size-sm)",
          letterSpacing: "var(--letter-spacing-label)",
        }}
      >
        FAILED TO LOAD LIBRARY
      </div>
    );
  }

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Filter row */}
      <div
        className="djit-filter-row"
        style={{ borderBottom: "1px solid var(--color-border-subtle)" }}
      >
        <input
          type="search"
          className="library-search"
          value={librarySearch}
          onChange={(event) => {
            setLibrarySearch(event.target.value);
            setSelectedTrackIds([]);
          }}
          placeholder="Search library..."
        />
        <details className="library-filter-menu">
          <summary className="btn btn-secondary">
            FILTERS{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ""}
          </summary>
          <div className="library-filter-popover">
            <fieldset>
              <legend>TRIAGE</legend>
              <div className="library-filter-chips">
                {TRIAGE_DECISIONS.map((status) => {
                  const isActive = filters.triageDecision.includes(status);
                  return (
                    <button
                      key={status}
                      type="button"
                      onClick={() =>
                        setFilters({
                          ...filters,
                          triageDecision: isActive
                            ? filters.triageDecision.filter((value) => value !== status)
                            : [...filters.triageDecision, status],
                        })
                      }
                      className={isActive ? getTriageChipClass(status) : "chip"}
                    >
                      {TRIAGE_LABELS[status]}
                    </button>
                  );
                })}
              </div>
            </fieldset>
            <div className="library-filter-grid">
              <label>
                KEY
                <select
                  value={filters.keyCamelot ?? ""}
                  onChange={(event) => setFilters({ ...filters, keyCamelot: event.target.value || null })}
                >
                  <option value="">All keys</option>
                  {availableKeys.map((key) => <option key={key} value={key}>{key}</option>)}
                </select>
              </label>
              <label>
                ANALYSIS
                <select
                  value={filters.analysisStatus[0] ?? ""}
                  onChange={(event) => setFilters({ ...filters, analysisStatus: event.target.value ? [event.target.value] : [] })}
                >
                  <option value="">Any status</option>
                  <option value="not_analyzed">Ready</option>
                  <option value="pending">Queued</option>
                  <option value="analyzing">Analyzing</option>
                  <option value="done">Done</option>
                  <option value="failed">Failed</option>
                  <option value="skipped">Skipped</option>
                </select>
              </label>
              <label>
                INTENSITY
                <span className="library-filter-range">
                  <input type="number" min={1} max={10} placeholder="Min" value={filters.energyMin ?? ""} onChange={(event) => setFilters({ ...filters, energyMin: event.target.value ? Number(event.target.value) : null })} />
                  <input type="number" min={1} max={10} placeholder="Max" value={filters.energyMax ?? ""} onChange={(event) => setFilters({ ...filters, energyMax: event.target.value ? Number(event.target.value) : null })} />
                </span>
              </label>
              <label>
                BPM
                <span className="library-filter-range">
                  <input type="number" placeholder="Min" value={filters.bpmMin ?? ""} onChange={(event) => setFilters({ ...filters, bpmMin: event.target.value ? Number(event.target.value) : null })} />
                  <input type="number" placeholder="Max" value={filters.bpmMax ?? ""} onChange={(event) => setFilters({ ...filters, bpmMax: event.target.value ? Number(event.target.value) : null })} />
                </span>
              </label>
            </div>
            <button type="button" className="btn btn-ghost" onClick={() => setFilters(EMPTY_FILTERS)}>
              CLEAR FILTERS
            </button>
          </div>
        </details>
        {activeFilterCount > 0 ? (
          <span className="library-filter-summary">{activeFilterCount} active</span>
        ) : null}
        <span className="library-toolbar-hint">Sort from the column headings</span>
      </div>

      {/* Bulk actions */}
      {selectedTrackIds.length > 0 ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            height: "var(--size-filter-row)",
            padding: "0 var(--space-6)",
            background: "var(--color-accent-muted)",
            borderBottom: "1px solid var(--color-accent-dim)",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-label)",
              fontSize: "var(--font-size-xs)",
              fontWeight: 700,
              color: "var(--color-accent)",
              letterSpacing: "var(--letter-spacing-caps)",
              marginRight: "var(--space-2)",
              flexShrink: 0,
            }}
          >
            {selectedTrackIds.length} SELECTED
          </span>
          <button
            type="button"
            onClick={() => void queueAnalysis(selectedTrackIds)}
            disabled={selectedTrackIds.length === 0 || isQueueingAnalysis}
            className="btn btn-secondary"
            style={{ height: 28 }}
          >
            {isQueueingAnalysis ? "QUEUEING…" : "ANALYZE"}
          </button>
          <select
            value={selectedPlaylistValue}
            onChange={(e) => setBulkPlaylistId(e.target.value)}
            disabled={playlists.length === 0 || isAddingToPlaylist}
            style={{
              width: 150,
              background: "var(--color-bg-input)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-sm)",
              color: "var(--color-text-primary)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--font-size-sm)",
              padding: "2px var(--space-2)",
              outline: "none",
            }}
          >
            {playlists.length === 0 ? (
              <option value="">No playlists</option>
            ) : (
              playlists.map((playlist) => (
                <option key={playlist.id} value={playlist.id}>
                  {playlist.name}
                </option>
              ))
            )}
          </select>
          <button
            type="button"
            onClick={async () => {
              if (
                selectedPlaylistId === null ||
                selectedTrackIds.length === 0
              ) {
                return;
              }
              await addTracksToPlaylist({
                playlistId: selectedPlaylistId,
                trackIds: selectedTrackIds,
              });
              setSelectedTrackIds([]);
            }}
            disabled={
              selectedTrackIds.length === 0 ||
              selectedPlaylistId === null ||
              isAddingToPlaylist
            }
            className="btn btn-secondary"
            style={{ height: 28 }}
          >
            {isAddingToPlaylist ? "ADDING…" : "ADD TO PLAYLIST"}
          </button>
          <button
            type="button"
            onClick={() =>
              void runBulkUpdate({
                triage_decision: "keep",
              })
            }
            disabled={isBulkUpdating}
            className="btn btn-secondary"
            style={{ height: 28, color: "var(--color-keep)" }}
            title="Keep = done triage, keep for normal playback/sets"
          >
            KEEP
          </button>
          <button
            type="button"
            onClick={() =>
              void runBulkUpdate({
                triage_decision: "maybe",
              })
            }
            disabled={isBulkUpdating}
            className="btn btn-secondary"
            style={{ height: 28, color: "var(--color-maybe)" }}
            title="Maybe = revisit before final export"
          >
            MAYBE
          </button>
          <button
            type="button"
            onClick={() =>
              void runBulkUpdate({
                triage_decision: "reject",
              })
            }
            disabled={isBulkUpdating}
            className="btn btn-secondary"
            style={{ height: 28, color: "var(--color-reject)" }}
            title="Reject = do not carry forward"
          >
            REJECT
          </button>
          <details className="library-more-actions">
            <summary className="btn btn-ghost">MORE</summary>
            <div>
              <label>
                SET GENRE
                <span>
                  <input
                    type="text"
                    value={bulkGenreValue}
                    onChange={(event) => setBulkGenreValue(event.target.value)}
                    placeholder="Genre…"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      const nextGenre = bulkGenreValue.trim();
                      if (!nextGenre) return;
                      await runBulkUpdate({ genre: nextGenre });
                      setBulkGenreValue("");
                    }}
                    disabled={bulkGenreValue.trim().length === 0 || isBulkUpdating}
                    className="btn btn-secondary"
                  >
                    APPLY
                  </button>
                </span>
              </label>
              <button
                type="button"
                onClick={() => void runBulkUpdate({ triage_decision: "problem" })}
                disabled={isBulkUpdating}
                className="btn btn-ghost"
                style={{ color: "var(--color-problem)" }}
              >
                MARK AS PROBLEM
              </button>
              <button type="button" onClick={() => setSelectedTrackIds([])} className="btn btn-ghost">
                CLEAR SELECTION
              </button>
            </div>
          </details>
          {bulkFeedback && (
            <span
              style={{
                fontFamily: "var(--font-label)",
                fontSize: "var(--font-size-xs)",
                color: bulkFeedbackIsError
                  ? "var(--color-problem)"
                  : "var(--color-text-muted)",
                letterSpacing: "var(--letter-spacing-label)",
                marginLeft: "var(--space-2)",
              }}
            >
              {bulkFeedback}
            </span>
          )}
        </div>
      ) : (
        <div
          style={{
            height: "var(--size-filter-row)",
            borderBottom: "1px solid var(--color-border-subtle)",
            flexShrink: 0,
          }}
        />
      )}

      {/* Track table */}
      <div className="track-table" ref={tableContainerRef}>
        {table.getHeaderGroups().map((headerGroup) => (
          <div
            key={headerGroup.id}
            className="track-thead"
            style={{
              boxSizing: "border-box",
              minWidth: tableMinWidth,
            }}
          >
            {headerGroup.headers.map((header) => (
              <div
                key={header.id}
                className={COL_CLASS[header.column.id] ?? ""}
                style={{
                  cursor: header.column.getCanSort() ? "pointer" : undefined,
                  userSelect: "none",
                  position: "relative",
                  width: header.getSize(),
                  flex: `0 0 ${header.getSize()}px`,
                  ...COL_STYLE[header.column.id],
                }}
                onClick={header.column.getToggleSortingHandler()}
              >
                {flexRender(
                  header.column.columnDef.header,
                  header.getContext(),
                )}
                {header.column.getIsSorted() === "asc"
                  ? " ▲"
                  : header.column.getIsSorted() === "desc"
                    ? " ▼"
                    : ""}
                {header.column.getCanResize() && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={header.getResizeHandler()}
                    onTouchStart={header.getResizeHandler()}
                    style={{
                      position: "absolute",
                      right: 0,
                      top: 0,
                      height: "100%",
                      width: 8,
                      cursor: "col-resize",
                    }}
                  />
                )}
              </div>
            ))}
          </div>
        ))}

        <div
          style={{
            height: rowVirtualizer.getTotalSize(),
            minWidth: tableMinWidth,
            position: "relative",
          }}
        >
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const row = tableRows[virtualRow.index];
            if (!row) {
              return null;
            }
            const isSelected = selectedTrackIds.includes(row.original.id);

            return (
              <div
                key={row.original.id}
                ref={(node) => {
                  if (node) {
                    rowVirtualizer.measureElement(node);
                  }
                }}
                data-index={virtualRow.index}
                className={`track-row${row.index % 2 === 1 ? " alt" : ""}${isSelected ? " selected" : ""}`}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  boxSizing: "border-box",
                  minWidth: tableMinWidth,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                onClick={() => {
                  if (hasActiveTextSelection()) {
                    return;
                  }
                  setSelectedTrackIds(
                    isSelected
                      ? selectedTrackIds.filter((id) => id !== row.original.id)
                      : [...selectedTrackIds, row.original.id],
                  );
                }}
                onDoubleClick={() => {
                  if (hasActiveTextSelection()) {
                    return;
                  }
                  setPlaybackQueueTrackIds(
                    tableRows.map((modelRow) => modelRow.original.id),
                  );
                  const nextSelectedTrackIds = [
                    ...selectedTrackIds.filter((id) => id !== row.original.id),
                    row.original.id,
                  ];
                  setSelectedTrackIds(nextSelectedTrackIds);
                  requestTrackPlayback(row.original.id);
                }}
              >
                {row.getVisibleCells().map((cell) => (
                  <div
                    key={cell.id}
                    className={COL_CLASS[cell.column.id] ?? ""}
                    style={{
                      overflow: "hidden",
                      width: cell.column.getSize(),
                      flex: `0 0 ${cell.column.getSize()}px`,
                      ...COL_STYLE[cell.column.id],
                    }}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      {/* Empty state */}
      {filteredData.length === 0 && (
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--color-text-faint)",
            fontFamily: "var(--font-label)",
            fontSize: "var(--font-size-sm)",
            letterSpacing: "var(--letter-spacing-caps)",
          }}
        >
          {tracks.length === 0
            ? "NO TRACKS — IMPORT A FOLDER TO GET STARTED"
            : "NO TRACKS MATCH THE CURRENT FILTERS"}
        </div>
      )}
    </div>
  );
};
