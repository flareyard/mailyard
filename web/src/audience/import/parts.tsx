/**
 * Pieces of Audience → Imports (design: import-*.html): the five steps, the five count tiles with the
 * arithmetic written out, and the row-errors table with its CSV download.
 */
import { useState } from "react"
import { fmtInt, num } from "../../lib/format.ts"
import { Icon } from "../../ui/icons.tsx"
import { arithmeticLine, type ImportCounts } from "./logic.ts"
import { type ContactImport, errorsCsvUrl } from "./queries.ts"

const STEPS = ["Choose file", "Map columns", "Options", "Import", "Report"] as const

/** `ol.hsteps`: steps before `current` are done; `fail` marks the current one failed (a failed import). */
export function ImportSteps({ current, fail }: { current: 1 | 2 | 3 | 4 | 5; fail?: boolean }) {
  return (
    <ol className="hsteps" aria-label="Import steps" data-od-id="import-steps">
      {STEPS.map((label, i) => {
        const n = i + 1
        const done = n < current || (n === current && current === 5 && !fail)
        const failed = n === current && fail
        return (
          <li key={label} className={`hstep${done ? " is-done" : failed ? " is-fail" : ""}`}>
            <span {...(n === current ? { "aria-current": "step" as const } : {})}>
              <span className="hs-ic">{done ? <Icon name="check" /> : failed ? <Icon name="x" /> : n}</span>
              {label}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/** Created, updated, skipped, invalid, duplicates: five tiles, then the sum (decision 3). */
export function ImportTiles({ imp, running }: { imp: ImportCounts; running?: boolean }) {
  const sup = num(imp.suppressed) ?? 0
  const bad = num(imp.invalid) ?? 0
  const dup = num(imp.duplicates) ?? 0
  const tiles: { label: string; v: unknown; c: string; s?: string | null; bad?: boolean }[] = [
    {
      label: "Created",
      v: imp.created,
      c: "--data-good",
      s: sup > 0 ? `including ${fmtInt(sup)} suppressed` : null,
    },
    { label: "Updated", v: imp.updated, c: "--data-transactional" },
    { label: "Skipped", v: imp.skipped, c: "--data-neutral" },
    {
      label: "Invalid",
      v: imp.invalid,
      c: "--data-bad",
      bad: bad > 0,
      s: bad > 0 ? (running ? "with their reasons so far" : "each listed with its line") : null,
    },
    {
      label: "Duplicates",
      v: imp.duplicates,
      c: "--data-mailbox",
      s: dup > 0 ? "repeats in the file, merged" : null,
    },
  ]
  return (
    <>
      <div className="bigstats" data-od-id="import-counts">
        {tiles.map((t) => (
          <div key={t.label} className={t.bad ? "is-bad" : ""}>
            <span className="bs-l">
              <i className="sw" style={{ ["--c" as string]: `var(${t.c})` }} />
              {t.label}
            </span>
            <span className="bs-v">{fmtInt(t.v as number)}</span>
            {t.s ? <span className="bs-s">{t.s}</span> : null}
          </div>
        ))}
      </div>
      <p className="imp-sum mono" data-od-id="import-arithmetic">
        {arithmeticLine(imp)}
      </p>
    </>
  )
}

/** Rows that didn't import: the first 8, then the first 100 the import keeps; every one is in the CSV. */
export function RowErrorsPanel({ imp }: { imp: ContactImport }) {
  const [all, setAll] = useState(false)
  const total = num(imp.errorsTotal) ?? imp.errors.length
  const kept = imp.errors.length
  const shown = all ? imp.errors : imp.errors.slice(0, 8)
  const file = (imp.fileName ?? "contacts").replace(/\.csv$/i, "")
  return (
    <section
      className="panel"
      data-endpoint={`GET /v1/imports/${imp.id} → errors[] (first 100), errorsTotal · GET /v1/imports/${imp.id}/errors.csv`}
      data-od-id="panel-row-errors"
      aria-labelledby="h-row-errors"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-row-errors">
          Rows that didn’t import · {fmtInt(total)}
        </h2>
        <div className="cluster">
          <a
            className="btn btn-primary btn-sm"
            href={errorsCsvUrl(imp.id)}
            download={`${file}-errors.csv`}
            data-od-id="download-errors"
          >
            <Icon name="download" />
            Download all errors (CSV)
          </a>
        </div>
      </header>
      <div className="panel-body">
        <div className="table-wrap">
          <table className="table dt" data-od-id="import-errors" style={{ minWidth: 640 }}>
            <thead>
              <tr>
                <th className="r">Line</th>
                <th>Column</th>
                <th>Value</th>
                <th>Code</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((e, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a line can carry one error; index breaks ties
                <tr key={`${e.line}-${i}`}>
                  <td className="r num">{fmtInt(e.line)}</td>
                  <td>{e.column ?? <span className="muted">—</span>}</td>
                  <td>
                    {e.value ? (
                      <code className="mono" style={{ overflowWrap: "anywhere" }}>
                        {e.value}
                      </code>
                    ) : (
                      <span className="muted">empty</span>
                    )}
                  </td>
                  <td>
                    {e.code ? <code className="mono">{e.code}</code> : <span className="muted">—</span>}
                  </td>
                  <td style={{ whiteSpace: "normal", minWidth: 220 }}>{e.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="dt-foot">
          <span>
            {total > kept
              ? `Showing ${fmtInt(shown.length)} here of the first ${fmtInt(kept)} the import keeps; the CSV has all ${fmtInt(total)}.`
              : `Showing ${fmtInt(shown.length)} of ${fmtInt(total)}.`}{" "}
            Lines count the header as line 1.
          </span>
          {kept > 8 ? (
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => setAll((v) => !v)}>
              {all ? "Show the first 8" : `Show the first ${fmtInt(kept)}`}
            </button>
          ) : null}
        </div>
        <p className="hint" style={{ marginTop: 8 }}>
          Codes are <code className="mono">missing_email</code>, <code className="mono">invalid_email</code>{" "}
          and <code className="mono">invalid_value</code> (a cell that doesn’t fit its field’s type);{" "}
          <code className="mono">parse_error</code> is a row with more cells than the header has columns. The
          CSV is <code className="mono">line,column,value,code,message</code>, UTF-8 with a BOM, with
          formula-like cells made safe.
        </p>
      </div>
    </section>
  )
}
