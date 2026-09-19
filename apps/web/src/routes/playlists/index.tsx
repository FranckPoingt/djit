import { createRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { PaginatedTracksResponse, TrackSummary } from "api-client";

import { useBuildIntelligentPlaylist } from "../../hooks/useIntelligentPlaylist";
import { usePlaylists } from "../../hooks/usePlaylists";
import { createApiUrl } from "../../lib/api";

import { rootRoute } from "../__root";

const formatDuration = (seconds: number | null) => {
  if (!seconds || seconds <= 0) {
    return "-";
  }
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`;
};

const OCCASIONS = [
  { value: "warm-up", label: "Warm-up", note: "A steady rise", count: 25, profile: "build_up" },
  { value: "party", label: "Party", note: "A longer arc", count: 40, profile: "build_up" },
  { value: "dinner", label: "Dinner / bar", note: "Easy and consistent", count: 20, profile: "cruise" },
  { value: "workout", label: "Workout", note: "Momentum first", count: 30, profile: "build_up" },
  { value: "after-hours", label: "After-hours", note: "Deep and unhurried", count: 25, profile: "cooldown" },
] as const;

const AUDIENCES = ["Just me", "Friends", "Mixed crowd", "Dancefloor"] as const;
const EMPTY_TRACKS: TrackSummary[] = [];
const VIBES = [
  { value: "laid-back", label: "Laid-back", energy: 3 },
  { value: "groovy", label: "Groovy", energy: 5 },
  { value: "uplifting", label: "Uplifting", energy: 7 },
  { value: "peak-time", label: "Peak-time", energy: 9 },
  { value: "dark", label: "Dark", energy: 6 },
] as const;

type Occasion = (typeof OCCASIONS)[number]["value"];
type Audience = (typeof AUDIENCES)[number];
type Vibe = (typeof VIBES)[number]["value"];

export type PlaylistIntent = {
  occasion: Occasion;
  genres: string[];
  audience: Audience;
  vibe: Vibe;
  seedId: number | null;
};

const occasionFor = (value: Occasion) =>
  OCCASIONS.find((option) => option.value === value) ?? OCCASIONS[0];

export const buildPlaylistName = (intent: PlaylistIntent) =>
  `${occasionFor(intent.occasion).label} · ${intent.genres.length === 1 ? intent.genres[0] : intent.genres.length > 1 ? "Multi-genre" : VIBES.find((vibe) => vibe.value === intent.vibe)?.label || "Mix"}`;

export const selectPlaylistTracks = (
  tracks: TrackSummary[],
  intent: PlaylistIntent,
) => {
  const seed = tracks.find((track) => track.id === intent.seedId);
  const genres = new Set(intent.genres.map((genre) => genre.toLocaleLowerCase()));
  const targetEnergy = VIBES.find((vibe) => vibe.value === intent.vibe)?.energy ?? 5;
  const candidates = tracks.filter(
    (track) =>
      track.id !== intent.seedId &&
      (genres.size === 0 || genres.has(track.genre?.toLocaleLowerCase() ?? "")),
  );

  const score = (track: TrackSummary) => {
    let value = track.triage_decision === "keep" ? 30 : 12;
    if (track.energy !== null && track.energy !== undefined) {
      value += Math.max(0, 18 - Math.abs(track.energy - targetEnergy) * 4);
    }
    const analyzed =
      track.analysis_status === "done" || track.analysis_status === "overridden";
    if (analyzed) value += intent.audience === "Dancefloor" ? 12 : 4;
    if (intent.audience === "Just me" && track.triage_decision === "maybe") value += 8;
    const playlistCount = track.playlist_memberships?.length ?? 0;
    if (intent.audience === "Friends" && playlistCount > 0) value += 3;
    if (intent.audience === "Mixed crowd" && playlistCount > 0) value += 6;
    if (intent.vibe === "dark" && track.key_camelot?.endsWith("A")) value += 4;
    return value;
  };

  candidates.sort((left, right) => score(right) - score(left) || left.id - right.id);

  return [...(seed ? [seed] : []), ...candidates].slice(
    0,
    occasionFor(intent.occasion).count,
  );
};

const fetchCuratedTracks = async (): Promise<PaginatedTracksResponse> => {
  const params = new URLSearchParams({ limit: "500" });
  params.append("triage_decision", "keep");
  params.append("triage_decision", "maybe");
  const response = await fetch(createApiUrl(`/tracks?${params}`));
  if (!response.ok) throw new Error("Failed to load saved tracks");
  return response.json();
};

const Choice = ({
  active,
  label,
  note,
  onClick,
}: {
  active: boolean;
  label: string;
  note?: string;
  onClick: () => void;
}) => (
  <button
    type="button"
    className={active ? "playlist-choice active" : "playlist-choice"}
    aria-pressed={active}
    onClick={onClick}
  >
    <strong>{label}</strong>
    {note ? <span>{note}</span> : null}
  </button>
);

const PlaylistsPage = () => {
  const { data: playlists = [], isLoading, error } = usePlaylists();
  const curatedQuery = useQuery({
    queryKey: ["playlist-builder-tracks"],
    queryFn: fetchCuratedTracks,
  });
  const buildPlaylist = useBuildIntelligentPlaylist();
  const navigate = useNavigate();
  const [occasion, setOccasion] = useState<Occasion>("warm-up");
  const [selectedGenres, setSelectedGenres] = useState<string[]>([]);
  const [audience, setAudience] = useState<Audience>("Friends");
  const [vibe, setVibe] = useState<Vibe>("groovy");
  const [seedSearch, setSeedSearch] = useState("");
  const [seedId, setSeedId] = useState<number | null>(null);
  const [customName, setCustomName] = useState("");

  const curatedTracks = curatedQuery.data?.items ?? EMPTY_TRACKS;
  const availableGenres = useMemo(
    () =>
      Array.from(new Set(curatedTracks.map((track) => track.genre).filter(Boolean)))
        .sort((left, right) => left!.localeCompare(right!)) as string[],
    [curatedTracks],
  );
  const intent: PlaylistIntent = {
    occasion,
    genres: selectedGenres,
    audience,
    vibe,
    seedId,
  };
  const selectedTracks = useMemo(
    () => selectPlaylistTracks(curatedTracks, intent),
    [audience, curatedTracks, occasion, seedId, selectedGenres, vibe],
  );
  const seed = curatedTracks.find((track) => track.id === seedId);
  const seedMatches = useMemo(() => {
    const search = seedSearch.trim().toLocaleLowerCase();
    if (!search || seed) return [];
    return curatedTracks
      .filter((track) => `${track.artist} ${track.title}`.toLocaleLowerCase().includes(search))
      .slice(0, 5);
  }, [curatedTracks, seed, seedSearch]);
  const suggestedName = buildPlaylistName(intent);

  const handleBuild = async () => {
    const option = occasionFor(occasion);
    try {
      const result = await buildPlaylist.mutateAsync({
        name: customName.trim() || suggestedName,
        trackIds: selectedTracks.map((track) => track.id),
        harmonizeOptions: {
          lock_first: seedId !== null,
          lock_last: false,
          bpm_weight: 0.5,
          bpm_tolerance: 4,
          profile: option.profile,
        },
        graphOrderOptions: {
          key_weight: 0.5,
          bpm_weight: 0.3,
          energy_weight: 0.2,
          start_id: seedId ?? undefined,
        },
      });
      await navigate({
        to: "/playlists/$playlistId",
        params: { playlistId: String(result.playlistId) },
      });
    } catch {
      // The mutation exposes the error directly below the builder.
    }
  };

  return (
    <>
      <div className="djit-topbar">
        <span
          style={{
            fontFamily: "var(--font-label)",
            fontSize: "var(--font-size-sm)",
            fontWeight: 700,
            letterSpacing: "var(--letter-spacing-caps)",
            color: "var(--color-text-secondary)",
          }}
        >
          PLAYLISTS
        </span>
        {!isLoading && (
          <span
            style={{
              fontFamily: "var(--font-label)",
              fontSize: "var(--font-size-xs)",
              color: "var(--color-text-faint)",
            }}
          >
            {playlists.length} playlists
          </span>
        )}
      </div>

      <div className="playlists-page">
        <details className="playlist-builder" open>
          <summary className="playlist-builder-intro">
            <span>
              <span className="review-eyebrow">NEW PLAYLIST</span>
              <h1>What are we making?</h1>
              <p>Shape a mix from tracks you Saved or Shortlisted. You can fine-tune it afterwards.</p>
            </span>
            <b className="playlist-builder-toggle">
              <span className="playlist-builder-toggle-hide">HIDE</span>
              <span className="playlist-builder-toggle-show">SHOW</span>
            </b>
          </summary>

          <div className="playlist-builder-body">

          <fieldset>
            <legend><span>1</span> What occasion?</legend>
            <div className="playlist-choice-grid">
              {OCCASIONS.map((option) => (
                <Choice key={option.value} active={occasion === option.value} label={option.label} note={option.note} onClick={() => setOccasion(option.value)} />
              ))}
            </div>
          </fieldset>

          <div className="playlist-builder-row">
            <div>
              <span><b>2</b> What genre?</span>
              <div className="playlist-genre-grid">
                <Choice active={selectedGenres.length === 0} label="Any genre" onClick={() => setSelectedGenres([])} />
                {availableGenres.map((value) => (
                  <Choice
                    key={value}
                    active={selectedGenres.includes(value)}
                    label={value}
                    onClick={() => setSelectedGenres((current) => current.includes(value) ? current.filter((genre) => genre !== value) : [...current, value])}
                  />
                ))}
              </div>
            </div>
            <div>
              <span><b>3</b> Who is it for?</span>
              <div className="playlist-choice-grid compact">
                {AUDIENCES.map((value) => (
                  <Choice key={value} active={audience === value} label={value} onClick={() => setAudience(value)} />
                ))}
              </div>
            </div>
          </div>

          <fieldset>
            <legend><span>4</span> What vibe?</legend>
            <div className="playlist-choice-grid compact">
              {VIBES.map((option) => (
                <Choice key={option.value} active={vibe === option.value} label={option.label} onClick={() => setVibe(option.value)} />
              ))}
            </div>
          </fieldset>

          <label className="playlist-seed">
            <span><b>5</b> Any track in mind? <small>Optional — it will open the mix.</small></span>
            <input
              value={seed ? `${seed.artist} — ${seed.title}` : seedSearch}
              onChange={(event) => {
                setSeedId(null);
                setSeedSearch(event.target.value);
              }}
              placeholder="Search Saved + Shortlisted tracks…"
            />
            {seedMatches.length > 0 ? (
              <div className="playlist-seed-results">
                {seedMatches.map((track) => (
                  <button key={track.id} type="button" onClick={() => { setSeedId(track.id); setSeedSearch(""); }}>
                    <strong>{track.title}</strong><span>{track.artist}</span>
                  </button>
                ))}
              </div>
            ) : null}
            {seed ? <button type="button" className="playlist-clear-seed" onClick={() => { setSeedId(null); setSeedSearch(""); }}>CLEAR SEED</button> : null}
          </label>

          <div className="playlist-builder-finish">
            <label>
              Playlist name
              <input value={customName} onChange={(event) => setCustomName(event.target.value)} placeholder={suggestedName} />
            </label>
            <div aria-live="polite">
              <strong>{curatedQuery.isLoading ? "Finding tracks…" : `${selectedTracks.length} tracks ready`}</strong>
              <span>{selectedGenres.length > 0 ? selectedGenres.join(" + ") : "Any genre"} · {audience} · {VIBES.find((option) => option.value === vibe)?.label}</span>
            </div>
            <button className="btn btn-primary" type="button" onClick={() => void handleBuild()} disabled={selectedTracks.length === 0 || buildPlaylist.isPending}>
              {buildPlaylist.isPending ? "BUILDING…" : "BUILD PLAYLIST"}
            </button>
          </div>
          {curatedQuery.isError ? <p className="playlist-builder-error">Could not load your Saved and Shortlisted tracks.</p> : null}
          {!curatedQuery.isLoading && curatedTracks.length === 0 ? <p className="playlist-builder-error">Save or Shortlist a few tracks in Review first.</p> : null}
          {buildPlaylist.isError ? <p className="playlist-builder-error">The playlist could not be created. Try again.</p> : null}
          </div>
        </details>

        <section className="playlist-library">
          <div className="playlist-library-heading">
            <h2>Your playlists</h2>
            {!isLoading ? <span>{playlists.length}</span> : null}
          </div>
        {error ? (
          <p
            style={{
              fontFamily: "var(--font-label)",
              fontSize: "var(--font-size-sm)",
              color: "var(--color-problem)",
              marginBottom: "var(--space-4)",
            }}
          >
            FAILED TO LOAD PLAYLISTS
          </p>
        ) : null}

        {isLoading ? (
          <p
            style={{
              fontFamily: "var(--font-label)",
              fontSize: "var(--font-size-sm)",
              color: "var(--color-text-faint)",
              letterSpacing: "var(--letter-spacing-label)",
            }}
          >
            LOADING…
          </p>
        ) : null}

        {!isLoading && playlists.length === 0 ? (
          <p
            style={{
              fontFamily: "var(--font-label)",
              fontSize: "var(--font-size-sm)",
              color: "var(--color-text-faint)",
              letterSpacing: "var(--letter-spacing-label)",
            }}
          >
            YOUR FIRST PLAYLIST WILL APPEAR HERE
          </p>
        ) : null}

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-2)",
          }}
        >
          {playlists.map((playlist) => (
            <Link
              key={playlist.id}
              to="/playlists/$playlistId"
              params={{ playlistId: String(playlist.id) }}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "var(--space-3) var(--space-4)",
                border: "1px solid var(--color-border-subtle)",
                borderRadius: "var(--radius-md)",
                background: "var(--color-bg-sidebar)",
                textDecoration: "none",
              }}
            >
              <div>
                <p
                  style={{
                    color: "var(--color-text-primary)",
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--font-size-base)",
                  }}
                >
                  {playlist.name}
                </p>
                <p
                  style={{
                    color: "var(--color-text-muted)",
                    fontFamily: "var(--font-label)",
                    fontSize: "var(--font-size-xs)",
                    letterSpacing: "var(--letter-spacing-label)",
                    marginTop: 2,
                  }}
                >
                  {playlist.track_count} tracks ·{" "}
                  {formatDuration(playlist.duration_seconds)} · BPM{" "}
                  {playlist.bpm_min ?? "—"} — {playlist.bpm_max ?? "—"}
                </p>
              </div>
              <span className="chip chip-done" style={{ flexShrink: 0 }}>
                {playlist.track_count}
              </span>
            </Link>
          ))}
        </div>
        </section>
      </div>
    </>
  );
};

export const playlistsIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "playlists",
  component: PlaylistsPage,
});
