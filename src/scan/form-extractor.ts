/**
 * Primary-form extractor for HIPAA deep scans.
 *
 * Heuristic: the first <form> that contains any of:
 *   - <input type="email">
 *   - a field whose name/id contains "phone"
 *   - a label whose text matches /appointment|book|contact|patient/i
 *
 * is treated as the "primary contact/appointment" form. We capture:
 *   - fields: names/ids of every <input>, <select>, <textarea> (deduped)
 *   - action: the form's action attribute (resolved to absolute if possible)
 *   - hasHttps: true iff the resolved action URL is https://
 *
 * If no form matches, returns null. Used as AI input for PHI-flow inference
 * — do NOT include field *values*, only field identifiers.
 */
import * as cheerio from 'cheerio'

export interface FormSummary {
  fields: string[]
  action: string
  hasHttps: boolean
}

// Cheerio wrapper around a single form element. We pass the wrapper rather
// than the raw DOM node so we never have to name cheerio's internal Element
// type (which isn't re-exported in v1.x).
type FormWrap = ReturnType<cheerio.CheerioAPI>

const LABEL_RE = /appointment|book|contact|patient/i

function formLooksPrimary($form: FormWrap): boolean {
  if ($form.find('input[type="email" i]').length > 0) return true
  const phoneLike = $form
    .find('input, select, textarea')
    .toArray()
    .some((el) => {
      const $el = $form.find(el as never)
      const n = ($el.attr('name') ?? '').toLowerCase()
      const i = ($el.attr('id') ?? '').toLowerCase()
      return n.includes('phone') || i.includes('phone')
    })
  if (phoneLike) return true
  const labelHit = $form
    .find('label')
    .toArray()
    .some((el) => LABEL_RE.test($form.find(el as never).text() ?? ''))
  return labelHit
}

function collectFields($form: FormWrap): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  $form.find('input, select, textarea').each((_, el) => {
    const $el = $form.find(el as never)
    // Skip hidden CSRF-style fields — they're not PHI-bearing.
    const type = ($el.attr('type') ?? '').toLowerCase()
    if (type === 'hidden') return
    const name = ($el.attr('name') ?? '').trim()
    const id = ($el.attr('id') ?? '').trim()
    const key = name || id
    if (!key) return
    if (seen.has(key)) return
    seen.add(key)
    out.push(key)
  })
  return out
}

function resolveActionUrl(
  rawAction: string,
  pageUrl: string
): { action: string; hasHttps: boolean } {
  const action = (rawAction ?? '').trim()
  if (!action) {
    // Empty action means same-document submit — inherits page's protocol.
    try {
      const u = new URL(pageUrl)
      return { action: '', hasHttps: u.protocol === 'https:' }
    } catch {
      return { action: '', hasHttps: false }
    }
  }
  try {
    const u = new URL(action, pageUrl)
    return { action: u.toString(), hasHttps: u.protocol === 'https:' }
  } catch {
    return { action, hasHttps: false }
  }
}

/**
 * Extract the first matching primary form from the page DOM.
 * `pageUrl` is the absolute URL of the scanned page (used to resolve relative
 * form actions). Returns null if no form matches the heuristic.
 */
export function extractPrimaryForm(
  $: cheerio.CheerioAPI,
  pageUrl: string
): FormSummary | null {
  const $forms = $('form')
  const count = $forms.length
  for (let i = 0; i < count; i++) {
    const $form = $forms.eq(i) as unknown as FormWrap
    if (!formLooksPrimary($form)) continue
    const fields = collectFields($form)
    const rawAction = $form.attr('action') ?? ''
    const { action, hasHttps } = resolveActionUrl(rawAction, pageUrl)
    return { fields, action, hasHttps }
  }
  return null
}
