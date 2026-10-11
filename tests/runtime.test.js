import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  annotateRuntime,
  composeRuntime,
  evaluateLink,
  readLinks,
  resolveChild,
  validateLink,
} from '../src/runtime.js';
import { bootId, processIdentity } from '../src/procfs.js';
import { toIndexEntry } from '../src/scanner.js';

// Synthetic identifiers only — no real session ids, paths or transcripts.
const ISO = '2026-10-11T12:00:00.000Z';
const FINISHED = '2026-10-11T12:01:00.000Z';
const IDENT = await processIdentity(process.pid);
const BOOT = await bootId();
const LIVE = Boolean(IDENT && BOOT); // Linux with /proc: real PID identity is checkable

function link(over = {}) {
  return {
    schemaVersion: 1,
    linkId: 'l1',
    parentSessionId: 'parent-1',
    childAdapter: 'claude-code',
    childSessionId: 'child-1',
    label: 'child work',
    model: 'synthetic-model',
    cwd: '/synthetic/project',
    pid: null,
    processStartTicks: null,
    bootId: null,
    state: 'completed',
    startedAt: ISO,
    finishedAt: FINISHED,
    exitCode: 0,
    source: 'launcher',
    ...over,
  };
}

const childRef = (over = {}) => ({
  runId: 'claude-code:synthetic-project:child-1',
  adapter: 'claude-code',
  kind: 'session',
  sessionId: 'child-1',
  project: '/synthetic/project',
  title: 'child title',
  modifiedAt: '2026-10-11T10:00:00.000Z',
  ...over,
});

const parentRef = (over = {}) => ({
  runId: 'hermes:parent-1',
  adapter: 'hermes',
  kind: 'session',
  sessionId: 'parent-1',
  project: '/synthetic/project',
  modifiedAt: ISO,
  activity: { state: 'unknown', source: 'hermes-journal', reason: 'no-worker-evidence' },
  ...over,
});

function parentIR() {
  return {
    irVersion: 1,
    meta: {
      runId: 'hermes:parent-1',
      adapter: 'hermes',
      kind: 'session',
      title: 'parent',
      totals: { tokens: 0, toolCalls: 0, agents: 0 },
      unrecognizedLineCount: 0,
      ext: {},
    },
    nodes: [
      { id: 'm1', kind: 'turn', label: 'first', status: 'completed', startedAt: '2026-10-11T11:00:00.000Z' },
      { id: 'm2', kind: 'turn', label: 'second', status: 'completed', startedAt: '2026-10-11T11:30:00.000Z' },
      { id: 'aN', kind: 'agent', label: 'native', status: 'completed', endedAt: '2026-10-11T11:20:00.000Z', agentId: 'native-1' },
      { id: 'aO', kind: 'agent', label: 'open', status: 'running', agentId: 'open-1' },
    ],
    edges: [{ id: 'e:sequence:m1→m2', kind: 'sequence', from: 'm1', to: 'm2' }],
    groups: [],
  };
}

function childIR() {
  return {
    irVersion: 1,
    meta: {
      runId: 'claude-code:synthetic-project:child-1',
      adapter: 'claude-code',
      kind: 'session',
      title: 'child',
      totals: { tokens: 0, toolCalls: 0, agents: 0 },
      unrecognizedLineCount: 0,
    },
    nodes: [
      { id: 'c1', kind: 'turn', label: 'child prompt', status: 'completed' },
      { id: 't1', kind: 'tool', label: 'Bash', status: 'completed', callCount: 1, errorCount: 0 },
    ],
    edges: [{ id: 'e:sequence:c1→t1', kind: 'sequence', from: 'c1', to: 't1' }],
    groups: [],
  };
}

const parseRef = async () => ({
  ir: childIR(),
  details: new Map([['c1', { kind: 'turn', prompt: 'child prompt', responseText: '' }]]),
});

describe('validateLink', () => {
  it('accepts the schema and rejects each out-of-contract field', () => {
    expect(validateLink(link()).ok).toBe(true);
    expect(validateLink({ ...link(), schemaVersion: 2 }).ok).toBe(false);
    expect(validateLink({ ...link(), childAdapter: 'codex' }).ok).toBe(false);
    expect(validateLink({ ...link(), state: 'paused' }).ok).toBe(false);
    expect(validateLink({ ...link(), source: 'guess' }).ok).toBe(false);
    expect(validateLink({ ...link(), processStartTicks: 12345 }).ok).toBe(false);
    expect(validateLink({ ...link(), startedAt: 'yesterday' }).ok).toBe(false);
  });
});

