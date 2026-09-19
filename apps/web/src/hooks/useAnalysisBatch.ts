import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { createApiUrl } from "../lib/api";
import { TRACKS_QUERY_KEY } from "./useTracks";

export type AnalysisBatch = {
  id: number;
  mode: "fast" | "deep";
  scope: string;
  status: "queued" | "running" | "paused" | "completed" | "cancelled";
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  current_track_id: number | null;
  current_track_title: string | null;
  current_track_artist: string | null;
  elapsed_seconds: number;
  eta_seconds: number | null;
};

const request = async <T,>(path: string, method = "GET"): Promise<T> => {
  const response = await fetch(createApiUrl(path), { method });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
};

export const useAnalysisBatch = () =>
  useQuery({
    queryKey: ["analysis-batch"],
    queryFn: () => request<AnalysisBatch | null>("/analysis/batch"),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "queued" || status === "running" ? 1_000 : 5_000;
    },
    refetchIntervalInBackground: true,
  });

export const useAnalysisBatchActions = () => {
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["analysis-batch"] });
    void queryClient.invalidateQueries({ queryKey: ["analysis-candidates"] });
    void queryClient.invalidateQueries({ queryKey: TRACKS_QUERY_KEY });
  };

  return {
    pause: useMutation({
      mutationFn: () => request<AnalysisBatch>("/analysis/batch/pause", "POST"),
      onSuccess: refresh,
    }),
    resume: useMutation({
      mutationFn: () => request<AnalysisBatch>("/analysis/batch/resume", "POST"),
      onSuccess: refresh,
    }),
    cancel: useMutation({
      mutationFn: () => request<{ status: string }>("/analysis/queue", "DELETE"),
      onSuccess: refresh,
    }),
  };
};
