import { and, eq, isNull, lt, or } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { oauthClients } from "../db/schema.ts"
import { recordAudit } from "../domain/audit.ts"
import { Ids } from "../kit/index.ts"
import { Database } from "../services/Database.ts"

/**
 * The clients an MCP user connects (HAL-3462). The MCP authorization spec (2026-07-28) prefers Client
 * ID Metadata Documents: the client id is an HTTPS URL, and its document names the client and its
 * redirect URIs. Dynamic Client Registration (RFC 7591) stays for older clients.
 */

/** An OAuth error, as RFC 6749 §5.2 and RFC 7591 §3.2.2 word it. */
export class OAuthError extends Schema.TaggedError<OAuthError>()("OAuthError", {
  error: Schema.String,
  description: Schema.String,
  status: Schema.optionalKey(Schema.Number),
}) {}

export type OAuthClient = typeof oauthClients.$inferSelect

const DAY = 86_400_000
/** A metadata document is fetched again after this long. */
export const CIMD_TTL_MS = DAY
/** A registered client nobody used within this long is dropped. */
export const DCR_UNUSED_MS = DAY
const MAX_DOCUMENT_BYTES = 16 * 1024
const MAX_REDIRECT_URIS = 10

/** Schemes a redirect may never use, whatever the client says. */
const FORBIDDEN_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "about:", "blob:", "ftp:"])

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"])

/**
 * Whether a redirect URI is one Mailyard will send codes to: https, http on a loopback address (a
 * native app's local server), or a private-use scheme (RFC 8252 §7.1). Never a fragment.
 */
export const redirectProblem = (raw: string): string | null => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return `${raw} isn't a URL.`
  }
  if (url.hash) return "A redirect URI can't have a fragment."
  if (FORBIDDEN_SCHEMES.has(url.protocol)) return `Redirects to ${url.protocol} URLs aren't allowed.`
  if (url.protocol === "http:" && !LOOPBACK.has(url.hostname))
    return "http redirect URIs must be on localhost, 127.0.0.1 or [::1]; use https otherwise."
  if (url.username || url.password) return "A redirect URI can't carry credentials."
  return null
}

/**
 * Whether `asked` matches a registered redirect URI. Exact, except that a loopback http URI may use
 * any port (RFC 8252 §7.3): native apps pick a free one each time.
 */
export const redirectMatches = (registered: ReadonlyArray<string>, asked: string) => {
  if (registered.includes(asked)) return true
  let a: URL
  try {
    a = new URL(asked)
  } catch {
    return false
  }
  if (a.protocol !== "http:" || !LOOPBACK.has(a.hostname)) return false
  return registered.some((r) => {
    try {
      const u = new URL(r)
      return (
        u.protocol === "http:" &&
        u.hostname === a.hostname &&
        u.pathname === a.pathname &&
        u.search === a.search
      )
    } catch {
      return false
    }
  })
}

/** Why a URL can't be a client id document's address (draft-ietf-oauth-client-id-metadata-document §3). */
export const clientIdUrlProblem = (raw: string): string | null => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return "The client_id isn't a URL."
  }
  if (url.protocol !== "https:") return "A URL client_id must use https."
  if (url.username || url.password) return "A client_id URL can't carry credentials."
  if (url.hash) return "A client_id URL can't have a fragment."
  if (url.pathname === "/" || url.pathname === "") return "A client_id URL needs a path."
  if (/(^|\/)\.\.?(\/|$)/.test(raw.slice(url.origin.length)))
    return "A client_id URL can't have . or .. segments."
  const host = url.hostname
  // Never fetch a document from an address that names this network or a bare IP.
  if (
    LOOPBACK.has(host) ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
    host.startsWith("[") ||
    /\.(local|localhost|internal|lan|home|test)$/i.test(host) ||
    !host.includes(".")
  )
    return "A client_id URL must be on a public host name."
  return null
}

const Metadata = Schema.Struct({
  client_id: Schema.optionalKey(Schema.String),
  client_name: Schema.optionalKey(Schema.String),
  client_uri: Schema.optionalKey(Schema.String),
  logo_uri: Schema.optionalKey(Schema.String),
  redirect_uris: Schema.Array(Schema.String),
  token_endpoint_auth_method: Schema.optionalKey(Schema.String),
  grant_types: Schema.optionalKey(Schema.Array(Schema.String)),
  response_types: Schema.optionalKey(Schema.Array(Schema.String)),
  client_secret: Schema.optionalKey(Schema.Unknown),
})
type Metadata = typeof Metadata.Type

