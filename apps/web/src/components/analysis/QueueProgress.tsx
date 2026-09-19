import {
  useAnalysisBatch,
  useAnalysisBatchActions,
} from "../../hooks/useAnalysisBatch";

const formatTime = (seconds: number | null) => {
  if (seconds === null) return "calculating…";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

export const QueueProgress = () => {
  const { data: batch } = useAnalysisBatch();
  const { pause, resume, cancel } = useAnalysisBatchActions();
  if (!batch || batch.status === "completed" || batch.status === "cancelled") return null;
  const progress = batch.total > 0 ? batch.completed / batch.total : 0;
  const currentTrack = [batch.current_track_artist, batch.current_track_title]
    .filter(Boolean)
    .join(" — ");

  return (
    <div className="analysis-banner" aria-live="polite">
      <span
        style={{
          fontWeight: 700,
          letterSpacing: "var(--letter-spacing-caps)",
          flexShrink: 0,
        }}
      >
        {batch.status === "paused"
          ? "PAUSED"
          : batch.scope === "all"
            ? "ANALYZING · BACKGROUND"
            : `ANALYZING · ${batch.mode.toUpperCase()}`}
      </span>
      <span
        style={{
          color: "var(--color-text-secondary)",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {currentTrack || "Preparing next track"}
      </span>
      <div
        className="analysis-banner-bar"
        role="progressbar"
        aria-label="Analysis progress"
        aria-valuemin={0}
        aria-valuemax={batch.total}
        aria-valuenow={batch.completed}
      >
        <div
          className="analysis-banner-fill"
          style={{ width: `${progress * 100}%` }}
        />
      </div>
      <span
        style={{
          flexShrink: 0,
          color: "var(--color-text-muted)",
        }}
      >
        {batch.completed} / {batch.total} · {formatTime(batch.eta_seconds)} left
      </span>
      {batch.status === "paused" ? (
        <button className="btn btn-ghost" type="button" onClick={() => resume.mutate()}>
          RESUME
        </button>
      ) : (
        <button className="btn btn-ghost" type="button" onClick={() => pause.mutate()}>
          PAUSE
        </button>
      )}
      <button className="btn btn-ghost" type="button" onClick={() => cancel.mutate()}>
        CANCEL
      </button>
    </div>
  );
};
