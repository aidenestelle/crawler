/**
 * Small integration-style test for graceful-shutdown behavior.
 *
 * We don't boot the real worker here (that would need a real Supabase) —
 * we recreate the shutdown primitive (a Set of in-flight promises + a
 * time-boxed allSettled) to lock the semantics in place.
 */
import { describe, it, expect } from 'vitest'

async function gracefulWait(
  inflight: Set<Promise<unknown>>,
  graceMs: number
): Promise<'done' | 'timeout'> {
  const waitAll = Promise.allSettled(inflight).then(() => 'done' as const)
  const timeout = new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), graceMs))
  return Promise.race([waitAll, timeout])
}

describe('graceful shutdown wait', () => {
  it('resolves "done" when all in-flight jobs finish before grace', async () => {
    const inflight = new Set<Promise<unknown>>()
    const p1 = new Promise((r) => setTimeout(r, 20))
    const p2 = new Promise((r) => setTimeout(r, 40))
    inflight.add(p1)
    inflight.add(p2)
    const outcome = await gracefulWait(inflight, 500)
    expect(outcome).toBe('done')
  })

  it('resolves "timeout" when jobs exceed the grace cap', async () => {
    const inflight = new Set<Promise<unknown>>()
    // Never-resolving promise simulates a stuck scan.
    inflight.add(new Promise(() => {}))
    const outcome = await gracefulWait(inflight, 30)
    expect(outcome).toBe('timeout')
  })
})
