/**
 * Small pieces the Overview panels share: links from route strings, the check chip, the offline flag, the
 * stale meta, and `combineQueries` so a panel fed by several endpoints still hands one query to <Panel>.
 */
import type { UseQueryResult } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { createContext, type ReactNode, useContext, useEffect, useState } from "react"
import { Icon } from "../ui/icons.tsx"
import { type ChipStatus, hhmm, RANGE_LABEL, type Range } from "./logic.ts"

/**
 * A link from a route string such as "/mail?is=unread" or "/domains/reputation#bounce". The entity routes
 * (HANDOFF §2) are typed loosely here because several of them land with later sections.
 */
export function AppLink({
  href,
  className,
  style,
  children,
  ...rest
}: {
  href: string
  className?: string
  style?: React.CSSProperties
  children: ReactNode
  "aria-label"?: string
  title?: string
}) {
  const [beforeHash, hash] = href.split("#") as [string, string | undefined]
  const [path, qs] = beforeHash.split("?") as [string, string | undefined]
  const search = qs ? Object.fromEntries(new URLSearchParams(qs)) : undefined
  return (
    <Link
      to={path as never}
      {...(search ? { search: search as never } : {})}
      {...(hash ? { hash } : {})}
      {...(className ? { className } : {})}
      {...(style ? { style } : {})}
      {...rest}
    >
      {children}
    </Link>
  )
}

const CHIP_ICON = {
  pass: "check-circle",
  warn: "warn",
  fail: "x-circle",
  off: "circle",
  error: "warn",
} as const
const CHIP_CLASS = {
  pass: "pass",
  warn: "warn",
  fail: "fail",
  off: "off",
  error: "warn",
  checking: "checking",
} as const
const CHIP_WORD = {
  pass: "passing",
  warn: "warning",
  fail: "failing",
  off: "off",
  error: "check error",
  checking: "checking now",
} as const

/** One check in the health strip. `sub` is the muted qualifier ("off", "unknown without a zone token"). */
export function CheckChip({
  label,
  status,
  sub,
  note,
  tip,
}: {
  label: string
  status: ChipStatus
  sub?: string
  note?: string
  tip?: string
}) {
  const word = CHIP_WORD[status]
  const when = note ? ` · ${note}` : ""
  if (status === "checking") {
    return (
      <span className="check-chip checking" title={tip ?? `${label}: checking now`}>
        <span className="spinner ov-chip-spinner" aria-hidden="true" />
        {label} <span className="sub">checking</span>
        <span className="sr-only"> checking now</span>
      </span>
    )
  }
  return (
    <span className={`check-chip ${CHIP_CLASS[status]}`} title={tip ?? `${label}: ${word}${when}`}>
      <Icon name={CHIP_ICON[status]} />
      {label}
      {sub ? (
        <>
          {" "}
          <span className="sub">{sub}</span>
        </>
      ) : null}
      <span className="sr-only">
        {" "}
        {sub && status === "off" ? sub : word}
        {when}
      </span>
    </span>
  )
}

export function useOnline() {
  const [online, set] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine))
  useEffect(() => {
    const on = () => set(true)
    const off = () => set(false)
    window.addEventListener("online", on)
    window.addEventListener("offline", off)
    return () => {
      window.removeEventListener("online", on)
      window.removeEventListener("offline", off)
    }
  }, [])
  return online
}

/** Whether the page is offline, so every panel can say what it shows is "as of" its last load. */
export const OfflineContext = createContext(false)
export const useOffline = () => useContext(OfflineContext)

/** The panel meta: the range label, or "As of hh:mm UTC" with the last successful load when offline. */
export function StaleMeta({
  offline,
  updatedAt,
  label,
}: {
  offline: boolean
  updatedAt: number
  label: string
}) {
  if (offline && updatedAt) {
    return (
      <>
        <Icon name="wifi-off" className="icon-12" /> As of {hhmm(new Date(updatedAt))} UTC
      </>
    )
  }
  return <>{label}</>
}
export const rangeLabel = (r: Range) => RANGE_LABEL[r]

/**
 * Folds several queries into the one <Panel> reads: pending while any required query is pending, the first
 * required error, and `refetch` retries every query that failed. Optional queries never block the panel; the
 * body handles them being absent.
 */
export function combineQueries<T>(
  required: UseQueryResult<unknown>[],
  optional: UseQueryResult<unknown>[],
  build: () => T,
): UseQueryResult<T> {
  const isPending = required.some((q) => q.isPending)
  const failed = required.find((q) => q.isError)
  const all = [...required, ...optional]
  const result = {
    isPending,
    isError: !isPending && Boolean(failed),
    error: failed?.error ?? null,
    data: isPending || failed ? undefined : build(),
    dataUpdatedAt: Math.max(0, ...required.map((q) => q.dataUpdatedAt)),
    refetch: async () => {
      await Promise.all(all.filter((q) => q.isError).map((q) => q.refetch()))
      return result
    },
  }
  return result as unknown as UseQueryResult<T>
}

/** The panel footer, drawn inside the body and pinned to the bottom of the panel (overview.css). */
export function PanelFoot({ children }: { children: ReactNode }) {
  return <footer className="panel-foot ov-foot">{children}</footer>
}

/** Spreads a prop only when it has a value (exactOptionalPropertyTypes forbids passing `undefined`). */
export function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V }
}

/** A query that has already settled with `data`, for panels whose body doesn't depend on a request. */
export function settled<T>(data: T): UseQueryResult<T> {
  const r = { isPending: false, isError: false, error: null, data, dataUpdatedAt: 0, refetch: async () => r }
  return r as unknown as UseQueryResult<T>
}
