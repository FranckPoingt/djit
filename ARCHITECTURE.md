# DJ-IT — Architecture Document

## 1. Overview

DJ-IT is a **local-first desktop application** packaged as a single executable. Internally it runs as a decoupled client-server pair: a FastAPI process handles all I/O, DSP, and database access, while a React SPA handles presentation. PyInstaller freezes both layers into one double-click bundle.

```
┌──────────────────────────────────────────────────────────────┐
│                        djit.app / djit.exe                   │
│                                                              │
│   [Browser: localhost:8000]                                  │
│          │                                                   │
│          ▼                                                   │
│   ┌─────────────┐   REST + SSE   ┌──────────────────────┐   │
│   │  React SPA  │◄──────────────►│  FastAPI (Python)    │   │
│   │  (static)   │                │  ├─ Routers           │   │
│   └─────────────┘                │  ├─ Services          │   │
│                                  │  ├─ Analysis Worker   │   │
│                                  │  └─ SQLite (djit.db)  │   │
│                                  └──────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

**Key constraints:**

- No internet access required at runtime.
- Files are never moved or renamed without explicit user action.
- The Engine DJ Desktop database is only written to when the user explicitly triggers an export, and only when Engine DJ Desktop is not running.

---

## 2. Monorepo Structure

```
djit/
├── apps/
│   ├── web/                        # React frontend (Vite + TanStack)
│   └── server/                     # Python FastAPI backend
├── packages/
│   └── api-client/                 # Auto-generated TypeScript API client (openapi-ts)
├── scripts/
│   ├── build.sh                    # Builds web → copies dist into server, then PyInstaller
│   └── dev.sh                      # Starts both apps in dev mode (concurrently)
├── .mise.toml                      # Canonical toolchain versions (Node, Python, uv, pnpm)
├── PRD.md
├── ARCHITECTURE.md
├── package.json                    # pnpm workspace root
├── pnpm-workspace.yaml
└── Taskfile.yml                    # Dev / build / lint task runner
```

### 2.1 `apps/web`

```
apps/web/
├── src/
│   ├── routes/                     # TanStack Router file-based routes
│   │   ├── __root.tsx
│   │   ├── index.tsx               # Library grid (default view)
│   │   ├── playlists/
│   │   │   ├── index.tsx           # Playlist list
│   │   │   └── $playlistId.tsx     # Single playlist view
│   │   └── duplicates.tsx          # Deduplication view
│   ├── components/
│   │   ├── grid/
│   │   │   ├── TrackGrid.tsx       # Sortable/filterable data table (TanStack Table)
│   │   │   ├── TrackRow.tsx        # Inline-editable row
│   │   │   ├── BulkTagBar.tsx      # Bulk-selection action bar
│   │   │   └── FilterPanel.tsx     # Faceted + range filters
│   │   ├── sidebar/
│   │   │   ├── PlaylistList.tsx    # Named playlists + smart views
│   │   │   └── SmartViews.tsx      # Saved filter configurations
│   │   ├── player/
│   │   │   └── AudioPreview.tsx    # Lightweight scrubber (streamed from backend)
│   │   ├── analysis/
│   │   │   └── QueueProgress.tsx   # Per-track progress + cancel button
│   │   └── export/
│   │       └── ExportModal.tsx     # Engine DJ export trigger + post-export instructions
│   ├── stores/
│   │   ├── libraryStore.ts         # Track list, filters, selection state
│   │   ├── playlistStore.ts        # Playlist CRUD + ordering
│   │   └── queueStore.ts           # Analysis queue state (fed by SSE)
│   ├── hooks/
│   │   ├── useAnalysisQueue.ts     # Subscribes to /events/analysis (SSE)
│   │   └── useTracks.ts            # Query + mutation wrappers
│   └── lib/
│       └── api.ts                  # Re-exports from packages/api-client
├── index.html
├── vite.config.ts
├── tsconfig.json
└── package.json
```

### 2.2 `apps/server`

```
apps/server/
├── djit/
│   ├── main.py                     # FastAPI app, mounts static build, opens browser on start
│   ├── database/
│   │   ├── models.py               # SQLAlchemy ORM models
│   │   ├── session.py              # DB session factory
│   │   └── migrations/             # Alembic migration scripts
│   ├── routers/
│   │   ├── library.py              # POST /library/import, GET /library/scan-status
│   │   ├── tracks.py               # GET/PATCH /tracks, GET /tracks/{id}
│   │   ├── analysis.py             # POST /analysis/queue, DELETE /analysis/queue
│   │   ├── audio.py                # GET /audio/{track_id}/stream  (StreamingResponse)
│   │   ├── playlists.py            # CRUD /playlists, POST /playlists/{id}/tracks
│   │   └── export.py               # POST /export/engine-dj
│   ├── services/
│   │   ├── scanner.py              # Recursive file scan, hash computation, incremental logic
│   │   ├── metadata.py             # mutagen read/write
│   │   ├── analyzer.py             # Librosa BPM + Essentia/key_finder key detection
│   │   ├── deduplicator.py         # Hash-based duplicate grouping
│   │   └── engine_export.py        # Writes to Engine DJ Desktop SQLite schema
│   ├── worker/
│   │   ├── queue.py                # asyncio-based background task queue
│   │   └── events.py               # SSE event broadcaster for queue progress
│   └── schemas/
│       ├── track.py                # Pydantic request/response models
│       ├── playlist.py
│       ├── analysis.py
│       └── export.py
├── pyproject.toml                  # uv / Poetry project config
└── djit.spec                       # PyInstaller spec file
```

### 2.3 `packages/api-client`

Generated automatically from the FastAPI OpenAPI schema via `openapi-ts` during the build step. Never edited by hand.

```
packages/api-client/
├── src/
│   └── (generated)
├── package.json
└── tsconfig.json
```

---

## 3. Data Model (SQLite — `djit.db`)

### `tracks`

| Column            | Type    | Notes                                                      |
| ----------------- | ------- | ---------------------------------------------------------- |
| `id`              | INTEGER | PK                                                         |
| `path`            | TEXT    | Absolute file path — unique                                |
| `drive_id`        | TEXT    | Volume/drive identifier                                    |
| `file_hash`       | TEXT    | MD5; used for duplicate detection                          |
| `title`           | TEXT    |                                                            |
| `artist`          | TEXT    |                                                            |
| `album`           | TEXT    |                                                            |
| `genre`           | TEXT    | User-editable                                              |
| `year`            | INTEGER |                                                            |
| `duration_sec`    | REAL    |                                                            |
| `bpm`             | REAL    | Two decimal places                                         |
| `bpm_confidence`  | REAL    | 0–1; below threshold requires attention                    |
| `key_raw`         | TEXT    | e.g. `"C minor"`                                           |
| `key_camelot`     | TEXT    | e.g. `"5A"`                                                |
| `mood`            | TEXT    | User-editable                                              |
| `energy`          | INTEGER | 1–5; user-editable                                         |
| `analysis_status` | TEXT    | `pending` / `analyzing` / `done` / `failed` / `overridden` |
| `triage_decision` | TEXT    | `unheard` / `keep` / `maybe` / `reject` / `problem`         |
| `manual_bpm`      | REAL    | Non-null when user has overridden BPM                      |
| `manual_camelot`  | TEXT    | Non-null when user has overridden key                      |
| `created_at`      | TEXT    | ISO-8601                                                   |
| `updated_at`      | TEXT    | ISO-8601                                                   |

### `playlists`

| Column       | Type    | Notes  |
| ------------ | ------- | ------ |
| `id`         | INTEGER | PK     |
| `name`       | TEXT    | Unique |
| `created_at` | TEXT    |        |
| `updated_at` | TEXT    |        |

### `playlist_tracks`

| Column        | Type    | Notes                             |
| ------------- | ------- | --------------------------------- |
| `id`          | INTEGER | PK                                |
| `playlist_id` | INTEGER | FK → playlists.id                 |
| `track_id`    | INTEGER | FK → tracks.id                    |
| `position`    | INTEGER | Manual sort order within playlist |

### `saved_views`

| Column        | Type    | Notes                              |
| ------------- | ------- | ---------------------------------- |
| `id`          | INTEGER | PK                                 |
| `name`        | TEXT    | e.g. `"Unheard Techno 125-135"` |
| `filter_json` | TEXT    | Serialized filter configuration    |

### `duplicate_groups`

| Column          | Type    | Notes                              |
| --------------- | ------- | ---------------------------------- |
| `id`            | INTEGER | PK                                 |
| `file_hash`     | TEXT    | Groups all tracks with same hash   |
| `kept_track_id` | INTEGER | FK → tracks.id; null if unresolved |

---

## 4. API Surface

All routes are prefixed `/api/v1`. The FastAPI instance also serves the compiled React build at `/`.

### Library

| Method | Path              | Description                                                   |
| ------ | ----------------- | ------------------------------------------------------------- |
| `POST` | `/library/import` | Opens native folder picker; begins scan + metadata extraction |
| `GET`  | `/library/status` | Returns current scan progress                                 |

### Tracks

| Method  | Path           | Description                                                                             |
| ------- | -------------- | --------------------------------------------------------------------------------------- |
| `GET`   | `/tracks`      | List all tracks; supports `?sort`, `?filter`, `?page`                                   |
| `GET`   | `/tracks/{id}` | Single track detail                                                                     |
| `PATCH` | `/tracks/{id}` | Update editable fields (genre, mood, energy, triage_decision, manual_bpm, manual_camelot) |
| `PATCH` | `/tracks/bulk` | Bulk update selected track IDs                                                          |

### Audio

| Method | Path                 | Description                                                   |
| ------ | -------------------- | ------------------------------------------------------------- |
| `GET`  | `/audio/{id}/stream` | Streams the audio file; supports `Range` header for scrubbing |

### Analysis

| Method   | Path               | Description                                                       |
| -------- | ------------------ | ----------------------------------------------------------------- |
| `POST`   | `/analysis/queue`  | Enqueues tracks for BPM + key analysis                            |
| `DELETE` | `/analysis/queue`  | Cancels the running queue                                         |
| `GET`    | `/events/analysis` | SSE stream — emits `{ track_id, status, bpm, camelot }` per event |

### Playlists

| Method   | Path                                | Description                                         |
| -------- | ----------------------------------- | --------------------------------------------------- |
| `GET`    | `/playlists`                        | All playlists with track count + duration summary   |
| `POST`   | `/playlists`                        | Create playlist                                     |
| `GET`    | `/playlists/{id}`                   | Playlist detail with ordered track list             |
| `DELETE` | `/playlists/{id}`                   | Delete playlist                                     |
| `POST`   | `/playlists/{id}/tracks`            | Add tracks to playlist                              |
| `DELETE` | `/playlists/{id}/tracks/{track_id}` | Remove track from playlist                          |
| `PUT`    | `/playlists/{id}/order`             | Reorder tracks (accepts ordered array of track IDs) |

### Export

| Method | Path                            | Description                                                  |
| ------ | ------------------------------- | ------------------------------------------------------------ |
| `GET`  | `/export/engine-dj/detect-path` | Returns detected Engine Library path; confirms DB not locked |
| `POST` | `/export/engine-dj`             | Writes tracks + playlist to Engine Library SQLite            |

### Saved Views

| Method   | Path          | Description                       |
| -------- | ------------- | --------------------------------- |
| `GET`    | `/views`      | All saved filter views            |
| `POST`   | `/views`      | Save current filter as named view |
| `DELETE` | `/views/{id}` | Delete saved view                 |

---

## 5. Background Worker & Real-Time Progress

Analysis runs in a persistent `asyncio` background worker. The queue is a Python `asyncio.Queue`. The `analyzer.py` service calls librosa and Essentia/key_finder in a thread pool (`loop.run_in_executor`) to avoid blocking the event loop.

Progress is pushed to the frontend via **Server-Sent Events** (`/events/analysis`). Each SSE message carries:

```json
{
  "track_id": 42,
  "status": "done",
  "bpm": 128.0,
  "bpm_confidence": 0.91,
  "key_raw": "C minor",
  "key_camelot": "5A"
}
```

The frontend `queueStore` consumes these events and updates the grid rows in real time. No polling needed.

---

## 6. Packaging (PyInstaller)

The build pipeline in `scripts/build.sh` runs in order:

1. `pnpm --filter web build` — Vite compiles the React app to `apps/web/dist/`.
2. `cp -r apps/web/dist apps/server/djit/static/` — The compiled frontend is embedded into the Python package as a static directory.
3. FastAPI serves it at startup: `app.mount("/", StaticFiles(directory="static", html=True))`.
4. `pyinstaller apps/server/djit.spec` — Bundles the entire Python environment, all dependencies (librosa, numpy, essentia, mutagen, etc.), and the embedded React build into a single binary.
5. On launch, `main.py` starts the FastAPI server and calls `webbrowser.open("http://localhost:8000")`.

**PyInstaller hidden imports to declare in `djit.spec`:**

- `librosa`, `soundfile`, `resampy`, `numba`
- `essentia` (or `keyfinder` binding)
- `mutagen`
- `tkinter` (for the native folder picker)
- `alembic`

---

## 7. Engine DJ Desktop Export

Engine DJ Desktop uses a standard SQLite file at:

- **macOS:** `~/Music/Engine Library/Database2/m.db`
- **Windows:** `%USERPROFILE%\Music\Engine Library\Database2\m.db`

The `engine_export.py` service:

1. Checks the process list for a running Engine DJ Desktop instance; aborts with a user-facing error if found.
2. Opens the Engine Library `m.db` with SQLAlchemy (read-write).
3. Upserts each track into the Engine Library `Track` table (match on file path).
4. Creates or updates the `Playlist` and `PlaylistTrackList` entries.
5. Closes the connection cleanly.

The UI then displays: _"Open Engine DJ Desktop and use Sync Manager to export to your USB key."_

---

## 8. Frontend State Architecture

| Store           | Responsibility                                              |
| --------------- | ----------------------------------------------------------- |
| `libraryStore`  | Full track list, active filters, column sort, row selection |
| `playlistStore` | Playlist list, active playlist, drag-and-drop order         |
| `queueStore`    | Analysis queue length, per-track status (fed by SSE)        |

State management: **Zustand** (lightweight, no boilerplate, compatible with TanStack Query).
Server state (fetching/caching/mutations): **TanStack Query**.

---

## 9. Development Setup

### Prerequisites

Install [mise](https://mise.jdx.dev/) once, then let it manage everything else:

```sh
# Install mise (macOS)
curl https://mise.run | sh

