/**
 * HIPAA Deep Scan Handler
 *
 * Pure scan function: given a claimed job row from the queue, runs a
 * headless-Chromium scan and writes the result (or failure) back to
 * Supabase. Realtime/claim orchestration lives in `src/index.ts`; this
 * module no longer owns a channel subscription.
 *
 * Retry policy (paired with migration 012):
 *   - Transient errors (timeouts, network, playwright launch): the job is
 *     RELEASED back to pending when claim_count < MAX_CLAIMS so the reaper /
 *     next tick can retry it.
 *   - On claim_count >= MAX_CLAIMS, the job is marked 'failed' permanently.
 *   - Successful scans always write status='complete'.
 *
 * 90s hard cap preserved from the legacy implementation.
 */
import { chromium, Browser, Request as PwRequest } from 'playwright'
import type { SupabaseClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import * as cheerio from 'cheerio'
import { logger } from '../utils/logger.js'
import { ESTELLEBOT_USER_AGENT } from '../utils/user-agent.js'
import { completeJob, failJob, releaseJob, type ClaimedJob } from '../queue/claim.js'
import { fetchPrivacyText } from '../scan/privacy-fetcher.js'
import { extractPrimaryForm, type FormSummary } from '../scan/form-extractor.js'
import { collectUnknownTrackerDomains } from '../scan/unknown-trackers.js'
import { runAiVerification } from '../verify/verify.js'
import { getAiProvider } from '../verify/ai-client.js'
import type { AiVerification } from '../verify/types.js'
import { emitEvent } from '../utils/events.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// --- Vendored tracker defs ----------------------------------------------
// Source: estelle-tools-platform/src/lib/tools/hipaa-checker/data/trackers.json
// Synced 2026-04-11 (byte-identical).
interface TrackerDef {
  pattern: string
  name: string
  vendor: string
  riskLevel: 'high' | 'medium' | 'low'
  description: string
  baaAvailable: boolean
}
const TRACKERS: TrackerDef[] = JSON.parse(
  readFileSync(resolve(__dirname, '../data/trackers.json'), 'utf-8')
) as TrackerDef[]

// --- Types (mirror estelle-tools-platform HipaaResult, extended) --------
interface DetectedRuntimeTracker {
  name: string
  vendor: string
  riskLevel: 'high' | 'medium' | 'low'
  description: string
  baaAvailable: boolean
  exampleUrl: string
  requestCount: number
}

/**
 * Additive AI-layer input payload (Epic 2).
 *
 * This is the raw signal the Epic 3 verifier consumes. It is strictly
 * additive on the scan result — existing fields (runtimeTrackers, checks,
 * etc.) are unchanged, and the tools-platform UI ignores unknown keys.
 *
 * Caps (bound downstream AI token cost):
 *   - privacyPolicyText: ≤ 20_000 chars (enforced by privacy-fetcher)
 *   - unknownTrackerDomains: ≤ 20 entries (enforced by unknown-trackers)
 */
export interface DeepScanAiInput {
  privacyPolicyText: string
  detectedTrackers: Array<{ name: string; vendor: string; exampleUrl: string }>
  unknownTrackerDomains: string[]
  formSummary: FormSummary | null
}

interface DeepScanResult {
  scannedUrl: string
  scannedAt: string
  overallStatus: 'pass' | 'warning' | 'fail'
  checks: []
  criticalCount: number
  warningCount: number
  infoCount: number
  recommendations: []
  tlsVersion: string | null
  runtimeTrackers: DetectedRuntimeTracker[]
  deepScan: true
  rulesetVersion: string
  /** Epic 2 additive signal for the AI verification pass (Epic 3). */
  aiInput: DeepScanAiInput
  /** Epic 3 second-opinion verification result (disabled stub when AI off). */
  aiVerification: AiVerification
}

const HIPAA_DEEP_SCAN_TIMEOUT_MS = 90_000
const DEEP_RULESET_VERSION = '2026.04.11-deep'
/** Must match the ceiling in reap_stuck_hipaa_deep_scans (migration 012). */
const MAX_CLAIMS = 3

function matchRuntimeTrackers(urls: string[]): DetectedRuntimeTracker[] {
  const compiled = TRACKERS.map((t) => ({ def: t, re: new RegExp(t.pattern, 'i') }))
  const byName = new Map<string, DetectedRuntimeTracker>()
  for (const u of urls) {
    if (!u) continue
    for (const { def, re } of compiled) {
      if (!re.test(u)) continue
      const existing = byName.get(def.name)
      if (existing) {
        existing.requestCount++
      } else {
        byName.set(def.name, {
          name: def.name,
          vendor: def.vendor,
          riskLevel: def.riskLevel,
          description: def.description,
          baaAvailable: def.baaAvailable,
          exampleUrl: u,
          requestCount: 1,
        })
      }
    }
  }
  const rank = { high: 0, medium: 1, low: 2 } as const
  return [...byName.values()].sort((a, b) => rank[a.riskLevel] - rank[b.riskLevel])
}

async function tryAcceptConsent(page: import('playwright').Page): Promise<void> {
  const selectors = [
    '#onetrust-accept-btn-handler',
    'button#onetrust-accept-btn-handler',
    'button:has-text("Accept All")',
    'button:has-text("Accept all")',
    'button:has-text("I Accept")',
    'button:has-text("Allow all")',
    '#CybotCookiebotDialogBodyLevelButtonAcceptAll',
    'button:has-text("Agree")',
    'button:has-text("Accept")',
  ]
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first()
      await el.click({ timeout: 5000 })
      logger.info(`[hipaa-deep-scan] clicked consent: ${sel}`)
      await page.waitForTimeout(2000)
      return
    } catch {
      // try next selector
    }
  }
}

