# Install DJ-IT on a Mac

This guide is for an AI coding agent setting up DJ-IT for someone who wants to
use the app. Complete the steps for the user; involve them only for system
prompts, permissions, and choosing music. No GitHub login, API keys, cloud
service, Homebrew, full Xcode, or paid Apple developer account is required.

## 1. Check the Mac

```sh
uname -m
sw_vers -productVersion
xcode-select -p
```

Supported: Apple Silicon (`arm64`, M1 or newer) with macOS 15 or newer. If the
terminal reports `x86_64`, check whether it is running under Rosetta on an Apple
Silicon Mac; use a native terminal there. Stop on an Intel Mac or older macOS
and explain the requirement before downloading dependencies.

If Apple's Command Line Tools are missing, run `xcode-select --install`. The
user must finish the macOS installer dialog. Then verify `xcode-select -p` and
`git --version` succeed before continuing. Installation requires internet access.

## 2. Get the source and tools

Use an ordinary writable project folder in the user's home directory. The
following example uses `~/Code/djit`; do not overwrite an existing checkout.
If it already exists, inspect its remote and local changes before reusing it.

```sh
mkdir -p "$HOME/Code"
git clone https://github.com/FranckPoingt/djit.git "$HOME/Code/djit"
cd "$HOME/Code/djit"
```

Read `AGENTS.md` and inspect `.mise.toml`. Check for an existing mise with
`command -v mise` or `~/.local/bin/mise --version`. If neither works, use the
[official mise installer](https://mise.jdx.dev/getting-started.html):

```sh
curl --fail --show-error --location https://mise.run -o /tmp/djit-install-mise.sh
sh /tmp/djit-install-mise.sh
```

Add the install directory to this terminal's PATH, trust the reviewed project
configuration, and install the pinned tools and locked dependencies:

```sh
export PATH="$HOME/.local/bin:$PATH"
mise --version
mise trust
./scripts/bootstrap.sh
```

The repository manages Node, Python, pnpm, uv, and Deno. No shell startup-file
edits or manual installs of those tools are needed. Keep the committed versions
and lockfiles; if a download fails, report the failing command instead of
silently upgrading dependencies.

## 3. Check and build the app

Run from the repository root, stopping if any command fails:

```sh
./scripts/mise-exec.sh pnpm run lint
./scripts/mise-exec.sh pnpm run test
./scripts/build.sh
codesign --verify --deep --strict --verbose=2 dist/DJ-IT.app
./scripts/mise-exec.sh python scripts/smoke-packaged.py
```

The first build downloads tools and dependencies and can take several minutes.
The build produces `dist/DJ-IT.app` with its frontend and backend included.
The smoke check uses synthetic audio and a temporary database; it does not
modify the user's library. It verifies backend workflows, not the native window.

## 4. Install and open

Quit any running DJ-IT normally and confirm it has exited before replacing it.
Preserve `~/Library/Application Support/DJ-IT` and all original music files.
If the app already has data, back up that directory while DJ-IT is closed,
including any SQLite sidecar files.

For a first installation (only when `/Applications/DJ-IT.app` does not exist):

```sh
ditto dist/DJ-IT.app /Applications/DJ-IT.app
codesign --verify --deep --strict --verbose=2 /Applications/DJ-IT.app
open /Applications/DJ-IT.app
```

For an existing installation, first move the old app bundle to a uniquely named
backup outside Applications, then use the commands above. **Never copy into an
existing app bundle:** merging leaves stale files and can break its signature.
Keep the backup until verification succeeds. If copying fails, do not launch a
partial bundle or claim installation succeeded.

If Applications requires administrator approval, let the user approve the copy
in Finder. This build is ad-hoc signed, not Apple notarized. If macOS blocks
opening it, inspect the exact warning and use the system's per-app approval
flow for this locally built app; do not disable Gatekeeper globally.

## 5. Verify the installed app

Confirm the DJ-IT window loads. Check the backend started by the installed app,
not a development server or the separate smoke-test process. Its port is dynamic:

```sh
pgrep -fl '/Applications/DJ-IT.app/Contents/Resources/djit-server/djit-server'
```

For each matching backend PID, inspect its listening socket:

```sh
lsof -nP -a -p <backend-pid> -iTCP -sTCP:LISTEN
curl --fail --show-error http://127.0.0.1:<actual-port>/api/v1/health
```

Replace the placeholders with the observed PID and port. Expect JSON containing
`"ok": true`; do not assume a fixed port. Then verify the bundle again:

```sh
codesign --verify --deep --strict --verbose=2 /Applications/DJ-IT.app
```

Exercise folder import and audio preview in the installed window using a small
folder chosen by the user or disposable test audio. If you cannot control the
window, have the user confirm those actions and clearly report that UI
verification is pending until they do. An HTTP health check alone is not enough.

Leave the app open and report the installed path, signature result, health
result, and what you exercised. Explain: **next time, open DJ-IT from Applications
or Spotlight, then import a music folder in the app.** Terminal and the coding
agent can be closed; development servers are not needed. Allow access to the
chosen music folder or external drive if macOS asks. No music is included.

## Updating later

Quit DJ-IT and back up its data first. In a clean checkout of this public
repository on `main`, use `git pull --ff-only`, then repeat the checks, build,
and fresh-bundle installation above. Stop if local changes or a diverged branch
need resolving; do not reset them away. Preserve the old app and pre-update data
backup together in case a rollback is needed.
