import { create } from "zustand";
import { persist } from "zustand/middleware";

export type GridFiltersState = {
  triageDecision: string[];
  analysisStatus: string[];
  keyCamelot: string | null;
  mood: string | null;
  energyMin: number | null;
  energyMax: number | null;
  bpmMin: number | null;
  bpmMax: number | null;
};

export type GridSortState = {
  id: string;
  desc: boolean;
};

type LibraryState = {
  selectedTrackIds: number[];
  playbackTrackId: number | null;
  playbackQueueTrackIds: number[];
  playbackRequestToken: number;
  playbackPauseRequestToken: number;
  playbackIsPlaying: boolean;
  librarySearch: string;
  libraryFolderPath: string | null;
  libraryScrollOffset: number;
  gridFilters: GridFiltersState;
  gridSorting: GridSortState[];
  setSelectedTrackIds: (trackIds: number[]) => void;
  setPlaybackQueueTrackIds: (trackIds: number[]) => void;
  requestTrackPlayback: (trackId: number) => void;
  requestTrackPause: () => void;
  setPlaybackIsPlaying: (isPlaying: boolean) => void;
  setLibrarySearch: (search: string) => void;
  setLibraryFolderPath: (folderPath: string | null) => void;
  setLibraryScrollOffset: (offset: number) => void;
  setGridFilters: (filters: GridFiltersState) => void;
  setGridSorting: (sorting: GridSortState[]) => void;
};

export const useLibraryStore = create<LibraryState>()(
  persist(
    (set) => ({
  selectedTrackIds: [],
  playbackTrackId: null,
  playbackQueueTrackIds: [],
  playbackRequestToken: 0,
  playbackPauseRequestToken: 0,
  playbackIsPlaying: false,
  librarySearch: "",
  libraryFolderPath: null,
  libraryScrollOffset: 0,
  gridFilters: {
    triageDecision: [],
    analysisStatus: [],
    keyCamelot: null,
    mood: null,
    energyMin: null,
    energyMax: null,
    bpmMin: null,
    bpmMax: null,
  },
  gridSorting: [{ id: "triage_decision", desc: false }],
  setSelectedTrackIds: (selectedTrackIds) => set({ selectedTrackIds }),
  setPlaybackQueueTrackIds: (playbackQueueTrackIds) =>
    set({ playbackQueueTrackIds }),
  requestTrackPlayback: (trackId) =>
    set((state) => ({
      playbackTrackId: trackId,
      playbackRequestToken: state.playbackRequestToken + 1,
    })),
  requestTrackPause: () =>
    set((state) => ({
      playbackPauseRequestToken: state.playbackPauseRequestToken + 1,
    })),
  setPlaybackIsPlaying: (playbackIsPlaying) => set({ playbackIsPlaying }),
  setLibrarySearch: (librarySearch) => set({ librarySearch }),
  setLibraryFolderPath: (libraryFolderPath) => set({ libraryFolderPath }),
  setLibraryScrollOffset: (libraryScrollOffset) =>
    set({ libraryScrollOffset }),
  setGridFilters: (gridFilters) => set({ gridFilters }),
  setGridSorting: (gridSorting) => set({ gridSorting }),
    }),
    {
      name: "djit-library-state",
      version: 1,
      partialize: (state) => ({
        selectedTrackIds: state.selectedTrackIds,
        playbackTrackId: state.playbackTrackId,
        librarySearch: state.librarySearch,
        libraryFolderPath: state.libraryFolderPath,
        libraryScrollOffset: state.libraryScrollOffset,
        gridFilters: state.gridFilters,
        gridSorting: state.gridSorting,
      }),
    },
  ),
);