/**
 * Perform one deep scan. Throws on hard failure.
 * Pure function (no Supabase side effects).
 */
export async function performScan(url: string): Promise<DeepScanResult> {
  const scannedAt = new Date().toISOString()
  const requestUrls: string[] = []
  let tlsVersion: string | null = null
  let browser: Browser | null = null

  const overallDeadline = Date.now() + HIPAA_DEEP_SCAN_TIMEOUT_MS

  try {
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({
      userAgent: ESTELLEBOT_USER_AGENT,
      viewport: { width: 1280, height: 800 },
    })
    const page = await context.newPage()

    page.on('request', (req: PwRequest) => {
      requestUrls.push(req.url())
    })

    const remaining = () => Math.max(1000, overallDeadline - Date.now())

    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: Math.min(45_000, remaining()),
    })
    try {
      await page.waitForLoadState('load', {
        timeout: Math.min(10_000, remaining()),
      })
    } catch {
      // Some pages keep a loader pixel open — not fatal.
    }

    if (response) {
      try {
        const sec = await response.securityDetails()
        if (sec && sec.protocol) {
          tlsVersion = sec.protocol
        }
      } catch (err) {
        logger.warn('[hipaa-deep-scan] securityDetails failed:', err)
      }
    }

    if (remaining() > 8000) {
      await tryAcceptConsent(page)
    }

    try {
      await page.waitForLoadState('networkidle', {
        timeout: Math.min(15_000, remaining()),
      })
    } catch {
      // Not fatal.
    }

    const runtime = matchRuntimeTrackers(requestUrls)

    // --- AI-layer signal capture (Epic 2; consumed by Epic 3) ---------------
    // Each stage is isolated in try/catch so a failure in the additive layer
    // never breaks the deterministic scan result.
    let html = ''
    try {
      html = await page.content()
    } catch (err) {
      logger.warn('[hipaa-deep-scan] page.content() failed:', err)
    }

    let privacyPolicyText = ''
    let formSummary: FormSummary | null = null
    if (html) {
      const $ = cheerio.load(html)
      try {
        formSummary = extractPrimaryForm($, url)
      } catch (err) {
        logger.warn('[hipaa-deep-scan] form extraction failed:', err)
      }
      try {
        privacyPolicyText = await fetchPrivacyText($, url)
      } catch (err) {
        logger.warn('[hipaa-deep-scan] privacy fetch failed:', err)
      }
    }

    const compiledPatterns = TRACKERS.map((t) => new RegExp(t.pattern, 'i'))
    const unknownTrackerDomains = collectUnknownTrackerDomains(requestUrls, {
      knownPatterns: compiledPatterns,
      targetUrl: url,
    })

    const detectedTrackers = runtime.map((t) => ({
      name: t.name,
      vendor: t.vendor,
      exampleUrl: t.exampleUrl,
    }))

    const aiInput: DeepScanAiInput = {
      privacyPolicyText,
      detectedTrackers,
      unknownTrackerDomains,
      formSummary,
    }

    // Epic 3: AI verification pass. Always returns (throws are swallowed
    // into the disabled stub inside runAiVerification).
    const aiVerification = await runAiVerification(aiInput)

    return {
      scannedUrl: url,
      scannedAt,
      overallStatus: runtime.length > 0 ? 'warning' : 'pass',
      checks: [],
      criticalCount: 0,
      warningCount: runtime.length,
      infoCount: 0,
      recommendations: [],
      tlsVersion,
      runtimeTrackers: runtime,
      deepScan: true,
      rulesetVersion: DEEP_RULESET_VERSION,
      aiInput,
      aiVerification,
    }
  } finally {
    if (browser) {
      await browser.close().catch(() => {})
    }
  }
}

