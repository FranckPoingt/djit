import { create } from "zustand";

type QueueEvent = Record<string, unknown>;
type TrackStatus = "pending" | "analyzing" | "done" | "failed" | "skipped";

type QueueSnapshot = {
  byTrackId: Record<number, TrackStatus>;
  lastAnalyzingTrackId: number | null;
};

type QueueState = {
  events: QueueEvent[];
  snapshot: QueueSnapshot;
  pushEvent: (event: QueueEvent) => void;
  seedPending: (trackIds: number[]) => void;
  resetSnapshot: () => void;
};

const toTrackEvent = (
  event: QueueEvent,
): { trackId: number; status: TrackStatus } | null => {
  const trackId = event.track_id;
  const status = event.status;

  if (
    typeof trackId !== "number" ||
    (status !== "pending" &&
      status !== "analyzing" &&
      status !== "done" &&
      status !== "failed" &&
      status !== "skipped")
  ) {
    return null;
  }

  return { trackId, status };
};

export const useQueueStore = create<QueueState>((set) => ({
  events: [],
  snapshot: {
    byTrackId: {},
    lastAnalyzingTrackId: null,
  },
  resetSnapshot: () =>
    set({
      events: [],
      snapshot: {
        byTrackId: {},
        lastAnalyzingTrackId: null,
      },
    }),
  seedPending: (trackIds) =>
    set((state) => {
      const currentStatuses = Object.values(state.snapshot.byTrackId);
      const hasInFlight = currentStatuses.some(
        (status) => status === "pending" || status === "analyzing",
      );
      const baseByTrackId = hasInFlight ? { ...state.snapshot.byTrackId } : {};

      for (const trackId of trackIds) {
        baseByTrackId[trackId] = "pending";
      }

      return {
        snapshot: {
          byTrackId: baseByTrackId,
          lastAnalyzingTrackId: hasInFlight
            ? state.snapshot.lastAnalyzingTrackId
            : null,
        },
      };
    }),
  pushEvent: (event) =>
    set((state) => ({
      events: [...state.events.slice(-9), event],
      snapshot: (() => {
        const parsed = toTrackEvent(event);
        if (!parsed) {
          return state.snapshot;
        }

        const currentStatuses = Object.values(state.snapshot.byTrackId);
        const hasInFlight = currentStatuses.some(
          (status) => status === "pending" || status === "analyzing",
        );
        const isStartingNewRun =
          !hasInFlight &&
          (parsed.status === "pending" || parsed.status === "analyzing");

        const baseSnapshot = isStartingNewRun
          ? {
              byTrackId: {},
              lastAnalyzingTrackId: null,
            }
          : state.snapshot;

        const byTrackId = {
          ...baseSnapshot.byTrackId,
          [parsed.trackId]: parsed.status,
        };

        let lastAnalyzingTrackId = baseSnapshot.lastAnalyzingTrackId;
        if (parsed.status === "analyzing") {
          lastAnalyzingTrackId = parsed.trackId;
        } else if (baseSnapshot.lastAnalyzingTrackId === parsed.trackId) {
          lastAnalyzingTrackId = null;
        }

        return {
          byTrackId,
          lastAnalyzingTrackId,
        };
      })(),
    })),
}));
