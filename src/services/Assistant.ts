import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type { Env } from "../Bindings.ts"
import { chatCompletionsUrl } from "./Classifier.ts"

/**
 * A language model for the mailbox and audience helpers (HAL-3305): thread summaries, reply drafts,
 * inbound categories and segments from a sentence. Behind a service, like the spam Classifier, so it
 * can be Workers AI (through AI Gateway when one is named), any OpenAI-compatible endpoint, or
 * nothing, the default, and so Mailyard runs off Cloudflare too.
 *
 * It never fails what called it: a timeout, an error or no provider answers `text: null`, and the
 * caller says the helper had nothing.
 */

export type AssistantFeature = "summary" | "draft" | "category" | "segment"

export interface AssistantRequest {
  readonly feature: AssistantFeature
  readonly system: string
  readonly user: string
  readonly maxTokens: number
  /** Ask for a JSON object. */
  readonly json?: boolean
}

export interface AssistantReply {
  readonly text: string | null
  readonly source: "off" | "workers-ai" | "openai" | "fixed"
  readonly model: string | null
  readonly inputTokens: number
  readonly outputTokens: number
  /** Workers AI's own unit of cost, when it reports one. */
  readonly neurons: number | null
}

/**
 * The newest small text model on Workers AI, measured 2026-10-18 against the account's model
 * catalogue (`@cf/zai-org/glm-4.7-flash`, added 2026-01-28). Run with thinking off, which it needs
 * for short answers: a one-sentence summary came back in 14 tokens. ASSISTANT_MODEL overrides it.
 */
export const DEFAULT_ASSISTANT_MODEL = "@cf/zai-org/glm-4.7-flash"

const nothing = (source: AssistantReply["source"], model: string | null): AssistantReply => ({
  text: null,
  source,
  model,
  inputTokens: 0,
  outputTokens: 0,
  neurons: null,
})

type Usage = { prompt_tokens?: number; completion_tokens?: number; neurons?: number } | undefined

/** The answer text out of either reply shape Workers AI gives (`response`, or OpenAI's `choices`). */
export const replyText = (reply: unknown): string | null => {
  if (typeof reply === "string") return reply.trim() || null
  const r = reply as {
    response?: unknown
    choices?: Array<{ message?: { content?: unknown } }>
  } | null
  if (typeof r?.response === "string") return r.response.trim() || null
  if (r?.response && typeof r.response === "object") return JSON.stringify(r.response)
  const content = r?.choices?.[0]?.message?.content
  return typeof content === "string" ? content.trim() || null : null
}

const usageOf = (reply: unknown) => {
  const usage = (reply as { usage?: Usage } | null)?.usage
  return {
    inputTokens: Math.max(0, Math.round(usage?.prompt_tokens ?? 0)),
    outputTokens: Math.max(0, Math.round(usage?.completion_tokens ?? 0)),
    neurons: typeof usage?.neurons === "number" ? usage.neurons : null,
  }
}

export class Assistant extends Context.Service<
  Assistant,
  {
    /** Which provider answers; `off` when none is configured. */
    readonly source: AssistantReply["source"]
    readonly model: string | null
    complete(request: AssistantRequest): Effect.Effect<AssistantReply>
  }
