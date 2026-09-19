import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createRoute } from "@tanstack/react-router";
import type { TrackSummary, TrackUpdate } from "api-client";
import { useEffect, useMemo, useState } from "react";

import { TRACKS_QUERY_KEY } from "../hooks/useTracks";
import {
  useAnalysisBatch,
  useAnalysisBatchActions,
} from "../hooks/useAnalysisBatch";
import { useUpdateTrack } from "../hooks/useUpdateTrack";
import { createApiUrl } from "../lib/api";
import { useLibraryStore } from "../stores/libraryStore";
import { rootRoute } from "./__root";

type Health = {
  total_tracks: number;
  disconnected_sources: number;
  missing_files: number;
  incomplete_metadata: number;
  failed_analysis: number;
  duplicate_groups: number;
  issues: { track_id: number; title: string; artist: string; path: string; reason: string }[];
};

type CleanupRequest = {
  recipe: string;
  scope: "keep_maybe" | "all" | "folder";
  folder_path?: string;
  find?: string;
  replace?: string;
};

type CleanupPreview = {
  total_changes: number;
  changes: {
    track_id: number;
    title: string;
    before: Record<string, string | null>;
    after: Record<string, string | null>;
  }[];
};

type MetadataMatch = {
  search_url: string;
  automatic_lookup_available: boolean;
};

type Suggestion = { track: TrackSummary; score: number; reason: string };
type AnalysisScope = "all" | "saved_shortlisted" | "folder" | "selected";
type AnalysisMode = "fast" | "deep";
type AnalysisCandidates = { count: number; estimated_seconds: number };

const apiJson = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(createApiUrl(path), init);
  if (!response.ok) throw new Error(await response.text());
  return response.json();
};

const metric = (label: string, value: number) => (
  <div className="organize-metric">
    <strong>{value}</strong>
    <span>{label}</span>
  </div>
);

