/**
 * Pieces every Analytics view shares: the range from the URL, the chart panel (meta, Built marker, CSV, the
 * source line), the CSV button and its scope gate, and the line chart with thresholds and hatching.
 */
import type { UseQueryResult } from "@tanstack/react-query"
import { getRouteApi } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { ApiError } from "../api/client.ts"
import { Gated } from "../auth/NoPermission.tsx"
import { type Me, useMe } from "../auth/session.ts"
import { download } from "../ops/download.ts"
import { BuiltPill } from "../ops/kit.tsx"
import { hasScope } from "../ops/roles.ts"
import { toast } from "../ops/toast.tsx"
import { Icon } from "../ui/icons.tsx"
import { PanelError, PanelSkeleton } from "../ui/Panel.tsx"
import {
  type Chart,
  csvFor,
  DEFAULT_RANGE,
  effectiveRange,
  hatchSpans,
  linePaths,
  RANGE_META,
  type Range,
  type View,
} from "./logic.ts"

const layout = getRouteApi("/_app/analytics")

/** The range a view reads: from the URL (7d when absent), clamped to what the view offers. */
export function useRange(view: View): Range {
  const { range = DEFAULT_RANGE } = layout.useSearch()
  return effectiveRange(view, range)
}

export const metaFor = (r: Range) => RANGE_META[r].meta

/** Whether CSV downloads are open to this caller: they check for the read scope themselves (HANDOFF-ops §25). */
export function csvAccess(me: Me | undefined): { ok: boolean; why: string } {
  if (hasScope(me, "read")) return { ok: true, why: "" }
  const key = me?.key?.name
  const scopes = (me?.scopes ?? []).join(", ")
  return {
    ok: false,
    why: key
      ? `The key you’re signed in with, ${key}, is a secret key with the ${scopes || "no"} scope${(me?.scopes.length ?? 0) === 1 ? "" : "s"} but not read, and CSV downloads check for read itself.`
      : "Your sign-in doesn’t carry the read scope, and CSV downloads check for read themselves.",
  }
}

export async function saveCsv(chart: Chart, range: Range) {
  const { path, file } = csvFor(chart, range)
  try {
    await download(path, file)
    toast({ title: `Downloaded ${file}` })
  } catch (e) {
    toast({
      tone: "bad",
      title: `${file} didn’t download`,
      sub:
        e instanceof ApiError
          ? `The API answered ${e.status}: ${e.message}`
          : "Mailyard couldn’t be reached.",
    })
  }
}

export function CsvButton({ chart, range }: { chart: Chart; range: Range }) {
  const me = useMe()
  const access = csvAccess(me.data)
  const { path } = csvFor(chart, range)
  return (
    <Gated allowed={access.ok} reason="CSV needs a secret key with read" who={access.why} side="right">
      <button
        className="btn btn-ghost btn-sm"
        type="button"
        data-endpoint={`GET ${path}`}
        aria-label={`Download ${chart} as CSV`}
        onClick={() => saveCsv(chart, range)}
      >
        <Icon name="download" />
        CSV
      </button>
    </Gated>
  )
}

type PanelProps<T> = {
  id: string
  title: ReactNode
  /** Plain text for loading and error copy. */
  name: string
  range?: Range
  meta?: ReactNode
  endpoint: string
  query: UseQueryResult<T>
  built?: string
  csv?: Chart
  link?: ReactNode
  skeleton?: ReactNode
  empty?: (data: T) => ReactNode | null
  children: (data: T) => ReactNode
  foot?: boolean
}

/** A chart panel as the designs draw it: head with range, Built marker and CSV; body; a source line. */
export function ChartPanel<T>({
  id,
  title,
  name,
  range,
  meta,
  endpoint,
  query,
  built,
  csv,
  link,
  skeleton,
  empty,
  children,
  foot = true,
}: PanelProps<T>) {
  const h = `h-${id}`
  const when = meta ?? (range ? metaFor(range) : null)
  const emptyNode = query.data !== undefined && empty ? empty(query.data) : null
  return (
    <section
      className={`panel${query.isError ? " is-error" : ""}`}
      data-endpoint={endpoint}
      data-od-id={`panel-${id}`}
      aria-labelledby={h}
      aria-busy={query.isPending}
    >
      <header className="panel-head">
        <h2 className="panel-title" id={h}>
          {title}
        </h2>
        <div className="cluster">
          {when ? <span className="panel-meta">{when}</span> : null}
          {built ? <BuiltPill issue={built} /> : null}
          {link}
          {csv && range ? <CsvButton chart={csv} range={range} /> : null}
        </div>
      </header>
      <div className="panel-body">
        {query.isPending ? (
          (skeleton ?? <PanelSkeleton rows={4} />)
        ) : query.isError ? (
          <ErrorBlock error={query.error} endpoint={endpoint} name={name} onRetry={() => query.refetch()} />
        ) : (
          (emptyNode ?? children(query.data as T))
        )}
      </div>
      {foot ? (
        <footer className="panel-foot">
          <span className="source-line">
            Source <code className="mono">{endpoint}</code>
            {when ? <> · {when}</> : null}
          </span>
        </footer>
      ) : null}
    </section>
  )
}

