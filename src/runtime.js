import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { snippet } from './ir.js';
import { bootId, processIdentity } from './procfs.js';
import { attachSignals } from './signals.js';

/**
 * The cross-runtime composition layer: an explicit launcher registry of
 * external (Claude Code headless) child runs, joined onto the native parent
 * run they were dispatched from.
 *
 * Server-side only. It knows the link schema and the *identity* of adapter
 * refs (adapter name + exact session id), never a vendor's file layout — the
 * child is parsed by the normal adapter, and this module only namespaces and
 * connects the result. No inference by time or name: a link is composed only
 * when its parentSessionId and childSessionId resolve exactly.
 *
 * Runtime truth for an external child:
 *   - a terminal record (completed/error) is the answer, and prevails;
 *   - a `running` record is running ONLY while its PID still has the recorded
 *     start ticks on the recorded boot; anything else is `unknown`;
 *   - an `unknown` record (wrapper failed before start) is `unknown`.
 * Native (Hermes) children read `running` only while the parent's worker is
 * running AND the child is still open; otherwise `unknown` or `completed`.
 */

export const LINK_SCHEMA_VERSION = 1;
export const LINK_CHILD_ADAPTER = 'claude-code';
const LINK_STATES = new Set(['running', 'completed', 'error', 'unknown']);
const LINK_SOURCES = new Set(['launcher', 'verified-import']);
const ID_RE = /^[A-Za-z0-9._:-]{1,160}$/;
const TICKS_RE = /^\d{1,20}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const MAX_LINK_BYTES = 16 * 1024;

const isId = (v) => typeof v === 'string' && ID_RE.test(v);
const isIso = (v) => typeof v === 'string' && ISO_RE.test(v) && Number.isFinite(Date.parse(v));

/** Directory of link records; unset or empty means no registry. */
export function linksDir() {
  return process.env.RUNGRAPH_LINKS_DIR || null;
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, link: object } | { ok: false, reason: string }}
 */
export function validateLink(raw) {
  const bad = (reason) => ({ ok: false, reason });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('not an object');
  if (raw.schemaVersion !== LINK_SCHEMA_VERSION) return bad('unsupported schemaVersion');
  if (!isId(raw.linkId)) return bad('bad linkId');
  if (!isId(raw.parentSessionId)) return bad('bad parentSessionId');
  if (raw.childAdapter !== LINK_CHILD_ADAPTER) return bad('unsupported childAdapter');
  if (!isId(raw.childSessionId)) return bad('bad childSessionId');
  if (!LINK_STATES.has(raw.state)) return bad('bad state');
  if (!LINK_SOURCES.has(raw.source)) return bad('bad source');
  if (!isIso(raw.startedAt)) return bad('bad startedAt');
  if (raw.finishedAt != null && !isIso(raw.finishedAt)) return bad('bad finishedAt');
  if (raw.exitCode != null && !Number.isInteger(raw.exitCode)) return bad('bad exitCode');
  if (raw.pid != null && !(Number.isInteger(raw.pid) && raw.pid > 0)) return bad('bad pid');
  if (raw.processStartTicks != null && !(typeof raw.processStartTicks === 'string' && TICKS_RE.test(raw.processStartTicks))) {
    return bad('bad processStartTicks');
  }
  if (raw.bootId != null && typeof raw.bootId !== 'string') return bad('bad bootId');
  if (raw.model != null && typeof raw.model !== 'string') return bad('bad model');
  if (raw.cwd != null && (typeof raw.cwd !== 'string' || raw.cwd.length > 4096)) return bad('bad cwd');
  return {
    ok: true,
    link: {
      linkId: raw.linkId,
      parentSessionId: raw.parentSessionId,
      childAdapter: raw.childAdapter,
      childSessionId: raw.childSessionId,
      label: typeof raw.label === 'string' ? raw.label.slice(0, 200) : '',
      model: raw.model ?? null,
      cwd: raw.cwd ?? null,
      ...(Number.isInteger(raw.proofMessageId) ? { proofMessageId: raw.proofMessageId } : {}),
      pid: raw.pid ?? null,
      processStartTicks: raw.processStartTicks ?? null,
      bootId: raw.bootId ?? null,
      state: raw.state,
      startedAt: raw.startedAt,
      finishedAt: raw.finishedAt ?? null,
      exitCode: raw.exitCode ?? null,
      source: raw.source,
    },
  };
}

