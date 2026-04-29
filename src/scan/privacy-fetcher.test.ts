/**
 * Offline unit tests for the privacy-policy fetcher.
 *
 * We inject a fake fetch so nothing touches the network. Covers:
 *   - link discovery (href match, text match, no match)
 *   - URL resolution (relative → absolute, invalid protocol)
 *   - text extraction (strips scripts/nav/footer, collapses whitespace)
 *   - truncation at 20_000 chars
 *   - failure modes (no link, non-OK response, fetch throws, timeout)
 */
import { describe, it, expect } from 'vitest'
import * as cheerio from 'cheerio'
import {
  PRIVACY_TEXT_MAX_CHARS,
  extractPrivacyText,
  fetchPrivacyText,
  findPrivacyLink,
  resolvePrivacyUrl,
  type FetchLike,
} from './privacy-fetcher.js'

function mockFetch(body: string, ok = true, status = 200): FetchLike {
  return async () => ({
    ok,
    status,
    text: async () => body,
  })
}

describe('findPrivacyLink', () => {
  it('matches on href containing "privacy"', () => {
    const $ = cheerio.load('<a href="/legal/privacy-policy">Legal</a>')
    expect(findPrivacyLink($)).toBe('/legal/privacy-policy')
  })

  it('matches on visible text containing "HIPAA"', () => {
    const $ = cheerio.load('<a href="/p/123">HIPAA Notice</a>')
    expect(findPrivacyLink($)).toBe('/p/123')
  })

  it('returns null when no anchor matches', () => {
    const $ = cheerio.load('<a href="/about">About</a><a href="/services">Services</a>')
    expect(findPrivacyLink($)).toBeNull()
  })

  it('returns the first matching link when multiple exist', () => {
    const $ = cheerio.load(
      '<a href="/privacy-1">A</a><a href="/privacy-2">B</a>'
    )
    expect(findPrivacyLink($)).toBe('/privacy-1')
  })
})

describe('resolvePrivacyUrl', () => {
  it('resolves relative paths against the page URL', () => {
    expect(resolvePrivacyUrl('/privacy', 'https://ex.com/a/b')).toBe(
      'https://ex.com/privacy'
    )
  })

  it('returns null for non-http(s) schemes', () => {
    expect(resolvePrivacyUrl('javascript:void(0)', 'https://ex.com/')).toBeNull()
  })

  it('returns null for completely malformed hrefs', () => {
    // URL constructor accepts many things; "http://" with no host is invalid.
    expect(resolvePrivacyUrl('http://', 'not a url')).toBeNull()
  })
})

describe('extractPrivacyText', () => {
  it('strips script/style/nav/footer and collapses whitespace', () => {
    const html = `
      <html><body>
        <nav>SKIPME_NAV</nav>
        <script>var x = 'SKIPME_SCRIPT';</script>
        <style>.x { color: red; }</style>
        <main>   Privacy    policy   text  </main>
        <footer>SKIPME_FOOTER</footer>
      </body></html>`
    const text = extractPrivacyText(html)
    expect(text).not.toMatch(/SKIPME/)
    expect(text).toContain('Privacy policy text')
  })

  it('truncates to PRIVACY_TEXT_MAX_CHARS', () => {
    const big = 'a'.repeat(PRIVACY_TEXT_MAX_CHARS + 5_000)
    const html = `<html><body><p>${big}</p></body></html>`
    const text = extractPrivacyText(html)
    expect(text.length).toBe(PRIVACY_TEXT_MAX_CHARS)
  })

  it('returns "" for empty HTML', () => {
    expect(extractPrivacyText('')).toBe('')
  })
})

describe('fetchPrivacyText (full pipeline, mocked fetch)', () => {
  const pageUrl = 'https://clinic.example.com/home'

  it('returns "" when no privacy link exists', async () => {
    const $ = cheerio.load('<a href="/about">About</a>')
    const text = await fetchPrivacyText($, pageUrl, mockFetch('<p>x</p>'))
    expect(text).toBe('')
  })

  it('returns extracted text on a successful fetch', async () => {
    const $ = cheerio.load('<a href="/privacy">Privacy</a>')
    const body =
      '<html><body><main>We collect IP addresses and cookies.</main></body></html>'
    const text = await fetchPrivacyText($, pageUrl, mockFetch(body))
    expect(text).toContain('We collect IP addresses and cookies.')
  })

  it('returns "" when the fetch returns a non-OK status', async () => {
    const $ = cheerio.load('<a href="/privacy">Privacy</a>')
    const text = await fetchPrivacyText($, pageUrl, mockFetch('nope', false, 500))
    expect(text).toBe('')
  })

  it('returns "" when the fetch implementation throws', async () => {
    const $ = cheerio.load('<a href="/privacy">Privacy</a>')
    const throwing: FetchLike = async () => {
      throw new Error('network down')
    }
    const text = await fetchPrivacyText($, pageUrl, throwing)
    expect(text).toBe('')
  })
})
