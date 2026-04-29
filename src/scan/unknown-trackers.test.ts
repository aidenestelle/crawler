/**
 * Unit tests for unknown-tracker-domain collection.
 * Covers: known-pattern filter, self-host filter, dedupe, cap-at-20,
 * non-http scheme rejection, and bad-URL safety.
 */
import { describe, it, expect } from 'vitest'
import {
  MAX_UNKNOWN_HOSTS,
  collectUnknownTrackerDomains,
} from './unknown-trackers.js'

const TARGET = 'https://clinic.example.com/home'

describe('collectUnknownTrackerDomains', () => {
  it('drops known-tracker URLs, keeps unknowns', () => {
    const knownPatterns = [/google-analytics\.com/i]
    const urls = [
      'https://www.google-analytics.com/collect?x=1',
      'https://cdn.unknownvendor.net/script.js',
    ]
    const out = collectUnknownTrackerDomains(urls, {
      knownPatterns,
      targetUrl: TARGET,
    })
    expect(out).toEqual(['cdn.unknownvendor.net'])
  })

  it('filters out the target site and its registrable domain', () => {
    const urls = [
      'https://clinic.example.com/static/app.js',
      'https://assets.example.com/font.woff', // same registrable
      'https://thirdparty.io/track',
    ]
    const out = collectUnknownTrackerDomains(urls, {
      knownPatterns: [],
      targetUrl: TARGET,
    })
    expect(out).toEqual(['thirdparty.io'])
  })

  it('dedupes by hostname', () => {
    const urls = [
      'https://cdn.vendor.net/a.js',
      'https://cdn.vendor.net/b.js',
      'https://cdn.vendor.net/c.js?q=1',
    ]
    const out = collectUnknownTrackerDomains(urls, {
      knownPatterns: [],
      targetUrl: TARGET,
    })
    expect(out).toEqual(['cdn.vendor.net'])
  })

  it('caps the output at MAX_UNKNOWN_HOSTS entries', () => {
    const urls = Array.from(
      { length: MAX_UNKNOWN_HOSTS + 10 },
      (_, i) => `https://vendor${i}.io/x`
    )
    const out = collectUnknownTrackerDomains(urls, {
      knownPatterns: [],
      targetUrl: TARGET,
    })
    expect(out.length).toBe(MAX_UNKNOWN_HOSTS)
    expect(out[0]).toBe('vendor0.io')
  })

  it('ignores non-http(s) schemes and malformed URLs', () => {
    const urls = [
      'data:image/png;base64,AAAA',
      'chrome-extension://abc/xyz',
      'not a url at all',
      '',
      'https://legit.vendor.com/px',
    ]
    const out = collectUnknownTrackerDomains(urls, {
      knownPatterns: [],
      targetUrl: TARGET,
    })
    expect(out).toEqual(['legit.vendor.com'])
  })
})
