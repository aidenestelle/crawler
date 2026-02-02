/**
 * PageSpeed Insights Analyzer
 *
 * Fetches Google PageSpeed Insights data for homepage analysis,
 * including Lighthouse scores, Core Web Vitals, CrUX field data,
 * and performance opportunities.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '../utils/logger.js'

// API types based on Google PageSpeed Insights API v5
interface PSIResponse {
  captchaResult?: string
  kind: string
  id: string
  loadingExperience?: LoadingExperience
  originLoadingExperience?: LoadingExperience
  lighthouseResult: LighthouseResult
  analysisUTCTimestamp: string
}

interface LoadingExperience {
  id: string
  metrics: Record<string, LoadingExperienceMetric>
  overall_category: 'FAST' | 'AVERAGE' | 'SLOW'
  initial_url?: string
}

interface LoadingExperienceMetric {
  percentile: number
  distributions: Array<{
    min: number
    max?: number
    proportion: number
  }>
  category: 'FAST' | 'AVERAGE' | 'SLOW'
}

interface LighthouseResult {
  requestedUrl: string
  finalUrl: string
  lighthouseVersion: string
  userAgent: string
  fetchTime: string
  environment: {
    networkUserAgent: string
    hostUserAgent: string
    benchmarkIndex: number
  }
  runWarnings: string[]
  configSettings: {
    emulatedFormFactor: string
    formFactor: string
    locale: string
    onlyCategories: string[]
  }
  audits: Record<string, LighthouseAudit>
  categories: Record<string, LighthouseCategory>
  timing: {
    total: number
  }
}

interface LighthouseAudit {
  id: string
  title: string
  description: string
  score: number | null
  scoreDisplayMode: string
  displayValue?: string
  numericValue?: number
  numericUnit?: string
  details?: {
    type: string
    items?: Array<Record<string, unknown>>
    overallSavingsMs?: number
    overallSavingsBytes?: number
  }
}

interface LighthouseCategory {
  id: string
  title: string
  description?: string
  score: number | null
  manualDescription?: string
  auditRefs: Array<{
    id: string
    weight: number
    group?: string
  }>
}

interface Opportunity {
  id: string
  title: string
  description: string
  score: number | null
  displayValue?: string
  numericValue?: number
  savingsMs?: number
  savingsBytes?: number
}

interface PSIResult {
  // Lighthouse Scores
  performanceScore: number | null
  accessibilityScore: number | null
  bestPracticesScore: number | null
  seoScore: number | null

  // Core Web Vitals
  lcpMs: number | null
  lcpRating: string | null
  fcpMs: number | null
  fcpRating: string | null
  clsScore: number | null
  clsRating: string | null
  ttfbMs: number | null
  ttfbRating: string | null
  inpMs: number | null
  inpRating: string | null

  // Opportunities & Diagnostics
  opportunities: Opportunity[]
  diagnostics: Opportunity[]
}

interface FieldData {
  hasFieldData: boolean
  lcpP75: number | null
  lcpRating: string | null
  fcpP75: number | null
  fcpRating: string | null
  clsP75: number | null
  clsRating: string | null
  inpP75: number | null
  inpRating: string | null
  ttfbP75: number | null
  ttfbRating: string | null
  overallCategory: string | null
}

export class PageSpeedInsightsAnalyzer {
  private supabase: SupabaseClient
  private apiKey: string

  constructor(supabase: SupabaseClient, apiKey: string) {
    this.supabase = supabase
    this.apiKey = apiKey
  }

  /**
   * Check if the analyzer is configured with an API key
   */
  isConfigured(): boolean {
    return !!this.apiKey
  }

  /**
   * Analyze homepage with PageSpeed Insights (mobile + desktop)
   */
  async analyzeHomepage(
    url: string,
    crawlId: string,
    projectId: string
  ): Promise<void> {
    if (!this.apiKey) {
      logger.warn('[PSI] No API key configured, skipping analysis')
      return
    }

    const startTime = Date.now()
    logger.info(`[PSI] Starting analysis for ${url}`)

    try {
      // Fetch mobile and desktop results in parallel
      const [mobileResult, desktopResult] = await Promise.all([
        this.fetchPSI(url, 'mobile'),
        this.fetchPSI(url, 'desktop'),
      ])

      // Extract field data (same for mobile/desktop - it's real user data)
      const fieldData = this.extractFieldData(mobileResult || desktopResult)

      // Extract results
      const mobile = mobileResult ? this.extractResult(mobileResult) : null
      const desktop = desktopResult ? this.extractResult(desktopResult) : null

      const analysisDuration = Date.now() - startTime

      // Store results
      await this.storeResults({
        crawlId,
        projectId,
        url,
        mobile,
        desktop,
        fieldData,
        lighthouseVersion: mobileResult?.lighthouseResult?.lighthouseVersion || desktopResult?.lighthouseResult?.lighthouseVersion || null,
        fetchTime: mobileResult?.analysisUTCTimestamp || desktopResult?.analysisUTCTimestamp || null,
        analysisDuration,
      })

      logger.info(`[PSI] Analysis complete in ${analysisDuration}ms. Mobile: ${mobile?.performanceScore ?? 'N/A'}, Desktop: ${desktop?.performanceScore ?? 'N/A'}`)
    } catch (error) {
      logger.error('[PSI] Analysis failed:', error)
      // Store error state
      await this.storeError(crawlId, projectId, url, error instanceof Error ? error.message : 'Unknown error')
    }
  }

  /**
   * Fetch PageSpeed Insights data from API
   */
  private async fetchPSI(url: string, strategy: 'mobile' | 'desktop'): Promise<PSIResponse | null> {
    const categories = ['performance', 'accessibility', 'best-practices', 'seo']
    const apiUrl = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed')

    apiUrl.searchParams.set('url', url)
    apiUrl.searchParams.set('key', this.apiKey)
    apiUrl.searchParams.set('strategy', strategy.toUpperCase())
    categories.forEach(cat => apiUrl.searchParams.append('category', cat.toUpperCase()))

    try {
      logger.debug(`[PSI] Fetching ${strategy} data for ${url}`)

      const response = await fetch(apiUrl.toString(), {
        headers: {
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(60000), // 60 second timeout
      })

      if (!response.ok) {
        const errorText = await response.text()
        logger.error(`[PSI] API error (${strategy}): ${response.status} - ${errorText}`)
        return null
      }

      const data = await response.json() as PSIResponse
      return data
    } catch (error) {
      logger.error(`[PSI] Failed to fetch ${strategy} data:`, error)
      return null
    }
  }

  /**
   * Extract processed result from PSI response
   */
  private extractResult(response: PSIResponse): PSIResult {
    const { lighthouseResult } = response
    const { categories, audits } = lighthouseResult

    // Get scores (0-100)
    const performanceScore = categories.performance?.score != null ? Math.round(categories.performance.score * 100) : null
    const accessibilityScore = categories.accessibility?.score != null ? Math.round(categories.accessibility.score * 100) : null
    const bestPracticesScore = categories['best-practices']?.score != null ? Math.round(categories['best-practices'].score * 100) : null
    const seoScore = categories.seo?.score != null ? Math.round(categories.seo.score * 100) : null

    // Extract Core Web Vitals from audits
    const lcp = audits['largest-contentful-paint']
    const fcp = audits['first-contentful-paint']
    const cls = audits['cumulative-layout-shift']
    const ttfb = audits['server-response-time']
    const inp = audits['interaction-to-next-paint'] || audits['experimental-interaction-to-next-paint']

    // Extract opportunities (audits with savings)
    const opportunities = this.extractOpportunities(audits)
    const diagnostics = this.extractDiagnostics(audits)

    return {
      performanceScore,
      accessibilityScore,
      bestPracticesScore,
      seoScore,
      lcpMs: lcp?.numericValue ?? null,
      lcpRating: this.getRating(lcp?.score),
      fcpMs: fcp?.numericValue ?? null,
      fcpRating: this.getRating(fcp?.score),
      clsScore: cls?.numericValue ?? null,
      clsRating: this.getRating(cls?.score),
      ttfbMs: ttfb?.numericValue ?? null,
      ttfbRating: this.getRating(ttfb?.score),
      inpMs: inp?.numericValue ?? null,
      inpRating: this.getRating(inp?.score),
      opportunities,
      diagnostics,
    }
  }

  /**
   * Extract CrUX field data from loading experience
   */
  private extractFieldData(response: PSIResponse | null): FieldData {
    // Prefer origin-level data, fall back to URL-level
    const experience = response?.originLoadingExperience || response?.loadingExperience
    const metrics = experience?.metrics

    // Return empty field data if no experience or no metrics
    if (!experience || !metrics) {
      return {
        hasFieldData: false,
        lcpP75: null,
        lcpRating: null,
        fcpP75: null,
        fcpRating: null,
        clsP75: null,
        clsRating: null,
        inpP75: null,
        inpRating: null,
        ttfbP75: null,
        ttfbRating: null,
        overallCategory: null,
      }
    }

    return {
      hasFieldData: true,
      lcpP75: metrics.LARGEST_CONTENTFUL_PAINT_MS?.percentile ?? null,
      lcpRating: this.fieldCategoryToRating(metrics.LARGEST_CONTENTFUL_PAINT_MS?.category),
      fcpP75: metrics.FIRST_CONTENTFUL_PAINT_MS?.percentile ?? null,
      fcpRating: this.fieldCategoryToRating(metrics.FIRST_CONTENTFUL_PAINT_MS?.category),
      clsP75: metrics.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile != null
        ? metrics.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100 // CLS is scaled by 100 in API
        : null,
      clsRating: this.fieldCategoryToRating(metrics.CUMULATIVE_LAYOUT_SHIFT_SCORE?.category),
      inpP75: metrics.INTERACTION_TO_NEXT_PAINT?.percentile ?? null,
      inpRating: this.fieldCategoryToRating(metrics.INTERACTION_TO_NEXT_PAINT?.category),
      ttfbP75: metrics.EXPERIMENTAL_TIME_TO_FIRST_BYTE?.percentile ?? null,
      ttfbRating: this.fieldCategoryToRating(metrics.EXPERIMENTAL_TIME_TO_FIRST_BYTE?.category),
      overallCategory: experience.overall_category || null,
    }
  }

  /**
   * Extract performance opportunities from audits
   */
  private extractOpportunities(audits: Record<string, LighthouseAudit>): Opportunity[] {
    const opportunityIds = [
      'render-blocking-resources',
      'unused-css-rules',
      'unused-javascript',
      'modern-image-formats',
      'offscreen-images',
      'uses-optimized-images',
      'uses-text-compression',
      'uses-responsive-images',
      'efficient-animated-content',
      'duplicated-javascript',
      'legacy-javascript',
      'preload-lcp-image',
      'total-byte-weight',
      'uses-long-cache-ttl',
      'dom-size',
      'critical-request-chains',
      'redirects',
      'mainthread-work-breakdown',
      'bootup-time',
      'font-display',
      'third-party-summary',
    ]

    return opportunityIds
      .map(id => audits[id])
      .filter((audit): audit is LighthouseAudit => audit !== undefined && audit.score !== null && audit.score < 1)
      .map(audit => ({
        id: audit.id,
        title: audit.title,
        description: audit.description,
        score: audit.score,
        displayValue: audit.displayValue,
        numericValue: audit.numericValue,
        savingsMs: audit.details?.overallSavingsMs,
        savingsBytes: audit.details?.overallSavingsBytes,
      }))
      .sort((a, b) => (a.score ?? 1) - (b.score ?? 1))
      .slice(0, 10) // Top 10 opportunities
  }

  /**
   * Extract diagnostics from audits
   */
  private extractDiagnostics(audits: Record<string, LighthouseAudit>): Opportunity[] {
    const diagnosticIds = [
      'largest-contentful-paint-element',
      'lcp-lazy-loaded',
      'layout-shift-elements',
      'long-tasks',
      'non-composited-animations',
      'unsized-images',
      'viewport',
      'no-document-write',
      'js-libraries',
      'network-requests',
      'network-rtt',
      'network-server-latency',
      'main-thread-tasks',
      'diagnostics',
      'resource-summary',
      'script-treemap-data',
    ]

    return diagnosticIds
      .map(id => audits[id])
      .filter((audit): audit is LighthouseAudit => audit !== undefined && (audit.details?.items?.length ?? 0) > 0)
      .map(audit => ({
        id: audit.id,
        title: audit.title,
        description: audit.description,
        score: audit.score,
        displayValue: audit.displayValue,
        numericValue: audit.numericValue,
      }))
      .slice(0, 10) // Top 10 diagnostics
  }

  /**
   * Convert Lighthouse score to rating
   */
  private getRating(score: number | null | undefined): string | null {
    if (score == null) return null
    if (score >= 0.9) return 'good'
    if (score >= 0.5) return 'needs-improvement'
    return 'poor'
  }

  /**
   * Convert CrUX category to rating
   */
  private fieldCategoryToRating(category: string | undefined): string | null {
    if (!category) return null
    switch (category) {
      case 'FAST': return 'good'
      case 'AVERAGE': return 'needs-improvement'
      case 'SLOW': return 'poor'
      default: return null
    }
  }

  /**
   * Store results in database
   */
  private async storeResults(data: {
    crawlId: string
    projectId: string
    url: string
    mobile: PSIResult | null
    desktop: PSIResult | null
    fieldData: FieldData
    lighthouseVersion: string | null
    fetchTime: string | null
    analysisDuration: number
  }): Promise<void> {
    const { error } = await this.supabase
      .from('crawl_psi_results')
      .upsert({
        crawl_id: data.crawlId,
        project_id: data.projectId,
        url: data.url,

        // Mobile scores
        mobile_performance_score: data.mobile?.performanceScore,
        mobile_accessibility_score: data.mobile?.accessibilityScore,
        mobile_best_practices_score: data.mobile?.bestPracticesScore,
        mobile_seo_score: data.mobile?.seoScore,

        // Mobile CWV
        mobile_lcp_ms: data.mobile?.lcpMs,
        mobile_lcp_rating: data.mobile?.lcpRating,
        mobile_fcp_ms: data.mobile?.fcpMs,
        mobile_fcp_rating: data.mobile?.fcpRating,
        mobile_cls_score: data.mobile?.clsScore,
        mobile_cls_rating: data.mobile?.clsRating,
        mobile_ttfb_ms: data.mobile?.ttfbMs,
        mobile_ttfb_rating: data.mobile?.ttfbRating,
        mobile_inp_ms: data.mobile?.inpMs,
        mobile_inp_rating: data.mobile?.inpRating,

        // Desktop scores
        desktop_performance_score: data.desktop?.performanceScore,
        desktop_accessibility_score: data.desktop?.accessibilityScore,
        desktop_best_practices_score: data.desktop?.bestPracticesScore,
        desktop_seo_score: data.desktop?.seoScore,

        // Desktop CWV
        desktop_lcp_ms: data.desktop?.lcpMs,
        desktop_lcp_rating: data.desktop?.lcpRating,
        desktop_fcp_ms: data.desktop?.fcpMs,
        desktop_fcp_rating: data.desktop?.fcpRating,
        desktop_cls_score: data.desktop?.clsScore,
        desktop_cls_rating: data.desktop?.clsRating,
        desktop_ttfb_ms: data.desktop?.ttfbMs,
        desktop_ttfb_rating: data.desktop?.ttfbRating,
        desktop_inp_ms: data.desktop?.inpMs,
        desktop_inp_rating: data.desktop?.inpRating,

        // Field data
        has_field_data: data.fieldData.hasFieldData,
        field_lcp_p75: data.fieldData.lcpP75,
        field_lcp_rating: data.fieldData.lcpRating,
        field_fcp_p75: data.fieldData.fcpP75,
        field_fcp_rating: data.fieldData.fcpRating,
        field_cls_p75: data.fieldData.clsP75,
        field_cls_rating: data.fieldData.clsRating,
        field_inp_p75: data.fieldData.inpP75,
        field_inp_rating: data.fieldData.inpRating,
        field_ttfb_p75: data.fieldData.ttfbP75,
        field_ttfb_rating: data.fieldData.ttfbRating,
        field_overall_category: data.fieldData.overallCategory,

        // Opportunities & diagnostics
        mobile_opportunities: data.mobile?.opportunities || [],
        desktop_opportunities: data.desktop?.opportunities || [],
        mobile_diagnostics: data.mobile?.diagnostics || [],
        desktop_diagnostics: data.desktop?.diagnostics || [],

        // Metadata
        lighthouse_version: data.lighthouseVersion,
        fetch_time: data.fetchTime,
        analysis_duration_ms: data.analysisDuration,
      }, {
        onConflict: 'crawl_id',
      })

    if (error) {
      logger.error('[PSI] Failed to store results:', error)
      throw error
    }
  }

  /**
   * Store error state
   */
  private async storeError(
    crawlId: string,
    projectId: string,
    url: string,
    errorMessage: string
  ): Promise<void> {
    const { error } = await this.supabase
      .from('crawl_psi_results')
      .upsert({
        crawl_id: crawlId,
        project_id: projectId,
        url,
        error_message: errorMessage,
      }, {
        onConflict: 'crawl_id',
      })

    if (error) {
      logger.error('[PSI] Failed to store error state:', error)
    }
  }
}
