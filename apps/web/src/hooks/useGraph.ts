import { useQuery } from "@tanstack/react-query";
import type { GraphResponse } from "api-client";

export type EdgeType = "key" | "bpm" | "genre" | "energy" | "mood" | "artist";

export interface UseGraphOptions {
  types?: EdgeType[];
  bpmTol?: number;
  filterIds?: number[];
  enabled?: boolean;
}

export const buildGraphUrl = (opts: UseGraphOptions): string => {
  const params = new URLSearchParams();
  const types = opts.types?.length
    ? opts.types
    : (["key", "bpm"] as EdgeType[]);
  for (const t of types) params.append("types", t);
  params.set("bpm_tol", String(opts.bpmTol ?? 5));
  for (const id of opts.filterIds ?? [])
    params.append("filter_ids", String(id));
  return `/api/v1/graph?${params.toString()}`;
};

export const useGraph = (opts: UseGraphOptions = {}) =>
  useQuery<GraphResponse>({
    queryKey: ["graph", opts.types, opts.bpmTol, opts.filterIds],
    queryFn: async () => {
      const res = await fetch(buildGraphUrl(opts));
      if (!res.ok) throw new Error("Failed to load graph");
      return res.json();
    },
    enabled: opts.enabled ?? true,
    refetchOnWindowFocus: false,
  });
