import { open, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { statOrNull } from '../../util.js';
import { processIdentity, PROC_SLACK_SEC } from '../../procfs.js';

/**
 * Hermes activity — is this session's worker actually running right now?
 *
 * Evidence, all of it required for `running`:
 *   1. the newest turn journal for the session (`<webui>/sessions/_turn_journal/
 *      <sid>~<pid>.jsonl`) ends in an OPEN stream (no completed/interrupted);
 *   2. that stream has a `worker_started` event, and the worker PID named in the
 *      journal file is alive and started no later than that event (plus slack) —
 *      a PID started AFTER its own worker_started is a reused PID;
 *   3. the session's sidecar (`<webui>/sessions/<sid>.json`) names the same
 *      stream in `active_stream_id`.
 * A terminal event is `completed`. Everything else is `unknown` — never a
 * fabricated `running`, and never `completed` without a terminal event.
 *
 * Recency is deliberately NOT evidence. The journal's mtime only bounds how far
 * back we look (a worker can be silent for minutes inside one tool call), so a
 * quiet journal stays `running` while its worker lives.
 *
 * Only a tail/head window of each journal is read, and the sidecar's head.
 * The sidecar can be tens of MB; `active_stream_id` sits near the top.
 *
 * Known limit (documented, not guessed around): a turn with very many events
 * can push its `worker_started` out of the head+tail window. The result is
 * `unknown` with reason `no-worker-evidence` — never a false `running`.
 * A journal idle for more than 12 hours is not evidence at all (null).
 */

const JOURNAL_WINDOW_MS = 12 * 60 * 60 * 1000;
const HEAD_BYTES = 16 * 1024;
const TAIL_BYTES = 64 * 1024;
const SIDECAR_HEAD_BYTES = 256 * 1024;
const TERMINAL_EVENTS = new Set(['completed', 'interrupted']);
const ACTIVE_RE = /"active_stream_id"\s*:\s*(null|"([^"]*)")/;

/**
 * Where the webui keeps its sessions/journals. `RUNGRAPH_HERMES_WEBUI_SESSIONS`
 * overrides it (tests; '' disables). Profile DBs live at `<root>/profiles/<name>/`,
 * and the webui is per-root, so the root is the directory above `profiles/`.
 */
export function webuiSessionsDir(ref) {
  const override = process.env.RUNGRAPH_HERMES_WEBUI_SESSIONS;
  if (override !== undefined) return override || null;
  if (typeof ref.dbPath !== 'string') return null;
  const dir = dirname(ref.dbPath);
  const root = /[\\/]profiles[\\/][^\\/]+$/.test(dir) ? dirname(dirname(dir)) : dir;
  return join(root, 'webui', 'sessions');
}

/**
 * @param {import('./detect.js').HermesRunRef} ref
 * @param {{ now?: number, cache?: Map<string, any> }} [ctx]  one scan's shared
 *   context: the journal directory is listed once per scan, not per run.
 * @returns {Promise<null|{ state: 'running'|'completed'|'unknown', source: 'hermes-journal',
 *   streamId?: string, workerPid?: number, startedAt?: string, reason?: string }>}
 *   null when this session has no journal at all (no claim is made).
 */
