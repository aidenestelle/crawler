/**
 * Gemini provider tests — fully offline, uses injected mock client.
 * Covers: success path + payload shape, parse-error, timeout.
 */
import { describe, it, expect, vi } from 'vitest'
import { createGeminiProvider, GEMINI_MODEL } from './gemini.js'

const INPUT = {
  privacyPolicyText: 'We follow HIPAA. No BAA mentioned.',
  detectedTrackers: [{ name: 'GA4', vendor: 'Google', exampleUrl: 'https://x' }],
  unknownTrackerDomains: ['cdn.unknownvendor.net'],
  formSummary: null,
}

const VALID_RESPONSE = {
  text: JSON.stringify({
    privacyPolicyScore: 3,
    privacyPolicyMissing: ['no BAA mention'],
    phiFormRiskLevel: 'low',
    phiFormReasoning: 'no form detected on the page.',
    unknownTrackerClassifications: {
      'cdn.unknownvendor.net': {
        likelyVendor: 'unknown',
        phiRisk: 'unknown',
        reasoning: 'no signal.',
      },
    },
  }),
}

describe('gemini provider', () => {
  it('success: sends expected model/config and parses JSON response', async () => {
    const generateContent = vi.fn().mockResolvedValue(VALID_RESPONSE)
    const provider = createGeminiProvider({
      apiKey: 'test',
      client: { models: { generateContent } },
    })

    const out = await provider.classify(INPUT)
    expect(out.provider).toBe('gemini-2.5-flash')
    expect(out.privacyPolicyScore).toBe(3)
    expect(out.privacyPolicyMissing).toEqual(['no BAA mention'])
    expect(out.phiFormRiskLevel).toBe('low')
    expect(out.latencyMs).toBeGreaterThanOrEqual(0)

    // Verify payload shape
    const call = generateContent.mock.calls[0]![0] as Record<string, unknown>
    expect(call.model).toBe(GEMINI_MODEL)
    const config = call.config as Record<string, unknown>
    expect(config.temperature).toBe(0.2)
    expect(config.responseMimeType).toBe('application/json')
    expect(config.responseSchema).toBeDefined()
    expect(config.systemInstruction).toContain('HIPAA')
  })

  it('parse-error: throws when model returns non-JSON', async () => {
    const generateContent = vi
      .fn()
      .mockResolvedValue({ text: 'sorry, I cannot comply' })
    const provider = createGeminiProvider({
      apiKey: 'test',
      client: { models: { generateContent } },
    })
    await expect(provider.classify(INPUT)).rejects.toThrow(/JSON/i)
  })

  it('timeout: aborts and throws after timeoutMs', async () => {
    const generateContent = vi.fn().mockImplementation(
      () => new Promise(() => {}) // never resolves
    )
    const provider = createGeminiProvider({
      apiKey: 'test',
      timeoutMs: 20,
      client: { models: { generateContent } },
    })
    await expect(provider.classify(INPUT)).rejects.toThrow(/timeout/i)
  })
})
