/**
 * Verify orchestrator tests — covers all failure → disabled-stub transitions.
 */
import { describe, it, expect, vi } from 'vitest'
import { runAiVerification } from './verify.js'
import { createDisabledProvider, zeroStub } from './providers/disabled.js'
import { resolveProvider } from './ai-client.js'
import type { AiProvider, AiVerification } from './types.js'

const INPUT = {
  privacyPolicyText: '',
  detectedTrackers: [],
  unknownTrackerDomains: [],
  formSummary: null,
}

function mockProvider(
  name: AiProvider['name'],
  impl: () => Promise<AiVerification>
): AiProvider {
  return { name, classify: impl }
}

describe('runAiVerification', () => {
  it('returns disabled stub when provider is disabled', async () => {
    const out = await runAiVerification(INPUT, {
      provider: createDisabledProvider(),
    })
    expect(out).toEqual(zeroStub())
  })

  it('returns disabled stub when provider throws', async () => {
    const out = await runAiVerification(INPUT, {
      provider: mockProvider('gemini-2.5-flash', async () => {
        throw new Error('boom')
      }),
    })
    expect(out.provider).toBe('disabled')
    expect(out.privacyPolicyScore).toBe(0)
  })

  it('returns disabled stub when provider exceeds outer timeout', async () => {
    const prev = process.env.AI_VERIFY_TIMEOUT_MS
    process.env.AI_VERIFY_TIMEOUT_MS = '20'
    try {
      const out = await runAiVerification(INPUT, {
        provider: mockProvider(
          'deepseek-v3',
          () => new Promise<AiVerification>(() => {})
        ),
      })
      expect(out.provider).toBe('disabled')
    } finally {
      if (prev === undefined) delete process.env.AI_VERIFY_TIMEOUT_MS
      else process.env.AI_VERIFY_TIMEOUT_MS = prev
    }
  })

  it('returns provider result on happy path', async () => {
    const verdict: AiVerification = {
      privacyPolicyScore: 5,
      privacyPolicyMissing: [],
      phiFormRiskLevel: 'low',
      phiFormReasoning: 'ok.',
      unknownTrackerClassifications: {},
      provider: 'gemini-2.5-flash',
      latencyMs: 42,
    }
    const out = await runAiVerification(INPUT, {
      provider: mockProvider('gemini-2.5-flash', async () => verdict),
    })
    expect(out).toEqual(verdict)
  })

  it('short-circuits disabled provider without awaiting classify', async () => {
    const classify = vi.fn()
    const out = await runAiVerification(INPUT, {
      provider: { name: 'disabled', classify },
    })
    expect(classify).not.toHaveBeenCalled()
    expect(out.provider).toBe('disabled')
  })
})

describe('resolveProvider precedence', () => {
  it('Gemini wins when GEMINI_API_KEY set', () => {
    const p = resolveProvider({ GEMINI_API_KEY: 'g', DEEPSEEK_API_KEY: 'd' })
    expect(p.name).toBe('gemini-2.5-flash')
  })

  it('DeepSeek when Gemini absent', () => {
    const p = resolveProvider({ DEEPSEEK_API_KEY: 'd', OLLAMA_HOST: 'http://x' })
    expect(p.name).toBe('deepseek-v3')
  })

  it('Ollama when only OLLAMA_HOST present', () => {
    const p = resolveProvider({ OLLAMA_HOST: 'http://localhost:11434' })
    expect(p.name).toBe('ollama-gemma-3-4b')
  })

  it('disabled when nothing set', () => {
    const p = resolveProvider({})
    expect(p.name).toBe('disabled')
  })

  it('empty-string values are treated as unset', () => {
    const p = resolveProvider({ GEMINI_API_KEY: '   ', DEEPSEEK_API_KEY: '' })
    expect(p.name).toBe('disabled')
  })
})
