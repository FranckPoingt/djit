import { Link, Outlet, createRootRoute } from "@tanstack/react-router";

import { QueueProgress } from "../components/analysis/QueueProgress";
import { FilterPanel } from "../components/grid/FilterPanel";
import { AudioPreview } from "../components/player/AudioPreview";
import { PlaylistList } from "../components/sidebar/PlaylistList";
import { useAnalysisQueue } from "../hooks/useAnalysisQueue";
import { useBackgroundAnalysis } from "../hooks/useBackgroundAnalysis";

const RootLayout = () => {
  useAnalysisQueue();
  useBackgroundAnalysis();

  return (
    <div className="djit-layout">
      <div className="djit-body">
        <aside
          className="djit-sidebar"
          style={{
            display: "flex",
            flexDirection: "column",
            padding: "40px 20px 28px",
          }}
        >
          {/* Logo */}
          <span
            className="djit-logo"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--font-size-lg)",
              fontWeight: 700,
              letterSpacing: "-0.02em",
            }}
          >
            DJIT
          </span>

          {/* Nav gap */}
          <div style={{ height: 32 }} />

          {/* Nav */}
          <nav style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <Link
              to="/"
              activeOptions={{ exact: true }}
              inactiveProps={{ className: "nav-item" }}
              activeProps={{ className: "nav-item active" }}
            >
              Library
            </Link>
            <Link
              to="/review"
              inactiveProps={{ className: "nav-item" }}
              activeProps={{ className: "nav-item active" }}
            >
              Review
            </Link>
            <Link
              to="/playlists"
              inactiveProps={{ className: "nav-item" }}
              activeProps={{ className: "nav-item active" }}
            >
              Playlists
            </Link>
            <Link
              to="/graph"
              inactiveProps={{ className: "nav-item" }}
              activeProps={{ className: "nav-item active" }}
            >
              Mix
            </Link>
            <Link
              to="/organize"
              inactiveProps={{ className: "nav-item" }}
              activeProps={{ className: "nav-item active" }}
            >
              Organize
            </Link>
          </nav>

          {/* Connected music sources */}
          <FilterPanel />

          {/* Spacer */}
          <div style={{ flex: 1 }} />

          {/* Playlists */}
          <PlaylistList />

        </aside>

        <main className="djit-main">
          <Outlet />
          <QueueProgress />
        </main>
      </div>

      {/* Player bar */}
      <AudioPreview />
    </div>
  );
};

export const rootRoute = createRootRoute({
  component: RootLayout,
});
