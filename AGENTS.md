# DJ-IT Agent Instructions

## Installing for a user

For requests to install or try DJ-IT, follow [docs/INSTALL_MAC.md](docs/INSTALL_MAC.md).
Handle prerequisite checks, building, installation, and verification for the user.
Use the standalone app workflow; do not leave a nontechnical user running dev servers.
Ask for help only with necessary system dialogs, permissions, or missing choices.
Preserve existing music and app data, and report any verification you could not do.
Installation does not require application source changes.

## Definition of Done

For every application code change, source checks are not enough. Before reporting the change complete:

1. Run the relevant tests and static checks.
2. Run `./scripts/build.sh` to rebuild the web app, frozen backend, and macOS bundle.
3. Verify `dist/DJ-IT.app` with `codesign --verify --deep --strict --verbose=2`.
4. Quit DJ-IT, replace `/Applications/DJ-IT.app` cleanly, and verify the installed bundle's signature. Do not merge into an old bundle because stale sealed resources invalidate its signature.
5. Launch `/Applications/DJ-IT.app`, confirm its embedded `/api/v1/health` endpoint, and exercise the affected workflow in the installed app.
6. Leave the installed app open for the user to test and report its exact installed/verified state.

Do not call an application change complete unless this installed-app check passes or a concrete blocker is reported.
