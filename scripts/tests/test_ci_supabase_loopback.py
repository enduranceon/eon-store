#!/usr/bin/env python3
"""Pure Docker fixtures and loopback-only TCP tests; no Docker or remote calls."""

from contextlib import redirect_stderr
import importlib.util
from io import StringIO
import json
from pathlib import Path
import queue
import socket
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import call, patch


SPEC = importlib.util.spec_from_file_location("ci_supabase_loopback", Path(__file__).with_name("ci-supabase-loopback.py"))
RELAY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RELAY)
NAME, NETWORK_ID, CONTAINER_ID = "eon-match-ci-123456-1", "a" * 64, "b" * 64
DB = RELAY.CHECK.DATABASE_CONTAINER


def fixtures():
    network = {"Id": NETWORK_ID, "Name": NAME, "Internal": True, "Driver": "bridge", "EnableIPv6": False,
               "IPAM": {"Config": [{"Subnet": "172.28.0.0/16", "Gateway": "172.28.0.1"}]},
               "Containers": {CONTAINER_ID: {"Name": DB[1:], "IPv4Address": "172.28.0.2/16"}}}
    container = {"Id": CONTAINER_ID, "Name": DB,
                 "State": {"Status": "running", "Running": True, "Paused": False, "Restarting": False},
                 "NetworkSettings": {"Networks": {NAME: {"NetworkID": NETWORK_ID, "IPAddress": "172.28.0.2"}}},
                 "Config": {"Env": ["NEVER_PRINT=synthetic-secret"]}}
    return [network], [container]


