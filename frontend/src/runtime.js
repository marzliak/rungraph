/**
 * Runtime and family vocabulary for the dashboard: what an execution is doing
 * right now, which model drives it, and how many children it has.
 *
 * Pure (no imports, no preact, no DOM) so it unit-tests beside viewmath and
 * focus — `tests/frontend-runtime-family.test.js`. Every reader here accepts
 * an absent or malformed field and degrades: a runtime the server did not
 * prove reads `unknown`, never `running`; an index entry without a runtime
 * signal falls back to `recent` when the legacy `active` flag is set, so a
 * recency heuristic never claims an execution is actually running.
 *
 * Wire contract (additive, server-owned):
 *   meta.ext.runtime  { state, source?, linkedChildren?, runningChildren?, model? }
 *   node.ext.runtime  { state, childRunId? }           (agent nodes)
 *   node.model        string                           (principal model per node)
 *   index entry       runtimeState?, activitySource?, parentRunId?
 */

/** The server-proven vocabulary. `recent` is a frontend-only legacy label. */
export const RUNTIME_STATES = Object.freeze(['running', 'waiting', 'completed', 'error', 'unknown']);

const LABELS = Object.freeze({
  running: 'running',
  waiting: 'waiting',
  completed: 'completed',
  error: 'failed',
  unknown: 'unknown',
  recent: 'recent',
});

/** A valid runtime state, or null when the value is not one of the five. */
export function normalizeState(v) {
  return typeof v === 'string' && RUNTIME_STATES.includes(v) ? v : null;
}

/** Human label for a state (`error` reads as `failed`; `recent` is legacy-only). */
export function runtimeLabel(state) {
  return LABELS[state] ?? LABELS.unknown;
}

function text(v) {
  return typeof v === 'string' && v.trim() ? v : null;
}

// A count from either a number or a list (the server may send either form).
function count(v) {
  if (Array.isArray(v)) return v.length;
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.floor(v);
  return null;
}

/**
 * The runtime of an index entry. A server-proven `runtimeState` wins — and a
 * present but invalid one reads `unknown`. Without it, the legacy `active`
 * flag means only `recent`: recency is not proof of execution.
 *
 * @returns {{ state: string, source: string|null, proven: boolean } | null}
 *   null when there is nothing to say (inactive, legacy, no signal).
 */
export function runtimeOfEntry(r) {
  if (!r || typeof r !== 'object') return null;
  if (r.runtimeState != null || r.activity != null) {
    return {
      state: normalizeState(r.runtimeState ?? r.activity?.state) ?? 'unknown',
      source: text(r.activitySource ?? r.activity?.source),
      proven: true,
    };
  }
  if (r.active) return { state: 'recent', source: null, proven: false };
  return null;
}

/**
 * Whether an index entry is PROVEN to be executing (running or waiting on
 * something). Legacy `active` recency never counts: the list's live dots and
 * the header badge must not claim an execution the server did not prove.
 */
export function isLiveEntry(r) {
  return isLiveRuntime(runtimeOfEntry(r));
}

/** A runtime that is proven and still executing (running or waiting). */
export function isLiveRuntime(rt) {
  return Boolean(rt?.proven && (rt.state === 'running' || rt.state === 'waiting'));
}

/**
 * The tag shown for a runtime, in the header and on picker rows — one rule for
 * both. Proven live → its state; proven failed → `failed`; proven finished →
 * nothing (quiet about the ordinary case); legacy recency → `recent`, never
 * `live`; proven but absent/incoherent telemetry → `unknown`.
 *
 * @returns {{ label: string, tone: 'live'|'failed'|'recent'|'unknown' } | null}
 */