# From the repo root — installs Node 24, Python 3.11, uv, pnpm 9
mise install
```

mise reads `.mise.toml` and auto-activates the correct runtime versions whenever you `cd` into the project. No manual `nvm use` or `pyenv local` needed.

**`.mise.toml`:**

```toml
[tools]
node = "24"
python = "3.11"
uv = "latest"
pnpm = "9"
```

### Commands (via Taskfile)

```sh
task install       # pnpm install + uv sync
task dev           # Starts FastAPI (uvicorn --reload) + Vite dev server concurrently
task build         # Full production build + PyInstaller bundle
task codegen       # Regenerates packages/api-client from live OpenAPI schema
task lint          # ESLint + Ruff
task test          # pytest + vitest
```

### Dev proxy

In dev mode, Vite proxies `/api` to `http://localhost:8001` (FastAPI on a separate port), so the React dev server hot-reload and the Python server run independently without the static file mount.

---

## 10. Key Dependency Versions (Pinned)

| Package                  | Version   | Rationale                                         |
| ------------------------ | --------- | ------------------------------------------------- |
| `librosa`                | 0.10.x    | BPM via onset strength                            |
| `essentia`               | 2.1-beta6 | Key detection (TensorFlow-based models available) |
| `mutagen`                | 1.47.x    | Read/write ID3, FLAC, AAC, AIFF tags              |
| `fastapi`                | 0.111.x   | Async router, SSE support via `sse-starlette`     |
| `sqlalchemy`             | 2.0.x     | ORM + raw SQL for Engine DJ export                |
| `alembic`                | 1.13.x    | Schema migrations                                 |
| `pyinstaller`            | 6.x       | Single-binary packaging                           |
| `react`                  | 19.x      |                                                   |
| `@tanstack/react-router` | 1.x       | File-based routing                                |
| `@tanstack/react-query`  | 5.x       | Server state                                      |
| `@tanstack/react-table`  | 8.x       | The track grid                                    |
| `zustand`                | 5.x       | Client state                                      |
| `tailwindcss`            | 4.x       |                                                   |
