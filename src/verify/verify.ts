/**
 * AI verification orchestrator (Epic 3).
 *
 * Wraps a provider's classify() in a try/catch + outer timeout. On ANY error
 * (throw, timeout, bad JSON, network) returns the zero-value disabled stub
 * and logs at warn level. Never rethrows — AI is never allowed to fail the
 * deterministic scan.
 *
 * PII hygiene: logs only provider, score, latencyMs. Never logs the privacy
 * text or the raw AI response.
 */
import { logger } from '../utils/logger.js'
import type { AiVerification, AiProvider, DeepScanAiInput } from './types.js'
import { getAiProvider } from './ai-client.js'
import { zeroStub } from './providers/disabled.js'

const DEFAULT_OUTER_TIMEOUT_MS = 15_000
const OLLAMA_OUTER_TIMEOUT_MS = 30_000

function outerTimeoutMs(providerName: AiProvider['name']): number {
  const fromEnv = process.env.AI_VERIFY_TIMEOUT_MS
    ? parseInt(process.env.AI_VERIFY_TIMEOUT_MS, 10)
    : NaN
  const base = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_OUTER_TIMEOUT_MS
  return providerName === 'ollama-gemma-3-4b'
    ? Math.max(OLLAMA_OUTER_TIMEOUT_MS, base)
    : base
}

export interface RunAiVerificationDeps {
  provider?: AiProvider
}

export async function runAiVerification(
  input: DeepScanAiInput,
  deps: RunAiVerificationDeps = {}
): Promise<AiVerification> {
  const provider = deps.provider ?? getAiProvider()

  if (provider.name === 'disabled') {
    return zeroStub()
  }

  const started = Date.now()
  const timeoutMs = outerTimeoutMs(provider.name)

  try {
    const result = await Promise.race([
      provider.classify(input),
      new Promise<AiVerification>((_, reject) =>
        setTimeout(
          () => reject(new Error(`ai verification outer timeout after ${timeoutMs}ms`)),
          timeoutMs
        )
      ),
    ])
    // PII hygiene — log ONLY numeric + string metadata.
    logger.info(
      `[ai-verify] ok provider=${result.provider} score=${result.privacyPolicyScore} phi=${result.phiFormRiskLevel} latency_ms=${result.latencyMs}`
    )
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn(
      `[ai-verify] provider=${provider.name} failed after ${Date.now() - started}ms: ${message} — falling back to disabled stub`
    )
    return zeroStub()
  }
}
