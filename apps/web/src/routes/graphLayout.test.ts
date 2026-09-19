import type { GraphNode } from "api-client";
import { describe, expect, it } from "vitest";
import {
  buildCamelotLayout,
  DEFAULT_ACTIVE_EDGE_TYPES,
  getHarmonicCompanionKeys,
  getTrackCompatibility,
  isWithinBpmTolerance,
  parseCamelot,
  rankMixCandidates,
} from "./graphLayout";

function makeNode(overrides: Partial<GraphNode>): GraphNode {
  return {
    id: overrides.id ?? 1,
    title: overrides.title ?? "Track",
    artist: overrides.artist ?? "Artist",
    bpm: overrides.bpm ?? 124,
    key_camelot:
      "key_camelot" in overrides ? (overrides.key_camelot ?? null) : "4A",
    genre: "genre" in overrides ? (overrides.genre ?? null) : null,
    energy: "energy" in overrides ? (overrides.energy ?? null) : null,
    mood: "mood" in overrides ? (overrides.mood ?? null) : null,
  };
}

describe("graphLayout", () => {
  it("parses Camelot keys case-insensitively", () => {
    expect(parseCamelot("4a")).toEqual({ num: 4, mode: "A" });
    expect(parseCamelot("12B")).toEqual({ num: 12, mode: "B" });
    expect(parseCamelot("bad")).toBeNull();
  });

  it("returns same, relative and adjacent harmonic keys", () => {
    expect(getHarmonicCompanionKeys("1A")).toEqual(["1A", "1B", "12A", "2A"]);
    expect(getHarmonicCompanionKeys("12B")).toEqual([
      "12B",
      "12A",
      "11B",
      "1B",
    ]);
  });

  it("defaults active edges to key and bpm", () => {
    expect(DEFAULT_ACTIVE_EDGE_TYPES).toEqual(["key", "bpm"]);
  });

  it("checks bpm tolerance using percent difference", () => {
    expect(isWithinBpmTolerance(124, 128, 4)).toBe(true);
    expect(isWithinBpmTolerance(124, 134, 4)).toBe(false);
  });

  it("classifies harmonic compatibility against bpm tolerance", () => {
    const anchor = makeNode({ id: 1, key_camelot: "4A", bpm: 124 });
    expect(
      getTrackCompatibility(
        anchor,
        makeNode({ id: 2, key_camelot: "4B", bpm: 126 }),
        5,
      ),
    ).toBe("compatible");
    expect(
      getTrackCompatibility(
        anchor,
        makeNode({ id: 3, key_camelot: "5A", bpm: 138 }),
        5,
      ),
    ).toBe("bpm-mismatch");
    expect(
      getTrackCompatibility(
        anchor,
        makeNode({ id: 4, key_camelot: "9B", bpm: 126 }),
        5,
      ),
    ).toBe("key-mismatch");
    expect(
      getTrackCompatibility(
        anchor,
        makeNode({ id: 5, key_camelot: null, bpm: 126 }),
        5,
      ),
    ).toBe("unknown-key");
  });

  it("ranks playable candidates by harmonic fit and bpm distance", () => {
    const anchor = makeNode({ id: 1, key_camelot: "4A", bpm: 120 });
    const ranked = rankMixCandidates(
      anchor,
      [
        anchor,
        makeNode({ id: 2, key_camelot: "5A", bpm: 121 }),
        makeNode({ id: 3, key_camelot: "4B", bpm: 120.5 }),
        makeNode({ id: 4, key_camelot: "4A", bpm: 120.5 }),
        makeNode({ id: 5, key_camelot: "9B", bpm: 120 }),
      ],
      5,
    );

    expect(ranked.map(({ track }) => track.id)).toEqual([4, 3, 2]);
    expect(ranked.map(({ relation }) => relation)).toEqual([
      "Same key",
      "Relative",
      "Adjacent",
    ]);
  });

  it("orders compatible candidates in the chosen mix direction", () => {
    const anchor = makeNode({ id: 1, bpm: 120, key_camelot: "8A", energy: 5 });
    const lower = makeNode({ id: 2, bpm: 118, key_camelot: "8A", energy: 3 });
    const higher = makeNode({ id: 3, bpm: 122, key_camelot: "8A", energy: 7 });

    expect(
      rankMixCandidates(anchor, [lower, higher], 5, "build_up")[0]?.track.id,
    ).toBe(3);
    expect(
      rankMixCandidates(anchor, [lower, higher], 5, "cooldown")[0]?.track.id,
    ).toBe(2);
  });

  it("places major keys farther out than minor keys", () => {
    const nodes = [
      makeNode({ id: 1, key_camelot: "4A", bpm: 120 }),
      makeNode({ id: 2, key_camelot: "4B", bpm: 120 }),
    ];
    const positions = buildCamelotLayout(nodes);
    const minor = positions.get(1);
    const major = positions.get(2);
    expect(minor).toBeDefined();
    expect(major).toBeDefined();
    const minorRadius = Math.hypot(minor!.x, minor!.y);
    const majorRadius = Math.hypot(major!.x, major!.y);
    expect(majorRadius).toBeGreaterThan(minorRadius);
  });

  it("matches the wheel orientation for cardinal Camelot sectors", () => {
    const nodes = [
      makeNode({ id: 1, key_camelot: "1A", bpm: 120 }),
      makeNode({ id: 2, key_camelot: "4A", bpm: 120 }),
      makeNode({ id: 3, key_camelot: "7A", bpm: 120 }),
      makeNode({ id: 4, key_camelot: "10A", bpm: 120 }),
    ];
    const positions = buildCamelotLayout(nodes);
    expect(positions.get(1)!.y).toBeGreaterThan(0);
    expect(positions.get(2)!.x).toBeGreaterThan(0);
    expect(positions.get(3)!.y).toBeLessThan(0);
    expect(positions.get(4)!.x).toBeLessThan(0);
  });

  it("uses bpm to push faster tracks farther out inside a key cluster", () => {
    const nodes = [
      makeNode({ id: 1, key_camelot: "8A", bpm: 110, genre: "House" }),
      makeNode({ id: 2, key_camelot: "8A", bpm: 138, genre: "House" }),
    ];
    const positions = buildCamelotLayout(nodes);
    const slower = positions.get(1)!;
    const faster = positions.get(2)!;
    expect(Math.hypot(faster.x, faster.y)).toBeGreaterThan(
      Math.hypot(slower.x, slower.y),
    );
  });

  it("ignores genre metadata when positioning tracks", () => {
    const clean = [
      makeNode({ id: 1, key_camelot: "6B", bpm: 126, genre: "House" }),
      makeNode({ id: 2, key_camelot: "6B", bpm: 126, genre: "Techno" }),
    ];
    const polluted = [
      makeNode({ id: 1, key_camelot: "6B", bpm: 126, genre: "track 01" }),
      makeNode({ id: 2, key_camelot: "6B", bpm: 126, genre: "Unknown Remix" }),
    ];

    expect([...buildCamelotLayout(clean)]).toEqual([
      ...buildCamelotLayout(polluted),
    ]);
  });

  it("moves unknown-key tracks into a separate fallback band", () => {
    const nodes = [
      makeNode({ id: 1, key_camelot: "2A" }),
      makeNode({ id: 2, key_camelot: null, bpm: 125, genre: "House" }),
    ];
    const positions = buildCamelotLayout(nodes);
    expect(positions.get(2)?.y).toBeLessThan(-5);
    expect(positions.get(1)?.y).toBeGreaterThan(positions.get(2)!.y);
  });
});
