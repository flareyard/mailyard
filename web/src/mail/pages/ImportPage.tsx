/**
 * `/mail/$mailboxId/imports/$importId` (import-running, import-paused, import-failed, import-retry): one
 * import, live. Totals, rate and ETA, the per-folder table with each folder's last error and retryable
 * count, pause, resume and cancel, retry failed (asking for the password again), and the catch-up pass.
 * Polled while it runs and moved by `import.progress` frames on the mailbox socket.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate, useSearch } from "@tanstack/react-router"
import { type ReactElement, useCallback, useState } from "react"
import { ApiError, api, unwrap } from "../../api/client.ts"
import { Gated } from "../../auth/NoPermission.tsx"
import { fmtInt, num } from "../../lib/format.ts"
import type { LiveFrame } from "../../live/socket.ts"
import { useMailboxLive } from "../../live/useMailboxLive.ts"
import { Icon } from "../../ui/icons.tsx"
import { PanelError, PanelSkeleton, RequestId } from "../../ui/Panel.tsx"
import { useMail } from "../context.tsx"
import { utcShort } from "../logic.ts"
import { toast } from "../toasts.tsx"
import { ImportStatus, importsQueryOptions } from "./ImportsPage.tsx"
import {
  applyImportProgress,
  durationWords,
  etaWords,
  folderProgress,
  folderState,
  importProgress,
  isActive,
  relativeShort,
  retryableCount,
} from "./logic.ts"
import { LabelTag, MailPage, pageKeys, Sheet } from "./shared.tsx"
import type { ImportList, MailImport } from "./types.ts"

const PILL: Record<string, string> = {
  pass: "pill-pass",
  warn: "pill-warn",
  fail: "pill-fail",
  info: "pill-info",
  neutral: "pill-neutral",
}

export function ImportPage({ importId }: { importId: string }) {
  const { mailboxId, local, access } = useMail()
  const search = useSearch({ from: "/_app/mail/$mailboxId/imports/$importId" })
  const navigate = useNavigate()
  const qc = useQueryClient()
  const key = pageKeys.import(mailboxId, importId)
  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      unwrap(
        api.GET("/v1/mailboxes/{id}/imports/{importId}", { params: { path: { id: mailboxId, importId } } }),
      ) as Promise<MailImport>,
    refetchInterval: (query) => (query.state.data && isActive(query.state.data.status) ? 15_000 : false),
  })
  const all = useQuery(importsQueryOptions(mailboxId))
  const onFrame = useCallback(
    (f: LiveFrame) => {
      if (f.type !== "import.progress") return
      qc.setQueryData<MailImport>(pageKeys.import(mailboxId, String(f.importId)), (old) =>
        old ? applyImportProgress(old, f) : old,
      )
      qc.setQueryData<ImportList>(pageKeys.imports(mailboxId), (old) =>
        old ? { imports: old.imports.map((i) => applyImportProgress(i, f)) } : old,
      )
    },
    [qc, mailboxId],
  )
  const live = useMailboxLive(mailboxId, onFrame)
  const act = useMutation({
    mutationFn: async (action: "pause" | "resume" | "cancel") => {
      const path = { params: { path: { id: mailboxId, importId } } }
      const r =
        action === "pause"
          ? api.POST("/v1/mailboxes/{id}/imports/{importId}/pause", path)
          : action === "resume"
            ? api.POST("/v1/mailboxes/{id}/imports/{importId}/resume", path)
            : api.POST("/v1/mailboxes/{id}/imports/{importId}/cancel", path)
      return (await unwrap(r)) as MailImport
    },
    onSuccess: (imp) => {
      qc.setQueryData(key, imp)
      qc.setQueryData<ImportList>(pageKeys.imports(mailboxId), (old) =>
        old ? { imports: old.imports.map((i) => (i.id === imp.id ? imp : i)) } : old,
      )
    },
    onError: (e) =>
      toast({
        title: "The import didn’t change",
        sub: e instanceof ApiError ? e.message : "Mailyard couldn’t be reached.",
        tone: "error",
      }),
  })
  const [confirmCancel, setConfirmCancel] = useState(false)
  const setRetry = (open: boolean) =>
    navigate({
      to: "/mail/$mailboxId/imports/$importId",
      params: { mailboxId, importId },
      search: open ? { retry: 1 } : {},
      replace: true,
    })

  const imp = q.data
  const title = imp
    ? `${imp.source === "imap" ? `Import from ${providerName(imp.host)}` : "mbox import"}`
    : "Import"
  return (
    <MailPage
      label="Import"
      crumb={
        <>
          <Link to="/mail/$mailboxId/imports" params={{ mailboxId }}>
            Import and export
          </Link>
          <span aria-hidden="true">/</span>
          <span className="mono">{importId}</span>
        </>
      }
      title="Import and export"
      sub="Bring mail in over IMAP or as mbox, and take everything out as mbox and .eml."
    >
      {q.isPending ? (
        <section className="panel" aria-busy="true">
          <div className="panel-body">
            <PanelSkeleton rows={5} />
          </div>
        </section>
      ) : q.isError ? (
        <section className="panel">
          <div className="panel-body">
            <PanelError error={q.error} onRetry={() => q.refetch()} what="This import didn’t load" />
          </div>
        </section>
      ) : imp ? (
        <>
          <ImportPanel
            imp={imp}
            title={title}
            local={local}
            live={live === "open"}
            canManage={access.manage}
            manageReason={access.manageReason}
            manageWho={access.manageWho}
            busy={act.isPending}
            confirmCancel={confirmCancel}
            onConfirmCancel={setConfirmCancel}
            onAct={(a) => {
              setConfirmCancel(false)
              act.mutate(a)
            }}
            onRetry={() => setRetry(true)}
          />
          <CatchUp imp={imp} list={all.data?.imports ?? []} />
          {search.retry === 1 && imp.status !== "running" ? (
            <RetrySheet imp={imp} onClose={() => setRetry(false)} />
          ) : null}
        </>
      ) : null}
    </MailPage>
  )
}

const providerName = (host: string | null) => {
  const h = (host ?? "").toLowerCase()
  if (h.includes("gmail") || h.includes("google")) return "Gmail"
  if (h.includes("outlook") || h.includes("office365") || h.includes("hotmail")) return "Outlook"
  if (h.includes("fastmail")) return "Fastmail"
  if (h.includes("yahoo")) return "Yahoo"
  if (h.includes("zoho")) return "Zoho"
  return host ?? "IMAP"
}

function ImportPanel({
  imp,
  title,
  local,
  live,
  canManage,
  manageReason,
  manageWho,
  busy,
  confirmCancel,
  onConfirmCancel,
  onAct,
  onRetry,
}: {
  imp: MailImport
  title: string
  local: string
  live: boolean
  canManage: boolean
  manageReason: string
  manageWho: string
  busy: boolean
  confirmCancel: boolean
  onConfirmCancel: (v: boolean) => void
  onAct: (a: "pause" | "resume" | "cancel") => void
  onRetry: () => void
}) {
  const p = importProgress(imp)
  const retryable = retryableCount(imp)
  const permanent = p.failed - retryable
  const started = num(imp.startedAt ?? imp.createdAt)
  const status = imp.status
  const heading =
    status === "paused"
      ? `${title} · paused`
      : status === "failed"
        ? `${title} stopped`
        : status === "complete"
          ? `${title} · done`
          : status === "cancelled"
            ? `${title} · cancelled`
            : `Importing from ${providerName(imp.host)}`
  const eta = etaWords(imp.etaAt)
  const gated = (el: ReactElement<{ onClick?: () => void }>) => (
    <Gated allowed={canManage} reason={manageReason} who={manageWho}>
      {el}
    </Gated>
  )
  return (
    <section
      className="panel"
      data-endpoint="GET /v1/mailboxes/{id}/imports/{importId} · ws /v1/mailboxes/{id}/live → import.progress (built)"
    >
      <header className="panel-head">
        <h2 className="panel-title">{heading}</h2>
        <span className="panel-meta">
          {imp.username ? <span className="mono">{imp.username}</span> : null}
          {imp.host ? (
            <>
              {" · "}
              <span className="mono">
                {imp.host}
                {imp.port !== null ? `:${num(imp.port)}` : ""}
              </span>
            </>
          ) : null}
          {started ? ` · started ${relativeShort(started)}` : " · waiting to start"}
          {isActive(status) && live ? " · live" : ""}
        </span>
      </header>
      <div className="panel-body stack stack-24">
        {status === "paused" ? (
          <div className="callout callout-warn" role="status">
            <span>
              <b>Paused {imp.pausedAt ? relativeShort(Number(imp.pausedAt)) : ""}.</b> Nothing is copying.{" "}
              {imp.credentialsHeld
                ? "The password is still held so Resume picks up from the last message copied; Cancel forgets it."
                : "Resume picks up from the last message copied."}
            </span>
          </div>
        ) : null}
        {status === "failed" ? (
          <div className="callout callout-error" role="alert">
            <div className="stack stack-8">
              <span>
                <b>The import stopped.</b> {imp.error ?? "Something went wrong part-way."}
              </span>
              <span className="req-id">
                Import <code className="mono">{imp.id}</code>
              </span>
            </div>
          </div>
        ) : null}
        {status === "complete" ? (
          <div className="callout callout-ok" role="status">
            <span>
              <b>Done.</b>{" "}
              {imp.accountedFor
                ? "Every message in the source is accounted for: copied, already here, skipped or failed."
                : `${fmtInt(p.done)} of ${fmtInt(p.source)} accounted for.`}
            </span>
          </div>
        ) : null}
        <div className="imp-head">
          <div className="stat">
            <span className="stat-label">Copied</span>
            <span className="stat-value">{fmtInt(p.imported)}</span>
            <span className="stat-delta">of {fmtInt(p.source)} in the source</span>
          </div>
          <div className="stat">
            <span className="stat-label">Duplicates skipped</span>
            <span className="stat-value">{fmtInt(p.duplicates)}</span>
            <span className="stat-delta">already in {local}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Failed</span>
            <span className="stat-value">{fmtInt(p.failed)}</span>
            <span className="stat-delta">{fmtInt(retryable)} can be retried</span>
          </div>
          {status === "paused" ? (
            <div className="stat">
              <span className="stat-label">Paused</span>
              <span className="stat-value">{imp.pausedAt ? relativeShort(Number(imp.pausedAt)) : "—"}</span>
              <span className="stat-delta">{started ? `started ${relativeShort(started)}` : ""}</span>
            </div>
          ) : status === "failed" || status === "complete" || status === "cancelled" ? (
            <div className="stat">
              <span className="stat-label">{status === "complete" ? "Finished" : "Stopped"}</span>
              <span className="stat-value">
                {imp.finishedAt ? relativeShort(Number(imp.finishedAt)) : "—"}
              </span>
              <span className="stat-delta">
                {durationWords(imp.startedAt, imp.finishedAt)
                  ? `after ${durationWords(imp.startedAt, imp.finishedAt)}`
                  : ""}
              </span>
            </div>
          ) : (
            <div className="stat">
              <span className="stat-label">Speed</span>
              <span className="stat-value">
                {imp.ratePerMinute !== null ? `${fmtInt(imp.ratePerMinute)}/min` : "—"}
              </span>
              <span className="stat-delta">
                {eta ?? (status === "pending" ? "starting" : "working out the pace")}
              </span>
            </div>
          )}
        </div>
        <div className="stack stack-8">
          <div className="spread">
            <span className="t-label">
              {fmtInt(p.done)} of {fmtInt(p.source)} accounted for
            </span>
            <span className="t-small muted num">{p.pct}%</span>
          </div>
          <div
            className={`progress${status === "paused" ? " is-paused" : status === "failed" ? " is-fail" : status === "complete" ? " is-done" : ""}`}
            role="progressbar"
            aria-valuenow={p.pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Import progress"
          >
            <span style={{ width: `${p.pct}%` }} />
          </div>
        </div>
        {imp.folders.length ? (
          <div className="table-wrap">
            <table className="table fold-table">
              <thead>
                <tr>
                  <th>Folder</th>
                  <th className="r">Total</th>
                  <th className="r">Copied</th>
                  <th className="r">Duplicates</th>
                  <th className="r">Failed</th>
                  <th style={{ minWidth: 96 }}>Progress</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {imp.folders.map((f) => {
                  const st = folderState(f, status)
                  const pct = folderProgress(f)
                  const fr = num(f.retryable) ?? 0
                  return (
                    <tr key={f.name}>
                      <td>
                        <span className="mono">{f.name}</span>
                        <div className="t-small muted">
                          into <span className="mono">{f.folder}</span>
                          {f.label ? (
                            <>
                              {" "}
                              + <LabelTag name={f.label} color={null} />
                            </>
                          ) : null}
                        </div>
                        {f.lastError ? (
                          <div className="t-small imp-error">
                            {f.lastError}{" "}
                            {fr
                              ? `${fmtInt(fr)} can be retried.`
                              : (num(f.failed) ?? 0) > 0
                                ? "None can be retried."
                                : ""}
                          </div>
                        ) : null}
                      </td>
                      <td className="r">{fmtInt(f.source)}</td>
                      <td className="r">{fmtInt(f.imported)}</td>
                      <td className="r">{fmtInt(f.duplicates)}</td>
                      <td className="r">{fmtInt(f.failed)}</td>
                      <td>
                        <div
                          className={`progress${st.label === "Done" || st.label === "Skipped" ? " is-done" : st.tone === "fail" ? " is-fail" : st.tone === "warn" ? " is-paused" : ""}`}
                          role="progressbar"
                          aria-valuenow={pct}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-label={f.name}
                        >
                          <span style={{ width: `${pct}%` }} />
                        </div>
                      </td>
                      <td>
                        <span className={`pill ${PILL[st.tone]}`}>
                          <span className="dot" />
                          {st.label}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        <div className="cluster">
          {status === "running" || status === "pending"
            ? gated(
                <button
                  className="btn btn-secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => onAct("pause")}
                >
                  <Icon name="pause" />
                  Pause
                </button>,
              )
            : null}
          {status === "paused"
            ? gated(
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={busy}
                  onClick={() => onAct("resume")}
                >
                  <Icon name="play" />
                  Resume
                </button>,
              )
            : null}
          {(status === "failed" || status === "complete" || status === "cancelled") && retryable > 0
            ? gated(
                <button className="btn btn-primary" type="button" onClick={onRetry}>
                  Retry the {fmtInt(retryable)} that can be retried
                </button>,
              )
            : null}
          {isActive(status) || status === "paused"
            ? confirmCancel
              ? gated(
                  <button
                    className="btn btn-danger"
                    type="button"
                    disabled={busy}
                    onClick={() => onAct("cancel")}
                  >
                    Cancel for good: keep what’s copied
                  </button>,
                )
              : gated(
                  <button
                    className="btn btn-danger-ghost"
                    type="button"
                    onClick={() => onConfirmCancel(true)}
                  >
                    Cancel import
                  </button>,
                )
            : null}
          <span className="t-small muted">
            {isActive(status)
              ? retryable
                ? `${fmtInt(retryable)} failed messages can be retried once the copy finishes.`
                : "Retry failed appears once the copy finishes; nothing here can be retried yet."
              : status === "failed" && retryable
                ? `The password isn’t kept after a failure, so retrying asks for it again.${permanent > 0 ? ` The ${fmtInt(permanent)} that failed for good can’t be imported.` : ""}`
                : status === "paused"
                  ? "Cancelling keeps what’s already copied."
                  : ""}
          </span>
        </div>
        {imp.retryOf ? (
          <span className="req-id">
            A retry of <code className="mono">{imp.retryOf}</code>
          </span>
        ) : null}
      </div>
    </section>
  )
}

/** The catch-up pass after the MX switch: a second short import that reads only what arrived since. */
function CatchUp({ imp, list }: { imp: MailImport; list: MailImport[] }) {
  const { mailboxId } = useMail()
  const catchup = imp.mode === "catchup" ? null : list.find((i) => i.catchupOf === imp.id)
  const parent = imp.mode === "catchup" && imp.catchupOf ? imp.catchupOf : null
  if (!catchup && !parent) return null
  const shown = catchup ?? imp
  const since = shown.since ? utcShort(Number(shown.since)).replace(/^\w+ /, "") : null
  const waiting = shown.status === "pending" && catchup && isActive(imp.status)
  return (
    <section
      className="panel"
      data-endpoint="GET /v1/mailboxes/{id}/imports → mode: catchup, catchupOf, since"
    >
      <header className="panel-head">
        <h2 className="panel-title">Catch-up after the MX switch</h2>
        {waiting ? (
          <span className="pill pill-neutral">
            <span className="dot" />
            Waiting for the full import
          </span>
        ) : (
          <ImportStatus imp={shown} />
        )}
      </header>
      <div className="panel-body stack stack-8">
        <p className="t-copy">
          Mail that reached the old server between starting the import and switching MX to Cloudflare gets a
          second, short pass. It runs on its own once the full import finishes and reads only what arrived
          {since ? ` since ${since}` : ""}.
        </p>
        <span className="req-id">
          Import{" "}
          {catchup ? (
            <Link to="/mail/$mailboxId/imports/$importId" params={{ mailboxId, importId: catchup.id }}>
              <code className="mono">{catchup.id}</code>
            </Link>
          ) : (
            <code className="mono">{imp.id}</code>
          )}{" "}
          · catch-up of{" "}
          {parent ? (
            <Link to="/mail/$mailboxId/imports/$importId" params={{ mailboxId, importId: parent }}>
              <code className="mono">{parent}</code>
            </Link>
          ) : (
            <code className="mono">{imp.id}</code>
          )}
        </span>
      </div>
    </section>
  )
}

