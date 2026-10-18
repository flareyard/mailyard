/**
 * `/mail/$mailboxId/imports` (import-probe.html and the "Import and export" hub): earlier and running
 * imports, a new IMAP import (probe first: every folder, its count, where it goes and what's skipped and
 * why; then copy), an mbox import (an upload or another mailbox's export), and the way to Export.
 */
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { ApiError, api, unwrap } from "../../api/client.ts"
import { Gated } from "../../auth/NoPermission.tsx"
import { fmtInt, num } from "../../lib/format.ts"
import { Icon } from "../../ui/icons.tsx"
import { PanelError, PanelSkeleton, RequestId } from "../../ui/Panel.tsx"
import { useMail } from "../context.tsx"
import { fileSize, utcStamp } from "../logic.ts"
import { mailboxDetailQuery, mailboxesQuery } from "../queries.ts"
import { importProgress, relativeShort } from "./logic.ts"
import { LabelTag, MailPage, pageKeys } from "./shared.tsx"
import type { ImportList, MailImport, Probe } from "./types.ts"

/** The import's status as a pill. */
export function ImportStatus({ imp }: { imp: Pick<MailImport, "status"> }) {
  const map: Record<string, [string, string]> = {
    pending: ["pill-neutral", "Waiting"],
    running: ["pill-info", "Copying"],
    paused: ["pill-warn", "Paused"],
    complete: ["pill-pass", "Complete"],
    failed: ["pill-fail", "Stopped"],
    cancelled: ["pill-neutral", "Cancelled"],
  }
  const [cls, label] = map[imp.status] ?? ["pill-neutral", imp.status]
  return (
    <span className={`pill ${cls}`}>
      <span className="dot" />
      {label}
    </span>
  )
}

export const importsQueryOptions = (mailboxId: string) => ({
  queryKey: pageKeys.imports(mailboxId),
  queryFn: () =>
    unwrap(
      api.GET("/v1/mailboxes/{id}/imports", { params: { path: { id: mailboxId } } }),
    ) as Promise<ImportList>,
})