/** The designed error: what didn't load, the endpoint and status, Retry and the request id. */
export function ErrorBlock({
  error,
  endpoint,
  name,
  onRetry,
}: {
  error: unknown
  endpoint: string
  name: string
  onRetry: () => void
}) {
  if (!(error instanceof ApiError))
    return <PanelError error={error} onRetry={onRetry} what={`${name} didn’t load`} />
  return (
    <div className="error-block" role="alert" data-od-id="error-block">
      <h3>
        <Icon name="warn" />
        {name} didn’t load
      </h3>
      <p>
        <code className="mono">{endpoint}</code> answered{" "}
        <b>
          {error.status} {error.message}
        </b>
        . Nothing else on this page changed. It retries when you come back to the tab.
      </p>
      <div className="cluster">
        <button className="btn btn-secondary btn-sm" type="button" onClick={onRetry}>
          <Icon name="refresh" />
          Retry
        </button>
        {error.requestId ? (
          <span className="req-id">
            Request id <code className="mono">{error.requestId}</code>
            <button
              className="copy-btn"
              type="button"
              aria-label="Copy request id"
              onClick={() => navigator.clipboard?.writeText(error.requestId ?? "")}
            >
              <Icon name="copy" />
            </button>
          </span>
        ) : null}
      </div>
    </div>
  )
}

export type Threshold = { at: number; label: string; risk?: boolean }

/**
 * A line chart (`.lc`): y axis, grid, the filled area under the line, threshold lines carrying their values,
 * hatched spans and two x labels. `values` already scaled to the axis top; a null is a gap.
 */
export function LineChart({
  label,
  values,
  top,
  ticks,
  thresholds = [],
  hatch = [],
  hatchLabel,
  hatchTitle,
  first,
  last,
  tone,
  table,
}: {
  label: string
  values: (number | null)[]
  top: number
  ticks: { bottom: number; label: string }[]
  thresholds?: Threshold[]
  hatch?: boolean[]
  hatchLabel?: string
  hatchTitle?: string
  first: string
  last: string
  tone?: "good"
  /** The data as rows, for screen readers (the chart itself is an image). */
  table?: { head: [string, string]; rows: [string, string][] }
}) {
  const runs = linePaths(values, top)
  const spans = hatchSpans(hatch)
  const cls = tone === "good" ? " is-good" : ""
  return (
    <>
      <div className="lc" role="img" aria-label={label}>
        <div className="lc-axis" aria-hidden="true">
          {ticks.map((t) => (
            <span key={t.bottom} style={{ bottom: `${t.bottom}%` }}>
              {t.label}
            </span>
          ))}
        </div>
        <div className="lc-plot">
          {[25, 50, 75].map((b) => (
            <i key={b} className="lc-grid" style={{ bottom: `${b}%` }} />
          ))}
          {spans.map((s) => (
            <div
              key={s.left}
              className="lc-insuf"
              style={{ left: `${s.left.toFixed(1)}%`, width: `${s.width.toFixed(1)}%` }}
              title={hatchTitle}
            >
              {hatchLabel && s.width > 30 ? <span>{hatchLabel}</span> : null}
            </div>
          ))}
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            {runs.map((r) => (
              <g key={r.line}>
                <path className={`area${cls}`} d={r.area} />
                <path className={`line${cls}`} d={r.line} />
              </g>
            ))}
          </svg>
          {thresholds.map((t) => (
            <i
              key={t.label}
              className={`lc-th${t.risk ? " risk" : ""}`}
              style={{ bottom: `${t.at.toFixed(1)}%` }}
            >
              <span>{t.label}</span>
            </i>
          ))}
        </div>
        <div className="lc-x" aria-hidden="true">
          <span>{first}</span>
          <span>{last}</span>
        </div>
      </div>
      {table ? (
        <div className="sr-only">
          <table>
            <caption>{label}</caption>
            <thead>
              <tr>
                <th>{table.head[0]}</th>
                <th>{table.head[1]}</th>
              </tr>
            </thead>
            <tbody>
              {table.rows.map(([a, b]) => (
                <tr key={a}>
                  <td>{a}</td>
                  <td>{b}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  )
}

/** "11 Oct" from "2026-10-11". */
export const shortDay = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en", { day: "numeric", month: "short", timeZone: "UTC" })
export const weekdayOf = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en", { weekday: "short", timeZone: "UTC" })
export const dayLong = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  })

export function SkeletonBlock({ height }: { height: number }) {
  return <span className="sk" style={{ display: "block", height }} aria-hidden="true" />
}
