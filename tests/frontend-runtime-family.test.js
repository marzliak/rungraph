import { describe, expect, it } from 'vitest';
import {
  RUNTIME_STATES,
  normalizeState,
  runtimeLabel,
  runtimeOfEntry,
  runtimeOfMeta,
  childRuntimeOfNode,
  principalModel,
  familySummary,
  isLiveEntry,
  isLiveRuntime,
  entryBadge,
  runtimeBadge,
  resolveRuntime,
  parentLinkOf,
} from '../frontend/src/runtime.js';
import { adapterChips, groupRuns } from '../frontend/src/picker-groups.js';

// Index entries as /api/index delivers them: only the fields these readers use.
let seq = 0;
const entry = (over = {}) => ({
  runId: over.runId ?? `t:run-${String(++seq).padStart(3, '0')}`,
  adapter: 'claude-code',
  kind: 'session',
  title: 't',
  project: '/home/dev/acme',
  modifiedAt: '2026-10-11T13:00:00.000Z',
  active: false,
  loose: false,
  ...over,
});

describe('runtime vocabulary', () => {
  it('the wire enum is exactly the five server states', () => {
    expect(RUNTIME_STATES).toEqual(['running', 'waiting', 'completed', 'error', 'unknown']);
  });

  it('normalizes only the five states; anything else is null', () => {
    for (const s of RUNTIME_STATES) expect(normalizeState(s)).toBe(s);
    expect(normalizeState('active')).toBeNull();
    expect(normalizeState('recent')).toBeNull();
    expect(normalizeState(undefined)).toBeNull();
    expect(normalizeState(42)).toBeNull();
  });

  it('labels error as failed, and never labels an unknown state as running', () => {
    expect(runtimeLabel('error')).toBe('failed');
    expect(runtimeLabel('running')).toBe('running');
    expect(runtimeLabel('bogus')).toBe('unknown');
    expect(runtimeLabel('unknown')).toBe('unknown');
    expect(runtimeLabel('recent')).toBe('recent');
  });
});

describe('runtimeOfEntry — legacy recency is not proof of execution', () => {
  it('a legacy active entry without runtimeState reads recent and unproven', () => {
    expect(runtimeOfEntry(entry({ active: true }))).toEqual({
      state: 'recent',
      source: null,
      proven: false,
    });
  });

  it('an inactive entry without runtimeState has no runtime to show', () => {
    expect(runtimeOfEntry(entry({ active: false }))).toBeNull();
  });

  it('a proven runtimeState wins over the legacy active flag', () => {
    const rt = runtimeOfEntry(entry({ active: true, runtimeState: 'completed', activitySource: 'journal' }));
    expect(rt).toEqual({ state: 'completed', source: 'journal', proven: true });
  });

  it('a present but invalid runtimeState reads unknown, not running', () => {
    const rt = runtimeOfEntry(entry({ active: true, runtimeState: 'spinning' }));
    expect(rt.state).toBe('unknown');
    expect(rt.proven).toBe(true);
  });

  it('a null or absent entry is no runtime', () => {
    expect(runtimeOfEntry(null)).toBeNull();
    expect(runtimeOfEntry(undefined)).toBeNull();
  });
});

describe('production activity wire contract', () => {
  it('reads scanner activity rather than calling a proven worker merely recent', () => {
    expect(runtimeOfEntry(entry({active: true, activity: {state: 'running', source: 'hermes-journal'}}))).toEqual({state: 'running', source: 'hermes-journal', proven: true});
    expect(isLiveEntry(entry({active: false, activity: {state: 'running', source: 'linked-child'}}))).toBe(true);
    expect(entryBadge(entry({active: true, activity: {state: 'completed', source: 'launcher'}}))).toBeNull();
    expect(runtimeOfEntry(entry({active: true, activity: {state: 'bogus'}})).state).toBe('unknown');
  });
});

describe('isLiveEntry — the live dot means proven execution only', () => {
  it('only proven running or waiting entries are live', () => {
    expect(isLiveEntry(entry({ runtimeState: 'running' }))).toBe(true);
    expect(isLiveEntry(entry({ runtimeState: 'waiting' }))).toBe(true);
    for (const s of ['completed', 'error', 'unknown']) {
      expect(isLiveEntry(entry({ runtimeState: s }))).toBe(false);
    }
  });

  it('a legacy active flag is not live', () => {
    expect(isLiveEntry(entry({ active: true }))).toBe(false);
  });

  it('a proven running entry with a stale legacy flag is still live', () => {
    expect(isLiveEntry(entry({ active: false, runtimeState: 'running' }))).toBe(true);
  });
});

