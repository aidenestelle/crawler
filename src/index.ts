/**
 * SemDash Crawler Worker
 *
 * Self-hosted Node.js service that:
 * 1. Listens for pending crawls via Supabase Realtime
 * 2. Crawls websites using Playwright for JS rendering
 * 3. Extracts SEO data using Cheerio
 * 4. Writes results back to Supabase
 */

import 'dotenv/config'
import { createClient, RealtimeChannel } from '@supabase/supabase-js'
import { CrawlManager } from './crawler/crawl-manager.js'
import { logger } from './utils/logger.js'

// Validate environment
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  logger.error('Missing required environment variables: SUPABASE_URL and SUPABASE_SERVICE_KEY')
  process.exit(1)
}

// Create Supabase client with service role key
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
})

// Track active crawl
let activeCrawlId: string | null = null
let crawlManager: CrawlManager | null = null
let realtimeChannel: RealtimeChannel | null = null

/**
 * Process a pending crawl job
 */
async function processCrawl(crawlId: string): Promise<void> {
  if (activeCrawlId) {
    logger.warn(`Already processing crawl ${activeCrawlId}, skipping ${crawlId}`)
    return
  }

  activeCrawlId = crawlId
  logger.info(`Starting crawl: ${crawlId}`)

  try {
    // Get crawl details with project info
    const { data: crawl, error: crawlError } = await supabase
      .from('crawls')
      .select(`
        *,
        projects (
          id,
          domain,
          crawl_settings
        )
      `)
      .eq('id', crawlId)
      .single()

    if (crawlError || !crawl) {
      throw new Error(`Failed to fetch crawl: ${crawlError?.message || 'Not found'}`)
    }

    if (crawl.status !== 'pending') {
      logger.info(`Crawl ${crawlId} is not pending (status: ${crawl.status}), skipping`)
      return
    }

    // Merge settings: use settings_snapshot if present (for resumed crawls), otherwise use project settings
    const existingSnapshot = crawl.settings_snapshot as Record<string, unknown> | null
    const projectSettings = crawl.projects.crawl_settings as Record<string, unknown>
    const mergedSettings = {
      ...projectSettings,
      ...(existingSnapshot || {}),
      // Preserve resume_info if it exists in the crawl's settings_snapshot
      resume_info: existingSnapshot?.resume_info || undefined,
    }

    // Update status to processing
    await supabase
      .from('crawls')
      .update({
        status: 'processing',
        started_at: new Date().toISOString(),
        settings_snapshot: mergedSettings,
      })
      .eq('id', crawlId)

    // Create project object with merged settings for the crawler
    const projectWithMergedSettings = {
      ...crawl.projects,
      crawl_settings: mergedSettings,
    }

    // Initialize and run crawler
    crawlManager = new CrawlManager(supabase, crawl, projectWithMergedSettings)
    await crawlManager.run()

    logger.info(`Crawl ${crawlId} completed successfully`)
  } catch (error) {
    logger.error(`Crawl ${crawlId} failed:`, error)

    // Update crawl status to failed
    await supabase
      .from('crawls')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_message: error instanceof Error ? error.message : 'Unknown error',
        error_details: { stack: error instanceof Error ? error.stack : undefined },
      })
      .eq('id', crawlId)
  } finally {
    activeCrawlId = null
    crawlManager = null
  }
}

/**
 * Recover orphaned processing crawls that were abandoned due to worker crash
 */
