#!/usr/bin/env python3
"""Synthetic-only tests: no Docker daemon, sockets, database or remote calls."""

from contextlib import redirect_stderr
from copy import deepcopy
import importlib.util
from io import StringIO
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    "ci_supabase_isolation", Path(__file__).with_name("ci-supabase-isolation.py"))
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)
NAME = "eon-match-ci-123456-1"
NETWORK_ID = "a" * 64
ENVIRONMENT = {"CI": "true", "EON_TEST_EPHEMERAL": "1", "EON_CI_NETWORK": NAME}


def network():
    return [{"Id": NETWORK_ID, "Name": NAME, "Driver": "bridge", "Internal": True, "EnableIPv6": False}]


def container(name=CHECK.DATABASE_CONTAINER, identifier="b" * 64):
    return {
        "Id": identifier, "Name": name,
        "State": {"Status": "running", "Running": True, "Paused": False, "Restarting": False},
        "NetworkSettings": {"Networks": {NAME: {"NetworkID": NETWORK_ID}}},
        "Config": {"Env": ["SYNTHETIC_SECRET=do-not-print-fixture"]},
    }


class IsolationTests(unittest.TestCase):
    def test_valid_database_and_api_containers(self):
        self.assertEqual(CHECK.validate_isolation(NAME, network(), [container(), container("/supabase_rest_test", "c" * 64)]), 2)

    def test_required_ci_environment(self):
        self.assertEqual(CHECK.validate_environment(ENVIRONMENT), NAME)
        for field in ENVIRONMENT:
            candidate = dict(ENVIRONMENT)
            candidate.pop(field)
            with self.subTest(field=field), self.assertRaises(CHECK.IsolationFailure):
                CHECK.validate_environment(candidate)

    def test_network_name_is_strict(self):
        for name in ["", "bridge", "eon-match-ci-1", "eon-match-ci-1-2\n", "eon-match-ci-one-2", "eon-match-ci-1-2-extra"]:
            with self.subTest(name=name), self.assertRaises(CHECK.IsolationFailure):
                CHECK.validate_environment({**ENVIRONMENT, "EON_CI_NETWORK": name})

    def test_noninternal_or_nonbridge_or_ipv6_network_is_denied(self):
        for field, value in [("Internal", False), ("Internal", "true"), ("Driver", "overlay"), ("EnableIPv6", True), ("EnableIPv6", None), ("Name", "other")]:
            candidate = network()
            candidate[0][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(CHECK.IsolationFailure):
                CHECK.validate_isolation(NAME, candidate, [container()])

    def test_missing_database_is_denied(self):
        with self.assertRaises(CHECK.IsolationFailure):
            CHECK.validate_isolation(NAME, network(), [container("/supabase_rest_test")])

    def test_two_networks_or_wrong_network_is_denied(self):
        for attachments in [{NAME: {"NetworkID": NETWORK_ID}, "bridge": {}}, {"bridge": {}}, {}, {NAME: {"NetworkID": "d" * 64}}]:
            candidate = container()
            candidate["NetworkSettings"]["Networks"] = attachments
            with self.subTest(attachments=attachments), self.assertRaises(CHECK.IsolationFailure):
                CHECK.validate_isolation(NAME, network(), [candidate])

    def test_stopped_paused_and_restarting_containers_are_denied(self):
        for field, value in [("Status", "exited"), ("Running", False), ("Paused", True), ("Restarting", True)]:
            candidate = container()
            candidate["State"][field] = value
            with self.subTest(field=field), self.assertRaises(CHECK.IsolationFailure):
                CHECK.validate_isolation(NAME, network(), [candidate])

    def test_malformed_or_incomplete_inspections_are_denied(self):
        for networks, containers in [(None, [container()]), ([], [container()]), (network() * 2, [container()]),
                                     (network(), []), (network(), None), (network(), [{}]), (network(), [None])]:
            with self.subTest(networks=networks, containers=containers), self.assertRaises(CHECK.IsolationFailure):
                CHECK.validate_isolation(NAME, networks, containers)

    def test_duplicate_names_and_ids_are_denied(self):
        for extra in [deepcopy(container()), container(CHECK.DATABASE_CONTAINER, "c" * 64), container("/supabase_rest_test")]:
            with self.subTest(extra=extra), self.assertRaises(CHECK.IsolationFailure):
                CHECK.validate_isolation(NAME, network(), [container(), extra])

    def test_complete_selection_is_required(self):
        outputs = [json.dumps(network()), "b" * 64 + "\n" + "c" * 64, json.dumps([container()])]
        with patch.object(CHECK, "docker_read", side_effect=outputs), self.assertRaises(CHECK.IsolationFailure):
            CHECK.check_docker(NAME)

    def test_inspection_uses_stopped_containers_and_explicit_types(self):
        outputs = [json.dumps(network()), "b" * 64, json.dumps([container()])]
        with patch.object(CHECK, "docker_read", side_effect=outputs) as docker:
            self.assertEqual(CHECK.check_docker(NAME), 1)
        self.assertEqual(docker.call_args_list[0].args, ("inspect", "--type", "network", NAME))
        self.assertEqual(docker.call_args_list[1].args, ("ps", "-aq", "--no-trunc", "--filter", "name=supabase_"))
        self.assertEqual(docker.call_args_list[2].args, ("inspect", "--type", "container", "b" * 64))

    def test_remote_docker_context_cannot_replace_local_socket(self):
        with patch.dict(CHECK.os.environ, {"DOCKER_HOST": "tcp://example.test:2375"}), \
                patch.object(CHECK.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout="[]")) as run:
            CHECK.docker_read("inspect", "--type", "network", NAME)
        self.assertEqual(run.call_args.args[0][:3], ["docker", "--host", "unix:///var/run/docker.sock"])

    def test_docker_error_output_is_not_logged(self):
        stderr = StringIO()
        with patch.dict(CHECK.os.environ, ENVIRONMENT, clear=True), \
                patch.object(CHECK.subprocess, "run", return_value=SimpleNamespace(returncode=1, stdout="do-not-print-fixture", stderr="do-not-print-fixture")), \
                redirect_stderr(stderr):
            self.assertEqual(CHECK.main(), 1)
        self.assertNotIn("do-not-print-fixture", stderr.getvalue())
        self.assertIn("Local Docker inspection failed", stderr.getvalue())

    def test_malformed_json_fails_closed(self):
        with self.assertRaises(CHECK.IsolationFailure):
            CHECK.decode_inspection("do-not-print-fixture")


if __name__ == "__main__":
    unittest.main()
