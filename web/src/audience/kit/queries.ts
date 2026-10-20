/**
 * Reads several of these screens share, typed from the OpenAPI. Keys match the rest of the app (`["topics"]`
 * and `["contact-fields"]` are the first run's too), so a topic made here shows up there at once.
 */
import { queryOptions, useQuery } from "@tanstack/react-query"
import { api, type paths, unwrap } from "../../api/client.ts"
import { meQuery } from "../../auth/session.ts"

/** The 200 body of an operation, straight from the generated schema. */
export type Json<
  P extends keyof paths,
  M extends "get" | "post" | "patch" | "put" | "delete",
  S extends number = 200,
> = paths[P][M] extends { responses: { [K in S]: { content: { "application/json": infer R } } } } ? R : never

/** A request body, from the generated schema. */
export type Body<P extends keyof paths, M extends "post" | "patch" | "put"> = paths[P][M] extends {
  requestBody?: { content: { "application/json": infer B } }
}
  ? B
  : never

/** Some fixture variants answer with a different envelope; never let that crash a screen. */
export const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])

export type Topic = Json<"/v1/topics", "get">["topics"][number]
export type Segment = Json<"/v1/segments", "get">["segments"][number]
export type ContactField = Json<"/v1/contact-fields", "get">["fields"][number]
export type Identity = Json<"/v1/identities", "get">["identities"][number]
export type ApiKey = Json<"/v1/api-keys", "get">["keys"][number]
export type TemplateSummary = Json<"/v1/templates", "get">["templates"][number]

/** Every topic, archived ones included; screens filter as they need. */
export const allTopicsQuery = queryOptions({
  queryKey: ["topics", "all"],
  queryFn: async () => arr<Topic>((await unwrap(api.GET("/v1/topics")))?.topics),
  staleTime: 60_000,
})

export const segmentsQuery = queryOptions({
  queryKey: ["segments"],
  queryFn: async () => arr<Segment>((await unwrap(api.GET("/v1/segments")))?.segments),
  staleTime: 30_000,
})

export const fieldsQuery = queryOptions({
  queryKey: ["contact-fields"],
  queryFn: async () => arr<ContactField>((await unwrap(api.GET("/v1/contact-fields")))?.fields),
  staleTime: 5 * 60_000,
})

export const identitiesQuery = queryOptions({
  queryKey: ["identities"],
  queryFn: async () => arr<Identity>((await unwrap(api.GET("/v1/identities")))?.identities),
  staleTime: 5 * 60_000,
})

export const templatesQuery = queryOptions({
  queryKey: ["templates"],
  queryFn: async () => arr<TemplateSummary>((await unwrap(api.GET("/v1/templates")))?.templates),
  staleTime: 60_000,
})

/**
 * The workspace's keys, for naming `updatedBy` / `publishedBy` / `createdBy` key ids. Listing keys needs an
 * admin key; without one the ids show as they are.
 */
export const keysQuery = queryOptions({
  queryKey: ["api-keys"],
  queryFn: async () => arr<ApiKey>((await unwrap(api.GET("/v1/api-keys")))?.keys),
  staleTime: 5 * 60_000,
  retry: false,
})

/** "the Coursified dashboard key" for a key id, or the id itself while the keys list isn't readable. */
export function useKeyName() {
  const keys = useQuery(keysQuery).data
  const me = useQuery(meQuery).data
  return (id: string | null | undefined): string => {
    if (!id) return "—"
    if (id === "root" || id === "admin") return "the admin key"
    if (me?.key && me.key.id === id) return `the ${me.key.name} key`
    if (!id.startsWith("key_")) return id
    const k = keys?.find((x) => x.id === id)
    return k ? `the ${k.name} key` : id
  }
}

/** A field's label for pickers: the registry label, with the key beside it once it's named. */
export function fieldLabel(f: Pick<ContactField, "key" | "label"> | undefined, key: string): string {
  if (!f || f.label === f.key) return key
  return f.label
}
