/**
 * Stable worker id generator.
 *
 * Format: `${prefix?}${hostname}:${pid}:${rand6}` — embedded into every
 * `claim_hipaa_deep_scan` RPC call so the DB row records which process
 * owns an in-flight scan.
 */
import { hostname } from 'os'
import { randomBytes } from 'crypto'

function rand6(): string {
  // 3 bytes -> 6 hex chars. Matches the spec's `nanoid(6)` shape without
  // pulling in a new dependency.
  return randomBytes(3).toString('hex')
}

export function createWorkerId(prefix?: string): string {
  const host = hostname() || 'unknown-host'
  const base = `${host}:${process.pid}:${rand6()}`
  return prefix ? `${prefix}-${base}` : base
}
