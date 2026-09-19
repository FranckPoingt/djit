# Product Requirements Document: DJ-IT — Music Library Organizer (MVP)

## 1. Executive Summary

**Objective:** Build a local-first desktop application that helps a DJ sort, tag, and curate a large unsorted music collection spread across old hard drives, then export ready-to-use playlists to a USB key for use on an Engine DJ OS machine.

**Core problem:** A collection of music files on old drives with inconsistent metadata and no organization. The user needs to triage, enrich, and structure that collection into playlists they can actually use at a gig.

**Target Users:**

1. Primary: The developer, for personal library triage and gig prep.
2. Secondary: Non-technical DJ friends — zero-configuration, double-click install, no CLI.

**North star:** Given an old hard drive full of unsorted music, the user can go from raw files to an organized, playlist-ready USB in one session.

---

## 2. Technical Architecture

A decoupled client-server model packaged into a single executable.

- **Frontend:** React, Tailwind CSS, TypeScript, Vite + tanstack start.
- **Backend / Analysis Engine:** Python 3.11+, FastAPI.
- **DSP:** Librosa (BPM), Essentia or `key_finder` (Camelot key detection).
- **Metadata:** `mutagen` for reading/writing embedded ID3/Vorbis tags.
- **Database:** SQLite (local, single-file).
- **Packaging:** PyInstaller. FastAPI serves the REST API and the compiled React build. Everything freezes into a single `.app` (macOS) or `.exe` (Windows).

---

## 3. Core Epics & Requirements

### Epic 1: Library Ingestion

Index local music files from drives and extract all available metadata.

- **REQ-1.1: Folder Import:** The React UI shall trigger a native OS folder-picker dialog (via FastAPI + `tkinter`). The backend shall recursively scan the selected folder for supported formats: MP3, FLAC, WAV, AAC, AIFF.
- **REQ-1.2: Embedded Metadata Extraction:** For each file, extract all existing embedded tags: title, artist, album, genre, year, BPM (if already tagged), and duration.
- **REQ-1.3: File Identity:** Record the absolute file path, drive/volume identifier, and a file hash (MD5 or SHA-1) to detect duplicates across imports.
- **REQ-1.4: Duplicate Detection:** Files with matching hashes shall be grouped as duplicates. The user shall see a deduplication view and choose which copy to keep or ignore.
- **REQ-1.5: Data Persistence:** All track metadata, file paths, and analysis results shall be stored in a local SQLite database. Tracks are never moved or renamed by the app unless the user explicitly requests it.
- **REQ-1.6: Incremental Scan:** Re-scanning a folder shall only process new or modified files. Already-analyzed files shall not be re-analyzed unless explicitly requested.
- **REQ-1.7: Analysis Queue:** Ingestion and analysis shall run in a background queue with per-track progress reported to the UI. The user must be able to cancel the queue at any time.

### Epic 2: Audio Analysis (Light, Reliable)

Extract the two technical fields that matter most for DJ mixing decisions.

- **REQ-2.1: BPM Detection:** The backend shall analyze each track and produce a BPM estimate (float, two decimal places). Tracks with low-confidence estimates shall be marked for manual attention.
- **REQ-2.2: Key Detection + Camelot Mapping:** The backend shall detect the musical key of each track and map it to Camelot Wheel notation (e.g., C Minor → 5A). The raw key and Camelot value shall both be stored and displayed.
- **REQ-2.3: Manual Override:** The user shall be able to manually correct BPM and Camelot/key values for any track. Manual corrections shall be persisted and survive re-analysis.
- **REQ-2.4: Analysis Status:** Each track shall carry an analysis status: `pending`, `analyzing`, `done`, `failed`, `overridden`. This is visible in the grid.

### Epic 3: Triage & Tagging UI

Give the user a fast, keyboard-friendly workflow for reviewing and enriching their library.

