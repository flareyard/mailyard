/**
 * Settings → Import and export (design: import-export, export-running, export-ready, export-gaps,
 * export-failed, import-export-no-admin; HAL-3451, live). Export everything (`POST /v1/exports { kind:
 * "workspace" }`), follow it while it runs, then download each part; past exports (the list carries no links,
 * so opening one mints fresh ones) and past imports, contacts and mail, below.
 */
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import { getRouteApi, Link } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { api, unwrap } from "../../api/client.ts"
import { useMe } from "../../auth/session.ts"
import { fmtInt, num } from "../../lib/format.ts"
import { fmtBytes } from "../../ops/format.ts"
import { BuiltPill, Empty, Time } from "../../ops/kit.tsx"
import { isAdmin } from "../../ops/roles.ts"
import { toast } from "../../ops/toast.tsx"
import { Icon } from "../../ui/icons.tsx"
import { PanelError, PanelSkeleton } from "../../ui/Panel.tsx"
import { SectionHead } from "../integrations/common.tsx"
import { MutationError } from "../integrations/KeySheets.tsx"
import { type Body, mailboxesQuery } from "../integrations/queries.ts"
import {
  downloadName,
  exportState,
  importTone,
  itemsLabel,
  mailImportAction,
  mailImportSummary,
  partCounts,
  took,
} from "./logic.ts"
import "../integrations/integrations.css"

const route = getRouteApi("/_app/settings/data")

type Export = Body<"/v1/exports/{id}">

const SECRETS = (
  <div className="callout callout-info">
    <Icon name="lock" />
    <span>
      <b>Secrets aren’t included.</b> settings.json holds brand, compliance, sending, webhook endpoints and
      API keys as metadata only. Create new API keys and webhook secrets after importing.
    </span>
  </div>
)

export function DataPage() {
  const search = route.useSearch()
  const navigate = route.useNavigate()
  const qc = useQueryClient()
  const me = useMe().data
  const admin = isAdmin(me)
  const start = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/exports", { body: { kind: "workspace" } })),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["exports"] })
      if ("id" in r) {
        qc.setQueryData(["exports", r.id], r)
        navigate({ search: (s) => ({ ...(s.fx ? { fx: s.fx } : {}), export: r.id }) })
        toast({
          title: "Exporting the workspace",
          sub: "You can leave this page; an alert says when it’s ready.",
        })
      }
    },
  })
  return (
    <>
      <SectionHead title="Import and export" sub="Bring data in, take all of it out." />
      <div className="stack">
        {!admin ? (
          <NoAdmin keyName={me?.key?.name} scopes={me?.scopes ?? []} />
        ) : search.export ? (
          <ExportPanel id={search.export} onAgain={() => start.mutate()} again={start} />
        ) : (
          <StartPanel onStart={() => start.mutate()} start={start} />
        )}
        {admin ? <PastExports current={search.export} /> : null}
        <PastImports />
      </div>
    </>
  )
}

function NoAdmin({ keyName, scopes }: { keyName: string | undefined; scopes: readonly string[] }) {
  return (
    <section
      className="panel"
      data-endpoint="POST /v1/exports { kind: workspace } (built, HAL-3451)"
      aria-labelledby="h-export"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-export">
          Export everything
        </h2>
        <div className="cluster">
          <BuiltPill issue="HAL-3451" />
        </div>
      </header>
      <div className="panel-body">
        <div className="locked">
          <span className="empty-icon">
            <Icon name="lock" />
          </span>
          <h2>Exporting the workspace needs the admin scope</h2>
          <p>
            {keyName ? (
              <>
                The key you’re signed in with, <b>{keyName}</b>, has {scopes.join(" and ") || "no scopes"}.{" "}
              </>
            ) : null}
            An export holds every mailbox and setting, so only admin keys, owners and admins can start or open
            one.
          </p>
        </div>
      </div>
    </section>
  )
}

