/**
 * Gemini provider (Epic 3).
 *
 * Uses @google/genai SDK. Model: gemini-2.5-flash. Structured output via
 * responseSchema + responseMimeType='application/json'. Temperature 0.2 for
 * determinism. 15s hard timeout via AbortController.
 *
 * Throws on ANY error (bad JSON, timeout, SDK failure). The verify.ts wrapper
 * catches + falls back to the disabled stub.
 */
import { GoogleGenAI } from '@google/genai'
import type { AiProvider, AiVerification, DeepScanAiInput } from '../types.js'
import {
  SYSTEM_PROMPT,
  RESPONSE_JSON_SCHEMA,
  buildUserPayload,
} from '../prompt.js'
import { parseAiJson } from '../parse.js'

export const GEMINI_MODEL = 'gemini-2.5-flash'
const DEFAULT_TIMEOUT_MS = 15_000

export interface GeminiProviderDeps {
  apiKey: string
  timeoutMs?: number
  /** Test seam — inject a mock GoogleGenAI-like client. */
  client?: {
    models: {
      generateContent: (args: unknown) => Promise<{ text?: string | null }>
    }
  }
}

export function createGeminiProvider(deps: GeminiProviderDeps): AiProvider {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const client =
    deps.client ?? (new GoogleGenAI({ apiKey: deps.apiKey }) as unknown as GeminiProviderDeps['client'])

  return {
    name: 'gemini-2.5-flash',
    async classify(input: DeepScanAiInput): Promise<AiVerification> {
      const started = Date.now()
      const payload = buildUserPayload(input)

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      try {
        const genPromise = client!.models.generateContent({
          model: GEMINI_MODEL,
          contents: [
            {
              role: 'user',
              parts: [{ text: JSON.stringify(payload) }],
            },
          ],
          config: {
            systemInstruction: SYSTEM_PROMPT,
            temperature: 0.2,
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_JSON_SCHEMA,
            abortSignal: controller.signal,
          },
        })

        const response = await Promise.race([
          genPromise,
          new Promise<never>((_, reject) => {
            controller.signal.addEventListener('abort', () => {
              reject(new Error('gemini timeout'))
            })
          }),
        ])

        const text = response?.text ?? ''
        const parsed = parseAiJson(text)

        return {
          ...parsed,
          provider: 'gemini-2.5-flash',
          latencyMs: Date.now() - started,
        }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
