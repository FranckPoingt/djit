import { createRouter } from "@tanstack/react-router";

import { playlistDetailRoute } from "./routes/playlists/$playlistId";
import { playlistsIndexRoute } from "./routes/playlists/index";
import { duplicatesRoute } from "./routes/duplicates";
import { graphRoute } from "./routes/graph";
import { indexRoute } from "./routes/index";
import { reviewRoute } from "./routes/review";
import { organizeRoute } from "./routes/organize";
import { rootRoute } from "./routes/__root";

const routeTree = rootRoute.addChildren([
  indexRoute,
  playlistsIndexRoute,
  playlistDetailRoute,
  duplicatesRoute,
  reviewRoute,
  graphRoute,
  organizeRoute,
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
});
