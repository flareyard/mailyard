/**
 * The panel frame every Overview panel and most later screens share (HANDOFF §1.5): it owns loading
 * (skeletons in the final layout), error (what failed, retry, the request id), empty and the full body.
 */
import type { UseQueryResult } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { ApiError } from "../api/client.ts"
import { Icon } from "./icons.tsx"

type Props<T> = {
  id: string
  title: string
  /** Where the title and the "go" link lead, as an app route. */
  to?: string
  linkLabel?: string
  meta?: ReactNode
  span?: 3 | 4 | 5 | 6 | 7 | 8 | 12
  /** The endpoint(s) feeding the panel, kept as data-endpoint like the designs. */
  endpoint: string
  query: UseQueryResult<T>
  isEmpty?: (data: T) => boolean
  empty?: ReactNode
  skeleton?: ReactNode
  children: (data: T) => ReactNode
}

export function Panel<T>({
  id,
  title,
  to,
  linkLabel,
  meta,
  span = 12,
  endpoint,
  query,
  isEmpty,
  empty,
  skeleton,
  children,
}: Props<T>) {
  const h = `h-${id}`
  return (
    <section
      className={`panel span-${span}${query.isError ? " is-error" : ""}`}
      data-endpoint={endpoint}
      aria-labelledby={h}
      aria-busy={query.isPending}
    >
      <header className="panel-head">
        <h2 className="panel-title" id={h}>
          {to ? <Link to={to}>{title}</Link> : title}
        </h2>
        <div className="cluster">
          {meta ? <span className="panel-meta">{meta}</span> : null}
          {to && linkLabel ? (
            <Link className="panel-link" to={to}>
              {linkLabel}
              <Icon name="chevron-right" />
            </Link>
          ) : null}
        </div>
      </header>
      <div className="panel-body">
        {query.isPending ? (
          (skeleton ?? <PanelSkeleton />)
        ) : query.isError ? (
          <PanelError error={query.error} onRetry={() => query.refetch()} what={`${title} didn’t load`} />
        ) : isEmpty?.(query.data) ? (
          (empty ?? <p className="muted t-small">Nothing here yet.</p>)
        ) : (
          children(query.data)
        )}
      </div>
    </section>
  )
}

export function PanelSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="stack stack-8" aria-hidden="true">
      <span className="sk sk-title" />
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
        <span key={i} className="sk sk-text" style={{ width: `${92 - i * 15}%` }} />
      ))}
    </div>
  )
}

/** The designed error block: what failed, in words; a retry; the request id with a copy button. */
export function PanelError({ error, onRetry, what }: { error: unknown; onRetry: () => void; what?: string }) {
  const e = error instanceof ApiError ? error : null
  return (
    <div className="error-block" role="alert">
      <h3>
        <Icon name="warn" />
        {what ?? "This didn’t load"}
      </h3>
      <p>
        {e ? (
          <>
            The API answered <b>{e.status}</b>: {e.message}
          </>
        ) : (
          "Mailyard couldn’t be reached. Check your connection; the rest of the page is unaffected."
        )}
      </p>
      <div className="cluster">
        <button className="btn btn-secondary btn-sm" type="button" onClick={onRetry}>
          <Icon name="refresh" />
          Retry
        </button>
        {e?.requestId ? <RequestId id={e.requestId} /> : null}
      </div>
    </div>
  )
}

export function RequestId({ id }: { id: string }) {
  return (
    <span className="req-id">
      Request id <code className="mono">{id}</code>
      <button
        className="copy-btn"
        type="button"
        aria-label="Copy request id"
        onClick={() => navigator.clipboard?.writeText(id)}
      >
        <Icon name="copy" />
      </button>
    </span>
  )
}
