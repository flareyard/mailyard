import * as Effect from "effect/Effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import { Bindings, type Env } from "../Bindings.ts"
import { handleMessageRaw, handleUpload } from "../workers/files.ts"
import { handleStatsCsv } from "../workers/statsCsv.ts"
import { handleUploads } from "../workers/uploads.ts"
import { MailApi } from "./Api.ts"

/**
 * File routes declared in the API so they're in the spec (HAL-3475). The Worker's router serves them
 * first, with their own checks; these handlers run the same functions for a request that reaches
 * the API, so both paths answer the same.
 */
export const FilesHandlers = HttpApiBuilder.group(
  MailApi,
  "files",
  Effect.fn(function* (handlers) {
    const env = (yield* Bindings) as unknown as Env
    const delegate =
      (run: (request: Request) => Promise<Response>) =>
      (input: { readonly request: HttpServerRequest.HttpServerRequest }) =>
        Effect.gen(function* () {
          const web = yield* HttpServerRequest.toWeb(input.request).pipe(Effect.orDie)
          return HttpServerResponse.fromWeb(yield* Effect.promise(() => run(web)))
        })
    return handlers
      .handleRaw(
        "upload",
        delegate((r) => handleUploads(r, env)),
      )
      .handleRaw("mailboxUpload", ({ request, params }) =>
        delegate((r) => handleUpload(r, env, params.id))({ request }),
      )
      .handleRaw("messageRaw", ({ request, params }) =>
        delegate((r) => handleMessageRaw(r, env, params.id))({ request }),
      )
      .handleRaw("statsCsv", ({ request, params }) =>
        delegate((r) => handleStatsCsv(r, env, params.chart))({ request }),
      )
  }),
)
