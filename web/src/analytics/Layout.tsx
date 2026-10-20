/**
 * The Analytics frame (design: screens/ops/analytics/*): the page head with the range control and Export, the
 * view tabs, then the view. The range is in the URL (7d stays out of it) and is kept across tabs; the digits 1
 * to 4 pick a range like the Overview's. Every role may open Analytics; it is read-only for everyone.
 */
import { getRouteApi, Link, Outlet, useLocation } from "@tanstack/react-router"
import { useCallback, useEffect } from "react"
import { Gated } from "../auth/NoPermission.tsx"
import { useMe } from "../auth/session.ts"
import { PageHead } from "../ops/kit.tsx"
import { Toaster } from "../ops/toast.tsx"
import { Icon } from "../ui/icons.tsx"
import { ExportSheet } from "./ExportSheet.tsx"
import {
  DEFAULT_RANGE,
  effectiveRange,
  isTypingTarget,
  RANGE_META,
  type Range,
  rangeForKey,
  rangesFor,
  VIEWS,
  viewFromPath,
} from "./logic.ts"
import { csvAccess } from "./shared.tsx"
import "./analytics.css"

const route = getRouteApi("/_app/analytics")

export function AnalyticsLayout() {
  const search = route.useSearch()
  const navigate = route.useNavigate()
  const { pathname } = useLocation()
  const view = viewFromPath(pathname)
  const offered = rangesFor(view)
  const range = effectiveRange(view, search.range ?? DEFAULT_RANGE)
  const me = useMe()
  const csv = csvAccess(me.data)

  const setRange = useCallback(
    (r: Range) => {
      navigate({
        to: ".",
        search: (prev) => {
          const { range: _drop, ...rest } = prev
          return r === DEFAULT_RANGE ? rest : { ...rest, range: r }
        },
        replace: true,
      })
    },
    [navigate],
  )
  const setExport = (open: boolean) =>
    navigate({
      to: ".",
      search: (prev) => {
        const { export: _drop, ...rest } = prev
        return open ? { ...rest, export: 1 as const } : rest
      },
    })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.defaultPrevented) return
      if (isTypingTarget(document.activeElement)) return
      if (document.querySelector("[role='dialog']")) return
      const r = rangeForKey(e.key, offered)
      if (r) {
        e.preventDefault()
        setRange(r)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [offered, setRange])

  return (
    <div className="ops">
      <PageHead
        title="Analytics"
        sub="Every chart carries its range, its source and a CSV export. Opens are always an estimate."
        actions={
          <>
            {/* biome-ignore lint/a11y/useSemanticElements: the design's segmented control; a fieldset would need a legend it doesn't show */}
            <div className="seg" role="group" aria-label="Range for every chart" data-od-id="range-control">
              {offered.map((r, i) => (
                <button
                  key={r}
                  type="button"
                  aria-pressed={r === range}
                  data-tip={`${RANGE_META[r].label} · ${i + 1}`}
                  aria-keyshortcuts={String(i + 1)}
                  onClick={() => setRange(r)}
                >
                  {r}
                </button>
              ))}
            </div>
            <Gated allowed={csv.ok} reason="CSV needs a secret key with read" who={csv.why} side="right">
              <button className="btn btn-secondary" type="button" onClick={() => setExport(true)}>
                <Icon name="download" />
                Export
              </button>
            </Gated>
          </>
        }
      />
      <nav className="page-tabs" aria-label="Analytics views" data-od-id="section-tabs">
        {VIEWS.map((v) => (
          <Link
            key={v.key}
            className="ptab"
            to={`/analytics/${v.key}`}
            search={(prev: Record<string, unknown>) => prev}
            activeOptions={{ includeSearch: false }}
            activeProps={{ "aria-current": "page" }}
            data-od-id={`tab-${v.key}`}
          >
            {v.label}
          </Link>
        ))}
      </nav>
      {!csv.ok ? (
        <div className="callout callout-info ana-note" role="status">
          <Icon name="info" />
          <span>
            <b>CSV export is off for this {me.data?.key ? "key" : "sign-in"}.</b> {csv.why} Every chart still
            shows here.
          </span>
        </div>
      ) : null}
      <Outlet />
      {search.export && csv.ok ? (
        <ExportSheet initial={search.range ?? DEFAULT_RANGE} onClose={() => setExport(false)} />
      ) : null}
      <Toaster />
    </div>
  )
}
