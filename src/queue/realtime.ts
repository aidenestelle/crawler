/**
 * Realtime wake-up ping.
 *
 * The claim SQL function is the source of truth for which job a worker
 * owns. This Realtime subscription exists solely to shave p50 latency:
 * an INSERT into hipaa_deep_scans fires `onTick()` so the worker can
 * claim the new row immediately rather than waiting for the 30s interval.
 *
 * Errors / disconnects are logged but non-fatal — the interval loop keeps
 * the worker draining the queue even if Realtime is down.
 */
import type { SupabaseClient, RealtimeChannel } from '@supabase/supabase-js'
import { logger } from '../utils/logger.js'

export function subscribeWakeUp(
  supabase: SupabaseClient,
  onTick: () => void
): RealtimeChannel {
  const channel = supabase
    .channel('hipaa-deep-scans-wakeup')
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'hipaa_deep_scans',
        filter: 'status=eq.pending',
      },
      () => {
        try {
          onTick()
        } catch (err) {
          logger.warn('[realtime] onTick threw (non-fatal):', err)
        }
      }
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        logger.info('[realtime] wake-up channel subscribed')
      } else if (status === 'CHANNEL_ERROR') {
        logger.warn('[realtime] wake-up channel error (non-fatal; interval loop continues)')
      } else if (status === 'CLOSED') {
        logger.info('[realtime] wake-up channel closed')
      }
    })

  return channel
}
