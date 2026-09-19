import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TrackBulkUpdate } from "api-client";

import { createApiUrl } from "../lib/api";
import { TRACKS_QUERY_KEY } from "./useTracks";

const bulkUpdateTracks = async (
  payload: TrackBulkUpdate,
): Promise<{ updated: number }> => {
  const response = await fetch(createApiUrl(`/tracks/bulk`), {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error("Failed to bulk update tracks");
  }

  return response.json();
};

export const useBulkUpdate = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: TrackBulkUpdate) => bulkUpdateTracks(payload),
    onSuccess: () => {
      // Invalidate tracks query to refetch updated data
      queryClient.invalidateQueries({ queryKey: TRACKS_QUERY_KEY });
    },
  });
};
