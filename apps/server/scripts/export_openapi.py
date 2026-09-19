from __future__ import annotations

import json
from pathlib import Path

from djit.main import create_app


def main() -> None:
    app = create_app()
    openapi_spec = app.openapi()
    output_path = Path(__file__).resolve().parents[1] / "openapi.json"
    output_path.write_text(json.dumps(openapi_spec, indent=2), encoding="utf-8")
    print(f"Wrote OpenAPI spec to {output_path}")


if __name__ == "__main__":
    main()
