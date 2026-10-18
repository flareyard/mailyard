/**
 * Every query Settings → Integrations makes, as query options so panels that read the same endpoint share one
 * request. Paths and parameters are checked against src/api/schema.d.ts by the compiler.
 */
import { queryOptions } from "@tanstack/react-query"
import { api, type paths, unwrap } from "../../api/client.ts"

/** The 200 body of a path and method, straight from the generated OpenAPI types. */
export type Body<
  P extends keyof paths,
  M extends "get" | "post" | "put" | "patch" | "delete" = "get",
> = paths[P][M] extends {
  responses: { 200: { content: { "application/json": infer R } } }
}
  ? R
  : never

export type Agent = Body<"/v1/agents">["agents"][number]
export type Approval = Body<"/v1/approvals">["approvals"][number]
export type ApiKey = Body<"/v1/api-keys">["keys"][number]
export type Mailbox = Body<"/v1/mailboxes">["mailboxes"][number]
export type MailboxDetail = Body<"/v1/mailboxes/{id}">
/** An audit entry. `ip` and `location` are always null (not recorded), so they are left out. */
export type AuditEntry = Omit<Body<"/v1/audit">["entries"][number], "ip" | "location">
export type Created = Body<"/v1/agents", "post">

export const agentsQuery = queryOptions({
  queryKey: ["agents"],
  queryFn: () => unwrap(api.GET("/v1/agents")),
})

export const agentQuery = (id: string) =>
  queryOptions({
    queryKey: ["agents", id],
    queryFn: () => unwrap(api.GET("/v1/agents/{id}", { params: { path: { id } } })),
  })

export const approvalsQuery = (status: "pending" | "approved" | "rejected" | "failed" = "pending") =>
  queryOptions({
    queryKey: ["approvals", status],
    queryFn: () => unwrap(api.GET("/v1/approvals", { params: { query: { status } } })),
    refetchInterval: 30_000,
  })

export const mcpKeysQuery = queryOptions({
  queryKey: ["api-keys", "mcp"],
  queryFn: () => unwrap(api.GET("/v1/api-keys", { params: { query: { purpose: "mcp" } } })),
})

export const mailboxesQuery = queryOptions({
  queryKey: ["mailboxes", "list"],
  queryFn: () => unwrap(api.GET("/v1/mailboxes")),
})

export const mailboxQuery = (id: string) =>
  queryOptions({
    queryKey: ["mailboxes", id],
    queryFn: () => unwrap(api.GET("/v1/mailboxes/{id}", { params: { path: { id } } })),
  })

export const domainsQuery = queryOptions({
  queryKey: ["domains"],
  queryFn: () => unwrap(api.GET("/v1/domains")),
})

export const webhooksQuery = queryOptions({
  queryKey: ["webhooks"],
  queryFn: () => unwrap(api.GET("/v1/webhooks")),
})

/** An agent's activity: the audit log with its key as the actor. */
export const keyAuditQuery = (keyId: string) =>
  queryOptions({
    queryKey: ["audit", { actor: keyId }],
    queryFn: () => unwrap(api.GET("/v1/audit", { params: { query: { actor: keyId, limit: "50" } } })),
  })
