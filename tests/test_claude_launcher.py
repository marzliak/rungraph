"""Hermetic launcher contract. Fake CLI only; never makes inference calls."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/rungraph-claude-launch.py"
spec = importlib.util.spec_from_file_location("launcher", SCRIPT)
assert spec is not None and spec.loader is not None
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class LauncherTests(unittest.TestCase):
    def test_identity_and_exclusions(self):
        env = {"HERMES_SESSION_ID": "parent-a"}
        plan = launcher.identity_plan(["-p", "task", "--model", "test-model"], env)
        self.assertEqual(plan[0], "parent-a")
        self.assertEqual(uuid.UUID(plan[1]).version, 4)
        self.assertEqual(plan[2][:2], ["--session-id", plan[1]])
        for args, child_env in [(["--version"], env), (["-p", "task"], {}),
                               (["-p", "--no-session-persistence", "task"], env),
                               (["-p", "--no-session-persistence=true", "task"], env),
                               (["-p", "--continue", "task"], env),
                               (["-p", "--resume", "not-a-uuid"], env),
                               (["-p", "--session-id", "bad-token"], env),
                               (["-p", "task"], {"HERMES_SESSION_ID": "../../unsafe"})]:
            self.assertIsNone(launcher.identity_plan(args, child_env))
        sid = str(uuid.uuid4())
        for opt in ("--session-id", "--resume", "-r"):
            args = ["-p", opt, sid, "task"]
            p = launcher.identity_plan(args, env)
            self.assertEqual((p[1], p[2]), (sid, args))

    def create_fake(self, root):
        fake = root / "fake-cli.py"
        fake.write_text("#!/usr/bin/env python3\nimport sys,time,json,os\n"
                        "print(json.dumps({'args':sys.argv[1:]}),flush=True)\n"
                        "time.sleep(float(os.environ.get('FAKE_WAIT','0')))\n"
                        "sys.exit(int(os.environ.get('FAKE_RC','0')))\n")
        fake.chmod(0o700)
        return fake

    def launch_env(self, root, fake, parent="parent-a", rc="0", wait="0"):
        return {**os.environ, "RUNGRAPH_CLAUDE_REAL": str(fake),
                "RUNGRAPH_LINKS_DIR": str(root / "links"), "HERMES_SESSION_ID": parent,
                "FAKE_RC": rc, "FAKE_WAIT": wait, "PYTHONDONTWRITEBYTECODE": "1"}

    def test_real_process_and_terminal_metadata(self):
        with tempfile.TemporaryDirectory(prefix="rg-launcher-", dir=os.environ.get("TMPDIR")) as tmp:
            root = Path(tmp)
            fake = self.create_fake(root)
            p = subprocess.Popen([sys.executable, str(SCRIPT), "-p", "prompt-not-in-ledger", "--model", "test-model"],
                                 env=self.launch_env(root, fake, wait="1"), cwd=root,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                deadline = time.monotonic() + 3
                records = []
                while time.monotonic() < deadline:
                    records = list((root / "links").glob("*.json"))
                    if records:
                        break
                    time.sleep(0.02)
                self.assertEqual(len(records), 1)
                record = json.loads(records[0].read_text())
                self.assertEqual(record["state"], "running")
                self.assertEqual(record["parentSessionId"], "parent-a")
                self.assertEqual(launcher.process_identity(record["pid"]),
                                 (record["processStartTicks"], record["bootId"]))
                self.assertNotIn("prompt-not-in-ledger", records[0].read_text())
                out, err = p.communicate(timeout=5)
                self.assertEqual((p.returncode, err), (0, ""))
                self.assertIn(record["childSessionId"], out)
                final = json.loads(records[0].read_text())
                self.assertEqual((final["state"], final["exitCode"]), ("completed", 0))
                self.assertIsNotNone(final["finishedAt"])
                self.assertEqual(records[0].stat().st_mode & 0o777, 0o600)
            finally:
                if p.poll() is None:
                    p.kill()
                    p.communicate()

    def test_parallel_parents_and_failure_passthrough(self):
        with tempfile.TemporaryDirectory(prefix="rg-launcher-", dir=os.environ.get("TMPDIR")) as tmp:
            root = Path(tmp)
            fake = self.create_fake(root)
            jobs = [subprocess.Popen([sys.executable, str(SCRIPT), "-p", "task"],
                                     env=self.launch_env(root, fake, parent, rc, "0.1"), cwd=root,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                    for parent, rc in (("parent-a", "0"), ("parent-b", "7"))]
            for p, rc in zip(jobs, (0, 7)):
                p.communicate(timeout=5)
                self.assertEqual(p.returncode, rc)
            records = [json.loads(p.read_text()) for p in (root / "links").glob("*.json")]
            self.assertEqual(len(records), 2)
            self.assertEqual({r["parentSessionId"] for r in records}, {"parent-a", "parent-b"})
            self.assertEqual({r["state"] for r in records}, {"completed", "error"})
            self.assertEqual(len({r["childSessionId"] for r in records}), 2)

    def test_direct_sdk_and_unowned_unchanged(self):
        with tempfile.TemporaryDirectory(prefix="rg-launcher-", dir=os.environ.get("TMPDIR")) as tmp:
            root = Path(tmp)
            fake = self.create_fake(root)
            for args, parent in ((["-p", "--no-session-persistence", "task"], "parent-a"),
                                 (["--version"], "parent-a"), (["-p", "task"], "")):
                p = subprocess.run([sys.executable, str(SCRIPT), *args],
                                   env=self.launch_env(root, fake, parent), cwd=root, capture_output=True, text=True)
                self.assertEqual(p.returncode, 0)
                self.assertEqual(json.loads(p.stdout)["args"], args)
            self.assertFalse((root / "links").exists())

    def test_signal_forwarding_and_no_false_completion(self):
        with tempfile.TemporaryDirectory(prefix="rg-launcher-", dir=os.environ.get("TMPDIR")) as tmp:
            root = Path(tmp)
            fake = self.create_fake(root)
            p = subprocess.Popen([sys.executable, str(SCRIPT), "-p", "task"],
                                 env=self.launch_env(root, fake, wait="10"), cwd=root,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                assert p.stdout is not None
                p.stdout.readline()
                deadline = time.monotonic() + 2
                records = []
                while time.monotonic() < deadline:
                    records = list((root / "links").glob("*.json"))
                    if records:
                        break
                    time.sleep(0.01)
                self.assertEqual(len(records), 1)
                p.send_signal(signal.SIGTERM)
                p.communicate(timeout=3)
                self.assertEqual(p.returncode, 143)
                r = json.loads(records[0].read_text())
                self.assertEqual((r["state"], r["exitCode"]), ("error", -signal.SIGTERM))
                self.assertIsNone(launcher.process_identity(r["pid"])[0])
            finally:
                if p.poll() is None:
                    p.kill()
                    p.communicate()


if __name__ == "__main__":
    unittest.main()
