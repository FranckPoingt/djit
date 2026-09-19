import type { paths, components } from "./generated";

export type HealthResponse =
  paths["/api/v1/health"]["get"]["responses"]["200"]["content"]["application/json"];

export type PaginatedTracksResponse =
  paths["/api/v1/tracks"]["get"]["responses"]["200"]["content"]["application/json"];

export type TrackSummary = PaginatedTracksResponse["items"][number];

export type TrackUpdate = components["schemas"]["TrackUpdate"];

export type TrackBulkUpdate = components["schemas"]["TrackBulkUpdate"];
export type LibraryStatusResponse =
  paths["/api/v1/library/status"]["get"]["responses"]["200"]["content"]["application/json"];

export type LibraryImportResponse =
  paths["/api/v1/library/import"]["post"]["responses"]["200"]["content"]["application/json"];

export type FolderPickResponse =
  paths["/api/v1/library/pick-folder"]["get"]["responses"]["200"]["content"]["application/json"];

export type LibrarySourceSummary = components["schemas"]["LibrarySourceSummary"];
export type FolderBrowseResponse = components["schemas"]["FolderBrowseResponse"];
export type FolderPreviewResponse = components["schemas"]["FolderPreviewResponse"];
export type FolderAnalysisQueueRequest =
  components["schemas"]["FolderAnalysisQueueRequest"];

export type GraphResponse = components["schemas"]["GraphResponse"];
export type GraphNode = components["schemas"]["GraphNode"];
export type GraphEdge = components["schemas"]["GraphEdge"];

export const createApiUrl = (path: string) => {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  return `/api/v1${normalizedPath}`;
};

export type { paths };
