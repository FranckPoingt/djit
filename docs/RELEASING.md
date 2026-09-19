# Releasing DJ-IT

## First public source release

The original private repository history contains SQLite journals. **Do not make
that repository public or push its history to a public remote.** Deleting files
in a later commit does not remove earlier copies.

1. Finish and review the current working changes. Run lint, tests, and API codegen.
2. Run `python3 scripts/prepare-source.py`. It creates `release/djit-source`
   from current working files, without Git history, generated bundles, or the
   personal audio-analysis experiment. It refuses to overwrite an existing tree.
3. Inspect that tree, including untracked files. Run a redacted secret scan, e.g.
   `gitleaks dir release/djit-source --redact`. Review any finding; do not add
   broad allowlists. Historical scans may flag musical `keys` arguments in harmonization tests;
   inspect the specific match before deciding whether it is a credential.
4. Initialize a new Git repository in the prepared tree and make its initial
   commit. Build and test from a fresh clone of that repository.
5. Publish this clean repository to a **new** remote, or arrange a separately
   approved replacement of the existing private repository. Do not force-push
   over existing history as part of routine release preparation. Update README
   and SECURITY links if the public repository has a different URL.
6. Enable private vulnerability reporting, run the checked-in CI workflow, and
   review its result before tagging `v0.1.0-alpha.1`. Do not tag an unverified build.

The old repository remains private for archival use. Its history is not part of
the public source distribution. Secret scanning is a check, not a guarantee;
review filenames, documentation, binary assets, and author metadata too.

## Installed desktop verification

On Apple Silicon running macOS 15 or newer (required by the pinned Essentia wheel):

```sh
./scripts/bootstrap.sh
./scripts/mise-exec.sh pnpm run lint
./scripts/mise-exec.sh pnpm run test
./scripts/build.sh
codesign --verify --deep --strict --verbose=2 dist/DJ-IT.app
./scripts/mise-exec.sh python scripts/smoke-packaged.py
```

Quit the installed DJ-IT and move its old bundle aside. Copy `dist/DJ-IT.app` to
`/Applications/DJ-IT.app` as a fresh bundle; never merge bundle directories. Verify
the installed signature, launch it, then check the backend's loopback
`/api/v1/health` endpoint. Exercise import, audio preview, triage, analysis,
playlist creation, and folder extraction using synthetic audio in a temporary
library. Leave the installed app open. Verify the signature again after launch;
the runtime must not leave unsealed update markers inside the bundle.

Preserve the user's database. Do not run destructive migration/reset scripts on
it. A successful source test run alone does not validate desktop packaging.

## Public binary releases (separate from publishing source)

- Gather exact license texts and matching source for bundled Python, JavaScript,
  Deno, and native dependencies. Check Essentia's bundled FFmpeg/FFTW/SDL/etc.
  Do not assume Python package metadata covers native-library obligations.
- Validate the icon and any other distributed artwork provenance.
- Sign with an appropriate Developer ID and notarize if advertising a normal
  double-click Mac download. Local builds use ad-hoc signatures only.
- Validate on a clean supported Mac, record architecture and macOS version,
  publish checksums and corresponding source alongside the artifact.
- Include limitations, backup guidance, and an upgrade/rollback procedure.
