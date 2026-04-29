/**
 * /healthz HTTP server.
 *
 * Minimal http.createServer — NO other routes. GET /healthz returns 200 with
 * a small JSON body; everything else is 404. Kept intentionally tiny so the
 * worker never drags in express/koa/etc.
 *
 * Epic 5 enrichment: body now includes workerId, version, and shuttingDown.
 * Owned by src/index.ts. Close via `server.close()` in shutdown.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface HealthState {
  /** Active in-flight job count. */
  getActiveJobs(): number
  /** Active AI provider name (e.g. 'gemini-2.5-flash' | 'disabled'). */
  getProvider(): string
  /** Worker id (stable for the lifetime of the process). */
  getWorkerId(): string
  /** Semver version of the worker (from package.json). */
  getVersion(): string
  /** True once SIGTERM/SIGINT shutdown has begun. */
  getShuttingDown(): boolean
}

export interface HealthServerOptions {
  port?: number
  state: HealthState
  /** Process start time in ms-since-epoch (default: Date.now() at start). */
  startedAtMs?: number
}

export interface HealthServer {
  server: Server
  /** Resolves to the bound port (useful when port=0 in tests). */
  listening: Promise<number>
  close(): Promise<void>
}

export function createHealthServer(opts: HealthServerOptions): HealthServer {
  const startedAtMs = opts.startedAtMs ?? Date.now()
  const port = opts.port ?? 8080

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      const shuttingDown = opts.state.getShuttingDown()
      const body = JSON.stringify({
        status: shuttingDown ? 'shutting_down' : 'ok',
        provider: opts.state.getProvider(),
        workerId: opts.state.getWorkerId(),
        activeJobs: opts.state.getActiveJobs(),
        uptimeMs: Date.now() - startedAtMs,
        version: opts.state.getVersion(),
        shuttingDown,
      })
      // Return 503 during shutdown so Fly's probe stops sending traffic.
      res.writeHead(shuttingDown ? 503 : 200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      })
      res.end(body)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })

  const listening = new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, () => {
      const addr = server.address() as AddressInfo | null
      resolve(addr?.port ?? port)
    })
  })

  return {
    server,
    listening,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}