/**
 * Read every valid link record. Invalid, oversized, unreadable or duplicate
 * records are skipped and reported by ordinal (never by file name or path).
 * @returns {Promise<{ links: object[], warnings: { adapter: string, reason: string }[] }>}
 */
export async function readLinks() {
  const dir = linksDir();
  const out = { links: [], warnings: [] };
  if (!dir) return out;
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err?.code !== 'ENOENT') out.warnings.push({ adapter: 'runtime', reason: `links dir unreadable (${err?.code ?? 'error'})` });
    return out;
  }
  const seen = new Set();
  let ordinal = 0;
  for (const name of names.sort()) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    ordinal++;
    const warn = (why) => out.warnings.push({ adapter: 'runtime', reason: `link record ${ordinal}: ${why}` });
    let raw;
    try {
      const path = join(dir, name);
      const st = await stat(path);
      if (!st.isFile() || st.size > MAX_LINK_BYTES) {
        warn('not a small regular file');
        continue;
      }
      raw = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      warn('unreadable or not JSON');
      continue;
    }
    const v = validateLink(raw);
    if (!v.ok) {
      warn(v.reason);
      continue;
    }
    if (seen.has(v.link.linkId)) {
      warn('duplicate linkId ignored');
      continue;
    }
    seen.add(v.link.linkId);
    out.links.push(v.link);
  }
  return out;
}

/**
 * The runtime truth of one link. `ctx.bootId` caches the boot id across one
 * composition so a 20-link registry reads /proc/sys once.
 * @returns {Promise<{ state: 'running'|'completed'|'error'|'unknown', source: string, reason?: string }>}
 */
export async function evaluateLink(link, ctx = {}) {
  const source = link.source;
  if (link.state === 'completed' || link.state === 'error') {
    // A terminal record must be internally coherent: a finish time, and an exit
    // code that agrees with the state. A contradiction is unknown, never a
    // confident answer built on a half-written record.
    if (link.finishedAt == null) return { state: 'unknown', source, reason: 'terminal-without-finish' };
    if (link.state === 'completed' && link.exitCode !== 0) {
      return { state: 'unknown', source, reason: 'terminal-contradiction' };
    }
    if (link.state === 'error' && link.exitCode === 0) {
      return { state: 'unknown', source, reason: 'terminal-contradiction' };
    }
    return { state: link.state, source };
  }
  if (link.state === 'unknown') return { state: 'unknown', source, reason: 'failed-before-start' };
  if (link.pid == null || link.processStartTicks == null || link.bootId == null) {
    return { state: 'unknown', source, reason: 'identity-missing' };
  }
  if (ctx.bootId === undefined) ctx.bootId = await bootId();
  if (!ctx.bootId) return { state: 'unknown', source, reason: 'boot-unavailable' };
  if (ctx.bootId !== link.bootId) return { state: 'unknown', source, reason: 'boot-changed' };
  const proc = await processIdentity(link.pid);
  // The launcher always writes a terminal record; a running record whose
  // process is gone means the wrapper died without one.
  if (!proc) return { state: 'unknown', source, reason: 'process-missing' };
  if (proc.startTicks !== link.processStartTicks) return { state: 'unknown', source, reason: 'pid-reused' };
  return { state: 'running', source };
}

/**
 * The one exact child ref for a link, or null. Ambiguity (the same session id
 * under two project dirs) resolves only by the recorded cwd, else not at all.
 */
export function resolveChild(link, runs) {
  // kind 'session' only: a workflow run shares its parent session id.
  const c = runs.filter(
    (r) => r.adapter === LINK_CHILD_ADAPTER && r.kind === 'session' && r.sessionId === link.childSessionId,
  );
  if (c.length <= 1) return c[0] ?? null;
  const byCwd = link.cwd ? c.filter((r) => r.project === link.cwd) : [];
  return byCwd.length === 1 ? byCwd[0] : null;
}

/** The exact parent ref for a link: adapter-agnostic by session id, hermes preferred. */
export function resolveParent(link, runs) {
  const p = runs.filter((r) => r.kind === 'session' && r.sessionId === link.parentSessionId);
  return p.find((r) => r.adapter === 'hermes') ?? p[0] ?? null;
}

