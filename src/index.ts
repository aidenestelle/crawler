/**
 * Estellebot — HIPAA Deep-Scan Worker
 *
 * Boots Supabase, subscribes to Realtime for wake-up pings, drives a
 * concurrency-bounded claim loop backed by `claim_hipaa_deep_scan` +
 * `reap_stuck_hipaa_deep_scans` (migration 012), and shuts down gracefully
 * on SIGINT/SIGTERM.
 *
 * Shutdown order (Epic 5 / Q-E4-SHUTDOWN-HEALTHZ-ORDER): see src/shutdown.ts.
 */
import 'dotenv/config'
import { createClient, type RealtimeChannel } from '@supabase/supabase-js'
import { logger } from './utils/logger.js'
import { emitEvent } from './utils/events.js'
import { createWorkerId } from './queue/worker-id.js'
import { claimJob, reapStuck } from './queue/claim.js'
import { subscribeWakeUp } from './queue/realtime.js'
import { runClaimedJob } from './handlers/hipaa-deep-scan.js'
import { resolveEager } from './verify/ai-client.js'
import { createHealthServer, type HealthServer } from './health.js'
import { runShutdown } from './shutdown.js'
import { WORKER_VERSION } from './version.js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  logger.error(
    '[estellebot] Missing required environment variables: SUPABASE_URL and SUPABASE_SERVICE_KEY'
  )
  process.exit(1)
}

const WORKER_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.WORKER_CONCURRENCY ?? '3', 10) || 3
)
const REAPER_INTERVAL_MS = Math.max(
  5_000,
  Number.parseInt(process.env.REAPER_INTERVAL_MS ?? '30000', 10) || 30_000
)
const REAPER_TIMEOUT_MS = Math.max(
  60_000,
  Number.parseInt(process.env.REAPER_TIMEOUT_MS ?? '180000', 10) || 180_000
)
const SHUTDOWN_GRACE_MS = Math.max(
  10_000,
  Number.parseInt(process.env.GRACEFUL_SHUTDOWN_MS ?? '120000', 10) || 120_000
)
const WORKER_ID = createWorkerId(process.env.WORKER_ID_PREFIX)

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// --- Worker state ------------------------------------------------------------
const inflight = new Set<Promise<void>>()
let shuttingDown = false
let wakeChannel: RealtimeChannel | null = null
let reaperTimer: NodeJS.Timeout | null = null
let healthServer: HealthServer | null = null
let activeProviderName = 'disabled'

function pgIntervalFromMs(ms: number): string {
  return `${Math.round(ms / 1000)} seconds`
}

async function tick(): Promise<void> {
  if (shuttingDown) return
  while (!shuttingDown && inflight.size < WORKER_CONCURRENCY) {
    const job = await claimJob(supabase, WORKER_ID).catch((err) => {
      logger.error('[estellebot] claimJob threw:', err)
      return null
    })
    if (!job) break
    logger.info(
      `[estellebot] claimed job ${job.id} (inflight=${inflight.size + 1}/${WORKER_CONCURRENCY})`
    )
    const p = runClaimedJob(supabase, job)
      .catch((err) => {
        logger.error(`[estellebot] runClaimedJob unhandled for ${job.id}:`, err)
      })
      .finally(() => {
        inflight.delete(p)
        if (!shuttingDown) void tick()
      })
    inflight.add(p)
  }
}

async function reapAndTick(): Promise<void> {
  try {
    const reaped = await reapStuck(supabase, pgIntervalFromMs(REAPER_TIMEOUT_MS))
    if (reaped > 0) {
      logger.info(`[estellebot] reaper released ${reaped} stuck job(s)`)
      emitEvent('scan_reaped', { reapedCount: reaped })
    }
  } catch (err) {
    logger.error('[estellebot] reaper error:', err)
  }
  void tick()
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  const startDraining = inflight.size
  logger.info(
    `[estellebot] received ${signal} — closing health then draining ${startDraining} job(s)`
  )

  const trace = await runShutdown({
    closeHealth: async () => {
      if (healthServer) {
        await healthServer.close()
        healthServer = null
      }
    },
    stopClaimLoop: () => {
      shuttingDown = true
    },
    stopReaper: () => {
      if (reaperTimer) {
        clearInterval(reaperTimer)
        reaperTimer = null
      }
    },
    drainInflight: async (graceMs) => {
      const waitAll = Promise.allSettled(inflight).then(() => 'done' as const)
      const timeout = new Promise<'timeout'>((res) =>
        setTimeout(() => res('timeout'), graceMs)
      )
      return Promise.race([waitAll, timeout])
    },
    closeRealtime: async () => {
      if (wakeChannel) {
        await supabase.removeChannel(wakeChannel)
        wakeChannel = null
      }
    },
    log: (m) => logger.warn('[estellebot] ' + m),
    graceMs: SHUTDOWN_GRACE_MS,
  })

  if (trace.drainOutcome === 'timeout') {
    logger.warn(
      `[estellebot] shutdown hard-cap hit (${SHUTDOWN_GRACE_MS}ms); ${inflight.size} job(s) still in-flight — they will be reaped`
    )
  } else {
    logger.info('[estellebot] all in-flight jobs complete')
  }

  emitEvent('worker_shutdown', {
    workerId: WORKER_ID,
    inFlightJobsDrained: startDraining - inflight.size,
    durationMs: trace.durationMs,
  })

  logger.info('[estellebot] shutdown complete')
  process.exit(0)
}

async function main(): Promise<void> {
  logger.info('[estellebot] HIPAA deep-scan worker starting...')
  logger.info(`[estellebot] worker_id=${WORKER_ID} version=${WORKER_VERSION}`)
  logger.info(
    `[estellebot] concurrency=${WORKER_CONCURRENCY} reaper_interval_ms=${REAPER_INTERVAL_MS} reaper_timeout_ms=${REAPER_TIMEOUT_MS}`
  )
  logger.info(`[estellebot] Supabase URL: ${SUPABASE_URL}`)

  const provider = resolveEager()
  activeProviderName = provider.name

  emitEvent('worker_boot', {
    workerId: WORKER_ID,
    provider: activeProviderName,
    concurrency: WORKER_CONCURRENCY,
    version: WORKER_VERSION,
  })

  const healthPort = Math.max(
    1,
    Number.parseInt(process.env.PORT ?? '8080', 10) || 8080
  )
  healthServer = createHealthServer({
    port: healthPort,
    state: {
      getActiveJobs: () => inflight.size,
      getProvider: () => activeProviderName,
      getWorkerId: () => WORKER_ID,
      getVersion: () => WORKER_VERSION,
      getShuttingDown: () => shuttingDown,
    },
  })
  try {
    const bound = await healthServer.listening
    logger.info(`[estellebot] /healthz listening on :${bound}`)
  } catch (err) {
    logger.error('[estellebot] failed to start /healthz server:', err)
    healthServer = null
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  if (process.env.HIPAA_DEEP_SCAN_ENABLED === 'false') {
    logger.warn('[estellebot] HIPAA_DEEP_SCAN_ENABLED=false — worker idle')
    return
  }

  wakeChannel = subscribeWakeUp(supabase, () => {
    if (!shuttingDown) void tick()
  })

  await reapAndTick()
  reaperTimer = setInterval(() => void reapAndTick(), REAPER_INTERVAL_MS)

  logger.info('[estellebot] worker ready')
}

main().catch((error) => {
  logger.error('[estellebot] fatal error:', error)
  process.exit(1)
})
