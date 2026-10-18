/**
 * Step 5, bring your old mail · optional (design: first-run/imap-{empty,folders,progress,paused,pass,fail}.html,
 * GAPS 4.6, 4.7). `POST /v1/mailboxes/{id}/imports/probe` lists the folders with one connection; nothing copies
 * until folders are picked and `POST /v1/mailboxes/{id}/imports` starts. Progress arrives as `import.progress`
 * on the mailbox's live socket, with a slow poll behind it. Pause, resume, cancel, and retry-failed (which needs
 * the password again, because it's wiped when an import ends).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type FormEvent, useCallback, useMemo, useState } from "react"
import { api, unwrap } from "../../api/client.ts"
import { Gated } from "../../auth/NoPermission.tsx"
import { fmtInt, num } from "../../lib/format.ts"
import type { LiveFrame } from "../../live/socket.ts"
import { useMailboxLive } from "../../live/useMailboxLive.ts"
import { Icon } from "../../ui/icons.tsx"
import { defaultFolderSelection, fmtUtc, landsIn, latest, mailRateLine, selectedMessages } from "../logic.ts"
import { type MailImport, mailImportQuery, mailImportsQuery, type Probe } from "../queries.ts"
import { nextAfter, SETUP_WHO, useMark, useSetup } from "../setup.tsx"
import { ApiErrorCallout, ConfirmButton, describe, FieldError, StepPanel, useNow } from "../ui.tsx"

const LEDE =
  "Copy mail from your old provider into a mailbox here. Nothing copies until you’ve seen the folders and picked them. Your password is held only while the import runs."

export function ImapStep() {
  const s = useSetup()
  const holding = s.mailboxes.filter((m) => m.holdsMail && m.kind !== "alias")
  const [mailboxId, setMailboxId] = useState(s.mailbox?.id ?? holding[0]?.id ?? "")
  const [fresh, setFresh] = useState(false)
  const imports = useQuery({ ...mailImportsQuery(mailboxId || "-"), enabled: Boolean(mailboxId) })
  const current = fresh ? undefined : latest(imports.data?.filter((i) => i.source === "imap"))

  const skip = () => {
    s.remember((m) => ({ ...m, skipped: { ...m.skipped, imap: true } }))
    s.goTo(
      nextAfter(
        s.steps.map((x) => (x.id === "imap" ? { ...x, status: "skipped" as const } : x)),
        "imap",
      ),
    )
  }

  if (!mailboxId)
    return (
      <StepPanel
        id="imap"
        n={5}
        title="Bring your old mail"
        lede={LEDE}
        endpoint="POST /v1/mailboxes/{id}/imports/probe (built, HAL-3368)"
        actions={
          <>
            <button className="btn btn-primary" type="button" onClick={() => s.goTo("mailbox")}>
              <Icon name="arrow-right" />
              First, create a mailbox
            </button>
            <button className="btn btn-ghost" type="button" onClick={skip}>
              Skip for now
            </button>
          </>
        }
      >
        <div className="callout callout-info">
          <Icon name="info" />
          <span>Old mail is copied into a mailbox. Create one in step 3.</span>
        </div>
      </StepPanel>
    )

  if (current && current.status !== "cancelled")
    return (
      <ImportView
        mailboxId={mailboxId}
        importId={current.id}
        initial={current}
        onSkip={skip}
        onAnother={() => setFresh(true)}
      />
    )

  return (
    <ConnectAndPick
      mailboxes={holding}
      mailboxId={mailboxId}
      onMailbox={(id) => {
        setMailboxId(id)
        setFresh(false)
      }}
      onStarted={() => setFresh(false)}
      onSkip={skip}
      cancelled={current?.status === "cancelled"}
    />
  )
}

function ConnectAndPick({
  mailboxes,
  mailboxId,
  onMailbox,
  onStarted,
  onSkip,
  cancelled,
}: {
  mailboxes: Array<{ id: string; address: string }>
  mailboxId: string
  onMailbox: (id: string) => void
  onStarted: () => void
  onSkip: () => void
  cancelled: boolean
}) {
  const s = useSetup()
  const qc = useQueryClient()
  const [host, setHost] = useState("")
  const [port, setPort] = useState("993")
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [probe, setProbe] = useState<Probe | null>(null)
  const [selected, setSelected] = useState<string[]>([])

  const probeM = useMutation({
    mutationFn: (body: { host: string; port: number; username: string; password: string }) =>
      unwrap(api.POST("/v1/mailboxes/{id}/imports/probe", { params: { path: { id: mailboxId } }, body })),
    onSuccess: (p) => {
      if (!p || !Array.isArray(p.folders)) return
      setProbe(p)
      setSelected(defaultFolderSelection(p.folders))
    },
  })
  const start = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/mailboxes/{id}/imports", {
          params: { path: { id: mailboxId } },
          body: {
            source: "imap",
            host: probe?.host ?? host.trim(),
            port: num(probe?.port) ?? Number(port),
            username: username.trim(),
            password,
            folders: selected,
            mode: "full",
          },
        }),
      ),
    onSuccess: (imp) => {
      setPassword("")
      if (imp && "id" in imp) qc.setQueryData(mailImportQuery(mailboxId, imp.id).queryKey, imp)
      qc.invalidateQueries({ queryKey: mailImportsQuery(mailboxId).queryKey })
      s.remember((m) => ({ ...m, started: true }))
      onStarted()
    },
  })

  const connect = (e: FormEvent) => {
    e.preventDefault()
    const errs: Record<string, string> = {}
    if (!/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(host.trim()))
      errs.host = "Type the IMAP server’s host name, like imap.gmail.com."
    const p = Number(port)
    if (!Number.isInteger(p) || p < 1 || p > 65535) errs.port = "A port number, usually 993."
    if (!username.trim()) errs.username = "The account you sign in to the old provider with."
    if (!password) errs.password = "The password or app password for that account."
    setErrors(errs)
    if (Object.keys(errs).length) {
      document
        .getElementById(
          `im-${Object.keys(errs)[0] === "username" ? "user" : Object.keys(errs)[0] === "password" ? "pw" : Object.keys(errs)[0]}`,
        )
        ?.focus()
      return
    }
    probeM.mutate({ host: host.trim(), port: p, username: username.trim(), password })
  }

  useMark("imap", "running", Boolean(probe) || probeM.isPending)
  const gmail = /gmail|googlemail/i.test(host) || /@gmail\.com$/i.test(username)

  if (probe) {
    const count = selectedMessages(probe.folders, selected)
    const skipped = probe.folders.filter((f) => f.skipped).length
    return (
      <StepPanel
        id="imap"
        n={5}
        title="Bring your old mail"
        lede={LEDE}
        endpoint="POST /v1/mailboxes/{id}/imports/probe → POST /v1/mailboxes/{id}/imports (built, HAL-3368)"
        actions={
          <>
            <Gated
              allowed={s.canSetUp && selected.length > 0}
              reason={s.canSetUp ? "Pick at least one folder" : "You can’t import mail"}
              who={s.canSetUp ? "Tick the folders to bring over." : SETUP_WHO}
            >
              <button
                className={`btn btn-primary${start.isPending ? " is-loading" : ""}`}
                type="button"
                onClick={() => start.mutate()}
                disabled={start.isPending}
              >
                {start.isPending ? <span className="spinner" aria-hidden="true" /> : null}
                {start.isPending ? "Starting the import…" : `Copy ${fmtInt(count)} messages`}
              </button>
            </Gated>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => {
                setProbe(null)
                setPassword("")
              }}
            >
              Use another account
            </button>
            <button className="btn btn-ghost" type="button" onClick={onSkip}>
              Skip for now
            </button>
          </>
        }
      >
        <div className="callout callout-ok">
          <Icon name="check-circle" />
          <span>
            <b>Connected to {probe.host}</b> as {username.trim()}. Pick what to bring over; nothing has been
            copied.
          </span>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Folder</th>
                <th className="r">Messages</th>
                <th>Lands in</th>
              </tr>
            </thead>
            <tbody>
              {probe.folders.map((f) => (
                <tr key={f.name} className={f.skipped ? "muted" : undefined}>
                  <td>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={!f.skipped && selected.includes(f.name)}
                        disabled={f.skipped || start.isPending}
                        aria-label={f.skipped ? `${f.name}, skipped` : undefined}
                        onChange={(e) =>
                          setSelected((sel) =>
                            e.target.checked ? [...sel, f.name] : sel.filter((x) => x !== f.name),
                          )
                        }
                      />
                      <span className="mono">{f.name}</span>
                    </label>
                  </td>
                  <td className="r">{f.skipped ? "—" : fmtInt(f.messages)}</td>
                  <td>{f.skipped ? `Skipped: ${f.skipReason ?? "not imported"}` : `→ ${landsIn(f)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="hint">
          <b className="num" style={{ color: "var(--my-fg)" }}>
            {fmtInt(count)}
          </b>{" "}
          messages selected.{" "}
          {skipped
            ? `${skipped} folder${skipped === 1 ? " is" : "s are"} skipped, and each row says why. `
            : ""}
          Duplicates are skipped by Message-ID, so running it twice is safe.
        </p>
        {start.isError ? <ApiErrorCallout error={start.error} what="The import didn’t start." /> : null}
      </StepPanel>
    )
  }

  return (
    <StepPanel
      id="imap"
      n={5}
      title="Bring your old mail"
      lede={LEDE}
      endpoint="POST /v1/mailboxes/{id}/imports/probe (built, HAL-3368)"
    >
      <form className="step-form" onSubmit={connect} noValidate>
        {cancelled ? (
          <div className="callout callout-warn">
            <Icon name="info" />
            <span>The last import was cancelled. What it copied stays; start another to bring the rest.</span>
          </div>
        ) : null}
        <div className="grid-12" style={{ gap: 12 }}>
          <div className="field span-8">
            <label className="label" htmlFor="im-host">
              IMAP server
            </label>
            <input
              className="input mono"
              id="im-host"
              value={host}
              placeholder="imap.gmail.com"
              onChange={(e) => setHost(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={probeM.isPending}
              {...describe(errors.host, "im-host-err")}
            />
            {errors.host ? <FieldError id="im-host-err">{errors.host}</FieldError> : null}
          </div>
          <div className="field span-4">
            <label className="label" htmlFor="im-port">
              Port
            </label>
            <input
              className="input mono"
              id="im-port"
              value={port}
              inputMode="numeric"
              onChange={(e) => setPort(e.target.value)}
              disabled={probeM.isPending}
              {...describe(errors.port, "im-port-err")}
            />
            {errors.port ? <FieldError id="im-port-err">{errors.port}</FieldError> : null}
          </div>
        </div>
        <div className="field">
          <label className="label" htmlFor="im-user">
            Username
          </label>
          <input
            className="input mono"
            id="im-user"
            value={username}
            placeholder="you@gmail.com"
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            spellCheck={false}
            disabled={probeM.isPending}
            {...describe(errors.username, "im-user-err")}
          />
          {errors.username ? <FieldError id="im-user-err">{errors.username}</FieldError> : null}
        </div>
        <div className="field">
          <label className="label" htmlFor="im-pw">
            {gmail ? "App password" : "Password or app password"}
          </label>
          <input
            className="input mono"
            id="im-pw"
            type="password"
            value={password}
            placeholder={gmail ? "16 characters from Google" : ""}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="off"
            disabled={probeM.isPending}
            {...describe(errors.password, "im-pw-err", "im-pw-hint")}
          />
          {errors.password ? <FieldError id="im-pw-err">{errors.password}</FieldError> : null}
          <p className="hint" id="im-pw-hint">
            {gmail
              ? "Gmail needs an app password when 2-Step Verification is on: Google Account → Security → App passwords. "
              : "Many providers need an app password for IMAP. "}
            Listing folders uses it for that one connection only.
          </p>
        </div>
        <div className="field">
          <label className="label" htmlFor="im-into">
            Copy into
          </label>
          <select
            className="select"
            id="im-into"
            value={mailboxId}
            onChange={(e) => onMailbox(e.target.value)}
            disabled={probeM.isPending}
          >
            {mailboxes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.address}
              </option>
            ))}
          </select>
        </div>
        {probeM.isError ? (
          <ApiErrorCallout
            error={probeM.error}
            what={`Couldn’t connect to ${host.trim() || "the server"}.`}
          />
        ) : null}
        <div className="cluster cluster-12" style={{ paddingTop: 4 }}>
          <Gated allowed={s.canSetUp} reason="You can’t import mail" who={SETUP_WHO}>
            <button
              className={`btn btn-primary${probeM.isPending ? " is-loading" : ""}`}
              type="submit"
              disabled={probeM.isPending}
            >
              {probeM.isPending ? <span className="spinner" aria-hidden="true" /> : null}
              {probeM.isPending ? "Connecting…" : "Connect and list folders"}
            </button>
          </Gated>
          <button className="btn btn-ghost" type="button" onClick={onSkip}>
            Skip for now
          </button>
        </div>
      </form>
    </StepPanel>
  )
}

const ACTIVE = new Set(["pending", "running"])

function ImportView({
  mailboxId,
  importId,
  initial,
  onSkip,
  onAnother,
}: {
  mailboxId: string
  importId: string
  initial: MailImport
  onSkip: () => void
  onAnother: () => void
}) {
  const s = useSetup()
  const qc = useQueryClient()
  const key = useMemo(() => mailImportQuery(mailboxId, importId).queryKey, [mailboxId, importId])
  const live = useMailboxLive(
    mailboxId,
    useCallback(
      (f: LiveFrame) => {
        if (f.type !== "import.progress" || f.importId !== importId) return
        qc.setQueryData(key, (old: MailImport | undefined) => {
          if (!old) return old
          const byName = new Map(
            (Array.isArray(f.folders) ? f.folders : []).map((x) => [
              String((x as { name?: unknown }).name),
              x as Partial<MailImport["folders"][number]>,
            ]),
          )
          return {
            ...old,
            status: (f.status as MailImport["status"]) ?? old.status,
            totals: { ...old.totals, ...(f.totals as Partial<MailImport["totals"]>) },
            ratePerMinute: (f.ratePerMinute as number | null) ?? null,
            etaAt: (f.etaAt as number | null) ?? null,
            folders: old.folders.map((fo) => ({ ...fo, ...(byName.get(fo.name) ?? {}) })),
          }
        })
        if (f.status !== "running" && f.status !== "pending") qc.invalidateQueries({ queryKey: key })
      },
      [qc, key, importId],
    ),
  )
  const q = useQuery({
    ...mailImportQuery(mailboxId, importId),
    initialData: initial,
    // The socket moves it live; the poll is the fallback when it isn't open.
    refetchInterval: (query) =>
      query.state.data && ACTIVE.has(query.state.data.status) ? (live === "open" ? 30_000 : 5000) : false,
  })
  const imp = q.data
  const now = useNow(5000, ACTIVE.has(imp.status))
  const [retryPw, setRetryPw] = useState("")
  const [retryErr, setRetryErr] = useState<string | null>(null)

  const act = useMutation({
    mutationFn: async (a: "pause" | "resume" | "cancel" | "retry") => {
      const params = { params: { path: { id: mailboxId, importId } } }
      if (a === "pause") return unwrap(api.POST("/v1/mailboxes/{id}/imports/{importId}/pause", params))
      if (a === "resume") return unwrap(api.POST("/v1/mailboxes/{id}/imports/{importId}/resume", params))
      if (a === "cancel") return unwrap(api.POST("/v1/mailboxes/{id}/imports/{importId}/cancel", params))
      return unwrap(
        api.POST("/v1/mailboxes/{id}/imports/{importId}/retry-failed", {
          ...params,
          body: { password: retryPw },
        }),
      )
    },
    onSuccess: (res, a) => {
      if (a === "retry") setRetryPw("")
      if (res && "id" in res) {
        if (res.id === importId) qc.setQueryData(key, res)
        else qc.setQueryData(mailImportQuery(mailboxId, res.id).queryKey, res)
      }
      qc.invalidateQueries({ queryKey: mailImportsQuery(mailboxId).queryKey })
    },
  })

  const t = imp.totals
  const done = (num(t.imported) ?? 0) + (num(t.duplicates) ?? 0)
  const failedFolders = imp.folders.filter((f) => (num(f.failed) ?? 0) > 0)
  const retryable = imp.folders.reduce((n, f) => n + (num(f.retryable) ?? 0), 0)
  const rate = useMemo(
    () => mailRateLine(imp.ratePerMinute, imp.etaAt, now),
    [imp.ratePerMinute, imp.etaAt, now],
  )
  const endpoint =
    "POST /v1/mailboxes/{id}/imports · GET /v1/mailboxes/{id}/imports/{importId} · ws /v1/mailboxes/{id}/live → import.progress (built, HAL-3368)"
  const next = (
    <button className="btn btn-ghost" type="button" onClick={() => s.goTo(nextAfter(s.steps, "imap"))}>
      <Icon name="arrow-right" />
      Next: contacts
    </button>
  )
  const cancel = (
    <ConfirmButton
      label="Cancel import"
      confirm="Yes, cancel the import"
      hint="What was copied stays."
      busy={act.isPending && act.variables === "cancel"}
      onConfirm={() => act.mutate("cancel")}
    />
  )

  return (
    <StepPanel
      id="imap"
      n={5}
      title="Bring your old mail"
      lede={LEDE}
      endpoint={endpoint}
      actions={
        ACTIVE.has(imp.status) ? (
          <>
            <button
              className="btn btn-secondary"
              type="button"
              data-endpoint="POST /v1/mailboxes/{id}/imports/{importId}/pause"
              onClick={() => act.mutate("pause")}
              disabled={act.isPending}
            >
              <Icon name="pause" />
              Pause
            </button>
            {cancel}
            {next}
          </>
        ) : imp.status === "paused" ? (
          <>
            <button
              className="btn btn-primary"
              type="button"
              data-endpoint="POST /v1/mailboxes/{id}/imports/{importId}/resume"
              onClick={() => act.mutate("resume")}
              disabled={act.isPending}
            >
              <Icon name="play" />
              Resume
            </button>
            {cancel}
            {next}
          </>
        ) : imp.status === "cancelled" ? (
          <>
            <button className="btn btn-primary" type="button" onClick={onAnother}>
              Start another import
            </button>
            {next}
          </>
        ) : imp.status === "failed" ? (
          <>
            {retryable > 0 ? (
              <button
                className={`btn btn-primary${act.isPending ? " is-loading" : ""}`}
                type="button"
                data-endpoint="POST /v1/mailboxes/{id}/imports/{importId}/retry-failed"
                disabled={act.isPending}
                onClick={() => {
                  if (!retryPw) {
                    setRetryErr("The password again: it was wiped when the import ended.")
                    document.getElementById("im-retry-pw")?.focus()
                    return
                  }
                  setRetryErr(null)
                  act.mutate("retry")
                }}
              >
                {act.isPending ? <span className="spinner" aria-hidden="true" /> : <Icon name="refresh" />}
                Retry {fmtInt(retryable)} failed messages
              </button>
            ) : null}
            <button className="btn btn-secondary" type="button" onClick={onAnother}>
              Start another import
            </button>
            <button className="btn btn-ghost" type="button" onClick={onSkip}>
              Skip for now
            </button>
          </>
        ) : (
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => s.goTo(nextAfter(s.steps, "imap"))}
          >
            <Icon name="arrow-right" />
            Next: bring your contacts
          </button>
        )
      }
    >
      {ACTIVE.has(imp.status) ? (
        <div className="callout callout-info" role="status">
          <Icon name="refresh" />
          <span>
            <b>
              {imp.status === "pending" ? "Starting" : "Copying"}: {fmtInt(done)} of {fmtInt(t.source)}.
            </b>{" "}
            {rate ? `${rate}. ` : ""}You can finish setup; it keeps going, and this view updates live.
          </span>
        </div>
      ) : imp.status === "paused" ? (
        <div className="callout callout-warn" role="status">
          <Icon name="pause" />
          <span>
            <b>
              Paused at {fmtInt(done)} of {fmtInt(t.source)}
            </b>
            {num(imp.pausedAt) !== null ? ` since ${fmtUtc(imp.pausedAt)}` : ""}. Resume picks up where it
            stopped. No rate or ETA while paused.
          </span>
        </div>
      ) : imp.status === "complete" ? (
        <div className="callout callout-ok">
          <Icon name="check-circle" />
          <span>
            <b>{imp.accountedFor ? "Every message accounted for." : "The import finished."}</b>{" "}
            {fmtInt(t.imported)} copied, {fmtInt(t.duplicates)} {num(t.duplicates) === 1 ? "was" : "were"}{" "}
            already here{(num(t.failed) ?? 0) > 0 ? `, ${fmtInt(t.failed)} failed` : ""}.
            {imp.credentialsHeld ? "" : " The password has been dropped."}
          </span>
        </div>
      ) : imp.status === "cancelled" ? (
        <div className="callout callout-warn" role="status">
          <Icon name="info" />
          <span>
            <b>
              The import was cancelled at {fmtInt(done)} of {fmtInt(t.source)}.
            </b>{" "}
            What was copied stays. Start another to bring the rest; duplicates are skipped by Message-ID.
          </span>
        </div>
      ) : (
        <>
          <div className="callout callout-error" role="alert">
            <Icon name="x-circle" />
            <span>
              <b>
                {failedFolders.length
                  ? failedFolders.map((f) => `${fmtInt(f.failed)} messages in “${f.name}”`).join(" and ") +
                    " weren’t copied."
                  : "The import stopped."}
              </b>{" "}
              What was copied stays.
              {retryable > 0
                ? " The password was wiped when the import ended, so retrying the failed messages needs it again."
                : ""}
              {imp.error ? (
                <>
                  {" "}
                  The server said: <code className="mono">{imp.error}</code>
                </>
              ) : null}
            </span>
          </div>
          {retryable > 0 ? (
            <div className="field">
              <label className="label" htmlFor="im-retry-pw">
                App password
              </label>
              <input
                className="input mono"
                id="im-retry-pw"
                type="password"
                value={retryPw}
                onChange={(e) => {
                  setRetryPw(e.target.value)
                  setRetryErr(null)
                }}
                autoComplete="off"
                {...describe(retryErr, "im-retry-err", "im-retry-hint")}
              />
              {retryErr ? <FieldError id="im-retry-err">{retryErr}</FieldError> : null}
              <p className="hint" id="im-retry-hint">
                Used for the retry only. Make a new app password if the old one was revoked.
              </p>
            </div>
          ) : null}
        </>
      )}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Folder</th>
              <th>Progress</th>
              <th className="r">Copied</th>
              <th className="r">Duplicates</th>
              <th className="r">Failed</th>
              <th className="r">Total</th>
            </tr>
          </thead>
          <tbody>
            {imp.folders.map((f) => {
              const source = num(f.source) ?? 0
              const failed = num(f.failed) ?? 0
              const moved = (num(f.imported) ?? 0) + (num(f.duplicates) ?? 0)
              const pct = source
                ? Math.min(100, Math.round((moved / source) * 100))
                : imp.status === "complete"
                  ? 100
                  : 0
              const cls =
                failed > 0 && imp.status !== "running"
                  ? "is-fail"
                  : imp.status === "paused"
                    ? "is-paused"
                    : imp.status === "complete"
                      ? "is-done"
                      : ""
              return [
                <tr key={f.name}>
                  <td className="mono">{f.name}</td>
                  <td style={{ width: "30%" }}>
                    <div
                      className={`progress ${cls}`}
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={pct}
                      aria-label={`${f.name} progress`}
                    >
                      <span style={{ width: `${pct}%` }} />
                    </div>
                  </td>
                  <td className="r">{fmtInt(f.imported)}</td>
                  <td className="r">{fmtInt(f.duplicates)}</td>
                  <td
                    className="r"
                    style={failed > 0 ? { color: "var(--red-900)", fontWeight: 600 } : undefined}
                  >
                    {fmtInt(failed)}
                  </td>
                  <td className="r">{fmtInt(source)}</td>
                </tr>,
                failed > 0 && f.lastError ? (
                  <tr key={`${f.name}-err`}>
                    <td colSpan={6} style={{ paddingTop: 0 }}>
                      <p className="t-small" style={{ color: "var(--red-900)" }}>
                        {(num(f.retryable) ?? 0) > 0 ? `${fmtInt(f.retryable)} can be retried. ` : ""}The
                        server said: <code className="mono">{f.lastError}</code>
                      </p>
                    </td>
                  </tr>
                ) : null,
              ]
            })}
          </tbody>
        </table>
      </div>
      {act.isError ? <ApiErrorCallout error={act.error} what="That didn’t go through." /> : null}
    </StepPanel>
  )
}
