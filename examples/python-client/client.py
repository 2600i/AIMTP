#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import shlex
import socket
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def _exit_with(message: str, code: int = 1) -> None:
    print(message)
    raise SystemExit(code)


def _load_schema(path: Path) -> Dict[str, Any]:
    if not path.exists():
        _exit_with(f"Schema not found: {path}")
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _load_validator(envelope_schema: Dict[str, Any], message_schema: Dict[str, Any]):
    try:
        import jsonschema
    except ImportError:
        _exit_with(
            "Missing dependency: jsonschema\n"
            "Install it with: python3 -m pip install jsonschema"
        )

    try:
        DraftValidator = jsonschema.Draft202012Validator
    except AttributeError:
        _exit_with(
            "jsonschema is too old for draft 2020-12.\n"
            "Upgrade with: python3 -m pip install --upgrade jsonschema"
        )

    try:
        from referencing import Registry, Resource
        from referencing.jsonschema import DRAFT202012
    except Exception:
        _exit_with(
            "Missing dependency: referencing (required by jsonschema >= 4.18).\n"
            "Install it with: python3 -m pip install referencing"
        )

    store = {
        envelope_schema.get("$id"): envelope_schema,
        message_schema.get("$id"): message_schema,
    }

    registry = Registry()
    for schema_id, schema in store.items():
        if not schema_id:
            continue
        resource = Resource.from_contents(schema, default_specification=DRAFT202012)
        registry = registry.with_resource(schema_id, resource)

    return DraftValidator(envelope_schema, registry=registry)


def _build_envelope() -> Dict[str, Any]:
    now = datetime.now(timezone.utc).isoformat()
    task_id = str(uuid.uuid4())

    return {
        "spec": "aimtp/0.1",
        "id": str(uuid.uuid4()),
        "timestamp": now,
        "sender": "python-client",
        "recipient": "aimtp-relay",
        "intent": "task.request",
        "message": {
            "id": str(uuid.uuid4()),
            "role": "user",
            "content": "Ping from the AIMTP Python demo client.",
            "content_type": "text/plain",
        },
        "task": {
            "kind": "request",
            "id": task_id,
            "type": "echo",
            "input": {"text": "Hello from Python"},
            "expects_response": True,
            "metadata": {"source": "examples/python-client"},
        },
        "signature": {
            "key_id": "demo-key",
            "signature": "not-signed",
            "alg": "none",
        },
        "metadata": {
            "demo": True,
            "client": "python-stdlib",
        },
    }


def _post_json(url: str, payload: Dict[str, Any], api_key: str = "") -> Dict[str, Any]:
    data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["X-AIMTP-KEY"] = api_key
    req = Request(url, data=data, headers=headers, method="POST")

    try:
        with urlopen(req, timeout=30) as resp:
            body = resp.read().decode("utf-8")
    except HTTPError as exc:
        body = exc.read().decode("utf-8") if exc.fp else ""
        _exit_with(f"Relay returned HTTP {exc.code}: {body or exc.reason}")
    except URLError as exc:
        _exit_with(f"Failed to reach relay: {exc.reason}")

    try:
        return json.loads(body)
    except json.JSONDecodeError:
        _exit_with(f"Relay response was not valid JSON: {body}")


def _parse_host_port(url: str) -> Tuple[str, int]:
    from urllib.parse import urlparse

    parsed = urlparse(url)
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    return host, port


def _wait_for_port(host: str, port: int, timeout_seconds: float = 5.0) -> bool:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.2):
                return True
        except OSError:
            time.sleep(0.1)
    return False


def _tail_lines(lines: Iterable[str], max_lines: int = 40) -> List[str]:
    data = list(lines)
    if len(data) <= max_lines:
        return data
    return data[-max_lines:]


def _format_relay_logs(stdout: str, stderr: str) -> str:
    blocks = []
    if stdout.strip():
        blocks.append("Relay stdout (tail):")
        blocks.extend(_tail_lines(stdout.splitlines()))
    if stderr.strip():
        blocks.append("Relay stderr (tail):")
        blocks.extend(_tail_lines(stderr.splitlines()))
    return "\n".join(blocks).rstrip()


def _start_relay(command: str, cwd: Path, api_key: str = "") -> subprocess.Popen:
    args = shlex.split(command)
    if not args:
        _exit_with("AIMTP_RELAY_CMD is empty.")
    env = dict(os.environ)
    if api_key:
        env["AIMTP_API_KEY"] = api_key
    try:
        return subprocess.Popen(
            args,
            cwd=str(cwd),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )
    except FileNotFoundError as exc:
        _exit_with(f"Failed to start relay: {exc}")


def _stop_relay(proc: subprocess.Popen, timeout_seconds: float = 2.0) -> None:
    if proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=timeout_seconds)


def _collect_relay_logs(proc: subprocess.Popen, timeout_seconds: float = 1.0) -> Tuple[str, str]:
    try:
        stdout, stderr = proc.communicate(timeout=timeout_seconds)
        return stdout or "", stderr or ""
    except subprocess.TimeoutExpired:
        proc.kill()
        stdout, stderr = proc.communicate(timeout=timeout_seconds)
        return stdout or "", stderr or ""


def _validation_errors(validator, payload: Dict[str, Any]) -> List[str]:
    return [err.message for err in validator.iter_errors(payload)]


def _parse_start_relay(argv: List[str]) -> bool:
    for arg in argv:
        if arg == "--start-relay":
            return True
        if arg.startswith("--start-relay="):
            value = arg.split("=", 1)[1].strip().lower()
            if value in {"1", "true", "yes", "on"}:
                return True
            if value in {"0", "false", "no", "off"}:
                return False
            _exit_with("Invalid value for --start-relay. Use true/false.")
    return True


