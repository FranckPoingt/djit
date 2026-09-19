import { createRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TrackSummary } from "api-client";
import {
  AiMagicIcon,
  Cancel01Icon,
  FavouriteIcon,
  Flag01Icon,
  Playlist01Icon,
  PauseIcon,
  PlayIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";

import { TrackArtwork } from "../components/media/TrackArtwork";
import { WaveformStrip } from "../components/media/WaveformStrip";
import {
  TrackMetadataEditor,
  type TrackMetadataPatch,
} from "../components/tracks/TrackMetadataEditor";
import { Icon } from "../components/ui/Icon";
import { useTracksQuery, flattenPages, TRACKS_QUERY_KEY } from "../hooks/useTracks";
import { useTrackWaveform } from "../hooks/useTrackWaveform";
import { useUpdateTrack } from "../hooks/useUpdateTrack";
import { createApiUrl } from "../lib/api";
import {
  applyAnalysisEventToTracks,
  parseAnalysisQueueEvent,
} from "../lib/analysisEvents";
import { useLibraryStore } from "../stores/libraryStore";
import { useQueueStore } from "../stores/queueStore";
import { rootRoute } from "./__root";

const MAX_REVIEW_DURATION_SECONDS = 12 * 60;
const REVIEW_MODES = ["fresh", "shortlisted", "fixing"] as const;
type ReviewMode = (typeof REVIEW_MODES)[number];

const REVIEW_MODE_LABELS: Record<ReviewMode, string> = {
  fresh: "Fresh",
  shortlisted: "Shortlisted",
  fixing: "Issues",
};

type ReviewGenreCount = { name: string; count: number };
type ReviewOverview = {
  total_eligible: number;
  unknown_genre: number;
  genres: ReviewGenreCount[];
};
type ReviewSessionResponse = {
  tracks: TrackSummary[];
  total_eligible: number;
  selected_genres: string[];
};
type SessionDecisionCounts = {
  keep: number;
  maybe: number;
  reject: number;
  problem: number;
};

const EMPTY_SESSION_COUNTS: SessionDecisionCounts = {
  keep: 0,
  maybe: 0,
  reject: 0,
  problem: 0,
};

const formatDuration = (seconds: number | null | undefined) => {
  if (!seconds || seconds <= 0) {
    return "-";
  }
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const remaining = total % 60;
  return `${minutes}:${String(remaining).padStart(2, "0")}`;
};

const formatBpm = (value: number | null | undefined) =>
  value === null || value === undefined ? "-" : String(Math.round(value));

const getJson = async <T,>(path: string): Promise<T> => {
  const response = await fetch(createApiUrl(path));
  if (!response.ok) throw new Error(await response.text());
  return response.json();
};

const isAnalyzed = (track: TrackSummary) =>
  (track.analysis_status === "done" || track.analysis_status === "overridden") &&
  track.bpm !== null &&
  track.key_camelot !== null;

const shouldQueueReviewAnalysis = (track: TrackSummary) =>
  track.analysis_status !== "pending" &&
  track.analysis_status !== "analyzing" &&
  track.analysis_status !== "done" &&
  track.analysis_status !== "overridden" &&
  track.analysis_status !== "skipped";

const candidateScore = (track: TrackSummary) => {
  let score = 0;
  if (isAnalyzed(track)) score += 50;
  if (track.bpm_confidence !== null && track.bpm_confidence !== undefined) {
    score += track.bpm_confidence * 20;
  }
  if (track.genre) score += 8;
  if ((track.playlist_memberships ?? []).length === 0) score += 6;
  if (track.duration_seconds && track.duration_seconds <= MAX_REVIEW_DURATION_SECONDS) {
    score += 4;
  }
  return score;
};

const isReviewableDuration = (track: TrackSummary) =>
  !track.duration_seconds ||
  track.duration_seconds <= MAX_REVIEW_DURATION_SECONDS;

const isFreshCandidate = (track: TrackSummary) =>
  track.triage_decision === "unheard" &&
  (track.playlist_memberships ?? []).length === 0 &&
  isReviewableDuration(track);

const isModeCandidate = (track: TrackSummary, mode: ReviewMode) => {
  if (mode === "fresh") return isFreshCandidate(track);
  if (mode === "shortlisted") return track.triage_decision === "maybe";
  return track.triage_decision === "problem";
};

const buildCandidates = (
  tracks: TrackSummary[],
  dismissedIds: Set<number>,
  mode: ReviewMode,
) =>
  tracks
    .filter((track) => isModeCandidate(track, mode))
    .filter((track) => !dismissedIds.has(track.id))
    .sort((a, b) => candidateScore(b) - candidateScore(a) || a.id - b.id);

const buildReasonChips = (track: TrackSummary, mode: ReviewMode) => {
  const chips: string[] = [];
  if (mode === "fresh") {
    chips.push("Unsorted");
    if ((track.playlist_memberships ?? []).length === 0) chips.push("Not in playlist");
  } else if (mode === "shortlisted") {
    chips.push("Shortlisted");
  } else {
    chips.push("Issue");
  }

  if (track.analysis_status === "pending" || track.analysis_status === "analyzing") {
    chips.push("Analysis queued");
  }
  return chips;
};

const orderCandidates = (candidates: TrackSummary[], pinnedIds: number[]) => {
  const byId = new Map(candidates.map((track) => [track.id, track]));
  const ordered: TrackSummary[] = [];

  for (const trackId of pinnedIds) {
    const track = byId.get(trackId);
    if (track) {
      ordered.push(track);
      byId.delete(trackId);
    }
  }

  return [...ordered, ...Array.from(byId.values())];
};

type ReviewCardProps = {
  track: TrackSummary;
  active: boolean;
  busy: boolean;
  mode: ReviewMode;
  isPlaying: boolean;
  onPlay: () => void;
  onAnalyze: () => void;
  onEditMetadata: () => void;
  onDecision: (decision: "keep" | "maybe" | "reject" | "problem") => void;
};

const ReviewCard = ({
  track,
  active,
  busy,
  mode,
  isPlaying,
  onPlay,
  onAnalyze,
  onEditMetadata,
  onDecision,
}: ReviewCardProps) => {
  const cardRef = useRef<HTMLElement>(null);
  const [loadWaveform, setLoadWaveform] = useState(active);
  useEffect(() => {
    if (loadWaveform || !cardRef.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setLoadWaveform(true);
          observer.disconnect();
        }
      },
      { rootMargin: "500px" },
    );
    observer.observe(cardRef.current);
    return () => observer.disconnect();
  }, [loadWaveform]);

  const { data: waveform } = useTrackWaveform(
    track.id,
    80,
    loadWaveform,
    `${track.title}|${track.duration_seconds ?? ""}`,
  );
  const waveformPoints = waveform?.points ?? [];
  const shouldOfferAnalysis = shouldQueueReviewAnalysis(track);
  const reasonChips = buildReasonChips(track, mode);

  return (
    <article
      ref={cardRef}
      className="review-track-card"
      style={{
        display: "grid",
        gridTemplateColumns: "96px minmax(0, 1fr)",
        gap: "var(--space-4)",
        padding: "var(--space-5)",
        borderBottom: "1px solid var(--color-border-subtle)",
        background: active ? "var(--color-bg-elevated)" : "transparent",
        minHeight: 178,
      }}
    >
      <TrackArtwork
        trackId={track.id}
        title={track.title}
        artist={track.artist}
        size={96}
        borderRadius={0}
        priority={active}
      />
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <p
            style={{
              margin: 0,
              color: "var(--color-text-muted)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--font-size-sm)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {track.artist}
          </p>
          <h2
            style={{
              margin: 0,
              color: "var(--color-text-primary)",
              fontFamily: "var(--font-mono)",
              fontSize: active ? 22 : 17,
              lineHeight: 1.1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={track.title}
          >
            {track.title}
          </h2>
        </div>

        <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
          {reasonChips.map((chip) => (
            <span key={chip} className="chip chip-review-reason">
              {chip}
            </span>
          ))}
          <span className="chip">{formatDuration(track.duration_seconds)}</span>
          <span className="chip">BPM {formatBpm(track.bpm)}</span>
          <span className="chip">{track.key_camelot ?? "-"}</span>
          <span className="chip">{track.analysis_status}</span>
          {track.genre ? <span className="chip chip-keep">{track.genre}</span> : null}
        </div>

        {waveformPoints.length > 0 ? (
          <WaveformStrip
            points={waveformPoints}
            width={360}
            height={20}
            baseColor="var(--color-waveform-idle)"
            progressColor="var(--color-waveform-played)"
          />
        ) : (
          <div style={{ height: 20 }} />
        )}

        <div
          style={{
            display: "flex",
            gap: "var(--space-4)",
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <div className="review-action-group">
            <button
              type="button"
              className="review-action review-action-utility"
              onClick={onPlay}
            >
              <Icon icon={isPlaying ? PauseIcon : PlayIcon} aria-hidden="true" />
              <span>{isPlaying ? "Pause" : "Play"}</span>
            </button>
            <button
              type="button"
              className="review-action review-action-utility"
              onClick={onAnalyze}
              disabled={!shouldOfferAnalysis || busy}
              title={
                shouldOfferAnalysis
                  ? "Queue analysis for this track"
                  : "Analysis is already queued, done, skipped, or manual"
              }
            >
              <Icon icon={AiMagicIcon} aria-hidden="true" />
              <span>Analyze</span>
            </button>
            <button
              type="button"
              className="review-action review-action-utility"
              onClick={onEditMetadata}
            >
              <span>Clean up</span>
            </button>
          </div>

          <div className="review-action-group review-decision-group">
            <button
              type="button"
              className="review-action review-action-keep"
              onClick={() => onDecision("keep")}
              disabled={busy}
              title="Save to collection"
            >
              <Icon icon={Tick02Icon} aria-hidden="true" />
              <span>Save</span>
            </button>
            <button
              type="button"
              className="review-action review-action-maybe"
              onClick={() => onDecision("maybe")}
              disabled={busy}
              title="Shortlist for later"
            >
              <Icon icon={FavouriteIcon} aria-hidden="true" />
              <span>Shortlist</span>
            </button>
            <button
              type="button"
              className="review-action review-action-pass"
              onClick={() => onDecision("reject")}
              disabled={busy}
              title="Skip from review"
            >
              <Icon icon={Cancel01Icon} aria-hidden="true" />
              <span>Skip</span>
            </button>
            <button
              type="button"
              className="review-action review-action-problem"
              onClick={() => onDecision("problem")}
              disabled={busy}
              title="Mark as file or metadata issue"
            >
              <Icon icon={Flag01Icon} aria-hidden="true" />
              <span>Issue</span>
            </button>
          </div>
        </div>
      </div>
    </article>
  );
};

const ReviewPage = () => {
  const queryClient = useQueryClient();
  const folderPath = useLibraryStore((state) => state.libraryFolderPath);
  const selectedTrackIds = useLibraryStore((state) => state.selectedTrackIds);
  const seedTrackId = selectedTrackIds.at(-1) ?? null;
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useTracksQuery("", folderPath);
  const tracks = useMemo(() => flattenPages(data?.pages), [data?.pages]);
  const [dismissedTrackIds, setDismissedTrackIds] = useState<number[]>([]);
  const [pinnedCandidateIds, setPinnedCandidateIds] = useState<number[]>([]);
  const [reviewMode, setReviewMode] = useState<ReviewMode>("fresh");
  const [editingTrack, setEditingTrack] = useState<TrackSummary | null>(null);
  const [busyTrackId, setBusyTrackId] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [selectedGenres, setSelectedGenres] = useState<string[]>([]);
  const [genreSearch, setGenreSearch] = useState("");
  const [reviewSession, setReviewSession] = useState<ReviewSessionResponse | null>(null);
  const [isStartingSession, setIsStartingSession] = useState(false);
  const [excludedSessionGenres, setExcludedSessionGenres] = useState<string[]>([]);
  const [sessionDecisions, setSessionDecisions] = useState<SessionDecisionCounts>(
    EMPTY_SESSION_COUNTS,
  );
  const reviewGenres = useQuery({
    queryKey: ["review-genres", folderPath],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("limit", "200");
      if (folderPath) params.set("folder_path", folderPath);
      return getJson<ReviewOverview>(`/tracks/review-genres?${params}`);
    },
  });
  const { mutateAsync: updateTrack } = useUpdateTrack();
  const requestTrackPlayback = useLibraryStore((state) => state.requestTrackPlayback);
  const requestTrackPause = useLibraryStore((state) => state.requestTrackPause);
  const playbackTrackId = useLibraryStore((state) => state.playbackTrackId);
  const playbackIsPlaying = useLibraryStore((state) => state.playbackIsPlaying);
  const setPlaybackQueueTrackIds = useLibraryStore(
    (state) => state.setPlaybackQueueTrackIds,
  );
  const seedPending = useQueueStore((state) => state.seedPending);
  const lastQueueEvent = useQueueStore((state) => state.events.at(-1));

  useEffect(() => {
    const event = parseAnalysisQueueEvent(lastQueueEvent);
    if (!event) return;
    setReviewSession((current) => {
      if (!current) return current;
      const updatedTracks = applyAnalysisEventToTracks(current.tracks, event);
      return updatedTracks === current.tracks
        ? current
        : { ...current, tracks: updatedTracks ?? current.tracks };
    });
  }, [lastQueueEvent]);

  const dismissedSet = useMemo(
    () => new Set(dismissedTrackIds),
    [dismissedTrackIds],
  );
  const candidateSource =
    reviewMode === "fresh" && reviewSession ? reviewSession.tracks : tracks;
  const scoredCandidates = useMemo(
    () =>
      buildCandidates(candidateSource, dismissedSet, reviewMode).filter(
        (track) => !track.genre || !excludedSessionGenres.includes(track.genre),
      ),
    [candidateSource, dismissedSet, excludedSessionGenres, reviewMode],
  );
  const candidates = useMemo(
    () => orderCandidates(scoredCandidates, pinnedCandidateIds),
    [scoredCandidates, pinnedCandidateIds],
  );
  const visibleCandidates = useMemo(() => candidates.slice(0, 25), [candidates]);
  const reviewedCount = tracks.filter(
    (track) => track.triage_decision !== "unheard",
  ).length;
  const reviewCounts = useMemo(
    () => ({
      fresh: reviewGenres.data?.total_eligible ?? tracks.filter(isFreshCandidate).length,
      shortlisted: tracks.filter((track) => track.triage_decision === "maybe").length,
      fixing: tracks.filter((track) => track.triage_decision === "problem").length,
      saved: tracks.filter((track) => track.triage_decision === "keep").length,
      skipped: tracks.filter((track) => track.triage_decision === "reject").length,
    }),
    [reviewGenres.data?.total_eligible, tracks],
  );
  const displayedGenres = useMemo(() => {
    const genres = reviewGenres.data?.genres ?? [];
    const search = genreSearch.trim().toLocaleLowerCase();
    return search
      ? genres.filter((genre) => genre.name.toLocaleLowerCase().includes(search)).slice(0, 16)
      : genres.slice(0, 16);
  }, [genreSearch, reviewGenres.data?.genres]);

  const dismissTrack = (trackId: number) => {
    setDismissedTrackIds((current) =>
      current.includes(trackId) ? current : [...current, trackId],
    );
  };


  const queueReviewAnalysis = async (trackIds: number[]) => {
    const response = await fetch(createApiUrl("/analysis/queue"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        track_ids: trackIds,
        mode: "fast",
        scope: "review",
        priority: "review",
      }),
    });
    if (!response.ok) throw new Error("Analysis queue failed");
    const payload = (await response.json()) as {
      queued?: number;
      skipped?: number;
      queued_track_ids?: number[];
    };
    if (payload.queued_track_ids?.length) {
      seedPending(payload.queued_track_ids);
      setReviewSession((current) => {
        if (!current) return current;
        const queuedIds = new Set(payload.queued_track_ids);
        return {
          ...current,
          tracks: current.tracks.map((track) =>
            queuedIds.has(track.id)
              ? { ...track, analysis_status: "pending" }
              : track,
          ),
        };
      });
    }
    void queryClient.invalidateQueries({ queryKey: TRACKS_QUERY_KEY });
    return payload;
  };

  const changeReviewMode = (mode: ReviewMode) => {
    setReviewMode(mode);
    setPinnedCandidateIds([]);
    setFeedback(null);
  };

  const startReviewSession = async (useSeed = false) => {
    setIsStartingSession(true);
    setFeedback(null);
    try {
      const params = new URLSearchParams({ limit: "25" });
      if (!useSeed) {
        for (const genre of selectedGenres) params.append("genre", genre);
      }
      if (folderPath) params.set("folder_path", folderPath);
      if (useSeed && seedTrackId !== null) {
        params.set("seed_track_id", String(seedTrackId));
      }
      const session = await getJson<ReviewSessionResponse>(
        `/tracks/review-session?${params}`,
      );
      setReviewSession(session);
      setDismissedTrackIds([]);
      setPinnedCandidateIds(session.tracks.map((track) => track.id));
      setExcludedSessionGenres([]);
      setSessionDecisions(EMPTY_SESSION_COUNTS);
      setPlaybackQueueTrackIds(session.tracks.map((track) => track.id));
      if (session.tracks.length === 0) {
        setFeedback("No unsorted tracks match that direction. Try another genre or Surprise me.");
      } else {
        void queueReviewAnalysis(session.tracks.map((track) => track.id))
          .then((payload) => {
            if (payload.queued) {
              setFeedback(`Fast lane started for ${payload.queued} tracks in this round.`);
            }
          })
          .catch(() => setFeedback("Review started, but its analysis fast lane could not start."));
      }
    } catch {
      setFeedback("Could not start this listening session. Please retry.");
    } finally {
      setIsStartingSession(false);
    }
  };

  const hideSessionGenre = (genre: string) => {
    setExcludedSessionGenres((current) =>
      current.includes(genre) ? current : [...current, genre],
    );
    setFeedback(`${genre} hidden from this round. No tracks were skipped.`);
  };

  useEffect(() => {
    setPinnedCandidateIds((current) => {
      const currentVisible = visibleCandidates.map((track) => track.id);
      const next = currentVisible.join(":");
      return current.join(":") === next ? current : currentVisible;
    });
  }, [visibleCandidates]);

  const handleDecision = async (
    track: TrackSummary,
    decision: "keep" | "maybe" | "reject" | "problem",
  ) => {
    setBusyTrackId(track.id);
    setFeedback(null);
    try {
      await updateTrack({ trackId: track.id, payload: { triage_decision: decision } });
      dismissTrack(track.id);
      if (reviewMode === "fresh" && reviewSession) {
        setSessionDecisions((current) => ({
          ...current,
          [decision]: current[decision] + 1,
        }));
      }
      setFeedback(`${track.title} marked ${decision}.`);
    } catch {
      setFeedback("Could not update the track. Please retry.");
    } finally {
      setBusyTrackId(null);
    }
  };

  const handleAnalyze = async (track: TrackSummary) => {
    setBusyTrackId(track.id);
    setFeedback(null);
    try {
      const payload = await queueReviewAnalysis([track.id]);
      setFeedback(
        payload.skipped
          ? `${track.title} skipped because it is over 12 minutes.`
          : payload.queued
            ? `${track.title} queued for analysis.`
            : `${track.title} does not need analysis.`,
      );
    } catch {
      setFeedback("Could not queue analysis. Please retry.");
    } finally {
      setBusyTrackId(null);
    }
  };

  const saveTrackMetadata = async (payload: TrackMetadataPatch) => {
    if (!editingTrack) return;
    const trackId = editingTrack.id;
    setBusyTrackId(trackId);
    try {
      await updateTrack({ trackId, payload });
      setReviewSession((current) =>
        current
          ? {
              ...current,
              tracks: current.tracks.map((track) =>
                track.id === trackId ? { ...track, ...payload } : track,
              ),
            }
          : current,
      );
      void queryClient.invalidateQueries({ queryKey: ["review-genres"] });
      setEditingTrack(null);
      setFeedback("Track metadata cleaned up.");
    } catch {
      setFeedback("Could not update track metadata. Please retry.");
    } finally {
      setBusyTrackId(null);
    }
  };

  const handlePlay = (trackId: number) => {
    if (playbackTrackId === trackId && playbackIsPlaying) {
      requestTrackPause();
      return;
    }
    const queueIds = visibleCandidates.map((track) => track.id);
    setPlaybackQueueTrackIds(queueIds);
    requestTrackPlayback(trackId);
  };

  const sessionReviewed = Object.values(sessionDecisions).reduce(
    (total, count) => total + count,
    0,
  );
  const sessionHidden = reviewSession
    ? reviewSession.tracks.filter(
        (track) => track.genre && excludedSessionGenres.includes(track.genre),
      ).length
    : 0;
  const isFreshSetup =
    reviewMode === "fresh" &&
    (reviewSession === null || reviewSession.tracks.length === 0);
  const isFreshComplete =
    reviewMode === "fresh" &&
    reviewSession !== null &&
    reviewSession.tracks.length > 0 &&
    candidates.length === 0;
  const headerSummary =
    reviewMode === "fresh" && reviewSession
      ? `${sessionReviewed}/${reviewSession.tracks.length} reviewed · ${reviewSession.total_eligible} matching tracks`
      : `${candidates.length} ${REVIEW_MODE_LABELS[reviewMode].toLowerCase()} · ${reviewedCount}/${tracks.length} loaded tracks triaged`;

  return (
    <>
      <div className="djit-topbar">
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          <span
            style={{
              fontFamily: "var(--font-label)",
              fontSize: "var(--font-size-sm)",
              fontWeight: 700,
              letterSpacing: "var(--letter-spacing-caps)",
              color: "var(--color-text-secondary)",
            }}
          >
            REVIEW
          </span>
          <span
            style={{
              fontFamily: "var(--font-label)",
              fontSize: "var(--font-size-xs)",
              color: "var(--color-text-faint)",
            }}
          >
            {headerSummary}
          </span>
        </div>
        {reviewMode !== "fresh" ? (
          <button
            type="button"
            className="review-action review-action-utility"
            onClick={() => void fetchNextPage()}
            disabled={!hasNextPage || isFetchingNextPage}
          >
            LOAD MORE
          </button>
        ) : null}
        <Link
          to="/playlists"
          className="review-action review-action-keep"
          title="Build a playlist from Saved and Shortlisted tracks"
        >
          <Icon icon={Playlist01Icon} aria-hidden="true" />
          <span>Build Playlist</span>
        </Link>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--space-4)",
          padding: "var(--space-3) var(--space-6)",
          borderTop: "1px solid var(--color-border-subtle)",
          borderBottom: "1px solid var(--color-border-subtle)",
          background: "var(--color-bg-row-alt)",
        }}
      >
        <div className="review-mode-bar">
          {REVIEW_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              className={
                mode === reviewMode
                  ? "review-mode-button active"
                  : "review-mode-button"
              }
              onClick={() => changeReviewMode(mode)}
            >
              <span>{REVIEW_MODE_LABELS[mode]}</span>
              <span>{reviewCounts[mode]}</span>
            </button>
          ))}
        </div>
        <div className="review-progress-strip">
          <span>Saved {reviewCounts.saved}</span>
          <span>Shortlisted {reviewCounts.shortlisted}</span>
          <span>Skipped {reviewCounts.skipped}</span>
          <span>Issues {reviewCounts.fixing}</span>
        </div>
      </div>

      <div
        style={{
          flex: 1,
          overflow: "auto",
          borderTop: "1px solid var(--color-border-subtle)",
        }}
      >
        {feedback ? (
          <div
            style={{
              padding: "var(--space-3) var(--space-6)",
              borderBottom: "1px solid var(--color-border-subtle)",
              color: "var(--color-text-muted)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--font-size-sm)",
            }}
          >
            {feedback}
          </div>
        ) : null}

        {isFreshSetup ? (
          <section className="review-start-card">
            <span className="review-eyebrow">START A LISTENING ROUND</span>
            <h1>What are you digging for?</h1>
            <p>
              Pick a direction or let DJ-IT surprise you. You have{" "}
              {reviewGenres.data?.total_eligible ?? "thousands of"} unsorted tracks;
              this round contains only 25.
            </p>
            {folderPath ? (
              <span className="chip chip-pending">
                Source · {folderPath.split("/").filter(Boolean).at(-1)}
              </span>
            ) : null}
            <input
              className="review-genre-search"
              type="search"
              value={genreSearch}
              onChange={(event) => setGenreSearch(event.target.value)}
              placeholder="Search genres — Funk, Hardstyle…"
              aria-label="Search genres"
            />
            {genreSearch && displayedGenres.length > 1 ? (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() =>
                  setSelectedGenres((current) => [
                    ...new Set([...current, ...displayedGenres.map((genre) => genre.name)]),
                  ])
                }
              >
                SELECT ALL {displayedGenres.length} MATCHES
              </button>
            ) : null}
            <div className="review-genre-grid">
              {displayedGenres.map((genre) => {
                const active = selectedGenres.includes(genre.name);
                return (
                  <button
                    key={genre.name}
                    type="button"
                    className={active ? "review-genre active" : "review-genre"}
                    aria-pressed={active}
                    onClick={() =>
                      setSelectedGenres((current) =>
                        active
                          ? current.filter((value) => value !== genre.name)
                          : [...current, genre.name],
                      )
                    }
                  >
                    <strong>{genre.name}</strong>
                    <span>{genre.count} unsorted</span>
                  </button>
                );
              })}
            </div>
            {genreSearch && displayedGenres.length === 0 ? (
              <p className="review-unknown-note">No unsorted tracks match that genre.</p>
            ) : null}
            {reviewGenres.data?.unknown_genre ? (
              <p className="review-unknown-note">
                {reviewGenres.data.unknown_genre} tracks have no genre yet. Surprise me can
                surface them while background analysis adds BPM, key, and intensity.
              </p>
            ) : null}
            <div className="review-start-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={isStartingSession}
                onClick={() => void startReviewSession(false)}
              >
                {isStartingSession
                  ? "BUILDING ROUND…"
                  : selectedGenres.length > 0
                    ? `START WITH ${selectedGenres.length} ${selectedGenres.length === 1 ? "GENRE" : "GENRES"}`
                    : "SURPRISE ME · 25 TRACKS"}
              </button>
              {seedTrackId !== null ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={isStartingSession}
                  onClick={() => void startReviewSession(true)}
                >
                  MORE LIKE SELECTED TRACK
                </button>
              ) : null}
            </div>
          </section>
        ) : isFreshComplete ? (
          <section className="review-session-summary">
            <span className="review-eyebrow">ROUND COMPLETE</span>
            <h1>{sessionReviewed} tracks reviewed</h1>
            <div className="review-summary-counts">
              <span><strong>{sessionDecisions.keep}</strong> Saved</span>
              <span><strong>{sessionDecisions.maybe}</strong> Shortlisted</span>
              <span><strong>{sessionDecisions.reject}</strong> Skipped</span>
              <span><strong>{sessionDecisions.problem}</strong> Issues</span>
              <span><strong>{sessionHidden}</strong> Hidden this round</span>
            </div>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void startReviewSession(false)}
              disabled={isStartingSession}
            >
              REVIEW ANOTHER 25
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setReviewSession(null);
                setDismissedTrackIds([]);
                setExcludedSessionGenres([]);
              }}
            >
              CHANGE DIRECTION
            </button>
          </section>
        ) : isLoading ? (
          <div className="empty-state">LOADING REVIEW DECK...</div>
        ) : visibleCandidates.length > 0 ? (
          <>
            {reviewMode === "fresh" && reviewSession?.selected_genres.length ? (
              <div
                style={{
                  display: "flex",
                  gap: "var(--space-2)",
                  alignItems: "center",
                  flexWrap: "wrap",
                  maxWidth: 980,
                  margin: "0 auto",
                  padding: "var(--space-3) var(--space-5)",
                  borderInline: "1px solid var(--color-border-subtle)",
                  borderBottom: "1px solid var(--color-border-subtle)",
                }}
              >
                <span className="review-eyebrow">THIS ROUND</span>
                {reviewSession.selected_genres
                  .filter((genre) => !excludedSessionGenres.includes(genre))
                  .map((genre) => (
                    <button
                      key={genre}
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => hideSessionGenre(genre)}
                    >
                      HIDE {genre}
                    </button>
                  ))}
              </div>
            ) : null}
            <div
              style={{
                maxWidth: 980,
                margin: "0 auto",
                borderLeft: "1px solid var(--color-border-subtle)",
                borderRight: "1px solid var(--color-border-subtle)",
              }}
            >
              {visibleCandidates.map((track, index) => (
                <ReviewCard
                  key={track.id}
                  track={track}
                  active={index === 0}
                  busy={busyTrackId === track.id}
                  mode={reviewMode}
                  isPlaying={playbackTrackId === track.id && playbackIsPlaying}
                  onPlay={() => handlePlay(track.id)}
                  onAnalyze={() => void handleAnalyze(track)}
                  onEditMetadata={() => setEditingTrack(track)}
                  onDecision={(decision) => void handleDecision(track, decision)}
                />
              ))}
            </div>
          </>
        ) : (
          <div className="empty-state">
            NO {REVIEW_MODE_LABELS[reviewMode].toUpperCase()} TRACKS IN THE LOADED LIBRARY
          </div>
        )}
      </div>
      {editingTrack ? (
        <TrackMetadataEditor
          key={editingTrack.id}
          track={editingTrack}
          isSaving={busyTrackId === editingTrack.id}
          onClose={() => setEditingTrack(null)}
          onSave={(payload) => void saveTrackMetadata(payload)}
        />
      ) : null}
    </>
  );
};

export const reviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/review",
  component: ReviewPage,
});
