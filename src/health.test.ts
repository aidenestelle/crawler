import { describe, it, expect } from 'vitest'
import { createHealthServer, type HealthState } from './health.js'

function mkState(overrides: Partial<HealthState> = {}): HealthState {
  return {
    getActiveJobs: () => 0,
    getProvider: () => 'disabled',
    getWorkerId: () => 'worker-test',
    getVersion: () => '1.0.0-beta.1',
    getShuttingDown: () => false,
    ...overrides,
  }
}

describe('createHealthServer', () => {
  it('returns 200 JSON with status/provider/workerId/activeJobs/uptimeMs/version/shuttingDown on GET /healthz', async () => {
    const h = createHealthServer({
      port: 0,
      state: mkState({ getActiveJobs: () => 2, getProvider: () => 'gemini-2.5-flash', getWorkerId: () => 'w-abc' }),
    })
    const port = await h.listening
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`)
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.status).toBe('ok')
      expect(json.provider).toBe('gemini-2.5-flash')
      expect(json.workerId).toBe('w-abc')
      expect(json.activeJobs).toBe(2)
      expect(typeof json.uptimeMs).toBe('number')
      expect(json.uptimeMs).toBeGreaterThanOrEqual(0)
      expect(json.version).toBe('1.0.0-beta.1')
      expect(json.shuttingDown).toBe(false)
    } finally {
      await h.close()
    }
  })

  it('returns 503 with shuttingDown=true when the worker is shutting down', async () => {
    let shutting = false
    const h = createHealthServer({
      port: 0,
      state: mkState({ getShuttingDown: () => shutting }),
    })
    const port = await h.listening
    try {
      shutting = true
      const res = await fetch(`http://127.0.0.1:${port}/healthz`)
      expect(res.status).toBe(503)
      const json = await res.json()
      expect(json.shuttingDown).toBe(true)
      expect(json.status).toBe('shutting_down')
    } finally {
      await h.close()
    }
  })

  it('returns 404 on any other path', async () => {
    const h = createHealthServer({ port: 0, state: mkState() })
    const port = await h.listening
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`)
      expect(res.status).toBe(404)
      const res2 = await fetch(`http://127.0.0.1:${port}/metrics`)
      expect(res2.status).toBe(404)
    } finally {
      await h.close()
    }
  })

  it('reflects live provider + activeJobs via state callbacks', async () => {
    let active = 0
    let provider = 'disabled'
    const h = createHealthServer({
      port: 0,
      state: mkState({ getActiveJobs: () => active, getProvider: () => provider }),
    })
    const port = await h.listening
    try {
      active = 5
      provider = 'ollama'
      const res = await fetch(`http://127.0.0.1:${port}/healthz`)
      const json = await res.json()
      expect(json.activeJobs).toBe(5)
      expect(json.provider).toBe('ollama')
    } finally {
      await h.close()
    }
  })

  it('close() stops accepting connections', async () => {
    const h = createHealthServer({ port: 0, state: mkState() })
    const port = await h.listening
    await h.close()
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow()
  })
})
