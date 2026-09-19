from __future__ import annotations

import multiprocessing
import os

if __name__ == "__main__":
    multiprocessing.freeze_support()

    # Native Essentia/SDL libraries must be initialized on macOS's main thread.
    import essentia.standard  # noqa: F401
    import uvicorn

    from djit.main import app

    uvicorn.run(
        app,
        host="127.0.0.1",
        port=int(os.environ["DJIT_BACKEND_PORT"]),
        log_level="info",
    )