- **REQ-3.1: The Grid:** A sortable, filterable data table showing all tracks. Visible columns: title, artist, BPM, Camelot, genre, mood, energy, duration, drive, analysis status, and triage decision.
- **REQ-3.2: Sortable & Filterable Columns:** All columns shall support ascending/descending sort. Genre, mood, energy, Camelot, and triage decision shall support faceted filtering. BPM shall support range filtering (e.g., 120–130).
- **REQ-3.3: Saved Filters / Smart Views:** The user shall be able to save a filter configuration as a named view (e.g., "Unheard Techno 125-135"). Saved views are accessible from a sidebar.
- **REQ-3.4: Inline Editing:** The user shall be able to edit genre, mood, energy (scale 1–5), and triage decision directly in the grid row without opening a separate panel.
- **REQ-3.5: Bulk Tagging:** The user shall be able to select multiple tracks and apply a tag value (genre, mood, energy) to all selected at once.
- **REQ-3.6: Triage Decision:** Each track shall have a triage decision: `unheard` / `keep` / `maybe` / `reject` / `problem`. The default view on launch shows `unheard` tracks first.
- **REQ-3.7: Quick Audio Preview:** Clicking a track shall render a lightweight audio preview (waveform or simple scrubber). Audio is streamed from the backend to avoid browser filesystem restrictions. Full Wavesurfer.js waveform visualization is a post-MVP concern.

### Epic 4: Playlist / Crate Management

Organize kept tracks into named playlists for export.

- **REQ-4.1: Create Playlist:** The user shall be able to create a named playlist and add tracks to it from the grid via drag-and-drop or a context menu action.
- **REQ-4.2: Reorder Tracks:** Tracks within a playlist shall be manually reorderable.
- **REQ-4.3: Remove Tracks:** Individual tracks shall be removable from a playlist without deleting them from the library.
- **REQ-4.4: Playlist Summary:** Each playlist shall display its total track count, total duration, and BPM range in the sidebar.
- **REQ-4.5: Multiple Playlists:** The user may maintain any number of named playlists simultaneously.

### Epic 5.5: Track Relationship Graph

Visualize the music library as a force-directed graph so the user can explore harmonic and sonic relationships between tracks for set-building and crate exploration.

- **REQ-5.5.1: Graph Endpoint:** A `GET /api/v1/graph` endpoint shall return `{ nodes, edges }`. Query parameters control which edge types to include (`types`), BPM tolerance (`bpm_tol`, default 5%), and an optional filter of track IDs (`filter_ids`) to scope the graph to the current saved view.
- **REQ-5.5.2: Edge Types:** The backend shall compute six edge types — `key` (Camelot wheel adjacency: same, ±1 step, relative key), `bpm` (within `bpm_tol` percent), `genre` (matching non-null genre string), `energy` (within ±1 on the 1–5 scale), `mood` (exact match of non-null mood string), and `artist` (same non-null artist). Each edge carries a `type` and numeric `weight` (0–1 similarity).
- **REQ-5.5.3: Performance Cap:** For libraries exceeding 2 000 tracks, the endpoint shall process only the first 2 000 results (by id) and include a `truncated: true` flag in the response to alert the UI.
- **REQ-5.5.4: Graph Canvas:** The frontend shall render the graph on a WebGL canvas using Sigma.js + graphology with a ForceAtlas2 layout computed in a web worker. Nodes represent tracks; edges represent relationships.
- **REQ-5.5.5: Visual Controls:** The user shall be able to toggle each edge type on/off (with a distinct colour per type), choose node colour encoding (by genre / Camelot key / energy), choose node size encoding (by BPM / energy / uniform), and adjust BPM tolerance via a slider (re-fetches the graph).
- **REQ-5.5.6: Interactions:** Hovering a node shall show a tooltip (title, artist, BPM, key, energy). Clicking a node shall trigger audio preview via the existing `AudioPreview` component. Multi-selecting nodes shall open the bulk-action bar.
- **REQ-5.5.7: Scope Integration:** A "Scope to current view" toggle shall pass the active saved-view track IDs as `filter_ids`, restricting the graph to the currently filtered library subset.

### Epic 5: Engine DJ Desktop Export

Push curated playlists and track metadata into the user's local Engine DJ Desktop collection. The user then uses Engine DJ Desktop's native Sync Manager to export to USB — guaranteeing 100% hardware compatibility without relying on reverse-engineered schemas.