const invalidMetadata = (description: string) =>
  new OAuthError({ error: "invalid_client_metadata", description, status: 400 })

/** A web URL a client shows as its home page or logo, or null when it isn't one. */
const webUrl = (raw: string | undefined) => {
  if (!raw) return null
  try {
    const url = new URL(raw)
    return url.protocol === "https:" ? url.toString().slice(0, 500) : null
  } catch {
    return null
  }
}

/** What both kinds of registration check: public clients using the code flow, sane redirect URIs. */
const checkMetadata = (m: Metadata) =>
  Effect.gen(function* () {
    if (m.client_secret !== undefined)
      return yield* invalidMetadata("Mailyard registers public clients only; drop client_secret.")
    if (m.token_endpoint_auth_method !== undefined && m.token_endpoint_auth_method !== "none")
      return yield* invalidMetadata(
        "Mailyard registers public clients only: token_endpoint_auth_method must be none (PKCE stands in for the secret).",
      )
    if (m.grant_types?.some((g) => g !== "authorization_code" && g !== "refresh_token"))
      return yield* invalidMetadata("Only the authorization_code and refresh_token grants are supported.")
    if (m.response_types?.some((r) => r !== "code"))
      return yield* invalidMetadata("Only response_type code is supported.")
    if (m.redirect_uris.length === 0) return yield* invalidMetadata("redirect_uris can't be empty.")
    if (m.redirect_uris.length > MAX_REDIRECT_URIS)
      return yield* invalidMetadata(`At most ${MAX_REDIRECT_URIS} redirect_uris.`)
    for (const uri of m.redirect_uris) {
      const problem = redirectProblem(uri)
      if (problem)
        return yield* new OAuthError({ error: "invalid_redirect_uri", description: problem, status: 400 })
    }
    return {
      name: (m.client_name ?? "").trim().slice(0, 100),
      uri: webUrl(m.client_uri),
      logoUri: webUrl(m.logo_uri),
      redirectUris: [...m.redirect_uris],
    }
  })

/** Fetches and checks a client's metadata document. */
const fetchDocument = (clientId: string) =>
  Effect.gen(function* () {
    const fetched = yield* Effect.promise(async () => {
      try {
        const response = await fetch(clientId, {
          headers: { accept: "application/json" },
          redirect: "manual",
          signal: AbortSignal.timeout(5_000),
        })
        if (response.status !== 200) return { ok: false as const, why: `it answered ${response.status}` }
        const length = Number(response.headers.get("content-length") ?? "0")
        if (length > MAX_DOCUMENT_BYTES) return { ok: false as const, why: "it's too large" }
        const text = await response.text()
        if (text.length > MAX_DOCUMENT_BYTES) return { ok: false as const, why: "it's too large" }
        return { ok: true as const, body: JSON.parse(text) as unknown }
      } catch {
        return { ok: false as const, why: "it couldn't be fetched or isn't JSON" }
      }
    })
    if (!fetched.ok)
      return yield* new OAuthError({
        error: "invalid_client",
        description: `The client's metadata document at ${clientId} can't be used: ${fetched.why}.`,
        status: 400,
      })
    const decoded = Schema.decodeUnknownExit(Metadata)(fetched.body)
    if (decoded._tag === "Failure")
      return yield* new OAuthError({
        error: "invalid_client",
        description: "The client's metadata document needs redirect_uris.",
        status: 400,
      })
    if (decoded.value.client_id !== clientId)
      return yield* new OAuthError({
        error: "invalid_client",
        description: "The metadata document's client_id must be its own URL.",
        status: 400,
      })
    return yield* checkMetadata(decoded.value).pipe(
      Effect.mapError(
        (e) => new OAuthError({ error: "invalid_client", description: e.description, status: 400 }),
      ),
    )
  })

/**
 * The client named by `client_id`: a URL is its metadata document (fetched, or from the day-old
 * cache); anything else must be a client registered here and not yet expired.
 */
