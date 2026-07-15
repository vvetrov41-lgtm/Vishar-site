from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
LAUNCHER = REPO / "scripts" / "geo_agent_launcher.py"
RUNTIME_CLI = REPO / ".geo-topic-agent-runtime" / "geo_agent_cli.py"


def run_launcher(runtime: str, *args: str) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env.pop("XMLRIVER_API_KEY", None)
    env.pop("XML_RIVER_KEY", None)
    return subprocess.run(
        [sys.executable, str(LAUNCHER), "--runtime", runtime, *args],
        cwd=REPO,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        check=False,
    )


def test_launcher_resolves_same_canonical_runtime_for_codex_and_claude() -> None:
    assert LAUNCHER.is_file()
    assert RUNTIME_CLI.is_file()
    codex = run_launcher("codex", "--", "--help")
    claude = run_launcher("claude", "--", "--help")
    assert codex.returncode == 0
    assert claude.returncode == 0
    assert "One-topic GEO/AEO workflow agent" in codex.stdout
    assert "One-topic GEO/AEO workflow agent" in claude.stdout


def test_shared_project_profile_is_single_source() -> None:
    profile = (REPO / "geo_agent" / "PROJECT_PROFILE.md").read_text(encoding="utf-8")
    config = json.loads((REPO / "geo_agent" / "config" / "geo_agent_config.json").read_text(encoding="utf-8"))
    assert "Vladimir Vishar" in profile
    assert "No Regrets Studios" in profile
    assert config["project"]["domain"] == "https://vishartattoo.com/"
    assert "vishar tattoo" in [v.lower() for v in config["project"]["brand_variants"]]


def test_runtime_local_state_roots_are_isolated_without_setup() -> None:
    codex = run_launcher("codex", "provider-audit", "--project-dir", ".")
    claude = run_launcher("claude", "provider-audit", "--project-dir", ".")
    assert codex.returncode == 0, codex.stderr
    assert claude.returncode == 0, claude.stderr
    codex_state = REPO / ".geo-agent-local" / "codex" / "STATE.md"
    claude_state = REPO / ".geo-agent-local" / "claude" / "STATE.md"
    assert codex_state.is_file()
    assert claude_state.is_file()
    assert codex_state != claude_state
    assert "Provider audit completed" in codex_state.read_text(encoding="utf-8")
    assert "Provider audit completed" in claude_state.read_text(encoding="utf-8")


def test_no_secrets_or_paid_network_flags_in_help() -> None:
    result = run_launcher("codex", "collect-serp", "--help")
    assert result.returncode == 0
    combined = result.stdout + result.stderr
    assert "XMLRIVER_API_KEY=" not in combined
    assert "--network-approved" in combined
    assert "--paid-approved" in combined
