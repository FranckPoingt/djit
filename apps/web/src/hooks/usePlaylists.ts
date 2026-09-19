import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { createApiUrl } from "../lib/api";

export type PlaylistSummary = {
  id: number;
  name: string;
  track_count: number;
  duration_seconds: number | null;
  bpm_min: number | null;
  bpm_max: number | null;
};

export type PlaylistDetail = PlaylistSummary & {
  tracks: {
    id: number;
    title: string;
    artist: string;
    genre?: string | null;
    mood?: string | null;
    energy?: number | null;
    duration_seconds?: number | null;
    bpm?: number | null;
    key_camelot?: string | null;
    analysis_status?: string;
    triage_decision?: string;
  }[];
};

export const PLAYLISTS_QUERY_KEY = ["playlists"] as const;

const fetchPlaylists = async (): Promise<PlaylistSummary[]> => {
  const response = await fetch(createApiUrl("/playlists"));
  if (!response.ok) {
    throw new Error("Failed to load playlists");
  }
  return response.json();
};

const fetchPlaylist = async (playlistId: number): Promise<PlaylistDetail> => {
  const response = await fetch(createApiUrl(`/playlists/${playlistId}`));
  if (!response.ok) {
    throw new Error("Failed to load playlist");
  }
  return response.json();
};

export const usePlaylists = () =>
  useQuery({
    queryKey: PLAYLISTS_QUERY_KEY,
    queryFn: fetchPlaylists,
  });

export const useCreatePlaylist = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { name: string }): Promise<PlaylistSummary> => {
      const response = await fetch(createApiUrl("/playlists"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error("Failed to create playlist");
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PLAYLISTS_QUERY_KEY });
    },
  });
};

export const useDeletePlaylist = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (playlistId: number): Promise<{ deleted: number }> => {
      const response = await fetch(createApiUrl(`/playlists/${playlistId}`), {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error("Failed to delete playlist");
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PLAYLISTS_QUERY_KEY });
    },
  });
};

export const usePlaylistDetail = (playlistId: number) =>
  useQuery({
    queryKey: [...PLAYLISTS_QUERY_KEY, playlistId],
    queryFn: () => fetchPlaylist(playlistId),
    enabled: Number.isFinite(playlistId) && playlistId > 0,
  });

export const useAddTracksToPlaylist = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { playlistId: number; trackIds: number[] }) => {
      const response = await fetch(
        createApiUrl(`/playlists/${payload.playlistId}/tracks`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ track_ids: payload.trackIds }),
        },
      );
      if (!response.ok) {
        throw new Error("Failed to add tracks to playlist");
      }
      return response.json();
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: PLAYLISTS_QUERY_KEY });
      queryClient.invalidateQueries({
        queryKey: [...PLAYLISTS_QUERY_KEY, variables.playlistId],
      });
    },
  });
};

export const useRemoveTrackFromPlaylist = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { playlistId: number; trackId: number }) => {
      const response = await fetch(
        createApiUrl(
          `/playlists/${payload.playlistId}/tracks/${payload.trackId}`,
        ),
        {
          method: "DELETE",
        },
      );
      if (!response.ok) {
        throw new Error("Failed to remove track from playlist");
      }
      return response.json();
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: PLAYLISTS_QUERY_KEY });
      queryClient.invalidateQueries({
        queryKey: [...PLAYLISTS_QUERY_KEY, variables.playlistId],
      });
    },
  });
};

export type HarmonizePlaylistRequest = {
  lock_first?: boolean;
  lock_last?: boolean;
  bpm_weight?: number;
  bpm_tolerance?: number;
  profile?: "build_up" | "cruise" | "cooldown";
};

export type HarmonizeTransitionDiagnostic = {
  from_track_id: number;
  to_track_id: number;
  from_key?: string | null;
  to_key?: string | null;
  category: string;
  label: string;
  compatibility: number;
};

export type HarmonizeDiagnostics = {
  transitions: HarmonizeTransitionDiagnostic[];
  compatibility_score: number;
  risky_jumps: number;
  energy_trend: "rising" | "falling" | "flat" | "mixed";
};

export type HarmonizePlaylistResponse = {
  playlist_id: number;
  track_ids: number[];
  applied: boolean;
  diagnostics: HarmonizeDiagnostics;
};

