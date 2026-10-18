import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type { Env } from "../Bindings.ts"

/**
 * Turns a document (PDF, Word, Excel, OpenDocument, HTML) into Markdown text, for agents reading
 * attachments (HAL-3459). Behind a service so it's Workers AI's `toMarkdown` on Cloudflare and
 * something else, or nothing, elsewhere. Images are never sent: describing one runs models that
 * cost money, and an agent reading mail wants the document's words.
 */
export interface Converted {
  readonly text: string
  readonly source: "workers-ai" | "fixed"
}

/** What `toMarkdown` converts without running models (docs, 2026-10-18): documents, not images. */
export const CONVERTIBLE = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel.sheet.macroenabled.12",
  "application/vnd.ms-excel.sheet.binary.macroenabled.12",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.apple.numbers",
  "text/html",
  "application/xml",
  "text/xml",
])

export class DocumentText extends Context.Service<
  DocumentText,
  {
    /** The document as Markdown, or null when it can't be converted here (no service, or it failed). */
    toMarkdown(input: {
      filename: string
      mimeType: string
      bytes: Uint8Array
    }): Effect.Effect<Converted | null>
  }
>()("mailyard/DocumentText") {
  static readonly layerOff = Layer.succeed(
    DocumentText,
    DocumentText.of({ toMarkdown: () => Effect.succeed(null) }),
  )

  static readonly layerWorkersAi = (ai: Ai) =>
    Layer.succeed(
      DocumentText,
      DocumentText.of({
        toMarkdown: (input) =>
          Effect.tryPromise(async () => {
            const result = (await ai.toMarkdown({
              name: input.filename,
              blob: new Blob([input.bytes], { type: input.mimeType }),
            })) as unknown as { format?: string; data?: string; error?: string }
            if (result.format === "error" || typeof result.data !== "string") return null
            return { text: result.data, source: "workers-ai" as const }
          }).pipe(
            Effect.timeout("30 seconds"),
            Effect.catchCause((cause) =>
              Effect.logWarning("document conversion failed", cause).pipe(Effect.as(null)),
            ),
          ),
      }),
    )

  /** A fixed answer, for tests. */
  static readonly layerFixed = (text: string) =>
    Layer.succeed(
      DocumentText,
      DocumentText.of({ toMarkdown: () => Effect.succeed({ text, source: "fixed" as const }) }),
    )

  static readonly fromEnv = (env: Env) =>
    env.AI ? DocumentText.layerWorkersAi(env.AI) : DocumentText.layerOff
}