>()("mailyard/Assistant") {
  static readonly layerOff = Layer.succeed(
    Assistant,
    Assistant.of({ source: "off", model: null, complete: () => Effect.succeed(nothing("off", null)) }),
  )

  /** Answers from `answers` by feature (a function sees the request); for tests. */
  static readonly layerFixed = (
    answers: Partial<Record<AssistantFeature, string | ((request: AssistantRequest) => string)>>,
  ) =>
    Layer.succeed(
      Assistant,
      Assistant.of({
        source: "fixed",
        model: "fixed",
        complete: (request) =>
          Effect.sync(() => {
            const answer = answers[request.feature]
            const text = typeof answer === "function" ? answer(request) : (answer ?? null)
            return {
              text,
              source: "fixed",
              model: "fixed",
              inputTokens: Math.ceil((request.system.length + request.user.length) / 4),
              outputTokens: Math.ceil((text ?? "").length / 4),
              neurons: null,
            }
          }),
      }),
    )

  static readonly layerWorkersAi = (ai: Ai, model: string, gateway: string | undefined) =>
    Layer.succeed(
      Assistant,
      Assistant.of({
        source: "workers-ai",
        model,
        complete: (request) =>
          Effect.tryPromise(() =>
            ai.run(
              model as keyof AiModels,
              {
                messages: [
                  { role: "system", content: request.system },
                  { role: "user", content: request.user },
                ],
                max_tokens: request.maxTokens,
                temperature: 0.2,
                // Reasoning models spend the whole budget thinking otherwise.
                chat_template_kwargs: { enable_thinking: false },
                ...(request.json ? { response_format: { type: "json_object" } } : {}),
              } as never,
              gateway ? ({ gateway: { id: gateway } } as never) : undefined,
            ),
          ).pipe(
            Effect.timeout("20 seconds"),
            Effect.map(
              (reply): AssistantReply => ({
                text: replyText(reply),
                source: "workers-ai",
                model,
                ...usageOf(reply),
              }),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning(`assistant: Workers AI gave no ${request.feature}`, cause).pipe(
                Effect.as(nothing("workers-ai", model)),
              ),
            ),
          ),
      }),
    )

  static readonly layerOpenAi = (config: {
    readonly url: string
    readonly model: string
    readonly apiKey: string | undefined
  }) =>
    Layer.succeed(
      Assistant,
      Assistant.of({
        source: "openai",
        model: config.model,
        complete: (request) =>
          Effect.tryPromise(async () => {
            const response = await fetch(chatCompletionsUrl(config.url), {
              method: "POST",
              headers: {
                "content-type": "application/json",
                ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
              },
              body: JSON.stringify({
                model: config.model,
                messages: [
                  { role: "system", content: request.system },
                  { role: "user", content: request.user },
                ],
                max_tokens: request.maxTokens,
                temperature: 0.2,
                ...(request.json ? { response_format: { type: "json_object" } } : {}),
              }),
              signal: AbortSignal.timeout(20_000),
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            return (await response.json()) as unknown
          }).pipe(
            Effect.map(
              (reply): AssistantReply => ({
                text: replyText(reply),
                source: "openai",
                model: config.model,
                ...usageOf(reply),
              }),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning(
                `assistant: the OpenAI-compatible endpoint gave no ${request.feature}`,
                cause,
              ).pipe(Effect.as(nothing("openai", config.model))),
            ),
          ),
      }),
    )

  /**
   * Chosen by MAILYARD_ASSISTANT: `workers-ai` (the AI binding; AI_GATEWAY_ID routes it through a
   * gateway, ASSISTANT_MODEL picks the model), `openai` (ASSISTANT_URL, ASSISTANT_MODEL,
   * ASSISTANT_API_KEY), `fixed` (ASSISTANT_FIXED, for tests), or `off`, the default. Misconfiguration
   * falls back to off.
   */
  static readonly fromEnv = (env: Env) => {
    const mode = env.MAILYARD_ASSISTANT ?? "off"
    if (mode === "fixed") {
      let answers: Partial<Record<AssistantFeature, string>> = {}
      try {
        answers = JSON.parse(env.ASSISTANT_FIXED ?? "{}") as typeof answers
      } catch {
        answers = {}
      }
      return Assistant.layerFixed(answers)
    }
    if (mode === "workers-ai" && env.AI)
      return Assistant.layerWorkersAi(
        env.AI,
        env.ASSISTANT_MODEL ?? DEFAULT_ASSISTANT_MODEL,
        env.AI_GATEWAY_ID,
      )
    if (mode === "openai" && env.ASSISTANT_URL && env.ASSISTANT_MODEL)
      return Assistant.layerOpenAi({
        url: env.ASSISTANT_URL,
        model: env.ASSISTANT_MODEL,
        apiKey: env.ASSISTANT_API_KEY,
      })
    return Assistant.layerOff
  }
}