const similarity = (a: string, b: string) => {
  const tokens = (value: string) =>
    new Set(value.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const left = tokens(a);
  const right = tokens(b);
  if (!left.size || !right.size) return 0;
  const shared = [...left].filter((token) => right.has(token)).length;
  return Math.round((shared / Math.max(left.size, right.size)) * 100);
};

const formatAnalysisTime = (seconds: number | null | undefined) => {
  if (seconds === null || seconds === undefined) return "calculating…";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

const OrganizePage = () => {
  const queryClient = useQueryClient();
  const selectedTrackIds = useLibraryStore((state) => state.selectedTrackIds);
  const playbackTrackId = useLibraryStore((state) => state.playbackTrackId);
  const folderPath = useLibraryStore((state) => state.libraryFolderPath);
  const setSelectedTrackIds = useLibraryStore((state) => state.setSelectedTrackIds);
  const requestTrackPlayback = useLibraryStore((state) => state.requestTrackPlayback);
  const activeTrackId = playbackTrackId ?? selectedTrackIds.at(-1) ?? null;
  const [analysisScope, setAnalysisScope] = useState<AnalysisScope>("all");
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>("fast");
  const analysisBatch = useAnalysisBatch();
  const analysisActions = useAnalysisBatchActions();
  const activeAnalysis =
    analysisBatch.data?.status === "queued" ||
    analysisBatch.data?.status === "running" ||
    analysisBatch.data?.status === "paused";
  const analysisCandidates = useQuery({
    queryKey: ["analysis-candidates", analysisScope, folderPath, analysisMode],
    enabled: analysisScope !== "selected" && (analysisScope !== "folder" || Boolean(folderPath)),
    queryFn: () => {
      const params = new URLSearchParams({ scope: analysisScope, mode: analysisMode });
      if (analysisScope === "folder" && folderPath) params.set("folder_path", folderPath);
      return apiJson<AnalysisCandidates>(`/analysis/candidates?${params}`);
    },
  });
  const candidateCount =
    analysisScope === "selected"
      ? selectedTrackIds.length
      : (analysisCandidates.data?.count ?? 0);
  const startAnalysis = useMutation({
    mutationFn: () => {
      if (analysisScope === "selected") {
        return apiJson("/analysis/queue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            track_ids: selectedTrackIds,
            mode: analysisMode,
            scope: "selected",
          }),
        });
      }
      if (analysisScope === "folder") {
        return apiJson("/analysis/queue/folder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            folder_path: folderPath,
            scope: "all",
            mode: analysisMode,
            limit: 500,
          }),
        });
      }
      if (analysisScope === "all") {
        return apiJson("/analysis/queue/all", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: analysisMode }),
        });
      }
      return apiJson("/analysis/queue/curated", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: analysisMode }),
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["analysis-batch"] });
      void queryClient.invalidateQueries({ queryKey: TRACKS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ["analysis-candidates"] });
    },
  });

  const health = useQuery({
    queryKey: ["library-health"],
    queryFn: () => apiJson<Health>("/library/health"),
  });
  const activeTrack = useQuery({
    queryKey: ["track", activeTrackId],
    enabled: activeTrackId !== null,
    queryFn: () => apiJson<TrackSummary>(`/tracks/${activeTrackId}`),
  });
  const metadataMatch = useQuery({
    queryKey: ["metadata-match", activeTrackId],
    enabled: activeTrackId !== null,
    queryFn: () => apiJson<MetadataMatch>(`/tracks/${activeTrackId}/metadata-match`),
  });
  const suggestions = useQuery({
    queryKey: ["mix-suggestions", activeTrackId],
    enabled: activeTrackId !== null,
    queryFn: () => apiJson<Suggestion[]>(`/tracks/${activeTrackId}/mix-suggestions`),
  });

  const [recipe, setRecipe] = useState("remove_number_prefix");
  const [scope, setScope] = useState<CleanupRequest["scope"]>("keep_maybe");
  const [genreFind, setGenreFind] = useState("");
  const [genreReplace, setGenreReplace] = useState("");
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [lastBatchId, setLastBatchId] = useState<number | null>(null);

  const cleanupPayload = useMemo<CleanupRequest>(
    () => ({
      recipe,
      scope,
      folder_path: scope === "folder" ? folderPath ?? undefined : undefined,
      find: recipe === "normalize_genre" ? genreFind : undefined,
      replace: recipe === "normalize_genre" ? genreReplace : undefined,
    }),
    [folderPath, genreFind, genreReplace, recipe, scope],
  );

  const previewCleanup = useMutation({
    mutationFn: () =>
      apiJson<CleanupPreview>("/library/cleanup/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cleanupPayload),
      }),
    onSuccess: setPreview,
  });
  const applyCleanup = useMutation({
    mutationFn: () =>
      apiJson<{ batch_id: number; updated: number }>("/library/cleanup/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cleanupPayload),
      }),
    onSuccess: (result) => {
      setLastBatchId(result.batch_id || null);
      setPreview(null);
      void queryClient.invalidateQueries({ queryKey: TRACKS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ["library-health"] });
    },
  });
  const undoCleanup = useMutation({
    mutationFn: (batchId: number) =>
      apiJson<{ restored: number }>(`/library/cleanup/${batchId}/undo`, { method: "POST" }),
    onSuccess: () => {
      setLastBatchId(null);
      void queryClient.invalidateQueries({ queryKey: TRACKS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ["library-health"] });
    },
  });

  const [candidate, setCandidate] = useState({ title: "", artist: "", genre: "", bpm: "", key_camelot: "" });
  useEffect(() => {
    setCandidate({ title: "", artist: "", genre: "", bpm: "", key_camelot: "" });
  }, [activeTrackId]);
  const updateTrack = useUpdateTrack();
  const confidence = activeTrack.data && candidate.title && candidate.artist
    ? Math.round((similarity(activeTrack.data.title, candidate.title) + similarity(activeTrack.data.artist, candidate.artist)) / 2)
    : null;

  const applyCandidate = async () => {
    if (!activeTrackId) return;
    const payload: TrackUpdate = {};
    if (candidate.title) payload.title = candidate.title;
    if (candidate.artist) payload.artist = candidate.artist;
    if (candidate.genre) payload.genre = candidate.genre;
    if (candidate.key_camelot) payload.key_camelot = candidate.key_camelot;
    if (candidate.bpm && Number.isFinite(Number(candidate.bpm))) payload.bpm = Number(candidate.bpm);
    await updateTrack.mutateAsync({ trackId: activeTrackId, payload });
    setCandidate({ title: "", artist: "", genre: "", bpm: "", key_camelot: "" });
  };

  return (
    <>
      <div className="djit-topbar">
        <span className="organize-title">ORGANIZE</span>
        <span className="organize-subtitle">Health · cleanup · matches · mix suggestions</span>
      </div>
      <div className="organize-page">
        <section className="organize-card organize-analysis-card">
          <div className="organize-heading">
            <div>
              <h2>Background Analysis</h2>
              <p>Build navigation metadata while you keep listening. Progress resumes when DJ-IT reopens.</p>
            </div>
            {analysisBatch.data ? (
              <span className={`analysis-status analysis-status-${analysisBatch.data.status}`}>
                {analysisBatch.data.status.toUpperCase()}
              </span>
            ) : null}
          </div>
          <div className="organize-controls">
            <label>
              TRACKS
              <select value={analysisScope} onChange={(event) => setAnalysisScope(event.target.value as AnalysisScope)} disabled={activeAnalysis}>
                <option value="all">Entire library</option>
                <option value="saved_shortlisted">Saved + Shortlisted</option>
                <option value="folder" disabled={!folderPath}>Current folder</option>
                <option value="selected" disabled={selectedTrackIds.length === 0}>Selected in Library</option>
              </select>
            </label>
            <label>
              DEPTH
              <select value={analysisMode} onChange={(event) => setAnalysisMode(event.target.value as AnalysisMode)} disabled={activeAnalysis}>
                <option value="fast">Fast · representative sections</option>
                <option value="deep">Deep · full track</option>
              </select>
            </label>
            <button
              className="btn btn-primary"
              type="button"
              disabled={activeAnalysis || candidateCount === 0 || startAnalysis.isPending}
              onClick={() => startAnalysis.mutate()}
            >
              {startAnalysis.isPending
                ? "STARTING…"
                : analysisScope === "all"
                  ? `ANALYZE ALL · ${candidateCount}`
                  : `ANALYZE ${candidateCount} TRACKS`}
            </button>
          </div>
          {!activeAnalysis ? (
            <p className="organize-note">
              {analysisCandidates.isFetching ? "Counting tracks…" : `${candidateCount} tracks · about ${formatAnalysisTime(analysisScope === "selected" ? candidateCount * (analysisMode === "fast" ? 2.5 : 4.9) : analysisCandidates.data?.estimated_seconds)} · one low-priority worker`}
            </p>
          ) : null}
          {analysisBatch.data ? (
            <div className="analysis-batch-detail">
              <div className="analysis-batch-copy">
                <strong>{analysisBatch.data.completed} / {analysisBatch.data.total} tracks</strong>
                <span>
                  {analysisBatch.data.status === "completed"
                    ? `Completed in ${formatAnalysisTime(analysisBatch.data.elapsed_seconds)}`
                    : analysisBatch.data.status === "cancelled"
                      ? "Cancelled"
                      : analysisBatch.data.current_track_title ?? (analysisBatch.data.status === "paused" ? "Paused after the current track" : "Preparing next track")}
                </span>
                <small>
                  {analysisBatch.data.failed} failed · {analysisBatch.data.skipped} skipped
                  {activeAnalysis ? ` · ${formatAnalysisTime(analysisBatch.data.eta_seconds)} left` : ""}
                </small>
              </div>
              <div className="analysis-batch-progress" role="progressbar" aria-label="Analysis progress" aria-valuemin={0} aria-valuemax={analysisBatch.data.total} aria-valuenow={analysisBatch.data.completed}>
                <span style={{ width: `${analysisBatch.data.total > 0 ? (analysisBatch.data.completed / analysisBatch.data.total) * 100 : 0}%` }} />
              </div>
              {activeAnalysis ? (
                <div className="analysis-batch-actions">
                  {analysisBatch.data.status === "paused" ? (
                    <button className="btn btn-secondary" type="button" onClick={() => analysisActions.resume.mutate()}>RESUME</button>
                  ) : (
                    <button className="btn btn-secondary" type="button" onClick={() => analysisActions.pause.mutate()}>PAUSE</button>
                  )}
                  <button className="btn btn-ghost" type="button" onClick={() => analysisActions.cancel.mutate()}>CANCEL</button>
                  <span>You can keep reviewing while this runs.</span>
                </div>
              ) : null}
            </div>
          ) : null}
          {startAnalysis.isError ? <p className="organize-error">Analysis could not start. Finish or cancel the active batch, then retry.</p> : null}
        </section>

        <section className="organize-card">
          <div className="organize-heading">
            <div><h2>Library Health</h2><p>Read-only checks. Nothing is removed automatically.</p></div>
            <button className="btn" type="button" onClick={() => health.refetch()}>REFRESH</button>
          </div>
          {health.isLoading ? <p>Checking the collection…</p> : health.error ? <p className="organize-error">Health check failed.</p> : health.data ? (
            <>
              <div className="organize-metrics">
                {metric("offline sources", health.data.disconnected_sources)}
                {metric("missing files", health.data.missing_files)}
                {metric("incomplete metadata", health.data.incomplete_metadata)}
                {metric("failed analysis", health.data.failed_analysis)}
                {metric("duplicate groups", health.data.duplicate_groups)}
              </div>
              {health.data.duplicate_groups > 0 ? <Link to="/duplicates" className="btn">REVIEW DUPLICATES</Link> : null}
              <div className="organize-issues">
                {health.data.issues.slice(0, 8).map((issue) => (
                  <div key={issue.track_id}><strong>{issue.title}</strong><span>{issue.artist} · {issue.reason}</span></div>
                ))}
              </div>
            </>
          ) : null}
        </section>

        <section className="organize-card">
          <div className="organize-heading"><div><h2>Cleanup Batch</h2><p>Preview database metadata changes, apply once, undo once.</p></div>{lastBatchId ? <button className="btn" type="button" onClick={() => undoCleanup.mutate(lastBatchId)}>UNDO LAST</button> : null}</div>
          <div className="organize-controls">
            <select value={recipe} onChange={(event) => { setRecipe(event.target.value); setPreview(null); }}>
              <option value="remove_number_prefix">Remove number prefixes</option>
              <option value="normalize_whitespace">Normalize whitespace</option>
              <option value="fix_title_casing">Fix all-upper/all-lower titles</option>
              <option value="split_artist_title">Split Artist - Title</option>
              <option value="normalize_genre">Consolidate genre</option>
            </select>
            <select value={scope} onChange={(event) => { setScope(event.target.value as CleanupRequest["scope"]); setPreview(null); }}>
              <option value="keep_maybe">Saved + Shortlisted</option>
              <option value="all">Entire library</option>
              <option value="folder" disabled={!folderPath}>Current folder</option>
            </select>
            {recipe === "normalize_genre" ? <><input placeholder="Genre to replace" value={genreFind} onChange={(event) => setGenreFind(event.target.value)} /><input placeholder="New genre" value={genreReplace} onChange={(event) => setGenreReplace(event.target.value)} /></> : null}
            <button className="btn btn-primary" type="button" onClick={() => previewCleanup.mutate()} disabled={previewCleanup.isPending}>PREVIEW</button>
          </div>
          {preview ? <div className="cleanup-preview"><strong>{preview.total_changes} changes</strong>{preview.changes.slice(0, 6).map((change) => <div key={change.track_id}><span>{change.title}</span><code>{Object.values(change.before).filter(Boolean).join(" · ")} → {Object.values(change.after).filter(Boolean).join(" · ")}</code></div>)}{preview.total_changes > 0 ? <button className="btn btn-primary" type="button" disabled={applyCleanup.isPending} onClick={() => { if (window.confirm(`Apply ${preview.total_changes} previewed metadata changes?`)) applyCleanup.mutate(); }}>APPLY {preview.total_changes}</button> : null}</div> : null}
        </section>

        <section className="organize-card">
          <div className="organize-heading"><div><h2>Metadata Match</h2><p>Verify a Saved or Shortlisted track on Beatport, then approve only the fields you want.</p></div></div>
          {!activeTrack.data ? <p>Select a track in Library first.</p> : !["keep", "maybe"].includes(activeTrack.data.triage_decision) ? <p>Mark <strong>{activeTrack.data.title}</strong> as Save or Shortlist before enrichment.</p> : (
            <>
              <div className="metadata-current"><strong>{activeTrack.data.artist} — {activeTrack.data.title}</strong><span>{activeTrack.data.genre ?? "No genre"} · {activeTrack.data.bpm ?? "—"} BPM · {activeTrack.data.key_camelot ?? "—"}</span></div>
              {metadataMatch.data ? <a className="btn" href={metadataMatch.data.search_url} target="_blank" rel="noreferrer">SEARCH BEATPORT ↗</a> : null}
              <p className="organize-note">Beatport catalogue access requires developer authentication, so DJ-IT does not scrape the site or read Chrome cookies. Copy the confirmed values below.</p>
              <div className="organize-controls">
                {(["artist", "title", "genre", "bpm", "key_camelot"] as const).map((field) => <input key={field} placeholder={field === "key_camelot" ? "Camelot key" : field.toUpperCase()} value={candidate[field]} onChange={(event) => setCandidate((current) => ({ ...current, [field]: event.target.value }))} />)}
                <button className="btn btn-primary" type="button" onClick={applyCandidate} disabled={!candidate.title && !candidate.artist && !candidate.genre && !candidate.bpm && !candidate.key_camelot}>APPLY APPROVED FIELDS</button>
              </div>
              {confidence !== null ? <p className={confidence >= 70 ? "organize-good" : "organize-error"}>{confidence}% title/artist confidence</p> : null}
            </>
          )}
        </section>

        <section className="organize-card">
          <div className="organize-heading"><div><h2>Mix Next</h2><p>Compatibility suggestions from the Curated Collection and Shortlist.</p></div></div>
          {!activeTrack.data ? <p>Select or play a seed track first.</p> : suggestions.isLoading ? <p>Finding compatible tracks…</p> : (
            <div className="mix-suggestions">{suggestions.data?.map((suggestion) => <button key={suggestion.track.id} type="button" onClick={() => { setSelectedTrackIds([suggestion.track.id]); requestTrackPlayback(suggestion.track.id); }}><strong>{suggestion.score}</strong><span>{suggestion.track.artist} — {suggestion.track.title}<small>{suggestion.track.bpm ?? "—"} BPM · {suggestion.track.key_camelot ?? "—"} · {suggestion.reason}</small></span></button>)}</div>
          )}
        </section>
      </div>
    </>
  );
};

export const organizeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/organize",
  component: OrganizePage,
});
