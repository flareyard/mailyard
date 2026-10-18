/**
 * Contact import's reads and writes, shared by Audience → Imports and the first run's CSV step. Keys are
 * `["imports"]` and `["imports", id]`, so an import started in either place shows in both.
 *
 * - `POST /v1/uploads?filename=` takes the file as the raw body and answers `{ id: "upl_…", … }`.
 * - `POST /v1/imports/contacts { uploadId, mapping, topicIds, onConflict, defaultStatus, consent? }` starts it.
 * - `GET /v1/imports/{id}` is polled every 2 s while it's queued or running; `POST /v1/imports/{id}/cancel`.
 * - `GET /v1/imports/{id}/errors.csv` (a raw route outside the OpenAPI) has every row error.
 */
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api, type paths, unwrap } from "../../api/client.ts"
import { isActiveImport, type MappingRow, toImportMapping } from "./logic.ts"

type Json<P extends keyof paths, M extends "get" | "post"> = paths[P][M] extends {
  responses: { 200: { content: { "application/json": infer R } } }
}
  ? R
  : never

export type ContactImport = Json<"/v1/imports/{id}", "get">
export type ImportListItem = Json<"/v1/imports", "get">["imports"][number]
export type Upload = paths["/v1/uploads"]["post"]["responses"][201]["content"]["application/json"]

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])

export const contactImportsQuery = queryOptions({
  queryKey: ["imports"],
  queryFn: async () => arr<ContactImport>((await unwrap(api.GET("/v1/imports")))?.imports),
})

export const contactImportQuery = (id: string) =>
  queryOptions({
    queryKey: ["imports", id],
    queryFn: () => unwrap(api.GET("/v1/imports/{id}", { params: { path: { id } } })),
  })

/** Where every row error downloads from (all of them; the import keeps the first 100 in `errors`). */
export const errorsCsvUrl = (id: string) => `/v1/imports/${encodeURIComponent(id)}/errors.csv`

/**
 * Uploads a picked file once (cached by name, size and modified time, so going back and forth doesn't upload it
 * again) and answers the `upl_…` id.
 */
export function useUpload(file: File | null) {
  return useQuery({
    queryKey: ["upload", file?.name, file?.size, file?.lastModified],
    queryFn: async () =>
      unwrap(
        api.POST("/v1/uploads", {
          params: { query: { filename: (file as File).name } },
          body: file as unknown as string,
          bodySerializer: (b: unknown) => b,
          headers: { "content-type": (file as File).type || "text/csv" },
        }),
      ) as Promise<Upload>,
    enabled: Boolean(file),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 30 * 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  })
}

export type StartImport = {
  uploadId: string
  mapping: readonly MappingRow[]
  topicIds: string[]
  onConflict: "update" | "skip"
  defaultStatus: "subscribed" | "unsubscribed"
  /** Sent only when ticked: `attested: false` is refused, so leaving it out is how you import without one. */
  consent: { attested: boolean; statement: string }
}

/** The `POST /v1/imports/contacts` body; consent only when attested, the statement only when written. */
export function startBody(s: StartImport) {
  const st = s.consent.statement.trim()
  return {
    uploadId: s.uploadId,
    mapping: toImportMapping(s.mapping),
    topicIds: s.topicIds,
    onConflict: s.onConflict,
    defaultStatus: s.defaultStatus,
    ...(s.consent.attested ? { consent: { attested: true as const, ...(st ? { statement: st } : {}) } } : {}),
  }
}

export function useStartImport(onStarted: (imp: ContactImport) => void) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (s: StartImport) => unwrap(api.POST("/v1/imports/contacts", { body: startBody(s) })),
    onSuccess: (imp) => {
      if (!imp || !("id" in imp)) return
      qc.setQueryData(contactImportQuery(imp.id).queryKey, imp)
      qc.invalidateQueries({ queryKey: ["imports"], exact: true })
      onStarted(imp)
    },
  })
}

/** An import, polled every 2 s while it's queued or running. */
export function useContactImport(id: string | null, initial?: ContactImport) {
  return useQuery({
    ...contactImportQuery(id ?? ""),
    enabled: Boolean(id),
    ...(initial ? { initialData: initial } : {}),
    refetchInterval: (q) => {
      const d = q.state.data as ContactImport | undefined
      return d && "status" in d && isActiveImport(d.status) ? 2000 : false
    },
  })
}

export function useCancelImport(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => unwrap(api.POST("/v1/imports/{id}/cancel", { params: { path: { id } } })),
    onSuccess: (res) => {
      if (res && "id" in res) qc.setQueryData(contactImportQuery(id).queryKey, res)
      qc.invalidateQueries({ queryKey: ["imports"], exact: true })
      qc.invalidateQueries({ queryKey: ["contacts"] })
    },
  })
}
