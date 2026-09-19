import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { createApiUrl } from "../lib/api";
import { type AnalysisBatch, useAnalysisBatch } from "./useAnalysisBatch";

type BatchStatus = AnalysisBatch["status"];

export const backgroundAnalysisAction = (
  status: BatchStatus | undefined,
  sawActiveBatch: boolean,
) => {
  if (status === "queued" || status === "running" || status === "paused") {
    return "wait";
  }
  if (status === "cancelled" && sawActiveBatch) return "stop";
  return "refill";
};

export const useBackgroundAnalysis = () => {
  const queryClient = useQueryClient();
  const analysisBatch = useAnalysisBatch();
  const requestPending = useRef(false);
  const sawActiveBatch = useRef(false);
  const stopped = useRef(false);

  useEffect(() => {
    if (analysisBatch.isLoading || stopped.current || requestPending.current) return;

    const action = backgroundAnalysisAction(
      analysisBatch.data?.status,
      sawActiveBatch.current,
    );
    if (action === "wait") {
      sawActiveBatch.current = true;
      return;
    }
    if (action === "stop") {
      stopped.current = true;
      return;
    }

    requestPending.current = true;
    void fetch(createApiUrl("/analysis/queue/background"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 50, mode: "fast" }),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Background analysis queue failed");
        return response.json() as Promise<{ queued: number }>;
      })
      .then((payload) => {
        if (payload.queued === 0) {
          stopped.current = true;
          return;
        }
        sawActiveBatch.current = true;
        void queryClient.invalidateQueries({ queryKey: ["analysis-batch"] });
      })
      .catch(() => {
        stopped.current = true;
      })
      .finally(() => {
        requestPending.current = false;
      });
  }, [
    analysisBatch.data?.id,
    analysisBatch.data?.status,
    analysisBatch.isLoading,
    queryClient,
  ]);
};
