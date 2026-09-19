import { create } from "zustand";

type PlaylistState = {
  activePlaylistId: number | null;
  setActivePlaylistId: (playlistId: number | null) => void;
};

export const usePlaylistStore = create<PlaylistState>((set) => ({
  activePlaylistId: null,
  setActivePlaylistId: (activePlaylistId) => set({ activePlaylistId }),
}));
