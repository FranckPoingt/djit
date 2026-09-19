import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { InfiniteData } from "@tanstack/react-query";
import type { PaginatedTracksResponse } from "api-client";

import {
  applyAnalysisEventToInfiniteData,
  parseAnalysisQueueEvent,
} from "../lib/analysisEvents";
import { createApiUrl } from "../lib/api";
import { TRACKS_QUERY_KEY } from "./useTracks";
import { useQueueStore } from "../stores/queueStore";

export const useAnalysisQueue = () => {
  const queryClient = useQueryClient();
  const pushEvent = useQueueStore((state) => state.pushEvent);
  const lastRefreshAtRef = useRef(0);

  useEffect(() => {
    const source = new EventSource(createApiUrl("/events/analysis"));
    source.addEventListener("analysis", (event) => {
      if (typeof event.data !== "string") {
        return;
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        return;
      }

      pushEvent(parsed);

      const analysisEvent = parseAnalysisQueueEvent(parsed);
      if (!analysisEvent) {
        return;
      }
      queryClient.setQueriesData<
        InfiniteData<PaginatedTracksResponse> | undefined
      >({ queryKey: TRACKS_QUERY_KEY }, (current) =>
        applyAnalysisEventToInfiniteData(current, analysisEvent),
      );

      const now = Date.now();
      if (now - lastRefreshAtRef.current >= 2500) {
        lastRefreshAtRef.current = now;
        void queryClient.invalidateQueries({
          queryKey: TRACKS_QUERY_KEY,
          refetchType: "active",
        });
      }
    });

    source.onerror = () => {
      const now = Date.now();
      if (now - lastRefreshAtRef.current >= 5000) {
        lastRefreshAtRef.current = now;
        void queryClient.invalidateQueries({
          queryKey: TRACKS_QUERY_KEY,
          refetchType: "active",
        });
      }
    };

    return () => {
      source.close();
    };
  }, [pushEvent, queryClient]);
};
