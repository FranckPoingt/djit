import { expect, it } from "vitest";

import { backgroundAnalysisAction } from "./useBackgroundAnalysis";

it("refills completed work, waits for active work, and respects cancellation", () => {
  expect(backgroundAnalysisAction("completed", true)).toBe("refill");
  expect(backgroundAnalysisAction("running", false)).toBe("wait");
  expect(backgroundAnalysisAction("cancelled", true)).toBe("stop");
});
