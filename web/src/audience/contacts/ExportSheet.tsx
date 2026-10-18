/**
 * Export the filtered view as CSV (design: contacts-export, -export-ready, -export-failed; GAPS-audience A1.7).
 * `POST /v1/exports?dryRun=1` counts first and writes nothing. `POST /v1/exports { kind: "contacts", filter,
 * fields }` writes up to 10,000 rows in the request (`completed`, with a link signed for a day); past that it
 * runs, and `GET /v1/exports/{id}` is polled with `processed` of `total`. The list never carries links, so each
 * recent export asks `GET /v1/exports/{id}` for a fresh one.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api, unwrap } from "../../api/client.ts"
import { Gated } from "../../auth/NoPermission.tsx"
import { fmtAgo, fmtInt, num } from "../../lib/format.ts"
import { Icon } from "../../ui/icons.tsx"
import { fmtDateTime, plural } from "../kit/format.ts"
import { type ContactField, useKeyName } from "../kit/queries.ts"
import { ApiErrorCallout, Sheet } from "../kit/ui.tsx"
import { ALWAYS_EXPORTED, type ContactsSearch, exportFilter } from "./logic.ts"
import { type ExportItem, exportsQuery } from "./queries.ts"

const MAX_FIELDS = 50

export function ExportSheet({
  search,
  description,
  fields,
  onClose,
}: {
  search: ContactsSearch
  description: string
  fields: ContactField[]
  onClose: () => void
}) {
  const qc = useQueryClient()
  const keyName = useKeyName()
  const ef = exportFilter(search)
  const filter = "filter" in ef ? ef.filter : null
  const [picked, setPicked] = useState<string[]>([])
  const [exp, setExp] = useState<ExportItem | null>(null)

  const dry = useQuery({
    queryKey: ["exports", "dry", filter],
    queryFn: async () => {
      const r = await unwrap(
        api.POST("/v1/exports", {
          params: { query: { dryRun: "1" } },
          body: { kind: "contacts", ...(filter ? { filter } : {}) } as never,
        }),
      )
      return r && "rows" in r && "dryRun" in r ? num(r.rows) : null
    },
    enabled: Boolean(filter),
    staleTime: 30_000,
  })

  const start = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/exports", {
          body: {
            kind: "contacts",
            ...(filter ? { filter } : {}),
            ...(picked.length ? { fields: picked } : {}),
          } as never,
        }),
      ),
    onSuccess: (r) => {
      if (r && "id" in r) setExp(r)
      qc.invalidateQueries({ queryKey: ["exports"], exact: true })
    },
  })

  const poll = useQuery({
    queryKey: ["exports", exp?.id],
    queryFn: () => unwrap(api.GET("/v1/exports/{id}", { params: { path: { id: exp?.id ?? "" } } })),
    enabled: exp?.status === "running",
    refetchInterval: (q) => (q.state.data?.status === "running" || !q.state.data ? 2000 : false),
  })
  const current = poll.data ?? exp

  const n = dry.data
  const title = !current
    ? n === null || n === undefined
      ? "Export contacts as CSV"
      : `Export ${plural(n, "contact")} as CSV`
    : current.status === "completed"
      ? "Your export is ready"
      : current.status === "failed"
        ? "The export didn’t finish"
        : "Writing your export…"

  const footer = !current ? (
    <>
      <button className="btn btn-ghost" type="button" onClick={onClose}>
        Cancel
      </button>
      <Gated
        allowed={Boolean(filter) && n !== 0}
        reason={!filter ? "This view can’t be exported as it is" : "Nothing to export"}
        who={"refused" in ef ? ef.refused : "No contact matches this view."}
        side="up"
      >
        <button
          className={`btn btn-primary${start.isPending ? " is-loading" : ""}`}
          type="button"
          data-od-id="start-export"
          data-endpoint="POST /v1/exports"
          onClick={() => start.mutate()}
          disabled={start.isPending}
        >
          {start.isPending ? <span className="spinner" aria-hidden="true" /> : <Icon name="download" />}
          Export CSV
        </button>
      </Gated>
    </>
  ) : current.status === "failed" ? (
    <>
      <button className="btn btn-ghost" type="button" onClick={onClose}>
        Close
      </button>
      <button
        className="btn btn-primary"
        type="button"
        data-endpoint="POST /v1/exports"
        onClick={() => {
          setExp(null)
          start.mutate()
        }}
      >
        <Icon name="refresh" />
        Export again
      </button>
    </>
  ) : (
    <button className="btn btn-ghost" type="button" onClick={onClose}>
      Done
    </button>
  )

  return (
    <Sheet
      title={title}
      sub={
        current
          ? `${plural(current.total ?? current.rows, "contact")} · ${description}.`
          : `The filtered view: ${description}.`
      }
      onClose={onClose}
      odId="export-sheet"
      endpoint="POST /v1/exports · GET /v1/exports/{id}"
      footer={footer}
    >
      {!current ? (
        <>
          {"refused" in ef ? (
            <div className="callout callout-warn" role="alert">
              <Icon name="warn" />
              <span>{ef.refused}</span>
            </div>
          ) : (
            <div
              className="exp-dry"
              role="status"
              data-od-id="export-dry-run"
              data-endpoint="POST /v1/exports?dryRun=1"
            >
              {dry.isPending ? (
                <>
                  <span className="sk sk-text" style={{ width: 160 }} aria-hidden="true" />
                  <span className="hint">Counting the contacts this view matches…</span>
                </>
              ) : dry.isError ? (
                <ApiErrorCallout error={dry.error} what="The count didn’t come back." />
              ) : (
                <>
                  <b>{plural(n, "contact")} match</b>
                  <span className="hint">A dry run counted them; nothing is written until you export.</span>
                </>
              )}
            </div>
          )}
          <div className="stack stack-8">
            <span className="label">Always included</span>
            <span className="topic-tags">
              {ALWAYS_EXPORTED.map((c) => (
                <span key={c} className="ttag mono">
                  {c}
                </span>
              ))}
            </span>
            <span className="hint">
              Topics lists the ones they’re subscribed to, separated by semicolons. Times are ISO 8601 in UTC.
            </span>
          </div>
          {fields.length ? (
            <fieldset className="stack stack-8" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="label" style={{ marginBottom: 8 }}>
                Custom fields to add{" "}
                <span className="opt">
                  up to {MAX_FIELDS} · <code className="mono">fields</code>
                </span>
              </legend>
              <div className="cluster cluster-16">
                {fields.map((f) => (
                  <label key={f.key} className="check">
                    <input
                      type="checkbox"
                      checked={picked.includes(f.key)}
                      disabled={!picked.includes(f.key) && picked.length >= MAX_FIELDS}
                      onChange={(e) =>
                        setPicked((p) => (e.target.checked ? [...p, f.key] : p.filter((x) => x !== f.key)))
                      }
                    />
                    <span className="mono">{f.key}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
          <div className="callout callout-info">
            <Icon name="info" />
            <span>
              Up to 10,000 contacts, the file is written straight away and the download appears here. Bigger
              exports run in the background while this waits; when one finishes, an{" "}
              <code className="mono">export_ready</code> notice appears in the alerts bell and expires after a
              day. The link is signed and lasts a day. Cells that look like formulas are made safe, and the
              export is written to the audit log.
            </span>
          </div>
          {start.isError ? <ApiErrorCallout error={start.error} what="The export didn’t start." /> : null}
        </>
      ) : current.status === "failed" ? (
        <div className="error-block" role="alert" data-od-id="error-block">
          <h3>
            <Icon name="warn" />
            The export didn’t finish
          </h3>
          <p>
            The export answered <b>status: failed</b>.
            {current.error ? (
              <>
                {" "}
                Its <code className="mono">error</code> says: <b>{current.error}</b>
              </>
            ) : null}{" "}
            Nothing usable was written. Export again starts a new export with the same filters.
          </p>
          <div className="cluster">
            <span className="req-id">
              Export <code className="mono">{current.id}</code>
            </span>
          </div>
        </div>
      ) : (
        <ExportProgress exp={current} keyName={keyName} />
      )}
      <RecentExports exclude={current?.id} />
    </Sheet>
  )
}

function ExportProgress({ exp, keyName }: { exp: ExportItem; keyName: (id: string) => string }) {
  const total = num(exp.total) ?? num(exp.rows) ?? 0
  const done = num(exp.processed) ?? 0
  const pct = total > 0 ? Math.min(100, (done / total) * 100) : exp.status === "completed" ? 100 : 0
  const secs =
    num(exp.finishedAt) !== null && num(exp.createdAt) !== null
      ? Math.max(1, Math.round(((num(exp.finishedAt) ?? 0) - (num(exp.createdAt) ?? 0)) / 1000))
      : null
  return (
    <>
      {exp.status === "completed" ? (
        <div className="callout callout-ok">
          <Icon name="check-circle" />
          <span>
            <b className="mono">{exp.filename}</b> · {plural(exp.rows, "row")} · columns{" "}
            {ALWAYS_EXPORTED.length}
            {exp.fields.length ? (
              <>
                {" "}
                plus <span className="mono">{exp.fields.join(", ")}</span>
              </>
            ) : null}
            .{secs !== null ? ` Written in ${secs} s.` : ""}
          </span>
        </div>
      ) : null}
      <div className="stack stack-4" data-od-id="export-progress">
        <div className="spread">
          <span className="label">
            {fmtInt(done)} of {fmtInt(total)} written
          </span>
          <span className="hint">started by {keyName(exp.createdBy)}</span>
        </div>
        <div
          className="progress"
          role="progressbar"
          aria-valuenow={done}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-label="Rows written"
        >
          <span style={{ width: `${pct}%` }} />
        </div>
        <span className="hint">
          Over 10,000 rows an export runs in the background, and this bar follows{" "}
          <code className="mono">processed</code> of <code className="mono">total</code> until it’s done.
        </span>
      </div>
      {exp.status === "completed" && exp.url ? (
        <>
          <a
            className="btn btn-primary btn-block"
            href={exp.url}
            download={exp.filename}
            data-od-id="download-export"
          >
            <Icon name="download" />
            Download CSV
          </a>
          <p className="hint">
            The link expires {fmtDateTime((num(exp.finishedAt) ?? Date.now()) + 86_400_000)}. After that, ask
            for a new one from the list below; the file stays.
          </p>
        </>
      ) : exp.status === "running" ? (
        <p className="hint" role="status">
          Checking every 2 seconds. You can close this; the export keeps going and its notice lands in the
          alerts bell.
        </p>
      ) : null}
    </>
  )
}

function RecentExports({ exclude }: { exclude?: string | undefined }) {
  const q = useQuery(exportsQuery)
  const keyName = useKeyName()
  const [linking, setLinking] = useState<string | null>(null)
  const [linkError, setLinkError] = useState<unknown>(null)
  const list = (q.data ?? []).filter((e) => e.kind === "contacts" && e.id !== exclude).slice(0, 5)
  if (!list.length) return null
  const getLink = async (id: string) => {
    setLinking(id)
    setLinkError(null)
    try {
      const fresh = await unwrap(api.GET("/v1/exports/{id}", { params: { path: { id } } }))
      if (fresh?.url) window.open(fresh.url, "_blank", "noopener")
    } catch (e) {
      setLinkError(e)
    } finally {
      setLinking(null)
    }
  }
  return (
    <div className="stack stack-8" data-endpoint="GET /v1/exports">
      <span className="label">Recent exports</span>
      <ul className="list">
        {list.map((e) => (
          <li key={e.id} className="list-row">
            <span className="grow" style={{ minWidth: 0 }}>
              <span className="row-title mono">{e.filename}</span>
              <span className="row-sub">
                {fmtInt(e.processed)} of {fmtInt(e.total ?? e.rows)} rows · {fmtAgo(e.createdAt)} by{" "}
                {keyName(e.createdBy)}
                {e.fields.length ? ` · ${e.fields.join(", ")}` : ""}
              </span>
            </span>
            {e.status === "completed" ? (
              <button
                className={`btn btn-ghost btn-sm${linking === e.id ? " is-loading" : ""}`}
                type="button"
                data-endpoint={`GET /v1/exports/${e.id}`}
                onClick={() => void getLink(e.id)}
              >
                {linking === e.id ? <span className="spinner" aria-hidden="true" /> : null}
                Get a link
              </button>
            ) : e.status === "failed" ? (
              <span className="pill pill-fail">
                <span className="dot" />
                Failed
              </span>
            ) : (
              <span className="pill pill-info">
                <span className="dot" />
                Running
              </span>
            )}
          </li>
        ))}
      </ul>
      <span className="hint">The list doesn’t carry links, so each fetches a fresh one when you ask.</span>
      {linkError ? <ApiErrorCallout error={linkError} what="That link didn’t come back." /> : null}
    </div>
  )
}
