#!/usr/bin/env python3
"""Dual-runtime launcher for the canonical GEO Topic Agent runtime."""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

SUPPORTED = {"codex", "claude"}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the canonical GEO Topic Agent with isolated runtime-local state.")
    parser.add_argument("--runtime", required=True, choices=sorted(SUPPORTED), help="Host runtime adapter to select.")
    parser.add_argument("command", nargs=argparse.REMAINDER, help="Arguments forwarded to geo_agent_cli.py.")
    return parser


def forwarded_runtime(command: list[str]) -> str | None:
    """Return the setup runtime requested in forwarded arguments, if any."""
    values: list[str] = []
    index = 0
    while index < len(command):
        token = command[index]
        if token == "--runtime":
            if index + 1 >= len(command):
                raise ValueError("forwarded --runtime requires a value")
            values.append(command[index + 1])
            index += 2
            continue
        if token.startswith("--runtime="):
            values.append(token.split("=", 1)[1])
        index += 1
    unique = {value for value in values if value}
    if len(unique) > 1:
        raise ValueError("conflicting forwarded --runtime values")
    return next(iter(unique), None)


def forwarded_project_dir(command: list[str], cwd: Path) -> Path:
    """Resolve the project-dir supplied to setup, defaulting to the launcher repo."""
    value = "."
    index = 0
    while index < len(command):
        token = command[index]
        if token == "--project-dir":
            if index + 1 >= len(command):
                raise ValueError("forwarded --project-dir requires a value")
            value = command[index + 1]
            index += 2
            continue
        if token.startswith("--project-dir="):
            value = token.split("=", 1)[1]
        index += 1
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = cwd / path
    return path.resolve()


def replace_project_dir(command: list[str], project_dir: Path) -> list[str]:
    """Replace all forwarded project-dir forms with one canonical absolute path."""
    rewritten: list[str] = []
    index = 0
    while index < len(command):
        token = command[index]
        if token == "--project-dir":
            if index + 1 >= len(command):
                raise ValueError("forwarded --project-dir requires a value")
            index += 2
            continue
        if token.startswith("--project-dir="):
            index += 1
            continue
        rewritten.append(token)
        index += 1
    rewritten.extend(["--project-dir", str(project_dir)])
    return rewritten


def copy_if_present(source: Path, destination: Path) -> None:
    if not source.is_file():
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def prepare_setup_shadow(repo_root: Path, runtime_local_root: Path) -> Path:
    """Create an ignored project root for setup-only generated configuration."""
    shadow = runtime_local_root / "setup-project"
    if shadow.exists():
        shutil.rmtree(shadow)
    shadow.mkdir(parents=True)
    # Ensure the runtime's project-root discovery stops here instead of walking
    # upward into the real tracked checkout.
    (shadow / ".git").mkdir()

    for relative in ("AGENTS.md", "CLAUDE.md", "package.json", "package-lock.json"):
        copy_if_present(repo_root / relative, shadow / relative)
    copy_if_present(
        repo_root / "geo_agent" / "PROJECT_PROFILE.md",
        shadow / "geo_agent" / "PROJECT_PROFILE.md",
    )
    copy_if_present(
        repo_root / "geo_agent" / "config" / "geo_agent_config.json",
        shadow / "geo_agent" / "config" / "geo_agent_config.json",
    )
    return shadow


def main() -> int:
    args = build_parser().parse_args()
    command = list(args.command)
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        print("error: missing GEO agent command", file=sys.stderr)
        return 2

    repo_root = Path(__file__).resolve().parents[1]
    canonical_cli = repo_root / ".geo-topic-agent-runtime" / "geo_agent_cli.py"
    if not canonical_cli.is_file():
        print(f"error: canonical GEO Topic Agent CLI not found: {canonical_cli}", file=sys.stderr)
        return 2

    runtime_local_root = repo_root / ".geo-agent-local" / args.runtime
    env = os.environ.copy()
    env["GEO_AGENT_RUNTIME"] = args.runtime
    env["GEO_AGENT_RUNTIME_LOCAL_ROOT"] = str(runtime_local_root)
    env.setdefault("PYTHONUTF8", "1")
    env.setdefault("PYTHONIOENCODING", "utf-8")

    forwarded = command
    if forwarded[0] == "setup":
        try:
            requested_runtime = forwarded_runtime(forwarded)
            requested_project = forwarded_project_dir(forwarded, repo_root)
        except ValueError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2
        if requested_runtime and requested_runtime != args.runtime:
            print(
                f"error: launcher runtime '{args.runtime}' conflicts with forwarded setup runtime '{requested_runtime}'",
                file=sys.stderr,
            )
            return 2
        if requested_project != repo_root.resolve():
            print("error: setup through this launcher must target its own repository root", file=sys.stderr)
            return 2
        if not requested_runtime:
            forwarded.extend(["--runtime", args.runtime])
        setup_shadow = prepare_setup_shadow(repo_root, runtime_local_root)
        forwarded = replace_project_dir(forwarded, setup_shadow)

    completed = subprocess.run([sys.executable, str(canonical_cli), *forwarded], cwd=repo_root, env=env)
    return int(completed.returncode)


if __name__ == "__main__":
    raise SystemExit(main())
