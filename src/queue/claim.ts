/**
 * Queue claim + lifecycle helpers.
 *
 * Wraps the two SQL functions defined in migration 012:
 *   - claim_hipaa_deep_scan(p_worker_id)
 *   - reap_stuck_hipaa_deep_scans(p_timeout)
 *
 * Plus thin update helpers for completion / failure / release that the
 * handler calls when a scan ends.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '../utils/logger.js'

export interface ClaimedJob {
  id: string
  url: string
  requested_by: string | null
  status: string
  claimed_by: string | null
  claim_count: number
  created_at: string
  started_at: string | null
}

/**
 * Atomically claim the oldest pending row. Returns `null` when queue is empty.
 * PostgREST returns a row of NULLs when the SQL function RETURNING clause
 * matched nothing — we detect that and coerce to null for a nicer caller API.
 */
export async function claimJob(
  supabase: SupabaseClient,
  workerId: string
): Promise<ClaimedJob | null> {
  const { data, error } = await supabase.rpc('claim_hipaa_deep_scan', {
    p_worker_id: workerId,
  })
  if (error) {
    logger.error('[queue] claim_hipaa_deep_scan failed:', error.message)
    return null
  }
  if (!data) return null
  // Composite-type RPC can return a single object or an array of one.
  const row = Array.isArray(data) ? data[0] : data
  if (!row || !row.id) return null
  return row as ClaimedJob
}

/**
 * Reap rows stuck in `running` past `timeout`. Returns the number reaped.
 * Caller typically logs at info when non-zero.
 */
export async function reapStuck(
  supabase: SupabaseClient,
  timeout?: string
): Promise<number> {
  const args = timeout ? { p_timeout: timeout } : {}
  const { data, error } = await supabase.rpc('reap_stuck_hipaa_deep_scans', args)
  if (error) {
    logger.error('[queue] reap_stuck_hipaa_deep_scans failed:', error.message)
    return 0
  }
  const count = typeof data === 'number' ? data : Number(data ?? 0)
  return Number.isFinite(count) ? count : 0
}

/** Mark a claimed job as complete, storing the scan result JSON. */
export async function completeJob(
  supabase: SupabaseClient,
  jobId: string,
  result: unknown
): Promise<void> {
  const { error } = await supabase
    .from('hipaa_deep_scans')
    .update({
      status: 'complete',
      result,
      error: null,
      completed_at: new Date().toISOString(),
    })
    .eq('id', jobId)
  if (error) {
    logger.error(`[queue] completeJob ${jobId} failed:`, error.message)
  }
}

/**
 * Mark a job as permanently failed. Used only when the reaper's claim_count
 * ceiling is reached, OR for non-retryable errors at the handler level.
 */
export async function failJob(
  supabase: SupabaseClient,
  jobId: string,
  errorMessage: string
): Promise<void> {
  const { error } = await supabase
    .from('hipaa_deep_scans')
    .update({
      status: 'failed',
      error: errorMessage.slice(0, 2000),
      completed_at: new Date().toISOString(),
    })
    .eq('id', jobId)
  if (error) {
    logger.error(`[queue] failJob ${jobId} failed:`, error.message)
  }
}

/**
 * Release a claimed job back to `pending` so the reaper/next tick retries it.
 * Called on transient errors when claim_count < max so the job keeps its
 * attempt budget for the reaper to exhaust if needed.
 */
export async function releaseJob(
  supabase: SupabaseClient,
  jobId: string,
  errorMessage?: string
): Promise<void> {
  const { error } = await supabase
    .from('hipaa_deep_scans')
    .update({
      status: 'pending',
      claimed_by: null,
      started_at: null,
      error: errorMessage ? errorMessage.slice(0, 2000) : null,
    })
    .eq('id', jobId)
  if (error) {
    logger.error(`[queue] releaseJob ${jobId} failed:`, error.message)
  }
}
