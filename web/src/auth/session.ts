/**
 * The browser session (HAL-3358, live since 2026-10-18): POST /v1/session exchanges a key for the HttpOnly
 * `__Host-mailyard_session` cookie, GET /v1/me says who that session is, DELETE /v1/session ends it.
 * The Worker's CSRF check is an Origin check, which these same-origin calls pass on their own.
 */
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query"
import { ApiError, api, type components, unwrap } from "../api/client.ts"

type MeBody = NonNullable<Awaited<ReturnType<typeof api.GET<"/v1/me", Record<string, never>>>>["data"]>
export type Role = "owner" | "admin" | "sender" | "agent" | "viewer"
/**
 * The live /v1/me body. People and roles (HAL-3361) add `user` and `role`; until then the session is a key and
 * both are absent, so the shell shows the key's name and scopes. Workspaces carry no host: the current one is
 * wherever this page is served from.
 */
export type Workspace = MeBody["workspace"] & { host?: string | null }
export type Me = Omit<MeBody, "workspace" | "workspaces"> & {
  workspace: Workspace
  workspaces: Workspace[]
  user?: { id: string; name: string; email: string } | null
  role?: Role | null
}
export type { components }

export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: () => unwrap(api.GET("/v1/me")) as Promise<Me>,
  retry: (n, e) => !(e instanceof ApiError && (e.status === 401 || e.status === 403)) && n < 2,
  staleTime: 60_000,
})

export const useMe = () => useQuery(meQuery)

/** Exchanges a key for the session cookie. The key is never stored: it lives in this call and nowhere else. */
export async function signIn(key: string): Promise<Me> {
  return unwrap(api.POST("/v1/session", { body: { key: key.trim() } })) as Promise<Me>
}

export async function signOut(): Promise<void> {
  await unwrap(api.DELETE("/v1/session"))
}

export function useSessionActions() {
  const qc = useQueryClient()
  return {
    async signIn(key: string) {
      const me = await signIn(key)
      qc.setQueryData(meQuery.queryKey, me)
      return me
    },
    async signOut() {
      try {
        await signOut()
      } finally {
        qc.clear()
      }
    },
  }
}

/** The refusal screens the sign-in page has a design for, keyed by the API's typed reasons (HAL-3359). */
export type SignInError =
  | { kind: "format" | "unknown" | "public-key" | "unreachable" | "session-expired" | "flareyard-expired" }
  | { kind: "revoked"; revokedAt?: string }
  | { kind: "insufficient-scope"; required: string; scopes: string[] }
  | { kind: "rate-limited"; retryAfter: number }
  | { kind: "other"; message: string; requestId?: string }

export function signInError(e: unknown): SignInError {
  if (!(e instanceof ApiError)) return { kind: "unreachable" }
  const b = e.body
  if (e.status === 429) return { kind: "rate-limited", retryAfter: Number(b.retryAfter ?? 60) }
  if (e.status === 401) {
    if (b.reason === "format" || b.reason === "unknown" || b.reason === "session-expired")
      return { kind: b.reason }
    if (b.reason === "revoked")
      return b.revokedAt ? { kind: "revoked", revokedAt: b.revokedAt } : { kind: "revoked" }
  }
  if (e.status === 403) {
    if (b.reason === "public-key") return { kind: "public-key" }
    if (b.reason === "insufficient-scope")
      return {
        kind: "insufficient-scope",
        required: b.required ?? "read",
        scopes: Array.isArray(b.scopes) ? (b.scopes as string[]) : [],
      }
  }
  if (e.status >= 500) return { kind: "unreachable" }
  return e.requestId
    ? { kind: "other", message: e.message, requestId: e.requestId }
    : { kind: "other", message: e.message }
}

/** Client-side shape check before a round trip: the API's own `format` refusal says the same thing. */
export const keyLooksValid = (k: string) =>
  /^(sk_|pk_)[A-Za-z0-9_-]{8,}$/.test(k.trim()) || k.trim().length >= 24
