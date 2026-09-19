import { describe, expect, it } from "vitest";
import { buildGraphUrl } from "../hooks/useGraph";

describe("buildGraphUrl", () => {
  it("defaults to transition relationships", () => {
    const url = buildGraphUrl({});
    expect(url).toContain("types=key");
    expect(url).toContain("types=bpm");
    expect(url).not.toContain("types=genre");
    expect(url).not.toContain("types=energy");
    expect(url).not.toContain("types=mood");
    expect(url).not.toContain("types=artist");
  });

  it("includes only specified types", () => {
    const url = buildGraphUrl({ types: ["key", "bpm"] });
    expect(url).toContain("types=key");
    expect(url).toContain("types=bpm");
    expect(url).not.toContain("types=genre");
    expect(url).not.toContain("types=mood");
  });

  it("includes default bpm_tol=5", () => {
    const url = buildGraphUrl({});
    expect(url).toContain("bpm_tol=5");
  });

  it("includes custom bpm_tol", () => {
    const url = buildGraphUrl({ bpmTol: 10 });
    expect(url).toContain("bpm_tol=10");
  });

  it("includes filter_ids when provided", () => {
    const url = buildGraphUrl({ filterIds: [1, 42, 99] });
    expect(url).toContain("filter_ids=1");
    expect(url).toContain("filter_ids=42");
    expect(url).toContain("filter_ids=99");
  });

  it("omits filter_ids when empty", () => {
    const url = buildGraphUrl({ filterIds: [] });
    expect(url).not.toContain("filter_ids");
  });

  it("starts with the correct base path", () => {
    const url = buildGraphUrl({});
    expect(url.startsWith("/api/v1/graph?")).toBe(true);
  });
});
