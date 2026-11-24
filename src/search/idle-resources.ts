/**
 * Idle-resource helpers for the background indexer.
 *
 * The indexer is a background task on the same machine the user is working on.
 * It must therefore use what the machine has left over, not what it can take:
 * a background task that competes with the foreground work makes both slower,
 * and on a memory-tight machine it pushes the foreground into swap.
 *
 * Two signals decide whether a background batch may run:
 *   - the machine load average, so the batch waits while the machine is busy;
 *   - the process priority, so the batch yields to whatever else is running.
 */

import { cpus, loadavg, setPriority } from 'node:os'

/**
 * The default load average above which the machine counts as busy.
 *
 * A quarter of the cores is the threshold: below it the machine has spare
 * capacity, above it the background task would compete with the foreground
 * work the user is waiting on.
 */
function defaultMaxLoad(): number {
  const cores = cpus().length || 1
  return Math.max(1, Math.ceil(cores / 4))
}

/**
 * Whether the machine currently has idle capacity for a background batch.
 *
 * @param maxLoad - Load average above which the machine counts as busy.
 *   Defaults to a quarter of the cores, or `YOMI_EMBED_MAX_LOAD` when set.
 * @returns True when the machine is idle enough for background work.
 */
export function isMachineIdle(maxLoad?: number): boolean {
  const configured = Number(process.env.YOMI_EMBED_MAX_LOAD)
  const threshold =
    typeof maxLoad === 'number' && !Number.isNaN(maxLoad)
      ? maxLoad
      : Number.isFinite(configured) && configured > 0
        ? configured
        : defaultMaxLoad()
  const load = loadavg()[0] ?? 0
  return load < threshold
}

/**
 * The load average the machine currently reports.
 *
 * @returns The one-minute load average.
 */
export function currentLoad(): number {
  return loadavg()[0] ?? 0
}

/**
 * Run a task at a low process priority and restore the priority afterwards.
 *
 * The scheduler then prefers whatever the user is doing, and the background
 * batch only gets the CPU that is genuinely free. The priority is restored
 * even when the task throws, so a failed batch cannot leave the whole server
 * deprioritized.
 *
 * @param task - The work to run.
 * @param priority - The nice value to use while the task runs.
 * @returns Whatever the task returns.
 */
export async function withLowPriority<T>(
  task: () => Promise<T>,
  priority = 10,
): Promise<T> {
  let changed = false
  try {
    setPriority(process.pid, priority)
    changed = true
  } catch {
    // Lowering the priority is an optimization, not a requirement: a platform
    // that refuses it must not stop the background work.
  }
  try {
    return await task()
  } finally {
    if (changed) {
      try {
        setPriority(process.pid, 0)
      } catch {
        // The priority stays lowered until the process exits; the next batch
        // restores it again.
      }
    }
  }
}
