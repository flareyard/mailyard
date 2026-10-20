/**
 * Import a suppression list (design: suppression-import, suppression-import-result; HAL-3372). The browser
 * reads the header first so the columns can be mapped, uploads the file (`POST /v1/uploads`), starts
 * `POST /v1/suppressions/import`, then polls the import until it lands. `?id=` is the result, so it's a link.
 */
import { useMutation, useQuery } from "@tanstack/react-query"
import { getRouteApi, Link } from "@tanstack/react-router"
import { type ChangeEvent, type DragEvent, useId, useRef, useState } from "react"
import { api, unwrap } from "../../api/client.ts"
import { fmtInt, num } from "../../lib/format.ts"
import { fmtBytes } from "../../ops/format.ts"
import { BuiltPill, SampleMarker, Time } from "../../ops/kit.tsx"
import { Icon } from "../../ui/icons.tsx"
import { PanelError, PanelSkeleton } from "../../ui/Panel.tsx"
import { Refusal } from "../keys/ui.tsx"
import { Crumbs } from "../Layout.tsx"
import { guessColumns, type Reason, readCsv } from "./logic.ts"
import { importQuery, importsQuery } from "./queries.ts"
import "../keys/keys.css"

const route = getRouteApi("/_app/transactional/suppressions/import")

type Picked = { file: File; headers: string[]; rows: number; first: string[] }

export function ImportPage() {
  const search = route.useSearch()
  const navigate = route.useNavigate()
  const fixture = {
    ...(search.state ? { state: search.state } : {}),
    ...(search.as ? { as: search.as } : {}),
  }
  return (
    <>
      <div className="page-head" data-od-id="page-head">
        <div style={{ minWidth: 0 }}>
          <Crumbs
            items={[
              { to: "/transactional/messages", label: "Transactional" },
              { to: "/transactional/suppressions", label: "Suppressions", search: fixture },
            ]}
          />
          <h1 data-od-id="page-title">Import a suppression list</h1>
          <p className="sub">Bring a suppression list from your old provider.</p>
        </div>
        <div className="cluster cluster-12">
          <SampleMarker />
        </div>
      </div>
      {search.id ? (
        <ImportResult id={search.id} fixture={fixture} onAgain={() => navigate({ search: fixture })} />
      ) : (
        <ImportForm onStarted={(id) => navigate({ search: { ...fixture, id } })} />
      )}
      <RecentImports fixture={fixture} />
    </>
  )
}

