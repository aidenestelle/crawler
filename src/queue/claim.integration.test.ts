/**
 * Integration test for the atomic claim + reap contract (Epic 5 T-5.4).
 *
 * Skipped unless SUPABASE_TEST_URL and SUPABASE_TEST_SERVICE_KEY are set.
 * See docs/deploy.md → "Testing" for the required env vars.
 *
 * What this verifies:
 *   1. 3 workers racing `claim_hipaa_deep_scan` against 10 pending rows each
 *      claim exactly 10 distinct rows — no duplicate claims, no lost rows.
 *   2. `reap_stuck_hipaa_deep_scans` flips a stuck `running` row back to
 *      `pending` when claim_count < 3.
 *   3. The same reap call flips a stuck row with claim_count=3 to `failed`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { claimJob, reapStuck, type ClaimedJob } from './claim.js'

const TEST_URL = process.env.SUPABASE_TEST_URL
const TEST_KEY = process.env.SUPABASE_TEST_SERVICE_KEY
const enabled = Boolean(TEST_URL && TEST_KEY)

// describe.skipIf keeps the suite green when env is absent (vitest >= 0.31).
describe.skipIf(!enabled)('claim + reap integration', () => {
  let supabase: SupabaseClient
  const insertedIds: string[] = []

  beforeAll(async () => {
    supabase = createClient(TEST_URL!, TEST_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    // Sanity: the RPC must exist. This surfaces a clear failure if the test
    // project was pointed at a DB that hasn't had migration 012 applied.
    const { error } = await supabase.rpc('claim_hipaa_deep_scan', {
      p_worker_id: 'integration-test-sanity',
    })
    if (error && /does not exist/i.test(error.message)) {
      throw new Error(
        `SUPABASE_TEST_URL is missing migration 012 (${error.message}). ` +
          'See docs/deploy.md → Testing.'
      )
    }
  })

  afterAll(async () => {
    if (insertedIds.length > 0) {
      await supabase.from('hipaa_deep_scans').delete().in('id', insertedIds)
    }
  })

  it('3 racing workers claim exactly 10 distinct rows with no duplicates', async () => {
    // Insert 10 pending rows.
    const rows = Array.from({ length: 10 }, (_, i) => ({
      url: `https://example-epic5-${Date.now()}-${i}.test/`,
      status: 'pending' as const,
    }))
    const { data: inserted, error: insErr } = await supabase
      .from('hipaa_deep_scans')
      .insert(rows)
      .select('id')
    expect(insErr).toBeNull()
    expect(inserted).toHaveLength(10)
    for (const r of inserted!) insertedIds.push(r.id)

    // 3 simulated workers race the claim RPC until the pool is drained.
    const workerIds = ['w-A', 'w-B', 'w-C']
    const claimedByWorker: Record<string, ClaimedJob[]> = { 'w-A': [], 'w-B': [], 'w-C': [] }

    async function drain(workerId: string) {
      while (true) {
        const job = await claimJob(supabase, workerId)
        if (!job) return
        // Only count rows we inserted for this test run.
        if (insertedIds.includes(job.id)) {
          claimedByWorker[workerId]!.push(job)
        }
        if (claimedByWorker['w-A']!.length + claimedByWorker['w-B']!.length + claimedByWorker['w-C']!.length >= 10) {
          return
        }
      }
    }

    await Promise.all(workerIds.map(drain))

    const all = [...claimedByWorker['w-A']!, ...claimedByWorker['w-B']!, ...claimedByWorker['w-C']!]
    const uniqueIds = new Set(all.map((j) => j.id))

    expect(all.length).toBe(10)
    expect(uniqueIds.size).toBe(10) // No duplicates across workers.
    // Each row's claimed_by must match a single worker_id.
    for (const job of all) {
      expect(workerIds).toContain(job.claimed_by)
    }
  }, 30_000)

  it('reaps a stuck running row (claim_count < 3) back to pending', async () => {
    const { data: ins, error } = await supabase
      .from('hipaa_deep_scans')
      .insert({
        url: `https://example-epic5-reap-retry-${Date.now()}.test/`,
        status: 'running',
        claimed_by: 'ghost-worker',
        claim_count: 1,
        started_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      })
      .select('id')
      .single()
    expect(error).toBeNull()
    insertedIds.push(ins!.id)

    const reaped = await reapStuck(supabase, '60 seconds')
    expect(reaped).toBeGreaterThanOrEqual(1)

    const { data: after } = await supabase
      .from('hipaa_deep_scans')
      .select('status')
      .eq('id', ins!.id)
      .single()
    expect(after?.status).toBe('pending')
  }, 15_000)

  it('fails a stuck row whose claim_count has reached the ceiling (3)', async () => {
    const { data: ins, error } = await supabase
      .from('hipaa_deep_scans')
      .insert({
        url: `https://example-epic5-reap-fail-${Date.now()}.test/`,
        status: 'running',
        claimed_by: 'ghost-worker',
        claim_count: 3,
        started_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      })
      .select('id')
      .single()
    expect(error).toBeNull()
    insertedIds.push(ins!.id)

    await reapStuck(supabase, '60 seconds')

    const { data: after } = await supabase
      .from('hipaa_deep_scans')
      .select('status')
      .eq('id', ins!.id)
      .single()
    expect(after?.status).toBe('failed')
  }, 15_000)
})

// Always-present marker test so vitest reports "skipped" rather than "no tests"
// when env vars are missing.
describe('claim integration (env guard)', () => {
  it.skipIf(enabled)('is skipped without SUPABASE_TEST_URL / SUPABASE_TEST_SERVICE_KEY', () => {
    expect(enabled).toBe(false)
  })
})