async function recoverOrphanedCrawls(): Promise<void> {
  const STALE_THRESHOLD_MINUTES = 5
  const staleTime = new Date(Date.now() - STALE_THRESHOLD_MINUTES * 60 * 1000).toISOString()

  logger.info('Checking for orphaned processing crawls...')

  const { data: staleCrawls, error } = await supabase
    .from('crawls')
    .select('id, started_at')
    .eq('status', 'processing')
    .lt('started_at', staleTime)

  if (error) {
    logger.error('Failed to check for orphaned crawls:', error)
    return
  }

  if (staleCrawls && staleCrawls.length > 0) {
    for (const crawl of staleCrawls) {
      logger.info(`Recovering orphaned crawl: ${crawl.id} (started: ${crawl.started_at})`)

      const { error: updateError } = await supabase
        .from('crawls')
        .update({
          status: 'pending',
          error_message: 'Worker crashed - automatically requeued',
        })
        .eq('id', crawl.id)

      if (updateError) {
        logger.error(`Failed to recover crawl ${crawl.id}:`, updateError)
      } else {
        logger.info(`Successfully recovered crawl: ${crawl.id}`)
      }
    }
  } else {
    logger.info('No orphaned crawls found')
  }
}

/**
 * Auto-resume failed crawls that have crawled pages
 * Creates new crawls that skip already-crawled URLs
 */
async function autoResumeFailedCrawls(): Promise<void> {
  // Only auto-resume crawls that:
  // 1. Failed within the last hour
  // 2. Have some pages already crawled
  // 3. Haven't been manually retried/resumed already
  const ONE_HOUR_AGO = new Date(Date.now() - 60 * 60 * 1000).toISOString()

  const { data: failedCrawls, error } = await supabase
    .from('crawls')
    .select('id, project_id, pages_crawled, pages_discovered, settings_snapshot, error_message')
    .eq('status', 'failed')
    .gt('completed_at', ONE_HOUR_AGO)
    .gt('pages_crawled', 10) // Only resume if at least 10 pages were crawled
    .order('completed_at', { ascending: false })
    .limit(5)

  if (error) {
    logger.error('Failed to check for auto-resumable crawls:', error)
    return
  }

  if (!failedCrawls || failedCrawls.length === 0) {
    return
  }

  for (const failedCrawl of failedCrawls) {
    // Check if there's already a pending/processing crawl for this project
    const { data: activeCrawl } = await supabase
      .from('crawls')
      .select('id')
      .eq('project_id', failedCrawl.project_id)
      .in('status', ['pending', 'processing'])
      .limit(1)
      .maybeSingle()

    if (activeCrawl) {
      logger.info(`Skipping auto-resume for ${failedCrawl.id} - project already has active crawl`)
      continue
    }

    // Check if this crawl was already auto-resumed (look for a newer crawl with resume_info pointing to this one)
    const existingSettings = failedCrawl.settings_snapshot as Record<string, unknown> | null
    const wasAlreadyResumed = existingSettings?.resume_info !== undefined

    // Don't auto-resume crawls that were themselves resumes (prevent infinite resume chains)
    if (wasAlreadyResumed) {
      logger.info(`Skipping auto-resume for ${failedCrawl.id} - was itself a resumed crawl`)
      continue
    }

    // Get already crawled URLs to skip
    const { data: crawledPages } = await supabase
      .from('crawled_pages')
      .select('url')
      .eq('crawl_id', failedCrawl.id)

    const alreadyCrawledUrls = crawledPages?.map(p => p.url) || []

    logger.info(`Auto-resuming failed crawl ${failedCrawl.id} with ${alreadyCrawledUrls.length} already-crawled URLs`)

    // Create new crawl with resume info
    const resumeInfo = {
      resumed_from_crawl_id: failedCrawl.id,
      skip_urls: alreadyCrawledUrls,
      original_pages_crawled: failedCrawl.pages_crawled || 0,
      original_pages_discovered: failedCrawl.pages_discovered || 0,
    }

    const { error: createError } = await supabase
      .from('crawls')
      .insert({
        project_id: failedCrawl.project_id,
        status: 'pending',
        trigger_type: 'auto_resume',
        settings_snapshot: {
          ...(existingSettings || {}),
          resume_info: resumeInfo,
        },
      })

    if (createError) {
      logger.error(`Failed to create auto-resume crawl for ${failedCrawl.id}:`, createError)
    } else {
      logger.info(`Created auto-resume crawl for failed crawl ${failedCrawl.id}`)
    }
  }
}

