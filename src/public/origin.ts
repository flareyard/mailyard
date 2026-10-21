/**
 * The workspace's public origin (HAL-3483). A deployment can answer on several hostnames: the
 * founder's answers on `mail.flareyard.dev` (the app), `api.mail.flareyard.dev` (keys, SDKs, MCP)
 * and workers.dev. Links that people open (unsubscribe, confirm, view in browser, tracking, file
 * links, automation runs) must not depend on which hostname a request happened to use, so they are
 * built on `MAILYARD_PUBLIC_ORIGIN` when it is set, and on the request's own origin otherwise.
 *
 * The value comes from the Worker's environment, which is the same for every request an isolate
 * serves, so it is configured once per request at the edge (`configurePublicOrigin`) and read
 * wherever a link is built.
 */

let configured: string | null = null

/** A URL's origin, or null for something that isn't an absolute http(s) URL. */
export const originOfUrl = (url: string | null | undefined) => {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : null
  } catch {
    return null
  }
}

/** Sets the public origin from `MAILYARD_PUBLIC_ORIGIN`; an unset or malformed value clears it. */
export const configurePublicOrigin = (value: string | undefined) => {
  configured = originOfUrl(value?.trim())
}

/** The configured public origin, if any. */
export const publicOrigin = () => configured

/** Where a link should point: the public origin, else the origin the request came in on. */
export const linkOrigin = (requestUrl: string) => configured ?? originOfUrl(requestUrl)

/**
 * Paths the Worker serves itself. Everything else belongs to the web app (Workers Static Assets);
 * keep this in step with `assets.run_worker_first` in wrangler.jsonc.
 */
const WORKER_PREFIXES = [
  "/v1/",
  "/t/",
  "/u/",
  "/p/",
  "/c/",
  "/f/",
  "/v/",
  "/brand/",
  "/oauth/",
  "/.well-known/oauth-",
  "/docs/",
]
const WORKER_PATHS = new Set([
  "/v1",
  "/mcp",
  "/healthz",
  "/openapi.json",
  "/docs",
  "/docs.md",
  "/llms.txt",
  "/llms-full.txt",
])

export const isWorkerPath = (path: string) =>
  WORKER_PATHS.has(path) || WORKER_PREFIXES.some((prefix) => path.startsWith(prefix))

/**
 * A browser opening an app page on another of the deployment's hostnames (api.mail, workers.dev)
 * is sent to the public origin with the same path and query, so the app always runs on one origin
 * and its session cookie stays first-party. 308 keeps the method; only GET and HEAD qualify, and
 * API, webhook and MCP paths are never redirected.
 */
export const canonicalRedirect = (request: Request): Response | null => {
  if (!configured) return null
  if (request.method !== "GET" && request.method !== "HEAD") return null
  const url = new URL(request.url)
  if (url.origin === configured || isWorkerPath(url.pathname)) return null
  return new Response(null, {
    status: 308,
    headers: { location: `${configured}${url.pathname}${url.search}`, "cache-control": "no-store" },
  })
}
