import * as Effect from "effect/Effect"
import type { Env } from "../Bindings.ts"
import { CLICK_PATH, OPEN_PATH, PIXEL, recordHit, verifyToken } from "../tracking/track.ts"
import { runtimeFor } from "./inbound.ts"

export { CLICK_PATH, OPEN_PATH }

const hitOf = (request: Request) => ({
  userAgent: request.headers.get("user-agent") ?? "",
  ip: request.headers.get("cf-connecting-ip") ?? "",
  at: Date.now(),
})

/**
 * `/t/o/{token}.gif`: always the pixel, recorded or not, so a broken token never shows a broken
 * image. Recording happens after the response, so the image never waits on the database.
 */
export const handleOpen = (request: Request, env: Env, token: string, ctx: ExecutionContext) => {
  ctx.waitUntil(
    runtimeFor(env)
      .runPromise(Effect.result(recordHit("open", token, hitOf(request))))
      .then(() => undefined),
  )
  return new Response(PIXEL, {
    headers: {
      "content-type": "image/gif",
      "cache-control": "no-store, no-cache, must-revalidate, private",
      "content-length": String(PIXEL.byteLength),
    },
  })
}

/** `/t/c/{token}`: a 302 to the signed address once the click is counted; a 404 for anything else. */
export const handleClick = async (request: Request, env: Env, token: string) => {
  // A HEAD is a link checker asking where it goes, not a person clicking: answer, but don't count it.
  if (request.method === "HEAD") {
    const payload = await runtimeFor(env).runPromise(Effect.result(verifyToken(token)))
    const url = payload._tag === "Success" ? payload.success?.u : undefined
    return url
      ? new Response(null, { status: 302, headers: { location: url } })
      : new Response(null, { status: 404 })
  }
  const result = await runtimeFor(env).runPromise(Effect.result(recordHit("click", token, hitOf(request))))
  if (result._tag === "Success" && result.success?.url) {
    return new Response(null, {
      status: 302,
      headers: {
        location: result.success.url,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    })
  }
  return new Response("Not found", { status: 404 })
}
