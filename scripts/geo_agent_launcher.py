#!/usr/bin/env python3
"""Dual-runtime launcher for the canonical GEO Topic Agent runtime."""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

SUPPORTED = {"codex", "claude"}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the canonical GEO Topic Agent with isolated runtime-local state.")
    parser.add_argument("--runtime", required=True, choices=sorted(SUPPORTED), help="Host runtime adapter to select.")
    parser.add_argument("command", nargs=argparse.REMAINDER, help="Arguments forwarded to geo_agent_cli.py.")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if not args.command:
        print("error: missing GEO agent command", file=sys.stderr)
        return 2
    if args.command[0] == "--":
        args.command = args.command[1:]
    repo_root = Path(__file__).resolve().parents[1]
    canonical_cli = repo_root / ".geo-topic-agent-runtime" / "geo_agent_cli.py"
    if not canonical_cli.is_file():
        print(f"error: canonical GEO Topic Agent CLI not found: {canonical_cli}", file=sys.stderr)
        return 2

    env = os.environ.copy()
    env["GEO_AGENT_RUNTIME"] = args.runtime
    env["GEO_AGENT_RUNTIME_LOCAL_ROOT"] = str(repo_root / ".geo-agent-local" / args.runtime)
    env.setdefault("PYTHONUTF8", "1")
    env.setdefault("PYTHONIOENCODING", "utf-8")

    forwarded = list(args.command)
    if forwarded and forwarded[0] == "setup" and "--runtime" not in forwarded:
        forwarded.extend(["--runtime", args.runtime])

    completed = subprocess.run([sys.executable, str(canonical_cli), *forwarded], cwd=repo_root, env=env)
    return int(completed.returncode)


if __name__ == "__main__":
    raise SystemExit(main())
