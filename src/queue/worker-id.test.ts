import { describe, it, expect } from 'vitest'
import { createWorkerId } from './worker-id.js'

describe('createWorkerId', () => {
  it('matches hostname:pid:hex6 format', () => {
    const id = createWorkerId()
    expect(id).toMatch(/^[^:]+:\d+:[0-9a-f]{6}$/)
  })

  it('applies prefix when provided', () => {
    const id = createWorkerId('prod')
    expect(id.startsWith('prod-')).toBe(true)
    expect(id).toMatch(/^prod-[^:]+:\d+:[0-9a-f]{6}$/)
  })

  it('is unique across calls', () => {
    const a = createWorkerId()
    const b = createWorkerId()
    expect(a).not.toBe(b)
  })
})
