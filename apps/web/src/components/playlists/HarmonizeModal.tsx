/**
 * HarmonizeModal — dialog to configure and trigger harmonic playlist ordering.
 *
 * Features:
 * - Mode toggle: Mood (key-heavy) vs Fuzzy (BPM-heavy)
 * - BPM tolerance slider
 * - Lock first track / Lock last track checkboxes
 * - Camelot Wheel preview that highlights the keys in the current playlist
 * - Cancel / Harmonize buttons
 */
import { useState } from "react";

import type { HarmonizePlaylistRequest } from "../../hooks/usePlaylists";
import { CamelotWheel } from "./CamelotWheel";

type HarmonizeMode = "build_up" | "cruise" | "cooldown";

type HarmonizeModalProps = {
  playlistName: string;
  trackKeys: (string | null | undefined)[];
  isLoading: boolean;
  onConfirm: (req: HarmonizePlaylistRequest) => void;
  onClose: () => void;
};

export const HarmonizeModal = ({
  playlistName,
  trackKeys,
  isLoading,
  onConfirm,
  onClose,
}: HarmonizeModalProps) => {
  const [mode, setMode] = useState<HarmonizeMode>("cruise");
  const [bpmTolerance, setBpmTolerance] = useState(4);
  const [lockFirst, setLockFirst] = useState(false);
  const [lockLast, setLockLast] = useState(false);

  const highlightedKeys = trackKeys.filter((k): k is string => !!k);
  const bpmWeight =
    mode === "build_up" ? 0.35 : mode === "cooldown" ? 0.45 : 0.5;

  const handleConfirm = () => {
    onConfirm({
      lock_first: lockFirst,
      lock_last: lockLast,
      bpm_weight: bpmWeight,
      bpm_tolerance: bpmTolerance,
      profile: mode,
    });
  };

  return (
    /* Backdrop */
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.65)",
        backdropFilter: "blur(4px)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Dialog */}
      <div
        style={{
          background: "var(--color-bg-panel)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-lg)",
          padding: "var(--space-6)",
          width: 560,
          maxWidth: "calc(100vw - 32px)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-5)",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <h2
            style={{
              fontFamily: "var(--font-label)",
              fontSize: "var(--font-size-sm)",
              fontWeight: 700,
              letterSpacing: "var(--letter-spacing-caps)",
              color: "var(--color-text-primary)",
              margin: 0,
            }}
          >
            HARMONIZE PLAYLIST
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="btn btn-ghost"
            style={{ height: 26 }}
          >
            ✕
          </button>
        </div>

        <p
          style={{
            fontFamily: "var(--font-label)",
            fontSize: "var(--font-size-xs)",
            color: "var(--color-text-muted)",
            letterSpacing: "var(--letter-spacing-label)",
            margin: 0,
          }}
        >
          {playlistName.toUpperCase()} · {highlightedKeys.length} ANALYSED
          TRACKS
        </p>

        {/* Two-column: controls left, wheel right */}
        <div
          style={{
            display: "flex",
            gap: "var(--space-6)",
            alignItems: "flex-start",
          }}
        >
          {/* Left: controls */}
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-4)",
            }}
          >
            {/* Harmonize mode */}
            <div>
              <label
                style={{
                  display: "block",
                  fontFamily: "var(--font-label)",
                  fontSize: "var(--font-size-xs)",
                  letterSpacing: "var(--letter-spacing-label)",
                  color: "var(--color-text-muted)",
                  marginBottom: "var(--space-2)",
                }}
              >
                HARMONIZE MODE
              </label>
              <div style={{ display: "flex", gap: "var(--space-2)" }}>
                {(["build_up", "cruise", "cooldown"] as HarmonizeMode[]).map(
                  (m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setMode(m)}
                      className={
                        mode === m ? "btn btn-primary" : "btn btn-secondary"
                      }
                      style={{ height: 28, minWidth: 84 }}
                    >
                      {m === "build_up"
                        ? "Build Up"
                        : m === "cooldown"
                          ? "Cooldown"
                          : "Cruise"}
                    </button>
                  ),
                )}
              </div>
              <p
                style={{
                  fontFamily: "var(--font-body)",
                  fontSize: "var(--font-size-xs)",
                  color: "var(--color-text-faint)",
                  marginTop: "var(--space-1)",
                }}
              >
                {mode === "build_up"
                  ? "Prefers positive key motion (+ / ++ / +++) for rising sets."
                  : mode === "cooldown"
                    ? "Prefers negative key motion (- / -- / ---) for landing transitions."
                    : "Balanced compatibility profile for smooth all-night flow."}
              </p>
            </div>

            {/* BPM tolerance */}
            <div>
              <label
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontFamily: "var(--font-label)",
                  fontSize: "var(--font-size-xs)",
                  letterSpacing: "var(--letter-spacing-label)",
                  color: "var(--color-text-muted)",
                  marginBottom: "var(--space-2)",
                }}
              >
                <span>BPM TOLERANCE</span>
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    color: "var(--color-text-primary)",
                  }}
                >
                  {bpmTolerance} BPM
                </span>
              </label>
              <input
                type="range"
                min={1}
                max={16}
                step={1}
                value={bpmTolerance}
                onChange={(e) => setBpmTolerance(Number(e.target.value))}
                style={{ width: "100%", accentColor: "var(--color-accent)" }}
              />
            </div>

            {/* Lock first track */}
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-2)",
                cursor: "pointer",
                fontFamily: "var(--font-body)",
                fontSize: "var(--font-size-sm)",
                color: "var(--color-text-secondary)",
              }}
            >
              <input
                type="checkbox"
                checked={lockFirst}
                onChange={(e) => setLockFirst(e.target.checked)}
                style={{ accentColor: "var(--color-accent)" }}
              />
              Lock first track
            </label>

            {/* Lock last track */}
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-2)",
                cursor: "pointer",
                fontFamily: "var(--font-body)",
                fontSize: "var(--font-size-sm)",
                color: "var(--color-text-secondary)",
              }}
            >
              <input
                type="checkbox"
                checked={lockLast}
                onChange={(e) => setLockLast(e.target.checked)}
                style={{ accentColor: "var(--color-accent)" }}
              />
              Lock last track
            </label>
          </div>

          {/* Right: Camelot Wheel */}
          <div style={{ flexShrink: 0 }}>
            <CamelotWheel highlightedKeys={highlightedKeys} size={220} />
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "var(--space-2)",
            paddingTop: "var(--space-2)",
            borderTop: "1px solid var(--color-border-subtle)",
          }}
        >
          <button
            type="button"
            onClick={onClose}
            className="btn btn-secondary"
            style={{ height: 32 }}
            disabled={isLoading}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className="btn btn-primary"
            style={{ height: 32 }}
            disabled={isLoading || highlightedKeys.length < 2}
          >
            {isLoading ? "Harmonizing…" : "Harmonize"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default HarmonizeModal;
