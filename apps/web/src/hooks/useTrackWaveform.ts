import { useQuery } from "@tanstack/react-query";

import { createApiUrl } from "../lib/api";

export type TrackWaveform = {
  track_id: number;
  points: number[];
  duration_seconds: number | null;
};

const fetchTrackWaveform = async (
  trackId: number,
  points: number,
  version: string,
): Promise<TrackWaveform> => {
  const response = await fetch(
    createApiUrl(
      `/audio/${trackId}/waveform?points=${points}&v=${encodeURIComponent(version)}`,
    ),
  );

  if (response.status === 404) {
    return {
      track_id: trackId,
      points: [],
      duration_seconds: null,
    };
  }

  if (!response.ok) {
    throw new Error("Failed to load waveform");
  }

  return response.json();
};

export const useTrackWaveform = (
  trackId: number | null,
  points = 48,
  enabled = true,
  version = "",
) =>
  useQuery({
    queryKey: ["waveform", trackId, points, version],
    queryFn: () => fetchTrackWaveform(trackId!, points, version),
    enabled: enabled && typeof trackId === "number" && trackId > 0,
    retry: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: 1000 * 60 * 60,
    gcTime: 1000 * 60 * 60 * 6,
  });
