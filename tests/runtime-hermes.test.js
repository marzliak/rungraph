import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activity } from '../src/adapters/hermes/journal.js';
import { detect, parse } from '../src/adapters/hermes/index.js';
import { bootId, processIdentity } from '../src/procfs.js';

// Synthetic sessions only. Journal and sidecar files are written per test.
// createRequire, not a literal import: vite-node mangles `import('node:sqlite')`
// (see src/sqlite.js). Node < 22.13 has no module → the block is skipped.
let DatabaseSync = null;
try {
  ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite'));
} catch {
  /* unavailable on this Node */
}
const IDENT = await processIdentity(process.pid);
const BOOT = await bootId();
const LIVE = Boolean(IDENT && BOOT);

const NOW = Date.now();
const nowSec = NOW / 1000;

let webui;
let jdir;
let root;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'rg-hjournal-'));
  webui = join(root, 'sessions');
  jdir = join(webui, '_turn_journal');
  await mkdir(jdir, { recursive: true });
  process.env.RUNGRAPH_HERMES_WEBUI_SESSIONS = webui;
});
afterAll(async () => {
  delete process.env.RUNGRAPH_HERMES_WEBUI_SESSIONS;
  await rm(root, { recursive: true, force: true });
});

/** Write one session's journal (+ sidecar). `events` are partial objects. */
async function fixtureSession(sid, { pid, events, sidecarStream, mtimeAgoMs = 0 }) {
  const stream = 'S-' + sid;
  const lines = events.map((e) => JSON.stringify({ version: 1, session_id: sid, turn_id: 'turn', stream_id: stream, ...e }));
  const jpath = join(jdir, `${sid}~${pid}.jsonl`);
  await writeFile(jpath, lines.join('\n') + '\n');
  const when = new Date(NOW - mtimeAgoMs);
  await utimes(jpath, when, when);
  const active = sidecarStream === undefined ? stream : sidecarStream;
  await writeFile(
    join(webui, `${sid}.json`),
    `{"session_id":"${sid}","title":"synthetic","active_stream_id":${active === null ? 'null' : JSON.stringify(active)},"messages":[]}`,
  );
  return stream;
}

const ref = (sid) => ({ runId: `hermes:${sid}`, adapter: 'hermes', kind: 'session', sessionId: sid, dbPath: '/synthetic/state.db' });

describe('hermes journal activity', () => {
  it.skipIf(!LIVE)('a live worker with an open stream is running, even when the journal is quiet for minutes', async () => {
    const stream = await fixtureSession('j-live', {
      pid: process.pid,
      mtimeAgoMs: 10 * 60_000,
      events: [
        { event: 'submitted', created_at: nowSec - 6 },
        { event: 'worker_started', created_at: nowSec - 5 },
        { event: 'assistant_started', created_at: nowSec - 4, assistant_message_index: 3 },
      ],
    });
    const act = await activity(ref('j-live'), { now: NOW });
    expect(act).toMatchObject({ state: 'running', source: 'hermes-journal', streamId: stream, workerPid: process.pid });
  });

  it.skipIf(!LIVE)('a sidecar naming another stream is unknown, not running', async () => {
    await fixtureSession('j-mismatch', {
      pid: process.pid,
      sidecarStream: 'some-other-stream',
      events: [
        { event: 'submitted', created_at: nowSec - 3 },
        { event: 'worker_started', created_at: nowSec - 2 },
      ],
    });
    expect(await activity(ref('j-mismatch'), { now: NOW })).toMatchObject({
      state: 'unknown',
      reason: 'sidecar-stream-mismatch',
    });
  });

  it.skipIf(!LIVE)('a PID that started after its own worker_started is reused: unknown', async () => {
    await fixtureSession('j-reused', {
      pid: process.pid,
      events: [{ event: 'worker_started', created_at: 1000 }],
    });
    expect(await activity(ref('j-reused'), { now: NOW })).toMatchObject({ state: 'unknown', reason: 'pid-reused' });
  });

  it('a completed turn is completed; an interrupted one is error, never success', async () => {
    await fixtureSession('j-done', {
      pid: process.pid,
      events: [
        { event: 'worker_started', created_at: nowSec - 3 },
        { event: 'completed', created_at: nowSec - 1, terminal: true },
      ],
    });
    expect(await activity(ref('j-done'), { now: NOW })).toMatchObject({ state: 'completed' });
    await fixtureSession('j-int', {
      pid: process.pid,
      events: [
        { event: 'worker_started', created_at: nowSec - 3 },
        { event: 'interrupted', created_at: nowSec - 1, terminal: true },
      ],
    });
    expect(await activity(ref('j-int'), { now: NOW })).toMatchObject({ state: 'error', reason: 'interrupted' });
  });

  it('a stream with no worker_started evidence is unknown', async () => {
    await fixtureSession('j-nostart', {
      pid: process.pid,
      events: [{ event: 'submitted', created_at: nowSec - 2 }],
    });
    expect(await activity(ref('j-nostart'), { now: NOW })).toMatchObject({ state: 'unknown', reason: 'no-worker-evidence' });
  });

  it('a dead worker PID is unknown, never running', async () => {
    await fixtureSession('j-dead', {
      pid: 2147483646,
      events: [{ event: 'worker_started', created_at: nowSec - 2 }],
    });
    expect(await activity(ref('j-dead'), { now: NOW })).toMatchObject({ state: 'unknown' });
    expect((await activity(ref('j-dead'), { now: NOW })).state).not.toBe('running');
  });

  it('a journal idle beyond the 12-hour evidence window is no evidence at all', async () => {
    await fixtureSession('j-old', {
      pid: process.pid,
      mtimeAgoMs: 13 * 60 * 60 * 1000,
      events: [{ event: 'worker_started', created_at: nowSec - 3600 * 13 }],
    });
    expect(await activity(ref('j-old'), { now: NOW })).toBeNull();
  });

  it('a session with no journal makes no runtime claim', async () => {
    expect(await activity(ref('j-none'), { now: NOW })).toBeNull();
  });
});

