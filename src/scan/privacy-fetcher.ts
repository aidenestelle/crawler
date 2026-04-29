/**
 * Privacy-policy text fetcher.
 *
 * Given the scanned page's HTML (as a Cheerio root) and the page's absolute
 * URL, find the first privacy/HIPAA-ish link, fetch it with a 10s timeout
 * using the shared Estellebot UA, strip scripts/styles/nav/footer, and
 * return up to 20_000 characters of visible text.
 *
 * On any failure (no link, bad URL, non-OK response, timeout, parse error)
 * this returns "" — callers treat empty as "no privacy text available"
 * rather than a hard error, because missing privacy policies are a
 * legitimate scan signal, not a worker fault.
 *
 * Fully offline-friendly: the `fetchImpl` parameter is injectable so unit
 * tests can mock it without touching the network.
 */
import * as cheerio from 'cheerio'
import { ESTELLEBOT_USER_AGENT } from '../utils/user-agent.js'

export const PRIVACY_TEXT_MAX_CHARS = 20_000
export const PRIVACY_FETCH_TIMEOUT_MS = 10_000

const LINK_RE = /privacy|hipaa/i

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> }
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>

/**
 * Find the first `<a>` whose href or visible text matches /privacy|hipaa/i.
 * Returns the raw href (possibly relative) or null.
 */
export function findPrivacyLink($: cheerio.CheerioAPI): string | null {
  const anchors = $('a').toArray()
  for (const a of anchors) {
    const el = $(a)
    const href = (el.attr('href') ?? '').trim()
    const text = (el.text() ?? '').trim()
    if (!href) continue
    if (LINK_RE.test(href) || LINK_RE.test(text)) {
      return href
    }
  }
  return null
}

/**
 * Resolve a possibly-relative href against the scanned page URL.
 * Returns null if the result isn't a valid absolute http(s) URL.
 */
export function resolvePrivacyUrl(
  href: string,
  pageUrl: string
): string | null {
  try {
    const u = new URL(href, pageUrl)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.toString()
  } catch {
    return null
  }
}

/**
 * Extract visible text from a privacy-policy HTML document.
 * Strips <script>, <style>, <nav>, <footer>, <header>, <noscript>.
 * Collapses whitespace. Truncates to PRIVACY_TEXT_MAX_CHARS.
 */
export function extractPrivacyText(html: string): string {
  const $ = cheerio.load(html)
  $('script, style, noscript, nav, footer, header').remove()
  const text = $('body').text() || $.root().text() || ''
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= PRIVACY_TEXT_MAX_CHARS) return collapsed
  return collapsed.slice(0, PRIVACY_TEXT_MAX_CHARS)
}

/**
 * Full pipeline: discover → resolve → fetch → extract → truncate.
 * Returns "" on any non-success path.
 */
export async function fetchPrivacyText(
  $: cheerio.CheerioAPI,
  pageUrl: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike
): Promise<string> {
  const href = findPrivacyLink($)
  if (!href) return ''
  const abs = resolvePrivacyUrl(href, pageUrl)
  if (!abs) return ''

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PRIVACY_FETCH_TIMEOUT_MS)
  try {
    const res = await fetchImpl(abs, {
      signal: controller.signal,
      headers: { 'user-agent': ESTELLEBOT_USER_AGENT },
    })
    if (!res.ok) return ''
    const html = await res.text()
    return extractPrivacyText(html)
  } catch {
    return ''
  } finally {
    clearTimeout(timer)
  }
}