function StartPanel({
  onStart,
  start,
}: {
  onStart: () => void
  start: { isPending: boolean; isError: boolean; error: unknown }
}) {
  return (
    <section
      className="panel"
      data-endpoint="POST /v1/exports { kind: workspace } · GET /v1/exports/{id} · GET /v1/exports (built, HAL-3451)"
      aria-labelledby="h-export"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-export">
          Export everything
        </h2>
        <div className="cluster">
          <BuiltPill issue="HAL-3451" />
        </div>
      </header>
      <div className="panel-body">
        <div className="stack stack-12">
          <p>
            Everything in this workspace, one file per part: an <span className="mono">.mbox</span> for each
            mailbox that holds mail, contacts.csv, templates, lists, settings.json, the audit log, and a
            manifest that lists them all.
          </p>
          {SECRETS}
          {start.isError ? <MutationError error={start.error} what="The export didn’t start" /> : null}
          <div>
            <button
              className="btn btn-primary"
              type="button"
              aria-disabled={start.isPending}
              onClick={() => !start.isPending && onStart()}
            >
              <Icon name="download" />
              {start.isPending ? "Starting…" : "Export everything"}
            </button>
          </div>
          <p className="hint">
            Admin only. It runs in the background; you get an export_ready alert when it’s done.
          </p>
        </div>
      </div>
    </section>
  )
}

