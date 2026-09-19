# Performance Overhaul Plan

## Problem Summary

| Symptom | Root Cause |
|---|---|
| Library scan takes forever | Sequential file hashing (reads entire files), sequential DB queries per file, 16 separate glob traversals |
| Same song imported twice | `file_hash` nullable — if first import crashes before hashing, second import creates a duplicate; no race guard on nearly-simultaneous requests |
| Cover then waveform load slowly | Both computed on-demand per-request; `librosa.load` decodes entire audio file for waveform; no persistent cache |
| Every action blocks UI | Waveform and cover extraction run synchronously in FastAPI event loop, blocking all other requests |

---

## Phase 1: Quick Wins (Low Risk, High Impact)

### 1.1 Parallelize File Discovery

**Problem:** `discover_audio_files` runs 16 separate `glob` traversals (8 extensions × 2 cases), each walking the entire tree.

**Fix:** Single `os.walk` with extension check.

```python
# scanner.py — replace glob loop with single walk
def discover_audio_files(root: Path) -> list[Path]:
    return [
        p for p in root.rglob("*")
        if p.suffix.lower() in SUPPORTED_EXTENSIONS
    ]
```

### 1.2 Fast Duplicate Detection (Fix Double Import)

**Problem:** Full SHA256 hash of every file just for dedup. If hash computation is interrupted, `file_hash=None` and the next import creates a duplicate.

**Fix:** Two-pass approach:
- **Pass 1 (fast):** Check by path first. If path exists, compare `file_mtime` + `file_size` (stored as new columns). If both match → skip. If changed → update.
- **Pass 2 (hash only when needed):** Only compute SHA256 for files not found by path. Use it to detect copies at different paths.
- **Backfill:** Add a migration to compute hashes for existing tracks where `file_hash IS NULL`.

New columns on `Track`:
```python
file_size: Mapped[int | None]
file_mtime: Mapped[float | None]  # st_mtime
```

### 1.3 Batch Database Queries

**Problem:** Two DB queries per file (path check + hash check). For 10,000 files = 20,000 queries.

**Fix:** Collect all paths first, do a single `SELECT * FROM tracks WHERE path IN (...)` query, build a dict in memory. Same for hashes. Then iterate files doing dict lookups.

```python
# Single query for all paths
all_paths = [str(p) for p in audio_files]
existing_by_path = {
    t.path: t
    for t in db.query(Track).filter(Track.path.in_(all_paths)).all()
}
```

### 1.4 Offload Waveform & Cover to Thread Pool

**Problem:** `_compute_waveform_cached` and `_extract_cover_art` run in the main event loop, blocking all other requests.

**Fix:** Wrap both in `asyncio.to_thread()`:

```python
@router.get("/audio/{track_id}/waveform")
async def waveform(track_id: int, points: int = 64, db: Session = Depends(get_db)):
    # ... validation ...
    values = await asyncio.to_thread(
        _compute_waveform_cached, str(track_path), points, int(stat.st_mtime_ns), int(stat.st_size)
    )
```

Same for cover art endpoint.

### 1.5 Standardize Waveform Points

**Problem:** `@lru_cache` keys include `points`. The grid requests 24, the hook requests 48, the default is 64. Each unique value = separate full decode.

**Fix:** Server always computes 64 points. Client downsamples if it needs fewer (trivial array operation). One decode per track forever.

---

## Phase 2: Precomputation & Caching

### 2.1 Precompute Waveforms During Import/Analysis

**Problem:** Waveforms are computed on-demand, causing slow first-load for every track.

**Fix:** Add waveform computation to the analysis pipeline. Store results in a `waveforms` table:

```python
class Waveform(Base):
    __tablename__ = "waveforms"
    track_id: Mapped[int]  # FK → tracks.id
    data: Mapped[str]  # JSON array of floats
    points: Mapped[int]  # resolution (always 64)
    file_mtime: Mapped[float]  # for cache invalidation
```

The analysis worker already processes each track — add waveform generation there. The `/audio/{id}/waveform` endpoint becomes a simple DB lookup.

### 2.2 Pre-extract Cover Art During Import

**Problem:** Cover art is extracted from the audio file on every request.

**Fix:** During import, extract cover art once and write to a local cache directory:
```
.cache/covers/{track_id}.jpg
```

The `/audio/{id}/cover` endpoint serves the cached file. If missing, extract on-demand and cache it. Add a `cover_cached: Mapped[bool]` column to Track.

### 2.3 Persistent Waveform Cache on Disk

