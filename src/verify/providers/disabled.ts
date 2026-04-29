/**
 * Disabled provider (Epic 3).
 *
 * Returned whenever no AI env vars are configured, OR as the fallback stub
 * when another provider throws/times out. Synchronous-ish: resolves in ~0ms.
 *
 * Shape contract: all arrays empty, all records empty, score=0,
 * phiFormRiskLevel='none', provider='disabled'. Keeping this deterministic is
 * important because the scan row's `aiVerification` field is exposed to
 * downstream analytics and the tools-platform UI.
 */
import type { AiProvider, AiVerification } from '../types.js'

export function createDisabledProvider(): AiProvider {
  return {
    name: 'disabled',
    async classify(): Promise<AiVerification> {
      return zeroStub()
    },
  }
}

export function zeroStub(): AiVerification {
  return {
    privacyPolicyScore: 0,
    privacyPolicyMissing: [],
    phiFormRiskLevel: 'none',
    phiFormReasoning: '',
    unknownTrackerClassifications: {},
    provider: 'disabled',
    latencyMs: 0,
  }
}
