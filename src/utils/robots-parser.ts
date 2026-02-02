/**
 * Robots.txt Parser
 *
 * Fetches and parses robots.txt to determine crawl permissions
 */

import robotsParser from 'robots-parser'

export class RobotsParser {
  private domain: string
  private userAgent: string
  private parser: ReturnType<typeof robotsParser> | null = null
  private aiCrawlerRules: Map<string, boolean> = new Map()

  // Known AI crawler user agents
  private static readonly AI_CRAWLERS = [
    'GPTBot',
    'ChatGPT-User',
    'Google-Extended',
    'anthropic-ai',
    'Claude-Web',
    'PerplexityBot',
    'Amazonbot',
    'OAI-SearchBot',
    'cohere-ai',
    'FacebookBot',
  ]

  constructor(domain: string, userAgent: string) {
    this.domain = domain.replace(/^www\./, '')
    this.userAgent = userAgent
  }

  /**
   * Fetch and parse robots.txt
   */
  async fetch(): Promise<void> {
    const robotsUrl = `https://${this.domain}/robots.txt`

    try {
      const response = await fetch(robotsUrl, {
        headers: {
          'User-Agent': this.userAgent,
        },
      })

      if (!response.ok) {
        // No robots.txt or error - allow all
        this.parser = robotsParser(robotsUrl, '')
        return
      }

      const robotsTxt = await response.text()
      this.parser = robotsParser(robotsUrl, robotsTxt)

      // Parse AI crawler rules
      this.parseAiCrawlerRules(robotsTxt)
    } catch {
      // Error fetching - allow all
      this.parser = robotsParser(robotsUrl, '')
    }
  }

  /**
   * Check if URL is allowed for crawling
   */
  isAllowed(url: string): boolean {
    if (!this.parser) return true
    return this.parser.isAllowed(url, this.userAgent) ?? true
  }

  /**
   * Get crawl delay if specified
   */
  getCrawlDelay(): number | null {
    if (!this.parser) return null
    return this.parser.getCrawlDelay(this.userAgent) ?? null
  }

  /**
   * Get sitemaps listed in robots.txt
   */
  getSitemaps(): string[] {
    if (!this.parser) return []
    return this.parser.getSitemaps()
  }

  /**
   * Parse AI crawler rules from robots.txt
   */
  private parseAiCrawlerRules(robotsTxt: string): void {
    const lines = robotsTxt.split('\n')
    let currentUserAgents: string[] = []

    for (const line of lines) {
      const trimmedLine = line.trim().toLowerCase()

      if (trimmedLine.startsWith('user-agent:')) {
        const ua = trimmedLine.replace('user-agent:', '').trim()
        if (ua === '*' || RobotsParser.AI_CRAWLERS.some((c) => c.toLowerCase() === ua)) {
          currentUserAgents.push(ua)
        } else {
          currentUserAgents = []
        }
      } else if (trimmedLine.startsWith('disallow:') && currentUserAgents.length > 0) {
        const path = trimmedLine.replace('disallow:', '').trim()
        if (path === '/' || path === '') {
          for (const ua of currentUserAgents) {
            if (ua !== '*') {
              // Specific AI crawler is blocked
              const matchedCrawler = RobotsParser.AI_CRAWLERS.find(
                (c) => c.toLowerCase() === ua
              )
              if (matchedCrawler) {
                this.aiCrawlerRules.set(matchedCrawler, false)
              }
            }
          }
        }
      } else if (trimmedLine.startsWith('allow:') && currentUserAgents.length > 0) {
        const path = trimmedLine.replace('allow:', '').trim()
        if (path === '/' || path === '') {
          for (const ua of currentUserAgents) {
            if (ua !== '*') {
              const matchedCrawler = RobotsParser.AI_CRAWLERS.find(
                (c) => c.toLowerCase() === ua
              )
              if (matchedCrawler) {
                this.aiCrawlerRules.set(matchedCrawler, true)
              }
            }
          }
        }
      } else if (trimmedLine === '' || trimmedLine.startsWith('#')) {
        currentUserAgents = []
      }
    }
  }

  /**
   * Get AI crawler access status
   */
  getAiCrawlerAccess(): Record<string, boolean | null> {
    const access: Record<string, boolean | null> = {}

    for (const crawler of RobotsParser.AI_CRAWLERS) {
      access[crawler] = this.aiCrawlerRules.has(crawler)
        ? this.aiCrawlerRules.get(crawler) ?? null
        : null // null = not explicitly mentioned
    }

    return access
  }

  /**
   * Check if a specific AI crawler is allowed
   */
  isAiCrawlerAllowed(crawler: string): boolean | null {
    return this.aiCrawlerRules.get(crawler) ?? null
  }
}
