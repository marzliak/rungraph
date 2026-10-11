"""Verified historical import contract; synthetic sources only."""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/import-launch-wave.py"
spec = importlib.util.spec_from_file_location("wave_import", SCRIPT)
assert spec is not None and spec.loader is not None
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)


class WaveImportTests(unittest.TestCase):
    def fixture(self, root):
        child = str(uuid.uuid4())
        wave = root / "wave" / "WAVE.json"
        wave.parent.mkdir()
        result = wave.parent / "lanes" / "task-a" / "claude-result.json"
        result.parent.mkdir(parents=True)
        result.write_text(json.dumps({"session_id": child, "modelUsage": {"test-model": {}}, "is_error": False}))
        wave.write_text(json.dumps({"model": "test-model", "lanes": {"task-a": {
            "sessionId": child, "status": "child_terminal", "exitCode": 0,
            "startedAt": "2026-01-01T00:00:00Z", "finishedAt": "2026-01-01T00:01:00Z",
            "candidate": str(root / "candidate"), "pid": 12345,
        }}}))
        db_path = root / "state.db"
        db = sqlite3.connect(db_path)
        try:
            db.execute("CREATE TABLE messages (id INTEGER,session_id TEXT,role TEXT,tool_calls TEXT)")
            call = [{"function": {"name": "terminal", "arguments": json.dumps({
                "command": f"python3 {wave.parent / 'run_wave.py'}", "background": True,
            })}}]
            db.execute("INSERT INTO messages VALUES(1,'parent-a','assistant',?)", (json.dumps(call),))
            db.commit()
        finally:
            db.close()
        return {"wave": wave, "db_path": db_path, "parent": "parent-a", "proof_id": 1,
                "registry": root / "links"}

    def test_proof_import_idempotent_and_sources_readonly(self):
        with tempfile.TemporaryDirectory(prefix="rg-import-", dir=os.environ.get("TMPDIR")) as tmp:
            kwargs = self.fixture(Path(tmp))
            db_before = kwargs["db_path"].read_bytes()
            wave_before = kwargs["wave"].read_bytes()
            self.assertEqual(importer.import_wave(**kwargs), 1)
            self.assertEqual(importer.import_wave(**kwargs), 1)
            files = list(kwargs["registry"].glob("*.json"))
            self.assertEqual(len(files), 1)
            record = json.loads(files[0].read_text())
            self.assertEqual((record["source"], record["state"], record["parentSessionId"]),
                             ("verified-import", "completed", "parent-a"))
            self.assertEqual(db_before, kwargs["db_path"].read_bytes())
            self.assertEqual(wave_before, kwargs["wave"].read_bytes())

    def test_wrong_parent_and_child_refused_before_write(self):
        with tempfile.TemporaryDirectory(prefix="rg-import-", dir=os.environ.get("TMPDIR")) as tmp:
            kwargs = self.fixture(Path(tmp))
            with self.assertRaisesRegex(ValueError, "not owned"):
                importer.import_wave(**{**kwargs, "parent": "parent-b"})
            self.assertFalse(kwargs["registry"].exists())
            result = kwargs["wave"].parent / "lanes" / "task-a" / "claude-result.json"
            result.write_text(json.dumps({"session_id": str(uuid.uuid4())}))
            with self.assertRaisesRegex(ValueError, "identity mismatch"):
                importer.import_wave(**kwargs)
            self.assertFalse(kwargs["registry"].exists())


if __name__ == "__main__":
    unittest.main()
