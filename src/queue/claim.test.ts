/**
 * Unit tests for the queue claim module.
 *
 * Mocks the SupabaseClient's `rpc` / `from(...).update().eq()` surface so we
 * can assert that the right RPC name / args flow through and that the
 * composite-type-null case is coerced to `null` for callers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  claimJob,
  reapStuck,
  completeJob,
  failJob,
  releaseJob,
  type ClaimedJob,
} from './claim.js'

type RpcMock = ReturnType<typeof vi.fn>

function makeSupabaseStub(opts: {
  rpc?: (name: string, args: unknown) => Promise<{ data: unknown; error: unknown }>
  update?: (payload: unknown) => { eq: (col: string, val: unknown) => Promise<{ error: unknown }> }
}) {
  const rpc = vi.fn(opts.rpc ?? (async () => ({ data: null, error: null })))
  const updateFn = vi.fn((payload: unknown) => {
    if (opts.update) return opts.update(payload)
    return {
      eq: vi.fn(async () => ({ error: null })),
    }
  })
  const from = vi.fn(() => ({ update: updateFn }))
  return {
    supabase: { rpc, from } as unknown as Parameters<typeof claimJob>[0],
    rpc: rpc as RpcMock,
    from,
    updateFn,
  }
}

describe('claimJob', () => {
  beforeEach(() => vi.clearAllMocks())

  it('calls claim_hipaa_deep_scan RPC with the worker id', async () => {
    const job: ClaimedJob = {
      id: 'job-1',
      url: 'https://example.com',
      requested_by: 'sess-x',
      status: 'running',
      claimed_by: 'worker-a',
      claim_count: 1,
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
    }
    const { supabase, rpc } = makeSupabaseStub({
      rpc: async () => ({ data: job, error: null }),
    })

    const out = await claimJob(supabase, 'worker-a')

    expect(rpc).toHaveBeenCalledOnce()
    expect(rpc).toHaveBeenCalledWith('claim_hipaa_deep_scan', { p_worker_id: 'worker-a' })
    expect(out).toEqual(job)
  })

  it('returns null when queue is empty (null data)', async () => {
    const { supabase } = makeSupabaseStub({
      rpc: async () => ({ data: null, error: null }),
    })
    expect(await claimJob(supabase, 'w')).toBeNull()
  })

  it('returns null when composite-type returns all-null row', async () => {
    const { supabase } = makeSupabaseStub({
      rpc: async () => ({ data: { id: null, url: null }, error: null }),
    })
    expect(await claimJob(supabase, 'w')).toBeNull()
  })

  it('unwraps single-element array response', async () => {
    const job: ClaimedJob = {
      id: 'job-2',
      url: 'https://x.test',
      requested_by: null,
      status: 'running',
      claimed_by: 'w',
      claim_count: 1,
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
    }
    const { supabase } = makeSupabaseStub({
      rpc: async () => ({ data: [job], error: null }),
    })
    expect(await claimJob(supabase, 'w')).toEqual(job)
  })

  it('returns null on RPC error', async () => {
    const { supabase } = makeSupabaseStub({
      rpc: async () => ({ data: null, error: { message: 'boom' } }),
    })
    expect(await claimJob(supabase, 'w')).toBeNull()
  })
})

describe('reapStuck', () => {
  beforeEach(() => vi.clearAllMocks())

  it('calls reap_stuck_hipaa_deep_scans with interval when provided', async () => {
    const { supabase, rpc } = makeSupabaseStub({
      rpc: async () => ({ data: 4, error: null }),
    })
    const n = await reapStuck(supabase, '3 minutes')
    expect(rpc).toHaveBeenCalledWith('reap_stuck_hipaa_deep_scans', { p_timeout: '3 minutes' })
    expect(n).toBe(4)
  })

  it('omits args when interval not provided', async () => {
    const { supabase, rpc } = makeSupabaseStub({
      rpc: async () => ({ data: 0, error: null }),
    })
    await reapStuck(supabase)
    expect(rpc).toHaveBeenCalledWith('reap_stuck_hipaa_deep_scans', {})
  })

  it('returns 0 on error', async () => {
    const { supabase } = makeSupabaseStub({
      rpc: async () => ({ data: null, error: { message: 'x' } }),
    })
    expect(await reapStuck(supabase)).toBe(0)
  })
})

describe('completeJob / failJob / releaseJob', () => {
  beforeEach(() => vi.clearAllMocks())

  it('completeJob sets status=complete with result', async () => {
    let captured: any
    const eq = vi.fn(async () => ({ error: null }))
    const update = vi.fn((p) => {
      captured = p
      return { eq }
    })
    const supabase = { from: vi.fn(() => ({ update })) } as any

    await completeJob(supabase, 'job-1', { ok: true })

    expect(update).toHaveBeenCalled()
    expect(captured.status).toBe('complete')
    expect(captured.result).toEqual({ ok: true })
    expect(captured.error).toBeNull()
    expect(eq).toHaveBeenCalledWith('id', 'job-1')
  })

  it('failJob sets status=failed with truncated error', async () => {
    let captured: any
    const eq = vi.fn(async () => ({ error: null }))
    const update = vi.fn((p) => {
      captured = p
      return { eq }
    })
    const supabase = { from: vi.fn(() => ({ update })) } as any

    await failJob(supabase, 'job-2', 'x'.repeat(3000))
    expect(captured.status).toBe('failed')
    expect(captured.error.length).toBe(2000)
  })

  it('releaseJob flips row back to pending, clears claim', async () => {
    let captured: any
    const eq = vi.fn(async () => ({ error: null }))
    const update = vi.fn((p) => {
      captured = p
      return { eq }
    })
    const supabase = { from: vi.fn(() => ({ update })) } as any

    await releaseJob(supabase, 'job-3', 'transient')
    expect(captured.status).toBe('pending')
    expect(captured.claimed_by).toBeNull()
    expect(captured.started_at).toBeNull()
    expect(captured.error).toBe('transient')
  })
})
