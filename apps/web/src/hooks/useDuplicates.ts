import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { createApiUrl } from "../lib/api";
import { TRACKS_QUERY_KEY } from "./useTracks";

export const DUPLICATES_QUERY_KEY = ["duplicates", "groups"] as const;

export type DuplicateTrackSummary = {
  id: number;
  title: string;
  artist: string;
  path: string;
};

export type DuplicateGroupSummary = {
  file_hash: string;
  tracks: DuplicateTrackSummary[];
};

const fetchDuplicateGroups = async (): Promise<DuplicateGroupSummary[]> => {
  const response = await fetch(createApiUrl("/duplicates/groups"));
  if (!response.ok) {
    throw new Error("Failed to load duplicate groups");
  }
  return response.json();
};

const resolveDuplicateGroup = async (payload: {
  keep_track_id: number;
  remove_track_ids: number[];
}): Promise<{ deleted: number; kept_track_id: number }> => {
  const response = await fetch(createApiUrl("/duplicates/resolve"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error("Failed to resolve duplicate group");
  }

  return response.json();
};

export const useDuplicates = () => {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: DUPLICATES_QUERY_KEY,
    queryFn: fetchDuplicateGroups,
  });

  const resolveMutation = useMutation({
    mutationFn: resolveDuplicateGroup,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: DUPLICATES_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: TRACKS_QUERY_KEY });
    },
  });

  return {
    ...query,
    resolveDuplicateGroup: resolveMutation.mutateAsync,
    isResolvingGroup: resolveMutation.isPending,
  };
};
