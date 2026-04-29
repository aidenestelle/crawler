/**
 * Ollama provider (Epic 3).
 *
 * Uses raw fetch against `${OLLAMA_HOST}/api/chat`. Model default: gemma3:4b
 * (override via OLLAMA_MODEL). format:'json' forces valid JSON output.
 * 30s timeout because local CPU inference is slow.
 *
 * Throws on any error; verify.ts wraps into the disabled stub.
 */
import type { AiProvider, AiVerification, DeepScanAiInput } from '../types.js'
import { SYSTEM_PROMPT, buildUserPayload } from '../prompt.js'
import { parseAiJson } from '../parse.js'

export const OLLAMA_DEFAULT_MODEL = 'gemma3:4b'
const DEFAULT_TIMEOUT_MS = 30_000

export interface OllamaProviderDeps {
  host: string
  model?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export function createOllamaProvider(deps: OllamaProviderDeps): AiProvider {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const model = deps.model ?? OLLAMA_DEFAULT_MODEL
  const doFetch = deps.fetchImpl ?? fetch
  const host = deps.host.replace(/\/+$/, '')

  return {
    name: 'ollama-gemma-3-4b',
    async classify(input: DeepScanAiInput): Promise<AiVerification> {
      const started = Date.now()
      const payload = buildUserPayload(input)

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      try {
        const res = await doFetch(`${host}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            stream: false,
            format: 'json',
            options: { temperature: 0.2 },
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: JSON.stringify(payload) },
            ],
          }),
          signal: controller.signal,
        })

        if (!res.ok) {
          throw new Error(`ollama http ${res.status}`)
        }
        const body = (await res.json()) as {
          message?: { content?: string }
        }
        const text = body?.message?.content ?? ''
        const parsed = parseAiJson(text)

        return {
          ...parsed,
          provider: 'ollama-gemma-3-4b',
          latencyMs: Date.now() - started,
        }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
