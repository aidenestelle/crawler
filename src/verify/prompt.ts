/**
 * Shared system prompt + user-turn builder for AI verification (Epic 3).
 *
 * Kept under ~2k tokens. Provider-agnostic — each provider supplies its own
 * transport + response-parsing, but the instructions are identical so the
 * outputs are comparable.
 *
 * PII hygiene: this module is the ONLY place the raw privacy text enters the
 * prompt payload. Callers must not log it.
 */
import type { DeepScanAiInput } from '../handlers/hipaa-deep-scan.js'

export const SYSTEM_PROMPT = `You are a HIPAA compliance auditor evaluating a healthcare website for patient privacy risk. You will receive (a) the site's privacy policy text, (b) a summary of its primary patient-contact form, and (c) a list of detected + unknown third-party trackers loaded at runtime.

Return STRICT JSON matching this TypeScript interface:
{
  "privacyPolicyScore": 0|1|2|3|4|5,
  "privacyPolicyMissing": string[],
  "phiFormRiskLevel": "high"|"medium"|"low"|"none",
  "phiFormReasoning": string,
  "unknownTrackerClassifications": { [domain: string]: { "likelyVendor": string, "phiRisk": "high"|"medium"|"low"|"unknown", "reasoning": string } }
}

Rubric — privacyPolicyScore (0..5):
  0 = no privacy policy text provided (empty).
  1 = generic privacy policy, no HIPAA awareness.
  2 = mentions HIPAA but does not address PHI handling by third parties or trackers.
  3 = addresses PHI + some third-party data sharing, but no BAA language and no patient-rights section.
  4 = covers HIPAA, third parties, patient rights, but missing at least one of: BAA references, breach notification, data retention.
  5 = comprehensive: HIPAA scope, BAA(s) referenced, patient rights (access/amend/accounting), breach notification, retention, explicit tracker / analytics carve-outs.

privacyPolicyMissing: short phrases describing what is absent (e.g. "no BAA mention", "no patient rights section", "no breach notification window", "no analytics disclosure"). Empty array if score >=5.

phiFormRiskLevel — considers the form summary only:
  high   = form collects obvious PHI (symptoms, conditions, medications, DOB + name + contact) AND action URL looks third-party or non-HTTPS.
  medium = form collects PHI fields but posts to first-party HTTPS; OR collects contact-only but embeds third-party tracking on the page.
  low    = contact/appointment form with no clinical fields, first-party HTTPS action.
  none   = no form, or marketing-only form with no PHI-adjacent fields.

phiFormReasoning: one or two sentences citing the specific fields / action URL you weighed.

unknownTrackerClassifications: for EACH domain in unknownTrackerDomains, produce one entry keyed by the domain. likelyVendor is your best guess ("unknown" is allowed). phiRisk reflects HIPAA exposure if PHI form fields were ever posted through this domain. reasoning <= 1 sentence.

Output rules:
  - Output ONLY valid JSON. No prose, no markdown fences.
  - Do not invent fields. Do not omit required fields.
  - If privacyPolicyText is empty, score=0, missing=["no privacy policy detected"].
  - If unknownTrackerDomains is empty, unknownTrackerClassifications={}.`

export interface PromptPayload {
  privacyPolicyText: string
  privacyPolicyBytes: number
  formSummary: DeepScanAiInput['formSummary']
  detectedTrackers: DeepScanAiInput['detectedTrackers']
  unknownTrackerDomains: string[]
}

/**
 * Build the user-turn JSON payload. The privacy text is included verbatim —
 * callers are responsible for (a) never logging the result of this function
 * and (b) relying on upstream caps (20KB) already applied.
 */
export function buildUserPayload(input: DeepScanAiInput): PromptPayload {
  return {
    privacyPolicyText: input.privacyPolicyText ?? '',
    privacyPolicyBytes: (input.privacyPolicyText ?? '').length,
    formSummary: input.formSummary,
    detectedTrackers: input.detectedTrackers ?? [],
    unknownTrackerDomains: input.unknownTrackerDomains ?? [],
  }
}

/** JSON schema used by Gemini structured-output mode. */
export const RESPONSE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    privacyPolicyScore: { type: 'integer', minimum: 0, maximum: 5 },
    privacyPolicyMissing: { type: 'array', items: { type: 'string' } },
    phiFormRiskLevel: {
      type: 'string',
      enum: ['high', 'medium', 'low', 'none'],
    },
    phiFormReasoning: { type: 'string' },
    unknownTrackerClassifications: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: {
          likelyVendor: { type: 'string' },
          phiRisk: {
            type: 'string',
            enum: ['high', 'medium', 'low', 'unknown'],
          },
          reasoning: { type: 'string' },
        },
        required: ['likelyVendor', 'phiRisk', 'reasoning'],
      },
    },
  },
  required: [
    'privacyPolicyScore',
    'privacyPolicyMissing',
    'phiFormRiskLevel',
    'phiFormReasoning',
    'unknownTrackerClassifications',
  ],
} as const