def _validate_response(
    validator, payload: Any
) -> List[str]:
    errors: List[str] = []
    if isinstance(payload, list):
        for idx, item in enumerate(payload):
            if not isinstance(item, dict):
                errors.append(f"response[{idx}] is not an object")
                continue
            for err in validator.iter_errors(item):
                errors.append(f"response[{idx}]: {err.message}")
        return errors
    if isinstance(payload, dict):
        return [err.message for err in validator.iter_errors(payload)]
    return ["response is not an object or array"]


def _validate_acceptance(payload: Any, envelope_id: str) -> List[str]:
    """POST /aimtp returns a 202 acceptance receipt, not an envelope."""
    if not isinstance(payload, dict):
        return ["acceptance response is not an object"]
    errors: List[str] = []
    if payload.get("status") != "accepted":
        errors.append(f'expected status "accepted", got {payload.get("status")!r}')
    if payload.get("queued") is not True:
        errors.append(f'expected queued true, got {payload.get("queued")!r}')
    if payload.get("id") != envelope_id:
        errors.append(
            f'acceptance id {payload.get("id")!r} does not match sent envelope {envelope_id!r}'
        )
    return errors


def _get_json(url: str, api_key: str = "") -> Any:
    headers = {}
    if api_key:
        headers["X-AIMTP-KEY"] = api_key
    req = Request(url, headers=headers, method="GET")
    try:
        with urlopen(req, timeout=30) as resp:
            body = resp.read().decode("utf-8")
    except HTTPError as exc:
        body = exc.read().decode("utf-8") if exc.fp else ""
        _exit_with(f"Relay returned HTTP {exc.code}: {body or exc.reason}")
    except URLError as exc:
        _exit_with(f"Failed to reach relay: {exc.reason}")
    if not body:
        return None
    try:
        return json.loads(body)
    except json.JSONDecodeError as exc:
        _exit_with(f"Relay returned invalid JSON: {exc}")


def main() -> None:
    start_relay = _parse_start_relay(sys.argv[1:])
    root = Path(__file__).resolve().parents[2]
    schema_dir = root / "schemas"
    envelope_schema = _load_schema(schema_dir / "envelope.schema.json")
    message_schema = _load_schema(schema_dir / "message.schema.json")

    validator = _load_validator(envelope_schema, message_schema)

    envelope = _build_envelope()
    relay_url = os.getenv("AIMTP_RELAY_URL", "http://localhost:8787/aimtp")
    relay_cmd = os.getenv("AIMTP_RELAY_CMD", "node dist/runtime/relay.js")
    # The relay is fail-closed: with no API key configured it rejects every
    # request with 401. Use a demo key by default so this runs standalone.
    api_key = os.getenv("AIMTP_API_KEY", "").strip() or "demo-key"
    relay_proc: Optional[subprocess.Popen] = None
    relay_started = False
    failed = False

    print(f"URL: {relay_url}")

    try:
        if start_relay:
            relay_proc = _start_relay(relay_cmd, root, api_key)
            relay_started = True

        request_errors = _validation_errors(validator, envelope)
        print(f"Relay started: {'yes' if relay_started else 'no'}")
        print(f"request errors: {request_errors}")

        if request_errors:
            _exit_with("Request validation failed.")

        host, port = _parse_host_port(relay_url)
        if not _wait_for_port(host, port, timeout_seconds=5.0):
            _exit_with(f"Relay not ready on {host}:{port}")

        # 1. POST the envelope. The relay validates and enqueues it, returning
        #    a 202 acceptance receipt (not a response envelope).
        response = _post_json(relay_url, envelope, api_key)
        acceptance_errors = _validate_acceptance(response, envelope["id"])
        print(f"acceptance errors: {acceptance_errors}")
        if acceptance_errors:
            _exit_with("Acceptance validation failed.")

        # 2. Poll it back out of the mailbox and validate the round-tripped
        #    envelope against the same schemas. This is the actual interop
        #    proof: an envelope built in Python survives the Node relay
        #    unchanged and still validates.
        recipient = envelope["recipient"]
        poll_url = f"{relay_url}/poll?recipient={recipient}&max=1"
        polled = _get_json(poll_url, api_key)
        if not isinstance(polled, list) or not polled:
            _exit_with(f"Expected a leased message from poll, got: {polled!r}")

        leased = polled[0]
        round_tripped = leased.get("envelope")
        response_errors = _validate_response(validator, round_tripped)
        print(f"round-trip errors: {response_errors}")
        if response_errors:
            _exit_with("Validation failed.")

        if round_tripped.get("id") != envelope["id"]:
            _exit_with(
                f'round-tripped id {round_tripped.get("id")!r} != sent {envelope["id"]!r}'
            )

        # 3. Acknowledge the lease so the queue drains.
        ack_url = f"{relay_url}/ack"
        ack = _post_json(ack_url, {"recipient": recipient, "lease_id": leased["lease_id"]}, api_key)
        print(f"ack: {ack.get('status')}")

        print("OK")
    except SystemExit:
        failed = True
        raise
    except Exception:
        failed = True
        raise
    finally:
        if relay_proc:
            _stop_relay(relay_proc)
            if failed:
                stdout, stderr = _collect_relay_logs(relay_proc)
                log_text = _format_relay_logs(stdout, stderr)
                if log_text:
                    print(log_text)


if __name__ == "__main__":
    main()