describe('picker counts use the proven predicate', () => {
  it('groupRuns counts only proven-live runs when given isLive', () => {
    const runs = [
      entry({ project: '/dev/a', runtimeState: 'running' }),
      entry({ project: '/dev/a', active: true }), // legacy recency: not live
      entry({ project: '/dev/a', runtimeState: 'completed' }),
    ];
    expect(groupRuns(runs, { isLive: isLiveEntry })[0].live).toBe(1);
  });

  it('the default predicate keeps the legacy active count for callers that pass none', () => {
    const runs = [entry({ project: '/dev/a', active: true }), entry({ project: '/dev/a' })];
    expect(groupRuns(runs)[0].live).toBe(1);
  });

  it('adapterChips marks an adapter live only on a proven live run', () => {
    const runs = [
      entry({ adapter: 'hermes', active: true }),
      entry({ adapter: 'codex', runtimeState: 'waiting' }),
    ];
    const chips = adapterChips(runs, { isLive: isLiveEntry });
    expect(chips.find((c) => c.adapter === 'hermes').live).toBe(false);
    expect(chips.find((c) => c.adapter === 'codex').live).toBe(true);
  });
});

describe('runtimeOfMeta', () => {
  it('absent meta.ext.runtime is no runtime (older server)', () => {
    expect(runtimeOfMeta({})).toBeNull();
    expect(runtimeOfMeta(undefined)).toBeNull();
    expect(runtimeOfMeta({ ext: {} })).toBeNull();
  });

  it('reads state, source, model and both child counts', () => {
    const rt = runtimeOfMeta({
      ext: {
        runtime: { state: 'running', source: 'stream', model: 'claude-opus-4', linkedChildren: 3, runningChildren: 1 },
      },
    });
    expect(rt).toEqual({
      state: 'running',
      source: 'stream',
      model: 'claude-opus-4',
      linkedChildren: 3,
      runningChildren: 1,
      proven: true,
    });
  });

  it('an invalid state reads unknown; counts accept a list as well as a number', () => {
    const rt = runtimeOfMeta({ ext: { runtime: { state: 'maybe', linkedChildren: ['a', 'b'], runningChildren: -2 } } });
    expect(rt.state).toBe('unknown');
    expect(rt.linkedChildren).toBe(2);
    expect(rt.runningChildren).toBeNull();
  });

  it('missing fields stay null rather than zero', () => {
    const rt = runtimeOfMeta({ ext: { runtime: { state: 'completed' } } });
    expect(rt.model).toBeNull();
    expect(rt.linkedChildren).toBeNull();
    expect(rt.runningChildren).toBeNull();
  });
});

describe('childRuntimeOfNode and principalModel', () => {
  it('reads an agent node child runtime, or null', () => {
    expect(childRuntimeOfNode({ ext: { runtime: { state: 'waiting', childRunId: 'c1' } } })).toEqual({
      state: 'waiting',
      childRunId: 'c1',
    });
    expect(childRuntimeOfNode({})).toBeNull();
  });

  it('principal model is the first node that names one', () => {
    expect(principalModel([{ id: 'a' }, { id: 'b', model: 'sonnet' }, { model: 'opus' }])).toBe('sonnet');
    expect(principalModel([{ id: 'a' }])).toBeNull();
    expect(principalModel(undefined)).toBeNull();
  });
});

