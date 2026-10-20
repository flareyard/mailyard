/**
 * The first run's reads, typed from the OpenAPI. Keys are shared with the rest of the app (`["mailboxes"]` is
 * the shell's), so a mailbox created here shows in the sidebar at once.
 */
import { queryOptions } from "@tanstack/react-query"
import { api, type paths, unwrap } from "../api/client.ts"

// Contact imports are shared with Audience → Imports.
export {
  type ContactImport,
  contactImportQuery,
  contactImportsQuery,
  type Upload,
} from "../audience/import/queries.ts"

type Json<P extends keyof paths, M extends "get" | "post" | "patch"> = paths[P][M] extends {
  responses: { 200: { content: { "application/json": infer R } } }
}
  ? R
  : never

export type DomainSummary = Json<"/v1/domains", "get">["domains"][number]
export type Domain = Json<"/v1/domains/{id}", "get">
export type DomainCheck = Domain["checks"][number]
export type Candidates = Json<"/v1/domains/candidates", "get">
export type Mailbox = Json<"/v1/mailboxes", "post">
export type MailboxSummary = Json<"/v1/mailboxes", "get">["mailboxes"][number]
export type TestSend = Json<"/v1/test-send/{id}", "get">
export type Verified = Json<"/v1/verified-addresses", "get">
export type Probe = Json<"/v1/mailboxes/{id}/imports/probe", "post">
export type MailImport = Json<"/v1/mailboxes/{id}/imports/{importId}", "get">
export type ContactField = Json<"/v1/contact-fields", "get">["fields"][number]
export type Topic = Json<"/v1/topics", "get">["topics"][number]

/** Some fixture variants and older deploys answer with a different envelope; never let that crash a step. */
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])

export const domainsQuery = queryOptions({
  queryKey: ["domains"],
  queryFn: async () => arr<DomainSummary>((await unwrap(api.GET("/v1/domains")))?.domains),
})

export const domainQuery = (id: string) =>
  queryOptions({
    queryKey: ["domains", id],
    queryFn: () => unwrap(api.GET("/v1/domains/{id}", { params: { path: { id } } })),
  })

export const candidatesQuery = queryOptions({
  queryKey: ["domains", "candidates"],
  queryFn: () => unwrap(api.GET("/v1/domains/candidates")),
  staleTime: 5 * 60_000,
})

/** Test sends that went out, from the message log (the `test` stream). */
export const testMessagesQuery = queryOptions({
  queryKey: ["messages", { stream: "test", limit: 20 }],
  queryFn: async () =>
    arr<{ source: string; stream: string; status: string }>(
      (await unwrap(api.GET("/v1/messages", { params: { query: { stream: "test", limit: "20" } } })))
        ?.messages,
    ),
})

/** Whether this workspace has delivered anything at all: a workspace already sending is past its test. */
export const deliveredQuery = queryOptions({
  queryKey: ["messages", { status: "delivered", limit: 1 }],
  queryFn: async () =>
    arr<{ source: string; stream: string; status: string }>(
      (await unwrap(api.GET("/v1/messages", { params: { query: { status: "delivered", limit: "1" } } })))
        ?.messages,
    ),
})

export const testSendQuery = (id: string) =>
  queryOptions({
    queryKey: ["test-send", id],
    queryFn: () => unwrap(api.GET("/v1/test-send/{id}", { params: { path: { id } } })),
  })

export const verifiedQuery = queryOptions({
  queryKey: ["verified-addresses"],
  queryFn: () => unwrap(api.GET("/v1/verified-addresses")),
  staleTime: 5 * 60_000,
})

export const mailImportsQuery = (mailboxId: string) =>
  queryOptions({
    queryKey: ["mailboxes", mailboxId, "imports"],
    queryFn: async () =>
      arr<MailImport>(
        (
          (await unwrap(api.GET("/v1/mailboxes/{id}/imports", { params: { path: { id: mailboxId } } }))) as {
            imports?: unknown
          }
        )?.imports,
      ),
  })

export const mailImportQuery = (mailboxId: string, importId: string) =>
  queryOptions({
    queryKey: ["mailboxes", mailboxId, "imports", importId],
    queryFn: () =>
      unwrap(
        api.GET("/v1/mailboxes/{id}/imports/{importId}", { params: { path: { id: mailboxId, importId } } }),
      ),
  })

export const contactFieldsQuery = queryOptions({
  queryKey: ["contact-fields"],
  queryFn: async () => arr<ContactField>((await unwrap(api.GET("/v1/contact-fields")))?.fields),
  staleTime: 5 * 60_000,
})

export const topicsQuery = queryOptions({
  queryKey: ["topics"],
  queryFn: async () => arr<Topic>((await unwrap(api.GET("/v1/topics")))?.topics).filter((t) => !t.archived),
  staleTime: 5 * 60_000,
})
