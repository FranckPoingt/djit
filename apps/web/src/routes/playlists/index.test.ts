import type { TrackSummary } from "api-client";
import { expect, it } from "vitest";

import { selectPlaylistTracks } from "./index";

const track = (overrides: Partial<TrackSummary>): TrackSummary => ({
  id: overrides.id ?? 1,
  title: overrides.title ?? "Track",
  artist: overrides.artist ?? "Artist",
  genre: overrides.genre ?? "House",
  mood: overrides.mood ?? null,
  energy: overrides.energy ?? 5,
  duration_seconds: overrides.duration_seconds ?? 300,
  bpm: overrides.bpm ?? 124,
  bpm_confidence: overrides.bpm_confidence ?? 0.9,
  key_camelot: overrides.key_camelot ?? "8A",
  analysis_status: overrides.analysis_status ?? "done",
  triage_decision: overrides.triage_decision ?? "keep",
  playlist_memberships: overrides.playlist_memberships ?? [],
});

it("anchors the seed, combines selected genres, and prefers the requested energy", () => {
  const result = selectPlaylistTracks(
    [
      track({ id: 1, genre: "Disco", energy: 3 }),
      track({ id: 2, genre: "House", energy: 4 }),
      track({ id: 3, genre: "House", energy: 9 }),
      track({ id: 4, genre: "Techno", energy: 9 }),
    ],
    {
      occasion: "party",
      genres: ["House", "Techno"],
      audience: "Dancefloor",
      vibe: "peak-time",
      seedId: 1,
    },
  );

  expect(result.map(({ id }) => id)).toEqual([1, 3, 4, 2]);
});
