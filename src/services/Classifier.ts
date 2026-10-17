import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type { Env } from "../Bindings.ts"

/**
 * An opinion on whether a message is spam, behind a service so it can be Workers AI, any
 * OpenAI-compatible endpoint, or nothing (the default), and so it can run off Cloudflare.
 * It only ever adds evidence: a failure or a timeout means "no opinion", never a lost message.
 */
export interface ClassifyInput {
  readonly from: string
  readonly subject: string
  /** The start of the plain text; the classifier never sees attachments. */
  readonly text: string
}

export interface Verdict {
  /** 0 (certainly not spam) to 1 (certainly spam), or null when there's no opinion. */
  readonly spamProbability: number | null
  readonly source: "off" | "workers-ai" | "openai" | "fixed"
}

export const NO_OPINION = (source: Verdict["source"]): Verdict => ({ spamProbability: null, source })

/** What the model sees: enough to judge, little enough to keep each call cheap. */
export const CLASSIFIER_TEXT_LIMIT = 2_000

/** Workers AI model with JSON mode (docs, 2026-10-17); CLASSIFIER_MODEL overrides it. */
export const DEFAULT_WORKERS_AI_MODEL = "@cf/meta/llama-3.1-8b-instruct"

const SYSTEM = `You classify email as spam or not. Spam is unsolicited bulk or fraudulent mail: phishing, scams, unwanted advertising. Newsletters someone signed up for, receipts, notifications and personal mail are not spam. Answer only with JSON: {"spam_probability": <number from 0 to 1>}.`

const prompt = (m: ClassifyInput) =>
  `From: ${m.from}\nSubject: ${m.subject}\n\n${m.text.slice(0, CLASSIFIER_TEXT_LIMIT)}`

const Answer = Schema.Struct({ spam_probability: Schema.Number })

/** Reads the probability out of a model reply, tolerating prose around the JSON. */
export const readProbability = (reply: unknown): number | null => {
  const text = typeof reply === "string" ? reply : JSON.stringify(reply ?? null)
  const json = /\{[^{}]*"spam_probability"[^{}]*\}/.exec(text)?.[0]
  if (!json) return null
  try {
    const decoded = Schema.decodeUnknownSync(Answer)(JSON.parse(json))
    return Number.isFinite(decoded.spam_probability)
      ? Math.min(Math.max(decoded.spam_probability, 0), 1)
      : null
  } catch {
    return null
  }
}

export class Classifier extends Context.Service<
  Classifier,
  { classify(input: ClassifyInput): Effect.Effect<Verdict> }
>()("mailyard/Classifier") {
  static readonly layerOff = Layer.succeed(
    Classifier,
    Classifier.of({ classify: () => Effect.succeed(NO_OPINION("off")) }),
  )

  /** Always answers `probability`; for tests. */
  static readonly layerFixed = (probability: number | null) =>
    Layer.succeed(
      Classifier,
      Classifier.of({ classify: () => Effect.succeed({ spamProbability: probability, source: "fixed" }) }),
    )

  static readonly layerWorkersAi = (ai: Ai, model: string) =>
    Layer.succeed(
      Classifier,
      Classifier.of({
        classify: (input) =>
          Effect.tryPromise(() =>
            ai.run(
              model as keyof AiModels,
              {
                messages: [
                  { role: "system", content: SYSTEM },
                  { role: "user", content: prompt(input) },
                ],
                response_format: { type: "json_object" },
                max_tokens: 32,
              } as never,
            ),
          ).pipe(
            Effect.timeout("4 seconds"),
            Effect.map((reply) => ({
              spamProbability: readProbability((reply as { response?: unknown }).response ?? reply),
              source: "workers-ai" as const,
            })),
            Effect.catchCause((cause) =>
              Effect.logWarning("classifier: Workers AI gave no opinion", cause).pipe(
                Effect.as(NO_OPINION("workers-ai")),
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
      Classifier,
      Classifier.of({
        classify: (input) =>
          Effect.tryPromise(async () => {
            const response = await fetch(`${config.url.replace(/\/$/, "")}/chat/completions`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
              },
              body: JSON.stringify({
                model: config.model,
                messages: [
                  { role: "system", content: SYSTEM },
                  { role: "user", content: prompt(input) },
                ],
                response_format: { type: "json_object" },
                max_tokens: 32,
                temperature: 0,
              }),
              signal: AbortSignal.timeout(4_000),
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
            return body.choices?.[0]?.message?.content ?? ""
          }).pipe(
            Effect.map((content) => ({
              spamProbability: readProbability(content),
              source: "openai" as const,
            })),
            Effect.catchCause((cause) =>
              Effect.logWarning("classifier: the OpenAI-compatible endpoint gave no opinion", cause).pipe(
                Effect.as(NO_OPINION("openai")),
              ),
            ),
          ),
      }),
    )

  /**
   * Chosen by MAILYARD_CLASSIFIER: `workers-ai` (needs the AI binding), `openai` (CLASSIFIER_URL,
   * CLASSIFIER_MODEL, CLASSIFIER_API_KEY), or `off`, the default. Misconfiguration falls back to off.
   */
  static readonly fromEnv = (env: Env) => {
    const mode = env.MAILYARD_CLASSIFIER ?? "off"
    if (mode === "workers-ai" && env.AI)
      return Classifier.layerWorkersAi(env.AI, env.CLASSIFIER_MODEL ?? DEFAULT_WORKERS_AI_MODEL)
    if (mode === "openai" && env.CLASSIFIER_URL && env.CLASSIFIER_MODEL) {
      return Classifier.layerOpenAi({
        url: env.CLASSIFIER_URL,
        model: env.CLASSIFIER_MODEL,
        apiKey: env.CLASSIFIER_API_KEY,
      })
    }
    return Classifier.layerOff
  }
}