describe('readLinks registry', () => {
  let dir;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rg-links-'));
    await writeFile(join(dir, 'a.json'), JSON.stringify(link({ linkId: 'l1' })));
    await writeFile(join(dir, 'b.json'), JSON.stringify(link({ linkId: 'l1' }))); // duplicate
    await writeFile(join(dir, 'c.json'), '{not json');
    await writeFile(join(dir, 'd.json'), JSON.stringify(link({ linkId: 'l9', state: 'paused' })));
    await writeFile(join(dir, 'e.json'), JSON.stringify(link({ linkId: 'l2', childSessionId: 'child-2' })));
    process.env.RUNGRAPH_LINKS_DIR = dir;
  });
  afterAll(async () => {
    delete process.env.RUNGRAPH_LINKS_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps valid unique links and reports the rest by ordinal, never by path', async () => {
    const { links, warnings } = await readLinks();
    expect(links.map((l) => l.linkId)).toEqual(['l1', 'l2']);
    expect(warnings.length).toBeGreaterThanOrEqual(3);
    for (const w of warnings) expect(w.reason).not.toContain(dir);
  });

  it('reads nothing when no registry is configured', async () => {
    delete process.env.RUNGRAPH_LINKS_DIR;
    expect(await readLinks()).toEqual({ links: [], warnings: [] });
    process.env.RUNGRAPH_LINKS_DIR = dir;
  });
});

describe('evaluateLink runtime truth', () => {
  it('terminal records prevail, but a contradictory terminal record is unknown', async () => {
    expect(await evaluateLink(link())).toEqual({ state: 'completed', source: 'launcher' });
    expect(await evaluateLink(link({ state: 'error', exitCode: 2 }))).toMatchObject({ state: 'error' });
    expect(await evaluateLink(link({ finishedAt: null }))).toMatchObject({ state: 'unknown', reason: 'terminal-without-finish' });
    expect(await evaluateLink(link({ exitCode: 1 }))).toMatchObject({ state: 'unknown', reason: 'terminal-contradiction' });
    expect(await evaluateLink(link({ state: 'error', exitCode: 0 }))).toMatchObject({ state: 'unknown', reason: 'terminal-contradiction' });
  });

  it('a failed-before-start record is unknown, never running or failed', async () => {
    expect(await evaluateLink(link({ state: 'unknown', finishedAt: null, exitCode: null }))).toMatchObject({
      state: 'unknown',
      reason: 'failed-before-start',
    });
  });

  it('a running record without identity is unknown', async () => {
    expect(await evaluateLink(link({ state: 'running', finishedAt: null, exitCode: null }))).toMatchObject({
      state: 'unknown',
      reason: 'identity-missing',
    });
  });

  it('a running record whose process is gone is unknown, not running', async () => {
    const rt = await evaluateLink(
      link({ state: 'running', finishedAt: null, exitCode: null, pid: 2147483646, processStartTicks: '1', bootId: BOOT ?? 'x' }),
    );
    expect(rt.state).toBe('unknown');
  });

  it('a boot-id mismatch is unknown on every platform', async () => {
    const rt = await evaluateLink(
      link({ state: 'running', finishedAt: null, exitCode: null, pid: process.pid, processStartTicks: IDENT?.startTicks ?? '1', bootId: 'another-boot' }),
    );
    expect(rt.state).toBe('unknown');
  });

  it.skipIf(!LIVE)('a live PID with the recorded start ticks on this boot is running', async () => {
    const rt = await evaluateLink(
      link({ state: 'running', finishedAt: null, exitCode: null, pid: process.pid, processStartTicks: IDENT.startTicks, bootId: BOOT }),
    );
    expect(rt).toEqual({ state: 'running', source: 'launcher' });
  });

  it.skipIf(!LIVE)('a reused PID (different start ticks) is unknown, never running', async () => {
    const rt = await evaluateLink(
      link({ state: 'running', finishedAt: null, exitCode: null, pid: process.pid, processStartTicks: '1', bootId: BOOT }),
    );
    expect(rt).toMatchObject({ state: 'unknown', reason: 'pid-reused' });
  });
});

