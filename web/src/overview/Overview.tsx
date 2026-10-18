/**
 * The Overview (HANDOFF §1.6): is email healthy, is anything waiting on you, and what's going out. Every panel
 * reads its own endpoint through <Panel>, so one failing endpoint never blanks the page. The range (24h, 7d,
 * 30d) lives in the URL; 7d is the default and stays out of it.
 */
import { useQuery } from "@tanstack/react-query"
import { getRouteApi } from "@tanstack/react-router"
import { useCallback, useEffect } from "react"
import { fixturesEnabled } from "../fixtures/mode.ts"
import { fmtInt, num } from "../lib/format.ts"
import { Icon } from "../ui/icons.tsx"
import { ActivityPanel } from "./ActivityPanel.tsx"
import { AudiencePanel } from "./AudiencePanel.tsx"
import { CostPanel } from "./CostPanel.tsx"
import { FunnelPanel } from "./FunnelPanel.tsx"
import { GoingOutPanel } from "./GoingOutPanel.tsx"
import { HealthPanel } from "./HealthPanel.tsx"
import { InboundPanel } from "./InboundPanel.tsx"
import { isTypingTarget, RANGES, type Range, rangeForKey } from "./logic.ts"
import { NeedsYouPanel } from "./NeedsYouPanel.tsx"
import { deliveryQuery } from "./queries.ts"
import { RatesPanel } from "./RatesPanel.tsx"
import { OfflineContext, useOnline } from "./shared.tsx"
import { VolumePanel } from "./VolumePanel.tsx"
import "./overview.css"

const route = getRouteApi("/_app/")

export function Overview() {
  const { range = "7d" } = route.useSearch()
  const navigate = route.useNavigate()
  const online = useOnline()
  const offline = !online

  const setRange = useCallback(
    (r: Range) => {
      navigate({ search: r === "7d" ? {} : { range: r } })
    },
    [navigate],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (offline || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.defaultPrevented) return
      if (isTypingTarget(document.activeElement)) return
      if (document.querySelector("[role='dialog']:not([hidden])")) return
      const r = rangeForKey(e.key)
      if (r) {
        e.preventDefault()
        setRange(r)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [offline, setRange])

  return (
    <OfflineContext.Provider value={offline}>
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <p className="sub">Is your email healthy, is anything waiting on you, and what’s going out.</p>
        </div>
        <div className="cluster cluster-12">
          {fixturesEnabled() ? (
            <span className="pill pill-sample sample-marker">
              <Icon name="info" />
              Sample data
              <span className="sr-only">: Every name and figure on this screen is fixture data.</span>
            </span>
          ) : null}
          <RangeControl range={range} onChange={setRange} offline={offline} />
        </div>
      </div>
      <div className={`grid-12${offline ? " ov-offline" : ""}`}>
        <NotEnoughData range={range} />
        <HealthPanel />
        <NeedsYouPanel />
        <FunnelPanel range={range} />
        <RatesPanel range={range} />
        <GoingOutPanel />
        <VolumePanel range={range} />
        <InboundPanel range={range} />
        <AudiencePanel range={range} />
        <CostPanel />
        <ActivityPanel />
      </div>
    </OfflineContext.Provider>
  )
}

function RangeControl({
  range,
  onChange,
  offline,
}: {
  range: Range
  onChange: (r: Range) => void
  offline: boolean
}) {
  const seg = (
    // biome-ignore lint/a11y/useSemanticElements: the design's segmented control; a fieldset would need a legend it doesn't show
    <div className="seg" role="group" aria-label="Range for every panel">
      {RANGES.map((r) => (
        <button
          key={r.key}
          type="button"
          aria-pressed={r.key === range}
          data-tip={`${r.label} · ${r.shortcut}`}
          aria-keyshortcuts={r.shortcut}
          disabled={offline}
          onClick={() => onChange(r.key)}
        >
          {r.key}
        </button>
      ))}
    </div>
  )
  if (!offline) return seg
  return (
    <span className="has-reason">
      {seg}
      <span className="reason-pop is-right" role="tooltip">
        <b>Needs a connection. Showing what loaded before you went offline.</b>
      </span>
    </span>
  )
}

/** Under the minimum sends, a note above the grid says counts are real and percentages wait (HANDOFF §4). */
function NotEnoughData({ range }: { range: Range }) {
  const q = useQuery(deliveryQuery(range))
  if (!q.data?.rates.insufficientData) return null
  const minimum = num(q.data.rates.minimumSends) ?? 100
  return (
    <div className="callout callout-info ov-note" role="status">
      <Icon name="info" />
      <span>
        <b>Not enough data yet.</b> Rates appear once a range holds {fmtInt(minimum)} sends, the minimum
        Cloudflare’s reputation policy uses. This range has {fmtInt(q.data.totals.sent)}. Counts below are
        real; percentages wait.
      </span>
    </div>
  )
}