class ValidationTests(unittest.TestCase):
    def test_exact_database_and_kong_ports(self):
        networks, containers = fixtures()
        self.assertEqual(RELAY.destinations(NAME, NETWORK_ID, networks, containers), {DB: ("172.28.0.2", 5432)})
        self.assertEqual(RELAY.TARGETS["/supabase_kong_bsiljrrodgtmtdilnuxr"], (54321, 8000))

    def test_network_must_remain_internal_ipv4_bridge_with_same_id(self):
        for field, value in [("Internal", False), ("EnableIPv6", True), ("Driver", "host"), ("Id", "c" * 64)]:
            networks, containers = fixtures()
            networks[0][field] = value
            with self.subTest(field=field), self.assertRaises(RELAY.Failure):
                RELAY.destinations(NAME, NETWORK_ID, networks, containers)

    def test_additional_or_other_network_is_denied(self):
        for attachments in [{"bridge": {}}, {NAME: {"NetworkID": NETWORK_ID}, "bridge": {}}]:
            networks, containers = fixtures()
            containers[0]["NetworkSettings"]["Networks"] = attachments
            with self.subTest(attachments=attachments), self.assertRaises(RELAY.Failure):
                RELAY.destinations(NAME, NETWORK_ID, networks, containers)

    def test_remote_loopback_and_malformed_addresses_are_denied(self):
        for value in ["8.8.8.8", "127.0.0.1", "192.168.1.3", "169.254.169.254", "::1", "", None, "synthetic-secret"]:
            networks, containers = fixtures()
            containers[0]["NetworkSettings"]["Networks"][NAME]["IPAddress"] = value
            with self.subTest(value=value), self.assertRaises(RELAY.Failure):
                RELAY.destinations(NAME, NETWORK_ID, networks, containers)

    def test_network_subnet_cannot_be_public(self):
        networks, containers = fixtures()
        networks[0]["IPAM"]["Config"][0]["Subnet"] = "8.8.8.0/24"
        with self.assertRaises(RELAY.Failure):
            RELAY.destinations(NAME, NETWORK_ID, networks, containers)

    def test_membership_must_match_and_reset_absence_does_not_forward(self):
        networks, containers = fixtures()
        networks[0]["Containers"] = {}
        self.assertEqual(RELAY.destinations(NAME, NETWORK_ID, networks, containers), {})
        networks, containers = fixtures()
        networks[0]["Containers"][CONTAINER_ID]["IPv4Address"] = "172.28.0.3/16"
        with self.assertRaises(RELAY.Failure):
            RELAY.destinations(NAME, NETWORK_ID, networks, containers)

    def test_only_exact_allowed_container_names_become_targets(self):
        networks, containers = fixtures()
        containers[0]["Name"] = "/supabase_rest_test"
        self.assertEqual(RELAY.destinations(NAME, NETWORK_ID, networks, containers), {})
        self.assertEqual(RELAY.destinations(NAME, NETWORK_ID, networks, []), {})

    def test_startup_and_reset_stopped_targets_are_unavailable(self):
        for status in ("created", "exited", "restarting"):
            networks, containers = fixtures()
            containers[0]["State"].update(Status=status, Running=False)
            with self.subTest(status=status):
                self.assertEqual(RELAY.destinations(NAME, NETWORK_ID, networks, containers), {})

    def test_created_container_unallocated_attachment_is_unavailable(self):
        networks, containers = fixtures()
        containers[0]["State"].update(Status="created", Running=False)
        attachment = containers[0]["NetworkSettings"]["Networks"][NAME]
        attachment.update(NetworkID="", IPAddress="")
        self.assertEqual(RELAY.destinations(NAME, NETWORK_ID, networks, containers), {})
        attachment["NetworkID"] = "c" * 64
        with self.assertRaises(RELAY.Failure):
            RELAY.destinations(NAME, NETWORK_ID, networks, containers)
        attachment["NetworkID"] = ""
        containers[0]["State"].update(Status="running", Running=True)
        with self.assertRaises(RELAY.Failure):
            RELAY.destinations(NAME, NETWORK_ID, networks, containers)

    def test_snapshot_retries_only_confirmed_removed_id(self):
        networks, containers = fixtures()
        target = object.__new__(RELAY.DockerTargets)
        target.name, target.network_id = NAME, NETWORK_ID
        old_id = "c" * 64
        with patch.object(target, "identifiers", side_effect=[[old_id], [CONTAINER_ID]]) as identifiers, \
                patch.object(target, "read", side_effect=[RELAY.Failure("Local Docker inspection failed"),
                                                         json.dumps(containers), json.dumps(networks)]):
            self.assertEqual(target.snapshot(), {DB: ("172.28.0.2", 5432)})
        self.assertEqual(identifiers.call_count, 2)
        with patch.object(target, "identifiers", return_value=[CONTAINER_ID]), \
                patch.object(target, "read", side_effect=RELAY.Failure("Local Docker inspection failed")) as read:
            with self.assertRaises(RELAY.Failure):
                target.snapshot()
        self.assertEqual(read.call_count, 1)

    def test_snapshot_retry_is_bounded_and_invalid_json_is_not_retried(self):
        target = object.__new__(RELAY.DockerTargets)
        target.name, target.network_id = NAME, NETWORK_ID
        with patch.object(target, "identifiers", side_effect=[[character * 64] for character in "bcde"]), \
                patch.object(target, "read", side_effect=RELAY.Failure("Local Docker inspection failed")) as read:
            with self.assertRaises(RELAY.Failure):
                target.snapshot()
        self.assertEqual(read.call_count, 3)
        with patch.object(target, "identifiers", return_value=[CONTAINER_ID]) as identifiers, \
                patch.object(target, "read", return_value="synthetic-secret"):
            with self.assertRaises(RELAY.Failure):
                target.snapshot()
        self.assertEqual(identifiers.call_count, 1)

    def test_changed_ip_is_resolved_for_each_connection(self):
        target = object.__new__(RELAY.DockerTargets)
        with patch.object(target, "snapshot", side_effect=[{DB: ("172.28.0.2", 5432)}, {DB: ("172.28.0.9", 5432)}]) as snapshot:
            self.assertEqual(target.resolve(DB), ("172.28.0.2", 5432))
            self.assertEqual(target.resolve(DB), ("172.28.0.9", 5432))
        self.assertEqual(snapshot.call_count, 2)

    def test_generic_proxy_target_is_refused(self):
        target = object.__new__(RELAY.DockerTargets)
        with self.assertRaises(RELAY.Failure):
            target.resolve("example.test")

    def test_unexpected_errors_are_redacted(self):
        stderr = StringIO()
        with patch.object(RELAY.sys, "argv", ["ci-supabase-loopback.py"]), \
                patch.object(RELAY.CHECK, "validate_environment", side_effect=RuntimeError("synthetic-secret")), redirect_stderr(stderr):
            self.assertEqual(RELAY.main(), 1)
        self.assertNotIn("synthetic-secret", stderr.getvalue())
        self.assertIn("details redacted", stderr.getvalue())

    def test_child_group_is_terminated_on_failure(self):
        child = SimpleNamespace(pid=12345, poll=lambda: None, wait=lambda timeout: 0)
        with patch.object(RELAY.os, "killpg") as kill:
            RELAY.terminate_group(child)
        self.assertEqual(kill.call_args_list, [call(12345, RELAY.signal.SIGTERM), call(12345, RELAY.signal.SIGKILL)])

    def test_child_group_cleanup_includes_already_exited_shell(self):
        child = SimpleNamespace(pid=12345, poll=lambda: 0, wait=lambda timeout: 0)
        with patch.object(RELAY.os, "killpg") as kill:
            RELAY.terminate_group(child)
        self.assertEqual(kill.call_count, 2)

    def test_monitor_failure_aborts_validation_child(self):
        child = SimpleNamespace(pid=12345, poll=lambda: None)
        target = SimpleNamespace(snapshot=unittest.mock.Mock(side_effect=[{}, RELAY.Failure("Invalid isolated network")]))
        with patch.object(RELAY.sys, "argv", ["ci-supabase-loopback.py"]), \
                patch.dict(RELAY.os.environ, {"CI": "true", "EON_TEST_EPHEMERAL": "1", "EON_CI_NETWORK": NAME,
                                             "DOCKER_HOST": RELAY.CHECK.DOCKER_SOCKET}), \
                patch.object(RELAY, "DockerTargets", return_value=target), \
                patch.object(RELAY.subprocess, "Popen", return_value=child) as start, \
                patch.object(RELAY, "terminate_group") as terminate, \
                patch.object(RELAY, "Relay") as listener, redirect_stderr(StringIO()):
            self.assertEqual(RELAY.main(), 1)
        start.assert_called_once()
        terminate.assert_called_once_with(child)
        listener.assert_not_called()

    def test_connection_validation_error_reaches_main_failure_queue(self):
        relay = object.__new__(RELAY.Relay)
        relay.target = DB
        relay.resolver = SimpleNamespace(resolve=lambda _: (_ for _ in ()).throw(RELAY.Failure("Invalid isolated network")))
        relay.stopped, relay.failures = threading.Event(), queue.Queue()
        relay.lock, relay.connections = threading.Lock(), set()
        client, peer = socket.socketpair()
        try:
            relay.forward(client)
            self.assertIsInstance(relay.failures.get_nowait(), RELAY.Failure)
        finally:
            peer.close()

    def test_real_loopback_tcp_pump_preserves_half_close_and_response(self):
        # Only ephemeral IPv4 loopback ports; no Docker and no external address.
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        left = socket.create_connection(listener.getsockname(), timeout=2)
        accepted, _ = listener.accept()
        upstream, server = socket.socketpair()
        server.settimeout(2)
        stopped = threading.Event()
        worker = threading.Thread(target=RELAY.pump, args=(accepted, upstream, stopped))
        worker.start()
        try:
            left.sendall(b"synthetic request")
            left.shutdown(socket.SHUT_WR)
            self.assertEqual(server.recv(100), b"synthetic request")
            self.assertEqual(server.recv(1), b"")
            server.sendall(b"synthetic response")
            server.shutdown(socket.SHUT_WR)
            self.assertEqual(left.recv(100), b"synthetic response")
            self.assertEqual(left.recv(1), b"")
            worker.join(timeout=2)
            self.assertFalse(worker.is_alive())
        finally:
            stopped.set()
            for stream in (left, accepted, upstream, server, listener):
                stream.close()
            worker.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
