import { useMutation } from "@tanstack/react-query";

import {
  type HarmonizePlaylistRequest,
  type OrderPlaylistRequest,
  useAddTracksToPlaylist,
  useCreatePlaylist,
  useHarmonizePlaylist,
  useOrderPlaylist,
  useReorderPlaylist,
} from "./usePlaylists";

type BuildIntelligentPlaylistRequest = {
  name: string;
  trackIds: number[];
  harmonizeOptions?: HarmonizePlaylistRequest;
  graphOrderOptions?: Omit<OrderPlaylistRequest, "track_ids">;
};

type BuildIntelligentPlaylistResponse = {
  playlistId: number;
  playlistName: string;
  added: number;
  orderedTrackIds: number[];
  method: "harmonize" | "graph" | "plain";
};

export const useBuildIntelligentPlaylist = () => {
  const createPlaylist = useCreatePlaylist();
  const addTracksToPlaylist = useAddTracksToPlaylist();
  const harmonizePlaylist = useHarmonizePlaylist();
  const orderPlaylist = useOrderPlaylist();
  const reorderPlaylist = useReorderPlaylist();

  return useMutation({
    mutationFn: async ({
      name,
      trackIds,
      harmonizeOptions,
      graphOrderOptions,
    }: BuildIntelligentPlaylistRequest): Promise<BuildIntelligentPlaylistResponse> => {
      if (trackIds.length === 0) {
        throw new Error("No tracks to build a playlist from");
      }

      const playlist = await createPlaylist.mutateAsync({ name });
      const addResult = await addTracksToPlaylist.mutateAsync({
        playlistId: playlist.id,
        trackIds,
      });

      if (trackIds.length < 2) {
        return {
          playlistId: playlist.id,
          playlistName: playlist.name,
          added: addResult.added,
          orderedTrackIds: trackIds,
          method: "plain",
        };
      }

      try {
        const harmonized = await harmonizePlaylist.mutateAsync({
          playlistId: playlist.id,
          options: harmonizeOptions ?? {
            lock_first: false,
            lock_last: false,
            bpm_weight: 0.5,
            bpm_tolerance: 4,
            profile: "cruise",
          },
        });

        return {
          playlistId: playlist.id,
          playlistName: playlist.name,
          added: addResult.added,
          orderedTrackIds: harmonized.track_ids,
          method: "harmonize",
        };
      } catch {
        const ordered = await orderPlaylist.mutateAsync({
          track_ids: trackIds,
          key_weight: graphOrderOptions?.key_weight ?? 0.5,
          bpm_weight: graphOrderOptions?.bpm_weight ?? 0.3,
          energy_weight: graphOrderOptions?.energy_weight ?? 0.2,
          start_id: graphOrderOptions?.start_id,
        });

        if (ordered.ordered_track_ids.length > 0) {
          await reorderPlaylist.mutateAsync({
            playlistId: playlist.id,
            trackIds: ordered.ordered_track_ids,
          });
        }

        return {
          playlistId: playlist.id,
          playlistName: playlist.name,
          added: addResult.added,
          orderedTrackIds: ordered.ordered_track_ids,
          method: "graph",
        };
      }
    },
  });
};