/**
 * Scan-time annotation: every link whose child resolves exactly gets the
 * child's runtime `activity` (external evidence, not recency) and
 * `parentRunId` for navigation. The child stays a standalone listing too.
 * Runs in place on the scan's refs; returns the registry's warnings.
 *
 * @param {object[]} runs
 * @returns {Promise<{ adapter: string, reason: string }[]>}
 */
export async function annotateRuntime(runs) {
  const { links, warnings } = await readLinks();
  if (links.length === 0) return warnings;
  const ctx = {};
  for (const link of links) {
    const child = resolveChild(link, runs);
    const parent = resolveParent(link, runs);
    const rt = await evaluateLink(link, ctx);
    // The launch exists before a persisted transcript is discovered.
    if (parent && rt.state === 'running') parent.linkedRunning = true;
    if (child) {
      child.activity = { state: rt.state, source: rt.source, ...(rt.reason ? { reason: rt.reason } : {}) };
      if (parent && parent.runId !== child.runId) child.parentRunId = parent.runId;
    }
  }
  return warnings;
}

const TERMINAL = new Set(['completed', 'error']);
const ROOT_ANCHOR_ID = 'rt:anchor';

/**
 * Compose one parent run's IR with its linked external children and annotate
 * native agents' runtime. Pure with respect to its inputs: the cached parent
 * IR is never mutated; the result is a new object.
 *
 * @param {{
 *   parent: object|null,            scanned RunRef (may carry `activity`, `model`)
 *   parentIR: object,
 *   parentDetails: Map<string, object>,
 *   runs: object[],                 full scan, for exact child resolution
 *   links: object[],
 *   parseRef: (ref: object) => Promise<{ ir: object, details: Map<string, object> }>,
 * }} args
 * @returns {Promise<{ ir: object, details: Map<string, object> }>}
 */
