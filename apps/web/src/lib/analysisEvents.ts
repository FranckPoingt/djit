import type { TrackSummary } from "api-client";
import type { InfiniteData } from "@tanstack/react-query";
import type { PaginatedTracksResponse } from "api-client";

export type AnalysisQueueEvent = {
  track_id: number;
  status: string;
  bpm?: number | null;
  bpm_confidence?: number | null;
  key_camelot?: string | null;
  mood?: string | null;
  energy?: number | null;
};

export const parseAnalysisQueueEvent = (
  payload: unknown,
): AnalysisQueueEvent | null => {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const data = payload as Record<string, unknown>;
  if (typeof data.track_id !== "number" || typeof data.status !== "string") {
    return null;
  }

  return {
    track_id: data.track_id,
    status: data.status,
    bpm: typeof data.bpm === "number" ? data.bpm : null,
    bpm_confidence:
      typeof data.bpm_confidence === "number" ? data.bpm_confidence : null,
    key_camelot: typeof data.key_camelot === "string" ? data.key_camelot : null,
    mood: typeof data.mood === "string" ? data.mood : null,
    energy: typeof data.energy === "number" ? data.energy : null,
  };
};

export const applyAnalysisEventToTracks = (
  tracks: TrackSummary[] | undefined,
  event: AnalysisQueueEvent,
): TrackSummary[] | undefined => {
  if (!tracks) {
    return tracks;
  }

  const trackIndex = tracks.findIndex((track) => track.id === event.track_id);
  if (trackIndex < 0) {
    return tracks;
  }

  const current = tracks[trackIndex];
  const next: TrackSummary = {
    ...current,
    analysis_status: event.status as TrackSummary["analysis_status"],
    bpm: event.bpm ?? current.bpm,
    bpm_confidence: event.bpm_confidence ?? current.bpm_confidence,
    key_camelot: event.key_camelot ?? current.key_camelot,
    mood: event.mood ?? current.mood,
    energy: event.energy ?? current.energy,
  };

  if (
    next.analysis_status === current.analysis_status &&
    next.bpm === current.bpm &&
    next.bpm_confidence === current.bpm_confidence &&
    next.key_camelot === current.key_camelot &&
    next.mood === current.mood &&
    next.energy === current.energy
  ) {
    return tracks;
  }

  return [
    ...tracks.slice(0, trackIndex),
    next,
    ...tracks.slice(trackIndex + 1),
  ];
};

/** Patch a single track inside InfiniteData<PaginatedTracksResponse>. */
export const applyAnalysisEventToInfiniteData = (
  data: InfiniteData<PaginatedTracksResponse> | undefined,
  event: AnalysisQueueEvent,
): InfiniteData<PaginatedTracksResponse> | undefined => {
  if (!data) return data;

  const pages = data.pages.map((page) => {
    const trackIndex = page.items.findIndex((t) => t.id === event.track_id);
    if (trackIndex < 0) return page;

    const current = page.items[trackIndex];
    const next: TrackSummary = {
      ...current,
      analysis_status: event.status as TrackSummary["analysis_status"],
      bpm: event.bpm ?? current.bpm,
      bpm_confidence: event.bpm_confidence ?? current.bpm_confidence,
      key_camelot: event.key_camelot ?? current.key_camelot,
      mood: event.mood ?? current.mood,
      energy: event.energy ?? current.energy,
    };

    if (
      next.analysis_status === current.analysis_status &&
      next.bpm === current.bpm &&
      next.bpm_confidence === current.bpm_confidence &&
      next.key_camelot === current.key_camelot &&
      next.mood === current.mood &&
      next.energy === current.energy
    ) {
      return page;
    }

    return {
      ...page,
      items: [
        ...page.items.slice(0, trackIndex),
        next,
        ...page.items.slice(trackIndex + 1),
      ],
    };
  });

  return { ...data, pages };
};
