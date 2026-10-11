#!/usr/bin/env python3
"""Import an existing launcher WAVE ledger with an exact Hermes launch-message proof.

Read-only sources; writes only link metadata. Never infer parentage from recency.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shlex
import sqlite3
import uuid


def import_wave(*, wave: Path, db_path: Path, parent: str, proof_id: int, registry: Path) -> int:
    spec = importlib.util.spec_from_file_location("rg_launcher", Path(__file__).with_name("rungraph-claude-launch.py"))
    assert spec is not None and spec.loader is not None
    launcher = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(launcher)
    if not launcher.SID_RE.fullmatch(parent):
        raise ValueError("invalid parent token")
    db = sqlite3.connect(db_path.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        row = db.execute("SELECT tool_calls FROM messages WHERE id=? AND session_id=? AND role='assistant'",
                         (proof_id, parent)).fetchone()
        if row is None:
            raise ValueError("launch proof not owned by parent")
        target = str(wave.parent / "run_wave.py")
        proven = False
        for call in json.loads(row[0] or "[]"):
            function = call.get("function", {})
            if function.get("name") != "terminal":
                continue
            args = json.loads(function.get("arguments", "{}"))
            command = args.get("command", "")
            if target in shlex.split(command) and args.get("background") is True:
                proven = True
        if not proven:
            raise ValueError("message does not prove launch of exact wave")
    finally:
        db.close()
    ledger_bytes = wave.read_bytes()
    ledger = json.loads(ledger_bytes)
    lanes = ledger.get("lanes")
    if not isinstance(lanes, dict) or not lanes:
        raise ValueError("empty or malformed wave")
    planned = []
    for key, lane in lanes.items():
        child_id = lane.get("sessionId")
        if not isinstance(child_id, str):
            raise ValueError(f"missing child identity: {key}")
        uuid.UUID(child_id)
        if lane.get("status") != "child_terminal" or not isinstance(lane.get("exitCode"), int):
            raise ValueError(f"no terminal execution proof: {key}")
        result_file = wave.parent / "lanes" / key / "claude-result.json"
        result = json.loads(result_file.read_text())
        if result.get("session_id") != child_id:
            raise ValueError(f"child result identity mismatch: {key}")
        models = list(result.get("modelUsage", {}))
        error = lane["exitCode"] != 0 or result.get("is_error") is True
        link_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"hermes:{parent}/claude-code:{child_id}"))
        planned.append({
            "schemaVersion": 1, "linkId": link_id,
            "parentSessionId": parent, "childAdapter": "claude-code", "childSessionId": child_id,
            "label": str(key), "model": models[0] if len(models) == 1 else ledger.get("model"),
            "cwd": lane.get("candidate"), "pid": lane.get("pid"),
            "processStartTicks": None, "bootId": None,
            "state": "error" if error else "completed",
            "startedAt": lane["startedAt"], "finishedAt": lane["finishedAt"],
            "exitCode": lane["exitCode"], "source": "verified-import",
            "proofMessageId": proof_id,
            "proofLedgerSHA256": hashlib.sha256(ledger_bytes).hexdigest(),
        })
    # Validate all records before publishing any, then atomic file per link.
    for record in planned:
        launcher.save_record(registry, record)
    return len(planned)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--wave", type=Path, required=True)
    p.add_argument("--db", type=Path, required=True)
    p.add_argument("--parent", required=True)
    p.add_argument("--proof-message-id", type=int, required=True)
    p.add_argument("--registry", type=Path, required=True)
    a = p.parse_args()
    count = import_wave(wave=a.wave, db_path=a.db, parent=a.parent,
                        proof_id=a.proof_message_id, registry=a.registry)
    print(json.dumps({"imported": count, "parentSessionId": a.parent}))


if __name__ == "__main__":
    main()
