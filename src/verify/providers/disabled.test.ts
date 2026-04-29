/**
 * Disabled provider tests — confirms zero-value stub contract.
 */
import { describe, it, expect } from 'vitest'
import { createDisabledProvider, zeroStub } from './disabled.js'

const EMPTY_INPUT = {
  privacyPolicyText: '',
  detectedTrackers: [],
  unknownTrackerDomains: [],
  formSummary: null,
}

describe('disabled provider', () => {
  it('returns zero-value stub with name=disabled', async () => {
    const p = createDisabledProvider()
    expect(p.name).toBe('disabled')
    const out = await p.classify(EMPTY_INPUT)
    expect(out).toEqual({
      privacyPolicyScore: 0,
      privacyPolicyMissing: [],
      phiFormRiskLevel: 'none',
      phiFormReasoning: '',
      unknownTrackerClassifications: {},
      provider: 'disabled',
      latencyMs: 0,
    })
  })

  it('zeroStub is idempotent and safe to reuse', () => {
    const a = zeroStub()
    const b = zeroStub()
    expect(a).toEqual(b)
    // Verify mutating one does not affect the other (defensive).
    a.privacyPolicyMissing.push('tampered')
    expect(b.privacyPolicyMissing).toEqual([])
  })

  it('stub shape matches AiVerification contract', () => {
    const s = zeroStub()
    expect(typeof s.privacyPolicyScore).toBe('number')
    expect(Array.isArray(s.privacyPolicyMissing)).toBe(true)
    expect(['high', 'medium', 'low', 'none']).toContain(s.phiFormRiskLevel)
    expect(typeof s.unknownTrackerClassifications).toBe('object')
  })
})
