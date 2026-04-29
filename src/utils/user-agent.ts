/**
 * Shared User-Agent constant for all outbound requests from Estellebot
 * (Playwright scan page, privacy-policy text fetch, any future fetch).
 * Keep this string stable — site operators filter on it.
 */
export const ESTELLEBOT_USER_AGENT =
  'Estellebot/1.0 (+https://estelledigitaldesigns.com/bot)'
