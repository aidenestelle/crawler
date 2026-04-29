/**
 * Handler-level event emission tests (Epic 5 T-5.1).
 *
 * Verifies that runClaimedJob emits scan_started on entry, scan_completed on
 * the happy path, and scan_failed on the error path. We mock Playwright and
 * the queue update helpers so the handler can run end-to-end without network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mocks ------------------------------------------------------------------

vi.mock('../utils/events.js', () => ({
  emitEvent: vi.fn(),
}))

vi.mock('../queue/claim.js', () => ({
  completeJob: vi.fn(async () => {}),
  failJob: vi.fn(async () => {}),
  releaseJob: vi.fn(async () => {}),
}))

vi.mock('../verify/verify.js', () => ({
  runAiVerification: vi.fn(async () => ({
    privacyPolicyScore: 3,
    privacyPolicyMissing: [],
    phiFormRiskLevel: 'low',
    phiFormReasoning: '',
    unknownTrackerClassifications: {},
    provider: 'gemini-2.5-flash',
    latencyMs: 42,
  })),
}))

vi.mock('../verify/ai-client.js', () => ({
  getAiProvider: vi.fn(() => ({ name: 'gemini-2.5-flash' })),
}))

// Playwright mock — a fake browser/page that's just enough for performScan.
const makePage = () => ({
  on: vi.fn(),
  goto: vi.fn(async () => ({
    securityDetails: async () => ({ protocol: 'TLS 1.3' }),
  })),
  waitForLoadState: vi.fn(async () => {}),
  waitForTimeout: vi.fn(async () => {}),
  content: vi.fn(async () => '<html><body></body></html>'),
  locator: vi.fn(() => ({
    first: () => ({ click: vi.fn(async () => { throw new Error('no consent') }) }),
  })),
})

let launchImpl: () => Promise<unknown> = async () => ({
  newContext: async () => ({ newPage: async () => makePage() }),
  close: async () => {},
})

vi.mock('playwright', () => ({
  chromium: { launch: vi.fn(() => launchImpl()) },
}))

// --- Imports (after mocks) --------------------------------------------------
import { runClaimedJob } from './hipaa-deep-scan.js'
import { emitEvent } from '../utils/events.js'
import { completeJob, failJob, releaseJob } from '../queue/claim.js'
import type { ClaimedJob } from '../queue/claim.js'

const baseJob: ClaimedJob = {
  id: 'job-123',
  url: 'https://example.com',
  requested_by: null,
  status: 'running',
  claimed_by: 'worker-1',
  claim_count: 1,
  created_at: '2026-04-12T00:00:00Z',
  started_at: '2026-04-12T00:00:01Z',
}

// Minimal Supabase stub — never actually called because queue helpers are mocked.
const supabase = {} as never

describe('runClaimedJob events', () => {
  beforeEach(() => {
    vi.mocked(emitEvent).mockClear()
    vi.mocked(completeJob).mockClear()
    vi.mocked(failJob).mockClear()
    vi.mocked(releaseJob).mockClear()
    launchImpl = async () => ({
      newContext: async () => ({ newPage: async () => makePage() }),
      close: async () => {},
    })
  })

  it('emits scan_started then scan_completed on happy path', async () => {
    await runClaimedJob(supabase, baseJob)

    expect(completeJob).toHaveBeenCalledTimes(1)
    expect(failJob).not.toHaveBeenCalled()
    expect(releaseJob).not.toHaveBeenCalled()

    const calls = vi.mocked(emitEvent).mock.calls
    expect(calls.map((c) => c[0])).toEqual(['scan_started', 'scan_completed'])

    const started = calls[0]![1] as unknown as Record<string, unknown>
    expect(started).toMatchObject({
      jobId: 'job-123',
      url: 'https://example.com',
      provider: 'gemini-2.5-flash',
      workerId: 'worker-1',
    })

    const completed = calls[1]![1] as unknown as Record<string, unknown>
    expect(completed).toMatchObject({
      jobId: 'job-123',
      score: 3,
      aiProvider: 'gemini-2.5-flash',
      aiLatencyMs: 42,
    })
    expect(typeof completed.durationMs).toBe('number')
    expect(completed.overallStatus).toBeDefined()
  })

  it('emits scan_started then scan_failed on failure (willRetry=true when under max)', async () => {
    launchImpl = async () => {
      throw new Error('chromium launch failed')
    }

    await runClaimedJob(supabase, { ...baseJob, claim_count: 1 })

    expect(releaseJob).toHaveBeenCalledTimes(1)
    expect(failJob).not.toHaveBeenCalled()

    const calls = vi.mocked(emitEvent).mock.calls
    expect(calls.map((c) => c[0])).toEqual(['scan_started', 'scan_failed'])

    const failed = calls[1]![1] as unknown as Record<string, unknown>
    expect(failed).toMatchObject({
      jobId: 'job-123',
      error: 'chromium launch failed',
      claimCount: 1,
      willRetry: true,
    })
    expect(typeof failed.durationMs).toBe('number')
  })

  it('emits scan_failed with willRetry=false when claim_count hit max', async () => {
    launchImpl = async () => {
      throw new Error('still broken')
    }

    await runClaimedJob(supabase, { ...baseJob, claim_count: 3 })

    expect(failJob).toHaveBeenCalledTimes(1)
    expect(releaseJob).not.toHaveBeenCalled()

    const calls = vi.mocked(emitEvent).mock.calls
    const failed = calls[1]![1] as unknown as Record<string, unknown>
    expect(failed.willRetry).toBe(false)
    expect(failed.claimCount).toBe(3)
  })
})
