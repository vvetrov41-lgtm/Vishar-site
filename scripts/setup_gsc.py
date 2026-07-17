"""Create an isolated virtual environment for the project-local GSC toolkit."""

from __future__ import annotations

import subprocess
import sys
import venv
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VENV = ROOT / ".venv-gsc"
REQUIREMENTS = ROOT / "geo_agent" / "tools" / "gsc" / "requirements.txt"


def main() -> int:
    if not VENV.exists():
        venv.EnvBuilder(with_pip=True).create(VENV)
    python = VENV / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
    subprocess.run(
        [str(python), "-m", "pip", "install", "--requirement", str(REQUIREMENTS)],
        check=True,
    )
    subprocess.run(
        [str(python), "-m", "geo_agent.tools.gsc.cli", "doctor"],
        cwd=ROOT,
        check=False,
    )
    print(f"GSC Python environment ready: {python}")
    print("A missing credential warning is expected until Google-side setup is complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
