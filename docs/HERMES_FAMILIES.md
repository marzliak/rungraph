# Hermes execution families

This downstream adaptation preserves the upstream graph and transcript adapters and adds an optional observer integration. Model choice and runtime identity are separate: a Hermes run can own native children and persisted Claude Code processes, even when they use different models.

## Connect new Claude Code workers

The viewer and launcher must read/write the **same private registry directory**.
This example uses your home directory, not a system-wide CLI replacement.

From the root of your cloned fork, start the observer:

```bash
export RUNGRAPH_LINKS_DIR="$HOME/.local/state/rungraph/links"
mkdir -p "$RUNGRAPH_LINKS_DIR"
chmod 700 "$RUNGRAPH_LINKS_DIR"
node bin/rungraph.js serve --no-open
```

Then, in the Hermes tool environment that launches a worker, call the launcher
instead of calling the Claude binary directly:

```bash
# Set this to the absolute path of YOUR cloned fork.
RUNGRAPH_CHECKOUT="/path/to/rungraph"
export RUNGRAPH_LINKS_DIR="$HOME/.local/state/rungraph/links"
export RUNGRAPH_CLAUDE_REAL="$(command -v claude)"
export RUNGRAPH_TASK_LABEL="Review tests"
python3 "$RUNGRAPH_CHECKOUT/scripts/rungraph-claude-launch.py" \
  --print "Review the tests in the current project. Do not edit files."
```

The second command makes a real Claude Code call and may incur your usual model
costs. Use a harmless task in your own project. `HERMES_SESSION_ID` must already
identify the real parent in the inherited tool environment; **do not invent a
parent ID** to make a graph look connected. Without that value the launcher
passes the call through without recording a link.

`RUNGRAPH_CLAUDE_REAL` must point to the original executable, not to this launcher
or a wrapper that calls it. Set it before configuring any optional PATH shim.
You do not need root access or to replace a package-owned symlink for this direct
invocation. The launcher preserves stdout/stderr, arguments, signals and terminal
exit status, but adds an exact child UUID when needed for registration.

Open the Hermes parent in the WebUI. A registered child can appear as a connected
placeholder before its persisted transcript is available. Once discovered, its
content becomes inspectable; the child also remains an independent run with a
parent navigation link. The Hermes filter changes the run list, not the parent's
composed family. For older branches in a long graph, press `f` to fit the graph.

Only future calls routed through the launcher are registered by this setup.
Interactive calls, `--continue`, ambiguous resumes and
`--no-session-persistence` calls are not linked. Stop invoking the launcher to
stop creating links; keep existing records private and decide their retention
separately. Stop the viewer with Ctrl+C. Neither step stops existing worker tasks.

## Explicit launch registration

`scripts/rungraph-claude-launch.py` can be invoked by an optional local CLI shim. Set `RUNGRAPH_CLAUDE_REAL` to the real Claude executable (not the shim) and `RUNGRAPH_LINKS_DIR` to a private metadata directory; configure the observer with the same registry directory.

The launcher links only persisted headless `claude -p` / `claude --print` commands that inherit a valid `HERMES_SESSION_ID`. It assigns an exact child UUID before process launch unless an exact `--session-id` or UUID resume was supplied. It preserves standard streams, CLI arguments, signals, exit status and the original executable. Per-invocation files are atomically published with mode 0600, contain no task prompts, and record parent/session IDs, requested model, task name, process identity, start/end time and terminal result.

Provider transports with `--no-session-persistence`, interactive commands, missing/invalid parent identities, ambiguous continue/resume and malformed source IDs are passed through unchanged. Do not claim they were linked. Absolute invocation of the real executable intentionally bypasses the optional observer shim. Package-manager updates may replace a package-owned CLI symlink; deployments must verify the shim after such updates.

## Observation contract

Registry files are observational metadata, not task commands. RunGraph never executes their contents or alters native transcripts. Cross-adapter graphs are joined by exact session IDs, not by matching names, working-directory proximity or time. The parent graph should show children while preserving standalone child navigation.

Execution state and recent transcript activity are different evidence. A long wait must not become “finished” because a recency window expired. Runtime identity uses process start time and boot identity as well as PID; terminal launcher records preserve completed/error outcomes after the process exits. Missing identity or unavailable telemetry is explicitly unknown, not evidence that a task is running or succeeded.

## Verified historical import

`scripts/import-launch-wave.py` imports the documented WAVE launcher format only when an exact assistant tool-call row proves that the specified Hermes parent launched the exact wave. Each child ID must match its actual CLI result and terminal ledger. All inputs are read-only; repeat imports use deterministic link IDs and do not duplicate the graph. This is an explicit migration utility, not automatic discovery of arbitrary historical scripts.

## Tests and scope

Run `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p 'test_*.py'` for launcher/import tests using a fake CLI. No inference calls, user transcripts or private topology are required. JavaScript tests cover the observer/composition and frontend contracts. Launching an observer does not give it control of agents, and registry support does not loosen network or authentication boundaries.
