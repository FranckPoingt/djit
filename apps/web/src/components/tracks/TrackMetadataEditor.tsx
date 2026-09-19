import { useState } from "react";
import type { TrackSummary } from "api-client";

export type TrackMetadataPatch = {
  artist: string;
  title: string;
  genre: string;
};

const NUMBER_PREFIX = /^\s*(?:\(?\d{1,3}\)?[\s._-]+)+/;
const tidyText = (value: string) => value.trim().replace(/\s+/g, " ");
const titleCaseIfUniform = (value: string) =>
  value === value.toUpperCase() || value === value.toLowerCase()
    ? value.toLowerCase().replace(/\b\p{L}/gu, (letter) => letter.toUpperCase())
    : value;

export const TrackMetadataEditor = ({
  track,
  isSaving,
  onClose,
  onSave,
}: {
  track: TrackSummary;
  isSaving: boolean;
  onClose: () => void;
  onSave: (payload: TrackMetadataPatch) => void;
}) => {
  const [artist, setArtist] = useState(track.artist);
  const [title, setTitle] = useState(track.title);
  const [genre, setGenre] = useState(track.genre ?? "");

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="track-metadata-title"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "grid",
        placeItems: "center",
        background: "rgba(0,0,0,0.65)",
        backdropFilter: "blur(4px)",
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        style={{
          width: 480,
          maxWidth: "calc(100vw - 32px)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-4)",
          padding: "var(--space-6)",
          border: "1px solid var(--color-border)",
          background: "var(--color-bg-sidebar)",
        }}
        onSubmit={(event) => {
          event.preventDefault();
          onSave({
            artist: tidyText(artist),
            title: tidyText(title),
            genre: tidyText(genre),
          });
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--space-3)" }}>
          <div>
            <span className="review-eyebrow">CLEAN UP TRACK</span>
            <h2 id="track-metadata-title" style={{ margin: "var(--space-1) 0 0", fontFamily: "var(--font-mono)" }}>
              {track.title}
            </h2>
          </div>
          <button type="button" className="btn btn-ghost" aria-label="Close metadata editor" onClick={onClose}>
            ×
          </button>
        </div>

        {([
          ["ARTIST", artist, setArtist],
          ["TITLE", title, setTitle],
          ["GENRE", genre, setGenre],
        ] as const).map(([label, value, setter]) => (
          <label key={label} className="review-checkbox-row" style={{ alignItems: "stretch" }}>
            <span>{label}</span>
            <input value={value} required={label !== "GENRE"} onChange={(event) => setter(event.target.value)} />
          </label>
        ))}

        <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              setArtist(tidyText(artist));
              setTitle(tidyText(title));
              setGenre(tidyText(genre));
            }}
          >
            TIDY SPACES
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setTitle(title.replace(NUMBER_PREFIX, ""))}>
            REMOVE NUMBER
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setTitle(titleCaseIfUniform(title))}>
            FIX CASING
          </button>
          {title.includes(" - ") ? (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                const [nextArtist, nextTitle] = title.split(" - ", 2);
                if (nextArtist && nextTitle) {
                  setArtist(tidyText(nextArtist));
                  setTitle(tidyText(nextTitle));
                }
              }}
            >
              SPLIT ARTIST — TITLE
            </button>
          ) : null}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-2)" }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>CANCEL</button>
          <button type="submit" className="btn btn-primary" disabled={isSaving}>
            {isSaving ? "SAVING…" : "SAVE METADATA"}
          </button>
        </div>
      </form>
    </div>
  );
};
