import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TrackUpdate } from "api-client";

import { createApiUrl } from "../lib/api";
import { TRACKS_QUERY_KEY } from "./useTracks";

const updateTrack = async (
  trackId: number,
  payload: TrackUpdate,
): Promise<void> => {
  const response = await fetch(createApiUrl(`/tracks/${trackId}`), {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error("Failed to update track");
  }
};

export const useUpdateTrack = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      trackId,
      payload,
    }: {
      trackId: number;
      payload: TrackUpdate;
    }) => updateTrack(trackId, payload),
    onSuccess: () => {
      // Invalidate tracks query to refetch updated data
      queryClient.invalidateQueries({ queryKey: TRACKS_QUERY_KEY });
    },
  });
};
