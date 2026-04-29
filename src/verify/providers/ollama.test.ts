/**
 * Ollama provider tests — fully offline with injected fetch.
 * Covers: success + format:json request shape, parse-error, timeout.
 */
import { describe, it, expect, vi } from 'vitest'
import { createOllamaProvider, OLLAMA_DEFAULT_MODEL } from './ollama.js'

const INPUT = {
  privacyPolicyText: '',
  detectedTrackers: [],
  unknownTrackerDomains: [],
  formSummary: null,
}

const VALID_CONTENT = JSON.stringify({
  privacyPolicyScore: 0,
  privacyPolicyMissing: ['no privacy policy detected'],
  phiFormRiskLevel: 'none',
  phiFormReasoning: '',
  unknownTrackerClassifications: {},
})

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response
}

describe('ollama provider', () => {
  it('success: POSTs to host/api/chat with format:json and default model', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ message: { content: VALID_CONTENT } })
    )
    const provider = createOllamaProvider({
      host: 'http://localhost:11434/',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const out = await provider.classify(INPUT)
    expect(out.provider).toBe('ollama-gemma-3-4b')
    expect(out.privacyPolicyScore).toBe(0)

    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('http://localhost:11434/api/chat')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.format).toBe('json')
    expect(body.stream).toBe(false)
    expect(body.model).toBe(OLLAMA_DEFAULT_MODEL)
    expect(body.options).toEqual({ temperature: 0.2 })
  })

  it('parse-error: throws on bad JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ message: { content: '<not json>' } })
    )
    const provider = createOllamaProvider({
      host: 'http://localhost:11434',
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
    const provider = createOllamaProvider({
      host: 'http://localhost:11434',
      timeoutMs: 20,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await expect(provider.classify(INPUT)).rejects.toThrow()
  })

  it('custom model override is used', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ message: { content: VALID_CONTENT } })
    )
    const provider = createOllamaProvider({
      host: 'http://localhost:11434',
      model: 'llama3:8b',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await provider.classify(INPUT)
    const body = JSON.parse(
      (fetchImpl.mock.calls[0]![1] as RequestInit).body as string
    )
    expect(body.model).toBe('llama3:8b')
  })
})
