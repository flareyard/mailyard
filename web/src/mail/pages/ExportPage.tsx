/**
 * `/mail/$mailboxId/export` (export.html): every message as one mbox file and a zip of .eml files. Progress
 * while it runs (polled), then signed download links with the time they stop working (downloadsExpireAt),
 * and the earlier exports. GET/POST …/exports, GET …/exports/{exportId}.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useEffect } from "react"
import { ApiError, api, unwrap } from "../../api/client.ts"
import { Gated } from "../../auth/NoPermission.tsx"
import { fmtInt, num } from "../../lib/format.ts"
import { Icon } from "../../ui/icons.tsx"
import { PanelError, PanelSkeleton, RequestId } from "../../ui/Panel.tsx"
import { useMail } from "../context.tsx"
import { fileSize, utcStamp } from "../logic.ts"
import { mailboxDetailQuery } from "../queries.ts"
import { expiryWords, exportPct, FORMAT_WORDS, relativeShort } from "./logic.ts"
import { MailPage, pageKeys } from "./shared.tsx"
import type { ExportList, MailExport } from "./types.ts"

const active = (e: MailExport) => e.status === "pending" || e.status === "running"

export function ExportPage() {
  const { mailboxId, local, access } = useMail()
  const qc = useQueryClient()
  const key = pageKeys.exports(mailboxId)
  const list = useQuery({
    queryKey: key,
    queryFn: () =>
      unwrap(
        api.GET("/v1/mailboxes/{id}/exports", { params: { path: { id: mailboxId } } }),
      ) as Promise<ExportList>,
  })
  const exports = [...(list.data?.exports ?? [])].sort((a, b) => Number(b.createdAt) - Number(a.createdAt))
  const running = exports.find(active)
  const current = useQuery({
    queryKey: [...key, running?.id ?? "none"],
    queryFn: () =>
      unwrap(
        api.GET("/v1/mailboxes/{id}/exports/{exportId}", {
          params: { path: { id: mailboxId, exportId: running?.id ?? "" } },
        }),
      ) as Promise<MailExport>,
    enabled: Boolean(running),
    refetchInterval: (q) => (q.state.data && !active(q.state.data) ? false : 5000),
  })
  // When the polled export finishes, fold it back into the list.
  const live = current.data && running && current.data.id === running.id ? current.data : running
  const finished = current.data && !active(current.data) ? current.data : null
  useEffect(() => {
    if (finished)
      qc.setQueryData<ExportList>(key, (old) =>
        old ? { exports: old.exports.map((e) => (e.id === finished.id && active(e) ? finished : e)) } : old,
      )
  }, [finished, qc, key])
  const detail = useQuery(mailboxDetailQuery(mailboxId))
  const total = num(detail.data?.messageCount) ?? null
  const start = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/mailboxes/{id}/exports", { params: { path: { id: mailboxId } } }),
      ) as Promise<MailExport>,
    onSuccess: (e) => qc.setQueryData<ExportList>(key, (old) => ({ exports: [e, ...(old?.exports ?? [])] })),
  })
  const done = exports.filter((e) => !active(e))
  return (
    <MailPage
      label="Export"
      crumb={
        <>
          <Link to="/mail/$mailboxId/imports" params={{ mailboxId }}>
            Import and export
          </Link>
          <span aria-hidden="true">/</span>
          <span>Export</span>
        </>
      }
      title={`Export ${local}`}
      sub={`Every message in ${local}, as one mbox file and a zip of .eml files.`}
    >
      {list.isPending ? (
        <section className="panel" aria-busy="true">
          <div className="panel-body">
            <PanelSkeleton rows={3} />
          </div>
        </section>
      ) : list.isError ? (
        <section className="panel">
          <div className="panel-body">
            <PanelError error={list.error} onRetry={() => list.refetch()} what="The exports didn’t load" />
          </div>
        </section>
      ) : live && active(live) ? (
        <section className="panel" data-endpoint="POST /v1/mailboxes/{id}/exports · GET …/exports/{exportId}">
          <header className="panel-head">
            <h2 className="panel-title">Exporting {local}</h2>
            <span className="panel-meta">
              {FORMAT_WORDS[live.format] ?? live.format} · started {relativeShort(Number(live.createdAt))}
            </span>
          </header>
          <div className="panel-body stack stack-16">
            <div className="stack stack-8">
              <div className="spread">
                <span className="t-label">
                  {fmtInt(live.messageCount)}
                  {total ? ` of ${fmtInt(total)}` : ""} messages written
                </span>
                {exportPct(live, total) !== null ? (
                  <span className="t-small muted num">{exportPct(live, total)}%</span>
                ) : null}
              </div>
              <div
                className="progress"
                role="progressbar"
                aria-valuenow={exportPct(live, total) ?? undefined}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Export progress"
              >
                <span style={{ width: `${exportPct(live, total) ?? 8}%` }} />
              </div>
            </div>
            <p className="hint">
              You can leave this page. The download links appear here and in Alerts when it’s ready, with the
              time they stop working.
            </p>
          </div>
        </section>
      ) : (
        <section className="panel" data-endpoint="POST /v1/mailboxes/{id}/exports">
          <header className="panel-head">
            <h2 className="panel-title">New export</h2>
            <span className="panel-meta">mbox and .eml zip</span>
          </header>
          <div className="panel-body stack stack-12">
            <p className="t-copy">
              {total !== null ? `${fmtInt(total)} messages` : "Every message"} in {local}, every folder
              included. It runs in the background; the links last a while, then Export again makes fresh ones.
            </p>
            {start.isError ? (
              <div className="callout callout-error" role="alert">
                <div className="stack stack-8">
                  <span>
                    <b>The export didn’t start.</b>{" "}
                    {start.error instanceof ApiError ? start.error.message : "Mailyard couldn’t be reached."}
                  </span>
                  {start.error instanceof ApiError && start.error.requestId ? (
                    <RequestId id={start.error.requestId} />
                  ) : null}
                </div>
              </div>
            ) : null}
            <div className="cluster">
              <Gated allowed={access.manage} reason={access.manageReason} who={access.manageWho}>
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={start.isPending}
                  onClick={() => start.mutate()}
                >
                  <Icon name="download" />
                  {start.isPending ? "Starting…" : `Export ${local}`}
                </button>
              </Gated>
            </div>
          </div>
        </section>
      )}
      {done.length ? (
        <section className="panel" data-endpoint="GET /v1/mailboxes/{id}/exports">
          <header className="panel-head">
            <h2 className="panel-title">Earlier exports</h2>
          </header>
          <div className="panel-body">
            <ul className="list">
              {done.map((e) => (
                <ExportRow key={`${e.id}-${e.createdAt}`} e={e} />
              ))}
            </ul>
          </div>
        </section>
      ) : null}
    </MailPage>
  )
}

function ExportRow({ e }: { e: MailExport }) {
  const expiry = expiryWords(e)
  const expired = e.downloadsExpireAt !== null && Number(e.downloadsExpireAt) < Date.now()
  return (
    <>
      <li className="list-row" style={{ flexWrap: "wrap" }}>
        <span className="grow">
          <span className="row-title">
            {utcStamp(Number(e.completedAt ?? e.createdAt))} · {fmtInt(e.messageCount)} messages
          </span>
          <span className="row-sub">
            {e.status === "complete" ? (
              <>
                {num(e.size) ? `mbox ${fileSize(e.size)}` : null}
                {num(e.size) && num(e.zipSize) ? " · " : null}
                {num(e.zipSize) ? `zip ${fileSize(e.zipSize)}` : null}
                {" · "}
              </>
            ) : e.error ? (
              <>{e.error} · </>
            ) : null}
            <span className="mono">{e.id}</span>
          </span>
        </span>
        <span className={`pill ${e.status === "complete" ? "pill-pass" : "pill-fail"}`}>
          <span className="dot" />
          {e.status === "complete" ? "Complete" : "Failed"}
        </span>
        {e.status === "complete" && !expired && e.downloads.mbox ? (
          <a className="btn btn-secondary btn-sm" href={e.downloads.mbox} download>
            mbox
          </a>
        ) : null}
        {e.status === "complete" && !expired && e.downloads.zip ? (
          <a className="btn btn-secondary btn-sm" href={e.downloads.zip} download>
            .eml zip
          </a>
        ) : null}
      </li>
      {e.status === "complete" && expiry ? (
        <li className="list-row">
          <span className="t-small muted" data-endpoint="downloadsExpireAt (built)">
            {expiry}
          </span>
        </li>
      ) : null}
    </>
  )
}
