# Third-party software

DJ-IT's original code is AGPL-3.0-only. Dependencies remain under their own
licenses. Exact versions and download hashes are recorded in `pnpm-lock.yaml`
and `apps/server/uv.lock`.

The analysis backend includes [Essentia](https://essentia.upf.edu/), developed by
the Music Technology Group, Universitat Pompeu Fabra, under AGPLv3. It uses native
libraries with their own conditions, including FFmpeg, FFTW, SDL, libsamplerate,
and TagLib where present in the installed wheel. See
[Essentia's licensing information](https://essentia.upf.edu/licensing_information.html).
No pretrained Essentia model files are included in this repository.

Other principal dependencies include React (MIT), TanStack libraries (MIT),
Vite (MIT), graphology (MIT), Sigma (MIT), FastAPI (MIT), SQLAlchemy (MIT),
Alembic (MIT), librosa (ISC), NumPy (BSD), and Mutagen (GPL-2.0-or-later).
The desktop runtime is Deno; Python is frozen using PyInstaller, whose licensing
includes an exception for generated applications.

This document identifies major components; it does not replace their license
texts. Source releases do not vendor dependencies. Before distributing a binary,
collect the license texts and corresponding source for every bundled dependency,
including native libraries, and ship the required notices. A local ad-hoc build
is not an approved public binary release. See `docs/RELEASING.md`.
