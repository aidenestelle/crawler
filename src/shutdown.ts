/**
 * Shutdown orchestration (Epic 5 T-5.3).
 *
 * Extracted from index.ts so it can be unit-tested without booting the worker.
 * Order (per CTO Q-E4-SHUTDOWN-HEALTHZ-ORDER):
 *   1. Close health server FIRST — Fly's probe fails, platform stops traffic.
 *   2. Set shuttingDown flag so the claim loop stops pulling new jobs.
 *   3. Clear reaper timer.
 *   4. Drain in-flight jobs up to graceMs.
 *   5. Close realtime channel.
 *   6. Resolve (caller is responsible for process.exit).
 */

export interface ShutdownDeps {
  /** Close the health server. Called FIRST. */
  closeHealth: () => Promise<void>
  /** Set the "no more claiming" flag in the worker. Called SECOND. */
  stopClaimLoop: () => void
  /** Clear the reaper interval timer. */
  stopReaper: () => void
  /** Await drain of in-flight work; honor graceMs. Returns 'done' or 'timeout'. */
  drainInflight: (graceMs: number) => Promise<'done' | 'timeout'>
  /** Close realtime channel (best-effort). */
  closeRealtime: () => Promise<void>
  /** Log sink — plain string logger. */
  log?: (msg: string) => void
  /** Grace period for drain. */
  graceMs: number
}

export interface ShutdownTrace {
  steps: string[]
  drainOutcome: 'done' | 'timeout'
  durationMs: number
}

/**
 * Execute shutdown in the canonical order. Returns a trace for tests + metrics.
 * Always resolves (never rejects) — individual steps' errors are logged and
 * swallowed so the process can exit cleanly.
 */
export async function runShutdown(deps: ShutdownDeps): Promise<ShutdownTrace> {
  const start = Date.now()
  const steps: string[] = []
  const log = deps.log ?? (() => {})

  // 1. Health server FIRST so Fly's probe stops routing traffic.
  try {
    await deps.closeHealth()
    steps.push('health_closed')
  } catch (err) {
    log(`shutdown: closeHealth failed: ${String(err)}`)
    steps.push('health_close_failed')
  }

  // 2. Stop the claim loop (flag flip; synchronous).
  deps.stopClaimLoop()
  steps.push('claim_loop_stopped')

  // 3. Stop reaper timer.
  try {
    deps.stopReaper()
    steps.push('reaper_stopped')
  } catch (err) {
    log(`shutdown: stopReaper failed: ${String(err)}`)
  }

  // 4. Drain in-flight jobs.
  const outcome = await deps.drainInflight(deps.graceMs)
  steps.push(outcome === 'done' ? 'drain_done' : 'drain_timeout')

  // 5. Realtime last — not critical for correctness.
  try {
    await deps.closeRealtime()
    steps.push('realtime_closed')
  } catch (err) {
    log(`shutdown: closeRealtime failed: ${String(err)}`)
  }

  return {
    steps,
    drainOutcome: outcome,
    durationMs: Date.now() - start,
  }
}
