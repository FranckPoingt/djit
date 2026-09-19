# Graph-Based Playlist Builder Implementation

## Overview

Enhanced the Djit graph visualization to make it actionable for playlist creation. Users can now directly order tracks and discover smooth progressions using graph-based algorithms.

## Backend Services

### 1. **Union-Find: Connected Component Detection**

- Discovers natural playlist clusters automatically
- Useful for suggesting "similar mood" playlists
- Endpoint: `POST /graph/components` → returns list of track ID clusters

**Example:**

```
GET /graph/components → {
  "components": [
    [1, 2, 3, 5],      // High-energy dance tracks (connected by BPM + key)
    [4, 6, 7, 9]       // Slower deep house (separate cluster)
  ],
  "truncated": false
}
```

### 2. **Greedy Nearest-Neighbor Ordering**

- Orders a set of track IDs into a smooth DJ mix
- Weights three criteria: key harmonics, BPM continuity, energy flow
- Configurable weights let users prioritize what matters (harmonious vs. energetic progression)
- Endpoint: `POST /graph/order`

**Example:**

```
POST /graph/order {
  "track_ids": [5, 1, 12, 3, 7],
  "key_weight": 0.5,
  "bpm_weight": 0.3,
  "energy_weight": 0.2
}
→ {
    "ordered_track_ids": [1, 5, 3, 12, 7]  // Smooth flow maintained
  }
```

### 3. **Dijkstra Path Finder**

- Finds the optimal progression between two anchor tracks
- Useful for: "Build a mix from Lo-Fi to High-Energy" progressions
- Considers same weighted edges as ordering
- Endpoint: `POST /graph/path`

**Example:**

```
POST /graph/path {
  "start_id": 42,        // Slow lofi track
  "end_id": 89,          // High-energy house
  "key_weight": 0.3,     // Relax key matching
  "bpm_weight": 0.7      // Enforce smooth BPM progression
}
→ {
    "path": [42, 15, 23, 67, 89],
    "found": true
  }
```

## Frontend Components

### Graph Selection Panel (Right Sidebar)

New controls added to the graph visualization:

**💫 SMART ORDER**

- Orders selected graph nodes using greedy algorithm
- Updates selection with ordered result
- Perfect for "I picked 10 random good tracks, now arrange them"

**🛤️ FIND PATH**

- Toggle to find smooth progression between two tracks
- User selects starting track, then enters target track ID
- Returns optimized path (intermediate tracks filled in)

**Weight Customization**

- Sliders for key_weight, bpm_weight, energy_weight
- Adjusts ordering/path algorithms in real-time

## React Hooks

Three new mutations in `usePlaylists.ts`:

```typescript
// Order a selection of tracks
const { mutateAsync: orderTracks } = useOrderPlaylist();
const result = await orderTracks({
  track_ids: [1, 5, 3],
  key_weight: 0.5,
  bpm_weight: 0.3,
  energy_weight: 0.2,
});

// Find path between two tracks
const { mutateAsync: findPath } = useFindPlaylistPath();
const result = await findPath({
  start_id: 10,
  end_id: 50,
});

// Detect natural clusters
const { mutateAsync: getComponents } = useGetPlaylistComponents();
const result = await getComponents();
```

## Use Cases

### 1. **One-Click Playlist Creation from Graph**

1. Click/Shift+click nodes in graph to select ~10 tracks
2. Hit "💫 SMART ORDER"
3. Click "CREATE PLAYLIST"
4. Done—smooth progression generated automatically

### 2. **Progressive Mix Building**

1. Select a slow track (e.g., lofi)
2. Want to end with high-energy house
3. Click "🛤️ FIND PATH"
4. Enter high-energy track ID
5. System fills in smooth intermediate tracks
6. Add to playlist

### 3. **Automatic Genre Playlists**

1. Run `/graph/components`
2. UI groups results by energy/key clusters
3. Suggest: "Create playlist from cluster 1" buttons
4. Each cluster auto-ordered by graph algorithm

### 4. **Weight-Based Exploration**

- High **key_weight**: Pure harmonic flow (same key preferred)
- High **bpm_weight**: Tempo-driven progression (energy levels consistent)
- High **energy_weight**: Smooth energy curve (no jarring jumps)

## Test Coverage

**20 new unit tests** in `tests/test_playlist_builder.py`:

- Component detection (empty, single, connected, disconnected graphs)
- Greedy ordering (empty lists, single node, edge preferences, custom start)
- Path finding (direct edges, multi-hop routes, disconnected cases, reverse direction)
- Weight preferences (key emphasis vs BPM emphasis)
- Full integration workflow (detect components → order → create playlists)

**All 101 backend tests pass** (35 graph_builder + 13 harmonize + 20 new + 33 other)

## Algorithm Complexity

- **Component detection**: O(n + e) using Union-Find
- **Greedy ordering**: O(n²) worst case, O(n log n) with edge caching
- **Path finding**: O((n + e) log n) Dijkstra with binary heap
- **All practical** for libraries up to 10k tracks

## Files Modified/Created

```
Backend:
  djit/services/playlist_builder.py       [NEW] 350 LOC service
  djit/routers/graph.py                   [+150] Three new endpoints
  tests/test_playlist_builder.py          [NEW] 20 test cases

Frontend:
  src/hooks/usePlaylists.ts               [+80] Three new hooks
  src/routes/graph.tsx                    [+120] UI controls + state management

No schema changes needed (reusing existing GraphNode/GraphEdge)
```

## Next Steps (Optional Enhancements)

1. **Audio preview** from graph (play path as you hover)
2. **Cluster labeling** (detect genre/mood from nodes and label components)
3. **Export as .m3u** directly from graph selection
4. **Collaborative playlists** (share graph selections with friends)
5. **Weighted edge visualization** (thicker lines = better matches)
