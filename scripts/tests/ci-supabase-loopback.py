#!/usr/bin/env python3
"""Run the fixed CI validation script with two local-only Supabase relays.

Docker's internal bridge remains the isolation boundary. No container is given
another network, a host-network listener, or a route to the internet. Listeners
appear only after their exact containers are running on the validated network,
so the Supabase CLI's initial checks still find the published ports free.
"""

from __future__ import annotations

import importlib.util
import ipaddress
import os
from pathlib import Path
import queue
import selectors
import signal
import socket
import subprocess
import sys
import threading
import time


DIRECTORY = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("ci_supabase_isolation", DIRECTORY / "ci-supabase-isolation.py")
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)
Failure = CHECK.IsolationFailure
require = CHECK.require
TARGETS = {
    "/supabase_db_bsiljrrodgtmtdilnuxr": (54322, 5432),
    "/supabase_kong_bsiljrrodgtmtdilnuxr": (54321, 8000),
}
PRIVATE_NETWORKS = tuple(ipaddress.IPv4Network(value) for value in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))


def destinations(name, expected_id, networks, containers):
    """Pure validation; unavailable startup/reset targets yield no destination."""
    network = CHECK.validate_network(name, networks)
    require(network["Id"] == expected_id, "The CI network identity changed")
    config = network.get("IPAM", {}).get("Config")
    require(isinstance(config, list) and bool(config), "Missing isolated network address range")
    subnets = []
    for entry in config:
        require(isinstance(entry, dict) and isinstance(entry.get("Subnet"), str), "Malformed isolated network address range")
        try:
            subnet = ipaddress.IPv4Network(entry["Subnet"])
        except ValueError:
            raise Failure("Isolated network must have private IPv4 address ranges") from None
        require(any(subnet.subnet_of(private) for private in PRIVATE_NETWORKS), "Isolated network must use private IPv4")
        subnets.append(subnet)
    members = network.get("Containers")
    require(isinstance(members, dict), "Missing isolated network membership")
    require(isinstance(containers, list), "Malformed container inspection")
    result = {}
    seen_ids, seen_names, running = set(), set(), []
    for container in containers:
        require(isinstance(container, dict), "Malformed container inspection")
        identifier, container_name = container.get("Id"), container.get("Name")
        require(isinstance(identifier, str) and bool(CHECK.DOCKER_ID_PATTERN.fullmatch(identifier)), "Malformed container identity")
        require(isinstance(container_name, str) and container_name.startswith("/supabase_"), "Unexpected container selection")
        require(identifier not in seen_ids and container_name not in seen_names, "Duplicate container selection")
        seen_ids.add(identifier)
        seen_names.add(container_name)
        state = container.get("State")
        require(isinstance(state, dict) and state.get("Status") in
                ("created", "running", "restarting", "exited", "dead", "removing"), "Malformed container state")
        require(all(type(state.get(key)) is bool for key in ("Running", "Paused", "Restarting")), "Malformed container state flags")
        settings = container.get("NetworkSettings")
        attachments = settings.get("Networks") if isinstance(settings, dict) else None
        require(isinstance(attachments, dict), "Missing container network inspection")
        # A just-created or just-removed container may not have its endpoint yet.
        if not attachments and state["Status"] != "running" and not state["Running"]:
            continue
        require(set(attachments) == {name}, "A Supabase container has an unexpected or additional network")
        attachment = attachments[name]
        require(isinstance(attachment, dict), "Malformed container network attachment")
        if state["Status"] != "running" and not state["Running"] and attachment.get("NetworkID") == "":
            # Docker create records the requested network before allocating it.
            require(attachment.get("IPAddress") == "", "An unallocated network has a target address")
            continue
        require(attachment.get("NetworkID") == expected_id,
                "Container is not attached to the exact isolated CI network")
        if state["Status"] != "running" or not state["Running"] or state["Paused"] or state["Restarting"]:
            continue
        running.append(container)
        if container_name not in TARGETS:
            continue
        try:
            address = ipaddress.IPv4Address(attachment.get("IPAddress", ""))
        except (ValueError, TypeError):
            raise Failure("Relay target has an invalid IPv4 address") from None
        require(any(address in subnet for subnet in subnets) and not
                (address.is_loopback or address.is_link_local or address.is_multicast or address.is_unspecified),
                "Relay target address is outside the isolated private network")
        member = members.get(identifier)
        # Docker snapshots are not atomic: an endpoint can disappear during reset.
        # Do not forward a connection until both inspections agree.
        if member is None:
            continue
        require(isinstance(member, dict) and member.get("Name") == container_name.lstrip("/"), "Relay network membership mismatch")
        try:
            member_address = ipaddress.IPv4Interface(member.get("IPv4Address", "")).ip
        except (ValueError, TypeError):
            raise Failure("Relay membership has an invalid IPv4 address") from None
        require(member_address == address, "Relay target address and network membership disagree")
        result[container_name] = (str(address), TARGETS[container_name][1])
    if any(item["Name"] == CHECK.DATABASE_CONTAINER for item in running):
        CHECK.validate_isolation(name, networks, running)
    return result