function ExportPanel({
  id,
  onAgain,
  again,
}: {
  id: string
  onAgain: () => void
  again: { isPending: boolean; isError: boolean; error: unknown }
}) {
  const q = useQuery({
    queryKey: ["exports", id],
    queryFn: () => unwrap(api.GET("/v1/exports/{id}", { params: { path: { id } } })),
    refetchInterval: (query) => (query.state.data?.status === "running" ? 2000 : false),
  })
  const shell = (title: string, body: ReactNode) => (
    <section
      className="panel"
      data-endpoint={`GET /v1/exports/${id} (built, HAL-3451)`}
      aria-labelledby="h-export"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-export">
          {title}
        </h2>
        <div className="cluster">
          <Link className="panel-link" to="/settings/data" search={(s) => (s.fx ? { fx: s.fx } : {})}>
            New export
          </Link>
          <BuiltPill issue="HAL-3451" />
        </div>
      </header>
      <div className="panel-body">{body}</div>
    </section>
  )
  if (q.isPending) return shell("Workspace export", <PanelSkeleton rows={6} />)
  if (q.isError)
    return shell(
      "Workspace export",
      <PanelError error={q.error} onRetry={() => q.refetch()} what="This export didn’t load" />,
    )
  const e = q.data
  const workspace = e.kind === "workspace"
  const state = exportState(e)
  const c = partCounts(e)
  const dur = took(e.createdAt, e.finishedAt)
  const what = workspace ? "workspace export" : "contacts export"
  const againButton = (
    <button
      className="btn btn-secondary"
      type="button"
      aria-disabled={again.isPending}
      onClick={() => !again.isPending && onAgain()}
    >
      <Icon name="refresh" />
      {again.isPending ? "Starting…" : "Export again"}
    </button>
  )

  if (state === "failed")
    return shell(
      `${workspace ? "Workspace" : "Contacts"} export failed`,
      <div className="stack stack-12">
        <div className="error-block" role="alert">
          <h3>
            <Icon name="warn" />
            The {what} failed
          </h3>
          <p>
            <code className="mono">GET /v1/exports/{e.id}</code> answered <b>status: failed</b>.{" "}
            {e.error ?? "It stopped without saying why."} {c.done === 0 ? "Nothing was written." : null} Try
            again; if it fails the same way, check the exports bucket’s binding.
          </p>
          <div className="cluster">
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => q.refetch()}>
              <Icon name="refresh" />
              Retry
            </button>
          </div>
        </div>
        {workspace ? (
          <div>
            <button
              className="btn btn-primary"
              type="button"
              aria-disabled={again.isPending}
              onClick={() => !again.isPending && onAgain()}
            >
              {again.isPending ? "Starting…" : "Export again"}
            </button>
          </div>
        ) : null}
        {again.isError ? <MutationError error={again.error} what="The export didn’t start" /> : null}
      </div>,
    )

  if (!workspace)
    return shell(
      state === "running" ? "Exporting contacts" : "Contacts export ready",
      <div className="stack stack-12">
        <p>
          <b>{fmtInt(e.processed)}</b> of {fmtInt(e.total ?? e.rows)} rows, started{" "}
          <Time value={e.createdAt} />.
        </p>
        {e.url ? (
          <div>
            <a className="btn btn-primary" href={e.url} download={e.filename}>
              <Icon name="download" />
              Download {e.filename}
            </a>
          </div>
        ) : null}
      </div>,
    )

  const failed = (e.parts ?? []).filter((p) => p.status === "failed")
  const title =
    state === "running"
      ? "Exporting the workspace"
      : state === "gaps"
        ? "Workspace export finished with gaps"
        : "Workspace export ready"
  const manifest = (e.parts ?? []).find((p) => p.kind === "manifest")
  const manifestUrl = manifest?.url ?? e.url
  return shell(
    title,
    <div
      className="stack stack-12"
      role={state === "running" ? "status" : undefined}
      aria-live={state === "running" ? "polite" : undefined}
    >
      {state === "running" ? (
        <>
          <p>
            <b>
              {fmtInt(c.done)} of {fmtInt(c.total)} parts written
            </b>
            , started <Time value={e.createdAt} />. You can leave this page; an alert says when it’s ready.
          </p>
          <div
            className="progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={c.total}
            aria-valuenow={c.done}
            aria-label="Parts written"
          >
            <span style={{ width: `${c.total ? Math.round((c.done / c.total) * 100) : 0}%` }} />
          </div>
        </>
      ) : state === "gaps" ? (
        <div className="callout callout-warn" role="status">
          <Icon name="warn" />
          <span>
            <b>The workspace export finished with gaps.</b> {failed.length}{" "}
            {failed.length === 1 ? "part" : "parts"} failed; the other {c.done} {c.done === 1 ? "is" : "are"}{" "}
            complete and can be downloaded.
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {failed.map((p) => (
                <li key={p.filename}>
                  <span className="mono">{p.filename}</span>: {p.error ?? "it failed without saying why."}
                </li>
              ))}
            </ul>
          </span>
        </div>
      ) : (
        <div className="callout callout-ok">
          <Icon name="check-circle" />
          <span>
            <b>The workspace export is ready.</b> {fmtInt(c.total)} parts{dur ? `, finished in ${dur}` : ""}.
          </span>
        </div>
      )}
      <div className="table-wrap rtable-wrap">
        <table className="rtable">
          <thead>
            <tr>
              <th>Part</th>
              <th className="r">Items</th>
              <th className="r">Size</th>
              <th>
                <span className="sr-only">Download</span>
              </th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {(e.parts ?? []).map((p) => {
              const it = itemsLabel(p.kind, p.items)
              return (
                <tr key={p.filename}>
                  <td className="is-head">
                    <div className="cell-main">
                      <span className="mono" style={{ color: "var(--my-fg)" }}>
                        {p.filename}
                      </span>
                      <span className="cell-sub">
                        {p.kind} · {p.format}
                      </span>
                    </div>
                  </td>
                  <td className="r" data-label="Items">
                    {fmtInt(it.n)} <span className="muted">{it.unit}</span>
                  </td>
                  <td className="r" data-label="Size">
                    {p.status === "complete" ? fmtBytes(p.bytes) : "—"}
                  </td>
                  <td className="actions">
                    {p.status === "complete" && p.url ? (
                      <a
                        className="btn btn-secondary btn-sm"
                        href={p.url}
                        download={downloadName(p.filename)}
                      >
                        <Icon name="download" />
                        Download
                      </a>
                    ) : null}
                  </td>
                  <td className="is-aside">
                    {p.status === "complete" ? (
                      <span className="pill pill-pass">
                        <span className="dot" />
                        Complete
                      </span>
                    ) : p.status === "failed" ? (
                      <span className="pill pill-fail">
                        <span className="dot" />
                        Failed
                      </span>
                    ) : (
                      <span className="pill pill-neutral">
                        <span className="spinner" aria-hidden="true" />
                        Pending
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {state !== "running" ? (
        <div className="cluster">
          {manifestUrl ? (
            <a className="btn btn-primary" href={manifestUrl} download="manifest.json">
              <Icon name="download" />
              Download manifest
            </a>
          ) : null}
          {state === "gaps" ? againButton : null}
        </div>
      ) : null}
      {again.isError ? <MutationError error={again.error} what="The export didn’t start" /> : null}
      {state === "ready" ? <EmptyMailboxes e={e} /> : null}
      {state !== "running" ? (
        <p className="hint">
          Each link works for a day. They’re minted when this export is opened, so open it again from the list
          for fresh ones.
        </p>
      ) : null}
      {SECRETS}
    </div>,
  )
}

/** Mailboxes that hold mail but have no part: they were empty when the export ran. */
function EmptyMailboxes({ e }: { e: Export }) {
  const q = useQuery(mailboxesQuery)
  const covered = new Set((e.parts ?? []).map((p) => p.mailboxId).filter(Boolean))
  const empty = (q.data?.mailboxes ?? []).filter((m) => m.holdsMail && !covered.has(m.id))
  if (!empty.length) return null
  return (
    <p className="hint">
      Empty mailboxes have no part:{" "}
      {empty.map((m, i) => (
        <span key={m.id}>
          {i ? ", " : ""}
          <span className="mono">{m.address}</span>
        </span>
      ))}{" "}
      {empty.length === 1 ? "holds" : "hold"} no mail, so {empty.length === 1 ? "it isn’t" : "they aren’t"} in
      this export.
    </p>
  )
}

function PastExports({ current }: { current: string | undefined }) {
  const q = useQuery({ queryKey: ["exports", "list"], queryFn: () => unwrap(api.GET("/v1/exports")) })
  return (
    <section className="panel" data-endpoint="GET /v1/exports (links null)" aria-labelledby="h-past-exports">
      <header className="panel-head">
        <h2 className="panel-title" id="h-past-exports">
          Past exports
        </h2>
      </header>
      <div className="panel-body">
        {q.isPending ? (
          <PanelSkeleton rows={3} />
        ) : q.isError ? (
          <PanelError error={q.error} onRetry={() => q.refetch()} what="Past exports didn’t load" />
        ) : q.data.exports.length === 0 ? (
          <Empty icon="download" title="No exports yet">
            Exports you start here or from Audience show up here, with fresh download links when opened.
          </Empty>
        ) : (
          <>
            <div className="table-wrap rtable-wrap">
              <table className="rtable">
                <thead>
                  <tr>
                    <th>Export</th>
                    <th>Contents</th>
                    <th>Finished</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.exports.map((e) => {
                    const state = exportState(e)
                    return (
                      <tr key={e.id} className={e.id === current ? "is-selected" : ""}>
                        <td className="is-head">
                          <div className="cell-main">
                            <Link
                              className="link"
                              to="/settings/data"
                              search={(s) => ({ ...(s.fx ? { fx: s.fx } : {}), export: e.id })}
                            >
                              {e.kind === "workspace" ? "Workspace export" : "Contacts export"}
                            </Link>
                            <span className="cell-sub mono">{e.id}</span>
                          </div>
                        </td>
                        <td data-label="Contents">
                          {e.kind === "workspace"
                            ? `${fmtInt(e.parts?.length ?? 0)} parts`
                            : `${fmtInt(e.rows)} rows`}
                        </td>
                        <td data-label="Finished">
                          {e.finishedAt ? (
                            <Time value={e.finishedAt} />
                          ) : (
                            <span className="muted">Running</span>
                          )}
                        </td>
                        <td className="is-aside">
                          <span
                            className={`pill ${state === "ready" ? "pill-pass" : state === "failed" ? "pill-fail" : "pill-warn"}`}
                          >
                            <span className="dot" />
                            {state === "ready"
                              ? "Completed"
                              : state === "gaps"
                                ? "With gaps"
                                : state === "failed"
                                  ? "Failed"
                                  : "Running"}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <p className="hint" style={{ marginTop: 10 }}>
              The list doesn’t carry download links. Open an export to get fresh ones, good for a day.
            </p>
          </>
        )}
      </div>
    </section>
  )
}

function PastImports() {
  const qc = useQueryClient()
  const contacts = useQuery({ queryKey: ["imports", "list"], queryFn: () => unwrap(api.GET("/v1/imports")) })
  const boxes = useQuery(mailboxesQuery)
  const holding = (boxes.data?.mailboxes ?? []).filter((m) => m.holdsMail)
  const mail = useQueries({
    queries: holding.map((m) => ({
      queryKey: ["mailboxes", m.id, "imports"],
      queryFn: () => unwrap(api.GET("/v1/mailboxes/{id}/imports", { params: { path: { id: m.id } } })),
    })),
  })
  const resume = useMutation({
    mutationFn: (v: { mailboxId: string; importId: string }) =>
      unwrap(
        api.POST("/v1/mailboxes/{id}/imports/{importId}/resume", {
          params: { path: { id: v.mailboxId, importId: v.importId } },
        }),
      ),
    onSuccess: async (_r, v) => {
      await qc.invalidateQueries({ queryKey: ["mailboxes", v.mailboxId, "imports"] })
      toast({ title: "Import resumed" })
    },
    onError: (e) =>
      toast({ title: "It didn’t resume", sub: e instanceof Error ? e.message : undefined, tone: "bad" }),
  })
  type Row = { key: string; at: number; node: ReactNode }
  const rows: Row[] = []
  holding.forEach((m, i) => {
    for (const imp of mail[i]?.data?.imports ?? []) {
      const action = mailImportAction(imp)
      rows.push({
        key: imp.id,
        at: num(imp.createdAt) ?? 0,
        node: (
          <tr key={imp.id}>
            <td className="is-head">
              <div className="cell-main">
                <span style={{ fontWeight: 600, color: "var(--my-fg)" }}>{m.address}</span>
                <span className="cell-sub">
                  Mailbox from{" "}
                  <span className="mono">
                    {imp.source === "mbox" ? "an mbox file" : (imp.host ?? "IMAP")}
                  </span>
                </span>
                <span className="cell-sub" style={{ whiteSpace: "normal" }}>
                  {mailImportSummary(imp)}
                </span>
              </div>
            </td>
            <td data-label="Started">
              <Time value={imp.startedAt ?? imp.createdAt} />
            </td>
            <td className="actions">
              {action === "resume" ? (
                <button
                  className="btn btn-secondary btn-sm"
                  type="button"
                  aria-disabled={resume.isPending}
                  onClick={() => !resume.isPending && resume.mutate({ mailboxId: m.id, importId: imp.id })}
                >
                  Resume
                </button>
              ) : action === "retry" ? (
                <Link className="btn btn-secondary btn-sm" to="/" search={{ setup: 1, step: "imap" }}>
                  Retry failed
                </Link>
              ) : null}
            </td>
            <td className="is-aside">
              <span className={`pill ${importTone(imp.status)}`}>
                <span className="dot" />
                {imp.status[0]?.toUpperCase()}
                {imp.status.slice(1)}
              </span>
            </td>
          </tr>
        ),
      })
    }
  })
  for (const imp of contacts.data?.imports ?? []) {
    rows.push({
      key: imp.id,
      at: num(imp.createdAt) ?? 0,
      node: (
        <tr key={imp.id}>
          <td className="is-head">
            <div className="cell-main">
              <span style={{ fontWeight: 600, color: "var(--my-fg)" }}>Audience</span>
              <span className="cell-sub">
                Contacts from <span className="mono">{imp.fileName ?? "a CSV"}</span>
              </span>
              <span className="cell-sub" style={{ whiteSpace: "normal" }}>
                {imp.status === "failed" && imp.error
                  ? imp.error
                  : `${fmtInt(imp.rows)} rows: ${fmtInt(imp.created)} created, ${fmtInt(imp.updated)} updated, ${fmtInt(imp.invalid)} invalid`}
              </span>
            </div>
          </td>
          <td data-label="Started">
            <Time value={imp.startedAt ?? imp.createdAt} />
          </td>
          <td className="actions" />
          <td className="is-aside">
            <span className={`pill ${importTone(imp.status)}`}>
              <span className="dot" />
              {imp.status === "completed"
                ? "Complete"
                : `${imp.status[0]?.toUpperCase()}${imp.status.slice(1)}`}
            </span>
          </td>
        </tr>
      ),
    })
  }
  rows.sort((a, b) => b.at - a.at)
  const loading = contacts.isPending || boxes.isPending || mail.some((m) => m.isPending)
  const failed = contacts.isError || boxes.isError
  return (
    <section
      className="panel"
      data-endpoint="GET /v1/imports (contacts, built) · GET /v1/mailboxes/{id}/imports (mail, built)"
      aria-labelledby="h-imports"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-imports">
          Past imports
        </h2>
        <div className="cluster">
          <Link className="btn btn-secondary btn-sm" to="/" search={{ setup: 1, step: "imap" }}>
            Import mail
          </Link>
          <Link className="btn btn-secondary btn-sm" to="/" search={{ setup: 1, step: "csv" }}>
            Import contacts
          </Link>
        </div>
      </header>
      <div className="panel-body">
        {loading ? (
          <PanelSkeleton rows={3} />
        ) : failed ? (
          <PanelError
            error={contacts.error ?? boxes.error}
            onRetry={() => {
              contacts.refetch()
              boxes.refetch()
            }}
            what="Past imports didn’t load"
          />
        ) : rows.length === 0 ? (
          <Empty icon="upload" title="Nothing imported yet">
            Bring mail in from another provider over IMAP, or contacts from a CSV.
          </Empty>
        ) : (
          <table className="rtable">
            <thead>
              <tr>
                <th>Import</th>
                <th>Started</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>{rows.map((r) => r.node)}</tbody>
          </table>
        )}
      </div>
    </section>
  )
}
