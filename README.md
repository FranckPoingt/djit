# DJ-IT

A local-first app for turning a messy music library into a collection worth DJing.
Import folders, listen and triage tracks, analyze BPM and key, build compatible
playlists, and copy a chosen playlist to a folder or USB drive.

**Alpha software.** macOS on Apple Silicon is the supported desktop target.
Windows, Linux, and Intel Mac packages have not been validated. Engine DJ database
export is not implemented; folder extraction produces audio copies, an M3U8
playlist, and a JSON manifest.

## What works

- Incremental folder imports and embedded metadata reading.
- Audio preview, triage, tagging, saved views, and duplicate review.
- Background BPM/key analysis with pause, resume, and failure recovery.
- Manual and compatibility playlists, plus a musical relationship graph.
- Metadata cleanup with undo and playlist extraction to a folder or USB drive.

Analysis estimates can be wrong. Review them before performing. Imports and
metadata cleanup do not rewrite source audio. Back up your collection and database
before trying an alpha release. Extraction manifests contain original file paths;
review them before sharing.

## Development

Install [mise](https://mise.jdx.dev/getting-started.html), Git, and Apple's Command
Line Tools (`xcode-select --install`). Then:

```sh
git clone https://github.com/FranckPoingt/djit.git
cd djit
mise trust
./scripts/bootstrap.sh
./scripts/dev.sh
```

The bootstrap installs the versions in [.mise.toml](.mise.toml) and dependencies
from the committed lockfiles. Development uses a local Vite frontend and FastAPI
backend. With [Portless](https://github.com/vercel-labs/portless) installed, the
frontend uses `http://djit.localhost`; otherwise Vite prints its local URL.
Both development servers bind to loopback. Do not expose the API to a network:
it is designed for a trusted local user and has no authentication.

## Checks and desktop build

```sh
./scripts/mise-exec.sh pnpm run lint
./scripts/mise-exec.sh pnpm run test
./scripts/mise-exec.sh pnpm run codegen
./scripts/build.sh
```

The build produces `dist/DJ-IT.app`, including the web frontend and a frozen Python
backend. It is ad-hoc signed for local use, not Apple notarized. Public binary
releases require the separate checks in [the release guide](docs/RELEASING.md).
A source checkout does not require a developer signing identity.

## Data and analysis

The installed app stores its database in
`~/Library/Application Support/DJ-IT/djit.db`. Development uses
`apps/server/djit.db`; `DJIT_DB_PATH` overrides the path. Quit the app before copying
the database and its SQLite sidecars for backup. Audio remains in its original
location until you explicitly extract copies.

Essentia is installed with the backend and used by default. `DJIT_ANALYSIS_ENGINE`
accepts `auto`, `essentia`, or `librosa`; `auto` can fall back to librosa in development.
The desktop backend requires Essentia. Tracks over twelve minutes are excluded
from normal analysis unless explicitly included. Fast analysis samples sections;
deep analysis processes the full track.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and
[TODO.md](TODO.md). Domain vocabulary lives in [CONTEXT.md](CONTEXT.md).

DJ-IT is licensed under **AGPL-3.0-only**; see [LICENSE](LICENSE).
Dependencies retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
No music or sample library is included. DJ-IT is not affiliated with Engine DJ.
