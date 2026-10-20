/**
 * Export analytics (design: the export sheet on every Analytics screen): one CSV per chart from
 * `GET /v1/stats/{chart}.csv`, for a range picked here. Volume uses by=hour for 24h; the 30-day charts read 30d
 * when 90d is picked, as the API does, and each row shows the exact path it will fetch.
 */
import { useState } from "react"
import { ApiError } from "../api/client.ts"
import { download } from "../ops/download.ts"
import { Sheet } from "../ops/Overlay.tsx"
import { toast } from "../ops/toast.tsx"
import { Icon } from "../ui/icons.tsx"
import { type Chart, CSV_CHARTS, csvFor, type Range } from "./logic.ts"

const RANGES: Range[] = ["24h", "7d", "30d", "90d"]

export function ExportSheet({ initial, onClose }: { initial: Range; onClose: () => void }) {
  const [range, setRange] = useState<Range>(initial)
  const [on, setOn] = useState<Set<Chart>>(() => new Set(CSV_CHARTS.map((c) => c.chart)))
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null)
  const picked = CSV_CHARTS.filter((c) => on.has(c.chart))

  const toggle = (c: Chart) =>
    setOn((cur) => {
      const next = new Set(cur)
      if (next.has(c)) next.delete(c)
      else next.add(c)
      return next
    })

  const run = async () => {
    setBusy({ done: 0, total: picked.length })
    const failed: string[] = []
    for (const [i, c] of picked.entries()) {
      const { path, file } = csvFor(c.chart, range)
      try {
        await download(path, file)
      } catch (e) {
        failed.push(`${file}${e instanceof ApiError ? ` (${e.status})` : ""}`)
      }
      setBusy({ done: i + 1, total: picked.length })
    }
    setBusy(null)
    if (failed.length)
      toast(
        {
          tone: "bad",
          title: `${failed.length} of ${picked.length} didn’t download`,
          sub: failed.join(", "),
        },
        8000,
      )
    else {
      toast({ title: `Downloaded ${picked.length} CSV${picked.length === 1 ? "" : "s"}` })
      onClose()
    }
  }

  return (
    <Sheet
      title="Export analytics"
      sub="One CSV per chart, for the range you’re looking at."
      wide
      onClose={onClose}
      odId="export-sheet"
      endpoint="GET /v1/stats/{chart}.csv?range=&by= (each)"
      foot={
        <>
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            type="button"
            disabled={!picked.length || busy !== null}
            onClick={run}
          >
            <Icon name="download" />
            {busy
              ? `Downloading ${busy.done} of ${busy.total}…`
              : `Download ${picked.length} CSV${picked.length === 1 ? "" : "s"}`}
          </button>
        </>
      }
    >
      <div className="field">
        <span className="label" id="export-range">
          Range
        </span>
        {/* biome-ignore lint/a11y/useSemanticElements: the design's segmented control */}
        <div className="seg" role="group" aria-labelledby="export-range">
          {RANGES.map((r) => (
            <button key={r} type="button" aria-pressed={r === range} onClick={() => setRange(r)}>
              {r}
            </button>
          ))}
        </div>
        <span className="hint">
          Volume uses by=hour for 24h and by=day otherwise.
          {range === "90d"
            ? " Only inbound and audience go back 90 days; the others export their last 30."
            : ""}
        </span>
      </div>
      <fieldset className="field ana-fieldset">
        <legend className="label">Charts · {CSV_CHARTS.length}</legend>
        <div className="pick-grid">
          {CSV_CHARTS.map((c) => {
            const { path } = csvFor(c.chart, range)
            const checked = on.has(c.chart)
            return (
              <label key={c.chart} className={`pick${checked ? " is-on" : ""}`}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(c.chart)}
                  className="ana-check"
                />
                <span className="p-name">{c.name}</span>
                <span className="p-sub mono">{path}</span>
              </label>
            )
          })}
        </div>
      </fieldset>
      <p className="hint">
        Each file has a header row. Times are UTC. <b>Rates are fractions</b> (0.0094 means 0.94%), as the API
        returns them, and an empty cell means not enough data. Needs a secret key with the read scope.
      </p>
    </Sheet>
  )
}
