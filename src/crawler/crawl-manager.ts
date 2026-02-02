/**
 * Crawl Manager
 *
 * Orchestrates the crawling process:
 * - Manages the crawl queue
 * - Coordinates page fetching
 * - Handles progress updates
 * - Aggregates results
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { chromium, Browser, BrowserContext } from 'playwright'
import { PageCrawler } from './page-crawler.js'
import { IssueDetector } from '../analyzers/issue-detector.js'
import { AISearchAnalyzer } from '../analyzers/ai-search-analyzer.js'
import { PageSpeedInsightsAnalyzer } from '../analyzers/pagespeed-insights-analyzer.js'
import { LinkQualityAnalyzer } from '../analyzers/link-quality-analyzer.js'
import { RobotsParser } from '../utils/robots-parser.js'
import { SitemapParser } from '../utils/sitemap-parser.js'
import { logger } from '../utils/logger.js'
import { isSeoRelevant } from '../utils/seo-url-filter.js'
import { createHash } from 'crypto'
import type { PageData } from '../types/page-data.js'

interface ResumeInfo {
  resumed_from_crawl_id: string
  skip_urls: string[]
  original_pages_crawled: number
  original_pages_discovered: number
}

interface CrawlSettings {
  max_pages: number
  crawl_delay_ms: number
  respect_robots_txt: boolean
  follow_subdomains: boolean
  render_javascript: boolean
  user_agent: string
  include_patterns: string[]
  exclude_patterns: string[]
  max_depth: number
  resume_info?: ResumeInfo
}

interface Crawl {
  id: string
  project_id: string
  status: string
  trigger_type: string
  triggered_by: string | null
}

interface Project {
  id: string
  domain: string
  crawl_settings: CrawlSettings
}

interface QueueItem {
  url: string
  depth: number
  parentUrl: string | null
  discoveredVia: 'seed' | 'sitemap' | 'crawl'
}

export class CrawlManager {
  private supabase: SupabaseClient
  private crawl: Crawl
  private project: Project
  private settings: CrawlSettings

  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private pageCrawler: PageCrawler | null = null
  private issueDetector: IssueDetector | null = null
  private robotsParser: RobotsParser | null = null
  private psiAnalyzer: PageSpeedInsightsAnalyzer | null = null

  private cancelled = false
  private queue: QueueItem[] = []
  private visited = new Set<string>()
  private discovered = new Set<string>()

  // Track incoming links for orphan page detection
  private incomingLinks = new Map<string, number>()

  // Counters
  private pagesCrawled = 0
  private pagesFailed = 0
  private pagesDiscovered = 0

  // Effective crawl delay (respects robots.txt)
  private effectiveCrawlDelayMs = 0

  constructor(supabase: SupabaseClient, crawl: Crawl, project: Project) {
    this.supabase = supabase
    this.crawl = crawl
    this.project = project
    this.settings = project.crawl_settings
  }

  /**
   * Cancel the crawl
   */
  cancel(): void {
    logger.crawl(this.crawl.id, 'info', 'Cancelling crawl...')
    this.cancelled = true
  }

  /**
   * Run the crawl
   */
  async run(): Promise<void> {
    const startTime = Date.now()

    try {
      // Check for resume info and initialize skip URLs
      const resumeInfo = this.settings.resume_info
      if (resumeInfo) {
        logger.crawl(
          this.crawl.id,
          'info',
          `Resuming crawl from ${resumeInfo.resumed_from_crawl_id} - skipping ${resumeInfo.skip_urls.length} already-crawled URLs`
        )
        // Add all previously crawled URLs to visited set so they're skipped
        for (const url of resumeInfo.skip_urls) {
          const normalizedUrl = this.normalizeUrl(url)
          if (normalizedUrl) {
            this.visited.add(normalizedUrl)
            this.discovered.add(normalizedUrl)
          }
        }
        // Initialize counters with previous progress
        this.pagesCrawled = 0 // Start fresh counter for this crawl session
        this.pagesDiscovered = resumeInfo.original_pages_discovered
      }

      // Initialize browser
      await this.initBrowser()

      // Initialize robots.txt parser and crawl delay
      if (this.settings.respect_robots_txt) {
        await this.initRobotsParser()
      } else {
        // Use configured delay when not respecting robots.txt
        this.effectiveCrawlDelayMs = this.settings.crawl_delay_ms
      }

      // Initialize issue detector
      this.issueDetector = new IssueDetector(this.supabase, this.crawl.id)
      await this.issueDetector.loadIssueDefinitions()

      // Initialize PageSpeed Insights analyzer (if API key is configured)
      const psiApiKey = process.env.PAGESPEED_API_KEY
      if (psiApiKey) {
        this.psiAnalyzer = new PageSpeedInsightsAnalyzer(this.supabase, psiApiKey)
        logger.crawl(this.crawl.id, 'info', 'PageSpeed Insights analyzer initialized')
      }

      // Start with the domain root (mark as seed URL)
      const startUrl = `https://${this.project.domain}`
      this.addToQueue(startUrl, 0, null, 'seed')

      // Parse sitemaps to discover additional URLs
      await this.parseSitemaps()

      // Process queue
      await this.processQueue()

      // Finalize
      if (!this.cancelled) {
        await this.finalize(startTime)
      }
    } finally {
      await this.cleanup()
    }
  }

  /**
   * Initialize Playwright browser
   */
  private async initBrowser(): Promise<void> {
    logger.crawl(this.crawl.id, 'info', 'Initializing browser...')

    this.browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    })

    this.context = await this.browser.newContext({
      userAgent: this.settings.user_agent,
      viewport: { width: 1920, height: 1080 },
      ignoreHTTPSErrors: true,
    })

    this.pageCrawler = new PageCrawler(this.context, this.settings)
  }

  /**
   * Initialize robots.txt parser
   */
  private async initRobotsParser(): Promise<void> {
    logger.crawl(this.crawl.id, 'info', 'Fetching robots.txt...')

    this.robotsParser = new RobotsParser(this.project.domain, this.settings.user_agent)
    await this.robotsParser.fetch()

    // Respect robots.txt crawl-delay if present (in seconds, convert to ms)
    const robotsCrawlDelay = this.robotsParser.getCrawlDelay()
    if (robotsCrawlDelay !== null && robotsCrawlDelay > 0) {
      const robotsDelayMs = robotsCrawlDelay * 1000
      // Use the larger of robots.txt delay or configured delay
      this.effectiveCrawlDelayMs = Math.max(robotsDelayMs, this.settings.crawl_delay_ms)
      logger.crawl(
        this.crawl.id,
        'info',
        `Respecting robots.txt crawl-delay: ${robotsCrawlDelay}s (effective: ${this.effectiveCrawlDelayMs}ms)`
      )
    } else {
      this.effectiveCrawlDelayMs = this.settings.crawl_delay_ms
    }
  }

  /**
   * Parse sitemaps to discover additional URLs
   * Uses sitemaps from robots.txt, or tries common sitemap locations
   */
  private async parseSitemaps(): Promise<void> {
    logger.crawl(this.crawl.id, 'info', 'Parsing sitemaps for URL discovery...')

    try {
      // Get sitemap URLs from robots.txt (if available)
      const sitemapUrls = this.robotsParser?.getSitemaps() || []

      const sitemapParser = new SitemapParser(
        this.project.domain,
        this.settings.user_agent,
        { maxUrls: this.settings.max_pages }
      )

      const result = await sitemapParser.parse(sitemapUrls)

      // Add discovered URLs to the queue (depth 1 since they're linked from sitemap)
      // Mark as 'sitemap' discovery source to distinguish from true orphans
      let addedCount = 0
      for (const sitemapUrl of result.urls) {
        if (this.addToQueue(sitemapUrl.loc, 1, null, 'sitemap')) {
          addedCount++
        }
      }

      if (addedCount > 0) {
        logger.crawl(
          this.crawl.id,
          'info',
          `Sitemap parsing complete. Added ${addedCount} URLs from ${result.sitemapIndexUrls.length > 0 ? result.sitemapIndexUrls.length + ' sitemaps' : 'sitemap'}`
        )
      } else if (result.errors.length > 0) {
        logger.crawl(
          this.crawl.id,
          'debug',
          `No URLs added from sitemaps. Errors: ${result.errors.join(', ')}`
        )
      } else {
        logger.crawl(this.crawl.id, 'debug', 'No sitemap found or no new URLs discovered')
      }
    } catch (error) {
      logger.crawl(this.crawl.id, 'warn', 'Failed to parse sitemaps:', error)
    }
  }

  /**
   * Add URL to crawl queue
   * @param discoveredVia - How the URL was discovered: 'seed' (initial URL), 'sitemap' (from XML sitemap), 'crawl' (found on page)
   */
  private addToQueue(
    url: string,
    depth: number,
    parentUrl: string | null,
    discoveredVia: 'seed' | 'sitemap' | 'crawl' = 'crawl'
  ): boolean {
    // Normalize URL
    const normalizedUrl = this.normalizeUrl(url)
    if (!normalizedUrl) return false

    // Check if already visited or queued
    if (this.visited.has(normalizedUrl) || this.discovered.has(normalizedUrl)) {
      return false
    }

    // Check depth limit
    if (depth > this.settings.max_depth) {
      return false
    }

    // Check max pages
    if (this.discovered.size >= this.settings.max_pages) {
      return false
    }

    // Check robots.txt
    if (this.robotsParser && !this.robotsParser.isAllowed(normalizedUrl)) {
      logger.crawl(this.crawl.id, 'debug', `Blocked by robots.txt: ${normalizedUrl}`)
      return false
    }

    // Check include/exclude patterns
    if (!this.matchesPatterns(normalizedUrl)) {
      return false
    }

    // Check domain
    if (!this.isAllowedDomain(normalizedUrl)) {
      return false
    }

    // Check if URL is SEO-relevant (skip non-SEO URLs like images, PDFs, tracking params, etc.)
    if (!this.isSeoRelevantUrl(normalizedUrl)) {
      logger.crawl(this.crawl.id, 'debug', `Skipping non-SEO URL: ${normalizedUrl}`)
      return false
    }

    // Add to queue
    this.queue.push({ url: normalizedUrl, depth, parentUrl, discoveredVia })
    this.discovered.add(normalizedUrl)
    this.pagesDiscovered++

    return true
  }

  /**
   * Normalize URL for deduplication
   */
  private normalizeUrl(url: string): string | null {
    try {
      const parsed = new URL(url)

      // Remove hash
      parsed.hash = ''

      // Sort query parameters
      const params = new URLSearchParams(parsed.search)
      const sortedParams = new URLSearchParams([...params.entries()].sort())
      parsed.search = sortedParams.toString()

      // Remove trailing slash (except for root)
      let normalized = parsed.toString()
      if (normalized.endsWith('/') && parsed.pathname !== '/') {
        normalized = normalized.slice(0, -1)
      }

      return normalized
    } catch {
      return null
    }
  }

  /**
   * Check if URL matches include/exclude patterns
   */
  private matchesPatterns(url: string): boolean {
    const { include_patterns, exclude_patterns } = this.settings

    // If include patterns exist, URL must match at least one
    if (include_patterns.length > 0) {
      const matches = include_patterns.some((pattern) => url.includes(pattern))
      if (!matches) return false
    }

    // URL must not match any exclude pattern
    if (exclude_patterns.length > 0) {
      const excluded = exclude_patterns.some((pattern) => url.includes(pattern))
      if (excluded) return false
    }

    return true
  }

  /**
   * Check if URL domain is allowed
   */
  private isAllowedDomain(url: string): boolean {
    try {
      const parsed = new URL(url)
      const targetDomain = parsed.hostname.replace(/^www\./, '')
      const baseDomain = this.project.domain.replace(/^www\./, '')

      if (this.settings.follow_subdomains) {
        return targetDomain === baseDomain || targetDomain.endsWith(`.${baseDomain}`)
      }

      return targetDomain === baseDomain
    } catch {
      return false
    }
  }

  /**
   * Check if URL is SEO-relevant (affects SEO)
   * Delegates to the seo-url-filter utility
   */
  private isSeoRelevantUrl(url: string): boolean {
    return isSeoRelevant(url)
  }

  /**
   * Process the crawl queue
   */
  private async processQueue(): Promise<void> {
    logger.crawl(this.crawl.id, 'info', 'Starting queue processing...')

    while (this.queue.length > 0 && !this.cancelled) {
      const item = this.queue.shift()
      if (!item) continue

      // Check if already visited (could happen with concurrent adds)
      if (this.visited.has(item.url)) continue

      this.visited.add(item.url)

      try {
        // Crawl the page
        const pageData = await this.pageCrawler!.crawl(item.url)

        // Store page data with discovery source
        const pageId = await this.storePage(pageData, item.depth, item.discoveredVia)

        // Extract and queue links (mark as discovered via 'crawl')
        if (pageData.links) {
          for (const link of pageData.links.internal) {
            this.addToQueue(link, item.depth + 1, item.url, 'crawl')
            // Track incoming link for orphan page detection
            this.trackIncomingLink(link)
          }
        }

        // Detect issues (pass pageId for linking)
        if (this.issueDetector && pageId) {
          await this.issueDetector.analyze({ ...pageData, pageId })
        }

        this.pagesCrawled++
      } catch (error) {
        logger.crawl(this.crawl.id, 'error', `Failed to crawl ${item.url}:`, error)
        this.pagesFailed++
      }

      // Update progress
      await this.updateProgress()

      // Crawl delay (respects robots.txt crawl-delay)
      if (this.effectiveCrawlDelayMs > 0) {
        await this.sleep(this.effectiveCrawlDelayMs)
      }
    }

    logger.crawl(
      this.crawl.id,
      'info',
      `Queue processing complete. Crawled: ${this.pagesCrawled}, Failed: ${this.pagesFailed}`
    )
  }

  /**
   * Store crawled page data
   * Uses upsert to handle duplicate URLs gracefully
   * @param discoveredVia - How URL was discovered: 'seed', 'sitemap', or 'crawl'
   */
  private async storePage(
    pageData: PageData,
    depth: number,
    discoveredVia: 'seed' | 'sitemap' | 'crawl' = 'crawl'
  ): Promise<string | null> {
    const urlHash = createHash('sha256').update(pageData.url).digest('hex')

    const { data, error } = await this.supabase
      .from('crawled_pages')
      .upsert({
        crawl_id: this.crawl.id,
        url: pageData.url,
        url_hash: urlHash,
        path: new URL(pageData.url).pathname,
        query_string: new URL(pageData.url).search || null,
        status_code: pageData.statusCode,
        redirect_url: pageData.redirectUrl,
        redirect_chain: pageData.redirectChain || [],
        content_type: pageData.contentType,
        response_time_ms: pageData.responseTime,
        page_size_bytes: pageData.pageSize,
        word_count: pageData.wordCount,
        page_depth: depth,
        crawl_depth: depth,
        title: pageData.title,
        title_length: pageData.title?.length || null,
        meta_description: pageData.metaDescription,
        meta_description_length: pageData.metaDescription?.length || null,
        canonical_url: pageData.canonicalUrl,
        is_self_canonical: pageData.isSelfCanonical,
        h1_tags: pageData.h1Tags || [],
        h2_tags: pageData.h2Tags || [],
        h1_count: pageData.h1Tags?.length || 0,
        h2_count: pageData.h2Tags?.length || 0,
        robots_meta: pageData.robotsMeta,
        is_indexable: pageData.isIndexable,
        indexability_reason: pageData.indexabilityReason,
        internal_links_count: pageData.links?.internal.length || 0,
        external_links_count: pageData.links?.external.length || 0,
        images_count: pageData.imageStats?.total || 0,
        images_without_alt: pageData.imageStats?.withoutAlt || 0,
        images_with_empty_alt: pageData.imageStats?.withEmptyAlt || 0,
        lcp_ms: pageData.cwv?.lcp,
        fid_ms: pageData.cwv?.inp,
        cls_score: pageData.cwv?.cls,
        fcp_ms: pageData.cwv?.fcp,
        ttfb_ms: pageData.cwv?.ttfb,
        is_mobile_friendly: pageData.isMobileFriendly,
        viewport_configured: pageData.hasViewport,
        schema_types: pageData.schemaTypes || [],
        has_schema: (pageData.schemaTypes?.length || 0) > 0,
        og_title: pageData.ogTags?.title,
        og_description: pageData.ogTags?.description,
        og_image: pageData.ogTags?.image,
        twitter_card: pageData.twitterCardType,
        is_https: pageData.url.startsWith('https://'),
        has_mixed_content: pageData.hasMixedContent,
        html_lang: pageData.htmlLang,
        hreflang_tags: pageData.hreflangTags,
        content_hash: pageData.contentHash,
        body_text: pageData.bodyText,
        discovered_via: discoveredVia,
      }, {
        onConflict: 'crawl_id,url_hash',
        ignoreDuplicates: false, // Update existing record with new data
      })
      .select('id')
      .single()

    if (error) {
      logger.crawl(this.crawl.id, 'error', `Failed to store page ${pageData.url}:`, error)
      return null
    }

    const pageId = data?.id || null

    // Store Core Web Vitals data to page_core_web_vitals table if available
    if (pageId && pageData.cwv) {
      await this.storeCoreWebVitals(pageId, pageData.cwv)
    }

    return pageId
  }

  /**
   * Store Core Web Vitals data to page_core_web_vitals table
   */
  private async storeCoreWebVitals(
    pageId: string,
    cwv: { lcp?: number; fcp?: number; ttfb?: number; cls?: number; inp?: number }
  ): Promise<void> {
    // Calculate status for each metric
    const lcpStatus = cwv.lcp
      ? cwv.lcp <= 2500 ? 'good' : cwv.lcp <= 4000 ? 'needs_improvement' : 'poor'
      : null
    const clsStatus = cwv.cls !== undefined
      ? cwv.cls <= 0.1 ? 'good' : cwv.cls <= 0.25 ? 'needs_improvement' : 'poor'
      : null
    const inpStatus = cwv.inp
      ? cwv.inp <= 200 ? 'good' : cwv.inp <= 500 ? 'needs_improvement' : 'poor'
      : null

    // Determine if passes CWV (all available metrics must be "good")
    const failingMetrics: string[] = []
    if (lcpStatus === 'needs_improvement' || lcpStatus === 'poor') failingMetrics.push('LCP')
    if (clsStatus === 'needs_improvement' || clsStatus === 'poor') failingMetrics.push('CLS')
    if (inpStatus === 'needs_improvement' || inpStatus === 'poor') failingMetrics.push('INP')

    const passesCwv = failingMetrics.length === 0 && (cwv.lcp !== undefined || cwv.cls !== undefined)

    const { error } = await this.supabase
      .from('page_core_web_vitals')
      .upsert({
        crawl_id: this.crawl.id,
        page_id: pageId,
        lcp_ms: cwv.lcp || null,
        lcp_status: lcpStatus,
        inp_ms: cwv.inp || null,
        inp_status: inpStatus,
        cls_score: cwv.cls !== undefined ? cwv.cls : null,
        cls_status: clsStatus,
        fcp_ms: cwv.fcp || null,
        ttfb_ms: cwv.ttfb || null,
        passes_cwv: passesCwv,
        failing_metrics: failingMetrics,
      }, {
        onConflict: 'page_id',
        ignoreDuplicates: false,
      })

    if (error) {
      logger.crawl(this.crawl.id, 'warn', `Failed to store CWV data for page ${pageId}:`, error)
    }
  }

  /**
   * Update crawl progress
   */
  private async updateProgress(): Promise<void> {
    const progress = Math.min(
      100,
      Math.round((this.pagesCrawled / Math.max(1, this.pagesDiscovered)) * 100)
    )

    await this.supabase
      .from('crawls')
      .update({
        pages_discovered: this.pagesDiscovered,
        pages_crawled: this.pagesCrawled,
        pages_failed: this.pagesFailed,
        progress_percentage: progress,
        current_url: this.visited.size > 0 ? [...this.visited].pop() : null,
      })
      .eq('id', this.crawl.id)
  }

  /**
   * Finalize crawl results
   */
  private async finalize(startTime: number): Promise<void> {
    logger.crawl(this.crawl.id, 'info', 'Finalizing crawl results...')

    const durationSeconds = Math.round((Date.now() - startTime) / 1000)

    // Get issue counts
    const issueCounts = await this.issueDetector?.getIssueCounts()

    // Calculate health score
    const healthScore = this.calculateHealthScore(
      issueCounts?.errors || 0,
      issueCounts?.warnings || 0,
      issueCounts?.notices || 0
    )

    // Update crawl record
    await this.supabase
      .from('crawls')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        duration_seconds: durationSeconds,
        pages_discovered: this.pagesDiscovered,
        pages_crawled: this.pagesCrawled,
        pages_failed: this.pagesFailed,
        progress_percentage: 100,
        current_url: null,
        health_score: healthScore,
        total_issues: (issueCounts?.errors || 0) + (issueCounts?.warnings || 0) + (issueCounts?.notices || 0),
        errors_count: issueCounts?.errors || 0,
        warnings_count: issueCounts?.warnings || 0,
        notices_count: issueCounts?.notices || 0,
        passed_count: this.pagesCrawled - (issueCounts?.pagesWithIssues || 0),
        category_scores: issueCounts?.categoryScores || {},
      })
      .eq('id', this.crawl.id)

    // Aggregate Core Web Vitals data
    await this.aggregateCoreWebVitals()

    // Analyze AI Search Health
    await this.analyzeAISearchHealth()

    // Analyze PageSpeed Insights (homepage only)
    await this.analyzePageSpeedInsights()

    // Analyze link quality (orphan pages, deep pages, etc.)
    await this.analyzeLinkQuality()

    logger.crawl(
      this.crawl.id,
      'info',
      `Crawl completed. Score: ${healthScore}, Duration: ${durationSeconds}s`
    )
  }

  /**
   * Analyze AI Search Health for the project
   */
  private async analyzeAISearchHealth(): Promise<void> {
    logger.crawl(this.crawl.id, 'info', 'Analyzing AI Search Health...')

    try {
      const analyzer = new AISearchAnalyzer(
        this.supabase,
        this.crawl.id,
        this.project.id,
        this.project.domain,
        this.robotsParser
      )

      const result = await analyzer.analyze()
      logger.crawl(
        this.crawl.id,
        'info',
        `AI Search Health analysis complete. Score: ${result.ai_health_score}`
      )
    } catch (error) {
      logger.crawl(this.crawl.id, 'warn', 'Failed to analyze AI Search Health:', error)
    }
  }

  /**
   * Analyze PageSpeed Insights for the homepage
   */
  private async analyzePageSpeedInsights(): Promise<void> {
    if (!this.psiAnalyzer) {
      logger.crawl(this.crawl.id, 'debug', 'PageSpeed Insights analyzer not configured, skipping')
      return
    }

    logger.crawl(this.crawl.id, 'info', 'Analyzing PageSpeed Insights...')

    try {
      const homepageUrl = `https://${this.project.domain}`
      await this.psiAnalyzer.analyzeHomepage(homepageUrl, this.crawl.id, this.project.id)
      logger.crawl(this.crawl.id, 'info', 'PageSpeed Insights analysis complete')
    } catch (error) {
      logger.crawl(this.crawl.id, 'warn', 'Failed to analyze PageSpeed Insights:', error)
    }
  }

  /**
   * Track incoming link to a URL (for orphan page detection)
   */
  private trackIncomingLink(url: string): void {
    try {
      const normalizedUrl = this.normalizeUrl(url)
      if (normalizedUrl === null) return
      const currentCount = this.incomingLinks.get(normalizedUrl) || 0
      this.incomingLinks.set(normalizedUrl, currentCount + 1)
    } catch {
      // Ignore invalid URLs
    }
  }

  /**
   * Update incoming link counts in database
   */
  private async updateIncomingLinkCounts(): Promise<void> {
    logger.crawl(this.crawl.id, 'info', `Updating incoming link counts for ${this.incomingLinks.size} URLs...`)

    // Batch update for efficiency
    const batchSize = 50
    const entries = Array.from(this.incomingLinks.entries())

    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = entries.slice(i, i + batchSize)

      for (const [url, count] of batch) {
        const urlHash = createHash('sha256').update(url).digest('hex')

        await this.supabase
          .from('crawled_pages')
          .update({ internal_links_received: count })
          .eq('crawl_id', this.crawl.id)
          .eq('url_hash', urlHash)
      }
    }

    logger.crawl(this.crawl.id, 'info', 'Incoming link counts updated')
  }

  /**
   * Analyze link quality (orphan pages, deep pages, etc.)
   */
  private async analyzeLinkQuality(): Promise<void> {
    logger.crawl(this.crawl.id, 'info', 'Analyzing link quality...')

    try {
      // First, update incoming link counts
      await this.updateIncomingLinkCounts()

      const analyzer = new LinkQualityAnalyzer(this.supabase, this.crawl.id)
      await analyzer.analyze()
      await analyzer.analyzeOrphanPages()
      logger.crawl(this.crawl.id, 'info', 'Link quality analysis complete')
    } catch (error) {
      logger.crawl(this.crawl.id, 'warn', 'Failed to analyze link quality:', error)
    }
  }

  /**
   * Aggregate Core Web Vitals data for the project
   */
  private async aggregateCoreWebVitals(): Promise<void> {
    logger.crawl(this.crawl.id, 'info', 'Aggregating Core Web Vitals data...')

    const { error } = await this.supabase.rpc('aggregate_core_web_vitals', {
      p_project_id: this.project.id,
      p_crawl_id: this.crawl.id,
    })

    if (error) {
      logger.crawl(this.crawl.id, 'warn', 'Failed to aggregate CWV data:', error)
    } else {
      logger.crawl(this.crawl.id, 'info', 'Core Web Vitals aggregation complete')
    }
  }

  /**
   * Calculate health score from issue counts
   */
  private calculateHealthScore(errors: number, warnings: number, notices: number): number {
    const score = 100 - (errors * 5 + warnings * 2 + Math.floor(notices * 0.5))
    return Math.max(0, Math.min(100, score))
  }

  /**
   * Cleanup resources
   */
  private async cleanup(): Promise<void> {
    logger.crawl(this.crawl.id, 'info', 'Cleaning up resources...')

    if (this.context) {
      await this.context.close()
    }

    if (this.browser) {
      await this.browser.close()
    }
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