export const findClient = Effect.fn("oauth.findClient")(function* (clientId: string, now = Date.now()) {
  const database = yield* Database
  if (!clientId || clientId.length > 2000)
    return yield* new OAuthError({
      error: "invalid_client",
      description: "client_id is missing.",
      status: 400,
    })
  const cached = yield* database.query("oauth.client", (db) =>
    db.select().from(oauthClients).where(eq(oauthClients.id, clientId)).get(),
  )
  if (clientId.startsWith("https://")) {
    const problem = clientIdUrlProblem(clientId)
    if (problem) return yield* new OAuthError({ error: "invalid_client", description: problem, status: 400 })
    if (cached && cached.fetchedAt !== null && now - cached.fetchedAt < CIMD_TTL_MS) return cached
    const doc = yield* fetchDocument(clientId)
    const row = {
      id: clientId,
      kind: "cimd" as const,
      name: doc.name || new URL(clientId).hostname,
      uri: doc.uri,
      logoUri: doc.logoUri,
      redirectUris: doc.redirectUris,
      fetchedAt: now,
      createdAt: cached?.createdAt ?? now,
      lastUsedAt: cached?.lastUsedAt ?? null,
    }
    yield* database.query("oauth.cacheClient", (db) =>
      db
        .insert(oauthClients)
        .values(row)
        .onConflictDoUpdate({
          target: oauthClients.id,
          set: {
            name: row.name,
            uri: row.uri,
            logoUri: row.logoUri,
            redirectUris: row.redirectUris,
            fetchedAt: now,
          },
        })
        .run(),
    )
    return row satisfies OAuthClient
  }
  if (cached?.kind !== "dcr" || (cached.lastUsedAt === null && now - cached.createdAt >= DCR_UNUSED_MS))
    return yield* new OAuthError({
      error: "invalid_client",
      description: "This client isn't registered with Mailyard. Register it again.",
      status: 400,
    })
  return cached
})

/** `POST /oauth/register` (RFC 7591): a public client, kept if used within a day. */
export const registerClient = Effect.fn("oauth.register")(function* (body: unknown, now = Date.now()) {
  const decoded = Schema.decodeUnknownExit(Metadata)(body)
  if (decoded._tag === "Failure")
    return yield* invalidMetadata("Send JSON client metadata with redirect_uris.")
  const checked = yield* checkMetadata(decoded.value)
  const id = `oc_${yield* (yield* Ids).next}`
  const database = yield* Database
  const row = {
    id,
    kind: "dcr" as const,
    name: checked.name || "An MCP client",
    uri: checked.uri,
    logoUri: checked.logoUri,
    redirectUris: checked.redirectUris,
    fetchedAt: null,
    createdAt: now,
    lastUsedAt: null,
  }
  yield* database.query("oauth.registerClient", (db) => db.insert(oauthClients).values(row).run())
  yield* recordAudit({
    actor: "oauth",
    action: "oauth.register",
    target: id,
    after: { name: row.name, redirectUris: row.redirectUris },
  })
  return {
    client_id: id,
    client_id_issued_at: Math.floor(now / 1000),
    client_name: row.name,
    ...(row.uri ? { client_uri: row.uri } : {}),
    ...(row.logoUri ? { logo_uri: row.logoUri } : {}),
    redirect_uris: row.redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  }
})

/** Marks a client used, so a registered one is kept. */
export const touchClient = Effect.fn("oauth.touchClient")(function* (id: string, now = Date.now()) {
  const database = yield* Database
  yield* database.query("oauth.touchClient", (db) =>
    db.update(oauthClients).set({ lastUsedAt: now }).where(eq(oauthClients.id, id)).run(),
  )
})

/** Hourly: registered clients nobody used within a day go. */
export const pruneClients = Effect.fn("oauth.pruneClients")(function* (now = Date.now()) {
  const database = yield* Database
  yield* database.query("oauth.pruneClients", (db) =>
    db
      .delete(oauthClients)
      .where(
        and(
          eq(oauthClients.kind, "dcr"),
          isNull(oauthClients.lastUsedAt),
          lt(oauthClients.createdAt, now - DCR_UNUSED_MS),
        ),
      )
      .run(),
  )
  // Metadata documents not fetched in a month are forgotten; they're fetched again when used.
  yield* database.query("oauth.pruneDocuments", (db) =>
    db
      .delete(oauthClients)
      .where(
        and(
          eq(oauthClients.kind, "cimd"),
          or(isNull(oauthClients.lastUsedAt), lt(oauthClients.lastUsedAt, now - 30 * DAY)),
          lt(oauthClients.fetchedAt, now - 30 * DAY),
        ),
      )
      .run(),
  )
})

/** The host shown beside a client's name, so a look-alike name can't pass for another app. */
export const clientHost = (client: OAuthClient) => {
  try {
    if (client.kind === "cimd") return new URL(client.id).host
    if (client.uri) return new URL(client.uri).host
    const first = client.redirectUris[0]
    return first ? new URL(first).host || new URL(first).protocol.replace(":", "") : null
  } catch {
    return null
  }
}
