#!/usr/bin/env python3
"""Observe persisted headless Claude launches without logging prompts or changing tools.

An optional PATH shim calls this script; the real CLI is never replaced. A per-call
HERMES_SESSION_ID (inherited from Hermes' tool environment) establishes parentage.
The observer cannot infer ownership of manually launched or anonymous processes.
"""
from __future__ import annotations

import datetime
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import uuid

SID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
DEFAULT_REAL = "/usr/bin/claude"


def option(args: list[str], name: str) -> str | None:
    for i, arg in enumerate(args):
        if arg.startswith(name + "="):
            return arg[len(name) + 1:]
        if arg == name and i + 1 < len(args):
            return args[i + 1]
    return None


def identity_plan(args: list[str], env: dict[str, str]) -> tuple[str, str, list[str]] | None:
    """Only unambiguously identified persisted noninteractive agent runs are linked."""
    parent = env.get("HERMES_SESSION_ID", "")
    if not SID_RE.fullmatch(parent):
        return None
    if "-p" not in args and "--print" not in args:
        return None
    if any(a.split("=", 1)[0] == "--no-session-persistence" for a in args):
        return None  # Provider transport, not an independent persisted CLI agent.
    if any(a in args for a in ("-c", "--continue")):
        return None  # Last-session selection does not establish a durable exact ID.
    chosen = option(args, "--session-id")
    resumed = option(args, "--resume") or option(args, "-r")
    if any(a.split("=", 1)[0] in ("--resume", "-r") for a in args) and not resumed:
        return None
    if chosen and resumed:
        return None  # Preserve CLI's own validation instead of repairing arguments.
    child = chosen or resumed
    if child:
        try:
            uuid.UUID(child)
        except (ValueError, AttributeError):
            return None
        return parent, child, list(args)
    child = str(uuid.uuid4())
    return parent, child, ["--session-id", child, *args]


def timestamp() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds")


def process_identity(pid: int) -> tuple[str | None, str | None]:
    try:
        # /proc comm can contain spaces or parentheses: fields begin AFTER last ')'.
        tail = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        ticks = tail[19]  # starttime, field 22 (tail starts at state, field 3).
        boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        return ticks, boot
    except (OSError, IndexError):
        return None, None


def save_record(directory: Path, record: dict) -> None:
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = directory / (record["linkId"] + ".json")
    fd, tmp = tempfile.mkstemp(prefix=".publish-", dir=directory)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(record, f, ensure_ascii=False)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass


def main(args: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if args is None else args)
    real = os.environ.get("RUNGRAPH_CLAUDE_REAL", DEFAULT_REAL)
    if Path(real).resolve() == Path(sys.argv[0]).resolve():
        print("rungraph launcher: recursive CLI configuration refused", file=sys.stderr)
        return 126
    plan = identity_plan(args, dict(os.environ))
    if plan is None:
        os.execv(real, [real, *args])
        return 127  # unreachable
    parent, child_id, child_args = plan
    directory = Path(os.environ.get("RUNGRAPH_LINKS_DIR", str(Path.home() / ".local/state/rungraph/links")))
    record = {
        "schemaVersion": 1,
        "linkId": str(uuid.uuid4()),
        "parentSessionId": parent,
        "childAdapter": "claude-code",
        "childSessionId": child_id,
        "label": (os.environ.get("RUNGRAPH_TASK_LABEL") or option(args, "--name") or "Claude Code")[:160],
        "model": option(args, "--model"),
        "cwd": str(Path.cwd()),
        "pid": None,
        "processStartTicks": None,
        "bootId": None,
        "state": "unknown",
        "startedAt": timestamp(),
        "finishedAt": None,
        "exitCode": None,
        "source": "launcher",
    }
    try:
        # stdout/stderr/stdin inherited byte-for-byte. No prompt capture or decoding.
        child = subprocess.Popen([real, *child_args])
    except OSError as exc:
        record.update(state="error", finishedAt=timestamp(), exitCode=127)
        try:
            save_record(directory, record)
        except OSError:
            pass
        print(f"rungraph launcher: CLI launch failed ({type(exc).__name__})", file=sys.stderr)
        return 127
    ticks, boot = process_identity(child.pid)
    record.update(pid=child.pid, processStartTicks=ticks, bootId=boot, state="running")

    def publish() -> None:
        try:
            save_record(directory, record)
        except OSError as exc:
            # Telemetry failure must not kill an otherwise valid user task.
            print(f"rungraph launcher: link unavailable ({type(exc).__name__})", file=sys.stderr)

    publish()

    def forward(sig: int, _frame) -> None:
        if child.poll() is None:
            try:
                child.send_signal(sig)
            except ProcessLookupError:
                pass

    previous = {sig: signal.signal(sig, forward) for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)}
    try:
        rc = child.wait()
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)
    record.update(state="completed" if rc == 0 else "error", finishedAt=timestamp(), exitCode=rc)
    publish()
    return rc if rc >= 0 else 128 - rc


if __name__ == "__main__":
    raise SystemExit(main())
