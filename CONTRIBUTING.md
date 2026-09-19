# Contributing

Start with the README setup instructions. Keep changes small and use synthetic
audio and temporary databases in tests; never commit a personal music library,
SQLite files, credentials, or recordings you cannot redistribute.

Run `pnpm run lint` and `pnpm run test` through `scripts/mise-exec.sh`.
For API changes, run `pnpm run codegen` and commit both generated files.
For desktop changes, build on Apple Silicon macOS, verify the signature, and
exercise the affected workflow in the installed app. See docs/RELEASING.md.

Explain the problem, the resulting behavior, and how you checked it in your pull
request. Contributions are made under the project's AGPL-3.0-only license.
Do not include generated bundles or dependency directories.
