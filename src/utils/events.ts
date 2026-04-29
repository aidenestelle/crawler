/**
 * Structured event logger (Epic 5 T-5.1).
 *
 * Emits one JSON object per line to stdout. Each event has a bounded, PII-safe
 * shape: only IDs, counts, durations, provider names, and short error strings.
 * Never includes privacy policy text, AI response text, or raw HTML.
 *
 * Consumed by Fly.io / Docker log aggregators — one event = one line.
 */

export type EventName =
  | 'scan_started'
  | 'scan_completed'
  | 'scan_failed'
  | 'scan_reaped'
  | 'worker_boot'
  | 'worker_shutdown'

interface ScanStarted {
  jobId: string
  url: string
  provider: string
  workerId: string
}

interface ScanCompleted {
  jobId: string
  durationMs: number
  score: number
  overallStatus: string
  aiProvider: string
  aiLatencyMs: number | null
}

interface ScanFailed {
  jobId: string
  durationMs: number
  error: string
  claimCount: number
  willRetry: boolean
}

interface ScanReaped {
  reapedCount: number
}

interface WorkerBoot {
  workerId: string
  provider: string
  concurrency: number
  version: string
}

interface WorkerShutdown {
  workerId: string
  inFlightJobsDrained: number
  durationMs: number
}

export interface EventMap {
  scan_started: ScanStarted
  scan_completed: ScanCompleted
  scan_failed: ScanFailed
  scan_reaped: ScanReaped
  worker_boot: WorkerBoot
  worker_shutdown: WorkerShutdown
}

/** Truncate any string field to a safe length so no event can blow the line budget. */
function truncate(s: string, max = 500): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}

/**
 * Emit a structured event as a single JSON line on stdout.
 * Never throws — a failure here must not take the worker down.
 */
export function emitEvent<E extends EventName>(
  name: E,
  payload: EventMap[E]
): void {
  try {
    // Normalize: truncate string fields so we never emit an unbounded line.
    const safe: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(payload as unknown as Record<string, unknown>)) {
      safe[k] = typeof v === 'string' ? truncate(v) : v
    }
    const line = JSON.stringify({
      event: name,
      ts: new Date().toISOString(),
      ...safe,
    })
    // Use process.stdout.write for deterministic one-line output.
    process.stdout.write(line + '\n')
  } catch {
    // Intentionally swallow — telemetry must never break the worker.
  }
}