/**
 * Run one claimed job end-to-end. Writes status=complete on success, or
 * releases / fails on error based on `claim_count`. Never throws to the
 * caller — the worker pool wants a `.finally` hook, not a rejected promise.
 */
export async function runClaimedJob(
  supabase: SupabaseClient,
  job: ClaimedJob
): Promise<void> {
  logger.info(
    `[hipaa-deep-scan] starting job ${job.id} url=${job.url} claimed_by=${job.claimed_by} attempt=${job.claim_count}`
  )
  const started = Date.now()

  let providerName = 'unknown'
  try {
    providerName = getAiProvider().name
  } catch {
    // Telemetry best-effort — never break the scan on provider lookup.
  }
  const workerId =
    job.claimed_by ?? process.env.FLY_MACHINE_ID ?? process.env.HOSTNAME ?? 'unknown'

  emitEvent('scan_started', {
    jobId: job.id,
    url: job.url,
    provider: providerName,
    workerId,
  })

  try {
    const result = await Promise.race([
      performScan(job.url),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('deep scan exceeded 90s cap')),
          HIPAA_DEEP_SCAN_TIMEOUT_MS
        )
      ),
    ])

    await completeJob(supabase, job.id, result)
    const durationMs = Date.now() - started
    logger.info(`[hipaa-deep-scan] complete ${job.id} duration_ms=${durationMs}`)
    emitEvent('scan_completed', {
      jobId: job.id,
      durationMs,
      score: result.aiVerification?.privacyPolicyScore ?? 0,
      overallStatus: result.overallStatus,
      aiProvider: result.aiVerification?.provider ?? 'disabled',
      aiLatencyMs: result.aiVerification?.latencyMs ?? null,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`[hipaa-deep-scan] job ${job.id} errored:`, message)
    const willRetry = job.claim_count < MAX_CLAIMS
    if (!willRetry) {
      await failJob(supabase, job.id, message)
    } else {
      await releaseJob(supabase, job.id, message)
    }
    emitEvent('scan_failed', {
      jobId: job.id,
      durationMs: Date.now() - started,
      error: message,
      claimCount: job.claim_count,
      willRetry,
    })
  }
}
