import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { createApiUrl } from "../lib/api";
import { PLAYLISTS_QUERY_KEY } from "./usePlaylists";

export const SAVED_VIEWS_QUERY_KEY = ["saved-views"] as const;

export type SavedViewState = {
  search: string;
  folder_path: string | null;
  triage_decision: string[];
  analysis_status: string[];
  key_camelot: string | null;
  mood: string | null;
  energy_min: number | null;
  energy_max: number | null;
  bpm_min: number | null;
  bpm_max: number | null;
  sort_by: string;
  sort_desc: boolean;
};

export type SavedViewSummary = {
  id: number;
  name: string;
  state: SavedViewState;
  is_default: boolean;
  track_count: number;
  created_at: string;
  updated_at: string;
};

const fetchSavedViews = async (): Promise<SavedViewSummary[]> => {
  const response = await fetch(createApiUrl("/saved-views"));
  if (!response.ok) {
    throw new Error("Failed to load saved views");
  }
  return response.json();
};

const createSavedView = async (payload: {
  name: string;
  state: SavedViewState;
  is_default?: boolean;
}): Promise<SavedViewSummary> => {
  const response = await fetch(createApiUrl("/saved-views"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error("Failed to create saved view");
  }

  return response.json();
};

const deleteSavedView = async (
  viewId: number,
): Promise<{ deleted: number }> => {
  const response = await fetch(createApiUrl(`/saved-views/${viewId}`), {
    method: "DELETE",
  });

  if (!response.ok) {
    throw new Error("Failed to delete saved view");
  }

  return response.json();
};

const setDefaultSavedView = async (payload: {
  viewId: number;
}): Promise<SavedViewSummary> => {
  const response = await fetch(createApiUrl(`/saved-views/${payload.viewId}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ is_default: true }),
  });

  if (!response.ok) {
    throw new Error("Failed to set default saved view");
  }

  return response.json();
};

const freezeSavedView = async (payload: {
  viewId: number;
  name?: string;
}): Promise<{ playlist_id: number; playlist_name: string; track_count: number }> => {
  const response = await fetch(createApiUrl(`/saved-views/${payload.viewId}/freeze`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: payload.name }),
  });
  if (!response.ok) throw new Error("Failed to freeze live playlist");
  return response.json();
};

export const useSavedViews = () => {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: SAVED_VIEWS_QUERY_KEY,
    queryFn: fetchSavedViews,
  });

  const createMutation = useMutation({
    mutationFn: createSavedView,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: SAVED_VIEWS_QUERY_KEY });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteSavedView,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: SAVED_VIEWS_QUERY_KEY });
    },
  });

  const setDefaultMutation = useMutation({
    mutationFn: setDefaultSavedView,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: SAVED_VIEWS_QUERY_KEY });
    },
  });

  const freezeMutation = useMutation({
    mutationFn: freezeSavedView,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PLAYLISTS_QUERY_KEY });
    },
  });

  return {
    ...query,
    createSavedView: createMutation.mutateAsync,
    isCreatingSavedView: createMutation.isPending,
    deleteSavedView: deleteMutation.mutateAsync,
    isDeletingSavedView: deleteMutation.isPending,
    setDefaultSavedView: setDefaultMutation.mutateAsync,
    isSettingDefault: setDefaultMutation.isPending,
    freezeSavedView: freezeMutation.mutateAsync,
    isFreezingSavedView: freezeMutation.isPending,
  };
};