export const useHarmonizePlaylist = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      playlistId: number;
      options: HarmonizePlaylistRequest;
    }): Promise<HarmonizePlaylistResponse> => {
      const response = await fetch(
        createApiUrl(`/playlists/${payload.playlistId}/harmonize`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload.options),
        },
      );
      if (!response.ok) {
        throw new Error("Failed to harmonize playlist");
      }
      return response.json();
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: PLAYLISTS_QUERY_KEY });
      queryClient.invalidateQueries({
        queryKey: [...PLAYLISTS_QUERY_KEY, variables.playlistId],
      });
    },
  });
};

export const useReorderPlaylist = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { playlistId: number; trackIds: number[] }) => {
      const response = await fetch(
        createApiUrl(`/playlists/${payload.playlistId}/order`),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ track_ids: payload.trackIds }),
        },
      );
      if (!response.ok) {
        throw new Error("Failed to reorder playlist");
      }
      return response.json();
    },
    onMutate: async (variables) => {
      const queryKey = [...PLAYLISTS_QUERY_KEY, variables.playlistId];
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<PlaylistDetail>(queryKey);
      if (previous) {
        const trackMap = new Map(previous.tracks.map((t) => [t.id, t]));
        const reorderedTracks = variables.trackIds
          .map((id) => trackMap.get(id))
          .filter(
            (t): t is PlaylistDetail["tracks"][number] => t !== undefined,
          );
        queryClient.setQueryData<PlaylistDetail>(queryKey, {
          ...previous,
          tracks: reorderedTracks,
        });
      }
      return { previous };
    },
    onError: (_err, variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(
          [...PLAYLISTS_QUERY_KEY, variables.playlistId],
          context.previous,
        );
      }
    },
    onSettled: (_data, _err, variables) => {
      queryClient.invalidateQueries({ queryKey: PLAYLISTS_QUERY_KEY });
      queryClient.invalidateQueries({
        queryKey: [...PLAYLISTS_QUERY_KEY, variables.playlistId],
      });
    },
  });
};

// ============================================================================
// Graph-based playlist creation mutations
// ============================================================================

export type OrderPlaylistRequest = {
  track_ids: number[];
  start_id?: number | null;
  key_weight?: number;
  bpm_weight?: number;
  energy_weight?: number;
};

export type OrderPlaylistResponse = {
  ordered_track_ids: number[];
};

export type FindPlaylistPathRequest = {
  start_id: number;
  end_id: number;
  key_weight?: number;
  bpm_weight?: number;
  energy_weight?: number;
  bpm_tolerance?: number;
  profile?: "build_up" | "cruise" | "cooldown";
};

export type FindPlaylistPathResponse = {
  path: number[] | null;
  found: boolean;
};

export type ComponentsResponse = {
  components: number[][];
  truncated: boolean;
};

/**
 * Order a set of track IDs into a smooth playlist using graph-based nearest-neighbor.
 * Considers key harmonics, BPM continuity, and energy flow.
 */
export const useOrderPlaylist = () => {
  return useMutation({
    mutationFn: async (
      payload: OrderPlaylistRequest,
    ): Promise<OrderPlaylistResponse> => {
      const url = new URL(createApiUrl("/graph/order"));
      url.searchParams.append("types", "key");
      url.searchParams.append("types", "bpm");
      url.searchParams.append("types", "energy");

      const response = await fetch(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error("Failed to order tracks");
      }
      return response.json();
    },
  });
};

/**
 * Find optimal path between two tracks through the library graph.
 * Useful for building progressive playlists.
 */
export const useFindPlaylistPath = () => {
  return useMutation({
    mutationFn: async (
      payload: FindPlaylistPathRequest,
    ): Promise<FindPlaylistPathResponse> => {
      const url = new URL(createApiUrl("/graph/path"));
      url.searchParams.append("types", "key");
      url.searchParams.append("types", "bpm");
      url.searchParams.append("types", "energy");

      const response = await fetch(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error("Failed to find path");
      }
      return response.json();
    },
  });
};

/**
 * Detect connected components (natural playlist clusters) in the graph.
 */
export const useGetPlaylistComponents = () => {
  return useMutation({
    mutationFn: async (): Promise<ComponentsResponse> => {
      const url = new URL(createApiUrl("/graph/components"));
      url.searchParams.append("types", "key");
      url.searchParams.append("types", "bpm");
      url.searchParams.append("types", "genre");

      const response = await fetch(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!response.ok) {
        throw new Error("Failed to detect components");
      }
      return response.json();
    },
  });
};
