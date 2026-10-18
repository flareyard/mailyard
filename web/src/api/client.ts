/**
 * The typed API client. Types come from the live OpenAPI (`bun run api:types` → schema.d.ts), so an API change
 * shows up here as a type error.
 *
 * Auth is the session cookie (`__Host-mailyard_session`, HttpOnly, set by POST /v1/session). The UI never
 * holds a key: it is posted once to /v1/session and dropped. The Worker's CSRF check is an Origin check, which
 * a same-origin fetch passes without any header.
 */
import createClient, { type Middleware } from "openapi-fetch"
import { fixtureFetch, fixturesEnabled } from "../fixtures/mode.ts"
import { noteResponse } from "../ops/deletion.ts"
import type { paths } from "./schema"

export type { components, paths } from "./schema"

/** Every refusal the API sends carries `_tag`, a message and usually a `requestId` (HAL-3359, HAL-3472). */
export type ApiErrorBody = {
  _tag?: string
  message?: string
  reason?: string
  requestId?: string
  retryAfter?: number
  required?: string
  revokedAt?: string
  [k: string]: unknown
}

export class ApiError extends Error {
  readonly status: number
  readonly body: ApiErrorBody
  constructor(status: number, body: ApiErrorBody) {
    super(body.message ?? `Request failed with ${status}`)
    this.name = "ApiError"
    this.status = status
    this.body = body
  }
  get requestId(): string | undefined {
    return this.body.requestId
  }
  get reason(): string | undefined {
    return this.body.reason
  }
}

/** Listeners for 401s, so the shell can open the re-auth sheet without each query handling it. */
const unauthorized = new Set<(e: ApiError) => void>()
export const onUnauthorized = (fn: (e: ApiError) => void) => {
  unauthorized.add(fn)
  return () => unauthorized.delete(fn)
}

const errors: Middleware = {
  async onResponse({ response }) {
    if (response.ok) return response
    let body: ApiErrorBody = {}
    try {
      body = (await response.clone().json()) as ApiErrorBody
    } catch {
      body = { message: response.statusText }
    }
    const err = new ApiError(response.status, body)
    if (response.status === 401) for (const fn of unauthorized) fn(err)
    throw err
  },
}

/**
 * A workspace being deleted (HAL-3448) says so on every response with `x-workspace-deleting: <deletesAt>`.
 * Every answer, refusals included, updates the shell's banner, so the countdown costs no extra request.
 * Registered after `errors`: openapi-fetch runs onResponse last-registered first, so this sees a refusal
 * before `errors` throws it.
 */
const deleting: Middleware = {
  onResponse({ response }) {
    noteResponse(response)
    return response
  },
}

export const api = createClient<paths>({
  baseUrl: typeof window === "undefined" ? "http://localhost" : window.location.origin,
  credentials: "same-origin",
  ...(fixturesEnabled() ? { fetch: fixtureFetch } : {}),
})
api.use(errors)
api.use(deleting)

/** Unwraps an openapi-fetch result for TanStack Query: the data, or the ApiError the middleware threw. */
export async function unwrap<T>(p: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  const { data, response } = await p
  if (response.status === 204) return undefined as T
  return data as T
}
