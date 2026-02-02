/**
 * Page Data Types
 *
 * Comprehensive types for crawled page data
 */

export interface RedirectInfo {
  url: string
  statusCode: number
}

export interface ImageData {
  src: string
  alt?: string
  width?: number
  height?: number
  size?: number
  isBroken?: boolean
}

export interface ImageStats {
  total: number
  withoutAlt: number
  withEmptyAlt: number
  details: ImageData[]
}

export interface CoreWebVitals {
  lcp?: number  // Largest Contentful Paint (ms)
  fid?: number  // First Input Delay (ms)
  cls?: number  // Cumulative Layout Shift
  inp?: number  // Interaction to Next Paint (ms)
  ttfb?: number // Time to First Byte (ms)
  fcp?: number  // First Contentful Paint (ms)
}

export interface HreflangEntry {
  lang: string
  url: string
}

export interface StructuredDataItem {
  '@type': string
  [key: string]: unknown
}

export interface SecurityHeaders {
  contentSecurityPolicy?: string
  xFrameOptions?: string
  strictTransportSecurity?: string
  xContentTypeOptions?: string
  referrerPolicy?: string
}

export interface OpenGraphData {
  title?: string
  description?: string
  image?: string
  url?: string
  type?: string
  siteName?: string
}

export interface TwitterCardData {
  card?: string
  title?: string
  description?: string
  image?: string
  site?: string
  creator?: string
}

export interface MetaData {
  description?: string
  keywords?: string
  robots?: string
  author?: string
  viewport?: string
}

/**
 * Complete page data from crawling
 *
 * This is the canonical type used throughout the crawler.
 * PageCrawler produces this type, and both CrawlManager (for DB storage)
 * and IssueDetector (for analysis) consume it.
 *
 * Some fields have two names for compatibility:
 * - "Clean" names (e.g., canonical, h1, openGraph) used by IssueDetector
 * - "Legacy" names (e.g., canonicalUrl, h1Tags, ogTags) used for DB mapping
 */
export interface PageData {
  // Required
  url: string
  statusCode: number

  // Identification
  pageId?: string

  // Response data
  contentType?: string
  responseTime?: number
  pageSize?: number
  htmlSize?: number

  // Redirects - clean names for analysis
  redirectChain?: RedirectInfo[]
  redirectUrl?: string

  // Indexability
  isIndexable?: boolean
  indexabilityReason?: string
  blockedByRobots?: boolean

  // Title
  title?: string

  // Meta - clean object form for analysis
  meta?: MetaData
  // Legacy flat form for DB
  metaDescription?: string
  robotsMeta?: string

  // Canonical - clean name for analysis
  canonical?: string
  // Legacy name for DB
  canonicalUrl?: string
  isSelfCanonical?: boolean

  // Headings - clean names for analysis
  h1?: string[]
  h2?: string[]
  // Legacy names for DB
  h1Tags?: string[]
  h2Tags?: string[]

  // Content
  wordCount?: number
  contentHash?: string
  bodyText?: string  // Extracted text content from the page body
  textToHtmlRatio?: number
  readingLevel?: 'basic' | 'intermediate' | 'advanced' | 'complex'
  readingGradeLevel?: number
  topKeywords?: Array<{ word: string; count: number; density: number }>
  headingHierarchy?: string[]  // e.g., ['h1', 'h2', 'h3', 'h2'] - order of headings

  // Links
  links?: {
    internal: string[]
    external: string[]
  }
  brokenLinks?: string[]

  // Pagination
  relPrev?: string
  relNext?: string
  isPaginatedPage?: boolean
  paginationPageNumber?: number

  // URL Analysis
  urlParameters?: string[]
  urlParameterCount?: number
  hasTrailingSlash?: boolean
  hasSortingParams?: boolean
  hasFilterParams?: boolean
  hasSessionParams?: boolean

  // Images - clean form for analysis (array of ImageData)
  images?: ImageData[]
  // Stats form for DB storage
  imageStats?: ImageStats
  imageDetails?: ImageData[]

  // Performance - clean name for analysis
  coreWebVitals?: CoreWebVitals
  // Legacy name for DB
  cwv?: CoreWebVitals
  requestCount?: number
  hasUnminifiedCss?: boolean
  hasUnminifiedJs?: boolean
  unminifiedCssFiles?: string[]
  unminifiedJsFiles?: string[]
  renderBlockingResources?: string[]

  // Security
  hasMixedContent?: boolean
  mixedContentUrls?: string[]
  securityHeaders?: SecurityHeaders
  hasInsecureForms?: boolean
  insecureForms?: string[]

  // Structured Data
  schemaTypes?: string[]
  structuredData?: Array<Record<string, unknown>>
  structuredDataErrors?: string[]
  structuredDataWarnings?: string[]

  // Mobile (basic fields for backward compatibility)
  hasViewport?: boolean
  viewportContent?: string
  isMobileFriendly?: boolean
  smallTapTargets?: string[]
  hasSmallText?: boolean
  hasHorizontalScroll?: boolean

