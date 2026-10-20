/**
 * Every query the Settings pages (S-A half) make, as query options so pages that read the same endpoint share
 * one request and one cache entry. Paths and parameters are checked against src/api/schema.d.ts.
 */
import { queryOptions } from "@tanstack/react-query"
import { api, type paths, unwrap } from "../api/client.ts"

/** The 200 body of a GET path, straight from the generated OpenAPI types. */
export type Ok<P extends keyof paths> = paths[P] extends {
  get: { responses: { 200: { content: { "application/json": infer R } } } }
}
  ? R
  : never

export type MailboxSummary = Ok<"/v1/mailboxes">["mailboxes"][number]
export type Mailbox = Ok<"/v1/mailboxes/{id}">
export type Rule = Ok<"/v1/mailboxes/{id}/rules">["rules"][number]
export type Member = Ok<"/v1/members">["members"][number]
export type Invite = Ok<"/v1/members">["invites"][number]
export type Session = Ok<"/v1/sessions">["sessions"][number]
export type Brand = Ok<"/v1/settings/brand">
export type Compliance = Ok<"/v1/settings/compliance">
export type Governor = Ok<"/v1/sending/governor">
export type SendingSettings = Ok<"/v1/settings/sending">

export const mailboxesQuery = queryOptions({
  queryKey: ["mailboxes"],
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

export const identitiesQuery = queryOptions({
  queryKey: ["identities"],
  queryFn: () => unwrap(api.GET("/v1/identities")),
})

export const rulesQuery = (mailboxId: string) =>
  queryOptions({
    queryKey: ["mailboxes", mailboxId, "rules"],
    queryFn: () => unwrap(api.GET("/v1/mailboxes/{id}/rules", { params: { path: { id: mailboxId } } })),
  })

export const labelsQuery = (mailboxId: string) =>
  queryOptions({
    queryKey: ["mailboxes", mailboxId, "labels"],
    queryFn: () => unwrap(api.GET("/v1/mailboxes/{id}/labels", { params: { path: { id: mailboxId } } })),
  })

export const threadsQuery = (mailboxId: string) =>
  queryOptions({
    queryKey: ["mailboxes", mailboxId, "threads", "rule-test"],
    queryFn: () =>
      unwrap(
        api.GET("/v1/mailboxes/{id}/threads", {
          params: { path: { id: mailboxId }, query: { limit: "20" } },
        }),
      ),
  })

export const webhooksQuery = queryOptions({
  queryKey: ["webhooks"],
  queryFn: () => unwrap(api.GET("/v1/webhooks")),
})

export const membersQuery = queryOptions({
  queryKey: ["members"],
  queryFn: () => unwrap(api.GET("/v1/members")),
})

export const sessionsQuery = queryOptions({
  queryKey: ["sessions"],
  queryFn: () => unwrap(api.GET("/v1/sessions")),
})

export const brandQuery = queryOptions({
  queryKey: ["settings", "brand"],
  queryFn: () => unwrap(api.GET("/v1/settings/brand")),
})

export const complianceQuery = queryOptions({
  queryKey: ["settings", "compliance"],
  queryFn: () => unwrap(api.GET("/v1/settings/compliance")),
})

export const governorQuery = queryOptions({
  queryKey: ["sending", "governor"],
  queryFn: () => unwrap(api.GET("/v1/sending/governor")),
  refetchInterval: 30_000,
  retry: 1,
})

export const sendingSettingsQuery = queryOptions({
  queryKey: ["settings", "sending"],
  queryFn: () => unwrap(api.GET("/v1/settings/sending")),
  retry: 1,
})
