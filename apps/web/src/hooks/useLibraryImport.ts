import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  FolderPickResponse,
  LibraryImportResponse,
  LibraryStatusResponse,
} from "api-client";
import { useEffect, useRef } from "react";

import { createApiUrl } from "../lib/api";
import { TRACKS_QUERY_KEY } from "./useTracks";

type LibraryStatusPollState = {
  status?: string;
  pendingAnalysis: number;
  waitingForScanToStart: boolean;
};

export const libraryStatusPollInterval = ({
  status,
  waitingForScanToStart,
}: LibraryStatusPollState) =>
  status === "scanning" || waitingForScanToStart ? 1000 : false;

const fetchLibraryStatus = async (): Promise<LibraryStatusResponse> => {
  const response = await fetch(createApiUrl("/library/status"));

  if (!response.ok) {
    throw new Error("Failed to load library status");
  }

  return response.json();
};

const postImportLibrary = async (
  folderPath: string,
): Promise<LibraryImportResponse> => {
  const response = await fetch(
    createApiUrl(
      `/library/import?folder_path=${encodeURIComponent(folderPath)}`,
    ),
    {
      method: "POST",
    },
  );

  if (!response.ok) {
    throw new Error("Failed to import library folder");
  }

  return response.json();
};

const getPickedFolder = async (): Promise<FolderPickResponse> => {
  const response = await fetch(createApiUrl("/library/pick-folder"));

  if (!response.ok) {
    throw new Error("Failed to open folder picker");
  }

  return response.json();
};

export const useLibraryImport = () => {
  const queryClient = useQueryClient();
  const scanStartDeadlineRef = useRef<number | null>(null);

  const statusQuery = useQuery({
    queryKey: ["library-status"],
    queryFn: fetchLibraryStatus,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      const pendingAnalysis = query.state.data?.pending_analysis ?? 0;
      const waitingForScanToStart =
        scanStartDeadlineRef.current !== null &&
        Date.now() < scanStartDeadlineRef.current;
      return libraryStatusPollInterval({
        status,
        pendingAnalysis,
        waitingForScanToStart,
      });
    },
  });

  const importMutation = useMutation({
    mutationFn: postImportLibrary,
    onSuccess: async () => {
      // Keep polling briefly in case scan startup races initial status response.
      scanStartDeadlineRef.current = Date.now() + 15_000;
      await queryClient.invalidateQueries({ queryKey: ["library-status"] });
      await queryClient.invalidateQueries({ queryKey: TRACKS_QUERY_KEY });
    },
  });

  const pickFolderMutation = useMutation({
    mutationFn: getPickedFolder,
  });

  const previousStatusRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const currentStatus = statusQuery.data?.status;
    const previousStatus = previousStatusRef.current;

    if (currentStatus === "scanning") {
      scanStartDeadlineRef.current = null;
    }

    if (
      previousStatus === "scanning" &&
      currentStatus &&
      currentStatus !== "scanning"
    ) {
      void queryClient.invalidateQueries({ queryKey: TRACKS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ["library-status"] });
    }

    previousStatusRef.current = currentStatus;
  }, [
    queryClient,
    statusQuery.data?.status,
  ]);

  return {
    status: statusQuery.data,
    isLoadingStatus: statusQuery.isLoading,
    statusError: statusQuery.error,
    importLibrary: importMutation.mutateAsync,
    importResult: importMutation.data,
    isImporting: importMutation.isPending,
    importError: importMutation.error,
    pickFolder: pickFolderMutation.mutateAsync,
    isPickingFolder: pickFolderMutation.isPending,
    pickFolderError: pickFolderMutation.error,
  };
};
