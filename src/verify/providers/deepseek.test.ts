/**
 * DeepSeek provider tests — fully offline with injected fetch.
 * Covers: success + payload/header shape, parse-error, timeout.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  createDeepseekProvider,
  DEEPSEEK_MODEL,
  DEEPSEEK_ENDPOINT,
} from './deepseek.js'

const INPUT = {
  privacyPolicyText: 'policy',
  detectedTrackers: [],
  unknownTrackerDomains: [],
  formSummary: null,
}

const VALID_CONTENT = JSON.stringify({
  privacyPolicyScore: 4,
  privacyPolicyMissing: [],
  phiFormRiskLevel: 'none',
  phiFormReasoning: 'no form.',
  unknownTrackerClassifications: {},
})

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response
}

describe('deepseek provider', () => {
  it('success: POSTs to DeepSeek endpoint with bearer + json_object mode', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ choices: [{ message: { content: VALID_CONTENT } }] })
    )
    const provider = createDeepseekProvider({
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const out = await provider.classify(INPUT)
    expect(out.provider).toBe('deepseek-v3')
    expect(out.privacyPolicyScore).toBe(4)

    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe(DEEPSEEK_ENDPOINT)
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-test')
    expect(headers['content-type']).toBe('application/json')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.model).toBe(DEEPSEEK_MODEL)
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.temperature).toBe(0.2)
    expect(body.messages[0].role).toBe('system')
  })

  it('parse-error: throws when content is not valid JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ choices: [{ message: { content: 'not json' } }] })
    )
    const provider = createDeepseekProvider({
      apiKey: 'sk',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await expect(provider.classify(INPUT)).rejects.toThrow(/JSON/i)
  })

  it('timeout: aborts and throws after timeoutMs', async () => {
    const fetchImpl = vi.fn().mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        const signal = (init as RequestInit).signal
        signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    })
    const provider = createDeepseekProvider({
      apiKey: 'sk',
      timeoutMs: 20,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await expect(provider.classify(INPUT)).rejects.toThrow()
  })

  it('http error: throws on non-2xx response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as unknown as Response)
    const provider = createDeepseekProvider({
      apiKey: 'sk',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await expect(provider.classify(INPUT)).rejects.toThrow(/500/)
  })
})
