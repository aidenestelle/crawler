import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { emitEvent } from './events.js'

describe('emitEvent', () => {
  let writes: string[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let spy: any

  beforeEach(() => {
    writes = []
    spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk))
      return true
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any)
  })

  afterEach(() => {
    spy.mockRestore()
  })

  it('emits a single JSON line with event name and ts', () => {
    emitEvent('worker_boot', {
      workerId: 'w1',
      provider: 'disabled',
      concurrency: 3,
      version: '1.0.0-beta.1',
    })
    expect(writes).toHaveLength(1)
    const line = writes[0]!
    expect(line.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(line.trim())
    expect(parsed.event).toBe('worker_boot')
    expect(parsed.workerId).toBe('w1')
    expect(parsed.version).toBe('1.0.0-beta.1')
    expect(typeof parsed.ts).toBe('string')
  })

  it('truncates overlong string fields so lines stay bounded', () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(2000)
    emitEvent('scan_started', { jobId: 'j1', url: longUrl, provider: 'gemini', workerId: 'w1' })
    const parsed = JSON.parse(writes[0]!.trim())
    expect(parsed.url.length).toBeLessThan(longUrl.length)
    expect(parsed.url.endsWith('…')).toBe(true)
  })

  it('never throws — swallows stdout errors silently', () => {
    spy.mockImplementation(() => {
      throw new Error('broken pipe')
    })
    expect(() =>
      emitEvent('scan_reaped', { reapedCount: 3 })
    ).not.toThrow()
  })
})
