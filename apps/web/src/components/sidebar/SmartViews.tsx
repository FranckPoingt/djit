import { useEffect, useMemo, useRef, useState } from "react";

import { useSavedViews } from "../../hooks/useSavedViews";
import { useLibraryStore } from "../../stores/libraryStore";

const SECTION_LABEL: React.CSSProperties = {
  fontFamily: "var(--font-label)",
  fontSize: "var(--font-size-xs)",
  fontWeight: 700,
  letterSpacing: "var(--letter-spacing-caps)",
  color: "var(--color-text-faint)",
  marginBottom: "var(--space-2)",
};

export const SmartViews = () => {
  const [newViewName, setNewViewName] = useState("");
  const hasAppliedDefault = useRef(false);
  const filters = useLibraryStore((state) => state.gridFilters);
  const sorting = useLibraryStore((state) => state.gridSorting);
  const setFilters = useLibraryStore((state) => state.setGridFilters);
  const setSorting = useLibraryStore((state) => state.setGridSorting);
  const search = useLibraryStore((state) => state.librarySearch);
  const folderPath = useLibraryStore((state) => state.libraryFolderPath);
  const setSearch = useLibraryStore((state) => state.setLibrarySearch);
  const setFolderPath = useLibraryStore((state) => state.setLibraryFolderPath);

  const {
    data = [],
    isLoading,
    error,
    createSavedView,
    isCreatingSavedView,
    deleteSavedView,
    isDeletingSavedView,
    setDefaultSavedView,
    isSettingDefault,
    freezeSavedView,
    isFreezingSavedView,
  } = useSavedViews();

  const canSave = useMemo(
    () => newViewName.trim().length > 0 && !isCreatingSavedView,
    [newViewName, isCreatingSavedView],
  );

  useEffect(() => {
    if (hasAppliedDefault.current) return;
    if (isLoading || data.length === 0) return;

    const defaultView = data.find((view) => view.is_default);
    if (!defaultView) {
      hasAppliedDefault.current = true;
      return;
    }

    setFilters({
      triageDecision: defaultView.state.triage_decision,
      analysisStatus: defaultView.state.analysis_status,
      keyCamelot: defaultView.state.key_camelot,
      mood: defaultView.state.mood,
      energyMin: defaultView.state.energy_min,
      energyMax: defaultView.state.energy_max,
      bpmMin: defaultView.state.bpm_min,
      bpmMax: defaultView.state.bpm_max,
    });
    setSearch(defaultView.state.search ?? "");
    setFolderPath(defaultView.state.folder_path ?? null);
    setSorting([
      {
        id: defaultView.state.sort_by,
        desc: defaultView.state.sort_desc,
      },
    ]);
    hasAppliedDefault.current = true;
  }, [data, isLoading, setFilters, setFolderPath, setSearch, setSorting]);

  const handleSaveView = async () => {
    if (!canSave) return;
    const primarySort = sorting[0] ?? { id: "triage_decision", desc: false };
    await createSavedView({
      name: newViewName.trim(),
      state: {
        search,
        folder_path: folderPath,
        triage_decision: filters.triageDecision,
        analysis_status: filters.analysisStatus,
        key_camelot: filters.keyCamelot,
        mood: filters.mood,
        energy_min: filters.energyMin,
        energy_max: filters.energyMax,
        bpm_min: filters.bpmMin,
        bpm_max: filters.bpmMax,
        sort_by: primarySort.id,
        sort_desc: primarySort.desc,
      },
    });
    setNewViewName("");
  };

  return (
    <div style={{ marginBottom: "var(--space-5)" }}>
      <p style={SECTION_LABEL}>LIVE PLAYLISTS</p>

      {error && (
        <span
          style={{
            fontSize: "var(--font-size-xs)",
            color: "var(--color-problem)",
            display: "block",
            marginBottom: "var(--space-1)",
          }}
        >
          Failed to load views.
        </span>
      )}

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-1)",
          marginBottom: "var(--space-2)",
        }}
      >
        {isLoading && (
          <span
            style={{
              fontSize: "var(--font-size-xs)",
              color: "var(--color-text-faint)",
              padding: "var(--space-1) 10px",
            }}
          >
            Loading…
          </span>
        )}

        {data.map((view) => (
          <div
            key={view.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-1)",
            }}
          >
            <button
              type="button"
              onClick={() => {
                setFilters({
                  triageDecision: view.state.triage_decision,
                  analysisStatus: view.state.analysis_status,
                  keyCamelot: view.state.key_camelot,
                  mood: view.state.mood,
                  energyMin: view.state.energy_min,
                  energyMax: view.state.energy_max,
                  bpmMin: view.state.bpm_min,
                  bpmMax: view.state.bpm_max,
                });
                setSearch(view.state.search ?? "");
                setFolderPath(view.state.folder_path ?? null);
                setSorting([
                  {
                    id: view.state.sort_by,
                    desc: view.state.sort_desc,
                  },
                ]);
              }}
              className="nav-item"
              style={{ flex: 1, justifyContent: "flex-start" }}
            >
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {view.name}
              </span>
              <span
                style={{
                  color: "var(--color-text-faint)",
                  fontSize: 10,
                  marginLeft: "auto",
                }}
              >
                {view.track_count}
              </span>
              {view.is_default && (
                <span
                  style={{
                    color: "var(--color-accent)",
                    fontSize: "var(--font-size-xs)",
                    marginLeft: "auto",
                    flexShrink: 0,
                  }}
                >
                  ★
                </span>
              )}
            </button>
            <button
              type="button"
              title="Freeze as an ordinary playlist"
              disabled={isFreezingSavedView}
              onClick={() => freezeSavedView({ viewId: view.id })}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "var(--color-text-disabled)",
                fontSize: 12,
                padding: "0 2px",
                flexShrink: 0,
              }}
            >
              ◆
            </button>
            <button
              type="button"
              title="Set default"
              disabled={isSettingDefault || view.is_default}
              onClick={() => setDefaultSavedView({ viewId: view.id })}
              style={{
                background: "none",
                border: "none",
                cursor: view.is_default ? "default" : "pointer",
                color: view.is_default
                  ? "var(--color-accent)"
                  : "var(--color-text-disabled)",
                fontSize: 12,
                padding: "0 2px",
                flexShrink: 0,
              }}
            >
              ★
            </button>
            <button
              type="button"
              title="Delete view"
              disabled={isDeletingSavedView}
              onClick={() => deleteSavedView(view.id)}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "var(--color-text-disabled)",
                fontSize: 12,
                padding: "0 2px",
                flexShrink: 0,
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {/* Save current view */}
      <div
        style={{
          display: "flex",
          gap: "var(--space-1)",
        }}
      >
        <input
          value={newViewName}
          onChange={(event) => setNewViewName(event.target.value)}
          placeholder="Save view as…"
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSaveView();
          }}
          style={{
            flex: 1,
            background: "var(--color-bg-input)",
            border: "1px solid var(--color-border-subtle)",
            borderRadius: "var(--radius-sm)",
            color: "var(--color-text-secondary)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--font-size-sm)",
            padding: "4px var(--space-2)",
            outline: "none",
            minWidth: 0,
          }}
        />
        <button
          type="button"
          onClick={handleSaveView}
          disabled={!canSave}
          className="btn btn-primary"
          style={{ height: 28, padding: "0 var(--space-2)", flexShrink: 0 }}
        >
          +
        </button>
      </div>
    </div>
  );
};