function ImportForm({ onStarted }: { onStarted: (id: string) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const ids = { email: useId(), reason: useId(), note: useId(), def: useId(), n: useId() }
  const [picked, setPicked] = useState<Picked | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [emailColumn, setEmailColumn] = useState("")
  const [reasonColumn, setReasonColumn] = useState("")
  const [noteColumn, setNoteColumn] = useState("")
  const [reason, setReason] = useState<Reason>("hard_bounce")
  const [note, setNote] = useState("")
  const [push, setPush] = useState(true)
  const [drag, setDrag] = useState(false)

  const take = async (file: File | undefined) => {
    if (!file) return
    setReadError(null)
    if (file.size > 50 * 1024 * 1024) {
      setReadError("That file is over 50 MB. Split it and import the parts.")
      return
    }
    try {
      const head = await file.slice(0, 256 * 1024).text()
      const full = file.size <= 256 * 1024 ? head : await file.text()
      const r = readCsv(full)
      if (!r.headers.length) {
        setReadError(
          "That file has no header row. The first line should name the columns, like EMAIL,STATUS.",
        )
        return
      }
      const g = guessColumns(r.headers)
      setPicked({ file, ...r })
      setEmailColumn(g.email ?? r.headers[0] ?? "")
      setReasonColumn(g.reason ?? "")
      setNoteColumn(g.note ?? "")
    } catch {
      setReadError("Mailyard couldn’t read that file. Save it as CSV (UTF-8) and try again.")
    }
  }

  const start = useMutation({
    mutationFn: async (p: Picked) => {
      const up = await unwrap(
        api.POST("/v1/uploads", {
          params: { query: { filename: p.file.name } },
          body: p.file as unknown as string,
          bodySerializer: (b: unknown) => b,
          headers: { "content-type": p.file.type || "text/csv" },
        }),
      )
      return unwrap(
        api.POST("/v1/suppressions/import", {
          body: {
            uploadId: up.id,
            reason,
            ...(note.trim() ? { note: note.trim() } : {}),
            ...(emailColumn ? { emailColumn } : {}),
            ...(reasonColumn ? { reasonColumn } : {}),
            ...(noteColumn ? { noteColumn } : {}),
            push,
          },
        }),
      )
    },
    onSuccess: (r) => onStarted(r.id),
  })

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDrag(false)
    void take(e.dataTransfer.files[0])
  }
  return (
    <section
      className="panel"
      data-endpoint="POST /v1/uploads (built, raw route) · POST /v1/suppressions/import { uploadId, reason?, note?, emailColumn?, reasonColumn?, noteColumn?, push? } (built, HAL-3372)"
      data-od-id="panel-import-form"
      aria-labelledby="h-import-form"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-import-form">
          Import a CSV
        </h2>
        <div className="cluster">
          <BuiltPill issue="HAL-3372" />
        </div>
      </header>
      <div className="panel-body">
        <div className="stack stack-16">
          <label
            className={`dropzone tb-drop${drag ? " is-over" : ""}`}
            onDragOver={(e) => {
              e.preventDefault()
              setDrag(true)
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={onDrop}
          >
            <Icon name="upload" className="icon-20" />
            {picked ? (
              <span>
                <b>{picked.file.name}</b> · {fmtInt(picked.rows)} rows · {fmtBytes(picked.file.size)}
              </span>
            ) : (
              <span>
                <b>Choose a CSV</b> or drop it here
              </span>
            )}
            <span className="hint">
              The first row names the columns. Uploaded with <span className="mono">POST /v1/uploads</span>{" "}
              when you import.
            </span>
            <input
              ref={input}
              className="sr-only"
              type="file"
              accept=".csv,text/csv"
              onChange={(e: ChangeEvent<HTMLInputElement>) => void take(e.target.files?.[0])}
            />
          </label>
          {readError ? (
            <p className="field-error" role="alert">
              <Icon name="warn" className="icon-12" />
              {readError}
            </p>
          ) : null}
          {picked ? (
            <>
              <div className="field-row">
                <div className="field">
                  <label className="label" htmlFor={ids.email}>
                    Email column
                  </label>
                  <select
                    className="select"
                    id={ids.email}
                    value={emailColumn}
                    onChange={(e) => setEmailColumn(e.target.value)}
                  >
                    {picked.headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                  {picked.first.length ? (
                    <span className="hint">
                      First row:{" "}
                      <span className="mono">{picked.first[picked.headers.indexOf(emailColumn)] ?? "—"}</span>
                    </span>
                  ) : null}
                </div>
                <div className="field">
                  <label className="label" htmlFor={ids.reason}>
                    Reason column <span className="opt">· optional</span>
                  </label>
                  <select
                    className="select"
                    id={ids.reason}
                    value={reasonColumn}
                    onChange={(e) => setReasonColumn(e.target.value)}
                  >
                    <option value="">None: use the reason below</option>
                    {picked.headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                  <span className="hint">
                    Other providers’ words are mapped: bounced, spam, unsubscribed…
                  </span>
                </div>
              </div>
              <div className="field-row">
                <div className="field">
                  <label className="label" htmlFor={ids.note}>
                    Note column <span className="opt">· optional</span>
                  </label>
                  <select
                    className="select"
                    id={ids.note}
                    value={noteColumn}
                    onChange={(e) => setNoteColumn(e.target.value)}
                  >
                    <option value="">None</option>
                    {picked.headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label className="label" htmlFor={ids.def}>
                    {reasonColumn ? "Reason when the column is empty" : "Reason for every row"}
                  </label>
                  <select
                    className="select"
                    id={ids.def}
                    value={reason}
                    onChange={(e) => setReason(e.target.value as Reason)}
                  >
                    <option value="hard_bounce">Hard bounce</option>
                    <option value="manual">Added by hand</option>
                    <option value="unsubscribe">Unsubscribe</option>
                    <option value="complaint">Complaint</option>
                  </select>
                </div>
              </div>
              <div className="field">
                <label className="label" htmlFor={ids.n}>
                  Note for every row <span className="opt">· optional</span>
                </label>
                <input
                  className="input"
                  id={ids.n}
                  value={note}
                  maxLength={500}
                  placeholder={`From ${picked.file.name}`}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>
              <label className="check">
                <input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} />
                <span>
                  Push to Cloudflare as they’re added
                  <small className="hint" style={{ display: "block" }}>
                    Unsubscribes and bulk-only rows are never pushed. Without a Cloudflare write token nothing
                    is pushed and the result says so.
                  </small>
                </span>
              </label>
              <Refusal error={start.error} what="The import didn’t start." />
            </>
          ) : null}
        </div>
      </div>
      <footer className="panel-foot">
        <span>Runs in 5,000-row steps; each step is kept if a later one fails.</span>
        <button
          className="btn btn-primary btn-sm"
          type="button"
          aria-disabled={!picked || !emailColumn || start.isPending}
          onClick={() => picked && emailColumn && !start.isPending && start.mutate(picked)}
        >
          <Icon name="upload" className="icon-12" />
          {start.isPending ? "Uploading…" : picked ? `Import ${fmtInt(picked.rows)} rows` : "Import"}
        </button>
      </footer>
    </section>
  )
}

function ImportResult({
  id,
  fixture,
  onAgain,
}: {
  id: string
  fixture: Record<string, string>
  onAgain: () => void
}) {
  const q = useQuery(importQuery(id))
  if (q.isPending) return <PanelSkeleton rows={5} />
  if (q.isError)
    return <PanelError error={q.error} onRetry={() => q.refetch()} what="This import didn’t load" />
  const r = q.data
  const done = r.status === "completed"
  const failed = r.status === "failed"
  const rows = num(r.rows) ?? 0
  const added = num(r.added) ?? 0
  const pushed = num(r.pushed) ?? 0
  return (
    <section
      className="panel"
      data-endpoint={`GET /v1/suppressions/imports/${id} (built, HAL-3372)`}
      data-od-id="panel-import-result"
      aria-labelledby="h-import-result"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-import-result">
          Import <span className="mono">{r.id}</span>
        </h2>
        <div className="cluster">
          <span className="panel-meta">
            {done || failed ? (
              <>
                {r.status} <Time value={r.finishedAt ?? r.createdAt} />
              </>
            ) : (
              "live"
            )}
          </span>
          <BuiltPill issue="HAL-3372" />
        </div>
      </header>
      <div className="panel-body">
        <div className="stack stack-16">
          {done ? (
            <div className="callout callout-ok">
              <Icon name="check-circle" />
              <span>
                <b>Import finished.</b> {fmtInt(rows)} rows = {fmtInt(added)} added + {fmtInt(r.existing)}{" "}
                already on the list + {fmtInt(r.invalid)} invalid + {fmtInt(r.duplicates)} duplicates.{" "}
                {r.push
                  ? `${fmtInt(pushed)} of the added were pushed to Cloudflare; the rest are unsubscribes or bulk only${pushed ? "" : ", or Cloudflare isn’t connected"}.`
                  : "Nothing was pushed to Cloudflare."}
              </span>
            </div>
          ) : failed ? (
            <div className="callout callout-error" role="alert">
              <Icon name="warn" />
              <span>
                <b>The import failed.</b> {r.error ?? "No reason was recorded."} Steps that finished before it
                are kept.
              </span>
            </div>
          ) : (
            <div className="callout callout-info" role="status">
              <Icon name="refresh" />
              <span>
                <b>{r.status === "queued" ? "Queued." : "Importing…"}</b>{" "}
                {rows ? `${fmtInt(rows)} rows read so far.` : ""} This page updates by itself; you can leave
                it.
              </span>
            </div>
          )}
          <div className="big-figures">
            {(
              [
                ["Rows", r.rows],
                ["Added", r.added],
                ["Already on the list", r.existing],
                ["Invalid", r.invalid],
                ["Duplicates in the file", r.duplicates],
                ["Pushed to Cloudflare", r.pushed],
              ] as const
            ).map(([label, n]) => (
              <div key={label} className="fig">
                <span className="stat-label">{label}</span>
                <span className="stat-value">{fmtInt(n)}</span>
              </div>
            ))}
          </div>
          {r.errors.length ? (
            <div>
              <h3 className="t-h4" style={{ marginBottom: 6 }}>
                First {r.errors.length} problem{r.errors.length === 1 ? "" : "s"}
              </h3>
              <ul className="list">
                {r.errors.map((e) => (
                  <li key={`${e.line}-${e.message}`} className="list-row">
                    <span className="grow">
                      <span className="row-title">Line {fmtInt(e.line)}</span>
                      <span className="row-sub">{e.message}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
      <footer className="panel-foot">
        <span>
          Columns: <span className="mono">{r.emailColumn ?? "email"}</span>
          {r.reasonColumn ? (
            <>
              {" "}
              · reason from <span className="mono">{r.reasonColumn}</span>
            </>
          ) : null}
          {r.note ? ` · note “${r.note}”` : ""}
        </span>
        <span className="cluster">
          <button className="btn btn-secondary btn-sm" type="button" onClick={onAgain}>
            Import another
          </button>
          <Link className="btn btn-primary btn-sm" to="/transactional/suppressions" search={fixture}>
            See the list
          </Link>
        </span>
      </footer>
    </section>
  )
}

function RecentImports({ fixture }: { fixture: Record<string, string> }) {
  const q = useQuery(importsQuery)
  const list = q.data?.imports ?? []
  if (!list.length) return null
  return (
    <section
      className="panel"
      style={{ marginTop: 16 }}
      data-endpoint="GET /v1/suppressions/imports (built, HAL-3372)"
      aria-labelledby="h-imports"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-imports">
          Recent imports
        </h2>
      </header>
      <div className="panel-body">
        <ul className="list">
          {list.map((i) => (
            <li key={i.id} className="list-row">
              <span className="grow">
                <Link
                  className="row-title mono"
                  to="/transactional/suppressions/import"
                  search={{ ...fixture, id: i.id }}
                >
                  {i.id}
                </Link>
                <span className="row-sub">
                  {i.status} · {fmtInt(i.added)} added of {fmtInt(i.rows)} · <Time value={i.createdAt} />
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
