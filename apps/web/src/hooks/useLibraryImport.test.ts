import { describe, expect, it } from "vitest";

import { libraryStatusPollInterval } from "./useLibraryImport";

describe("libraryStatusPollInterval", () => {
  it("does not poll forever just because tracks still need analysis", () => {
    expect(
      libraryStatusPollInterval({
        status: "idle",
        pendingAnalysis: 4_000,
        waitingForScanToStart: false,
      }),
    ).toBe(false);
  });

  it("polls while a library scan is active", () => {
    expect(
      libraryStatusPollInterval({
        status: "scanning",
        pendingAnalysis: 0,
        waitingForScanToStart: false,
      }),
    ).toBe(1000);
  });
});
