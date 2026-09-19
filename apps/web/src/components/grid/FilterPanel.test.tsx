import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { FilterPanel } from "./FilterPanel";

vi.mock("../../hooks/useLibraryImport", () => ({
  useLibraryImport: () => ({
    status: {
      total_tracks: 42,
      pending_analysis: 12,
      unheard: 9,
      status: "idle",
    },
    isLoadingStatus: false,
    statusError: null,
    importLibrary: vi.fn(),
    importResult: null,
    isImporting: false,
    importError: null,
    pickFolder: vi.fn(),
    isPickingFolder: false,
    pickFolderError: null,
  }),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));

describe("FilterPanel", () => {
  it("renders connected sources and keeps import separate from analysis", () => {
    const queryClient = new QueryClient();
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <FilterPanel />
      </QueryClientProvider>,
    );

    expect(html).toContain("SOURCES");
    expect(html).toContain("CHOOSE FOLDER");
  });
});
