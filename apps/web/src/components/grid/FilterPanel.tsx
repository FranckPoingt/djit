import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type {
  FolderBrowseResponse,
  FolderPreviewResponse,
  LibrarySourceSummary,
} from "api-client";
import { useState } from "react";

import { useLibraryImport } from "../../hooks/useLibraryImport";
import { createApiUrl } from "../../lib/api";
import { useLibraryStore } from "../../stores/libraryStore";
import { TRACKS_QUERY_KEY } from "../../hooks/useTracks";

const fetchJson = async <T,>(path: string): Promise<T> => {
  const response = await fetch(createApiUrl(path));
  if (!response.ok) throw new Error("Request failed");
  return response.json();
};

const formatDuration = (seconds: number) => {
  if (seconds < 60) return "under a minute";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.ceil((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes} min`;
};

type FolderNodeProps = {
  depth: number;
  folder: {
    name: string;
    path: string;
    imported_tracks: number;
    has_children: boolean;
    connected?: boolean;
  };
  selectedPath: string | null;
  onSelect: (path: string) => void;
};

const FolderNode = ({ depth, folder, selectedPath, onSelect }: FolderNodeProps) => {
  const [expanded, setExpanded] = useState(false);
  const childrenQuery = useQuery({
    queryKey: ["library-folders", folder.path],
    queryFn: () =>
      fetchJson<FolderBrowseResponse>(
        `/library/browse?folder_path=${encodeURIComponent(folder.path)}`,
      ),
    enabled: expanded,
    staleTime: 10_000,
  });

  return (
    <div>
      <div
        className={selectedPath === folder.path ? "source-row active" : "source-row"}
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        <button
          type="button"
          className="source-disclosure"
          aria-label={expanded ? "Collapse folder" : "Expand folder"}
          disabled={!folder.has_children}
          onClick={() => setExpanded((value) => !value)}
        >
          {folder.has_children ? (expanded ? "▾" : "▸") : "·"}
        </button>
        <button
          type="button"
          className="source-name"
          title={folder.path}
          onClick={() => onSelect(folder.path)}
        >
          {folder.name}
        </button>
        {folder.imported_tracks > 0 ? (
          <span className="source-count">{folder.imported_tracks}</span>
        ) : null}
        {folder.connected === false ? <span className="source-offline">offline</span> : null}
      </div>
      {expanded
        ? childrenQuery.data?.entries.map((child) => (
            <FolderNode
              key={child.path}
              depth={depth + 1}
              folder={child}
              selectedPath={selectedPath}
              onSelect={onSelect}
            />
          ))
        : null}
      {expanded && childrenQuery.isLoading ? (
        <div className="source-hint" style={{ paddingLeft: 28 + depth * 14 }}>
          Reading folders…
        </div>
      ) : null}
    </div>
  );
};

export const FilterPanel = () => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(true);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const activeFolderPath = useLibraryStore((state) => state.libraryFolderPath);
  const setActiveFolderPath = useLibraryStore((state) => state.setLibraryFolderPath);
  const {
    status,
    importLibrary,
    isImporting,
    importError,
    pickFolder,
    isPickingFolder,
    pickFolderError,
  } = useLibraryImport();

  const sourcesQuery = useQuery({
    queryKey: ["library-sources"],
    queryFn: () => fetchJson<LibrarySourceSummary[]>("/library/sources"),
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  });

  const previewQuery = useQuery({
    queryKey: ["library-preview", selectedPath],
    queryFn: () =>
      fetchJson<FolderPreviewResponse>(
        `/library/preview?folder_path=${encodeURIComponent(selectedPath ?? "")}`,
      ),
    enabled: false,
  });

  const handlePickFolder = async () => {
    const picked = await pickFolder();
    if (picked.folder_path) {
      setSelectedPath(picked.folder_path);
      setExpanded(true);
      setFeedback(null);
    }
  };

  const handleImport = async () => {
    if (!selectedPath) return;
    await importLibrary(selectedPath);
    setFeedback("Import Scan started. Musical Analysis will not run automatically.");
    void queryClient.invalidateQueries({ queryKey: ["library-sources"] });
  };

  const handleBrowse = (route: "/" | "/review") => {
    if (!selectedPath) return;
    setActiveFolderPath(selectedPath);
    void navigate({ to: route });
  };

  const preview = previewQuery.data;
  const isScanning = status?.status === "scanning";
  const selectedConnected =
    sourcesQuery.data?.find((source) => source.path === selectedPath)?.connected ?? true;

  return (
    <section className="sources-panel">
      <div className="sources-heading">
        <button
          type="button"
          className="sources-title"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "▾" : "▸"} MUSIC SOURCES
        </button>
        <button
          type="button"
          className="source-refresh"
          title="Refresh music sources"
          onClick={() => void sourcesQuery.refetch()}
        >
          ↻
        </button>
      </div>

      {expanded ? (
        <>
          <div className="sources-tree">
            {sourcesQuery.data?.map((source) => (
              <FolderNode
                key={source.path}
                depth={0}
                folder={{
                  name: source.name,
                  path: source.path,
                  imported_tracks: source.imported_tracks,
                  has_children: source.connected,
                  connected: source.connected,
                }}
                selectedPath={selectedPath}
                onSelect={(path) => {
                  setSelectedPath(path);
                  setFeedback(null);
                }}
              />
            ))}
            {sourcesQuery.isLoading ? <div className="source-hint">Finding disks…</div> : null}
            {!sourcesQuery.isLoading && sourcesQuery.data?.length === 0 ? (
              <div className="source-hint">Choose a music folder to get started.</div>
            ) : null}
            {sourcesQuery.isError ? (
              <div className="source-error">Could not read connected disks.</div>
            ) : null}
          </div>

          <button
            type="button"
            className="btn btn-secondary source-folder-picker"
            disabled={isPickingFolder}
            onClick={() => void handlePickFolder()}
          >
            {isPickingFolder ? "OPENING…" : "+ CHOOSE FOLDER"}
          </button>

          {activeFolderPath ? (
            <button
              type="button"
              className="source-active-filter"
              title={activeFolderPath}
              onClick={() => setActiveFolderPath(null)}
            >
              Showing {activeFolderPath.split("/").filter(Boolean).at(-1)} ×
            </button>
          ) : null}

          {selectedPath ? (
            <div className="source-selection">
              <div className="source-selection-name" title={selectedPath}>
                {selectedPath.split("/").filter(Boolean).at(-1) ?? selectedPath}
              </div>
              {!selectedConnected ? (
                <div className="source-error">Reconnect this disk to scan or play its files.</div>
              ) : null}
              <div className="source-selection-actions">
                <button type="button" className="btn btn-ghost" onClick={() => handleBrowse("/")}>
                  BROWSE
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => handleBrowse("/review")}
                >
                  REVIEW
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={previewQuery.isFetching || !selectedConnected}
                  onClick={() => void previewQuery.refetch()}
                >
                  {previewQuery.isFetching ? "SCANNING…" : "PREVIEW"}
                </button>
              </div>

              {preview ? (
                <div className="source-preview">
                  <span>{preview.audio_files} audio files</span>
                  <span>{preview.new_files} new · {preview.existing_files} indexed</span>
                  <span>
                    {preview.not_analyzed} available for analysis · about{" "}
                    {formatDuration(preview.estimated_analysis_seconds)}
                  </span>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={isImporting || isScanning || preview.new_files === 0}
                    onClick={() => void handleImport()}
                  >
                    {isImporting || isScanning
                      ? "IMPORTING…"
                      : `ADD ${preview.new_files} NEW TRACKS`}
                  </button>
                  <span>Use Organize → Analysis when you are ready.</span>
                </div>
              ) : null}
            </div>
          ) : null}

          {isScanning ? (
            <div className="source-progress">
              Importing {status?.scan_processed_files ?? 0} / {status?.scan_total_files ?? 0}
            </div>
          ) : null}
          {feedback ? <div className="source-feedback">{feedback}</div> : null}
          {importError || pickFolderError ? (
            <div className="source-error">The folder action failed. Please retry.</div>
          ) : null}
        </>
      ) : null}
    </section>
  );
};
