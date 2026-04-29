import { describe, it, expect, vi } from 'vitest'
import { runShutdown } from './shutdown.js'

describe('runShutdown', () => {
  it('closes health server BEFORE setting stop-claim flag', async () => {
    const order: string[] = []
    const trace = await runShutdown({
      closeHealth: async () => {
        order.push('closeHealth')
      },
      stopClaimLoop: () => {
        order.push('stopClaimLoop')
      },
      stopReaper: () => {
        order.push('stopReaper')
      },
      drainInflight: async () => {
        order.push('drainInflight')
        return 'done'
      },
      closeRealtime: async () => {
        order.push('closeRealtime')
      },
      graceMs: 1000,
    })
    expect(order[0]).toBe('closeHealth')
    expect(order[1]).toBe('stopClaimLoop')
    expect(order.indexOf('closeHealth')).toBeLessThan(order.indexOf('stopClaimLoop'))
    expect(order.indexOf('stopClaimLoop')).toBeLessThan(order.indexOf('drainInflight'))
    expect(order.indexOf('drainInflight')).toBeLessThan(order.indexOf('closeRealtime'))
    expect(trace.drainOutcome).toBe('done')
    expect(trace.steps).toContain('health_closed')
    expect(trace.steps).toContain('drain_done')
  })

  it('continues past a failing closeHealth and still stops the claim loop', async () => {
    const log = vi.fn()
    const stopClaim = vi.fn()
    const trace = await runShutdown({
      closeHealth: async () => {
        throw new Error('boom')
      },
      stopClaimLoop: stopClaim,
      stopReaper: () => {},
      drainInflight: async () => 'done',
      closeRealtime: async () => {},
      log,
      graceMs: 1000,
    })
    expect(stopClaim).toHaveBeenCalled()
    expect(trace.steps).toContain('health_close_failed')
    expect(log).toHaveBeenCalled()
  })

  it('reports timeout when drain exceeds graceMs', async () => {
    const trace = await runShutdown({
      closeHealth: async () => {},
      stopClaimLoop: () => {},
      stopReaper: () => {},
      drainInflight: async () => 'timeout',
      closeRealtime: async () => {},
      graceMs: 10,
    })
    expect(trace.drainOutcome).toBe('timeout')
    expect(trace.steps).toContain('drain_timeout')
  })
})
