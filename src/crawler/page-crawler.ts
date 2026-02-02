/**
 * Page Crawler
 *
 * Handles individual page crawling:
 * - Fetches page using Playwright
 * - Extracts SEO data using Cheerio
 * - Measures Core Web Vitals
 */

import { BrowserContext, Page, Response } from 'playwright'
import * as cheerio from 'cheerio'
import { createHash } from 'crypto'
import type {
  PageData,
  ImageData,
  HreflangEntry,
  CoreWebVitals,
  OpenGraphData,
  MetaData,
} from '../types/page-data.js'

interface CrawlSettings {
  render_javascript: boolean
  user_agent: string
}

export class PageCrawler {
  private context: BrowserContext
  private settings: CrawlSettings
  private timeout = 30000
  private maxRetries = 2
  private retryDelayMs = 1000

  constructor(context: BrowserContext, settings: CrawlSettings) {
    this.context = context
    this.settings = settings
  }

  /**
   * Crawl a single page with retry logic for transient failures
   */
  async crawl(url: string): Promise<PageData> {
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.crawlAttempt(url)
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))

        // Don't retry on non-transient errors
        if (!this.isRetryableError(lastError)) {
          break
        }

        // Wait before retrying (exponential backoff)
        if (attempt < this.maxRetries) {
          const delay = this.retryDelayMs * Math.pow(2, attempt)
          await this.sleep(delay)
        }
      }
    }

    // All retries exhausted, return error result
    return this.createErrorResult(url, 0, lastError?.message || 'Unknown error')
  }

  /**
   * Check if an error is retryable (transient)
   */
  private isRetryableError(error: Error): boolean {
    const message = error.message.toLowerCase()

    // Retryable network errors
    const retryablePatterns = [
      'net::err_connection_reset',
      'net::err_connection_timed_out',
      'net::err_network_changed',
      'net::err_internet_disconnected',
      'net::err_socket_not_connected',
      'net::err_connection_closed',
      'net::err_empty_response',
      'timeout',
      'econnreset',
      'econnrefused',
      'etimedout',
      'epipe',
      'socket hang up',
      'aborted',
    ]

    return retryablePatterns.some((pattern) => message.includes(pattern))
  }

  /**
   * Sleep utility for retry delays
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * Perform a single crawl attempt
   */
  private async crawlAttempt(url: string): Promise<PageData> {
    const page = await this.context.newPage()
    const startTime = Date.now()
    let response: Response | null = null
    const redirectChain: Array<{ url: string; statusCode: number }> = []

    try {
      // Track redirects
      page.on('response', (res) => {
        if (res.request().isNavigationRequest() && res.status() >= 300 && res.status() < 400) {
          redirectChain.push({ url: res.url(), statusCode: res.status() })
        }
      })

      // Navigate to URL
      response = await page.goto(url, {
        waitUntil: this.settings.render_javascript ? 'networkidle' : 'domcontentloaded',
        timeout: this.timeout,
      })

      const responseTime = Date.now() - startTime

      if (!response) {
        return this.createErrorResult(url, 0, 'No response received')
      }

      const statusCode = response.status()
      const contentType = response.headers()['content-type'] || ''
      const finalUrl = page.url()

      // Skip non-HTML content
      if (!contentType.includes('text/html')) {
        return {
          url: finalUrl,
          statusCode,
          contentType,
          responseTime,
          isIndexable: false,
          indexabilityReason: 'Not HTML content',
        }
      }

      // Get page content
      const html = await page.content()
      const pageSize = Buffer.byteLength(html, 'utf8')

      // Parse with Cheerio
      const $ = cheerio.load(html)

      // Extract all SEO data
      const data = this.extractPageData($, finalUrl, {
        statusCode,
        contentType,
        responseTime,
        pageSize,
        redirectChain: redirectChain.length > 0 ? redirectChain : undefined,
        redirectUrl: redirectChain.length > 0 ? finalUrl : undefined,
      }, html)

      // Measure Core Web Vitals (if JS rendering enabled)
      if (this.settings.render_javascript) {
        const cwv = await this.measureCoreWebVitals(page)
        data.cwv = cwv
        data.coreWebVitals = cwv
      }

      return data
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'

      if (errorMessage.includes('net::ERR_NAME_NOT_RESOLVED')) {
        return this.createErrorResult(url, 0, 'DNS resolution failed')
      }
      if (errorMessage.includes('net::ERR_CONNECTION_REFUSED')) {
        return this.createErrorResult(url, 0, 'Connection refused')
      }
      if (errorMessage.includes('Timeout')) {
        return this.createErrorResult(url, 0, 'Request timeout')
      }

      return this.createErrorResult(url, response?.status() || 0, errorMessage)
    } finally {
      await page.close()
    }
  }

  /**
   * Create error result
   */
  private createErrorResult(url: string, statusCode: number, reason: string): PageData {
    return {
      url,
      statusCode,
      isIndexable: false,
      indexabilityReason: reason,
    }
  }

  /**
   * Extract all SEO data from page
   */
  private extractPageData(
    $: cheerio.CheerioAPI,
    url: string,
    baseData: {
      statusCode: number
      contentType?: string
      responseTime?: number
      pageSize?: number
      redirectChain?: Array<{ url: string; statusCode: number }>
      redirectUrl?: string
    },
    html: string
  ): PageData {
    // Title
    const title = $('title').first().text().trim() || undefined

    // Meta description
    const metaDescription =
      $('meta[name="description"]').attr('content')?.trim() || undefined

    // Robots meta
    const robotsMeta =
      $('meta[name="robots"]').attr('content') ||
      $('meta[name="googlebot"]').attr('content') ||
      undefined

    // Meta object for analysis
    const meta: MetaData = {
      description: metaDescription,
      robots: robotsMeta,
    }

    // Canonical URL
    const canonicalUrl = $('link[rel="canonical"]').attr('href') || undefined
    const isSelfCanonical = canonicalUrl
      ? this.normalizeUrl(canonicalUrl, url) === this.normalizeUrl(url, url)
      : undefined

    // Headings
    const h1Tags: string[] = []
    $('h1').each((_, el) => {
      const text = $(el).text().trim()
      if (text) h1Tags.push(text)
    })

    const h2Tags: string[] = []
    $('h2').each((_, el) => {
      const text = $(el).text().trim()
      if (text) h2Tags.push(text)
    })

    // Indexability
    const { isIndexable, indexabilityReason } = this.checkIndexability(
      baseData.statusCode,
      robotsMeta
    )

    // Links
    const links = this.extractLinks($, url)

    // Images
    const imageData = this.extractImages($)

    // Word count (from plain text) and body text extraction (as Markdown)
    const plainText = this.extractBodyText($)
    const wordCount = plainText ? plainText.split(/\s+/).length : 0
    const bodyText = this.extractBodyTextAsMarkdown($)

    // Viewport
    const viewportMeta = $('meta[name="viewport"]')
    const hasViewport = viewportMeta.length > 0
    const viewportContent = viewportMeta.attr('content') || undefined

    // Language
    const htmlLang = $('html').attr('lang') || undefined

    // Schema.org
    const schemaData = this.extractSchemaData($)
    const schemaTypes = schemaData.types

    // Open Graph
    const ogData: OpenGraphData = {
      title: $('meta[property="og:title"]').attr('content') || undefined,
      description: $('meta[property="og:description"]').attr('content') || undefined,
      image: $('meta[property="og:image"]').attr('content') || undefined,
    }

    // Twitter Card
    const twitterCardType = $('meta[name="twitter:card"]').attr('content') || undefined

    // Hreflang
    const hreflangTags = this.extractHreflang($, url)
    const hreflangValidation = hreflangTags.length > 0
      ? this.validateHreflangTags(hreflangTags, url)
      : undefined

    // Mixed content detection (basic)
    const hasMixedContent = url.startsWith('https://') && this.detectMixedContent($)

    // Content hash for duplicate detection
    const contentHash = createHash('sha256')
      .update($('body').text().replace(/\s+/g, ' ').trim())
      .digest('hex')

    // Mobile friendliness (basic check)
    const isMobileFriendly = hasViewport && !this.hasSmallTouchTargets($)

    // Content quality analysis
    const textToHtmlRatio = this.calculateTextToHtmlRatio($, html)
    const topKeywords = this.analyzeKeywords($)
    const readingAnalysis = this.analyzeReadingLevel($)
    const headingHierarchy = this.extractHeadingHierarchy($)

    // Pagination detection
    const relPrev = $('link[rel="prev"]').attr('href') || undefined
    const relNext = $('link[rel="next"]').attr('href') || undefined
    const paginationInfo = this.detectPagination(url, relPrev, relNext)

    // URL parameter analysis
    const urlAnalysis = this.analyzeUrlParameters(url)

    return {
      // Required
      url,
      statusCode: baseData.statusCode,

      // Response data
      contentType: baseData.contentType,
      responseTime: baseData.responseTime,
      pageSize: baseData.pageSize,

      // Redirects
      redirectChain: baseData.redirectChain,
      redirectUrl: baseData.redirectUrl,

      // Title
      title,

      // Meta - both forms
      meta,
      metaDescription,
      robotsMeta,

      // Canonical - both names
      canonical: canonicalUrl,
      canonicalUrl,
      isSelfCanonical,

      // Headings - both names
      h1: h1Tags,
      h2: h2Tags,
      h1Tags,
      h2Tags,

      // Indexability
      isIndexable,
      indexabilityReason,

      // Links
      links,

      // Images - both forms
      images: imageData.details,
      imageStats: imageData,
      imageDetails: imageData.details,

      // Content
      wordCount,
      contentHash,
      bodyText,
      textToHtmlRatio,
      topKeywords,
      readingLevel: readingAnalysis.level,
      readingGradeLevel: readingAnalysis.gradeLevel,
      headingHierarchy,

      // Mobile (legacy fields)
      hasViewport,
      viewportContent,
      isMobileFriendly,

      // Mobile (extended analysis)
      mobile: this.extractMobileData($, viewportContent, html),

      // International - both names
      lang: htmlLang,
      htmlLang,
      hreflangs: hreflangTags.length > 0 ? hreflangTags : undefined,
      hreflangTags: hreflangTags.length > 0 ? hreflangTags : undefined,
      hreflangValidation,

      // Structured data
      schemaTypes,
      structuredData: schemaData.data,
      structuredDataErrors: schemaData.errors.length > 0 ? schemaData.errors : undefined,

      // Social - both names
      openGraph: ogData,
      ogTags: ogData,
      twitterCard: twitterCardType ? { card: twitterCardType } : undefined,
      twitterCardType,

      // Security
      hasMixedContent,

      // Pagination
      relPrev,
      relNext,
      isPaginatedPage: paginationInfo.isPaginated,
      paginationPageNumber: paginationInfo.pageNumber,

      // URL Analysis
      urlParameters: urlAnalysis.parameters,
      urlParameterCount: urlAnalysis.parameterCount,
      hasTrailingSlash: urlAnalysis.hasTrailingSlash,
      hasSortingParams: urlAnalysis.hasSortingParams,
      hasFilterParams: urlAnalysis.hasFilterParams,
      hasSessionParams: urlAnalysis.hasSessionParams,

      // E-commerce
      ecommerce: this.extractEcommerceData(schemaData.data),

      // Article/News/Blog
      article: this.extractArticleData(schemaData.data),
    }
  }

  /**
   * Extract and validate e-commerce product data from structured data
   */
  private extractEcommerceData(structuredData: Array<Record<string, unknown>>): PageData['ecommerce'] | undefined {
    if (!structuredData || structuredData.length === 0) {
      return undefined
    }

    // Find Product schema types
    const productSchemas = structuredData.filter(item => {
      const type = item['@type']
      if (Array.isArray(type)) {
        return type.includes('Product')
      }
      return type === 'Product'
    })

    if (productSchemas.length === 0) {
      return undefined
    }

    const hasProductSchema = true
    const multipleProducts = productSchemas.length > 1
    const product = productSchemas[0] as Record<string, unknown>

    // Extract product data
    const productData: NonNullable<PageData['ecommerce']>['productData'] = {
      name: this.getSchemaString(product['name']),
      description: this.getSchemaString(product['description']),
      sku: this.getSchemaString(product['sku']),
      gtin: this.getSchemaString(product['gtin'] || product['gtin13'] || product['gtin12'] || product['gtin14']),
      mpn: this.getSchemaString(product['mpn']),
      brand: this.extractBrandName(product['brand']),
      image: this.extractFirstImage(product['image']),
      condition: this.getSchemaString(product['itemCondition']),
    }

    // Extract rating info
    if (product['aggregateRating'] && typeof product['aggregateRating'] === 'object') {
      const rating = product['aggregateRating'] as Record<string, unknown>
      productData.ratingValue = this.getSchemaNumber(rating['ratingValue'])
      productData.reviewCount = this.getSchemaNumber(rating['reviewCount'] || rating['ratingCount'])
    }

    // Extract offers (price, availability)
    const offers = this.extractOffers(product['offers'])
    if (offers.length > 0) {
      productData.offers = offers
      // Use first offer for main price/availability
      const mainOffer = offers[0]
      productData.price = mainOffer?.price
      productData.currency = mainOffer?.currency
      productData.availability = mainOffer?.availability
    }

    // Validate and detect issues
    const issues: NonNullable<PageData['ecommerce']>['issues'] = {}

    // Required/recommended field checks
    if (!productData.name) {
      issues.missingProductName = true
    }
    if (!productData.description) {
      issues.missingDescription = true
    }
    if (!productData.image) {
      issues.missingImage = true
    }
    if (!productData.sku && !productData.gtin && !productData.mpn) {
      issues.missingSku = true
    }
    if (!productData.brand) {
      issues.missingBrand = true
    }

    // Price/offer checks
    if (!product['offers']) {
      issues.missingOffer = true
      issues.missingPrice = true
      issues.missingAvailability = true
    } else {
      if (!productData.price && productData.price !== 0) {
        issues.missingPrice = true
      } else if (productData.price < 0) {
        issues.invalidPrice = true
      }
      if (!productData.availability) {
        issues.missingAvailability = true
      }
      if (!productData.currency) {
        issues.missingCurrency = true
      }
    }

    // Availability status checks
    if (productData.availability) {
      const availLower = productData.availability.toLowerCase()
      if (availLower.includes('outofstock') || availLower.includes('out_of_stock')) {
        issues.outOfStock = true
      }
      if (availLower.includes('discontinued')) {
        issues.discontinuedProduct = true
      }
    }

    // Check for expired price validity
    if (offers.length > 0) {
      const now = new Date()
      for (const offer of offers) {
        if (offer.priceValidUntil) {
          try {
            const validUntil = new Date(offer.priceValidUntil)
            if (validUntil < now) {
              issues.expiredPrice = true
              break
            }
          } catch {
            // Invalid date format, ignore
          }
        }
      }
    }

    if (multipleProducts) {
      issues.multipleProducts = true
    }

    // Only return if there's product data or issues
    const hasIssues = Object.values(issues).some(v => v === true)

    return {
      hasProductSchema,
      productData,
      issues: hasIssues ? issues : undefined,
    }
  }

  /**
   * Extract and validate Article/NewsArticle/BlogPosting data from structured data
   */
  private extractArticleData(structuredData: Array<Record<string, unknown>>): PageData['article'] | undefined {
    if (!structuredData || structuredData.length === 0) {
      return undefined
    }

    // Find Article schema types (Article, NewsArticle, BlogPosting, TechArticle, ScholarlyArticle)
    const articleTypes = ['Article', 'NewsArticle', 'BlogPosting', 'TechArticle', 'ScholarlyArticle']
    const articleSchemas = structuredData.filter(item => {
      const type = item['@type']
      if (Array.isArray(type)) {
        return type.some(t => articleTypes.includes(t))
      }
      return articleTypes.includes(type as string)
    })

    if (articleSchemas.length === 0) {
      return undefined
    }

    const hasArticleSchema = true
    const articleCount = articleSchemas.length
    const article = articleSchemas[0] as Record<string, unknown>

    // Determine schema type
    const rawType = article['@type']
    const schemaType = (Array.isArray(rawType)
      ? rawType.find(t => articleTypes.includes(t))
      : rawType) as NonNullable<PageData['article']>['schemaType']

    // Extract article data
    const articleData: NonNullable<PageData['article']>['articleData'] = {
      headline: this.getSchemaString(article['headline'] || article['name']),
      description: this.getSchemaString(article['description'] || article['abstract']),
      body: this.getSchemaString(article['articleBody'] || article['text']),
      datePublished: this.getSchemaString(article['datePublished']),
      dateModified: this.getSchemaString(article['dateModified']),
      image: this.extractFirstImage(article['image']),
      wordCount: this.getSchemaNumber(article['wordCount']),
      inLanguage: this.getSchemaString(article['inLanguage']),
      mainEntityOfPage: this.getSchemaString(
        typeof article['mainEntityOfPage'] === 'object'
          ? (article['mainEntityOfPage'] as Record<string, unknown>)['@id']
          : article['mainEntityOfPage']
      ),
    }

    // Extract author
    const authorData = article['author']
    if (authorData) {
      if (typeof authorData === 'string') {
        articleData.author = authorData
      } else if (typeof authorData === 'object' && authorData !== null) {
        // Handle array of authors - use first one
        const firstAuthor = Array.isArray(authorData) ? authorData[0] : authorData
        if (typeof firstAuthor === 'object' && firstAuthor !== null) {
          const authorObj = firstAuthor as Record<string, unknown>
          articleData.author = {
            name: this.getSchemaString(authorObj['name']) || 'Unknown',
            url: this.getSchemaString(authorObj['url']),
          }
        }
      }
    }

    // Extract publisher
    const publisherData = article['publisher']
    if (publisherData) {
      if (typeof publisherData === 'string') {
        articleData.publisher = publisherData
      } else if (typeof publisherData === 'object' && publisherData !== null) {
        const pubObj = publisherData as Record<string, unknown>
        const pubName = this.getSchemaString(pubObj['name'])
        const pubLogo = pubObj['logo']
        let logoUrl: string | undefined
        if (typeof pubLogo === 'string') {
          logoUrl = pubLogo
        } else if (typeof pubLogo === 'object' && pubLogo !== null) {
          logoUrl = this.getSchemaString((pubLogo as Record<string, unknown>)['url'])
        }
        articleData.publisher = {
          name: pubName || 'Unknown',
          logo: logoUrl,
        }
      }
    }

    // Validate and detect issues
    const issues: NonNullable<PageData['article']>['issues'] = {}

    // Required field checks
    if (!articleData.headline) {
      issues.missingHeadline = true
    } else {
      // Check headline length
      if (articleData.headline.length < 30) {
        issues.shortHeadline = true
      }
      if (articleData.headline.length > 110) {
        issues.headlineTooLong = true
      }
    }

    if (!articleData.datePublished) {
      issues.missingDatePublished = true
    } else {
      // Validate date format (ISO 8601)
      const dateValid = this.isValidISO8601Date(articleData.datePublished)
      if (!dateValid) {
        issues.invalidDateFormat = true
      } else {
        // Check for future date
        const pubDate = new Date(articleData.datePublished)
        if (pubDate > new Date()) {
          issues.futureDatePublished = true
        }
        // Check for outdated content (>2 years without modification)
        const twoYearsAgo = new Date()
        twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2)
        if (pubDate < twoYearsAgo && !articleData.dateModified) {
          issues.outdatedContent = true
        }
      }
    }

    // Check dateModified format if present
    if (articleData.dateModified && !this.isValidISO8601Date(articleData.dateModified)) {
      issues.invalidDateFormat = true
    }

    // Missing dateModified
    if (articleData.datePublished && !articleData.dateModified) {
      issues.missingDateModified = true
    }

    if (!articleData.author) {
      issues.missingAuthor = true
    }

    if (!articleData.image) {
      issues.missingImage = true
    }

    if (!articleData.description) {
      issues.missingDescription = true
    }

    if (!articleData.publisher) {
      issues.missingPublisher = true
    }

    if (!articleData.body) {
      issues.missingBody = true
    }

    if (!articleData.wordCount && articleData.body) {
      issues.missingWordCount = true
    }

    if (articleCount > 1) {
      issues.multipleArticles = true
    }

    const hasIssues = Object.values(issues).some(v => v === true)

    return {
      hasArticleSchema,
      schemaType,
      articleCount,
      articleData,
      issues: hasIssues ? issues : undefined,
    }
  }

  /**
   * Validate ISO 8601 date format
   */
  private isValidISO8601Date(dateStr: string): boolean {
    if (!dateStr) return false
    // Common ISO 8601 formats:
    // YYYY-MM-DD, YYYY-MM-DDTHH:MM:SS, YYYY-MM-DDTHH:MM:SSZ, YYYY-MM-DDTHH:MM:SS+00:00
    const iso8601Regex = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/
    if (!iso8601Regex.test(dateStr)) {
      return false
    }
    // Also check if it parses to a valid date
    const date = new Date(dateStr)
    return !isNaN(date.getTime())
  }

  /**
   * Extract comprehensive mobile usability data
   */
  private extractMobileData($: cheerio.CheerioAPI, _viewportContent: string | undefined, html: string): PageData['mobile'] {
    const issues: NonNullable<PageData['mobile']>['issues'] = {}

    // ========== VIEWPORT ANALYSIS ==========
    const viewportMeta = $('meta[name="viewport"]')
    const hasViewport = viewportMeta.length > 0
    const content = viewportMeta.attr('content') || ''

    // Parse viewport attributes
    let isZoomDisabled = false
    let hasUserScalableNo = false
    let maxScale: number | undefined
    let initialScale: number | undefined
    let viewportWidth: string | undefined

    if (content) {
      const viewportParts = content.toLowerCase().split(',').map(p => p.trim())
      for (const part of viewportParts) {
        if (part.includes('user-scalable')) {
          const value = part.split('=')[1]?.trim()
          if (value === 'no' || value === '0') {
            hasUserScalableNo = true
            isZoomDisabled = true
          }
        }
        if (part.includes('maximum-scale')) {
          const value = parseFloat(part.split('=')[1]?.trim() || '')
          if (!isNaN(value)) {
            maxScale = value
            if (value <= 1) {
              isZoomDisabled = true
            }
          }
        }
        if (part.includes('initial-scale')) {
          const value = parseFloat(part.split('=')[1]?.trim() || '')
          if (!isNaN(value)) {
            initialScale = value
          }
        }
        if (part.includes('width=')) {
          viewportWidth = part.split('=')[1]?.trim()
        }
      }
    }

    const viewportAnalysis = {
      hasViewport,
      content: content || undefined,
      isZoomDisabled,
      hasUserScalableNo,
      maxScale,
      initialScale,
      width: viewportWidth,
    }

    if (isZoomDisabled) {
      issues.zoomDisabled = true
    }
    if (initialScale && initialScale !== 1) {
      issues.initialScaleNotOne = true
    }

    // ========== PWA/APP FEATURES ==========
    const hasAppleTouchIcon = $('link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]').length > 0
    const hasWebAppManifest = $('link[rel="manifest"]').length > 0
    const themeColorMeta = $('meta[name="theme-color"]').attr('content')
    const hasThemeColor = themeColorMeta || undefined

    if (!hasAppleTouchIcon) {
      issues.noAppleTouchIcon = true
    }
    if (!hasWebAppManifest) {
      issues.noWebAppManifest = true
    }
    if (!hasThemeColor) {
      issues.noThemeColor = true
    }

    // ========== RESPONSIVE IMAGES ==========
    const allImages = $('img')
    let totalImageCount = 0
    let nonResponsiveImageCount = 0

    allImages.each((_, img) => {
      const $img = $(img)
      // Skip tiny icons/tracking pixels
      const width = parseInt($img.attr('width') || '0', 10)
      const height = parseInt($img.attr('height') || '0', 10)
      if (width > 50 || height > 50 || (!width && !height)) {
        totalImageCount++
        const hasSrcset = !!$img.attr('srcset')
        const inPicture = $img.parents('picture').length > 0

        if (!hasSrcset && !inPicture) {
          nonResponsiveImageCount++
        }
      }
    })

    const hasResponsiveImages = nonResponsiveImageCount === 0 || totalImageCount === 0
    if (!hasResponsiveImages && nonResponsiveImageCount > 0) {
      issues.imagesNotResponsive = true
    }

    // ========== TABLES ==========
    const tables = $('table')
    const tableCount = tables.length
    let hasResponsiveTables = true

    if (tableCount > 0) {
      // Check if tables have responsive wrappers or CSS classes
      tables.each((_, table) => {
        const $table = $(table)
        const parentClasses = $table.parent().attr('class') || ''
        const tableClasses = $table.attr('class') || ''
        const hasOverflowWrapper = parentClasses.includes('overflow') || parentClasses.includes('responsive') || parentClasses.includes('scroll')
        const isResponsiveTable = tableClasses.includes('responsive') || $table.attr('data-responsive')

        if (!hasOverflowWrapper && !isResponsiveTable) {
          hasResponsiveTables = false
        }
      })
    }

    if (tableCount > 0 && !hasResponsiveTables) {
      issues.tablesWithoutResponsive = true
    }

    // ========== FIXED/STICKY ELEMENTS ==========
    const fixedElements: string[] = []
    $('[style*="position: fixed"], [style*="position:fixed"], [style*="position: sticky"], [style*="position:sticky"]').each((_, el) => {
      const $el = $(el)
      const tagName = $el.prop('tagName')?.toLowerCase() || 'unknown'
      const id = $el.attr('id')
      const className = $el.attr('class')?.split(' ')[0]
      fixedElements.push(`${tagName}${id ? '#' + id : className ? '.' + className : ''}`)
    })

    // Also check common fixed element patterns
    const commonFixedSelectors = ['header.fixed', 'nav.fixed', '.sticky-header', '.fixed-header', '.fixed-nav', '#cookie-banner', '.cookie-notice']
    commonFixedSelectors.forEach(selector => {
      if ($(selector).length > 0) {
        fixedElements.push(selector)
      }
    })

    const hasLargeFixedElements = fixedElements.length > 2 // More than 2 fixed elements is concerning
    if (hasLargeFixedElements) {
      issues.fixedElementsBlocking = true
    }

    // ========== CLICK-TO-CALL ==========
    const telLinks = $('a[href^="tel:"]')
    const hasTelLinks = telLinks.length > 0

    // Simple phone number detection in text
    const bodyText = $('body').text()
    const phoneRegex = /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g
    const phoneMatches = bodyText.match(phoneRegex)
    const phoneNumbersFound = phoneMatches?.length || 0

    if (phoneNumbersFound > 0 && !hasTelLinks) {
      issues.noTelLinks = true
    }

    // ========== LCP LAZY LOADING ==========
    // Check if large images in header/hero area are lazy loaded
    let lcpElementIsLazyLoaded = false
    const heroSelectors = ['header img', '.hero img', '[class*="hero"] img', 'main > img:first-child', 'main > div:first-child img']
    heroSelectors.forEach(selector => {
      const $img = $(selector).first()
      if ($img.length > 0 && $img.attr('loading') === 'lazy') {
        lcpElementIsLazyLoaded = true
      }
    })

    if (lcpElementIsLazyLoaded) {
      issues.lcpLazyLoaded = true
    }

    // ========== CSS MEDIA QUERIES ==========
    // Check inline styles and style tags for media queries
    let hasMediaQueries = false

    // Check style tags
    $('style').each((_, style) => {
      const styleContent = $(style).html() || ''
      if (styleContent.includes('@media')) {
        hasMediaQueries = true
      }
    })

    // Check for responsive framework classes (Bootstrap, Tailwind, etc.)
    const responsiveIndicators = ['col-sm', 'col-md', 'col-lg', 'md:', 'sm:', 'lg:', 'hidden-xs', 'd-none', 'd-sm-', '@screen']
    const htmlContent = html.substring(0, 100000) // Limit check to prevent performance issues
    responsiveIndicators.forEach(indicator => {
      if (htmlContent.includes(indicator)) {
        hasMediaQueries = true
      }
    })

    // Check linked stylesheets hint (we can't read external CSS, but we can check if responsive frameworks are likely used)
    $('link[rel="stylesheet"]').each((_, link) => {
      const href = $(link).attr('href') || ''
      if (href.includes('bootstrap') || href.includes('tailwind') || href.includes('foundation') || href.includes('bulma')) {
        hasMediaQueries = true
      }
    })

    if (!hasMediaQueries) {
      issues.noMediaQueries = true
    }

    // ========== SMALL TEXT/TAP TARGETS (basic heuristic) ==========
    const smallTextElements: string[] = []
    // Look for inline styles with very small font sizes
    $('[style*="font-size"]').each((_, el) => {
      const style = $(el).attr('style') || ''
      const fontSizeMatch = style.match(/font-size:\s*(\d+)(px|pt)/i)
      if (fontSizeMatch && fontSizeMatch[1] && fontSizeMatch[2]) {
        const size = parseInt(fontSizeMatch[1], 10)
        const unit = fontSizeMatch[2].toLowerCase()
        const pxSize = unit === 'pt' ? size * 1.333 : size
        if (pxSize < 12) {
          const tagName = $(el).prop('tagName')?.toLowerCase() || 'element'
          smallTextElements.push(`${tagName} (${size}${unit})`)
        }
      }
    })

    const minimumFontSize = smallTextElements.length > 0 ? 10 : undefined
    if (smallTextElements.length > 0) {
      issues.fontTooSmall = true
    }

    const hasIssues = Object.values(issues).some(v => v === true)

    return {
      viewportAnalysis,
      hasResponsiveImages,
      nonResponsiveImageCount: nonResponsiveImageCount > 0 ? nonResponsiveImageCount : undefined,
      totalImageCount: totalImageCount > 0 ? totalImageCount : undefined,
      hasResponsiveTables: tableCount > 0 ? hasResponsiveTables : undefined,
      tableCount: tableCount > 0 ? tableCount : undefined,
      hasLargeFixedElements,
      fixedElements: fixedElements.length > 0 ? fixedElements : undefined,
      smallTextElements: smallTextElements.length > 0 ? smallTextElements : undefined,
      minimumFontSize,
      hasAppleTouchIcon,
      hasWebAppManifest,
      hasThemeColor,
      hasTelLinks,
      phoneNumbersFound: phoneNumbersFound > 0 ? phoneNumbersFound : undefined,
      lcpElementIsLazyLoaded,
      hasMediaQueries,
      issues: hasIssues ? issues : undefined,
    }
  }

  /**
   * Extract brand name from various formats
   */
  private extractBrandName(brand: unknown): string | undefined {
    if (!brand) return undefined
    if (typeof brand === 'string') return brand
    if (typeof brand === 'object' && brand !== null) {
      const brandObj = brand as Record<string, unknown>
      return this.getSchemaString(brandObj['name'])
    }
    return undefined
  }

  /**
   * Extract first image from image field
   */
  private extractFirstImage(image: unknown): string | undefined {
    if (!image) return undefined
    if (typeof image === 'string') return image
    if (Array.isArray(image) && image.length > 0) {
      return this.extractFirstImage(image[0])
    }
    if (typeof image === 'object' && image !== null) {
      const imgObj = image as Record<string, unknown>
      return this.getSchemaString(imgObj['url'] || imgObj['@id'])
    }
    return undefined
  }

  /**
   * Extract offers from schema
   */
  private extractOffers(offers: unknown): Array<{
    price?: number
    currency?: string
    availability?: string
    priceValidUntil?: string
  }> {
    if (!offers) return []

    const result: Array<{
      price?: number
      currency?: string
      availability?: string
      priceValidUntil?: string
    }> = []

    const processOffer = (offer: unknown) => {
      if (typeof offer !== 'object' || offer === null) return
      const o = offer as Record<string, unknown>

      // Handle AggregateOffer
      if (o['@type'] === 'AggregateOffer') {
        const lowPrice = this.getSchemaNumber(o['lowPrice'])
        const highPrice = this.getSchemaNumber(o['highPrice'])
        result.push({
          price: lowPrice ?? highPrice,
          currency: this.getSchemaString(o['priceCurrency']),
          availability: this.normalizeAvailability(o['availability']),
          priceValidUntil: this.getSchemaString(o['priceValidUntil']),
        })
        return
      }

      result.push({
        price: this.getSchemaNumber(o['price']),
        currency: this.getSchemaString(o['priceCurrency']),
        availability: this.normalizeAvailability(o['availability']),
        priceValidUntil: this.getSchemaString(o['priceValidUntil']),
      })
    }

    if (Array.isArray(offers)) {
      offers.forEach(processOffer)
    } else {
      processOffer(offers)
    }

    return result
  }

  /**
   * Normalize availability URL to short form
   */
  private normalizeAvailability(availability: unknown): string | undefined {
    const avail = this.getSchemaString(availability)
    if (!avail) return undefined

    // Extract just the status part from full URLs
    const match = avail.match(/schema\.org\/(.*?)$/i)
    if (match && match[1]) {
      return match[1]
    }
    return avail
  }

  /**
   * Safely get string value from schema property
   */
  private getSchemaString(value: unknown): string | undefined {
    if (typeof value === 'string') return value
    if (typeof value === 'number') return String(value)
    return undefined
  }

  /**
   * Safely get number value from schema property
   */
  private getSchemaNumber(value: unknown): number | undefined {
    if (typeof value === 'number') return value
    if (typeof value === 'string') {
      const parsed = parseFloat(value.replace(/[^0-9.-]/g, ''))
      return isNaN(parsed) ? undefined : parsed
    }
    return undefined
  }

  /**
   * Normalize URL for comparison
   */
  private normalizeUrl(url: string, baseUrl: string): string {
    try {
      const parsed = new URL(url, baseUrl)
      parsed.hash = ''
      let normalized = parsed.toString()
      if (normalized.endsWith('/') && parsed.pathname !== '/') {
        normalized = normalized.slice(0, -1)
      }
      return normalized
    } catch {
      return url
    }
  }

  /**
   * Check if page is indexable
   */
  private checkIndexability(
    statusCode: number,
    robotsMeta?: string
  ): { isIndexable: boolean; indexabilityReason?: string } {
    if (statusCode >= 400) {
      return { isIndexable: false, indexabilityReason: `HTTP ${statusCode} error` }
    }

    if (statusCode >= 300 && statusCode < 400) {
      return { isIndexable: false, indexabilityReason: 'Redirect' }
    }

    if (robotsMeta) {
      const directives = robotsMeta.toLowerCase()
      if (directives.includes('noindex')) {
        return { isIndexable: false, indexabilityReason: 'noindex directive' }
      }
    }

    return { isIndexable: true }
  }

  /**
   * Extract links from page
   */
  private extractLinks(
    $: cheerio.CheerioAPI,
    baseUrl: string
  ): { internal: string[]; external: string[] } {
    const internal: string[] = []
    const external: string[] = []
    const baseDomain = new URL(baseUrl).hostname.replace(/^www\./, '')

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href')
      if (!href) return

      try {
        const absoluteUrl = new URL(href, baseUrl).toString()
        const linkDomain = new URL(absoluteUrl).hostname.replace(/^www\./, '')

        // Skip non-HTTP URLs
        if (!absoluteUrl.startsWith('http')) return

        if (linkDomain === baseDomain || linkDomain.endsWith(`.${baseDomain}`)) {
          if (!internal.includes(absoluteUrl)) {
            internal.push(absoluteUrl)
          }
        } else {
          if (!external.includes(absoluteUrl)) {
            external.push(absoluteUrl)
          }
        }
      } catch {
        // Invalid URL, skip
      }
    })

    return { internal, external }
  }

  /**
   * Extract image data
   */
  private extractImages($: cheerio.CheerioAPI): {
    total: number
    withoutAlt: number
    withEmptyAlt: number
    details: ImageData[]
  } {
    let total = 0
    let withoutAlt = 0
    let withEmptyAlt = 0
    const details: ImageData[] = []

    $('img').each((_, el) => {
      total++
      const src = $(el).attr('src')
      const alt = $(el).attr('alt')
      const width = parseInt($(el).attr('width') || '', 10)
      const height = parseInt($(el).attr('height') || '', 10)

      if (alt === undefined) {
        withoutAlt++
      } else if (alt.trim() === '') {
        withEmptyAlt++
      }

      if (src) {
        details.push({
          src,
          alt: alt ?? undefined,
          width: isNaN(width) ? undefined : width,
          height: isNaN(height) ? undefined : height,
        })
      }
    })

    return { total, withoutAlt, withEmptyAlt, details }
  }

  /**
   * Extract clean body text (removing scripts, styles, etc.)
   */
  private extractBodyText($: cheerio.CheerioAPI): string {
    return $('body')
      .clone()
      .find('script, style, noscript, nav, footer, header, aside')
      .remove()
      .end()
      .text()
      .replace(/\s+/g, ' ')
      .trim()
  }

  /**
   * Extract body content as Markdown format
   * Converts headings, paragraphs, lists, links, and emphasis to Markdown
   * Filters out cookie banners, consent popups, and other boilerplate
   */
  private extractBodyTextAsMarkdown($: cheerio.CheerioAPI): string {
    const $body = $('body').clone()

    // Remove unwanted elements
    $body.find('script, style, noscript, nav, footer, header, aside').remove()

    // Remove cookie consent banners and privacy popups by common selectors
    $body.find([
      // Cookie consent common IDs and classes
      '[id*="cookie"]',
      '[id*="consent"]',
      '[id*="gdpr"]',
      '[id*="privacy-banner"]',
      '[class*="cookie"]',
      '[class*="consent"]',
      '[class*="gdpr"]',
      '[class*="privacy-banner"]',
      '[class*="cookieyes"]',
      // Common cookie consent plugins
      '.cc-window',
      '.cc-banner',
      '#CybotCookiebotDialog',
      '#onetrust-consent-sdk',
      '.onetrust-pc-dark-filter',
      '#truste-consent-track',
      '.evidon-banner',
      '#cookiescript_injected',
      '.cookie-law-info-bar',
      '#cookie-law-info-bar',
      '.cli-modal',
      // Generic popup/modal patterns often used for consent
      '[aria-label*="cookie"]',
      '[aria-label*="consent"]',
      '[aria-label*="privacy"]',
    ].join(', ')).remove()

    // Patterns to skip in text content (cookie/consent boilerplate)
    const boilerplatePatterns = [
      // Privacy/cookie intro phrases
      /^we (use|value) (cookies|your privacy)/i,
      /we use cookies to (enhance|help|improve)/i,
      /cookie(s)? (policy|preferences|settings|consent)/i,
      /accept (all )?(cookies|consent)/i,
      /by clicking .*(accept|agree|consent)/i,
      /consent (to|for) (our|the) use of cookies/i,
      /manage (your )?(cookie|consent|privacy)/i,
      // Cookie category headers and descriptions
      /^necessary cookies/i,
      /^functional cookies/i,
      /^analytical cookies/i,
      /^performance cookies/i,
      /^advertisement cookies/i,
      /cookies are (used|required|stored)/i,
      /no cookies to display/i,
      /cookies do not store any personally/i,
      // Cookie details (CookieYes format)
      /this cookie is set by/i,
      /cookieyes sets this cookie/i,
      /google analytics sets this cookie/i,
      /^cookie[a-z_-]*$/i,  // Just "Cookie" or "Cookieelementor" etc.
      /^duration/i,  // "Duration1 year" etc.
      /^description.*cookie/i,
      /sets this cookie to/i,
      // Cookie consent buttons/actions
      /show more/i,
      /accept all/i,
      /reject all/i,
      /customize/i,
      /save preferences/i,
      // General consent language
      /stored on your browser/i,
      /enabling the basic functionalities/i,
      /collect or store any personal/i,
      /third-party features/i,
      /remember users' consent/i,
      /calculate visitor, session/i,
      /store and count page views/i,
      /track site usage/i,
      /recognise unique visitors/i,
      /analyse the effectiveness/i,
      /customised advertisements/i,
      /key performance indexes/i,
    ]

    const isBoilerplate = (text: string): boolean => {
      // Skip very short content that's likely UI elements
      if (text.length < 3) return true
      return boilerplatePatterns.some(pattern => pattern.test(text))
    }

    const lines: string[] = []

    // Process content elements in document order
    $body.find('h1, h2, h3, h4, h5, h6, p, li, blockquote').each((_, el) => {
      const $el = $(el)
      const tagName = el.tagName.toLowerCase()
      let text = $el.clone().children('h1, h2, h3, h4, h5, h6, p, li, blockquote').remove().end().text().trim()

      if (!text) return

      // Clean up whitespace
      text = text.replace(/\s+/g, ' ')

      // Skip boilerplate content
      if (isBoilerplate(text)) return

      switch (tagName) {
        case 'h1':
          lines.push(`# ${text}`)
          lines.push('')
          break
        case 'h2':
          lines.push(`## ${text}`)
          lines.push('')
          break
        case 'h3':
          lines.push(`### ${text}`)
          lines.push('')
          break
        case 'h4':
          lines.push(`#### ${text}`)
          lines.push('')
          break
        case 'h5':
          lines.push(`##### ${text}`)
          lines.push('')
          break
        case 'h6':
          lines.push(`###### ${text}`)
          lines.push('')
          break
        case 'p':
          lines.push(text)
          lines.push('')
          break
        case 'li':
          // Check if it's in an ordered list
          const parent = $el.parent()
          if (parent.is('ol')) {
            const index = $el.index() + 1
            lines.push(`${index}. ${text}`)
          } else {
            lines.push(`- ${text}`)
          }
          break
        case 'blockquote':
          lines.push(`> ${text}`)
          lines.push('')
          break
      }
    })

    // Join and clean up multiple blank lines
    let result = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()

    // Post-process: Remove any remaining cookie/consent blocks that may have slipped through
    // This catches multi-line cookie descriptions that start with "We value your privacy"
    result = result
      // Remove cookie consent block at the start
      .replace(/^(We value your privacy[\s\S]*?)(#{1,6}\s)/m, '$2')
      // Remove any remaining cookie table-like content
      .replace(/- Cookie[a-z_-]*\n- Duration[^\n]*\n- Description[^\n]*/gi, '')
      // Clean up resulting empty list markers
      .replace(/\n-\s*\n/g, '\n')
      // Clean up multiple blank lines again
      .replace(/\n{3,}/g, '\n\n')
      .trim()

    return result
  }

  /**
   * Calculate text to HTML ratio
   */
  private calculateTextToHtmlRatio($: cheerio.CheerioAPI, html: string): number {
    const text = this.extractBodyText($)
    if (!html || html.length === 0) return 0
    return Math.round((text.length / html.length) * 100)
  }

  /**
   * Analyze keyword density and find potential keyword stuffing
   */
  private analyzeKeywords($: cheerio.CheerioAPI): Array<{ word: string; count: number; density: number }> {
    const text = this.extractBodyText($).toLowerCase()
    if (!text) return []

    // Tokenize words (3+ characters, letters only)
    const words = text.match(/\b[a-z]{3,}\b/g) || []
    const totalWords = words.length
    if (totalWords < 50) return []  // Not enough content to analyze

    // Count word frequency
    const wordCounts = new Map<string, number>()
    const stopWords = new Set([
      'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her',
      'was', 'one', 'our', 'out', 'has', 'have', 'been', 'will', 'from',
      'they', 'this', 'that', 'with', 'what', 'which', 'when', 'where',
      'your', 'more', 'about', 'would', 'there', 'their', 'than', 'into',
      'some', 'could', 'them', 'these', 'other', 'only', 'just', 'also',
      'over', 'such', 'most', 'very', 'here', 'should', 'being', 'does'
    ])

    for (const word of words) {
      if (!stopWords.has(word)) {
        wordCounts.set(word, (wordCounts.get(word) || 0) + 1)
      }
    }

    // Calculate density and return top keywords
    const keywords: Array<{ word: string; count: number; density: number }> = []
    for (const [word, count] of wordCounts.entries()) {
      if (count >= 3) {  // Only words appearing 3+ times
        const density = Math.round((count / totalWords) * 1000) / 10  // As percentage with 1 decimal
        keywords.push({ word, count, density })
      }
    }

    // Sort by density descending, take top 10
    return keywords
      .sort((a, b) => b.density - a.density)
      .slice(0, 10)
  }

  /**
   * Estimate reading level using Flesch-Kincaid approximation
   * Returns grade level and category
   */
  private analyzeReadingLevel($: cheerio.CheerioAPI): { level: 'basic' | 'intermediate' | 'advanced' | 'complex'; gradeLevel: number } {
    const text = this.extractBodyText($)
    if (!text || text.length < 100) {
      return { level: 'basic', gradeLevel: 0 }
    }

    // Count sentences (ending with . ! ?)
    const sentences = (text.match(/[.!?]+/g) || []).length || 1

    // Count words
    const words = text.split(/\s+/).length || 1

    // Estimate syllables (rough approximation)
    const syllableCount = this.countSyllables(text)

    // Flesch-Kincaid Grade Level formula
    const avgWordsPerSentence = words / sentences
    const avgSyllablesPerWord = syllableCount / words
    const gradeLevel = Math.round(0.39 * avgWordsPerSentence + 11.8 * avgSyllablesPerWord - 15.59)

    // Categorize
    let level: 'basic' | 'intermediate' | 'advanced' | 'complex'
    if (gradeLevel <= 6) {
      level = 'basic'
    } else if (gradeLevel <= 10) {
      level = 'intermediate'
    } else if (gradeLevel <= 14) {
      level = 'advanced'
    } else {
      level = 'complex'
    }

    return { level, gradeLevel: Math.max(0, gradeLevel) }
  }

  /**
   * Count syllables in text (approximation)
   */
  private countSyllables(text: string): number {
    const words = text.toLowerCase().match(/\b[a-z]+\b/g) || []
    let syllables = 0

    for (const word of words) {
      // Count vowel groups as syllables
      const matches = word.match(/[aeiouy]+/g)
      let wordSyllables = matches ? matches.length : 1

      // Adjust for silent 'e' at end
      if (word.endsWith('e') && wordSyllables > 1) {
        wordSyllables--
      }

      // Every word has at least 1 syllable
      syllables += Math.max(1, wordSyllables)
    }

    return syllables
  }

  /**
   * Extract heading hierarchy to check for proper structure
   */
  private extractHeadingHierarchy($: cheerio.CheerioAPI): string[] {
    const hierarchy: string[] = []
    $('h1, h2, h3, h4, h5, h6').each((_, el) => {
      hierarchy.push(el.tagName.toLowerCase())
    })
    return hierarchy
  }

  /**
   * Extract Schema.org data
   */
  private extractSchemaData($: cheerio.CheerioAPI): {
    types: string[]
    data: Array<Record<string, unknown>>
    errors: string[]
  } {
    const types: string[] = []
    const data: Array<Record<string, unknown>> = []
    const errors: string[] = []

    // JSON-LD
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($(el).html() || '{}')
        if (json['@type']) {
          const schemaType = Array.isArray(json['@type']) ? json['@type'] : [json['@type']]
          types.push(...schemaType)
          data.push(json)
        }
        if (json['@graph']) {
          for (const item of json['@graph']) {
            if (item['@type']) {
              const itemType = Array.isArray(item['@type']) ? item['@type'] : [item['@type']]
              types.push(...itemType)
              data.push(item)
            }
          }
        }
      } catch (e) {
        errors.push(`Invalid JSON-LD: ${e instanceof Error ? e.message : 'Parse error'}`)
      }
    })

    // Microdata
    $('[itemtype]').each((_, el) => {
      const itemtype = $(el).attr('itemtype')
      if (itemtype) {
        const typeName = itemtype.split('/').pop()
        if (typeName && !types.includes(typeName)) {
          types.push(typeName)
        }
      }
    })

    return { types: [...new Set(types)], data, errors }
  }

  /**
   * Extract hreflang tags
   */
  private extractHreflang($: cheerio.CheerioAPI, baseUrl: string): HreflangEntry[] {
    const tags: HreflangEntry[] = []

    $('link[rel="alternate"][hreflang]').each((_, el) => {
      const hreflang = $(el).attr('hreflang')
      const href = $(el).attr('href')
      if (hreflang && href) {
        try {
          const absoluteUrl = new URL(href, baseUrl).toString()
          tags.push({ lang: hreflang, url: absoluteUrl })
        } catch {
          // Invalid URL, skip
        }
      }
    })

    return tags
  }

  /**
   * Validate hreflang tags for common issues
   */
  private validateHreflangTags(hreflangs: HreflangEntry[], currentUrl: string): {
    invalidLangCodes: Array<{ lang: string; url: string }>
    invalidRegionCodes: Array<{ lang: string; url: string }>
    hasSelfReference: boolean
    duplicateEntries: Array<{ lang: string; urls: string[] }>
  } {
    // Valid ISO 639-1 language codes (subset of most common)
    const validLangCodes = new Set([
      'aa', 'ab', 'af', 'am', 'ar', 'as', 'az', 'ba', 'be', 'bg', 'bn', 'bo', 'br', 'bs',
      'ca', 'ce', 'co', 'cs', 'cy', 'da', 'de', 'el', 'en', 'eo', 'es', 'et', 'eu', 'fa',
      'fi', 'fj', 'fo', 'fr', 'fy', 'ga', 'gd', 'gl', 'gu', 'ha', 'he', 'hi', 'hr', 'hu',
      'hy', 'id', 'is', 'it', 'ja', 'jv', 'ka', 'kk', 'km', 'kn', 'ko', 'ku', 'ky', 'la',
      'lb', 'lo', 'lt', 'lv', 'mg', 'mi', 'mk', 'ml', 'mn', 'mr', 'ms', 'mt', 'my', 'nb',
      'ne', 'nl', 'nn', 'no', 'pa', 'pl', 'ps', 'pt', 'ro', 'ru', 'rw', 'sa', 'sd', 'si',
      'sk', 'sl', 'so', 'sq', 'sr', 'sv', 'sw', 'ta', 'te', 'tg', 'th', 'tk', 'tl', 'tr',
      'tt', 'uk', 'ur', 'uz', 'vi', 'xh', 'yi', 'zh', 'zu'
    ])

    // Valid ISO 3166-1 Alpha-2 region codes (subset of most common)
    const validRegionCodes = new Set([
      'AD', 'AE', 'AF', 'AG', 'AL', 'AM', 'AO', 'AR', 'AT', 'AU', 'AZ', 'BA', 'BB', 'BD',
      'BE', 'BG', 'BH', 'BN', 'BO', 'BR', 'BS', 'BT', 'BW', 'BY', 'BZ', 'CA', 'CD', 'CF',
      'CH', 'CI', 'CL', 'CM', 'CN', 'CO', 'CR', 'CU', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DO',
      'DZ', 'EC', 'EE', 'EG', 'ES', 'ET', 'FI', 'FJ', 'FR', 'GA', 'GB', 'GE', 'GH', 'GR',
      'GT', 'HK', 'HN', 'HR', 'HT', 'HU', 'ID', 'IE', 'IL', 'IN', 'IQ', 'IR', 'IS', 'IT',
      'JM', 'JO', 'JP', 'KE', 'KG', 'KH', 'KR', 'KW', 'KZ', 'LA', 'LB', 'LI', 'LK', 'LT',
      'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME', 'MG', 'MK', 'ML', 'MM', 'MN', 'MO', 'MT',
      'MU', 'MV', 'MX', 'MY', 'MZ', 'NA', 'NG', 'NI', 'NL', 'NO', 'NP', 'NZ', 'OM', 'PA',
      'PE', 'PH', 'PK', 'PL', 'PR', 'PS', 'PT', 'PY', 'QA', 'RO', 'RS', 'RU', 'RW', 'SA',
      'SD', 'SE', 'SG', 'SI', 'SK', 'SN', 'SO', 'SV', 'SY', 'TH', 'TJ', 'TN', 'TR', 'TW',
      'TZ', 'UA', 'UG', 'UK', 'US', 'UY', 'UZ', 'VE', 'VN', 'YE', 'ZA', 'ZM', 'ZW'
    ])

    const invalidLangCodes: Array<{ lang: string; url: string }> = []
    const invalidRegionCodes: Array<{ lang: string; url: string }> = []
    let hasSelfReference = false
    const langUrlMap = new Map<string, string[]>()

    // Normalize current URL for comparison
    const normalizedCurrentUrl = this.normalizeUrlForComparison(currentUrl)

    for (const entry of hreflangs) {
      const lang = entry.lang.toLowerCase()

      // Skip x-default
      if (lang === 'x-default') {
        continue
      }

      // Parse language-region format (e.g., en-US, pt-BR)
      const parts = lang.split('-')
      const langCode = parts[0]
      const regionCode = parts[1]?.toUpperCase()

      // Validate language code
      if (langCode && !validLangCodes.has(langCode)) {
        invalidLangCodes.push({ lang: entry.lang, url: entry.url })
      }

      // Validate region code if present
      if (regionCode && !validRegionCodes.has(regionCode)) {
        invalidRegionCodes.push({ lang: entry.lang, url: entry.url })
      }

      // Check for self-reference
      const normalizedEntryUrl = this.normalizeUrlForComparison(entry.url)
      if (normalizedEntryUrl === normalizedCurrentUrl) {
        hasSelfReference = true
      }

      // Track duplicates
      const existing = langUrlMap.get(entry.lang) || []
      existing.push(entry.url)
      langUrlMap.set(entry.lang, existing)
    }

    // Find duplicates
    const duplicateEntries: Array<{ lang: string; urls: string[] }> = []
    for (const [lang, urls] of langUrlMap.entries()) {
      if (urls.length > 1) {
        duplicateEntries.push({ lang, urls })
      }
    }

    return {
      invalidLangCodes,
      invalidRegionCodes,
      hasSelfReference,
      duplicateEntries,
    }
  }

  /**
   * Normalize URL for comparison (remove trailing slash, lowercase)
   */
  private normalizeUrlForComparison(url: string): string {
    try {
      const parsed = new URL(url)
      parsed.hash = ''
      let normalized = parsed.toString().toLowerCase()
      if (normalized.endsWith('/') && parsed.pathname !== '/') {
        normalized = normalized.slice(0, -1)
      }
      return normalized
    } catch {
      return url.toLowerCase()
    }
  }

  /**
   * Detect mixed content (basic check)
   */
  private detectMixedContent($: cheerio.CheerioAPI): boolean {
    let hasMixed = false

    $('img[src], script[src], link[href], iframe[src], video[src], audio[src]').each(
      (_, el) => {
        const src = $(el).attr('src') || $(el).attr('href')
        if (src && src.startsWith('http://')) {
          hasMixed = true
        }
      }
    )

    return hasMixed
  }

  /**
   * Check for small touch targets (basic heuristic)
   */
  private hasSmallTouchTargets($: cheerio.CheerioAPI): boolean {
    // This is a simplified check - real detection would need computed styles
    let smallTargets = 0

    $('a, button, input[type="submit"], input[type="button"]').each((_, el) => {
      const style = $(el).attr('style') || ''
      // Very basic check for explicitly small sizes
      if (
        style.includes('font-size: 10px') ||
        style.includes('font-size:10px') ||
        style.includes('width: 20px') ||
        style.includes('height: 20px')
      ) {
        smallTargets++
      }
    })

    return smallTargets > 3
  }

  /**
   * Measure Core Web Vitals using Performance API
   */
  private async measureCoreWebVitals(page: Page): Promise<CoreWebVitals> {
    try {
      const metrics = await page.evaluate(() => {
        return new Promise<{
          lcp?: number
          fcp?: number
          ttfb?: number
          cls?: number
        }>((resolve) => {
          const result: { lcp?: number; fcp?: number; ttfb?: number; cls?: number } = {}

          // Get paint timings
          try {
            const paintEntries = performance.getEntriesByType('paint')
            for (const entry of paintEntries) {
              if (entry.name === 'first-contentful-paint') {
                result.fcp = Math.round(entry.startTime)
              }
            }
          } catch {
            // Paint timing not available
          }

          // Get navigation timing
          try {
            const navEntries = performance.getEntriesByType('navigation')
            if (navEntries.length > 0) {
              const nav = navEntries[0] as PerformanceNavigationTiming
              if (nav) {
                result.ttfb = Math.round(nav.responseStart - nav.requestStart)
              }
            }
          } catch {
            // Navigation timing not available
          }

          // Try to get LCP (requires PerformanceObserver to have run)
          try {
            const lcpEntries = performance.getEntriesByType('largest-contentful-paint')
            if (lcpEntries.length > 0) {
              const lastLcp = lcpEntries[lcpEntries.length - 1]
              if (lastLcp) {
                result.lcp = Math.round(lastLcp.startTime)
              }
            }
          } catch {
            // LCP not available
          }

          resolve(result)
        })
      })

      return metrics
    } catch {
      return {}
    }
  }

  /**
   * Detect pagination patterns in URL and rel links
   */
  private detectPagination(
    url: string,
    relPrev?: string,
    relNext?: string
  ): { isPaginated: boolean; pageNumber?: number } {
    // Check for rel="prev" or rel="next" links
    if (relPrev || relNext) {
      return { isPaginated: true, pageNumber: this.extractPageNumber(url) }
    }

    // Check URL patterns for pagination
    const paginationPatterns = [
      /[?&]page=(\d+)/i,
      /[?&]p=(\d+)/i,
      /\/page\/(\d+)/i,
      /\/p\/(\d+)/i,
      /[?&]offset=(\d+)/i,
      /[?&]start=(\d+)/i,
      /-page-(\d+)/i,
      /_page(\d+)/i,
    ]

    for (const pattern of paginationPatterns) {
      const match = url.match(pattern)
      if (match && match[1]) {
        const pageNum = parseInt(match[1], 10)
        // Only consider it pagination if page > 1 or offset > 0
        if (pageNum > 1 || (pattern.source.includes('offset') && pageNum > 0)) {
          return { isPaginated: true, pageNumber: pageNum }
        }
      }
    }

    return { isPaginated: false }
  }

  /**
   * Extract page number from URL
   */
  private extractPageNumber(url: string): number | undefined {
    const patterns = [
      /[?&]page=(\d+)/i,
      /[?&]p=(\d+)/i,
      /\/page\/(\d+)/i,
      /\/p\/(\d+)/i,
    ]

    for (const pattern of patterns) {
      const match = url.match(pattern)
      if (match && match[1]) {
        return parseInt(match[1], 10)
      }
    }

    return undefined
  }

  /**
   * Analyze URL parameters for technical SEO issues
   */
  private analyzeUrlParameters(url: string): {
    parameters: string[]
    parameterCount: number
    hasTrailingSlash: boolean
    hasSortingParams: boolean
    hasFilterParams: boolean
    hasSessionParams: boolean
  } {
    try {
      const parsed = new URL(url)
      const params = Array.from(parsed.searchParams.keys())

      // Sorting parameters
      const sortingParams = ['sort', 'order', 'orderby', 'sortby', 'dir', 'direction', 'asc', 'desc']
      const hasSortingParams = params.some(p => sortingParams.includes(p.toLowerCase()))

      // Filter/facet parameters (common e-commerce patterns)
      const filterParams = ['filter', 'color', 'size', 'brand', 'price', 'category', 'type',
        'min_price', 'max_price', 'minprice', 'maxprice', 'attr', 'attribute', 'facet']
      const hasFilterParams = params.some(p => filterParams.includes(p.toLowerCase()))

      // Session/tracking parameters
      const sessionParams = ['sid', 'sessionid', 'session_id', 'phpsessid', 'jsessionid',
        'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
        'fbclid', 'gclid', 'msclkid', 'ref', 'referrer', 'source', 'affiliate']
      const hasSessionParams = params.some(p => sessionParams.includes(p.toLowerCase()))

      // Check trailing slash
      const hasTrailingSlash = parsed.pathname.endsWith('/') && parsed.pathname !== '/'

      return {
        parameters: params,
        parameterCount: params.length,
        hasTrailingSlash,
        hasSortingParams,
        hasFilterParams,
        hasSessionParams,
      }
    } catch {
      return {
        parameters: [],
        parameterCount: 0,
        hasTrailingSlash: false,
        hasSortingParams: false,
        hasFilterParams: false,
        hasSessionParams: false,
      }
    }
  }
}