class DockerTargets:
    def __init__(self, name, stopped=None):
        self.name = name
        self.stopped = stopped if stopped is not None else threading.Event()
        network = CHECK.validate_network(name, CHECK.decode_inspection(self.read("inspect", "--type", "network", name)))
        self.network_id = network["Id"]

    def read(self, *arguments):
        require(not self.stopped.is_set(), "Local relay validation was interrupted")
        result = CHECK.docker_read(*arguments)
        require(not self.stopped.is_set(), "Local relay validation was interrupted")
        return result

    def identifiers(self):
        identifiers = self.read("ps", "-aq", "--no-trunc", "--filter", "name=supabase_").splitlines()
        require(len(set(identifiers)) == len(identifiers) and
                all(CHECK.DOCKER_ID_PATTERN.fullmatch(value) for value in identifiers), "Malformed local container selection")
        return identifiers

    def snapshot(self):
        identifiers = self.identifiers()
        for attempt in range(3):
            try:
                raw = self.read("inspect", "--type", "container", *identifiers) if identifiers else "[]"
                break
            except Failure:
                refreshed = self.identifiers()
                # Reset may remove an ID after docker ps. Retry only when that
                # removal is confirmed, never for unchanged/invalid inspection.
                if not set(identifiers) - set(refreshed) or attempt == 2:
                    raise
                identifiers = refreshed
        containers = CHECK.decode_inspection(raw)
        require(isinstance(containers, list) and len(containers) == len(identifiers) and
                all(isinstance(item, dict) for item in containers) and
                {item.get("Id") for item in containers} == set(identifiers), "Incomplete local container inspection")
        networks = CHECK.decode_inspection(self.read("inspect", "--type", "network", self.name))
        return destinations(self.name, self.network_id, networks, containers)

    def resolve(self, target):
        require(target in TARGETS, "Unapproved relay target")
        return self.snapshot().get(target)


def pump(left, right, stopped):
    """Copy opaque TCP bytes, preserving half-closes, until shutdown."""
    peers = {left: right, right: left}
    pending = {left: bytearray(), right: bytearray()}
    reading = {left: True, right: True}
    writing = {left: True, right: True}
    for stream in peers:
        stream.setblocking(False)
    with selectors.DefaultSelector() as selector:
        while not stopped.is_set():
            for stream, peer in peers.items():
                if not reading[peer] and not pending[stream] and writing[stream]:
                    stream.shutdown(socket.SHUT_WR)
                    writing[stream] = False
                mask = (selectors.EVENT_READ if reading[stream] and len(pending[peer]) < 65536 else 0)
                mask |= selectors.EVENT_WRITE if pending[stream] else 0
                if stream in selector.get_map():
                    if mask:
                        selector.modify(stream, mask)
                    else:
                        selector.unregister(stream)
                elif mask:
                    selector.register(stream, mask)
            if not selector.get_map():
                return
            for event, mask in selector.select(0.2):
                stream, peer = event.fileobj, peers[event.fileobj]
                if mask & selectors.EVENT_READ:
                    try:
                        data = stream.recv(65536 - len(pending[peer]))
                        if data:
                            pending[peer].extend(data)
                        else:
                            reading[stream] = False
                    except BlockingIOError:
                        pass
                if mask & selectors.EVENT_WRITE:
                    try:
                        sent = stream.send(pending[stream])
                        del pending[stream][:sent]
                    except BlockingIOError:
                        pass


