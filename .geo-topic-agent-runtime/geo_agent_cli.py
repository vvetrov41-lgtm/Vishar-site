from __future__ import annotations

import os
import sys
from pathlib import Path


# The distributable runtime must remain import-clean even when launched by a
# normal Python installation without PYTHONDONTWRITEBYTECODE.
sys.dont_write_bytecode = True


def main() -> int:
    runtime_root = Path(__file__).resolve().parent
    runtime_path = str(runtime_root)
    if runtime_path not in sys.path:
        sys.path.insert(0, runtime_path)
    os.environ.setdefault("PYTHONUTF8", "1")
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="strict")
    from geo_topic_agent.cli import main as cli_main

    result = cli_main()
    return int(result) if isinstance(result, int) else 0


if __name__ == "__main__":
    raise SystemExit(main())
