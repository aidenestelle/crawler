/**
 * Unknown-tracker-domain collector.
 *
 * Given the full list of network-request URLs observed during a scan, the
 * set of regexes that DID match a tracker in trackers.json, and the target
 * site URL, this returns the deduped set of third-party hostnames that
 * remained unclassified — bounded at 20 entries to cap downstream AI
 * payload cost.
 *
 * Filters:
 *   - Drops requests that match any known tracker regex
 *   - Drops requests whose hostname equals the target host (or a subdomain
 *     of the target's registrable domain, approximated by suffix match)
 *   - Drops non-http(s) schemes (data:, blob:, chrome-extension:, etc.)
 *   - Dedupes by hostname
 *   - Caps at MAX_UNKNOWN_HOSTS (20)
 */

export const MAX_UNKNOWN_HOSTS = 20

/**
 * Very small "same-site" approximation without tldts. Treats the last two
 * labels of each host as the registrable domain for comparison. This is
 * imperfect for multi-part TLDs (e.g. .co.uk) but the consequence of an
 * over-match is only "we filter out one extra domain" — acceptable for a
 * 20-entry signal payload.
 */
function registrableDomain(host: string): string {
  const labels = host.toLowerCase().split('.').filter(Boolean)
  if (labels.length <= 2) return labels.join('.')
  return labels.slice(-2).join('.')
}

function safeHost(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.hostname.toLowerCase()
  } catch {
    return null
  }
}

export interface UnknownTrackerOptions {
  /**
   * Compiled tracker patterns. Any request URL matching ANY of these is
   * considered "known" and its host is not reported as unknown.
   */
  knownPatterns: RegExp[]
  /** Absolute URL of the scanned page. Used to derive the self-host filter. */
  targetUrl: string
}

/**
 * Returns the deduped, capped list of unknown third-party hostnames.
 */
export function collectUnknownTrackerDomains(
  requestUrls: string[],
  opts: UnknownTrackerOptions
): string[] {
  const selfHost = safeHost(opts.targetUrl)
  const selfReg = selfHost ? registrableDomain(selfHost) : null

  const out: string[] = []
  const seen = new Set<string>()

  for (const url of requestUrls) {
    if (!url) continue
    const host = safeHost(url)
    if (!host) continue

    // Self-site filter: same host or same registrable domain.
    if (selfHost && host === selfHost) continue
    if (selfReg && registrableDomain(host) === selfReg) continue

    // Known-tracker filter.
    if (opts.knownPatterns.some((re) => re.test(url))) continue

    if (seen.has(host)) continue
    seen.add(host)
    out.push(host)
    if (out.length >= MAX_UNKNOWN_HOSTS) break
  }

  return out
}