export function runtimeBadge(rt) {
  if (!rt) return null;
  if (isLiveRuntime(rt)) return { label: runtimeLabel(rt.state), tone: 'live' };
  if (!rt.proven) return { label: runtimeLabel('recent'), tone: 'recent' };
  if (rt.state === 'error') return { label: runtimeLabel('error'), tone: 'failed' };
  if (rt.state === 'unknown') return { label: runtimeLabel('unknown'), tone: 'unknown' };
  return null;
}

/** The picker row's tag: `runtimeBadge` of the index entry's own runtime. */
export function entryBadge(r) {
  return runtimeBadge(runtimeOfEntry(r));
}

/**
 * The runtime the header shows for the open run. The index entry is polled
 * every few seconds, so its proven state wins for the STATE (a run that
 * finished while no delta arrived still reads completed); the graph's
 * `meta.ext.runtime` supplies the detail (model, child counts) and the state
 * when the index has none. The legacy `active` flag is the last resort and
 * only ever reads `recent`.
 */
export function resolveRuntime(entry, meta) {
  const fromEntry = runtimeOfEntry(entry);
  const fromMeta = runtimeOfMeta(meta);
  if (fromEntry?.proven) {
    return {
      ...(fromMeta ?? {}),
      state: fromEntry.state,
      source: fromEntry.source ?? fromMeta?.source ?? null,
      proven: true,
    };
  }
  return fromMeta ?? fromEntry;
}

/**
 * The runtime of a graph, from `meta.ext.runtime`. Null when the graph carries
 * no runtime block at all (an older server, or an adapter without one).
 */
export function runtimeOfMeta(meta) {
  const rt = meta?.ext?.runtime;
  if (!rt || typeof rt !== 'object') return null;
  return {
    state: normalizeState(rt.state) ?? 'unknown',
    source: text(rt.source),
    model: text(rt.model),
    linkedChildren: count(rt.totalChildren ?? rt.linkedChildren),
    runningChildren: count(rt.runningChildren),
    proven: true,
  };
}

/** An agent node's child execution, from `node.ext.runtime`, or null. */
export function childRuntimeOfNode(node) {
  const rt = node?.ext?.runtime;
  if (!rt || typeof rt !== 'object') return null;
  return {
    state: normalizeState(rt.state) ?? 'unknown',
    childRunId: text(rt.childRunId),
  };
}

/** The model of the earliest node that names one — the run's principal model. */
export function principalModel(nodes) {
  for (const n of nodes ?? []) {
    const m = text(n?.model);
    if (m) return m;
  }
  return null;
}

/**
 * One concise line for the header: `model · N children · M running`. Each
 * part appears only when known, so a run with no family and no model yields
 * null and the header stays silent rather than printing zeros it cannot back.
 *
 * @param {ReturnType<typeof runtimeOfMeta>} rt
 * @param {Array<object>} nodes  the graph's nodes, for the model fallback
 */
export function familySummary(rt, nodes) {
  const model = rt?.model ?? principalModel(nodes);
  const parts = [];
  if (model) parts.push(model.length > 28 ? model.slice(0, 27) + '…' : model);
  if (rt?.linkedChildren != null) {
    const n = rt.linkedChildren;
    parts.push(`${n} child${n === 1 ? '' : 'ren'}`);
  }
  if (rt?.runningChildren != null) parts.push(`${rt.runningChildren} running`);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * Where a standalone external entry's `parentRunId` leads. `listed` means the
 * parent is in this dashboard's index and can be opened; `unavailable` means
 * it is named but not listed here, and the UI must say so rather than offer a
 * dead link. A self-parent is treated as no parent (no cycles, ever).
 *
 * @param {object} entry
 * @param {Set<string>} listedIds  runIds present in the index
 * @returns {{ kind: 'listed'|'unavailable', runId: string } | null}
 */
export function parentLinkOf(entry, listedIds) {
  const p = text(entry?.parentRunId);
  if (!p || p === entry?.runId) return null;
  return listedIds && listedIds.has(p)
    ? { kind: 'listed', runId: p }
    : { kind: 'unavailable', runId: p };
}