export function ImportsPage() {
  const { mailboxId, local, access } = useMail()
  const imports = useQuery({
    ...importsQueryOptions(mailboxId),
    refetchInterval: (q) =>
      q.state.data?.imports.some((i) => i.status === "running" || i.status === "pending") ? 10_000 : false,
  })
  const list = [...(imports.data?.imports ?? [])].sort((a, b) => Number(b.createdAt) - Number(a.createdAt))
  return (
    <MailPage
      label="Import and export"
      crumb={<span>Import and export</span>}
      title="Import and export"
      sub="Bring mail in over IMAP or as mbox, and take everything out as mbox and .eml."
      actions={
        <Gated allowed={access.manage} reason={access.manageReason} who={access.manageWho} side="right">
          <Link className="btn btn-secondary btn-sm" to="/mail/$mailboxId/export" params={{ mailboxId }}>
            <Icon name="download" />
            Export {local}
          </Link>
        </Gated>
      }
    >
      <section className="panel" data-endpoint="GET /v1/mailboxes/{id}/imports">
        <header className="panel-head">
          <h2 className="panel-title">Imports</h2>
          <span className="panel-meta">Running, paused and finished copies into {local}</span>
        </header>
        <div className="panel-body">
          {imports.isPending ? (
            <PanelSkeleton rows={2} />
          ) : imports.isError ? (
            <PanelError
              error={imports.error}
              onRetry={() => imports.refetch()}
              what="The imports didn’t load"
            />
          ) : list.length === 0 ? (
            <p className="t-small muted">
              Nothing imported yet. Copy an old mailbox in below; duplicates are skipped automatically.
            </p>
          ) : (
            <ul className="list">
              {list.map((imp) => {
                const p = importProgress(imp)
                return (
                  <li key={imp.id}>
                    <Link
                      className="list-row"
                      style={{ flexWrap: "wrap" }}
                      to="/mail/$mailboxId/imports/$importId"
                      params={{ mailboxId, importId: imp.id }}
                    >
                      <span className="grow">
                        <span className="row-title">
                          {imp.source === "imap" ? (imp.username ?? imp.host ?? "IMAP") : "mbox file"}
                          {imp.mode === "catchup" ? " · catch-up" : ""}
                        </span>
                        <span className="row-sub">
                          {imp.host ? <span className="mono">{imp.host}</span> : null}
                          {imp.host ? " · " : ""}
                          {fmtInt(p.imported)} of {fmtInt(p.source)} copied · started{" "}
                          {relativeShort(Number(imp.startedAt ?? imp.createdAt))} ·{" "}
                          <span className="mono">{imp.id}</span>
                        </span>
                      </span>
                      <ImportStatus imp={imp} />
                      <Icon name="chevron-right" />
                    </Link>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </section>
      <ImapImport />
      <MboxImport />
    </MailPage>
  )
}

function ImapImport() {
  const { mailboxId, local, access } = useMail()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [host, setHost] = useState("")
  const [port, setPort] = useState("993")
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [mode, setMode] = useState<"full" | "catchup">("full")
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const creds = { host: host.trim(), port: Number(port) || 993, username: username.trim(), password }
  const probe = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/mailboxes/{id}/imports/probe", { params: { path: { id: mailboxId } }, body: creds }),
      ) as Promise<Probe>,
    onSuccess: (p) => setPicked(new Set(p.folders.filter((f) => !f.skipped).map((f) => f.name))),
  })
  const start = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/mailboxes/{id}/imports", {
          params: { path: { id: mailboxId } },
          body: { source: "imap", ...creds, folders: [...picked], mode },
        }),
      ) as Promise<MailImport>,
    onSuccess: (imp) => {
      qc.setQueryData<ImportList>(pageKeys.imports(mailboxId), (old) => ({
        imports: [imp, ...(old?.imports ?? [])],
      }))
      qc.setQueryData(pageKeys.import(mailboxId, imp.id), imp)
      setPassword("")
      navigate({ to: "/mail/$mailboxId/imports/$importId", params: { mailboxId, importId: imp.id } })
    },
  })
  const p = probe.data
  const total = p
    ? p.folders.filter((f) => picked.has(f.name)).reduce((n, f) => n + (num(f.messages) ?? 0), 0)
    : 0
  const skippedN = p ? p.folders.filter((f) => f.skipped).length : 0
  const ready = creds.host && creds.username && creds.password
  if (p)
    return (
      <section
        className="panel"
        data-endpoint="POST /v1/mailboxes/{id}/imports/probe {host, port, username, password} (built)"
      >
        <header className="panel-head">
          <h2 className="panel-title">
            What’s in <span className="mono">{creds.username}</span>
          </h2>
          <span className="panel-meta">
            <span className="mono">
              {p.host}:{num(p.port)}
            </span>{" "}
            · checked just now · nothing copied yet
          </span>
        </header>
        <div className="panel-body stack stack-16">
          <p className="t-copy">
            {picked.size} folder{picked.size === 1 ? "" : "s"} and {fmtInt(total)} messages will be copied.
            {skippedN
              ? ` ${skippedN} ${skippedN === 1 ? "is" : "are"} skipped by default, each with the reason; tick one to copy it anyway.`
              : ""}
          </p>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 44 }}>
                    <span className="sr-only">Copy</span>
                  </th>
                  <th>Folder</th>
                  <th className="r">Messages</th>
                </tr>
              </thead>
              <tbody>
                {p.folders.map((f) => {
                  const empty = f.messages === null || num(f.messages) === 0
                  return (
                    <tr key={f.name} className={f.skipped ? "is-skipped" : undefined}>
                      <td>
                        <label className="check" style={{ alignItems: "center" }}>
                          <input
                            type="checkbox"
                            checked={picked.has(f.name)}
                            disabled={f.skipped && empty}
                            aria-label={f.skipped ? `Copy ${f.name} anyway` : `Copy ${f.name}`}
                            onChange={(e) => {
                              const next = new Set(picked)
                              if (e.target.checked) next.add(f.name)
                              else next.delete(f.name)
                              setPicked(next)
                            }}
                          />
                          <span className="sr-only">{f.skipped ? "Copy anyway" : "Copy"}</span>
                        </label>
                      </td>
                      <td>
                        <span className="mono">{f.name}</span>
                        <div className="t-small muted">
                          {f.skipped && f.skipReason ? (
                            f.skipReason
                          ) : (
                            <>
                              into <span className="mono">{f.folder ?? "inbox"}</span>
                              {f.label ? (
                                <>
                                  {" "}
                                  + <LabelTag name={f.label} color={null} />
                                </>
                              ) : null}
                            </>
                          )}
                        </div>
                      </td>
                      <td className="r">{f.messages === null ? "—" : fmtInt(f.messages)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="field">
            <span className="label">What to copy</span>
            {/* biome-ignore lint/a11y/useSemanticElements: the design's segmented control */}
            <div className="seg" role="group" aria-label="Import mode">
              <button type="button" aria-pressed={mode === "full"} onClick={() => setMode("full")}>
                Everything
              </button>
              <button type="button" aria-pressed={mode === "catchup"} onClick={() => setMode("catchup")}>
                Only what’s new since the last import
              </button>
            </div>
          </div>
          <div className="callout callout-info">
            <span>
              The password is held only while the import runs (and while it’s paused), then dropped.
              Duplicates already in {local} are skipped automatically.
            </span>
          </div>
          {start.isError ? (
            <PanelError error={start.error} onRetry={() => start.mutate()} what="The import didn’t start" />
          ) : null}
          <div className="cluster">
            <Gated allowed={access.manage} reason={access.manageReason} who={access.manageWho}>
              <button
                className="btn btn-primary"
                type="button"
                disabled={!picked.size || start.isPending}
                onClick={() => start.mutate()}
              >
                {start.isPending ? "Starting…" : `Copy ${fmtInt(total)} messages`}
              </button>
            </Gated>
            <button className="btn btn-ghost" type="button" onClick={() => probe.reset()}>
              Change account
            </button>
          </div>
        </div>
      </section>
    )
  return (
    <section
      className="panel"
      data-endpoint="POST /v1/mailboxes/{id}/imports/probe {host, port, username, password} (built)"
    >
      <header className="panel-head">
        <h2 className="panel-title">Import from IMAP</h2>
        <span className="panel-meta">Gmail, Outlook, Fastmail or any IMAP server</span>
      </header>
      <form
        className="panel-body stack stack-16"
        onSubmit={(e) => {
          e.preventDefault()
          if (ready && access.manage) probe.mutate()
        }}
      >
        <p className="t-copy">
          Mailyard looks first: every folder with its message count, where it would go and what it would skip.
          Nothing is copied until you say so.
        </p>
        <div className="imp-form">
          <div className="field">
            <label className="label" htmlFor="imap-host">
              Server
            </label>
            <input
              id="imap-host"
              className="input mono"
              placeholder="imap.gmail.com"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="imap-port">
              Port
            </label>
            <input
              id="imap-port"
              className="input mono"
              inputMode="numeric"
              value={port}
              onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
            />
          </div>
          <div className="field field-wide">
            <label className="label" htmlFor="imap-user">
              Account
            </label>
            <input
              id="imap-user"
              className="input mono"
              placeholder="you@gmail.com"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="field field-wide">
            <label className="label" htmlFor="imap-pw">
              App password
            </label>
            <input
              id="imap-pw"
              className="input mono"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
            />
            <span className="hint">
              For Gmail, make an app password in your Google account. It’s held only while the import runs.
            </span>
          </div>
        </div>
        {probe.isError ? (
          <div className="callout callout-error" role="alert">
            <div className="stack stack-8">
              <span>
                <b>Couldn’t look inside that account.</b>{" "}
                {probe.error instanceof ApiError ? probe.error.message : "Mailyard couldn’t be reached."}
              </span>
              {probe.error instanceof ApiError && probe.error.requestId ? (
                <RequestId id={probe.error.requestId} />
              ) : null}
            </div>
          </div>
        ) : null}
        <div className="cluster">
          <Gated allowed={access.manage} reason={access.manageReason} who={access.manageWho}>
            <button className="btn btn-primary" type="submit" disabled={!ready || probe.isPending}>
              {probe.isPending ? "Checking folders…" : "Check folders"}
            </button>
          </Gated>
        </div>
      </form>
    </section>
  )
}

const MAX_UPLOAD = 25 * 1024 * 1024

function MboxImport() {
  const { mailboxId, local, access } = useMail()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const boxes = useQuery(mailboxesQuery)
  const others = (boxes.data?.mailboxes ?? []).filter((m) => m.holdsMail && m.id !== mailboxId)
  const details = useQueries({ queries: others.map((m) => mailboxDetailQuery(m.id)) })
  const exports = others.flatMap((m, i) => {
    const d = details[i]?.data
    return d?.lastExport?.status === "complete"
      ? [{ mailboxId: m.id, mailbox: m.address, ex: d.lastExport }]
      : []
  })
  const [file, setFile] = useState<File | null>(null)
  const [exportId, setExportId] = useState("")
  const [problem, setProblem] = useState<string | null>(null)
  const start = useMutation({
    mutationFn: async () => {
      let body: { source: "mbox"; uploadKey?: string; exportId?: string }
      if (file) {
        const up = (await unwrap(
          api.POST("/v1/mailboxes/{id}/uploads", {
            params: { path: { id: mailboxId }, query: { filename: file.name.replace(/[\\/]/g, "_") } },
            body: file as unknown as string,
            bodySerializer: (b) => b as unknown as string,
          }),
        )) as { key: string }
        body = { source: "mbox", uploadKey: up.key }
      } else body = { source: "mbox", exportId }
      return (await unwrap(
        api.POST("/v1/mailboxes/{id}/imports", { params: { path: { id: mailboxId } }, body }),
      )) as MailImport
    },
    onSuccess: (imp) => {
      qc.setQueryData<ImportList>(pageKeys.imports(mailboxId), (old) => ({
        imports: [imp, ...(old?.imports ?? [])],
      }))
      qc.setQueryData(pageKeys.import(mailboxId, imp.id), imp)
      navigate({ to: "/mail/$mailboxId/imports/$importId", params: { mailboxId, importId: imp.id } })
    },
    onError: (e) => setProblem(e instanceof ApiError ? e.message : "Mailyard couldn’t be reached."),
  })
  return (
    <section
      className="panel"
      data-endpoint="POST /v1/mailboxes/{id}/uploads?filename= · POST /v1/mailboxes/{id}/imports {source:mbox, uploadKey|exportId}"
    >
      <header className="panel-head">
        <h2 className="panel-title">Import an mbox</h2>
        <span className="panel-meta">A file up to 25 MiB, or another mailbox’s export</span>
      </header>
      <form
        className="panel-body stack stack-12"
        onSubmit={(e) => {
          e.preventDefault()
          setProblem(null)
          if (!access.manage) return
          if (file && file.size > MAX_UPLOAD)
            return setProblem(
              `${file.name} is ${fileSize(file.size)}; uploads stop at 25 MiB. Import a bigger mailbox over IMAP, or from an export.`,
            )
          if (!file && !exportId) return setProblem("Choose a file or an export.")
          start.mutate()
        }}
      >
        <div className="field">
          <label className="label" htmlFor="mbox-file">
            mbox file
          </label>
          <input
            id="mbox-file"
            className="input"
            type="file"
            accept=".mbox,application/mbox,text/plain"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null)
              if (e.target.files?.[0]) setExportId("")
            }}
          />
          {file ? (
            <span className="hint">
              {file.name} · {fileSize(file.size)}
            </span>
          ) : null}
        </div>
        {exports.length ? (
          <div className="field">
            <label className="label" htmlFor="mbox-export">
              Or copy another mailbox’s export
            </label>
            <select
              id="mbox-export"
              className="select"
              value={exportId}
              onChange={(e) => {
                setExportId(e.target.value)
                if (e.target.value) setFile(null)
              }}
            >
              <option value="">Choose an export</option>
              {exports.map(({ mailboxId: mid, mailbox, ex }) => (
                <option key={mid} value={ex.id}>
                  {mailbox} · {fmtInt(ex.messageCount)} messages ·{" "}
                  {utcStamp(Number(ex.completedAt ?? ex.createdAt))}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <p className="hint">
          Messages land in {local}’s folders by their own flags; duplicates already here are skipped.
        </p>
        {problem ? (
          <p className="field-error" role="alert">
            <Icon name="warn" />
            {problem}
          </p>
        ) : null}
        <div className="cluster">
          <Gated allowed={access.manage} reason={access.manageReason} who={access.manageWho}>
            <button
              className="btn btn-secondary"
              type="submit"
              disabled={start.isPending || (!file && !exportId)}
            >
              {start.isPending ? "Uploading…" : "Import mbox"}
            </button>
          </Gated>
        </div>
      </form>
    </section>
  )
}