/**
 * Check for pending crawls on startup
 */
async function checkPendingCrawls(): Promise<void> {
  logger.info('Checking for pending crawls...')

  const { data: pendingCrawls, error } = await supabase
    .from('crawls')
    .select('id')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)

  if (error) {
    logger.error('Failed to check pending crawls:', error)
    return
  }

  if (pendingCrawls && pendingCrawls.length > 0) {
    const crawl = pendingCrawls[0]
    if (crawl) {
      logger.info(`Found pending crawl: ${crawl.id}`)
      await processCrawl(crawl.id)
    }
  } else {
    logger.info('No pending crawls found')
  }
}

/**
 * Subscribe to crawl changes via Realtime
 */
function subscribeToChanges(): void {
  logger.info('Subscribing to crawl changes...')

  realtimeChannel = supabase
    .channel('crawls-channel')
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'crawls',
        filter: 'status=eq.pending',
      },
      (payload) => {
        const crawlId = payload.new.id as string
        logger.info(`New pending crawl detected: ${crawlId}`)
        processCrawl(crawlId)
      }
    )
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'crawls',
      },
      (payload) => {
        // Handle user stopping the crawl (either cancel/discard or save/process)
        const newStatus = payload.new.status
        const oldStatus = payload.old?.status
        const isActiveCrawl = payload.new.id === activeCrawlId

        if (isActiveCrawl && oldStatus === 'processing') {
          if (newStatus === 'cancelled') {
            logger.info(`Crawl ${activeCrawlId} was cancelled by user`)
            crawlManager?.cancel()
          } else if (newStatus === 'completed') {
            logger.info(`Crawl ${activeCrawlId} was stopped early and saved by user`)
            crawlManager?.cancel()
          }
        }
      }
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        logger.info('Successfully subscribed to Realtime changes')
      } else if (status === 'CHANNEL_ERROR') {
        logger.error('Failed to subscribe to Realtime changes')
      }
    })
}

/**
 * Graceful shutdown handler
 */
async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, shutting down gracefully...`)

  // Cancel active crawl
  if (crawlManager) {
    crawlManager.cancel()
  }

  // Unsubscribe from Realtime
  if (realtimeChannel) {
    await supabase.removeChannel(realtimeChannel)
  }

  // Mark any processing crawls as failed (they can be retried)
  if (activeCrawlId) {
    await supabase
      .from('crawls')
      .update({
        status: 'failed',
        error_message: 'Worker shutdown during crawl',
      })
      .eq('id', activeCrawlId)
  }

  logger.info('Shutdown complete')
  process.exit(0)
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  logger.info('SemDash Crawler Worker starting...')
  logger.info(`Supabase URL: ${SUPABASE_URL}`)

  // Register shutdown handlers
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  // Subscribe to Realtime changes
  subscribeToChanges()

  // Recover any orphaned processing crawls from previous worker crashes
  await recoverOrphanedCrawls()

  // Check for auto-resumable failed crawls
  await autoResumeFailedCrawls()

  // Check for any pending crawls (including just-recovered and auto-resumed ones)
  await checkPendingCrawls()

  // Poll for pending crawls every 30 seconds as fallback
  // (in case Realtime events are missed due to network issues)
  setInterval(async () => {
    if (!activeCrawlId) {
      await checkPendingCrawls()
    }
  }, 30000)

  // Check for auto-resumable failed crawls every 5 minutes
  setInterval(async () => {
    if (!activeCrawlId) {
      await autoResumeFailedCrawls()
    }
  }, 5 * 60 * 1000)

  logger.info('Crawler worker ready and listening for jobs')
}

// Start the worker
main().catch((error) => {
  logger.error('Fatal error:', error)
  process.exit(1)
})
