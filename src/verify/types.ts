/**
 * AI verification types (Epic 3).
 *
 * Shape mirrors spec.md §AI verification interface. This is strictly additive
 * on the deterministic scan result — the tools-platform UI ignores unknown
 * fields today, and Epic 4 will surface them.
 */
import type { DeepScanAiInput } from '../handlers/hipaa-deep-scan.js'

export type AiProviderName =
  | 'gemini-2.5-flash'
  | 'deepseek-v3'
  | 'ollama-gemma-3-4b'
  | 'disabled'

export interface UnknownTrackerClassification {
  likelyVendor: string
  phiRisk: 'high' | 'medium' | 'low' | 'unknown'
  reasoning: string
}

export interface AiVerification {
  privacyPolicyScore: 0 | 1 | 2 | 3 | 4 | 5
  privacyPolicyMissing: string[]
  phiFormRiskLevel: 'high' | 'medium' | 'low' | 'none'
  phiFormReasoning: string
  unknownTrackerClassifications: Record<string, UnknownTrackerClassification>
  provider: AiProviderName
  latencyMs: number
}

export interface AiProvider {
  name: AiProviderName
  classify(input: DeepScanAiInput): Promise<AiVerification>
}

export type { DeepScanAiInput }