- **REQ-5.1: Export Trigger:** From any playlist view, the user shall be able to trigger "Export to Engine DJ Desktop."
- **REQ-5.2: Collection Path Detection:** The backend shall auto-detect the default Engine DJ Desktop collection path (`~/Music/Engine Library/Database2` on macOS, `%USERPROFILE%\Music\Engine Library\Database2` on Windows). The user shall be able to override this path manually if needed.
- **REQ-5.3: Track Registration:** The backend shall write each playlist track into the Engine Library `Track` table (title, artist, BPM, key, duration, genre, absolute file path) using the same SQLite schema Engine DJ Desktop itself writes. Existing tracks (matched by file path) shall be updated, not duplicated.
- **REQ-5.4: Playlist Registration:** The backend shall write each exported playlist as a `Playlist` and `PlaylistTrackList` entry in the Engine Library database. Playlists shall appear in Engine DJ Desktop on next launch without any manual import step.
- **REQ-5.5: Engine DJ Desktop Not Running:** The backend shall check that Engine DJ Desktop is not currently running before writing to the database, and warn the user if it is (to avoid write conflicts).
- **REQ-5.6: Post-Export Instruction:** After a successful export, the UI shall display a clear one-liner: "Open Engine DJ Desktop and use Sync Manager to export to your USB key."
- **REQ-5.7: Direct-to-USB Write (Phase 2):** Writing the Engine Library database directly to a USB key, bypassing Engine DJ Desktop entirely, is deferred until the desktop export path is validated end-to-end.

---

## 4. Explicit Out-of-Scope (MVP)

The following are valid future features but are explicitly excluded from this MVP to keep scope viable:

| Feature                                                       | Reason deferred                                                                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Direct-to-USB Engine Library write (bypass Engine DJ Desktop) | Relies on reverse-engineered schema; fragile against firmware updates. Engine DJ Desktop sync is the safe MVP path. |
| Rekordbox / Pioneer XML export                                | Requires cross-ecosystem compatibility testing                                                                      |
| Automatic genre/mood classification from audio                | Accuracy unreliable without custom training                                                                         |
| Waveform region visualization                                 | Post-MVP; lightweight scrubber sufficient                                                                           |
| Cloud sync or multi-user support                              | Out of scope for local-first tool                                                                                   |
| macOS app notarization / code signing                         | Required for distribution; not required for personal use                                                            |

---

## 5. Expected User Flow

1. **Launch:** Double-click the packaged app. FastAPI starts in the background and opens the browser to `localhost:8000`.
2. **Import:** Click "Add Folder." A native folder picker opens; the user selects a drive or folder. The app indexes files and queues analysis.
3. **Analyze:** BPM and Camelot key are extracted in the background. Progress is shown per-track. The user can start tagging before analysis finishes.
4. **Triage:** The grid opens to `unheard` tracks. The user sorts by BPM, filters by genre, bulk-tags batches, and marks tracks as `keep`, `maybe`, `reject`, or `problem`.
5. **Curate:** Keep tracks are dragged into named playlists (e.g., "Opening Set," "Peak Hour," "Warmup").
6. **Export:** The user clicks "Export to Engine DJ Desktop." The app writes playlists and track metadata directly into the local Engine Library database.
7. **Sync:** The user opens Engine DJ Desktop, which shows the imported playlists. They click Sync Manager and export to their USB key.
8. **Play:** The USB is inserted into the Engine DJ OS machine.

---

## 6. Open Questions / Risks

| #   | Question                                                                                                                                                                                                                                                       | Impact                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1   | ~~Does Engine DJ OS read m3u8 directly from USB?~~ **RESOLVED.** Hardware reads Engine Library SQLite only. Engine DJ Desktop also cannot import m3u. Chosen approach: write to the desktop Engine Library database and let Engine DJ Desktop handle USB sync. | Resolved — see Epic 5.                                                            |
| 2   | What is the p90 analysis time for a 500-track collection?                                                                                                                                                                                                      | Determines whether a progress/cancel UI is sufficient or async batching is needed |
| 3   | How does PyInstaller handle bundled audio codec deps on Windows?                                                                                                                                                                                               | Packaging risk; needs a spike before targeting Windows                            |
| 4   | Is key detection accurate enough on DJ-relevant genres without custom tuning?                                                                                                                                                                                  | May require swapping DSP library or adding confidence thresholds                  |
