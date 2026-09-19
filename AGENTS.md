# DJ-IT Agent Instructions

## Definition of Done

For every application code change, source checks are not enough. Before reporting the change complete:

1. Run the relevant tests and static checks.
2. Run `./scripts/build.sh` to rebuild the web app, frozen backend, and macOS bundle.
3. Verify `dist/DJ-IT.app` with `codesign --verify --deep --strict --verbose=2`.
4. Quit DJ-IT, replace `/Applications/DJ-IT.app` cleanly, and verify the installed bundle's signature. Do not merge into an old bundle because stale sealed resources invalidate its signature.
5. Launch `/Applications/DJ-IT.app`, confirm its embedded `/api/v1/health` endpoint, and exercise the affected workflow in the installed app.
6. Leave the installed app open for Franck to test and report its exact installed/verified state.

Do not call an application change complete unless this installed-app check passes or a concrete blocker is reported.
