/**
 * Link Quality Analyzer
 *
 * Performs post-crawl analysis to detect link quality issues:
 * - Orphan pages (no internal links pointing to them)
 * - Deep pages (too many clicks from homepage)
 * - Dead end pages (no outbound internal links)
 * - Pages with excessive outbound links
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '../utils/logger.js'

interface IssueDefinition {
  id: string
  code: string
  name: string
  category: string
  severity: 'error' | 'warning' | 'notice'
}

interface PageLinkData {
  id: string
  url: string
  page_depth: number
  internal_links_count: number
  status_code: number
}

export class LinkQualityAnalyzer {
  private supabase: SupabaseClient
  private crawlId: string
  private issueDefinitions: Map<string, IssueDefinition> = new Map()

  constructor(supabase: SupabaseClient, crawlId: string) {
    this.supabase = supabase
    this.crawlId = crawlId
  }

  /**
   * Load relevant issue definitions
   */
  async loadIssueDefinitions(): Promise<void> {
    const codes = [
      'page_too_deep',
      'page_very_deep',
      'orphan_page',
      'sitemap_only_page', // Pages only discoverable via sitemap (not true orphans)
      'low_internal_links',
      'high_outbound_links',
      'dead_end_page',
      'links_to_broken',
    ]

    const { data, error } = await this.supabase
      .from('issue_definitions')
      .select('id, code, name, category, severity')
      .in('code', codes)
      .eq('is_active', true)

    if (error) {
      logger.error('Failed to load link quality issue definitions', error)
      return
    }

    for (const def of data || []) {
      this.issueDefinitions.set(def.code, def)
    }

    logger.info(`Loaded ${this.issueDefinitions.size} link quality issue definitions`)
  }

  /**
   * Run post-crawl link quality analysis
   */
  async analyze(): Promise<void> {
    logger.crawl(this.crawlId, 'info', 'Running link quality analysis...')

    await this.loadIssueDefinitions()

    // Fetch all crawled pages with their link data
    const { data: pages, error } = await this.supabase
      .from('crawled_pages')
      .select('id, url, page_depth, internal_links_count, status_code')
      .eq('crawl_id', this.crawlId)

    if (error) {
      logger.error('Failed to fetch pages for link analysis', error)
      return
    }

    if (!pages || pages.length === 0) {
      logger.crawl(this.crawlId, 'info', 'No pages to analyze for link quality')
      return
    }

    // Build internal link map from page_issues or analyze links
    // For now, we'll analyze based on depth and outbound links
    const pageMap = new Map<string, PageLinkData>()
    for (const page of pages) {
      pageMap.set(page.url, page)
    }

    // Analyze each page
    for (const page of pages) {
      await this.analyzePage(page, pageMap)
    }

    logger.crawl(this.crawlId, 'info', `Link quality analysis complete for ${pages.length} pages`)
  }

  /**
   * Analyze a single page for link quality issues
   */
  private async analyzePage(page: PageLinkData, _pageMap: Map<string, PageLinkData>): Promise<void> {
    // Skip error pages
    if (page.status_code >= 400) return

    const issues: Array<{ code: string; details: Record<string, unknown> }> = []

    // Check for deep pages (depth > 4)
    if (page.page_depth > 4 && page.page_depth <= 7) {
      issues.push({
        code: 'page_too_deep',
        details: {
          depth: page.page_depth,
          threshold: 4,
          url: page.url,
        },
      })
    }

    // Check for very deep pages (depth > 7)
    if (page.page_depth > 7) {
      issues.push({
        code: 'page_very_deep',
        details: {
          depth: page.page_depth,
          threshold: 7,
          url: page.url,
        },
      })
    }

    // Check for dead end pages (no outbound internal links)
    if (page.internal_links_count === 0) {
      issues.push({
        code: 'dead_end_page',
        details: {
          outboundLinks: 0,
          url: page.url,
        },
      })
    }

    // Check for excessive outbound links (> 150)
    if (page.internal_links_count > 150) {
      issues.push({
        code: 'high_outbound_links',
        details: {
          outboundLinks: page.internal_links_count,
          threshold: 150,
          url: page.url,
        },
      })
    }

    // Store detected issues
    for (const issue of issues) {
      await this.storeIssue(page.id, issue.code, issue.details)
    }
  }

  /**
   * Store a detected issue
   */
  private async storeIssue(
    pageId: string,
    code: string,
    details: Record<string, unknown>
  ): Promise<void> {
    const def = this.issueDefinitions.get(code)
    if (!def) {
      logger.warn(`Issue definition not found: ${code}`)
      return
    }

    try {
      // Get or create issue record
      let issueId: string | null = null

      const { data: existingIssue } = await this.supabase
        .from('issues')
        .select('id')
        .eq('crawl_id', this.crawlId)
        .eq('issue_definition_id', def.id)
        .single()

      if (existingIssue) {
        issueId = existingIssue.id
        await this.supabase.rpc('increment_issue_count', {
          p_crawl_id: this.crawlId,
          p_issue_definition_id: def.id,
        })
      } else {
        const { data: newIssue, error: insertError } = await this.supabase
          .from('issues')
          .insert({
            crawl_id: this.crawlId,
            issue_definition_id: def.id,
            issue_code: def.code,
            issue_name: def.name,
            category: def.category,
            severity: def.severity,
            affected_pages_count: 1,
          })
          .select('id')
          .single()

        if (insertError) {
          logger.error(`Failed to insert issue ${code}:`, insertError)
          return
        }

        issueId = newIssue?.id || null
      }

      if (!issueId) return

      // Link page to issue
      const { error: linkError } = await this.supabase.from('page_issues').insert({
        crawl_id: this.crawlId,
        page_id: pageId,
        issue_id: issueId,
        details,
      })

      if (linkError && linkError.code !== '23505') {
        logger.error(`Failed to link page to issue:`, linkError)
      }
    } catch (err) {
      logger.error(`Failed to store issue ${code}`, err)
    }
  }

  /**
   * Analyze orphan pages (pages not linked from any other page)
   *
   * Splits detection into two categories:
   * 1. True orphans (orphan_page): Pages discovered during crawl but have no incoming links
   *    - These are genuinely unreachable from normal site navigation
   * 2. Sitemap-only pages (sitemap_only_page): Pages only discoverable via sitemap
   *    - These exist in the sitemap but aren't linked from other pages
   *    - Less critical than true orphans since search engines can find them
   */
  async analyzeOrphanPages(): Promise<void> {
    // Query for pages with no incoming internal links
    // Include discovered_via to differentiate sitemap-only vs true orphans
    const { data: potentialOrphans, error } = await this.supabase
      .from('crawled_pages')
      .select('id, url, page_depth, internal_links_received, discovered_via')
      .eq('crawl_id', this.crawlId)
      .eq('internal_links_received', 0)
      .neq('page_depth', 0) // Exclude homepage
      .gte('status_code', 200)
      .lt('status_code', 400)

    if (error) {
      logger.error('Failed to query for orphan pages', error)
      return
    }

    if (!potentialOrphans || potentialOrphans.length === 0) return

    // Split into true orphans vs sitemap-only pages
    const trueOrphans: typeof potentialOrphans = []
    const sitemapOnlyPages: typeof potentialOrphans = []

    for (const page of potentialOrphans) {
      if (page.discovered_via === 'sitemap') {
        // Page was discovered via sitemap but has no internal links pointing to it
        sitemapOnlyPages.push(page)
      } else {
        // Page was discovered via crawl but somehow has no incoming links
        // This is a true orphan (or seed URL)
        if (page.discovered_via !== 'seed') {
          trueOrphans.push(page)
        }
      }
    }

    // Create issues for true orphans (more serious)
    const orphanDef = this.issueDefinitions.get('orphan_page')
    if (orphanDef) {
      for (const page of trueOrphans) {
        await this.storeIssue(page.id, 'orphan_page', {
          url: page.url,
          incomingLinks: 0,
          discoveredVia: page.discovered_via,
        })
      }
    }

    // Create issues for sitemap-only pages (notice level)
    const sitemapOnlyDef = this.issueDefinitions.get('sitemap_only_page')
    if (sitemapOnlyDef) {
      for (const page of sitemapOnlyPages) {
        await this.storeIssue(page.id, 'sitemap_only_page', {
          url: page.url,
          incomingLinks: 0,
          discoveredVia: 'sitemap',
        })
      }
    }

    // Log results
    if (trueOrphans.length > 0) {
      logger.crawl(this.crawlId, 'info', `Found ${trueOrphans.length} true orphan pages (no internal links)`)
    }
    if (sitemapOnlyPages.length > 0) {
      logger.crawl(this.crawlId, 'info', `Found ${sitemapOnlyPages.length} sitemap-only pages (discoverable via sitemap only)`)
    }
  }
}