describe('resolveChild exactness', () => {
  it('never resolves a workflow run or an ambiguous session without a cwd match', () => {
    const l = link({ childSessionId: 'shared' });
    const runs = [
      { runId: 'a', adapter: 'claude-code', kind: 'session', sessionId: 'shared', project: '/p/one' },
      { runId: 'b', adapter: 'claude-code', kind: 'session', sessionId: 'shared', project: '/p/two' },
      { runId: 'w', adapter: 'claude-code', kind: 'workflow', sessionId: 'wf-only' },
    ];
    expect(resolveChild(l, runs)).toBeNull();
    expect(resolveChild({ ...l, cwd: '/p/two' }, runs)?.runId).toBe('b');
    expect(resolveChild({ ...l, childSessionId: 'wf-only' }, runs)).toBeNull();
  });
});

describe('composeRuntime', () => {
  it('connects an exact child to its live anchor and namespaces every id', async () => {
    const out = await composeRuntime({
      parent: parentRef(),
      parentIR: parentIR(),
      parentDetails: new Map([['m1', { kind: 'turn' }]]),
      runs: [parentRef(), childRef()],
      links: [link()],
      parseRef,
    });
    const ids = new Set(out.ir.nodes.map((n) => n.id));
    expect(ids.size).toBe(out.ir.nodes.length);
    expect(out.ir.edges.every((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to)).toBe(true);

    const agent = out.ir.nodes.find((n) => n.id === 'c:l1:agent');
    expect(agent.ext.runtime).toMatchObject({
      state: 'completed',
      source: 'launcher',
      childRunId: childRef().runId,
      childAvailable: true,
    });
    // No proofMessageId on this link → neutral explicit-parent root, never a time guess.
    expect(out.ir.edges).toContainEqual(expect.objectContaining({ kind: 'spawn', from: 'rt:anchor', to: 'c:l1:agent' }));
    expect(out.ir.edges).toContainEqual(expect.objectContaining({ kind: 'return', from: 'c:l1:agent', to: 'rt:anchor' }));
    expect(out.ir.nodes.find((n) => n.id === 'c:l1:c1').group).toBe('c:l1:lane');
    expect(out.details.get('c:l1:c1')).toEqual({ kind: 'turn', prompt: 'child prompt', responseText: '' });
    expect(out.details.get('m1')).toEqual({ kind: 'turn' });
    expect(out.ir.meta.ext.runtime).toMatchObject({ linkedChildren: 1, totalChildren: 3, runningChildren: 0, state: 'unknown' });
    expect(out.ir.meta.totals.agents).toBe(3);
  });

  it('native agents keep their own status; an open native agent under an idle parent is unknown', async () => {
    const out = await composeRuntime({
      parent: parentRef(),
      parentIR: parentIR(),
      parentDetails: new Map(),
      runs: [parentRef()],
      links: [],
      parseRef,
    });
    expect(out.ir.nodes.find((n) => n.id === 'aN').ext.runtime.state).toBe('completed');
    expect(out.ir.nodes.find((n) => n.id === 'aO').ext.runtime.state).toBe('unknown');
    const running = await composeRuntime({
      parent: parentRef({ activity: { state: 'running', source: 'hermes-journal' } }),
      parentIR: parentIR(),
      parentDetails: new Map(),
      runs: [],
      links: [],
      parseRef,
    });
    expect(running.ir.nodes.find((n) => n.id === 'aO').ext.runtime).toMatchObject({ state: 'running', source: 'hermes-journal' });
  });

  it('never anchors by time: unproven children hang on one neutral explicit-parent root', async () => {
    const links = [
      link({ linkId: 'l2', childSessionId: 'missing-9', startedAt: '2026-10-11T11:10:00.000Z' }),
      link({ linkId: 'l3', childSessionId: 'missing-10', startedAt: '2026-10-11T10:00:00.000Z' }),
    ];
    const out = await composeRuntime({
      parent: parentRef(),
      parentIR: parentIR(),
      parentDetails: new Map(),
      runs: [parentRef()],
      links,
      parseRef,
    });
    expect(out.ir.nodes.find((n) => n.id === 'c:l2:agent').ext.runtime.childAvailable).toBe(false);
    expect(out.details.get('c:l2:agent').pending).toMatch(/not visible/);
    const root = out.ir.nodes.filter((n) => n.id === 'rt:anchor');
    expect(root).toHaveLength(1);
    expect(root[0].label).toBe('linked external children (explicit parent)');
    expect(out.ir.edges).toContainEqual(expect.objectContaining({ kind: 'spawn', from: 'rt:anchor', to: 'c:l2:agent' }));
    expect(out.ir.edges).toContainEqual(expect.objectContaining({ kind: 'spawn', from: 'rt:anchor', to: 'c:l3:agent' }));
    expect(out.ir.edges.some((e) => e.kind === 'spawn' && e.from === 'm1')).toBe(false);
  });

  it('anchors on a retained turn only when the link carries an exact proof id that matches it', async () => {
    const out = await composeRuntime({
      parent: parentRef(),
      parentIR: parentIR(),
      parentDetails: new Map(),
      runs: [parentRef()],
      links: [link({ linkId: 'l5', childSessionId: 'missing-11', proofMessageId: 2 })],
      parseRef,
    });
    expect(out.ir.edges).toContainEqual(expect.objectContaining({ kind: 'spawn', from: 'm2', to: 'c:l5:agent' }));
    expect(out.ir.nodes.some((n) => n.id === 'rt:anchor')).toBe(false);
  });

  it.skipIf(!LIVE)('a running external child makes an idle parent running', async () => {
    const live = link({
      linkId: 'l4',
      childSessionId: 'missing-live',
      state: 'running',
      finishedAt: null,
      exitCode: null,
      pid: process.pid,
      processStartTicks: IDENT.startTicks,
      bootId: BOOT,
    });
    const out = await composeRuntime({
      parent: parentRef(),
      parentIR: parentIR(),
      parentDetails: new Map(),
      runs: [parentRef()],
      links: [live],
      parseRef,
    });
    expect(out.ir.meta.ext.runtime).toMatchObject({ state: 'running', source: 'linked-child', runningChildren: 1 });
    const agent = out.ir.nodes.find((n) => n.id === 'c:l4:agent');
    expect(agent.status).toBe('running');
    expect(agent.ext.runtime.state).toBe('running');
  });
});

describe('annotateRuntime and index activity', () => {
  let dir;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rg-annotate-'));
    await writeFile(join(dir, 'x.json'), JSON.stringify(link({ state: 'completed' })));
    process.env.RUNGRAPH_LINKS_DIR = dir;
  });
  afterAll(async () => {
    delete process.env.RUNGRAPH_LINKS_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it('attaches exact child activity and parentRunId, and keeps the parent live while a child runs', async () => {
    const old = '2026-10-10T08:00:00.000Z';
    const parent = parentRef({ modifiedAt: old, activity: { state: 'unknown', source: 'hermes-journal' } });
    const child = childRef({ modifiedAt: old });
    await annotateRuntime([parent, child]);
    expect(child.activity).toMatchObject({ state: 'completed', source: 'launcher' });
    expect(child.parentRunId).toBe(parent.runId);
    expect(parent.linkedRunning).toBeUndefined();
  });

  it.skipIf(!LIVE)('a live linked child lifts an idle parent to active in the index', async () => {
    await writeFile(
      join(dir, 'x.json'),
      JSON.stringify(link({ state: 'running', finishedAt: null, exitCode: null, pid: process.pid, processStartTicks: IDENT.startTicks, bootId: BOOT })),
    );
    const old = '2026-10-10T08:00:00.000Z';
    const parent = parentRef({ modifiedAt: old, activity: { state: 'unknown', source: 'hermes-journal' } });
    const child = childRef({ modifiedAt: old });
    await annotateRuntime([parent, child]);
    expect(child.activity.state).toBe('running');
    expect(parent.linkedRunning).toBe(true);
    expect(toIndexEntry(parent).active).toBe(true);
    expect(toIndexEntry(parent).activity).toMatchObject({state: 'running', source: 'linked-child'});
    const placeholderParent = parentRef({modifiedAt: old, activity: undefined});
    await annotateRuntime([placeholderParent]);
    expect(toIndexEntry(placeholderParent).activity).toMatchObject({state: 'running', source: 'linked-child'});
    expect(toIndexEntry(placeholderParent).active).toBe(true);
  });

  it('a running worker stays active past 45s; unknown evidence is not treated as running', () => {
    const old = '2026-10-10T08:00:00.000Z';
    const now = Date.parse(old) + 10 * 60_000;
    const ref = { runId: 'hermes:s', adapter: 'hermes', kind: 'session', title: 't', project: '/synthetic/project', projectExists: true, modifiedAt: old, sizeBytes: 1 };
    expect(toIndexEntry({ ...ref, activity: { state: 'running', source: 'hermes-journal' } }, now).active).toBe(true);
    expect(toIndexEntry({ ...ref, activity: { state: 'unknown', source: 'hermes-journal', reason: 'x' } }, now).active).toBe(false);
    expect(toIndexEntry({ ...ref, modifiedAt: new Date(now - 1000).toISOString() }, now).active).toBe(true);
  });
});
