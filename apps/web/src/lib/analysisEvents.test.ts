import type { TrackSummary } from "api-client";
import { describe, expect, it } from "vitest";

import {
  applyAnalysisEventToTracks,
  parseAnalysisQueueEvent,
} from "./analysisEvents";

const makeTrack = (id: number): TrackSummary => ({
  id,
  title: `Track ${id}`,
  artist: "Artist",
  bpm: null,
  key_camelot: null,
  analysis_status: "pending",
  triage_decision: "unheard",
});

describe("parseAnalysisQueueEvent", () => {
  it("returns null for invalid payloads", () => {
    expect(parseAnalysisQueueEvent(null)).toBeNull();
    expect(parseAnalysisQueueEvent({})).toBeNull();
    expect(
      parseAnalysisQueueEvent({ track_id: "1", status: "done" }),
    ).toBeNull();
  });

  it("normalizes valid payload", () => {
    expect(
      parseAnalysisQueueEvent({
        track_id: 2,
        status: "done",
        bpm: 127.5,
        key_camelot: "8A",
      }),
    ).toEqual({
      track_id: 2,
      status: "done",
      bpm: 127.5,
      bpm_confidence: null,
      key_camelot: "8A",
      mood: null,
      energy: null,
    });
  });
});

describe("applyAnalysisEventToTracks", () => {
  it("updates matching row", () => {
    const tracks = [makeTrack(1), makeTrack(2)];
    const updated = applyAnalysisEventToTracks(tracks, {
      track_id: 2,
      status: "done",
      bpm: 128,
      key_camelot: "5A",
      mood: "Driving",
      energy: 8,
    });

    expect(updated?.[0]).toEqual(tracks[0]);
    expect(updated?.[1].analysis_status).toBe("done");
    expect(updated?.[1].bpm).toBe(128);
    expect(updated?.[1].key_camelot).toBe("5A");
    expect(updated?.[1].mood).toBe("Driving");
    expect(updated?.[1].energy).toBe(8);
  });

  it("returns original array if track does not exist", () => {
    const tracks = [makeTrack(1)];
    const updated = applyAnalysisEventToTracks(tracks, {
      track_id: 99,
      status: "done",
    });

    expect(updated).toBe(tracks);
  });
});
