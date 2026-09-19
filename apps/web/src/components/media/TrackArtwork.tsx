import { useEffect, useState } from "react";

import { createApiUrl } from "../../lib/api";

const noCoverTrackIds = new Set<number>();

type TrackArtworkProps = {
  trackId: number;
  title: string;
  artist?: string | null;
  size?: number;
  borderRadius?: number;
  priority?: boolean;
};

export const TrackArtwork = ({
  trackId,
  title,
  artist,
  size = 44,
  borderRadius = 8,
  priority = false,
}: TrackArtworkProps) => {
  const [hasCoverError, setHasCoverError] = useState(
    noCoverTrackIds.has(trackId),
  );
  const coverIdentity = encodeURIComponent(
    `${trackId}|${title}|${artist ?? ""}`,
  );

  useEffect(() => {
    setHasCoverError(noCoverTrackIds.has(trackId));
  }, [trackId]);

  const shouldTryCover = !hasCoverError;

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius,
        background: "var(--color-bg-surface)",
        flexShrink: 0,
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {shouldTryCover ? (
        <img
          key={`${trackId}:${coverIdentity}`}
          src={createApiUrl(`/audio/${trackId}/cover?v=${coverIdentity}`)}
          alt={`${title} cover`}
          loading={priority ? "eager" : "lazy"}
          fetchPriority={priority ? "high" : "auto"}
          decoding="async"
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            display: "block",
          }}
          onError={() => {
            noCoverTrackIds.add(trackId);
            setHasCoverError(true);
          }}
        />
      ) : null}
      <span
        style={{
          display: shouldTryCover ? "none" : "flex",
          width: "100%",
          height: "100%",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--color-text-disabled)",
          fontSize: Math.max(14, Math.round(size * 0.38)),
          lineHeight: 1,
        }}
      >
        ♪
      </span>
    </div>
  );
};