**Alternative to 2.1** (if you don't want a DB table): Store waveforms as JSON files:
```
.cache/waveforms/{track_id}_{mtime}.json
```

The `@lru_cache` decorator wraps a function that reads from this file cache. This survives server restarts.

---

## Phase 3: Server-Side Pagination & Streaming

### 3.1 Paginated Track Endpoint

**Problem:** `GET /tracks` returns ALL tracks in one JSON response. For 5,000 tracks this is a large payload that blocks rendering.

**Fix:** Add `?offset=0&limit=100` support. Return `{ items: [...], total: 5000 }`.

### 3.2 Infinite Scroll on Client

**Problem:** The virtualized table already handles large lists well, but it waits for ALL tracks to load before rendering anything.

**Fix:** Fetch first page immediately, render it, then fetch subsequent pages in the background. The virtualizer already supports dynamic data.

---

## Phase 4: True Concurrency (If Still Needed)

### 4.1 Parallel Library Scan with ThreadPoolExecutor

If Phase 1-3 aren't enough for your library size:

```python
from concurrent.futures import ThreadPoolExecutor, as_completed

def run_scan_import(folder_path: str, db: Session, tracker: ScanProgressTracker):
    audio_files = scan_folder(path)
    
    # Phase 1: Fast path/hash lookups (single thread, DB bound)
    existing_by_path = bulk_load_existing_paths(db, audio_files)
    existing_by_hash = bulk_load_existing_hashes(db, audio_files)
    
    # Phase 2: Parallel metadata extraction + hashing
    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = {
            executor.submit(process_file, fp, existing_by_path, existing_by_hash): fp
            for fp in audio_files
        }
        for future in as_completed(futures):
            result = future.result()
            # collect results, batch insert
            tracker.mark_processed()
    
    # Phase 3: Batch commit
    db.bulk_save_objects(new_tracks)
    db.commit()
```

Key insight: metadata extraction and file hashing are I/O bound, not CPU bound. `ThreadPoolExecutor` is the right choice (not `ProcessPoolExecutor`).

### 4.2 Analysis Worker Already Concurrent

The analysis system already uses `ProcessPoolExecutor` with 4 workers and a semaphore. This is fine. The bottleneck is the scan phase, not analysis.

---

## Recommended Implementation Order

| # | Task | Effort | Impact | Risk |
|---|---|---|---|---|
| 1 | Offload waveform/cover to thread pool (1.4) | 30 min | High | Low |
| 2 | Fast duplicate detection + mtime/size columns (1.2) | 2 hours | High | Low |
| 3 | Batch DB queries (1.3) | 1 hour | High | Low |
| 4 | Single-pass file discovery (1.1) | 15 min | Medium | Low |
| 5 | Standardize waveform points to 64 (1.5) | 30 min | Medium | Low |
| 6 | Precompute waveforms in analysis (2.1) | 3 hours | High | Medium |
| 7 | Pre-extract cover art during import (2.2) | 2 hours | High | Medium |
| 8 | Paginated track endpoint (3.1) | 2 hours | Medium | Medium |
| 9 | Infinite scroll client (3.2) | 2 hours | Medium | Medium |
| 10 | Parallel scan with ThreadPoolExecutor (4.1) | 4 hours | Medium | High |

**Total for Phases 1-2 (recommended): ~10 hours**
**Total for everything: ~18 hours**

---

## Architecture After Changes

```
┌─────────────────────────────────────────────────────────────┐
│  Import Flow (Parallel)                                      │
│                                                              │
│  os.walk (single pass)                                       │
│       ↓                                                      │
│  ThreadPoolExecutor (8 workers)                              │
│  ├── hash (first 64KB only for dedup)                        │
│  ├── extract metadata                                        │
│  └── extract cover → .cache/covers/{id}.jpg                  │
│       ↓                                                      │
│  Batch DB insert (single commit)                             │
│       ↓                                                      │
│  Enqueue analysis                                            │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Analysis Flow (Already concurrent)                          │
│                                                              │
│  asyncio.Queue → 4 ProcessPoolExecutor workers               │
│  ├── BPM/key detection                                       │
│  ├── Mood/energy analysis                                    │
│  └── Waveform computation → waveforms table                  │
│       ↓                                                      │
│  SSE broadcast → client updates in real-time                 │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Client Rendering                                            │
│                                                              │
│  GET /tracks?offset=0&limit=100  → render immediately        │
│  GET /tracks?offset=100&limit=100 → background fetch         │
│                                                              │
│  Cover: <img src="/audio/{id}/cover"> → served from cache    │
│  Waveform: GET /audio/{id}/waveform → DB lookup (precomputed)│
│                                                              │
│  Virtualized table renders visible rows only                 │
└─────────────────────────────────────────────────────────────┘
```
