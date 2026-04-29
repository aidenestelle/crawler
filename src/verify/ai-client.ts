/**
 * AI provider factory (Epic 3).
 *
 * Hard-coded precedence (decided by CTO):
 *   GEMINI_API_KEY > DEEPSEEK_API_KEY > OLLAMA_HOST > disabled
 *
 * Logs which provider is active at boot with `[estellebot] AI provider: X`.
 * Boot log is emitted exactly once per process via module-level memoization —
 * subsequent getAiProvider() calls return the cached provider.
 */
import { logger } from '../utils/logger.js'
import type { AiProvider } from './types.js'
import { createGeminiProvider } from './providers/gemini.js'
import { createDeepseekProvider } from './providers/deepseek.js'
import { createOllamaProvider } from './providers/ollama.js'
import { createDisabledProvider } from './providers/disabled.js'

let cached: AiProvider | null = null

export interface AiClientEnv {
  GEMINI_API_KEY?: string
  DEEPSEEK_API_KEY?: string
  OLLAMA_HOST?: string
  OLLAMA_MODEL?: string
  AI_VERIFY_TIMEOUT_MS?: string
}

export function resolveProvider(env: AiClientEnv = process.env as AiClientEnv): AiProvider {
  const timeoutMs = env.AI_VERIFY_TIMEOUT_MS
    ? Math.max(1000, parseInt(env.AI_VERIFY_TIMEOUT_MS, 10) || 15_000)
    : undefined

  if (env.GEMINI_API_KEY && env.GEMINI_API_KEY.trim()) {
    return createGeminiProvider({ apiKey: env.GEMINI_API_KEY, timeoutMs })
  }
  if (env.DEEPSEEK_API_KEY && env.DEEPSEEK_API_KEY.trim()) {
    return createDeepseekProvider({ apiKey: env.DEEPSEEK_API_KEY, timeoutMs })
  }
  if (env.OLLAMA_HOST && env.OLLAMA_HOST.trim()) {
    // Ollama floor is 30s — AI_VERIFY_TIMEOUT_MS only raises, never lowers.
    const ollamaTimeout = timeoutMs !== undefined ? Math.max(30_000, timeoutMs) : undefined
    return createOllamaProvider({
      host: env.OLLAMA_HOST,
      model: env.OLLAMA_MODEL,
      timeoutMs: ollamaTimeout,
    })
  }
  return createDisabledProvider()
}

export function getAiProvider(): AiProvider {
  if (cached) return cached
  cached = resolveProvider()
  logger.info(`AI provider: ${cached.name}`)
  return cached
}

/**
 * Eager resolution — call once at process boot (src/index.ts) so the
 * `[estellebot] AI provider: X` line appears in logs at startup, not lazily
 * on first job. Idempotent: subsequent calls are no-ops (identical to
 * getAiProvider() after first call).
 */
export function resolveEager(): AiProvider {
  return getAiProvider()
}

/** Test seam — reset module-level cache between tests. */
export function _resetAiProviderCacheForTests(): void {
  cached = null
}
