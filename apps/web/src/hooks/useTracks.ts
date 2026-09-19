import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import type { PaginatedTracksResponse, TrackSummary } from "api-client";

import { createApiUrl } from "../lib/api";
import {
  type GridFiltersState,
  type GridSortState,
  useLibraryStore,
} from "../stores/libraryStore";

export const TRACKS_QUERY_KEY = ["tracks"] as const;

const PAGE_SIZE = 200;

const EMPTY_FILTERS: GridFiltersState = {
  triageDecision: [],
  analysisStatus: [],
  keyCamelot: null,
  mood: null,
  energyMin: null,
  energyMax: null,
  bpmMin: null,
  bpmMax: null,
};

export const tracksQueryKey = (
  search: string,
  folderPath: string | null,
  filters: GridFiltersState,
  sorting: GridSortState[],
) => [...TRACKS_QUERY_KEY, search.trim(), folderPath, filters, sorting] as const;

const fetchTracksPage = async (
  offset: number,
  search: string,
  folderPath: string | null,
  filters: GridFiltersState,
  sorting: GridSortState[],
): Promise<PaginatedTracksResponse> => {
  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  const normalizedSearch = search.trim();
  if (normalizedSearch.length > 0) {
    params.set("q", normalizedSearch);
  }
  if (folderPath) {
    params.set("folder_path", folderPath);
  }
  for (const decision of filters.triageDecision) {
    params.append("triage_decision", decision);
  }
  for (const status of filters.analysisStatus) {
    params.append("analysis_status", status);
  }
  if (filters.keyCamelot) params.set("key_camelot", filters.keyCamelot);
  if (filters.mood) params.set("mood", filters.mood);
  if (filters.energyMin !== null) params.set("energy_min", String(filters.energyMin));
  if (filters.energyMax !== null) params.set("energy_max", String(filters.energyMax));
  if (filters.bpmMin !== null) params.set("bpm_min", String(filters.bpmMin));
  if (filters.bpmMax !== null) params.set("bpm_max", String(filters.bpmMax));
  const primarySort = sorting[0];
  if (primarySort) {
    params.set("sort_by", primarySort.id);
    params.set("sort_desc", String(primarySort.desc));
  }
  const url = createApiUrl(`/tracks?${params.toString()}`);
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error("Failed to load tracks");
  }

  return response.json();
};

export const useTracks = () => {
  const search = useLibraryStore((state) => state.librarySearch);
  const folderPath = useLibraryStore((state) => state.libraryFolderPath);
  const filters = useLibraryStore((state) => state.gridFilters);
  const sorting = useLibraryStore((state) => state.gridSorting);

  return useTracksQuery(search, folderPath, filters, sorting);
};

export const useTracksQuery = (
  search: string,
  folderPath: string | null = null,
  filters: GridFiltersState = EMPTY_FILTERS,
  sorting: GridSortState[] = [],
) => {
  return useInfiniteQuery({
    queryKey: tracksQueryKey(search, folderPath, filters, sorting),
    queryFn: ({ pageParam }) =>
      fetchTracksPage(pageParam as number, search, folderPath, filters, sorting),
    initialPageParam: 0,
    placeholderData: keepPreviousData,
    getNextPageParam: (lastPage) => {
      const nextOffset = lastPage.offset + lastPage.limit;
      return nextOffset < lastPage.total ? nextOffset : undefined;
    },
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
};

/** Flatten all loaded pages into a single track array. */
export const flattenPages = (
  pages: PaginatedTracksResponse[] | undefined,
): TrackSummary[] => pages?.flatMap((p) => p.items) ?? [];
