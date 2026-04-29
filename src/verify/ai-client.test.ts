import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  resolveProvider,
  resolveEager,
  getAiProvider,
  _resetAiProviderCacheForTests,
} from './ai-client.js'

describe('ai-client', () => {
  beforeEach(() => {
    _resetAiProviderCacheForTests()
  })

  it('resolveProvider returns disabled when no env set', () => {
    const p = resolveProvider({})
    expect(p.name).toBe('disabled')
  })

  it('resolveProvider picks gemini when GEMINI_API_KEY set', () => {
    const p = resolveProvider({ GEMINI_API_KEY: 'test-key' })
    expect(p.name).toMatch(/gemini/)
  })

  it('resolveProvider prefers gemini over deepseek over ollama', () => {
    const p = resolveProvider({
      GEMINI_API_KEY: 'g',
      DEEPSEEK_API_KEY: 'd',
      OLLAMA_HOST: 'http://localhost:11434',
    })
    expect(p.name).toMatch(/gemini/)
  })

  it('resolveEager returns a provider and is idempotent (same instance)', () => {
    const a = resolveEager()
    const b = resolveEager()
    const c = getAiProvider()
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('resolveEager logs AI provider line once', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      resolveEager()
      resolveEager()
      resolveEager()
      const aiLogCalls = spy.mock.calls.filter((args) =>
        args.some(
          (a) => typeof a === 'string' && a.includes('AI provider:')
        )
      )
      expect(aiLogCalls.length).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })
})
