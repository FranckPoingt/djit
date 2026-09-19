import { useQuery } from "@tanstack/react-query";
import type { TrackSummary } from "api-client";
import { useEffect, useRef, useState } from "react";

import { useTrackWaveform } from "../../hooks/useTrackWaveform";
import { createApiUrl } from "../../lib/api";
import { useLibraryStore } from "../../stores/libraryStore";
import { TrackArtwork } from "../media/TrackArtwork";
import { WaveformStrip } from "../media/WaveformStrip";

const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0:00";
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
};

export const AudioPreview = () => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pendingAutoplayTrackIdRef = useRef<number | null>(null);
  const selectedTrackIds = useLibraryStore((state) => state.selectedTrackIds);
  const playbackTrackId = useLibraryStore((state) => state.playbackTrackId);
  const playbackQueueTrackIds = useLibraryStore(
    (state) => state.playbackQueueTrackIds,
  );
  const playbackRequestToken = useLibraryStore(
    (state) => state.playbackRequestToken,
  );
  const playbackPauseRequestToken = useLibraryStore(
    (state) => state.playbackPauseRequestToken,
  );
  const requestTrackPlayback = useLibraryStore(
    (state) => state.requestTrackPlayback,
  );
  const setPlaybackIsPlaying = useLibraryStore(
    (state) => state.setPlaybackIsPlaying,
  );
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const activeTrackId =
    playbackTrackId ?? selectedTrackIds[selectedTrackIds.length - 1] ?? null;
  const { data: activeTrack = null } = useQuery({
    queryKey: ["track", activeTrackId],
    enabled: activeTrackId !== null,
    queryFn: async (): Promise<TrackSummary> => {
      const response = await fetch(createApiUrl(`/tracks/${activeTrackId}`));
      if (!response.ok) throw new Error("Failed to load active track");
      return response.json();
    },
  });

  const activeQueue = playbackQueueTrackIds.length
    ? playbackQueueTrackIds
    : selectedTrackIds;
  const activeIndex =
    activeTrack && activeQueue.length > 0
      ? activeQueue.indexOf(activeTrack.id)
      : -1;
  const hasPrev = activeIndex > 0;
  const hasNext = activeIndex >= 0 && activeIndex < activeQueue.length - 1;

  const moveTrack = (direction: -1 | 1) => {
    if (!activeTrack || activeIndex < 0) {
      return;
    }
    const nextIndex = activeIndex + direction;
    if (nextIndex < 0 || nextIndex >= activeQueue.length) {
      return;
    }
    const nextTrackId = activeQueue[nextIndex];
    requestTrackPlayback(nextTrackId);
  };

  useEffect(() => {
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
    setPlaybackIsPlaying(false);
    if (audioRef.current) {
      audioRef.current.load();
    }
  }, [activeTrack?.id, setPlaybackIsPlaying]);

  useEffect(() => {
    if (!audioRef.current || !activeTrack) {
      return;
    }
    if (playbackTrackId !== activeTrack.id) {
      return;
    }

    pendingAutoplayTrackIdRef.current = activeTrack.id;
    if (audioRef.current.readyState >= 1) {
      void audioRef.current
        .play()
        .then(() => {
          pendingAutoplayTrackIdRef.current = null;
        })
        .catch(() => {
          setIsPlaying(false);
        });
    }
  }, [activeTrack, playbackRequestToken, playbackTrackId]);

  useEffect(() => {
    if (!audioRef.current || playbackPauseRequestToken === 0) {
      return;
    }
    audioRef.current.pause();
  }, [playbackPauseRequestToken]);

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play();
    }
  };

  const progress = duration > 0 ? currentTime / duration : 0;
  const { data: waveform } = useTrackWaveform(
    activeTrack?.id ?? null,
    96,
    !!activeTrack,
    activeTrack ? `${activeTrack.title}|${activeTrack.duration_seconds ?? ""}` : "",
  );
  const waveformPoints = waveform?.points ?? [];

  return (
    <div className="djit-player">
      {/* Hidden audio element */}
      {activeTrack && (
        <audio
          ref={audioRef}
          preload="metadata"
          src={createApiUrl(`/audio/${activeTrack.id}/stream`)}
          style={{ display: "none" }}
          onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => {
            setDuration(e.currentTarget.duration || 0);
            if (pendingAutoplayTrackIdRef.current === activeTrack.id) {
              void e.currentTarget
                .play()
                .then(() => {
                  pendingAutoplayTrackIdRef.current = null;
                })
                .catch(() => {
                  setIsPlaying(false);
                });
            }
          }}
          onPlay={() => {
            setIsPlaying(true);
            setPlaybackIsPlaying(true);
          }}
          onPause={() => {
            setIsPlaying(false);
            setPlaybackIsPlaying(false);
          }}
          onEnded={() => {
            setIsPlaying(false);
            setPlaybackIsPlaying(false);
            if (hasNext) {
              moveTrack(1);
            }
          }}
        />
      )}

      {/* Now Playing */}
      <div
        style={{
          width: 280,
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
          flexShrink: 0,
          overflow: "hidden",
        }}
      >
        {activeTrack ? (
          <TrackArtwork
            trackId={activeTrack.id}
            title={activeTrack.title}
            artist={activeTrack.artist}
          />
        ) : (
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: "var(--radius-md)",
              background: "var(--color-bg-surface)",
              flexShrink: 0,
            }}
          />
        )}
        <div style={{ overflow: "hidden" }}>
          <p
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--font-size-base)",
              color: "var(--color-text-primary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {activeTrack?.title ?? "—"}
          </p>
          <p
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--font-size-sm)",
              color: "var(--color-text-muted)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {activeTrack?.artist ?? "Select a track"}
          </p>
        </div>
      </div>

      {/* Controls + Scrubber */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "var(--space-2)",
          padding: "0 var(--space-6)",
        }}
      >
        {/* Play/pause */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-6)",
          }}
        >
          <button
            type="button"
            onClick={() => moveTrack(-1)}
            disabled={!activeTrack || !hasPrev}
            style={{
              background: "none",
              border: "none",
              cursor: activeTrack && hasPrev ? "pointer" : "default",
              color:
                activeTrack && hasPrev
                  ? "var(--color-text-primary)"
                  : "var(--color-text-disabled)",
              fontSize: 16,
              lineHeight: 1,
              padding: 0,
            }}
            aria-label="Previous track"
            title="Previous track"
          >
            ⏮
          </button>

          <button
            type="button"
            onClick={togglePlay}
            disabled={!activeTrack}
            style={{
              background: "none",
              border: "none",
              cursor: activeTrack ? "pointer" : "default",
              color: activeTrack
                ? "var(--color-text-primary)"
                : "var(--color-text-disabled)",
              fontSize: 22,
              lineHeight: 1,
              padding: 0,
            }}
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? "⏸" : "▶"}
          </button>

          <button
            type="button"
            onClick={() => moveTrack(1)}
            disabled={!activeTrack || !hasNext}
            style={{
              background: "none",
              border: "none",
              cursor: activeTrack && hasNext ? "pointer" : "default",
              color:
                activeTrack && hasNext
                  ? "var(--color-text-primary)"
                  : "var(--color-text-disabled)",
              fontSize: 16,
              lineHeight: 1,
              padding: 0,
            }}
            aria-label="Next track"
            title="Next track"
          >
            ⏭
          </button>
        </div>

        {/* Scrubber */}
        <div
          style={{
            width: "100%",
            maxWidth: 320,
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--font-size-xs)",
              color: "var(--color-text-muted)",
              fontVariantNumeric: "tabular-nums",
              flexShrink: 0,
            }}
          >
            {formatTime(currentTime)}
          </span>
          <div
            style={{
              flex: 1,
              height: 28,
              borderRadius: 2,
              background: "var(--color-bg-surface)",
              cursor: duration > 0 ? "pointer" : "default",
              position: "relative",
              overflow: "hidden",
            }}
            onClick={(e) => {
              if (!audioRef.current || duration === 0) return;
              const rect = e.currentTarget.getBoundingClientRect();
              const ratio = (e.clientX - rect.left) / rect.width;
              const newTime = ratio * duration;
              audioRef.current.currentTime = newTime;
              setCurrentTime(newTime);
            }}
          >
            {waveformPoints.length > 0 ? (
              <WaveformStrip
                points={waveformPoints}
                width="100%"
                height={28}
                progress={progress}
                baseColor="var(--color-waveform-idle)"
                progressColor="var(--color-waveform-played)"
              />
            ) : (
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  height: "100%",
                  width: `${progress * 100}%`,
                  borderRadius: 2,
                  background: "var(--color-accent)",
                }}
              />
            )}
          </div>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--font-size-xs)",
              color: "var(--color-text-muted)",
              fontVariantNumeric: "tabular-nums",
              flexShrink: 0,
            }}
          >
            {formatTime(duration)}
          </span>
        </div>
      </div>

      {/* Volume */}
      <div
        style={{
          width: 120,
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
          flexShrink: 0,
          justifyContent: "flex-end",
        }}
      >
        <span
          style={{
            color: "var(--color-text-muted)",
            fontSize: "var(--font-size-sm)",
          }}
        >
          🔊
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          defaultValue={1}
          onChange={(e) => {
            if (audioRef.current) {
              audioRef.current.volume = Number(e.target.value);
            }
          }}
          style={{ flex: 1, accentColor: "var(--color-accent)" }}
          aria-label="Volume"
        />
      </div>
    </div>
  );
};