export async function activity(ref, ctx = {}) {
  const webui = webuiSessionsDir(ref);
  if (!webui) return null;
  const newest = (await journalIndex(join(webui, '_turn_journal'), ctx)).get(ref.sessionId)?.[0];
  if (!newest) return null;
  const now = ctx.now ?? Date.now();
  if (now - newest.mtimeMs > JOURNAL_WINDOW_MS) return null;

  const events = await readEvents(newest.path, newest.size);
  const last = events.at(-1);
  if (!last) return unknown('empty-journal');
  if (TERMINAL_EVENTS.has(last.event)) {
    // An interrupted turn did not finish its work: error, never a success.
    if (last.event === 'interrupted') {
      return { state: 'error', source: 'hermes-journal', streamId: last.stream_id, reason: 'interrupted' };
    }
    return { state: 'completed', source: 'hermes-journal', streamId: last.stream_id };
  }

  const streamId = last.stream_id;
  const started = events.find((e) => e.event === 'worker_started' && e.stream_id === streamId);
  if (!started) return unknown('no-worker-evidence', streamId);
  const createdSec = Number(started.created_at);
  if (!Number.isFinite(createdSec)) return unknown('no-worker-evidence', streamId);

  const proc = await processIdentity(newest.pid);
  if (!proc) return unknown('worker-not-running', streamId);
  if (proc.startEpochSec == null) return unknown('identity-unavailable', streamId);
  // Started after its own worker_started: this PID now belongs to something else.
  if (proc.startEpochSec > createdSec + PROC_SLACK_SEC) return unknown('pid-reused', streamId);

  const sidecar = await activeStreamOf(webui, ref.sessionId);
  if (sidecar === undefined) return unknown('sidecar-unreadable', streamId);
  if (sidecar !== streamId) return unknown('sidecar-stream-mismatch', streamId);

  return {
    state: 'running',
    source: 'hermes-journal',
    streamId,
    workerPid: newest.pid,
    startedAt: new Date(createdSec * 1000).toISOString(),
  };
}

function unknown(reason, streamId) {
  return { state: 'unknown', source: 'hermes-journal', reason, ...(streamId ? { streamId } : {}) };
}

/** sid → journal files newest-first, listed once per scan (ctx.cache). */
async function journalIndex(jdir, ctx) {
  const cache = ctx.cache ?? new Map();
  const key = `journal:${jdir}`;
  if (cache.has(key)) return cache.get(key);
  const bySid = new Map();
  let names = [];
  try {
    names = await readdir(jdir);
  } catch {
    /* no journal directory: a CLI-only profile */
  }
  for (const name of names) {
    const m = /^([^~]+)~(\d+)\.jsonl$/.exec(name);
    if (!m) continue;
    const path = join(jdir, name);
    const st = await statOrNull(path);
    if (!st) continue;
    const list = bySid.get(m[1]) ?? [];
    list.push({ path, pid: Number(m[2]), mtimeMs: st.mtimeMs, size: st.size });
    bySid.set(m[1], list);
  }
  for (const list of bySid.values()) list.sort((a, b) => b.mtimeMs - a.mtimeMs);
  cache.set(key, bySid);
  return bySid;
}

/** Head plus tail of one journal; a line cut by either window edge is dropped. */
async function readEvents(path, size) {
  let fh;
  try {
    fh = await open(path, 'r');
  } catch {
    return [];
  }
  let text;
  try {
    if (size <= HEAD_BYTES + TAIL_BYTES) {
      const buf = Buffer.alloc(size);
      await fh.read(buf, 0, size, 0);
      text = buf.toString('utf8');
    } else {
      const head = Buffer.alloc(HEAD_BYTES);
      await fh.read(head, 0, HEAD_BYTES, 0);
      let headText = head.toString('utf8');
      headText = headText.slice(0, headText.lastIndexOf('\n') + 1);
      const tail = Buffer.alloc(TAIL_BYTES);
      await fh.read(tail, 0, TAIL_BYTES, size - TAIL_BYTES);
      let tailText = tail.toString('utf8');
      tailText = tailText.slice(tailText.indexOf('\n') + 1);
      text = headText + '\n' + tailText;
    }
  } catch {
    text = '';
  } finally {
    await fh.close();
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o === 'object') out.push(o);
    } catch {
      /* partial line mid-write — tolerated */
    }
  }
  return out;
}

/** The sidecar's active stream: string, null (idle), or undefined (unreadable). */
async function activeStreamOf(webui, sid) {
  let fh;
  try {
    fh = await open(join(webui, `${sid}.json`), 'r');
  } catch {
    return undefined;
  }
  try {
    const buf = Buffer.alloc(SIDECAR_HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, SIDECAR_HEAD_BYTES, 0);
    const m = ACTIVE_RE.exec(buf.toString('utf8', 0, bytesRead));
    if (!m) return undefined;
    return m[1] === 'null' ? null : m[2];
  } catch {
    return undefined;
  } finally {
    await fh.close();
  }
}
