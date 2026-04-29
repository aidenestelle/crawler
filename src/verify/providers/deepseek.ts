/**
 * DeepSeek provider (Epic 3).
 *
 * Uses raw fetch against DeepSeek's OpenAI-compatible chat completions
 * endpoint. Model: deepseek-chat. response_format: { type: 'json_object' }
 * to keep outputs strictly JSON. 15s hard timeout via AbortController.
 *
 * Throws on any error; verify.ts wraps into the disabled stub.
 */
import type { AiProvider, AiVerification, DeepScanAiInput } from '../types.js'
import { SYSTEM_PROMPT, buildUserPayload } from '../prompt.js'
import { parseAiJson } from '../parse.js'

export const DEEPSEEK_MODEL = 'deepseek-chat'
export const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions'
const DEFAULT_TIMEOUT_MS = 15_000

export interface DeepseekProviderDeps {
  apiKey: string
  timeoutMs?: number
  endpoint?: string
  /** Test seam — inject a fetch impl. */
  fetchImpl?: typeof fetch
}

export function createDeepseekProvider(deps: DeepseekProviderDeps): AiProvider {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const endpoint = deps.endpoint ?? DEEPSEEK_ENDPOINT
  const doFetch = deps.fetchImpl ?? fetch

  return {
    name: 'deepseek-v3',
    async classify(input: DeepScanAiInput): Promise<AiVerification> {
      const started = Date.now()
      const payload = buildUserPayload(input)

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      try {
        const res = await doFetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${deps.apiKey}`,
          },
          body: JSON.stringify({
            model: DEEPSEEK_MODEL,
            temperature: 0.2,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: JSON.stringify(payload) },
            ],
          }),
          signal: controller.signal,
        })

        if (!res.ok) {
          throw new Error(`deepseek http ${res.status}`)
        }
        const body = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>
        }
        const text = body?.choices?.[0]?.message?.content ?? ''
        const parsed = parseAiJson(text)

        return {
          ...parsed,
          provider: 'deepseek-v3',
          latencyMs: Date.now() - started,
        }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