/** Retry failed (import-retry.html): the password was dropped when the import stopped, so it's asked again. */
export function RetrySheet({ imp, onClose }: { imp: MailImport; onClose: () => void }) {
  const { mailboxId, access } = useMail()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [password, setPassword] = useState("")
  const retryable = retryableCount(imp)
  const from = imp.folders.filter((f) => (num(f.retryable) ?? 0) > 0).map((f) => f.name)
  const permanent = importProgress(imp).failed - retryable
  const retry = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/mailboxes/{id}/imports/{importId}/retry-failed", {
          params: { path: { id: mailboxId, importId: imp.id } },
          body: { password },
        }),
      ) as Promise<MailImport>,
    onSuccess: (next) => {
      setPassword("")
      qc.setQueryData(pageKeys.import(mailboxId, next.id), next)
      qc.setQueryData<ImportList>(pageKeys.imports(mailboxId), (old) => ({
        imports: [next, ...(old?.imports ?? [])],
      }))
      toast({ title: `Retrying ${fmtInt(retryable)} messages`, sub: `A new import linked to ${imp.id}.` })
      navigate({
        to: "/mail/$mailboxId/imports/$importId",
        params: { mailboxId, importId: next.id },
        replace: true,
      })
    },
  })
  return (
    <Sheet
      wide={false}
      title={`Retry ${fmtInt(retryable)} failed message${retryable === 1 ? "" : "s"}`}
      hint={
        <>
          {from.length ? (
            <>
              From{" "}
              {from.map((f, i) => (
                <span key={f}>
                  {i ? ", " : ""}
                  <span className="mono">{f}</span>
                </span>
              ))}
              .{" "}
            </>
          ) : null}
          {imp.credentialsHeld
            ? "Enter the password to confirm."
            : "The password was dropped when the import stopped, so enter it again."}
        </>
      }
      onClose={onClose}
      endpoint="POST /v1/mailboxes/{id}/imports/{importId}/retry-failed {password} (built)"
      foot={
        <>
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <Gated allowed={access.manage} reason={access.manageReason} who={access.manageWho} side="up">
            <button
              className="btn btn-primary"
              type="button"
              disabled={!password || retry.isPending || !retryable}
              onClick={() => retry.mutate()}
            >
              {retry.isPending ? "Starting…" : `Retry ${fmtInt(retryable)}`}
            </button>
          </Gated>
        </>
      }
    >
      <div className="field">
        <label className="label" htmlFor="retry-account">
          Account
        </label>
        <input id="retry-account" className="input mono" value={imp.username ?? ""} readOnly />
      </div>
      <form
        className="field"
        onSubmit={(e) => {
          e.preventDefault()
          if (password && access.manage) retry.mutate()
        }}
      >
        <label className="label" htmlFor="retry-pw">
          App password
        </label>
        <input
          id="retry-pw"
          className="input mono"
          type="password"
          autoComplete="off"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <span className="hint">Use the same app password as before. It’s held only for this retry.</span>
      </form>
      <p className="hint">
        {permanent > 0 ? `The ${fmtInt(permanent)} that failed for good aren’t retried. ` : ""}The retry is a
        new import linked to this one (<span className="mono">retryOf: {imp.id}</span>).
      </p>
      {retry.isError ? (
        <div className="callout callout-error" role="alert">
          <div className="stack stack-8">
            <span>
              <b>The retry didn’t start.</b>{" "}
              {retry.error instanceof ApiError ? retry.error.message : "Mailyard couldn’t be reached."}
            </span>
            {retry.error instanceof ApiError && retry.error.requestId ? (
              <RequestId id={retry.error.requestId} />
            ) : null}
          </div>
        </div>
      ) : null}
    </Sheet>
  )
}
