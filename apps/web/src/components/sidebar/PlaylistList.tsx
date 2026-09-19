import { Link } from "@tanstack/react-router";

import { usePlaylists } from "../../hooks/usePlaylists";

const SECTION_LABEL: React.CSSProperties = {
  fontFamily: "var(--font-label)",
  fontSize: "var(--font-size-xs)",
  fontWeight: 700,
  letterSpacing: "var(--letter-spacing-caps)",
  color: "var(--color-text-faint)",
  marginBottom: "var(--space-2)",
};

export const PlaylistList = () => {
  const { data: playlists = [], isLoading } = usePlaylists();

  return (
    <div style={{ marginBottom: "var(--space-5)" }}>
      <p style={SECTION_LABEL}>PLAYLISTS</p>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-1)",
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

        {playlists.map((playlist) => (
          <Link
            key={playlist.id}
            to="/playlists/$playlistId"
            params={{ playlistId: String(playlist.id) }}
            inactiveProps={{ className: "nav-item" }}
            activeProps={{ className: "nav-item active" }}
          >
            <span
              style={{
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {playlist.name}
            </span>
            <span
              style={{
                fontSize: "var(--font-size-xs)",
                color: "var(--color-text-faint)",
                flexShrink: 0,
                marginLeft: "auto",
              }}
            >
              {playlist.track_count}
            </span>
          </Link>
        ))}
      </div>

      <Link
        to="/playlists"
        className="btn btn-primary"
        style={{
          display: "flex",
          justifyContent: "center",
          width: "100%",
          marginTop: "var(--space-2)",
          textDecoration: "none",
        }}
      >
        + NEW PLAYLIST
      </Link>
    </div>
  );
};
