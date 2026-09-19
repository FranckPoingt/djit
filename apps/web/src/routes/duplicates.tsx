import { useMemo, useState } from "react";
import { createRoute } from "@tanstack/react-router";

import { useDuplicates } from "../hooks/useDuplicates";
import { rootRoute } from "./__root";

const DuplicatesPage = () => {
  const {
    data = [],
    isLoading,
    error,
    resolveDuplicateGroup,
    isResolvingGroup,
  } = useDuplicates();
  const [keepByHash, setKeepByHash] = useState<Record<string, number>>({});

  const groups = useMemo(() => data, [data]);

  return (
    <>
      <div className="djit-topbar">
        <span
          style={{
            fontFamily: "var(--font-label)",
            fontSize: "var(--font-size-sm)",
            fontWeight: 700,
            letterSpacing: "var(--letter-spacing-caps)",
            color: "var(--color-text-secondary)",
          }}
        >
          DUPLICATES
        </span>
        {!isLoading && (
          <span
            style={{
              fontFamily: "var(--font-label)",
              fontSize: "var(--font-size-xs)",
              color: "var(--color-text-faint)",
            }}
          >
            {groups.length} groups
          </span>
        )}
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "var(--space-6)" }}>
        {error ? (
          <p
            style={{
              fontFamily: "var(--font-label)",
              fontSize: "var(--font-size-sm)",
              color: "var(--color-problem)",
              marginBottom: "var(--space-4)",
            }}
          >
            FAILED TO LOAD DUPLICATE GROUPS
          </p>
        ) : null}

        {isLoading ? (
          <p
            style={{
              fontFamily: "var(--font-label)",
              fontSize: "var(--font-size-sm)",
              color: "var(--color-text-faint)",
              letterSpacing: "var(--letter-spacing-label)",
            }}
          >
            LOADING…
          </p>
        ) : null}

        {!isLoading && groups.length === 0 ? (
          <p
            style={{
              fontFamily: "var(--font-label)",
              fontSize: "var(--font-size-sm)",
              color: "var(--color-text-faint)",
              letterSpacing: "var(--letter-spacing-label)",
            }}
          >
            NO DUPLICATE GROUPS DETECTED
          </p>
        ) : null}

        <div style={{ display: "flex", flexDirection: "column" }}>
          {groups.map((group) => {
            const selectedKeepId =
              keepByHash[group.file_hash] ?? group.tracks[0]?.id;
            const removeIds = group.tracks
              .map((track) => track.id)
              .filter((trackId) => trackId !== selectedKeepId);

            return (
              <article
                key={group.file_hash}
                style={{
                  border: "1px solid var(--color-border)",
                  borderRadius: "var(--radius-lg)",
                  padding: "var(--space-4)",
                  marginBottom: "var(--space-3)",
                  background: "var(--color-bg-sidebar)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: "var(--space-3)",
                  }}
                >
                  <span
                    style={{
                      fontFamily: "var(--font-label)",
                      fontSize: "var(--font-size-xs)",
                      letterSpacing: "var(--letter-spacing-label)",
                      color: "var(--color-text-faint)",
                    }}
                  >
                    HASH {group.file_hash.slice(0, 12)}…
                  </span>
                  <button
                    type="button"
                    disabled={isResolvingGroup || removeIds.length === 0}
                    onClick={async () => {
                      await resolveDuplicateGroup({
                        keep_track_id: selectedKeepId,
                        remove_track_ids: removeIds,
                      });
                    }}
                    className="btn btn-primary"
                    style={{ height: 28 }}
                  >
                    KEEP ({removeIds.length} REMOVE)
                  </button>
                </div>

                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--space-2)",
                  }}
                >
                  {group.tracks.map((track) => (
                    <label
                      key={track.id}
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: "var(--space-3)",
                        border: "1px solid var(--color-border-subtle)",
                        borderRadius: "var(--radius-md)",
                        padding: "var(--space-2) var(--space-3)",
                        cursor: "pointer",
                        background:
                          selectedKeepId === track.id
                            ? "var(--color-bg-row-selected)"
                            : undefined,
                      }}
                    >
                      <input
                        type="radio"
                        name={`keep-${group.file_hash}`}
                        checked={selectedKeepId === track.id}
                        onChange={() =>
                          setKeepByHash((prev) => ({
                            ...prev,
                            [group.file_hash]: track.id,
                          }))
                        }
                        style={{
                          accentColor: "var(--color-accent)",
                          marginTop: 2,
                        }}
                      />
                      <div style={{ minWidth: 0 }}>
                        <p
                          style={{
                            fontSize: "var(--font-size-base)",
                            color: "var(--color-text-primary)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {track.title}
                        </p>
                        <p
                          style={{
                            fontSize: "var(--font-size-sm)",
                            color: "var(--color-text-secondary)",
                          }}
                        >
                          {track.artist}
                        </p>
                        <p
                          style={{
                            fontSize: "var(--font-size-xs)",
                            color: "var(--color-text-faint)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {track.path}
                        </p>
                      </div>
                    </label>
                  ))}
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </>
  );
};

export const duplicatesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "duplicates",
  component: DuplicatesPage,
});
