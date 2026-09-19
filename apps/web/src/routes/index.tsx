import { createRoute } from "@tanstack/react-router";
import { useMemo } from "react";

import { ExportModal } from "../components/export/ExportModal";
import { TrackGrid } from "../components/grid/TrackGrid";
import { useTracks, flattenPages } from "../hooks/useTracks";
import { useLibraryStore } from "../stores/libraryStore";
import { rootRoute } from "./__root";

const LibraryPage = () => {
  const { data } = useTracks();
  const tracks = useMemo(() => flattenPages(data?.pages), [data?.pages]);
  const totalTracks = data?.pages[0]?.total ?? 0;
  const selectedTrackIds = useLibraryStore((state) => state.selectedTrackIds);
  const folderPath = useLibraryStore((state) => state.libraryFolderPath);
  const setFolderPath = useLibraryStore((state) => state.setLibraryFolderPath);

  return (
    <>
      {/* Topbar */}
      <div className="djit-topbar">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-3)",
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-label)",
              fontSize: "var(--font-size-sm)",
              fontWeight: 700,
              letterSpacing: "var(--letter-spacing-caps)",
              color: "var(--color-text-secondary)",
            }}
          >
            LIBRARY
          </span>
          <span
            style={{
              fontFamily: "var(--font-label)",
              fontSize: "var(--font-size-xs)",
              color: "var(--color-text-faint)",
            }}
          >
            {totalTracks} tracks · {tracks.length} loaded
          </span>
          {folderPath ? (
            <button
              type="button"
              className="chip chip-pending"
              title={folderPath}
              onClick={() => setFolderPath(null)}
            >
              {folderPath.split("/").filter(Boolean).at(-1)} ×
            </button>
          ) : null}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
          }}
        >
          {selectedTrackIds.length > 0 && (
            <span
              style={{
                fontFamily: "var(--font-label)",
                fontSize: "var(--font-size-xs)",
                color: "var(--color-accent)",
                letterSpacing: "var(--letter-spacing-label)",
              }}
            >
              {selectedTrackIds.length} selected
            </span>
          )}
          <ExportModal />
        </div>
      </div>

      {/* Track table — fills remaining height */}
      <TrackGrid />
    </>
  );
};

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: LibraryPage,
});