export async function composeRuntime({ parent, parentIR, parentDetails, runs, links, parseRef }) {
  const parentState = parent?.activity?.state ?? 'unknown';
  const parentSource = parent?.activity?.source ?? 'none';
  const mine = parent ? links.filter((l) => l.parentSessionId === parent.sessionId) : [];
  const ctx = {};

  const linked = [];
  for (const link of mine) {
    const rt = await evaluateLink(link, ctx);
    const childRef = resolveChild(link, runs);
    const child = childRef ? await parseRef(childRef) : null;
    linked.push({ link, rt, childRef, child });
  }

  // Native agents: running only while the parent's worker runs AND the child
  // is still open. An ended child is completed. Anything else is unknown.
  const nodes = parentIR.nodes.map((n) => {
    if (n.kind !== 'agent' || n.ext?.runtime) return n;
    // Native status is preserved on the node; the runtime state only mirrors it.
    const state = n.endedAt
      ? n.status === 'error'
        ? 'error'
        : 'completed'
      : parentState === 'running'
        ? 'running'
        : 'unknown';
    return {
      ...n,
      ext: {
        ...(n.ext ?? {}),
        runtime: {
          state,
          source: state === 'unknown' ? 'none' : parentSource,
          // Native children are subagent sessions, never standalone runs.
          childRunId: null,
        },
      },
    };
  });
  const edges = [...parentIR.edges];
  const groups = [...parentIR.groups];
  const details = new Map(parentDetails ?? []);
  let anchorAdded = false;

  for (const { link, rt, childRef, child } of linked) {
    const p = `c:${link.linkId}:`;
    const laneId = `${p}lane`;
    const agentId = `${p}agent`;
    const startMs = Date.parse(link.startedAt);
    const terminal = TERMINAL.has(rt.state);

    // Anchor: only an EXACT proof of dispatch attaches to a retained turn —
    // the link's proofMessageId naming a turn node that is present in the
    // parent graph. Time is never evidence (compaction removes the launch
    // turn, so the nearest earlier turn would be a guess). Otherwise the
    // explicit parent's neutral metadata root carries the spawn.
    const proofId = Number.isInteger(link.proofMessageId) ? `m${link.proofMessageId}` : null;
    const proofNode = proofId ? parentIR.nodes.find((t) => t.id === proofId && t.kind === 'turn') : null;
    let anchorId = proofNode ? proofNode.id : ROOT_ANCHOR_ID;
    if (!proofNode && !anchorAdded) {
      anchorAdded = true;
      nodes.push({
        id: ROOT_ANCHOR_ID,
        kind: 'turn',
        label: 'linked external children (explicit parent)',
        status: 'completed',
        hasDetail: false,
        ext: { runtime: { provenance: 'explicit-parent' } },
      });
    }

    const label = snippet(link.label || childRef?.title || link.childSessionId, 60);
    // `unknown` is not a failure: it maps to completed (no active work claimed)
    // and the truth travels in ext.runtime.state, so no error signal fires on
    // a child we cannot verify.
    const status = rt.state === 'running' ? 'running' : rt.state === 'error' ? 'error' : 'completed';
    nodes.push({
      id: agentId,
      kind: 'agent',
      label,
      status,
      agentId: link.childSessionId,
      group: laneId,
      hasDetail: true,
      startedAt: link.startedAt,
      ...(terminal && link.finishedAt ? { endedAt: link.finishedAt } : {}),
      ...(link.model ? { model: link.model } : {}),
      ext: {
        runtime: {
          state: rt.state,
          source: rt.source,
          childRunId: childRef?.runId ?? null,
          childAvailable: Boolean(child),
          linkId: link.linkId,
          ...(rt.reason ? { reason: rt.reason } : {}),
        },
      },
    });
    groups.push({ id: laneId, label });
    edges.push({
      id: `e:spawn:${anchorId}→${agentId}`,
      kind: 'spawn',
      from: anchorId,
      to: agentId,
      ...(link.label ? { label: snippet(link.label, 90) } : {}),
    });

    if (child) {
      const cIR = child.ir;
      for (const g of cIR.groups) groups.push({ id: p + g.id, label: g.label });
      for (const n of cIR.nodes) {
        nodes.push({ ...n, id: p + n.id, group: n.group ? p + n.group : laneId });
      }
      for (const e of cIR.edges) edges.push({ ...e, id: p + e.id, from: p + e.from, to: p + e.to });
      for (const [k, v] of child.details) details.set(p + k, v);
      const root = cIR.nodes[0];
      if (root) edges.push({ id: `e:sequence:${agentId}→${p + root.id}`, kind: 'sequence', from: agentId, to: p + root.id });
    }
    if (terminal) {
      edges.push({ id: `e:return:${agentId}→${anchorId}`, kind: 'return', from: agentId, to: anchorId });
    }

    details.set(agentId, {
      kind: 'agent',
      prompt: label,
      result: terminal
        ? `process ${rt.state}${link.exitCode != null ? ` (exit ${link.exitCode})` : ''}`
        : null,
      transcript: [],
      runtime: { state: rt.state, source: rt.source, childAvailable: Boolean(child) },
      ...(child ? {} : { pending: 'child transcript not visible to the scanner yet' }),
    });
  }

  const runningChildren = linked.filter((x) => x.rt.state === 'running').length;
  // The run is live while any linked child runs, even when its own worker is idle.
  const metaState = parentState !== 'running' && runningChildren > 0 ? 'running' : parentState;
  const metaSource = metaState !== parentState ? 'linked-child' : parentSource;
  const totals = { ...(parentIR.meta.totals ?? {}) };
  for (const { child } of linked) {
    for (const key of ['tokens', 'toolCalls']) {
      const value = child?.ir?.meta?.totals?.[key];
      if (typeof value === 'number' && Number.isFinite(value)) totals[key] = (totals[key] ?? 0) + value;
    }
  }
  totals.agents = nodes.filter((n) => n.kind === 'agent').length;
  const ir = {
    ...parentIR,
    meta: {
      ...parentIR.meta,
      totals,
      ext: {
        ...(parentIR.meta.ext ?? {}),
        runtime: {
          state: metaState,
          source: metaSource,
          ...(parent?.model ? { model: parent.model } : {}),
          linkedChildren: linked.length,
          totalChildren: totals.agents,
          runningChildren: nodes.filter((n) => n.kind === 'agent' && n.ext?.runtime?.state === 'running').length,
        },
      },
    },
    nodes,
    edges,
    groups,
  };
  attachSignals(ir);
  return { ir, details };
}
