/**
 * The Audience page head and its section tabs (design: every Audience list screen; HANDOFF-audience §4 "Area
 * tabs"). Each tab carries its live count; Suppressions belongs to Transactional (HAL-3372) and links there.
 */
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { api, unwrap } from "../api/client.ts"
import { fmtInt, num } from "../lib/format.ts"
import { Icon } from "../ui/icons.tsx"
import { arr, fieldsQuery, segmentsQuery } from "./kit/queries.ts"
import { PageHead } from "./kit/ui.tsx"
import "./audience.css"

export type AudienceTab = "contacts" | "segments" | "topics" | "forms" | "fields" | "imports"

/** The total behind the Contacts tab: one row is enough, `total` counts them all. */
export const contactsTotalQuery = {
  queryKey: ["contacts", "total"] as const,
  queryFn: async () =>
    num((await unwrap(api.GET("/v1/contacts", { params: { query: { limit: "1" } } })))?.total),
  staleTime: 60_000,
}

const formsCountQuery = {
  queryKey: ["forms", "count"] as const,
  queryFn: async () => arr<unknown>((await unwrap(api.GET("/v1/forms")))?.forms).length,
  staleTime: 60_000,
}

const topicsCountQuery = {
  queryKey: ["topics", "count"] as const,
  queryFn: async () =>
    arr<{ archived?: boolean }>((await unwrap(api.GET("/v1/topics")))?.topics).filter((t) => !t.archived)
      .length,
  staleTime: 60_000,
}

export function AudienceTabs({ current }: { current: AudienceTab }) {
  const contacts = useQuery(contactsTotalQuery).data
  const segments = useQuery(segmentsQuery).data?.length
  const topics = useQuery(topicsCountQuery).data
  const forms = useQuery(formsCountQuery).data
  const fields = useQuery(fieldsQuery).data?.length
  const tabs: { id: AudienceTab; label: string; to: string; n?: number | null | undefined }[] = [
    { id: "contacts", label: "Contacts", to: "/audience/contacts", n: contacts },
    { id: "segments", label: "Segments", to: "/audience/segments", n: segments },
    { id: "topics", label: "Topics", to: "/audience/topics", n: topics },
    { id: "forms", label: "Forms", to: "/audience/forms", n: forms },
    { id: "fields", label: "Fields", to: "/audience/fields", n: fields },
    { id: "imports", label: "Imports", to: "/audience/imports" },
  ]
  return (
    <nav className="au-tabs" aria-label="Audience sections" data-od-id="audience-tabs">
      {tabs.map((t) => (
        <Link
          key={t.id}
          className="au-tab"
          to={t.to}
          aria-current={t.id === current ? "page" : undefined}
          data-od-id={`au-tab-${t.id}`}
        >
          {t.label}
          {t.n !== undefined && t.n !== null ? <span className="au-n">{fmtInt(t.n)}</span> : null}
        </Link>
      ))}
      <Link
        className="au-tab"
        to="/transactional"
        data-tip="In Transactional"
        data-od-id="au-tab-suppressions"
      >
        Suppressions
        <Icon name="external" />
        <span className="sr-only"> (in Transactional)</span>
      </Link>
    </nav>
  )
}

/** The Audience head (title, the tab's own sentence, its actions) and the tabs under it. */
export function AudienceHead({
  current,
  sub,
  actions,
  title = "Audience",
}: {
  current: AudienceTab
  sub: ReactNode
  actions?: ReactNode
  title?: ReactNode
}) {
  return (
    <>
      <PageHead title={title} sub={sub} actions={actions} />
      <AudienceTabs current={current} />
    </>
  )
}