describe.skipIf(!DatabaseSync)('hermes compacted and inactive dispatch anchoring', () => {
  let dbRoot;
  beforeAll(async () => {
    dbRoot = await mkdtemp(join(tmpdir(), 'rg-hcompact-'));
    const db = new DatabaseSync(join(dbRoot, 'state.db'));
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, title TEXT, model TEXT, cwd TEXT,
        parent_session_id TEXT, started_at REAL, ended_at REAL, end_reason TEXT, message_count INTEGER,
        tool_call_count INTEGER, input_tokens INTEGER, output_tokens INTEGER, hidden INTEGER DEFAULT 0,
        last_activity_at REAL);
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT,
        tool_call_id TEXT, tool_calls TEXT, timestamp REAL, token_count INTEGER,
        active INTEGER DEFAULT 1, compacted INTEGER DEFAULT 0, display_kind TEXT);
    `);
    const ins = (table, row) => {
      const keys = Object.keys(row);
      db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(
        ...keys.map((k) => (row[k] === undefined ? null : row[k])),
      );
    };
    // P1: dispatch compacted out of context; the live prompt is a separate, active turn.
    ins('sessions', { id: 'P1', source: 'cli', title: 'compacted parent', started_at: 100, ended_at: 300, message_count: 3 });
    ins('messages', { session_id: 'P1', role: 'user', content: 'old prompt', timestamp: 100, active: 0, compacted: 1 });
    ins('messages', { session_id: 'P1', role: 'assistant', content: 'old reply', timestamp: 110, active: 0, compacted: 1 });
    ins('messages', { session_id: 'P1', role: 'user', content: 'new prompt', timestamp: 200, active: 1, compacted: 0 });
    ins('sessions', { id: 'C1', source: 'subagent', parent_session_id: 'P1', title: 'child goal', started_at: 150, ended_at: 180 });
    ins('messages', { session_id: 'C1', role: 'user', content: 'child goal', timestamp: 151, active: 1 });
    ins('messages', { session_id: 'C1', role: 'assistant', content: 'child done', timestamp: 179, active: 1 });
    // P2: plain inactive (not compacted) history; the child's dispatch has no active turn either.
    ins('sessions', { id: 'P2', source: 'cli', title: 'inactive parent', started_at: 100, ended_at: 300, message_count: 1 });
    ins('messages', { session_id: 'P2', role: 'user', content: 'rewound', timestamp: 100, active: 0, compacted: 0 });
    ins('sessions', { id: 'C2', source: 'subagent', parent_session_id: 'P2', title: 'child two', started_at: 150, ended_at: 180 });
    ins('messages', { session_id: 'C2', role: 'user', content: 'goal two', timestamp: 151, active: 1 });
    // P3: timing alone places a child inside a turn, but supplies no exact dispatch proof.
    ins('sessions', { id: 'P3', source: 'cli', title: 'anchored parent', started_at: 100, ended_at: 300, message_count: 1 });
    ins('messages', { session_id: 'P3', role: 'user', content: 'go', timestamp: 120, active: 1, compacted: 0 });
    ins('sessions', { id: 'C3', source: 'subagent', parent_session_id: 'P3', title: 'child three', started_at: 130, ended_at: 140 });
    ins('messages', { session_id: 'C3', role: 'user', content: 'goal three', timestamp: 131, active: 1 });
    db.close();
  });
  afterAll(async () => {
    await rm(dbRoot, { recursive: true, force: true });
  });

  async function parsed(sid) {
    const refs = await detect([dbRoot]);
    const r = refs.find((x) => x.sessionId === sid);
    return parse(r, { collectDetails: true });
  }

  it('a compacted dispatch anchors to visible history with compacted provenance, not a rewind', async () => {
    const { ir } = await parsed('P1');
    const hist = ir.nodes.find((n) => n.id === 'hist');
    expect(hist.ext.hermes.provenance).toBe('compacted-history');
    expect(ir.edges).toContainEqual(expect.objectContaining({ kind: 'spawn', from: 'hist', to: 'aC1' }));
    expect(ir.nodes.find((n) => n.id === 'aC1')).toBeTruthy();
    // The compacted prompt text is not re-emitted as an active turn.
    expect(ir.nodes.some((n) => n.label === 'old prompt')).toBe(false);
  });

  it('a non-compacted inactive dispatch is labelled inactive-history', async () => {
    const { ir } = await parsed('P2');
    expect(ir.nodes.find((n) => n.id === 'hist').ext.hermes.provenance).toBe('inactive-history');
  });

  it('timing alone never assigns a native child to an active dispatch turn', async () => {
    const { ir } = await parsed('P3');
    expect(ir.nodes.some((n) => n.id === 'hist')).toBe(true);
    const spawn = ir.edges.find((e) => e.kind === 'spawn' && e.to === 'aC3');
    expect(spawn.from).toBe('hist');
  });
});
