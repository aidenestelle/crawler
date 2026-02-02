/**
 * Sitemap Parser
 *
 * Parses XML sitemaps (sitemap.xml, sitemap index files) to discover URLs
 * Supports: standard sitemaps, sitemap indexes, gzip compression
 */

import { gunzipSync } from 'zlib'

export interface SitemapUrl {
  loc: string
  lastmod?: string
  changefreq?: string
  priority?: number
}

export interface SitemapParseResult {
  urls: SitemapUrl[]
  sitemapIndexUrls: string[]
  errors: string[]
}

export class SitemapParser {
  private domain: string
  private userAgent: string
  private maxUrls: number
  private timeout: number

  constructor(
    domain: string,
    userAgent: string,
    options: { maxUrls?: number; timeout?: number } = {}
  ) {
    this.domain = domain.replace(/^www\./, '')
    this.userAgent = userAgent
    this.maxUrls = options.maxUrls ?? 10000
    this.timeout = options.timeout ?? 30000
  }

  /**
   * Parse sitemap(s) and return discovered URLs
   * Handles both direct sitemaps and sitemap index files
   */
  async parse(sitemapUrls: string[]): Promise<SitemapParseResult> {
    const result: SitemapParseResult = {
      urls: [],
      sitemapIndexUrls: [],
      errors: [],
    }

    const processedSitemaps = new Set<string>()
    const sitemapsToProcess = [...sitemapUrls]

    // If no sitemaps provided, try common locations
    if (sitemapsToProcess.length === 0) {
      sitemapsToProcess.push(
        `https://${this.domain}/sitemap.xml`,
        `https://${this.domain}/sitemap_index.xml`
      )
    }

    while (sitemapsToProcess.length > 0 && result.urls.length < this.maxUrls) {
      const sitemapUrl = sitemapsToProcess.shift()!

      if (processedSitemaps.has(sitemapUrl)) {
        continue
      }
      processedSitemaps.add(sitemapUrl)

      try {
        const content = await this.fetchSitemap(sitemapUrl)
        if (!content) continue

        const parsed = this.parseXml(content)

        // Check if it's a sitemap index
        if (parsed.sitemapIndexUrls.length > 0) {
          result.sitemapIndexUrls.push(...parsed.sitemapIndexUrls)
          // Add child sitemaps to processing queue
          for (const childUrl of parsed.sitemapIndexUrls) {
            if (!processedSitemaps.has(childUrl)) {
              sitemapsToProcess.push(childUrl)
            }
          }
        }

        // Add discovered URLs (up to max)
        const remaining = this.maxUrls - result.urls.length
        const urlsToAdd = parsed.urls.slice(0, remaining)
        result.urls.push(...urlsToAdd)

        if (parsed.errors.length > 0) {
          result.errors.push(...parsed.errors)
        }
      } catch (error) {
        result.errors.push(
          `Failed to parse ${sitemapUrl}: ${error instanceof Error ? error.message : 'Unknown error'}`
        )
      }
    }

    return result
  }

  /**
   * Fetch sitemap content, handling gzip compression
   */
  private async fetchSitemap(url: string): Promise<string | null> {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), this.timeout)

      const response = await fetch(url, {
        headers: {
          'User-Agent': this.userAgent,
          Accept: 'application/xml, text/xml, */*',
        },
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        return null
      }

      // Check if gzipped
      if (url.endsWith('.gz')) {
        const buffer = await response.arrayBuffer()
        const decompressed = gunzipSync(Buffer.from(buffer))
        return decompressed.toString('utf-8')
      }

      return await response.text()
    } catch {
      return null
    }
  }

  /**
   * Parse XML content to extract URLs or sitemap index references
   */
  private parseXml(content: string): SitemapParseResult {
    const result: SitemapParseResult = {
      urls: [],
      sitemapIndexUrls: [],
      errors: [],
    }

    // Check if this is a sitemap index
    if (content.includes('<sitemapindex')) {
      const sitemapMatches = content.matchAll(/<sitemap[^>]*>[\s\S]*?<\/sitemap>/gi)
      for (const match of sitemapMatches) {
        const locMatch = match[0].match(/<loc[^>]*>([^<]+)<\/loc>/i)
        if (locMatch && locMatch[1]) {
          const sitemapUrl = this.cleanUrl(locMatch[1])
          if (sitemapUrl) {
            result.sitemapIndexUrls.push(sitemapUrl)
          }
        }
      }
      return result
    }

    // Parse as regular sitemap
    const urlMatches = content.matchAll(/<url[^>]*>[\s\S]*?<\/url>/gi)

    for (const match of urlMatches) {
      const urlBlock = match[0]

      // Extract loc (required)
      const locMatch = urlBlock.match(/<loc[^>]*>([^<]+)<\/loc>/i)
      if (!locMatch || !locMatch[1]) continue

      const loc = this.cleanUrl(locMatch[1])
      if (!loc) continue

      // Only include URLs from the same domain
      if (!this.isSameDomain(loc)) continue

      const urlEntry: SitemapUrl = { loc }

      // Extract lastmod (optional)
      const lastmodMatch = urlBlock.match(/<lastmod[^>]*>([^<]+)<\/lastmod>/i)
      if (lastmodMatch && lastmodMatch[1]) {
        urlEntry.lastmod = lastmodMatch[1].trim()
      }

      // Extract changefreq (optional)
      const changefreqMatch = urlBlock.match(/<changefreq[^>]*>([^<]+)<\/changefreq>/i)
      if (changefreqMatch && changefreqMatch[1]) {
        urlEntry.changefreq = changefreqMatch[1].trim()
      }

      // Extract priority (optional)
      const priorityMatch = urlBlock.match(/<priority[^>]*>([^<]+)<\/priority>/i)
      if (priorityMatch && priorityMatch[1]) {
        const priority = parseFloat(priorityMatch[1].trim())
        if (!isNaN(priority) && priority >= 0 && priority <= 1) {
          urlEntry.priority = priority
        }
      }

      result.urls.push(urlEntry)
    }

    return result
  }

  /**
   * Clean and decode URL
   */
  private cleanUrl(url: string): string | null {
    try {
      // Decode HTML entities
      let cleaned = url
        .trim()
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")

      // Validate URL
      const parsed = new URL(cleaned)
      return parsed.toString()
    } catch {
      return null
    }
  }

  /**
   * Check if URL belongs to the same domain
   */
  private isSameDomain(url: string): boolean {
    try {
      const parsed = new URL(url)
      const urlDomain = parsed.hostname.replace(/^www\./, '')
      return urlDomain === this.domain || urlDomain.endsWith(`.${this.domain}`)
    } catch {
      return false
    }
  }
}
