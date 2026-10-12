#!/usr/bin/env python3
"""Read-only, fail-closed check of the disposable Supabase CI Docker network.

Run after start and again after reset, before any tests. The workflow must create
the internal network BEFORE starting Supabase; this check cannot undo earlier
network traffic. It never starts containers, modifies networks or prints Docker
inspection output, which may contain environment credentials.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from collections.abc import Mapping
from typing import Any


NETWORK_PATTERN = re.compile(r"eon-match-ci-[0-9]+-[0-9]+")
DOCKER_ID_PATTERN = re.compile(r"[0-9a-f]{64}")
DATABASE_CONTAINER = "/supabase_db_bsiljrrodgtmtdilnuxr"
DOCKER_SOCKET = "unix:///var/run/docker.sock"


class IsolationFailure(Exception):
    """A deliberately redacted diagnostic safe to print in public CI logs."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise IsolationFailure(message)


def validate_environment(environment: Mapping[str, str]) -> str:
    require(environment.get("CI") == "true", "CI=true is required")
    require(environment.get("EON_TEST_EPHEMERAL") == "1", "EON_TEST_EPHEMERAL=1 is required")
    name = environment.get("EON_CI_NETWORK", "")
    require(bool(NETWORK_PATTERN.fullmatch(name)), "EON_CI_NETWORK must be a per-run eon-match-ci network")
    return name


def validate_isolation(name: str, networks: Any, containers: Any) -> int:
    """Validate already-decoded Docker JSON without performing any I/O."""
    require(bool(NETWORK_PATTERN.fullmatch(name)), "Unexpected CI network name")
    require(isinstance(networks, list) and len(networks) == 1, "Expected exactly one Docker network")
    network = networks[0]
    require(isinstance(network, dict), "Malformed Docker network inspection")
    require(network.get("Name") == name, "Docker network name does not match this CI run")
    require(network.get("Internal") is True, "Docker network must be internal before starting Supabase")
    require(network.get("Driver") == "bridge", "Docker network must use the bridge driver")
    require(network.get("EnableIPv6") is False, "IPv6 must be disabled for the isolated CI network")
    network_id = network.get("Id")
    require(isinstance(network_id, str) and bool(DOCKER_ID_PATTERN.fullmatch(network_id)), "Malformed Docker network ID")
    require(isinstance(containers, list) and bool(containers), "No Supabase containers were inspected")
    names: set[str] = set()
    identifiers: set[str] = set()
    for container in containers:
        require(isinstance(container, dict), "Malformed Docker container inspection")
        container_name = container.get("Name")
        require(isinstance(container_name, str) and container_name.startswith("/supabase_"),
                "Container selection includes an unexpected name")
        require(container_name not in names, "Duplicate Supabase container name")
        names.add(container_name)
        container_id = container.get("Id")
        require(isinstance(container_id, str) and bool(DOCKER_ID_PATTERN.fullmatch(container_id)), "Malformed Docker container ID")
        require(container_id not in identifiers, "Duplicate Supabase container ID")
        identifiers.add(container_id)
        state = container.get("State")
        require(isinstance(state, dict) and state.get("Status") == "running" and state.get("Running") is True
                and state.get("Paused") is False and state.get("Restarting") is False,
                "Every Supabase container must be running, not paused or restarting")
        settings = container.get("NetworkSettings")
        attachments = settings.get("Networks") if isinstance(settings, dict) else None
        require(isinstance(attachments, dict) and set(attachments) == {name},
                "Every Supabase container must attach only to the isolated CI network")
        attachment = attachments[name]
        require(isinstance(attachment, dict) and attachment.get("NetworkID") == network_id,
                "Supabase container network ID does not match the isolated network")
    require(DATABASE_CONTAINER in names, "The expected Supabase database container is missing")
    return len(containers)


def docker_read(*arguments: str) -> str:
    """Use the local Linux CI socket explicitly, never an ambient Docker context."""
    try:
        result = subprocess.run(
            ["docker", "--host", DOCKER_SOCKET, *arguments],
            capture_output=True, text=True, timeout=30, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        raise IsolationFailure("Local Docker inspection failed or timed out") from None
    require(result.returncode == 0, "Local Docker inspection failed")
    return result.stdout


def decode_inspection(raw: str) -> Any:
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        raise IsolationFailure("Docker inspection returned invalid JSON") from None


def check_docker(name: str) -> int:
    networks = decode_inspection(docker_read("inspect", "--type", "network", name))
    # Include stopped containers; inspecting only running ones could hide a
    # misconfigured or crashed service and produce a false success.
    identifiers = docker_read("ps", "-aq", "--no-trunc", "--filter", "name=supabase_").splitlines()
    require(bool(identifiers) and len(set(identifiers)) == len(identifiers)
            and all(DOCKER_ID_PATTERN.fullmatch(identifier) for identifier in identifiers),
            "Expected a nonempty, unambiguous list of local Supabase container IDs")
    containers = decode_inspection(docker_read("inspect", "--type", "container", *identifiers))
    require(isinstance(containers, list) and len(containers) == len(identifiers)
            and all(isinstance(container, dict) for container in containers)
            and {container.get("Id") for container in containers} == set(identifiers),
            "Docker container inspection does not match the complete Supabase container selection")
    return validate_isolation(name, networks, containers)


def main() -> int:
    try:
        count = check_docker(validate_environment(os.environ))
    except IsolationFailure as error:
        print(f"FAIL Supabase CI isolation: {error}", file=sys.stderr)
        return 1
    except Exception:
        # Do not leak inspect payloads, environment variables or raw Docker errors.
        print("FAIL Supabase CI isolation: unexpected inspection error (details redacted)", file=sys.stderr)
        return 1
    print(f"PASS Supabase CI isolation: {count} running containers use only the internal IPv4 bridge")
    return 0


if __name__ == "__main__":
    sys.exit(main())