class Relay:
    def __init__(self, target, resolver, stopped, failures):
        require(target in TARGETS, "Unapproved relay target")
        self.target, self.resolver, self.stopped, self.failures = target, resolver, stopped, failures
        self.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            self.socket.bind(("127.0.0.1", TARGETS[target][0]))
            self.socket.listen(32)
            self.socket.settimeout(0.2)
        except OSError:
            self.socket.close()
            raise Failure("Unable to bind the fixed local relay port") from None
        self.connections, self.workers = set(), []
        self.lock = threading.Lock()
        self.thread = threading.Thread(target=self.accept, name="supabase-loopback-listener", daemon=True)
        self.thread.start()

    def accept(self):
        try:
            while not self.stopped.is_set():
                try:
                    client, _ = self.socket.accept()
                except socket.timeout:
                    continue
                with self.lock:
                    self.connections.add(client)
                    worker = threading.Thread(target=self.forward, args=(client,), name="supabase-loopback-connection", daemon=True)
                    self.workers.append(worker)
                worker.start()
        except Exception:
            if not self.stopped.is_set():
                self.failures.put(Failure("Local relay listener failed"))

    def forward(self, client):
        upstream = None
        try:
            # Never reuse a cached IP after database recreation or reset.
            endpoint = self.resolver.resolve(self.target)
            if endpoint is None or self.stopped.is_set():
                return
            try:
                upstream = socket.create_connection(endpoint, timeout=3)
            except OSError:
                # Running containers may still be starting their application.
                return
            with self.lock:
                self.connections.add(upstream)
            pump(client, upstream, self.stopped)
        except Failure as error:
            self.failures.put(error)
        except OSError:
            # A database restart or a client disconnect closes only this stream.
            pass
        except Exception:
            self.failures.put(Failure("Local relay validation failed (details redacted)"))
        finally:
            for connection in (client, upstream):
                if connection is not None:
                    with self.lock:
                        self.connections.discard(connection)
                    connection.close()

    def close(self):
        self.socket.close()
        self.thread.join(timeout=2)
        with self.lock:
            connections, workers = list(self.connections), list(self.workers)
        for connection in connections:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            connection.close()
        # docker_read has a 30s timeout; stopped prevents subsequent reads.
        deadline = time.monotonic() + 35
        for worker in workers:
            worker.join(timeout=max(0, deadline - time.monotonic()))
        require(not self.thread.is_alive() and not any(worker.is_alive() for worker in workers),
                "Local relay workers failed to stop")


def terminate_group(child):
    if child is None:
        return
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
    # The shell can have exited while a descendant remains in its group.
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    child.wait(timeout=5)


def main():
    stopped, failures = threading.Event(), queue.Queue()
    child, relays = None, {}
    previous_handlers = {}
    result = 1
    try:
        require(len(sys.argv) == 1, "This wrapper accepts no commands or arguments")
        name = CHECK.validate_environment(os.environ)
        require(os.environ.get("DOCKER_HOST") == CHECK.DOCKER_SOCKET, "The local CI Docker socket is required")
        resolver = DockerTargets(name, stopped)
        require(not resolver.snapshot(), "Supabase relay targets already exist before CI bootstrap")
        script = DIRECTORY / "ci-supabase-validation.sh"
        require(script.is_file(), "The fixed CI validation script is missing")
        for signum in (signal.SIGINT, signal.SIGTERM):
            previous_handlers[signum] = signal.signal(signum, lambda *_: stopped.set())
        child = subprocess.Popen(["bash", str(script)], cwd=DIRECTORY.parent.parent, start_new_session=True)
        while child.poll() is None:
            require(not stopped.is_set(), "Local CI validation was interrupted")
            if not failures.empty():
                raise failures.get_nowait()
            for target in resolver.snapshot():
                if target not in relays:
                    relays[target] = Relay(target, resolver, stopped, failures)
                    print(f"PASS restricted loopback relay ready on 127.0.0.1:{TARGETS[target][0]}", flush=True)
            stopped.wait(0.2)
        if not failures.empty():
            raise failures.get_nowait()
        result = child.returncode if child.returncode >= 0 else 1
    except Failure as error:
        print(f"FAIL Supabase loopback isolation: {error}", file=sys.stderr)
    except Exception:
        print("FAIL Supabase loopback isolation: unexpected error (details redacted)", file=sys.stderr)
    finally:
        stopped.set()
        try:
            terminate_group(child)
        except Exception:
            result = 1
            print("FAIL Supabase loopback cleanup: child group did not stop (details redacted)", file=sys.stderr)
        for relay in relays.values():
            try:
                relay.close()
            except Exception:
                result = 1
                print("FAIL Supabase loopback cleanup: relay did not stop (details redacted)", file=sys.stderr)
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)
    return result


if __name__ == "__main__":
    sys.exit(main())