describe('familySummary — one concise header line', () => {
  it('composes model, child count and running count', () => {
    const rt = runtimeOfMeta({ ext: { runtime: { state: 'running', model: 'opus', linkedChildren: 2, runningChildren: 1 } } });
    expect(familySummary(rt, [])).toBe('opus · 2 children · 1 running');
  });

  it('singular child, and the model falls back to the nodes', () => {
    const rt = runtimeOfMeta({ ext: { runtime: { state: 'completed', linkedChildren: 1 } } });
    expect(familySummary(rt, [{ model: 'sonnet' }])).toBe('sonnet · 1 child');
  });

  it('is null when there is nothing honest to say', () => {
    expect(familySummary(null, [])).toBeNull();
    expect(familySummary(runtimeOfMeta({ ext: { runtime: { state: 'running' } } }), [])).toBeNull();
  });

  it('truncates a long model name rather than overflowing the header', () => {
    const long = 'x'.repeat(60);
    const s = familySummary(null, [{ model: long }]);
    expect(s.length).toBeLessThanOrEqual(28);
    expect(s.endsWith('…')).toBe(true);
  });

  it('a zero running count is stated, not hidden', () => {
    const rt = runtimeOfMeta({ ext: { runtime: { state: 'completed', linkedChildren: 2, runningChildren: 0 } } });
    expect(familySummary(rt, [])).toBe('2 children · 0 running');
  });
});

describe('entryBadge — the picker row tag', () => {
  it('proven live shows its state; legacy recency shows recent, never live', () => {
    expect(entryBadge(entry({ runtimeState: 'running' }))).toEqual({ label: 'running', tone: 'live' });
    expect(entryBadge(entry({ runtimeState: 'waiting' }))).toEqual({ label: 'waiting', tone: 'live' });
    expect(entryBadge(entry({ active: true }))).toEqual({ label: 'recent', tone: 'recent' });
  });

  it('proven failure is tagged failed; proven completion stays quiet', () => {
    expect(entryBadge(entry({ runtimeState: 'error' }))).toEqual({ label: 'failed', tone: 'failed' });
    expect(entryBadge(entry({ runtimeState: 'completed' }))).toBeNull();
    expect(entryBadge(entry({}))).toBeNull();
  });

  it('an unknown proven state shows unknown, never a live tag', () => {
    expect(entryBadge(entry({ runtimeState: 'unknown' }))).toEqual({ label: 'unknown', tone: 'unknown' });
  });

  it('runtimeBadge is the one rule: null runtime → no tag', () => {
    expect(runtimeBadge(null)).toBeNull();
    expect(runtimeBadge({ state: 'completed', proven: true })).toBeNull();
  });
});

describe('resolveRuntime — index entry state, graph detail', () => {
  it('the proven index state wins over a stale graph state, keeping graph detail', () => {
    const rt = resolveRuntime(
      entry({ runtimeState: 'completed', activitySource: 'journal' }),
      { ext: { runtime: { state: 'running', model: 'opus', linkedChildren: 2 } } },
    );
    expect(rt.state).toBe('completed');
    expect(rt.model).toBe('opus');
    expect(rt.linkedChildren).toBe(2);
    expect(rt.source).toBe('journal');
  });

  it('with no index runtime, the graph runtime supplies state and detail', () => {
    const rt = resolveRuntime(entry({}), { ext: { runtime: { state: 'waiting', source: 'stream' } } });
    expect(rt.state).toBe('waiting');
    expect(rt.source).toBe('stream');
  });

  it('a legacy-only entry with no graph block reads recent, unproven', () => {
    expect(resolveRuntime(entry({ active: true }), {})).toEqual({ state: 'recent', source: null, proven: false });
  });

  it('nothing known is null', () => {
    expect(resolveRuntime(entry({}), {})).toBeNull();
  });
});

describe('parentLinkOf — navigation without cycles or dead links', () => {
  it('a listed parent is navigable', () => {
    const listed = new Set(['p1', 'c1']);
    expect(parentLinkOf({ runId: 'c1', parentRunId: 'p1' }, listed)).toEqual({ kind: 'listed', runId: 'p1' });
  });

  it('a parent that is named but not listed is unavailable, never a dead jump', () => {
    expect(parentLinkOf({ runId: 'c1', parentRunId: 'gone' }, new Set(['c1']))).toEqual({
      kind: 'unavailable',
      runId: 'gone',
    });
  });

  it('no parent, empty parent, and a self-parent are all no link', () => {
    const listed = new Set(['c1']);
    expect(parentLinkOf({ runId: 'c1' }, listed)).toBeNull();
    expect(parentLinkOf({ runId: 'c1', parentRunId: '  ' }, listed)).toBeNull();
    expect(parentLinkOf({ runId: 'c1', parentRunId: 'c1' }, listed)).toBeNull();
  });
});
