/**
 * SEO URL Filter Utility
 *
 * Filters URLs to only include those that affect SEO.
 * Excludes non-HTML resources, admin pages, tracking parameters, etc.
 */

// Non-HTML file extensions to exclude
const NON_HTML_EXTENSIONS = [
  // Images
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico', '.bmp', '.tiff', '.avif',
  // Documents
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp',
  // Media
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.webm', '.ogg', '.flac', '.mkv',
  // Code/Data
  '.js', '.css', '.json', '.xml', '.rss', '.atom', '.yaml', '.yml',
  // Fonts
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  // Archives
  '.zip', '.rar', '.tar', '.gz', '.7z',
  // Other
  '.txt', '.csv', '.ics', '.vcf', '.apk', '.exe', '.dmg',
]

// Non-SEO URL path patterns to exclude (exact segment matches)
// These patterns match path segments, not substrings
const EXCLUDED_PATH_SEGMENTS = [
  // Admin/Backend
  'wp-admin', 'admin', 'administrator', 'backend', 'dashboard',
  'wp-login', 'wp-json',
  // User accounts
  'login', 'logout', 'signin', 'signout', 'signup', 'register',
  'account', 'my-account', 'profile', 'settings', 'preferences',
  'password', 'reset-password', 'forgot-password',
  // E-commerce non-indexable
  'cart', 'checkout', 'basket', 'wishlist', 'compare',
  'add-to-cart', 'remove-from-cart', 'order-confirmation',
  'order-tracking', 'payment',
  // Search and filters (internal search is usually noindexed)
  'search', 'filter', 'results',
  // Print/Share versions
  'print', 'email-friend', 'share',
  // Calendar/Events
  'calendar', 'ical',
  // Feeds
  'feed', 'rss', 'atom',
  // API endpoints
  'api', 'graphql', 'rest',
  // Preview/Draft
  'preview', 'draft',
  // Private/Internal
  'private', 'internal', 'staging',
  // Comments
  'comment', 'comments', 'reply',
  // Tags/Authors (often thin content or duplicates)
  'tag', 'author', 'tags', 'authors',
]

// Patterns that use substring matching (for paths like /wp-content/uploads)
const EXCLUDED_PATH_SUBSTRINGS = [
  '/wp-content/uploads',
  '/wp-login.php',
]

// Non-SEO query parameters to exclude
const EXCLUDED_QUERY_PARAMS = [
  // Pagination (complex pagination often creates duplicate content)
  'page', 'p', 'paged', 'pg', 'offset',
  // Sorting/Filtering (creates duplicate content)
  'sort', 'sortby', 'order', 'orderby', 'filter', 'filters',
  // Session/Tracking
  'sessionid', 'session_id', 'sid', 'phpsessid', 'jsessionid',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'msclkid', 'dclid', 'zanpid', 'ref', 'affiliate',
  'mc_cid', 'mc_eid', '_ga', '_gl', 'yclid', 'ymclid',
  // Preview/Debug
  'preview', 'draft', 'debug', 'test',
  // Print/Format
  'print', 'format', 'output', 'pdf',
  // Reply/Comments
  'replytocom', 'reply', 'comment',
  // Cart/Checkout
  'add-to-cart', 'remove-item', 'quantity', 'coupon',
  // Search
  'q', 's', 'search', 'query', 'keyword', 'keywords',
  // Login/Auth
  'redirect', 'redirect_to', 'return', 'return_to', 'next',
  // View modes
  'view', 'display', 'layout', 'mode',
  // Comparison/Wishlist
  'compare', 'wishlist', 'add-to-wishlist',
  // Versioning
  'v', 'ver', 'version', 'rev',
  // Timestamps (cache busting)
  't', 'ts', 'timestamp', 'cache', '_',
]

export interface SeoFilterResult {
  isRelevant: boolean
  reason?: string
}

/**
 * Check if a URL is SEO-relevant (affects SEO)
 * Filters out non-HTML resources, pagination, tracking, admin, and other non-SEO URLs
 */
/**
 * Check if a path segment matches any excluded segment
 */
function hasExcludedPathSegment(pathname: string): string | null {
  // Split path into segments and check each one
  const segments = pathname.split('/').filter(s => s.length > 0)

  for (const segment of segments) {
    if (EXCLUDED_PATH_SEGMENTS.includes(segment)) {
      return segment
    }
  }

  return null
}

export function isSeoRelevantUrl(url: string): SeoFilterResult {
  try {
    const parsed = new URL(url)
    const pathname = parsed.pathname.toLowerCase()

    // Check file extension
    for (const ext of NON_HTML_EXTENSIONS) {
      if (pathname.endsWith(ext)) {
        return { isRelevant: false, reason: `Non-HTML file extension: ${ext}` }
      }
    }

    // Check path segments (exact match)
    const excludedSegment = hasExcludedPathSegment(pathname)
    if (excludedSegment) {
      return { isRelevant: false, reason: `Excluded path segment: ${excludedSegment}` }
    }

    // Check path substrings (for patterns like /wp-content/uploads)
    for (const pattern of EXCLUDED_PATH_SUBSTRINGS) {
      if (pathname.includes(pattern)) {
        return { isRelevant: false, reason: `Excluded path pattern: ${pattern}` }
      }
    }

    // Check query parameters
    const params = parsed.searchParams
    for (const param of EXCLUDED_QUERY_PARAMS) {
      if (params.has(param)) {
        return { isRelevant: false, reason: `Excluded query parameter: ${param}` }
      }
    }

    return { isRelevant: true }
  } catch {
    return { isRelevant: false, reason: 'Invalid URL' }
  }
}

/**
 * Simple boolean check for SEO relevance
 */
export function isSeoRelevant(url: string): boolean {
  return isSeoRelevantUrl(url).isRelevant
}

// Export constants for testing
export const SEO_FILTER_CONFIG = {
  nonHtmlExtensions: NON_HTML_EXTENSIONS,
  excludedPathPatterns: EXCLUDED_PATH_SEGMENTS,
  excludedPathSubstrings: EXCLUDED_PATH_SUBSTRINGS,
  excludedQueryParams: EXCLUDED_QUERY_PARAMS,
}
