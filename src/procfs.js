import { readFile } from 'node:fs/promises';

/**
 * Linux process identity — the evidence that a PID still names the process
 * that was launched. Pure reads of /proc, no I/O beyond that.
 *
 * On platforms without /proc every call returns null, and callers MUST read
 * null as unknown, never as running.
 *
 * Start time is field 22 of /proc/<pid>/stat, in clock ticks since boot. The
 * tick rate is USER_HZ (100 on every Linux ABI rungraph targets). The epoch
 * derived from it is only ever compared against a slack window, never shown.
 */

export const PROC_SLACK_SEC = 5;
const USER_HZ = 100;

let bootTimeCache = null;

/** The kernel's per-boot UUID, or null when unavailable. */
export async function bootId() {
  try {
    return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() || null;
  } catch {
    return null;
  }
}

async function bootTimeSec() {
  if (bootTimeCache != null) return bootTimeCache;
  try {
    const m = /^btime (\d+)/m.exec(await readFile('/proc/stat', 'utf8'));
    if (m) bootTimeCache = Number(m[1]);
  } catch {
    /* no /proc */
  }
  return bootTimeCache;
}

/**
 * @param {number} pid
 * @returns {Promise<{ startTicks: string, startEpochSec: number|null } | null>}
 *   null when the process does not exist, is a zombie, or /proc is absent.
 */
export async function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let raw;
  try {
    raw = await readFile(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  // comm (field 2) may contain spaces and parens; everything after the LAST ')'
  // starts at field 3 (state), so starttime (field 22) is index 19 there.
  const close = raw.lastIndexOf(')');
  if (close < 0) return null;
  const fields = raw.slice(close + 2).trim().split(/\s+/);
  if (fields[0] === 'Z' || fields[0] === 'X') return null;
  const ticks = fields[19];
  if (!/^\d+$/.test(ticks ?? '')) return null;
  const bt = await bootTimeSec();
  return {
    startTicks: ticks,
    startEpochSec: bt == null ? null : bt + Number(ticks) / USER_HZ,
  };
}
