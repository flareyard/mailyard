/**
 * Every query and mutation the Domains screens make, as shared query options so a list row and its detail read
 * the same cache entry. Paths and bodies are checked against src/api/schema.d.ts by the compiler.
 */
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query"
import { api, unwrap } from "../api/client.ts"
import type { Domain } from "./logic.ts"

export const domainsQuery = queryOptions({
  queryKey: ["domains"],
  queryFn: () => unwrap(api.GET("/v1/domains")),
})

/** A domain's detail. While any record is still being checked, it refreshes every 3 seconds. */
export const domainQuery = (id: string) =>
  queryOptions({
    queryKey: ["domains", id],
    queryFn: () => unwrap(api.GET("/v1/domains/{id}", { params: { path: { id } } })),
    refetchInterval: (q) => {
      const d = q.state.data
      return d && (d.checkStatus === "checking" || d.checks.some((c) => c.status === "checking"))
        ? 3000
        : false
    },
  })

/** `connected` here is the one signal for whether the zone token (CLOUDFLARE_DNS_TOKEN) is set. */
export const candidatesQuery = queryOptions({
  queryKey: ["domains", "candidates"],
  queryFn: () => unwrap(api.GET("/v1/domains/candidates")),
  staleTime: 5 * 60_000,
})

export const sendingEventsQuery = queryOptions({
  queryKey: ["sending", "events"],
  queryFn: () => unwrap(api.GET("/v1/sending/events")),
})

export const reputationQuery = queryOptions({
  queryKey: ["reputation"],
  queryFn: () => unwrap(api.GET("/v1/reputation")),
})

export const activeCampaignsQuery = queryOptions({
  queryKey: ["campaigns", "list", "active"],
  queryFn: () => unwrap(api.GET("/v1/campaigns", { params: { query: { status: "active" } } })),
})

/** Writes the fresh domain into both caches, the detail and its row in the list. */
export function usePutDomain() {
  const qc = useQueryClient()
  return (d: Domain) => {
    qc.setQueryData(domainQuery(d.id).queryKey, d)
    void qc.invalidateQueries({ queryKey: domainsQuery.queryKey, exact: true })
  }
}

export function useRecheck(id: string) {
  const put = usePutDomain()
  return useMutation({
    mutationFn: () => unwrap(api.POST("/v1/domains/{id}/recheck", { params: { path: { id } } })),
    onSuccess: put,
  })
}

export function useUpdateDomain(id: string) {
  const put = usePutDomain()
  return useMutation({
    mutationFn: (body: { receiving?: boolean; sending?: boolean; catchAll?: "bounce" | "keep" }) =>
      unwrap(api.PATCH("/v1/domains/{id}", { params: { path: { id } }, body })),
    onSuccess: put,
  })
}

export function useFix(id: string) {
  const put = usePutDomain()
  return useMutation({
    mutationFn: () => unwrap(api.POST("/v1/domains/{id}/fix", { params: { path: { id } } })),
    onSuccess: (r) => put(r.domain),
  })
}

/** DMARC aggregate reports for one domain over a range (HAL-3375). */
export const dmarcQuery = (id: string, range: "7d" | "30d" | "90d") =>
  queryOptions({
    queryKey: ["domains", id, "dmarc", range],
    queryFn: () => unwrap(api.GET("/v1/domains/{id}/dmarc", { params: { path: { id }, query: { range } } })),
  })

/** Mark a sending IP as known (with an optional label), or take that back. */
export function useMarkKnown(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ ip, known, label }: { ip: string; known: boolean; label?: string }) =>
      known
        ? unwrap(
            api.POST("/v1/domains/{id}/dmarc/sources/{ip}/known", {
              params: { path: { id, ip } },
              body: { label: label?.trim() ? label.trim() : null },
            }),
          )
        : unwrap(api.DELETE("/v1/domains/{id}/dmarc/sources/{ip}/known", { params: { path: { id, ip } } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["domains", id, "dmarc"] }),
  })
}

/** `PATCH …/dmarc`: with `dryRun` it only returns the record before and after; without it, it writes DNS. */
export const changeDmarcPolicy = (
  id: string,
  body: { p: "none" | "quarantine" | "reject"; pct?: number | null },
  dryRun: boolean,
) =>
  unwrap(
    api.PATCH("/v1/domains/{id}/dmarc", {
      params: { path: { id }, query: dryRun ? { dryRun: "1" } : {} },
      body,
    }),
  )