  // Mobile (extended analysis)
  mobile?: {
    // Viewport analysis
    viewportAnalysis?: {
      hasViewport?: boolean
      content?: string
      isZoomDisabled?: boolean
      hasUserScalableNo?: boolean
      maxScale?: number
      initialScale?: number
      width?: string
    }
    // Content analysis
    contentOverflowsViewport?: boolean
    hasResponsiveImages?: boolean
    nonResponsiveImageCount?: number
    totalImageCount?: number
    hasResponsiveTables?: boolean
    tableCount?: number
    // Fixed elements
    hasLargeFixedElements?: boolean
    fixedElements?: string[]
    // Typography
    smallTextElements?: string[]
    minimumFontSize?: number
    // Tap targets
    tapTargetIssues?: {
      tooSmall?: string[]
      tooClose?: string[]
    }
    // PWA/App features
    hasAppleTouchIcon?: boolean
    hasWebAppManifest?: boolean
    hasThemeColor?: string
    // Click-to-call
    hasTelLinks?: boolean
    phoneNumbersFound?: number
    // Performance
    lcpElementIsLazyLoaded?: boolean
    // CSS
    hasMediaQueries?: boolean
    // Issues pre-calculated
    issues?: {
      zoomDisabled?: boolean
      contentWiderThanScreen?: boolean
      imagesNotResponsive?: boolean
      tablesWithoutResponsive?: boolean
      fixedElementsBlocking?: boolean
      fontTooSmall?: boolean
      tapTargetsTooSmall?: boolean
      tapTargetsTooClose?: boolean
      noAppleTouchIcon?: boolean
      noWebAppManifest?: boolean
      noThemeColor?: boolean
      noTelLinks?: boolean
      lcpLazyLoaded?: boolean
      noMediaQueries?: boolean
      initialScaleNotOne?: boolean
    }
  }

  // International - clean name for analysis
  lang?: string
  hreflangs?: HreflangEntry[]
  // Legacy names for DB
  htmlLang?: string
  hreflangTags?: HreflangEntry[]
  hreflangErrors?: string[]
  nonReciprocalHreflangs?: string[]
  // Enhanced hreflang validation
  hreflangValidation?: {
    invalidLangCodes?: Array<{ lang: string; url: string }>
    invalidRegionCodes?: Array<{ lang: string; url: string }>
    hasSelfReference?: boolean
    duplicateEntries?: Array<{ lang: string; urls: string[] }>
  }

  // Social - clean names for analysis
  openGraph?: OpenGraphData
  twitterCard?: TwitterCardData
  // Legacy names for DB
  ogTags?: OpenGraphData
  twitterCardType?: string

  // Accessibility
  emptyLinks?: string[]
  missingFormLabels?: string[]
  lowContrastElements?: string[]
  hasSkipLink?: boolean
  hasAriaLandmarks?: boolean

  // AI Search
  aiCrawlerAccess?: Record<string, boolean | null>
  hasLlmFriendlyStructure?: boolean

  // Article/News/Blog Schema
  article?: {
    hasArticleSchema?: boolean
    schemaType?: 'Article' | 'NewsArticle' | 'BlogPosting' | 'TechArticle' | 'ScholarlyArticle'
    articleCount?: number  // Number of article schemas on page
    articleData?: {
      headline?: string
      description?: string
      body?: string
      author?: string | { name: string; url?: string }
      datePublished?: string
      dateModified?: string
      image?: string | string[]
      publisher?: string | { name: string; logo?: string }
      wordCount?: number
      inLanguage?: string
      mainEntityOfPage?: string
    }
    issues?: {
      missingHeadline?: boolean
      missingDatePublished?: boolean
      missingAuthor?: boolean
      missingImage?: boolean
      missingDescription?: boolean
      missingPublisher?: boolean
      missingBody?: boolean
      invalidDateFormat?: boolean
      futureDatePublished?: boolean
      missingDateModified?: boolean
      multipleArticles?: boolean
      shortHeadline?: boolean
      headlineTooLong?: boolean
      outdatedContent?: boolean
      missingWordCount?: boolean
    }
  }

  // E-commerce
  ecommerce?: {
    hasProductSchema?: boolean
    productData?: {
      name?: string
      description?: string
      sku?: string
      gtin?: string
      mpn?: string
      brand?: string
      price?: number
      currency?: string
      availability?: string
      condition?: string
      image?: string
      ratingValue?: number
      reviewCount?: number
      offers?: Array<{
        price?: number
        currency?: string
        availability?: string
        priceValidUntil?: string
      }>
    }
    issues?: {
      missingProductName?: boolean
      missingPrice?: boolean
      missingAvailability?: boolean
      missingImage?: boolean
      missingDescription?: boolean
      missingSku?: boolean
      missingBrand?: boolean
      outOfStock?: boolean
      discontinuedProduct?: boolean
      invalidPrice?: boolean
      expiredPrice?: boolean
      missingCurrency?: boolean
      missingOffer?: boolean
      multipleProducts?: boolean
    }
  }
}

/**
 * Crawl settings from project configuration
 */
export interface CrawlSettings {
  max_pages: number
  max_depth: number
  respect_robots_txt: boolean
  render_javascript: boolean
  crawl_speed: 'slow' | 'normal' | 'fast'
  user_agent: string
  include_subdomains: boolean
  exclude_patterns: string[]
}

/**
 * Crawl job from database
 */
export interface CrawlJob {
  id: string
  project_id: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  started_at?: string
  completed_at?: string
  pages_crawled: number
  pages_with_issues: number
  total_errors: number
  total_warnings: number
  total_notices: number
  health_score?: number
  created_at: string
}

/**
 * Project from database
 */
export interface Project {
  id: string
  organization_id: string
  name: string
  domain: string
  crawl_settings: CrawlSettings
  created_at: string
  updated_at: string
}
