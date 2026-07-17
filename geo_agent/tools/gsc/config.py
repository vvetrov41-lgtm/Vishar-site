"""Configuration and validation helpers for the project-local GSC client."""

from __future__ import annotations

import json
import os
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import DEFAULT_PROPERTY


PROJECT_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_OUTPUT_DIR = PROJECT_ROOT / "geo_agent" / "data" / "gsc"
DEFAULT_CREDENTIALS_PATH = (
    Path.home() / ".config" / "vishar-site" / "gsc-service-account.json"
)
READONLY_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly"


class ConfigurationError(RuntimeError):
    """Raised when local GSC configuration is absent or unsafe."""


@dataclass(frozen=True)
class Settings:
    property_url: str
    credentials_path: Path
    output_dir: Path


def load_settings() -> Settings:
    raw_path = (
        os.environ.get("GSC_SERVICE_ACCOUNT_PATH")
        or os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    )
    return Settings(
        property_url=os.environ.get("GSC_PROPERTY", DEFAULT_PROPERTY).strip(),
        credentials_path=Path(raw_path).expanduser()
        if raw_path
        else DEFAULT_CREDENTIALS_PATH,
        output_dir=Path(
            os.environ.get("GSC_OUTPUT_DIR", str(DEFAULT_OUTPUT_DIR))
        ).expanduser(),
    )


def validate_property(property_url: str) -> None:
    if property_url == DEFAULT_PROPERTY:
        return
    if property_url in {
        "https://vishartattoo.com/",
        "https://www.vishartattoo.com/",
    }:
        return
    raise ConfigurationError(
        "GSC_PROPERTY must target vishartattoo.com; received "
        f"{property_url!r}. This guard prevents accidental cross-project exports."
    )


def load_credentials_info(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise ConfigurationError(
            f"Service Account key not found at {path}. "
            "Keep it outside the repository and set GSC_SERVICE_ACCOUNT_PATH."
        )
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ConfigurationError(f"Cannot read Service Account JSON: {exc}") from exc

    required = {"type", "project_id", "private_key", "client_email", "token_uri"}
    missing = sorted(required.difference(data))
    if missing:
        raise ConfigurationError(
            "Service Account JSON is missing fields: " + ", ".join(missing)
        )
    if data.get("type") != "service_account":
        raise ConfigurationError("Credential JSON is not a Google Service Account key.")
    return data


def credential_permissions_warning(path: Path) -> str | None:
    """Return a warning on POSIX when group/other permission bits are present."""
    try:
        mode = stat.S_IMODE(path.stat().st_mode)
    except OSError:
        return None
    if mode & 0o077:
        return f"credential file permissions are {mode:o}; use 600"
    return None


def masked_email(value: str) -> str:
    if "@" not in value:
        return "(invalid email)"
    local, domain = value.split("@", 1)
    visible = local[:3]
    return f"{visible}***@{domain}"
