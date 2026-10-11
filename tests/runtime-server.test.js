import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.js';
import { CLEAN_RUN_ID, CODEX_FIXTURE_ROOT, FIXTURE_ROOT, SESSION_RUN_ID } from './helpers.js';

// The fixture parent (11111111…) dispatched the fixture child (33333333…) through
// an external launcher link. Synthetic registry only; no real launch happened.
const PARENT_SID = '11111111-1111-4111-8111-111111111111';
const CHILD_SID = '33333333-3333-4333-8333-333333333333';
const LINK_ID = 'fixture-link-1';
const AGENT_ID = `c:${LINK_ID}:agent`;
const LINK = {
  schemaVersion: 1,
  linkId: LINK_ID,
  parentSessionId: PARENT_SID,
  childAdapter: 'claude-code',
  childSessionId: CHILD_SID,
  label: 'fixture child',
  model: 'synthetic-model',
  cwd: null,
  pid: null,
  processStartTicks: null,
  bootId: null,
  state: 'completed',
  startedAt: '2026-08-01T13:00:00.000Z',
  finishedAt: '2026-08-01T13:05:00.000Z',
  exitCode: 0,
  source: 'launcher',
};

let server;
let linksDir;
const linkPath = () => join(linksDir, `${LINK_ID}.json`);

beforeAll(async () => {
  linksDir = await mkdtemp(join(tmpdir(), 'rg-server-links-'));
  await writeFile(linkPath(), JSON.stringify(LINK));
  process.env.RUNGRAPH_LINKS_DIR = linksDir;
  process.env.RUNGRAPH_CLAUDE_PROJECTS = FIXTURE_ROOT;
  process.env.RUNGRAPH_CODEX_SESSIONS = CODEX_FIXTURE_ROOT;
  process.env.RUNGRAPH_HERMES_HOME = '';
  process.env.RUNGRAPH_OPENCODE_HOME = '';
  process.env.RUNGRAPH_CURSOR_GLOBAL_STORAGE = '';
  process.env.RUNGRAPH_CURSOR_CLI_HOME = '';
  server = await startServer({ preferredPort: 0 });
});

afterAll(async () => {
  await server?.close();
  for (const k of [
    'RUNGRAPH_LINKS_DIR',
    'RUNGRAPH_CLAUDE_PROJECTS',
    'RUNGRAPH_CODEX_SESSIONS',
    'RUNGRAPH_HERMES_HOME',
    'RUNGRAPH_OPENCODE_HOME',
    'RUNGRAPH_CURSOR_GLOBAL_STORAGE',
    'RUNGRAPH_CURSOR_CLI_HOME',
  ]) delete process.env[k];
  await rm(linksDir, { recursive: true, force: true });
});

const get = async (path) => {
  const res = await fetch(server.url + path);
  return { status: res.status, body: await res.json() };
};

/** A Server-Sent-Events reader over one open watch connection. */
async function openSse(path) {
  const ac = new AbortController();
  const res = await fetch(server.url + path, { signal: ac.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const next = async (until, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const cut = buf.indexOf('\n\n');
      if (cut >= 0) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const line = block.split('\n').find((l) => l.startsWith('data: '));
        if (line) {
          const msg = JSON.parse(line.slice(6));
          if (until(msg)) return msg;
        }
        continue;
      }
      if (Date.now() > deadline) throw new Error('timed out waiting for an SSE event');
      const { done, value } = await reader.read();
      if (done) throw new Error('SSE stream closed');
      buf += dec.decode(value, { stream: true });
    }
  };
  return { next, close: () => ac.abort() };
}

describe('composed graph over the server', () => {
  it('GET graph shows the linked child under its exact parent, namespaced and connected', async () => {
    const { status, body } = await get(`/api/graph/${encodeURIComponent(SESSION_RUN_ID)}`);
    expect(status).toBe(200);
    const agent = body.nodes.find((n) => n.id === AGENT_ID);
    expect(agent).toBeTruthy();
    expect(agent.ext.runtime).toMatchObject({
      state: 'completed',
      source: 'launcher',
      childRunId: CLEAN_RUN_ID,
      childAvailable: true,
    });
    expect(body.nodes.some((n) => n.id.startsWith(`c:${LINK_ID}:`) && n.id !== AGENT_ID)).toBe(true);
    expect(body.edges).toContainEqual(expect.objectContaining({ kind: 'spawn', to: AGENT_ID }));
    expect(body.meta.ext.runtime).toMatchObject({ linkedChildren: 1, runningChildren: 0 });
    const ids = new Set(body.nodes.map((n) => n.id));
    expect(ids.size).toBe(body.nodes.length);
    expect(body.edges.every((e) => ids.has(e.from) && ids.has(e.to))).toBe(true);
  });

  it('GET detail resolves the composed agent and its namespaced children', async () => {
    const { status, body } = await get(`/api/detail/${encodeURIComponent(AGENT_ID)}?run=${encodeURIComponent(SESSION_RUN_ID)}`);
    expect(status).toBe(200);
    expect(body.kind).toBe('agent');
    expect(body.runtime).toMatchObject({ state: 'completed', childAvailable: true });
  });

  it('the child keeps its standalone listing with parentRunId, and its own graph is unchanged', async () => {
    const index = await get('/api/index');
    const child = index.body.runs.find((r) => r.runId === CLEAN_RUN_ID);
    expect(child.parentRunId).toBe(SESSION_RUN_ID);
    const standalone = await get(`/api/graph/${encodeURIComponent(CLEAN_RUN_ID)}`);
    expect(standalone.status).toBe(200);
    expect(standalone.body.nodes.some((n) => n.id.startsWith('c:'))).toBe(false);
  });

  it('an unknown run still answers with a JSON 404, not a composed graph', async () => {
    const { status } = await get('/api/graph/claude-code:nope:nothing');
    expect(status).toBe(404);
  });
});

describe('live watch follows linked child state without new parent messages', () => {
  it('republishes the agent when the child record changes state', async () => {
    const sse = await openSse(`/api/watch/${encodeURIComponent(SESSION_RUN_ID)}`);
    try {
      const snap = await sse.next((m) => m.type === 'snapshot');
      expect(snap.graph.nodes.find((n) => n.id === AGENT_ID).status).toBe('completed');

      await writeFile(linkPath(), JSON.stringify({ ...LINK, state: 'error', exitCode: 1 }));
      const delta = await sse.next(
        (m) => m.type === 'delta' && (m.nodes ?? []).some((n) => n.id === AGENT_ID && n.status === 'error'),
      );
      const agent = delta.nodes.find((n) => n.id === AGENT_ID);
      expect(agent.ext.runtime.state).toBe('error');
    } finally {
      sse.close();
    }
  }, 30000);
});
