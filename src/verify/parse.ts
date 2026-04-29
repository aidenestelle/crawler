/**
 * Parse + validate AI JSON responses (Epic 3).
 *
 * Shared by all providers so a mangled response from any provider produces
 * the same thrown error that verify.ts converts into the disabled stub.
 *
 * We validate structurally but are permissive on trailing markdown code
 * fences — some providers wrap JSON in ```json blocks despite instructions.
 */
import type { AiVerification, UnknownTrackerClassification } from './types.js'

const PHI_RISK_VALUES = new Set(['high', 'medium', 'low', 'unknown'])
const PHI_FORM_RISK_VALUES = new Set(['high', 'medium', 'low', 'none'])

export function stripCodeFence(s: string): string {
  const trimmed = s.trim()
  if (trimmed.startsWith('```')) {
    const withoutOpen = trimmed.replace(/^```(?:json)?\s*\n?/i, '')
    return withoutOpen.replace(/\n?```\s*$/i, '').trim()
  }
  return trimmed
}

export function parseAiJson(
  raw: string
): Omit<AiVerification, 'provider' | 'latencyMs'> {
  if (!raw || typeof raw !== 'string') {
    throw new Error('empty ai response')
  }
  const clean = stripCodeFence(raw)
  let obj: unknown
  try {
    obj = JSON.parse(clean)
  } catch (err) {
    throw new Error(`ai response not valid JSON: ${(err as Error).message}`)
  }
  if (!obj || typeof obj !== 'object') {
    throw new Error('ai response not an object')
  }
  const o = obj as Record<string, unknown>

  const score = o.privacyPolicyScore
  if (typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > 5) {
    throw new Error(`privacyPolicyScore invalid: ${String(score)}`)
  }

  const missing = Array.isArray(o.privacyPolicyMissing)
    ? (o.privacyPolicyMissing as unknown[]).filter((x): x is string => typeof x === 'string')
    : []

  const phiFormRiskLevel = String(o.phiFormRiskLevel)
  if (!PHI_FORM_RISK_VALUES.has(phiFormRiskLevel)) {
    throw new Error(`phiFormRiskLevel invalid: ${phiFormRiskLevel}`)
  }

  const phiFormReasoning =
    typeof o.phiFormReasoning === 'string' ? o.phiFormReasoning : ''

  const classificationsRaw = (o.unknownTrackerClassifications ?? {}) as Record<string, unknown>
  const classifications: Record<string, UnknownTrackerClassification> = {}
  if (classificationsRaw && typeof classificationsRaw === 'object') {
    for (const [domain, val] of Object.entries(classificationsRaw)) {
      if (!val || typeof val !== 'object') continue
      const v = val as Record<string, unknown>
      const risk = typeof v.phiRisk === 'string' && PHI_RISK_VALUES.has(v.phiRisk) ? (v.phiRisk as UnknownTrackerClassification['phiRisk']) : 'unknown'
      classifications[domain] = {
        likelyVendor: typeof v.likelyVendor === 'string' ? v.likelyVendor : 'unknown',
        phiRisk: risk,
        reasoning: typeof v.reasoning === 'string' ? v.reasoning : '',
      }
    }
  }

  return {
    privacyPolicyScore: score as 0 | 1 | 2 | 3 | 4 | 5,
    privacyPolicyMissing: missing,
    phiFormRiskLevel: phiFormRiskLevel as AiVerification['phiFormRiskLevel'],
    phiFormReasoning,
    unknownTrackerClassifications: classifications,
  }
}
