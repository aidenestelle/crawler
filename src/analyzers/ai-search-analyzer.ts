/**
 * AI Search Health Analyzer
 *
 * Analyzes how well a site is optimized for AI search engines
 * and LLM crawlers (ChatGPT, Perplexity, Google AI, etc.)
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '../utils/logger.js'
import type { RobotsParser } from '../utils/robots-parser.js'

interface AISearchHealthData {
  // AI crawler access
  chatgpt_user_allowed: boolean | null
  oai_searchbot_allowed: boolean | null
  googlebot_allowed: boolean | null
  google_extended_allowed: boolean | null
  anthropic_allowed: boolean | null
  perplexity_allowed: boolean | null

  // llms.txt
  has_llms_txt: boolean
  llms_txt_url: string | null
  llms_txt_valid: boolean | null
  llms_txt_issues: string[]

  // ai.txt
  has_ai_txt: boolean
  ai_txt_url: string | null

  // Content optimization stats
  pages_optimized_for_ai: number
  pages_not_optimized: number
  ai_content_issues_count: number

  // Schema types beneficial for AI
  pages_with_speakable: number
  pages_with_faq_schema: number
  pages_with_howto_schema: number

  // Overall score
  ai_health_score: number
}

interface PageAIAnalysis {
  hasGoodStructure: boolean
  hasFaqSchema: boolean
  hasHowToSchema: boolean
  hasSpeakableSchema: boolean
  issues: string[]
}

export class AISearchAnalyzer {
  private supabase: SupabaseClient
  private crawlId: string
  private projectId: string
  private domain: string
  private robotsParser: RobotsParser | null

  constructor(
    supabase: SupabaseClient,
    crawlId: string,
    projectId: string,
    domain: string,
    robotsParser: RobotsParser | null
  ) {
    this.supabase = supabase
    this.crawlId = crawlId
    this.projectId = projectId
    this.domain = domain.replace(/^www\./, '')
    this.robotsParser = robotsParser
  }

  /**
   * Run the full AI search health analysis
   */
  async analyze(): Promise<AISearchHealthData> {
    logger.info(`[AI Search] Starting analysis for ${this.domain}`)

    // 1. Get AI crawler access from robots.txt
    const aiCrawlerAccess = this.getAICrawlerAccess()

    // 2. Check for llms.txt
    const llmsTxtResult = await this.checkLlmsTxt()

    // 3. Check for ai.txt
    const aiTxtResult = await this.checkAiTxt()

    // 4. Analyze crawled pages for AI optimization
    const pageStats = await this.analyzePages()

    // 5. Calculate overall score
    const aiHealthScore = this.calculateScore({
      aiCrawlerAccess,
      llmsTxtResult,
      aiTxtResult,
      pageStats,
    })

    const healthData: AISearchHealthData = {
      // AI crawler access
      chatgpt_user_allowed: aiCrawlerAccess['ChatGPT-User'] ?? null,
      oai_searchbot_allowed: aiCrawlerAccess['OAI-SearchBot'] ?? null,
      googlebot_allowed: null, // Googlebot is different from Google-Extended
      google_extended_allowed: aiCrawlerAccess['Google-Extended'] ?? null,
      anthropic_allowed: aiCrawlerAccess['anthropic-ai'] ?? null,
      perplexity_allowed: aiCrawlerAccess['PerplexityBot'] ?? null,

      // llms.txt
      has_llms_txt: llmsTxtResult.exists,
      llms_txt_url: llmsTxtResult.url,
      llms_txt_valid: llmsTxtResult.isValid,
      llms_txt_issues: llmsTxtResult.issues,

      // ai.txt
      has_ai_txt: aiTxtResult.exists,
      ai_txt_url: aiTxtResult.url,

      // Content optimization stats
      pages_optimized_for_ai: pageStats.optimizedCount,
      pages_not_optimized: pageStats.notOptimizedCount,
      ai_content_issues_count: pageStats.issuesCount,

      // Schema types
      pages_with_speakable: pageStats.speakableCount,
      pages_with_faq_schema: pageStats.faqSchemaCount,
      pages_with_howto_schema: pageStats.howToSchemaCount,

      // Score
      ai_health_score: aiHealthScore,
    }

    // Store in database
    await this.storeResults(healthData)

    logger.info(`[AI Search] Analysis complete. Score: ${aiHealthScore}`)
    return healthData
  }

  /**
   * Get AI crawler access status from robots parser
   */
  private getAICrawlerAccess(): Record<string, boolean | null> {
    if (!this.robotsParser) {
      return {
        'GPTBot': null,
        'ChatGPT-User': null,
        'Google-Extended': null,
        'anthropic-ai': null,
        'PerplexityBot': null,
        'OAI-SearchBot': null,
      }
    }

    return this.robotsParser.getAiCrawlerAccess()
  }

  /**
   * Check for llms.txt file
   */
  private async checkLlmsTxt(): Promise<{
    exists: boolean
    url: string | null
    isValid: boolean | null
    issues: string[]
    content: string | null
  }> {
    const url = `https://${this.domain}/llms.txt`
    const issues: string[] = []

    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'SemDash-Crawler/1.0' },
        signal: AbortSignal.timeout(10000),
      })

      if (!response.ok) {
        return { exists: false, url: null, isValid: null, issues: [], content: null }
      }

      const content = await response.text()

      // Validate llms.txt structure
      // Expected format based on llms.txt spec
      const lines = content.split('\n').filter(line => line.trim())

      if (lines.length === 0) {
        issues.push('llms.txt is empty')
        return { exists: true, url, isValid: false, issues, content }
      }

      // Check for required sections
      const hasTitle = lines.some(l => l.startsWith('#') || l.startsWith('Title:'))
      const hasUrl = lines.some(l => l.startsWith('URL:') || l.includes('http'))

      if (!hasTitle && !hasUrl) {
        issues.push('llms.txt missing title or URL information')
      }

      // Check for common issues
      if (content.length < 50) {
        issues.push('llms.txt content is very short - consider adding more context')
      }

      const isValid = issues.length === 0

      logger.info(`[AI Search] Found llms.txt at ${url}`)
      return { exists: true, url, isValid, issues, content }
    } catch (error) {
      logger.debug(`[AI Search] No llms.txt found at ${url}`)
      return { exists: false, url: null, isValid: null, issues: [], content: null }
    }
  }

  /**
   * Check for ai.txt file
   */
  private async checkAiTxt(): Promise<{
    exists: boolean
    url: string | null
    content: string | null
  }> {
    const url = `https://${this.domain}/ai.txt`

    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'SemDash-Crawler/1.0' },
        signal: AbortSignal.timeout(10000),
      })

      if (!response.ok) {
        return { exists: false, url: null, content: null }
      }

      const content = await response.text()
      logger.info(`[AI Search] Found ai.txt at ${url}`)
      return { exists: true, url, content }
    } catch (error) {
      logger.debug(`[AI Search] No ai.txt found at ${url}`)
      return { exists: false, url: null, content: null }
    }
  }

  /**
   * Analyze crawled pages for AI optimization
   */
  private async analyzePages(): Promise<{
    optimizedCount: number
    notOptimizedCount: number
    issuesCount: number
    faqSchemaCount: number
    howToSchemaCount: number
    speakableCount: number
  }> {
    // Get all crawled pages for this crawl
    const { data: pages, error } = await this.supabase
      .from('crawled_pages')
      .select('id, schema_types, h1_count, h2_count, word_count, title, meta_description')
      .eq('crawl_id', this.crawlId)
      .eq('is_indexable', true)

    if (error) {
      logger.error('[AI Search] Failed to fetch pages:', error)
      return {
        optimizedCount: 0,
        notOptimizedCount: 0,
        issuesCount: 0,
        faqSchemaCount: 0,
        howToSchemaCount: 0,
        speakableCount: 0,
      }
    }

    let optimizedCount = 0
    let notOptimizedCount = 0
    let issuesCount = 0
    let faqSchemaCount = 0
    let howToSchemaCount = 0
    let speakableCount = 0

    for (const page of pages || []) {
      const analysis = this.analyzePageForAI(page)

      if (analysis.hasFaqSchema) faqSchemaCount++
      if (analysis.hasHowToSchema) howToSchemaCount++
      if (analysis.hasSpeakableSchema) speakableCount++

      if (analysis.hasGoodStructure) {
        optimizedCount++
      } else {
        notOptimizedCount++
      }

      issuesCount += analysis.issues.length
    }

    return {
      optimizedCount,
      notOptimizedCount,
      issuesCount,
      faqSchemaCount,
      howToSchemaCount,
      speakableCount,
    }
  }

  /**
   * Analyze a single page for AI optimization
   */
  private analyzePageForAI(page: {
    schema_types?: string[]
    h1_count?: number
    h2_count?: number
    word_count?: number
    title?: string
    meta_description?: string
  }): PageAIAnalysis {
    const issues: string[] = []
    const schemaTypes = page.schema_types || []

    // Check for AI-friendly schema types
    const hasFaqSchema = schemaTypes.some(s =>
      s.toLowerCase().includes('faq') || s === 'FAQPage'
    )
    const hasHowToSchema = schemaTypes.some(s =>
      s.toLowerCase().includes('howto') || s === 'HowTo'
    )
    const hasSpeakableSchema = schemaTypes.some(s =>
      s.toLowerCase().includes('speakable')
    )

    // Check content structure
    const hasGoodHeadingStructure = (page.h1_count || 0) === 1 && (page.h2_count || 0) >= 2
    const hasAdequateContent = (page.word_count || 0) >= 300
    const hasTitle = !!page.title && page.title.length >= 20
    const hasMetaDescription = !!page.meta_description && page.meta_description.length >= 50

    // Determine if page is optimized for AI
    const hasGoodStructure = hasGoodHeadingStructure && hasAdequateContent && hasTitle

    // Track issues
    if (!hasGoodHeadingStructure) {
      issues.push('Poor heading structure for AI comprehension')
    }
    if (!hasAdequateContent) {
      issues.push('Content may be too short for AI to extract value')
    }
    if (!hasTitle) {
      issues.push('Missing or short title')
    }
    if (!hasMetaDescription) {
      issues.push('Missing or short meta description')
    }

    return {
      hasGoodStructure,
      hasFaqSchema,
      hasHowToSchema,
      hasSpeakableSchema,
      issues,
    }
  }

  /**
   * Calculate overall AI health score
   */
  private calculateScore(data: {
    aiCrawlerAccess: Record<string, boolean | null>
    llmsTxtResult: { exists: boolean; isValid: boolean | null }
    aiTxtResult: { exists: boolean }
    pageStats: {
      optimizedCount: number
      notOptimizedCount: number
      faqSchemaCount: number
      howToSchemaCount: number
      speakableCount: number
    }
  }): number {
    let score = 100

    // AI Crawler Access (30 points max)
    // Blocking major AI crawlers reduces score
    const crawlerPenalties: Record<string, number> = {
      'GPTBot': 10,
      'ChatGPT-User': 5,
      'Google-Extended': 10,
      'anthropic-ai': 5,
      'PerplexityBot': 5,
    }

    for (const [crawler, penalty] of Object.entries(crawlerPenalties)) {
      if (data.aiCrawlerAccess[crawler] === false) {
        score -= penalty
      }
    }

    // llms.txt presence (15 points)
    if (!data.llmsTxtResult.exists) {
      score -= 10 // Not having llms.txt is a missed opportunity
    } else if (data.llmsTxtResult.isValid === false) {
      score -= 5 // Invalid llms.txt
    }

    // ai.txt presence (5 points)
    if (!data.aiTxtResult.exists) {
      score -= 5
    }

    // Content optimization (30 points max)
    const totalPages = data.pageStats.optimizedCount + data.pageStats.notOptimizedCount
    if (totalPages > 0) {
      const optimizationRatio = data.pageStats.optimizedCount / totalPages
      if (optimizationRatio < 0.3) {
        score -= 20
      } else if (optimizationRatio < 0.5) {
        score -= 15
      } else if (optimizationRatio < 0.7) {
        score -= 10
      } else if (optimizationRatio < 0.9) {
        score -= 5
      }
    }

    // AI-friendly schema bonus (20 points max)
    if (data.pageStats.faqSchemaCount === 0) {
      score -= 10 // No FAQ schema anywhere
    }
    if (data.pageStats.howToSchemaCount === 0 && data.pageStats.faqSchemaCount === 0) {
      score -= 5 // No instructional schema at all
    }

    return Math.max(0, Math.min(100, score))
  }

  /**
   * Store results in database
   */
  private async storeResults(data: AISearchHealthData): Promise<void> {
    // Get previous score for comparison
    const { data: previousCrawl } = await this.supabase
      .from('ai_search_health')
      .select('ai_health_score')
      .eq('project_id', this.projectId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    const { error } = await this.supabase
      .from('ai_search_health')
      .upsert({
        crawl_id: this.crawlId,
        project_id: this.projectId,
        ai_health_score: data.ai_health_score,
        previous_ai_score: previousCrawl?.ai_health_score ?? null,
        chatgpt_user_allowed: data.chatgpt_user_allowed,
        oai_searchbot_allowed: data.oai_searchbot_allowed,
        googlebot_allowed: data.googlebot_allowed,
        google_extended_allowed: data.google_extended_allowed,
        anthropic_allowed: data.anthropic_allowed,
        perplexity_allowed: data.perplexity_allowed,
        has_llms_txt: data.has_llms_txt,
        llms_txt_url: data.llms_txt_url,
        llms_txt_valid: data.llms_txt_valid,
        llms_txt_issues: data.llms_txt_issues,
        has_ai_txt: data.has_ai_txt,
        ai_txt_url: data.ai_txt_url,
        pages_optimized_for_ai: data.pages_optimized_for_ai,
        pages_not_optimized: data.pages_not_optimized,
        ai_content_issues_count: data.ai_content_issues_count,
        pages_with_speakable: data.pages_with_speakable,
        pages_with_faq_schema: data.pages_with_faq_schema,
        pages_with_howto_schema: data.pages_with_howto_schema,
      }, {
        onConflict: 'crawl_id',
      })

    if (error) {
      logger.error('[AI Search] Failed to store results:', error)
    }
  }
}
