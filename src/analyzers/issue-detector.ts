/**
 * Issue Detector
 *
 * Analyzes crawled pages against SEO issue definitions
 * and stores detected issues in the database
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { PageData } from '../types/page-data.js'
import { logger } from '../utils/logger.js'

interface IssueDefinition {
  id: string
  code: string
  name: string
  category: string
  severity: 'error' | 'warning' | 'notice'
  description: string
  recommendation: string
}

interface DetectedIssue {
  issue_definition_id: string
  details: Record<string, unknown>
}

export class IssueDetector {
  private supabase: SupabaseClient
  private crawlId: string
  private issueDefinitions: Map<string, IssueDefinition> = new Map()

  constructor(supabase: SupabaseClient, crawlId: string) {
    this.supabase = supabase
    this.crawlId = crawlId
  }

  /**
   * Load issue definitions from database
   */
  async loadIssueDefinitions(): Promise<void> {
    const { data, error } = await this.supabase
      .from('issue_definitions')
      .select('*')
      .eq('is_active', true)

    if (error) {
      logger.error('Failed to load issue definitions', error)
      throw error
    }

    for (const def of data || []) {
      this.issueDefinitions.set(def.code, def)
    }

    logger.info(`Loaded ${this.issueDefinitions.size} issue definitions`)
  }

  /**
   * Analyze a page and detect issues
   */
  async analyze(page: PageData): Promise<void> {
    const issues: DetectedIssue[] = []

    // Run all analyzers
    issues.push(...this.analyzeCrawlability(page))
    issues.push(...this.analyzeIndexability(page))
    issues.push(...this.analyzeContent(page))
    issues.push(...this.analyzePerformance(page))
    issues.push(...this.analyzeSecurity(page))
    issues.push(...this.analyzeImages(page))
    issues.push(...this.analyzeStructuredData(page))
    issues.push(...this.analyzeMobile(page))
    issues.push(...this.analyzeInternational(page))
    issues.push(...this.analyzeSocial(page))
    issues.push(...this.analyzeAccessibility(page))
    issues.push(...this.analyzeAiSearch(page))
    issues.push(...this.analyzeTechnicalSeo(page))
    issues.push(...this.analyzeEcommerce(page))
    issues.push(...this.analyzeArticle(page))

    // Store issues
    await this.storeIssues(page, issues)
  }

  /**
   * Store detected issues in database
   */
  private async storeIssues(page: PageData, issues: DetectedIssue[]): Promise<void> {
    if (issues.length === 0) return

    logger.debug(`Storing ${issues.length} issues for page ${page.url}`)

    // Get or create issue records, then link to page
    for (const issue of issues) {
      try {
        // Get the issue definition to retrieve denormalized fields
        const def = this.getDefinitionById(issue.issue_definition_id)
        if (!def) {
          logger.error(`Issue definition not found for id: ${issue.issue_definition_id}`)
          continue
        }

        // First, try to get existing issue record
        let issueId: string | null = null

        const { data: existingIssue } = await this.supabase
          .from('issues')
          .select('id')
          .eq('crawl_id', this.crawlId)
          .eq('issue_definition_id', issue.issue_definition_id)
          .single()

        if (existingIssue) {
          // Issue exists, increment count
          issueId = existingIssue.id
          await this.supabase.rpc('increment_issue_count', {
            p_crawl_id: this.crawlId,
            p_issue_definition_id: issue.issue_definition_id,
          })
        } else {
          // Create new issue record with denormalized fields
          const { data: newIssue, error: insertError } = await this.supabase
            .from('issues')
            .insert({
              crawl_id: this.crawlId,
              issue_definition_id: issue.issue_definition_id,
              issue_code: def.code,
              issue_name: def.name,
              category: def.category,
              severity: def.severity,
              affected_pages_count: 1,
            })
            .select('id')
            .single()

          if (insertError) {
            logger.error(`Failed to insert issue ${def.code}:`, insertError)
            continue
          }

          issueId = newIssue?.id || null
        }

        if (!issueId) {
          logger.error(`No issue ID for ${issue.issue_definition_id}`)
          continue
        }

        // Link page to issue using the correct issue_id column
        const { error: linkError } = await this.supabase.from('page_issues').insert({
          crawl_id: this.crawlId,
          page_id: page.pageId,
          issue_id: issueId,  // Use issue_id, not issue_definition_id
          details: issue.details,
        })

        if (linkError) {
          // May be duplicate, that's ok
          if (linkError.code !== '23505') {
            logger.error(`Failed to link page to issue:`, linkError)
          }
        }
      } catch (err) {
        logger.error(`Failed to store issue ${issue.issue_definition_id}`, err)
      }
    }
  }

  /**
   * Get issue definition by code
   */
  private getIssue(code: string): IssueDefinition | undefined {
    return this.issueDefinitions.get(code)
  }

  /**
   * Get issue definition by ID
   */
  private getDefinitionById(id: string): IssueDefinition | undefined {
    for (const def of this.issueDefinitions.values()) {
      if (def.id === id) return def
    }
    return undefined
  }

  /**
   * Create detected issue if definition exists
   */
  private createIssue(code: string, details: Record<string, unknown> = {}): DetectedIssue | null {
    const def = this.getIssue(code)
    if (!def) return null
    return {
      issue_definition_id: def.id,
      details,
    }
  }

  // ============================================================================
  // CRAWLABILITY ANALYZERS
  // ============================================================================

  private analyzeCrawlability(page: PageData): DetectedIssue[] {
    const issues: DetectedIssue[] = []

    // 4xx errors
    if (page.statusCode >= 400 && page.statusCode < 500) {
      const issue = this.createIssue('CRAWL_4XX_ERROR', {
        statusCode: page.statusCode,
        url: page.url,
      })
      if (issue) issues.push(issue)
    }

    // 5xx errors
    if (page.statusCode >= 500) {
      const issue = this.createIssue('CRAWL_5XX_ERROR', {
        statusCode: page.statusCode,
        url: page.url,
      })
      if (issue) issues.push(issue)
    }

    // Redirect chains (detected by redirect count > 1)
    if (page.redirectChain && page.redirectChain.length > 1) {
      const issue = this.createIssue('CRAWL_REDIRECT_CHAIN', {
        redirectCount: page.redirectChain.length,
        chain: page.redirectChain,
      })
      if (issue) issues.push(issue)
    }

    // Temporary redirects
    if (page.redirectChain?.some((r) => r.statusCode === 302 || r.statusCode === 307)) {
      const issue = this.createIssue('CRAWL_TEMP_REDIRECT', {
        redirects: page.redirectChain.filter((r) => r.statusCode === 302 || r.statusCode === 307),
      })
      if (issue) issues.push(issue)
    }

    // Slow response time (> 3 seconds)
    if (page.responseTime && page.responseTime > 3000) {
      const issue = this.createIssue('CRAWL_SLOW_RESPONSE', {
        responseTime: page.responseTime,
        threshold: 3000,
      })
      if (issue) issues.push(issue)
    }

    // Broken internal links
    if (page.brokenLinks && page.brokenLinks.length > 0) {
      const issue = this.createIssue('CRAWL_BROKEN_LINK', {
        brokenLinks: page.brokenLinks,
        count: page.brokenLinks.length,
      })
      if (issue) issues.push(issue)
    }

    return issues
  }

  // ============================================================================
  // INDEXABILITY ANALYZERS
  // ============================================================================

  private analyzeIndexability(page: PageData): DetectedIssue[] {
    const issues: DetectedIssue[] = []

    // Noindex
    if (page.meta?.robots?.includes('noindex')) {
      const issue = this.createIssue('INDEX_NOINDEX', {
        robots: page.meta.robots,
      })
      if (issue) issues.push(issue)
    }

    // Missing canonical
    if (!page.canonical) {
      const issue = this.createIssue('INDEX_NO_CANONICAL', {
        url: page.url,
      })
      if (issue) issues.push(issue)
    }

    // Canonical to different URL (potential issue)
    if (page.canonical && page.canonical !== page.url) {
      // Check if it's just a trailing slash difference
      const normalizedUrl = page.url.replace(/\/$/, '')
      const normalizedCanonical = page.canonical.replace(/\/$/, '')
      if (normalizedUrl !== normalizedCanonical) {
        const issue = this.createIssue('INDEX_CANONICAL_MISMATCH', {
          url: page.url,
          canonical: page.canonical,
        })
        if (issue) issues.push(issue)
      }
    }

    // Duplicate content (same canonical for multiple pages tracked elsewhere)

    // Blocked by robots.txt
    if (page.blockedByRobots) {
      const issue = this.createIssue('INDEX_ROBOTS_BLOCKED', {
        url: page.url,
      })
      if (issue) issues.push(issue)
    }

    return issues
  }

  // ============================================================================
  // CONTENT ANALYZERS
  // ============================================================================

  private analyzeContent(page: PageData): DetectedIssue[] {
    const issues: DetectedIssue[] = []

    // Missing title
    if (!page.title) {
      const issue = this.createIssue('CONTENT_NO_TITLE', {
        url: page.url,
      })
      if (issue) issues.push(issue)
    }

    // Title too short (< 30 chars)
    if (page.title && page.title.length < 30) {
      const issue = this.createIssue('CONTENT_TITLE_SHORT', {
        title: page.title,
        length: page.title.length,
        minLength: 30,
      })
      if (issue) issues.push(issue)
    }

    // Title too long (> 60 chars)
    if (page.title && page.title.length > 60) {
      const issue = this.createIssue('CONTENT_TITLE_LONG', {
        title: page.title,
        length: page.title.length,
        maxLength: 60,
      })
      if (issue) issues.push(issue)
    }

    // Missing meta description
    if (!page.meta?.description) {
      const issue = this.createIssue('CONTENT_NO_META_DESC', {
        url: page.url,
      })
      if (issue) issues.push(issue)
    }

    // Meta description too short (< 70 chars)
    if (page.meta?.description && page.meta.description.length < 70) {
      const issue = this.createIssue('CONTENT_META_DESC_SHORT', {
        description: page.meta.description,
        length: page.meta.description.length,
        minLength: 70,
      })
      if (issue) issues.push(issue)
    }

    // Meta description too long (> 160 chars)
    if (page.meta?.description && page.meta.description.length > 160) {
      const issue = this.createIssue('CONTENT_META_DESC_LONG', {
        description: page.meta.description,
        length: page.meta.description.length,
        maxLength: 160,
      })
      if (issue) issues.push(issue)
    }

    // Missing H1
    if (!page.h1 || page.h1.length === 0) {
      const issue = this.createIssue('CONTENT_NO_H1', {
        url: page.url,
      })
      if (issue) issues.push(issue)
    }

    // Multiple H1s
    if (page.h1 && page.h1.length > 1) {
      const issue = this.createIssue('CONTENT_MULTIPLE_H1', {
        h1s: page.h1,
        count: page.h1.length,
      })
      if (issue) issues.push(issue)
    }

    // Low word count (< 300 words)
    if (page.wordCount !== undefined && page.wordCount < 300 && page.wordCount >= 100) {
      const issue = this.createIssue('CONTENT_LOW_WORD_COUNT', {
        wordCount: page.wordCount,
        minWords: 300,
      })
      if (issue) issues.push(issue)
    }

    // Very thin content (< 100 words) - more severe
    if (page.wordCount !== undefined && page.wordCount < 100 && page.wordCount > 0) {
      const issue = this.createIssue('very_thin_content', {
        wordCount: page.wordCount,
        threshold: 100,
      })
      if (issue) issues.push(issue)
    }

    // No readable body content
    if (page.wordCount !== undefined && page.wordCount === 0) {
      const issue = this.createIssue('no_body_content', {
        url: page.url,
      })
      if (issue) issues.push(issue)
    }

    // Keyword stuffing detection (word density > 3%)
    if (page.topKeywords && page.topKeywords.length > 0) {
      const stuffedKeywords = page.topKeywords.filter(k => k.density > 3)
      if (stuffedKeywords.length > 0) {
        const issue = this.createIssue('keyword_stuffing', {
          keywords: stuffedKeywords,
          threshold: 3,
        })
        if (issue) issues.push(issue)
      }
    }

    // Low text to HTML ratio (< 10%)
    if (page.textToHtmlRatio !== undefined && page.textToHtmlRatio < 10 && page.wordCount && page.wordCount > 50) {
      const issue = this.createIssue('low_text_ratio', {
        ratio: page.textToHtmlRatio,
        threshold: 10,
      })
      if (issue) issues.push(issue)
    }

    // Complex reading level
    if (page.readingLevel === 'complex' && page.readingGradeLevel && page.readingGradeLevel > 16) {
      const issue = this.createIssue('reading_level_complex', {
        readingLevel: page.readingLevel,
        gradeLevel: page.readingGradeLevel,
      })
      if (issue) issues.push(issue)
    }

    // Broken heading hierarchy
    if (page.headingHierarchy && page.headingHierarchy.length > 0) {
      const hierarchy = page.headingHierarchy
      let hasSkip = false

      for (let i = 1; i < hierarchy.length; i++) {
        const prevLevel = parseInt(hierarchy[i - 1]?.charAt(1) || '0', 10)
        const currLevel = parseInt(hierarchy[i]?.charAt(1) || '0', 10)
        // Check if we skip more than one level (e.g., h1 to h3)
        if (currLevel > prevLevel + 1) {
          hasSkip = true
          break
        }
      }

      if (hasSkip) {
        const issue = this.createIssue('broken_heading_hierarchy', {
          hierarchy: hierarchy,
        })
        if (issue) issues.push(issue)
      }
    }

    // Title keywords not in content
    if (page.title && page.wordCount && page.wordCount >= 50) {
      const titleWords = page.title.toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length >= 4)  // Only meaningful words

      const bodyText = page.topKeywords?.map(k => k.word).join(' ') || ''
      const missingKeywords = titleWords.filter(w => !bodyText.includes(w))

      if (titleWords.length > 0 && missingKeywords.length === titleWords.length) {
        const issue = this.createIssue('title_keyword_missing', {
          titleWords: titleWords,
          missingWords: missingKeywords,
        })
        if (issue) issues.push(issue)
      }
    }

    // Duplicate title (tracked across pages)
    // Duplicate meta description (tracked across pages)

    return issues
  }

  // ============================================================================
  // PERFORMANCE ANALYZERS
  // ============================================================================

  private analyzePerformance(page: PageData): DetectedIssue[] {
    const issues: DetectedIssue[] = []

    // Large page size (> 3MB)
    if (page.pageSize && page.pageSize > 3 * 1024 * 1024) {
      const issue = this.createIssue('PERF_LARGE_PAGE', {
        pageSize: page.pageSize,
        maxSize: 3 * 1024 * 1024,
      })
      if (issue) issues.push(issue)
    }

    // Large HTML (> 100KB)
    if (page.htmlSize && page.htmlSize > 100 * 1024) {
      const issue = this.createIssue('PERF_LARGE_HTML', {
        htmlSize: page.htmlSize,
        maxSize: 100 * 1024,
      })
      if (issue) issues.push(issue)
    }

    // Too many requests (> 100)
    if (page.requestCount && page.requestCount > 100) {
      const issue = this.createIssue('PERF_TOO_MANY_REQUESTS', {
        requestCount: page.requestCount,
        maxRequests: 100,
      })
      if (issue) issues.push(issue)
    }

    // Core Web Vitals issues
    if (page.coreWebVitals) {
      // Poor LCP (> 4s)
      if (page.coreWebVitals.lcp && page.coreWebVitals.lcp > 4000) {
        const issue = this.createIssue('PERF_POOR_LCP', {
          lcp: page.coreWebVitals.lcp,
          threshold: 4000,
        })
        if (issue) issues.push(issue)
      }

      // Poor FID (> 300ms)
      if (page.coreWebVitals.fid && page.coreWebVitals.fid > 300) {
        const issue = this.createIssue('PERF_POOR_FID', {
          fid: page.coreWebVitals.fid,
          threshold: 300,
        })
        if (issue) issues.push(issue)
      }

      // Poor CLS (> 0.25)
      if (page.coreWebVitals.cls && page.coreWebVitals.cls > 0.25) {
        const issue = this.createIssue('PERF_POOR_CLS', {
          cls: page.coreWebVitals.cls,
          threshold: 0.25,
        })
        if (issue) issues.push(issue)
      }

      // Poor INP (> 500ms)
      if (page.coreWebVitals.inp && page.coreWebVitals.inp > 500) {
        const issue = this.createIssue('PERF_POOR_INP', {
          inp: page.coreWebVitals.inp,
          threshold: 500,
        })
        if (issue) issues.push(issue)
      }

      // Poor TTFB (> 800ms)
      if (page.coreWebVitals.ttfb && page.coreWebVitals.ttfb > 800) {
        const issue = this.createIssue('PERF_POOR_TTFB', {
          ttfb: page.coreWebVitals.ttfb,
          threshold: 800,
        })
        if (issue) issues.push(issue)
      }
    }

    // Unminified CSS/JS
    if (page.hasUnminifiedCss) {
      const issue = this.createIssue('PERF_UNMINIFIED_CSS', {
        files: page.unminifiedCssFiles,
      })
      if (issue) issues.push(issue)
    }

    if (page.hasUnminifiedJs) {
      const issue = this.createIssue('PERF_UNMINIFIED_JS', {
        files: page.unminifiedJsFiles,
      })
      if (issue) issues.push(issue)
    }

    // Render-blocking resources
    if (page.renderBlockingResources && page.renderBlockingResources.length > 0) {
      const issue = this.createIssue('PERF_RENDER_BLOCKING', {
        resources: page.renderBlockingResources,
        count: page.renderBlockingResources.length,
      })
      if (issue) issues.push(issue)
    }

    return issues
  }

  // ============================================================================
  // SECURITY ANALYZERS
  // ============================================================================

  private analyzeSecurity(page: PageData): DetectedIssue[] {
    const issues: DetectedIssue[] = []

    // HTTP page (not HTTPS)
    if (page.url.startsWith('http://')) {
      const issue = this.createIssue('SEC_NOT_HTTPS', {
        url: page.url,
      })
      if (issue) issues.push(issue)
    }

    // Mixed content
    if (page.hasMixedContent) {
      const issue = this.createIssue('SEC_MIXED_CONTENT', {
        mixedContentUrls: page.mixedContentUrls,
      })
      if (issue) issues.push(issue)
    }

    // Missing security headers
    if (page.securityHeaders) {
      if (!page.securityHeaders.contentSecurityPolicy) {
        const issue = this.createIssue('SEC_NO_CSP', {
          url: page.url,
        })
        if (issue) issues.push(issue)
      }

      if (!page.securityHeaders.xFrameOptions) {
        const issue = this.createIssue('SEC_NO_X_FRAME', {
          url: page.url,
        })
        if (issue) issues.push(issue)
      }

      if (!page.securityHeaders.strictTransportSecurity) {
        const issue = this.createIssue('SEC_NO_HSTS', {
          url: page.url,
        })
        if (issue) issues.push(issue)
      }
    }

    // Insecure form action
    if (page.hasInsecureForms) {
      const issue = this.createIssue('SEC_INSECURE_FORM', {
        forms: page.insecureForms,
      })
      if (issue) issues.push(issue)
    }

    return issues
  }

  // ============================================================================
  // IMAGE ANALYZERS
  // ============================================================================

  private analyzeImages(page: PageData): DetectedIssue[] {
    const issues: DetectedIssue[] = []

    if (!page.images) return issues

    // Images without alt text
    const imagesNoAlt = page.images.filter((img) => !img.alt)
    if (imagesNoAlt.length > 0) {
      const issue = this.createIssue('IMG_NO_ALT', {
        images: imagesNoAlt.map((i) => i.src),
        count: imagesNoAlt.length,
      })
      if (issue) issues.push(issue)
    }

    // Large images (> 200KB)
    const largeImages = page.images.filter((img) => img.size && img.size > 200 * 1024)
    if (largeImages.length > 0) {
      const issue = this.createIssue('IMG_TOO_LARGE', {
        images: largeImages.map((i) => ({ src: i.src, size: i.size })),
        count: largeImages.length,
        maxSize: 200 * 1024,
      })
      if (issue) issues.push(issue)
    }

    // Images without dimensions
    const imagesNoDimensions = page.images.filter((img) => !img.width || !img.height)
    if (imagesNoDimensions.length > 0) {
      const issue = this.createIssue('IMG_NO_DIMENSIONS', {
        images: imagesNoDimensions.map((i) => i.src),
        count: imagesNoDimensions.length,
      })
      if (issue) issues.push(issue)
    }

    // Non-optimized format (not using WebP/AVIF for large images)
    const nonOptimizedImages = page.images.filter(
      (img) =>
        img.size &&
        img.size > 50 * 1024 &&
        !img.src.match(/\.(webp|avif)$/i) &&
        !img.src.includes('format=webp')
    )
    if (nonOptimizedImages.length > 0) {
      const issue = this.createIssue('IMG_NOT_OPTIMIZED', {
        images: nonOptimizedImages.map((i) => i.src),
        count: nonOptimizedImages.length,
      })
      if (issue) issues.push(issue)
    }

    // Broken images
    const brokenImages = page.images.filter((img) => img.isBroken)
    if (brokenImages.length > 0) {
      const issue = this.createIssue('IMG_BROKEN', {
        images: brokenImages.map((i) => i.src),
        count: brokenImages.length,
      })
      if (issue) issues.push(issue)
    }

    return issues
  }

  // ============================================================================
  // STRUCTURED DATA ANALYZERS
  // ============================================================================

  private analyzeStructuredData(page: PageData): DetectedIssue[] {
    const issues: DetectedIssue[] = []

    // No structured data
    if (!page.structuredData || page.structuredData.length === 0) {
      const issue = this.createIssue('SCHEMA_NO_DATA', {
        url: page.url,
      })
      if (issue) issues.push(issue)
    }

    // Invalid structured data
    if (page.structuredDataErrors && page.structuredDataErrors.length > 0) {
      const issue = this.createIssue('SCHEMA_INVALID', {
        errors: page.structuredDataErrors,
      })
      if (issue) issues.push(issue)
    }

    // Missing recommended properties
    if (page.structuredDataWarnings && page.structuredDataWarnings.length > 0) {
      const issue = this.createIssue('SCHEMA_MISSING_PROPS', {
        warnings: page.structuredDataWarnings,
      })
      if (issue) issues.push(issue)
    }

    return issues
  }

  // ============================================================================
  // MOBILE ANALYZERS
  // ============================================================================

  private analyzeMobile(page: PageData): DetectedIssue[] {
    const issues: DetectedIssue[] = []
    const mobile = page.mobile
    const mobileIssues = mobile?.issues || {}

    // ========== LEGACY CHECKS (backward compatibility) ==========

    // No viewport meta tag
    if (!page.hasViewport && !mobile?.viewportAnalysis?.hasViewport) {
      const issue = this.createIssue('MOBILE_NO_VIEWPORT', {
        url: page.url,
      })
      if (issue) issues.push(issue)
    }

    // Fixed width viewport
    if (page.viewportContent && page.viewportContent.includes('width=') && !page.viewportContent.includes('device-width')) {
      const issue = this.createIssue('MOBILE_FIXED_WIDTH', {
        viewport: page.viewportContent,
      })
      if (issue) issues.push(issue)
    }

    // Small tap targets (legacy field)
    if (page.smallTapTargets && page.smallTapTargets.length > 0) {
      const issue = this.createIssue('MOBILE_SMALL_TAP', {
        elements: page.smallTapTargets,
        count: page.smallTapTargets.length,
      })
      if (issue) issues.push(issue)
    }

    // Text too small (legacy field)
    if (page.hasSmallText) {
      const issue = this.createIssue('MOBILE_SMALL_TEXT', {
        url: page.url,
      })
      if (issue) issues.push(issue)
    }

    // Content wider than screen (legacy field)
    if (page.hasHorizontalScroll) {
      const issue = this.createIssue('MOBILE_HORIZONTAL_SCROLL', {
        url: page.url,
      })
      if (issue) issues.push(issue)
    }

    // ========== ENHANCED MOBILE CHECKS (new mobile object) ==========

    if (!mobile) {
      return issues
    }

    // Zoom disabled (user-scalable=no or maximum-scale=1)
    if (mobileIssues.zoomDisabled || mobile.viewportAnalysis?.isZoomDisabled) {
      const issue = this.createIssue('mobile_zoom_disabled', {
        url: page.url,
        viewport: mobile.viewportAnalysis?.content,
        hasUserScalableNo: mobile.viewportAnalysis?.hasUserScalableNo,
        maxScale: mobile.viewportAnalysis?.maxScale,
      })
      if (issue) issues.push(issue)
    }

    // Content wider than viewport
    if (mobileIssues.contentWiderThanScreen || mobile.contentOverflowsViewport) {
      const issue = this.createIssue('mobile_content_wider_than_screen', {
        url: page.url,
      })
      if (issue) issues.push(issue)
    }

    // Images not responsive
    if (mobileIssues.imagesNotResponsive || (mobile.nonResponsiveImageCount && mobile.nonResponsiveImageCount > 0)) {
      const issue = this.createIssue('mobile_images_not_responsive', {
        url: page.url,
        nonResponsiveCount: mobile.nonResponsiveImageCount,
        totalImages: mobile.totalImageCount,
      })
      if (issue) issues.push(issue)
    }

    // Tables without responsive handling
    if (mobileIssues.tablesWithoutResponsive || (mobile.tableCount && mobile.tableCount > 0 && !mobile.hasResponsiveTables)) {
      const issue = this.createIssue('mobile_tables_without_responsive', {
        url: page.url,
        tableCount: mobile.tableCount,
      })
      if (issue) issues.push(issue)
    }

    // Fixed elements blocking content
    if (mobileIssues.fixedElementsBlocking || mobile.hasLargeFixedElements) {
      const issue = this.createIssue('mobile_fixed_elements_blocking', {
        url: page.url,
        fixedElements: mobile.fixedElements,
      })
      if (issue) issues.push(issue)
    }

    // Font too small
    if (mobileIssues.fontTooSmall || (mobile.minimumFontSize && mobile.minimumFontSize < 12)) {
      const issue = this.createIssue('mobile_font_too_small', {
        url: page.url,
        minimumFontSize: mobile.minimumFontSize,
        smallTextElements: mobile.smallTextElements?.slice(0, 5),
      })
      if (issue) issues.push(issue)
    }

    // Tap targets too small (enhanced)
    if (mobileIssues.tapTargetsTooSmall || (mobile.tapTargetIssues?.tooSmall && mobile.tapTargetIssues.tooSmall.length > 0)) {
      const issue = this.createIssue('mobile_tap_targets_too_small', {
        url: page.url,
        elements: mobile.tapTargetIssues?.tooSmall?.slice(0, 10),
        count: mobile.tapTargetIssues?.tooSmall?.length,
      })
      if (issue) issues.push(issue)
    }

    // Tap targets too close
    if (mobileIssues.tapTargetsTooClose || (mobile.tapTargetIssues?.tooClose && mobile.tapTargetIssues.tooClose.length > 0)) {
      const issue = this.createIssue('mobile_tap_targets_too_close', {
        url: page.url,
        elements: mobile.tapTargetIssues?.tooClose?.slice(0, 10),
        count: mobile.tapTargetIssues?.tooClose?.length,
      })
      if (issue) issues.push(issue)
    }

    // Missing Apple Touch Icon
    if (mobileIssues.noAppleTouchIcon || mobile.hasAppleTouchIcon === false) {
      const issue = this.createIssue('mobile_no_apple_touch_icon', {
        url: page.url,
      })
      if (issue) issues.push(issue)
    }

    // Missing Web App Manifest
    if (mobileIssues.noWebAppManifest || mobile.hasWebAppManifest === false) {
      const issue = this.createIssue('mobile_no_web_app_manifest', {
        url: page.url,
      })
      if (issue) issues.push(issue)
    }

    // Missing theme color
    if (mobileIssues.noThemeColor || (mobile.hasThemeColor === undefined || mobile.hasThemeColor === '')) {
      const issue = this.createIssue('mobile_no_theme_color', {
        url: page.url,
      })
      if (issue) issues.push(issue)
    }

    // No tel: links when phone numbers found
    if (mobileIssues.noTelLinks || (mobile.phoneNumbersFound && mobile.phoneNumbersFound > 0 && !mobile.hasTelLinks)) {
      const issue = this.createIssue('mobile_no_tel_links', {
        url: page.url,
        phoneNumbersFound: mobile.phoneNumbersFound,
      })
      if (issue) issues.push(issue)
    }

    // LCP element is lazy loaded
    if (mobileIssues.lcpLazyLoaded || mobile.lcpElementIsLazyLoaded) {
      const issue = this.createIssue('mobile_lcp_lazy_loaded', {
        url: page.url,
      })
      if (issue) issues.push(issue)
    }

    // No responsive CSS media queries
    if (mobileIssues.noMediaQueries || mobile.hasMediaQueries === false) {
      const issue = this.createIssue('mobile_no_media_queries', {
        url: page.url,
      })
      if (issue) issues.push(issue)
    }

    // Initial scale not 1
    if (mobileIssues.initialScaleNotOne || (mobile.viewportAnalysis?.initialScale && mobile.viewportAnalysis.initialScale !== 1)) {
      const issue = this.createIssue('mobile_viewport_initial_scale_not_1', {
        url: page.url,
        initialScale: mobile.viewportAnalysis?.initialScale,
      })
      if (issue) issues.push(issue)
    }

    return issues
  }

  // ============================================================================
  // INTERNATIONAL ANALYZERS
  // ============================================================================

  private analyzeInternational(page: PageData): DetectedIssue[] {
    const issues: DetectedIssue[] = []

    // Missing lang attribute
    if (!page.lang) {
      const issue = this.createIssue('I18N_NO_LANG', {
        url: page.url,
      })
      if (issue) issues.push(issue)
    }

    // Invalid hreflang
    if (page.hreflangErrors && page.hreflangErrors.length > 0) {
      const issue = this.createIssue('I18N_INVALID_HREFLANG', {
        errors: page.hreflangErrors,
      })
      if (issue) issues.push(issue)
    }

    // Missing x-default hreflang
    if (page.hreflangs && page.hreflangs.length > 0 && !page.hreflangs.some((h) => h.lang === 'x-default')) {
      const issue = this.createIssue('I18N_NO_X_DEFAULT', {
        hreflangs: page.hreflangs,
      })
      if (issue) issues.push(issue)
    }

    // Non-reciprocal hreflang
    if (page.nonReciprocalHreflangs && page.nonReciprocalHreflangs.length > 0) {
      const issue = this.createIssue('I18N_NOT_RECIPROCAL', {
        issues: page.nonReciprocalHreflangs,
      })
      if (issue) issues.push(issue)
    }

    // Enhanced hreflang validation
    if (page.hreflangValidation) {
      // Invalid language codes
      if (page.hreflangValidation.invalidLangCodes && page.hreflangValidation.invalidLangCodes.length > 0) {
        const issue = this.createIssue('hreflang_invalid_lang_code', {
          invalidCodes: page.hreflangValidation.invalidLangCodes,
          count: page.hreflangValidation.invalidLangCodes.length,
        })
        if (issue) issues.push(issue)
      }

      // Invalid region codes
      if (page.hreflangValidation.invalidRegionCodes && page.hreflangValidation.invalidRegionCodes.length > 0) {
        const issue = this.createIssue('hreflang_invalid_region', {
          invalidCodes: page.hreflangValidation.invalidRegionCodes,
          count: page.hreflangValidation.invalidRegionCodes.length,
        })
        if (issue) issues.push(issue)
      }

      // Missing self-reference
      if (page.hreflangs && page.hreflangs.length > 0 && !page.hreflangValidation.hasSelfReference) {
        const issue = this.createIssue('hreflang_no_self_reference', {
          url: page.url,
          hreflangs: page.hreflangs,
        })
        if (issue) issues.push(issue)
      }

      // Duplicate entries
      if (page.hreflangValidation.duplicateEntries && page.hreflangValidation.duplicateEntries.length > 0) {
        const issue = this.createIssue('hreflang_duplicate_entries', {
          duplicates: page.hreflangValidation.duplicateEntries,
        })
        if (issue) issues.push(issue)
      }
    }

    return issues
  }

  // ============================================================================
  // SOCIAL ANALYZERS
  // ============================================================================

  private analyzeSocial(page: PageData): DetectedIssue[] {
    const issues: DetectedIssue[] = []

    // Missing Open Graph tags
    if (!page.openGraph || Object.keys(page.openGraph).length === 0) {
      const issue = this.createIssue('SOCIAL_NO_OG', {
        url: page.url,
      })
      if (issue) issues.push(issue)
    }

    // Missing og:image
    if (page.openGraph && !page.openGraph.image) {
      const issue = this.createIssue('SOCIAL_NO_OG_IMAGE', {
        url: page.url,
        existingTags: Object.keys(page.openGraph),
      })
      if (issue) issues.push(issue)
    }

    // Missing Twitter Card
    if (!page.twitterCard || Object.keys(page.twitterCard).length === 0) {
      const issue = this.createIssue('SOCIAL_NO_TWITTER', {
        url: page.url,
      })
      if (issue) issues.push(issue)
    }

    return issues
  }

  // ============================================================================
  // ACCESSIBILITY ANALYZERS
  // ============================================================================

  private analyzeAccessibility(page: PageData): DetectedIssue[] {
    const issues: DetectedIssue[] = []

    // Empty links
    if (page.emptyLinks && page.emptyLinks.length > 0) {
      const issue = this.createIssue('A11Y_EMPTY_LINKS', {
        links: page.emptyLinks,
        count: page.emptyLinks.length,
      })
      if (issue) issues.push(issue)
    }

    // Missing form labels
    if (page.missingFormLabels && page.missingFormLabels.length > 0) {
      const issue = this.createIssue('A11Y_NO_FORM_LABELS', {
        fields: page.missingFormLabels,
        count: page.missingFormLabels.length,
      })
      if (issue) issues.push(issue)
    }

    // Low contrast text
    if (page.lowContrastElements && page.lowContrastElements.length > 0) {
      const issue = this.createIssue('A11Y_LOW_CONTRAST', {
        elements: page.lowContrastElements,
        count: page.lowContrastElements.length,
      })
      if (issue) issues.push(issue)
    }

    // Missing skip links
    if (!page.hasSkipLink) {
      const issue = this.createIssue('A11Y_NO_SKIP_LINK', {
        url: page.url,
      })
      if (issue) issues.push(issue)
    }

    // Missing ARIA landmarks
    if (!page.hasAriaLandmarks) {
      const issue = this.createIssue('A11Y_NO_LANDMARKS', {
        url: page.url,
      })
      if (issue) issues.push(issue)
    }

    return issues
  }

  // ============================================================================
  // AI SEARCH ANALYZERS
  // ============================================================================

  private analyzeAiSearch(page: PageData): DetectedIssue[] {
    const issues: DetectedIssue[] = []

    // Blocking AI crawlers
    if (page.aiCrawlerAccess) {
      const blockedCrawlers = Object.entries(page.aiCrawlerAccess)
        .filter(([_, allowed]) => allowed === false)
        .map(([crawler]) => crawler)

      if (blockedCrawlers.length > 0) {
        const issue = this.createIssue('AI_CRAWLERS_BLOCKED', {
          blockedCrawlers,
          count: blockedCrawlers.length,
        })
        if (issue) issues.push(issue)
      }
    }

    // No LLM-friendly content structure
    if (!page.hasLlmFriendlyStructure) {
      const issue = this.createIssue('AI_NO_STRUCTURE', {
        url: page.url,
        recommendations: [
          'Add clear headings hierarchy',
          'Include FAQ sections with structured data',
          'Use descriptive section titles',
          'Add comprehensive metadata',
        ],
      })
      if (issue) issues.push(issue)
    }

    // Missing FAQ schema (important for AI search)
    if (!page.structuredData?.some((sd) => sd['@type'] === 'FAQPage')) {
      const issue = this.createIssue('AI_NO_FAQ_SCHEMA', {
        url: page.url,
      })
      if (issue) issues.push(issue)
    }

    return issues
  }

  // ============================================================================
  // TECHNICAL SEO ANALYZERS
  // ============================================================================

  private analyzeTechnicalSeo(page: PageData): DetectedIssue[] {
    const issues: DetectedIssue[] = []

    // Pagination issues - paginated page without rel links
    if (page.isPaginatedPage && !page.relPrev && !page.relNext) {
      const issue = this.createIssue('pagination_no_rel_links', {
        url: page.url,
        pageNumber: page.paginationPageNumber,
      })
      if (issue) issues.push(issue)
    }

    // Pagination pages canonicalizing to first page (potential issue)
    if (page.isPaginatedPage && page.paginationPageNumber && page.paginationPageNumber > 1) {
      if (page.canonical && !page.isSelfCanonical) {
        // Check if canonical points to a non-paginated version (likely page 1)
        const canonicalUrl = page.canonical
        const hasPageParam = /[?&]page=|\/page\/|[?&]p=/i.test(canonicalUrl)
        if (!hasPageParam) {
          const issue = this.createIssue('pagination_first_page_canonical', {
            url: page.url,
            canonical: page.canonical,
            pageNumber: page.paginationPageNumber,
          })
          if (issue) issues.push(issue)
        }
      }
    }

    // Pagination pages with noindex
    if (page.isPaginatedPage && page.meta?.robots?.includes('noindex')) {
      const issue = this.createIssue('pagination_noindex', {
        url: page.url,
        pageNumber: page.paginationPageNumber,
      })
      if (issue) issues.push(issue)
    }

    // Excessive URL parameters (3+)
    if (page.urlParameterCount && page.urlParameterCount >= 3) {
      const issue = this.createIssue('excessive_url_parameters', {
        url: page.url,
        parameters: page.urlParameters,
        count: page.urlParameterCount,
      })
      if (issue) issues.push(issue)
    }

    // Sorting parameters in URL
    if (page.hasSortingParams) {
      const issue = this.createIssue('url_parameter_sorting', {
        url: page.url,
        parameters: page.urlParameters,
      })
      if (issue) issues.push(issue)
    }

    // Session/tracking parameters in URL
    if (page.hasSessionParams) {
      const issue = this.createIssue('url_parameter_session', {
        url: page.url,
        parameters: page.urlParameters,
      })
      if (issue) issues.push(issue)
    }

    // Faceted navigation URLs (filter params that are indexable)
    if (page.hasFilterParams && page.isIndexable) {
      const issue = this.createIssue('faceted_nav_indexable', {
        url: page.url,
        parameters: page.urlParameters,
      })
      if (issue) issues.push(issue)
    }

    // Self-referencing canonical missing
    if (page.isIndexable && page.statusCode === 200) {
      if (!page.canonical) {
        const issue = this.createIssue('self_canonical_missing', {
          url: page.url,
        })
        if (issue) issues.push(issue)
      }
    }

    return issues
  }

  // ============================================================================
  // E-COMMERCE ANALYZERS
  // ============================================================================

  private analyzeEcommerce(page: PageData): DetectedIssue[] {
    const issues: DetectedIssue[] = []

    // Only analyze pages with product schema
    if (!page.ecommerce?.hasProductSchema) {
      return issues
    }

    const ecommerce = page.ecommerce
    const productIssues = ecommerce.issues || {}

    // Missing product name (required)
    if (productIssues.missingProductName) {
      const issue = this.createIssue('product_missing_name', {
        url: page.url,
        hasOtherFields: !!ecommerce.productData?.sku || !!ecommerce.productData?.brand,
      })
      if (issue) issues.push(issue)
    }

    // Missing product description
    if (productIssues.missingDescription) {
      const issue = this.createIssue('product_missing_description', {
        url: page.url,
        productName: ecommerce.productData?.name,
      })
      if (issue) issues.push(issue)
    }

    // Missing product image
    if (productIssues.missingImage) {
      const issue = this.createIssue('product_missing_image', {
        url: page.url,
        productName: ecommerce.productData?.name,
      })
      if (issue) issues.push(issue)
    }

    // Missing SKU/GTIN/MPN identifier
    if (productIssues.missingSku) {
      const issue = this.createIssue('product_missing_identifier', {
        url: page.url,
        productName: ecommerce.productData?.name,
      })
      if (issue) issues.push(issue)
    }

    // Missing brand
    if (productIssues.missingBrand) {
      const issue = this.createIssue('product_missing_brand', {
        url: page.url,
        productName: ecommerce.productData?.name,
      })
      if (issue) issues.push(issue)
    }

    // Missing offer/price info entirely
    if (productIssues.missingOffer) {
      const issue = this.createIssue('product_missing_offer', {
        url: page.url,
        productName: ecommerce.productData?.name,
      })
      if (issue) issues.push(issue)
    }

    // Missing price (has offer but no price)
    if (productIssues.missingPrice && !productIssues.missingOffer) {
      const issue = this.createIssue('product_missing_price', {
        url: page.url,
        productName: ecommerce.productData?.name,
      })
      if (issue) issues.push(issue)
    }

    // Invalid price (negative)
    if (productIssues.invalidPrice) {
      const issue = this.createIssue('product_invalid_price', {
        url: page.url,
        productName: ecommerce.productData?.name,
        price: ecommerce.productData?.price,
      })
      if (issue) issues.push(issue)
    }

    // Missing currency
    if (productIssues.missingCurrency && !productIssues.missingOffer) {
      const issue = this.createIssue('product_missing_currency', {
        url: page.url,
        productName: ecommerce.productData?.name,
        price: ecommerce.productData?.price,
      })
      if (issue) issues.push(issue)
    }

    // Missing availability
    if (productIssues.missingAvailability && !productIssues.missingOffer) {
      const issue = this.createIssue('product_missing_availability', {
        url: page.url,
        productName: ecommerce.productData?.name,
      })
      if (issue) issues.push(issue)
    }

    // Out of stock product
    if (productIssues.outOfStock) {
      const issue = this.createIssue('product_out_of_stock', {
        url: page.url,
        productName: ecommerce.productData?.name,
        availability: ecommerce.productData?.availability,
      })
      if (issue) issues.push(issue)
    }

    // Discontinued product
    if (productIssues.discontinuedProduct) {
      const issue = this.createIssue('product_discontinued', {
        url: page.url,
        productName: ecommerce.productData?.name,
        availability: ecommerce.productData?.availability,
      })
      if (issue) issues.push(issue)
    }

    // Expired price validity
    if (productIssues.expiredPrice) {
      const issue = this.createIssue('product_price_expired', {
        url: page.url,
        productName: ecommerce.productData?.name,
        offers: ecommerce.productData?.offers,
      })
      if (issue) issues.push(issue)
    }

    // Multiple products on single page
    if (productIssues.multipleProducts) {
      const issue = this.createIssue('product_multiple_on_page', {
        url: page.url,
      })
      if (issue) issues.push(issue)
    }

    return issues
  }

  // ============================================================================
  // ARTICLE/NEWS/BLOG ANALYZERS
  // ============================================================================

  private analyzeArticle(page: PageData): DetectedIssue[] {
    const issues: DetectedIssue[] = []

    // Only analyze pages with article schema
    if (!page.article?.hasArticleSchema) {
      return issues
    }

    const article = page.article
    const articleIssues = article.issues || {}
    const articleData = article.articleData || {}

    // Missing headline (required)
    if (articleIssues.missingHeadline) {
      const issue = this.createIssue('article_missing_headline', {
        url: page.url,
        schemaType: article.schemaType,
      })
      if (issue) issues.push(issue)
    }

    // Missing datePublished (required for NewsArticle)
    if (articleIssues.missingDatePublished) {
      const issue = this.createIssue('article_missing_date_published', {
        url: page.url,
        schemaType: article.schemaType,
        headline: articleData.headline?.substring(0, 100),
      })
      if (issue) issues.push(issue)
    }

    // Missing author (important for E-E-A-T)
    if (articleIssues.missingAuthor) {
      const issue = this.createIssue('article_missing_author', {
        url: page.url,
        schemaType: article.schemaType,
        headline: articleData.headline?.substring(0, 100),
      })
      if (issue) issues.push(issue)
    }

    // Missing image (required for rich results)
    if (articleIssues.missingImage) {
      const issue = this.createIssue('article_missing_image', {
        url: page.url,
        schemaType: article.schemaType,
        headline: articleData.headline?.substring(0, 100),
      })
      if (issue) issues.push(issue)
    }

    // Missing description
    if (articleIssues.missingDescription) {
      const issue = this.createIssue('article_missing_description', {
        url: page.url,
        schemaType: article.schemaType,
        headline: articleData.headline?.substring(0, 100),
      })
      if (issue) issues.push(issue)
    }

    // Missing publisher
    if (articleIssues.missingPublisher) {
      const issue = this.createIssue('article_missing_publisher', {
        url: page.url,
        schemaType: article.schemaType,
        headline: articleData.headline?.substring(0, 100),
      })
      if (issue) issues.push(issue)
    }

    // Invalid date format
    if (articleIssues.invalidDateFormat) {
      const issue = this.createIssue('article_invalid_date_format', {
        url: page.url,
        datePublished: articleData.datePublished,
        dateModified: articleData.dateModified,
      })
      if (issue) issues.push(issue)
    }

    // Future publication date
    if (articleIssues.futureDatePublished) {
      const issue = this.createIssue('article_future_publish_date', {
        url: page.url,
        datePublished: articleData.datePublished,
      })
      if (issue) issues.push(issue)
    }

    // Outdated content (over 2 years old without modification)
    if (articleIssues.outdatedContent) {
      const issue = this.createIssue('article_outdated_content', {
        url: page.url,
        datePublished: articleData.datePublished,
        dateModified: articleData.dateModified,
        headline: articleData.headline?.substring(0, 100),
      })
      if (issue) issues.push(issue)
    }

    // Missing articleBody
    if (articleIssues.missingBody) {
      const issue = this.createIssue('article_missing_body', {
        url: page.url,
        schemaType: article.schemaType,
      })
      if (issue) issues.push(issue)
    }

    // Missing dateModified
    if (articleIssues.missingDateModified) {
      const issue = this.createIssue('article_missing_date_modified', {
        url: page.url,
        datePublished: articleData.datePublished,
        headline: articleData.headline?.substring(0, 100),
      })
      if (issue) issues.push(issue)
    }

    // Multiple articles on page
    if (articleIssues.multipleArticles) {
      const issue = this.createIssue('article_multiple_on_page', {
        url: page.url,
        articleCount: article.articleCount,
      })
      if (issue) issues.push(issue)
    }

    // Short headline
    if (articleIssues.shortHeadline) {
      const issue = this.createIssue('article_short_headline', {
        url: page.url,
        headline: articleData.headline,
        headlineLength: articleData.headline?.length,
      })
      if (issue) issues.push(issue)
    }

    // Headline too long
    if (articleIssues.headlineTooLong) {
      const issue = this.createIssue('article_headline_too_long', {
        url: page.url,
        headline: articleData.headline?.substring(0, 150),
        headlineLength: articleData.headline?.length,
      })
      if (issue) issues.push(issue)
    }

    // Missing word count
    if (articleIssues.missingWordCount) {
      const issue = this.createIssue('article_missing_word_count', {
        url: page.url,
        schemaType: article.schemaType,
      })
      if (issue) issues.push(issue)
    }

    return issues
  }

  // ============================================================================
  // ISSUE COUNTS
  // ============================================================================

  /**
   * Get issue counts by severity for the crawl
   */
  async getIssueCounts(): Promise<{
    errors: number
    warnings: number
    notices: number
    pagesWithIssues: number
    categoryScores: Record<string, number>
  }> {
    // Get issues with their definitions
    const { data: issues, error } = await this.supabase
      .from('issues')
      .select(`
        affected_pages_count,
        issue_definitions (
          severity,
          category
        )
      `)
      .eq('crawl_id', this.crawlId)

    if (error) {
      logger.error('Failed to get issue counts', error)
      return {
        errors: 0,
        warnings: 0,
        notices: 0,
        pagesWithIssues: 0,
        categoryScores: {},
      }
    }

    let errors = 0
    let warnings = 0
    let notices = 0
    const categoryIssues: Record<string, { errors: number; warnings: number; notices: number }> = {}

    for (const issue of issues || []) {
      // issue_definitions can be an object or array depending on Supabase join
      const defData = issue.issue_definitions
      const def = Array.isArray(defData) ? defData[0] : defData
      if (!def || typeof def !== 'object') continue

      const typedDef = def as { severity: string; category: string }
      const count = issue.affected_pages_count || 0

      switch (typedDef.severity) {
        case 'error':
          errors += count
          break
        case 'warning':
          warnings += count
          break
        case 'notice':
          notices += count
          break
      }

      // Track by category
      if (!categoryIssues[typedDef.category]) {
        categoryIssues[typedDef.category] = { errors: 0, warnings: 0, notices: 0 }
      }
      const categoryData = categoryIssues[typedDef.category]!
      switch (typedDef.severity) {
        case 'error':
          categoryData.errors += count
          break
        case 'warning':
          categoryData.warnings += count
          break
        case 'notice':
          categoryData.notices += count
          break
      }
    }

    // Calculate category scores
    const categoryScores: Record<string, number> = {}
    for (const [category, counts] of Object.entries(categoryIssues)) {
      const score = 100 - (counts.errors * 5 + counts.warnings * 2 + Math.floor(counts.notices * 0.5))
      categoryScores[category] = Math.max(0, Math.min(100, score))
    }

    // Get DISTINCT pages with issues count (a page with multiple issues should only count once)
    const { data: pagesWithIssuesResult } = await this.supabase
      .rpc('count_distinct_pages_with_issues', { p_crawl_id: this.crawlId })

    const pagesWithIssues = pagesWithIssuesResult ?? 0

    return {
      errors,
      warnings,
      notices,
      pagesWithIssues: pagesWithIssues || 0,
      categoryScores,
    }
  }
}
