/**
 * One import (design: import-progress, import-cancel, import-cancelled, import-done, import-row-errors,
 * import-error; GAPS-audience A5). `GET /v1/imports/{id}` is polled every 2 s while it's queued or running: the
 * bar is `bytesRead / size`, exact from the first second, with rows, rate, ETA and the start under it. Cancel
 * (`POST /v1/imports/{id}/cancel`, owners, admins and senders) keeps the rows already in. The report writes the
 * counts' arithmetic out, lists the first 100 row errors and downloads every one from `errors.csv`.
 */
import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { Gated } from "../../auth/NoPermission.tsx"
import { fmtAgo, fmtInt, num } from "../../lib/format.ts"
import { Icon } from "../../ui/icons.tsx"
import { AudienceTabs } from "../AudienceHead.tsx"
import { AlertRef } from "../kit/AlertRef.tsx"
import { allTopicsQuery, useKeyName } from "../kit/queries.ts"
import { ApiErrorCallout, CopyButton, PageHead, Sheet, useCan, useNow } from "../kit/ui.tsx"
import { fmtBytes, fmtLeft, fmtUtc, importStep, isActiveImport, progressPct } from "./logic.ts"
import { ImportSteps, ImportTiles, RowErrorsPanel } from "./parts.tsx"
import { type ContactImport, useCancelImport, useContactImport } from "./queries.ts"

export function ImportPage({ id, cancelOpen }: { id: string; cancelOpen: boolean }) {
  const q = useContactImport(id)
  const imp = q.data && "status" in q.data ? q.data : undefined
  return (
    <>
      <PageHead
        title="Import contacts"
        sub="Bring contacts in from a CSV: map its columns, choose how existing contacts are handled, and pick their topics."
      />
      <AudienceTabs current="imports" />
      {!imp ? (
        <>
          <ImportSteps current={4} />
          <section className="panel" aria-busy={q.isPending} data-endpoint={`GET /v1/imports/${id}`}>
            <div className="panel-body">
              {q.isError ? (
                <ApiErrorCallout error={q.error} what="This import didn’t load." />
              ) : (
                <div className="stack stack-12" aria-hidden="true">
                  <span className="sk sk-title" />
                  <span className="sk sk-bar" />
                  <span className="sk sk-text" />
                  <span className="sk sk-text" style={{ width: "60%" }} />
                </div>
              )}
            </div>
          </section>
        </>
      ) : (
        <>
          <ImportSteps current={importStep(imp.status)} fail={imp.status === "failed"} />
          <ImportBody imp={imp} cancelOpen={cancelOpen} onRetry={() => q.refetch()} />
        </>
      )}
    </>
  )
}

function ImportBody({
  imp,
  cancelOpen,
  onRetry,
}: {
  imp: ContactImport
  cancelOpen: boolean
  onRetry: () => void
}) {
  const navigate = useNavigate()
  const setCancel = (open: boolean) =>
    navigate({
      to: "/audience/imports/$importId",
      params: { importId: imp.id },
      search: open ? { cancel: 1 } : {},
      replace: true,
    })
  if (isActiveImport(imp.status))
    return (
      <>
        <Progress imp={imp} onCancel={() => setCancel(true)} />
        {cancelOpen ? <CancelSheet imp={imp} onClose={() => setCancel(false)} /> : null}
      </>
    )
  const errors = (num(imp.errorsTotal) ?? imp.errors.length) > 0
  if (imp.status === "failed")
    return (
      <div className="stack">
        <Failed imp={imp} onRetry={onRetry} />
        <AlertRef kind="import_failed" subjectId={imp.id} />
        {errors ? <RowErrorsPanel imp={imp} /> : null}
      </div>
    )
  const invalid = num(imp.invalid) ?? 0
  return (
    <div className="stack">
      {imp.status === "cancelled" ? (
        <div className="callout callout-info" role="status" data-od-id="import-cancelled">
          <Icon name="info" />
          <span>
            <b>Cancelled {fmtAgo(imp.finishedAt)}.</b> {fmtInt(imp.processed)} rows were in before it stopped,
            and they stay: {fmtInt(imp.created)} contacts were created and {fmtInt(imp.updated)} updated. The
            rest of <span className="mono">{imp.fileName ?? "the file"}</span> wasn’t read. Import the file
            again to finish: matching is by email, so nothing is duplicated.
          </span>
        </div>
      ) : invalid > 0 ? (
        <div className="callout callout-warn">
          <Icon name="warn" />
          <span>
            <b>Imported with {fmtInt(invalid)} invalid rows left out.</b>{" "}
            {fmtInt((num(imp.created) ?? 0) + (num(imp.updated) ?? 0))} contacts are in
            {(num(imp.duplicates) ?? 0) > 0
              ? `; ${fmtInt(imp.duplicates)} repeated rows were merged into them`
              : ""}
            . Fix the rows below in your file and import it again; matching is by email, so re-importing is
            safe.
          </span>
        </div>
      ) : (
        <CompletedCallout imp={imp} />
      )}
      {imp.status === "completed" && errors ? <RowErrorsPanel imp={imp} /> : null}
      <Report imp={imp} />
      {imp.status === "cancelled" && errors ? <RowErrorsPanel imp={imp} /> : null}
    </div>
  )
}

function CompletedCallout({ imp }: { imp: ContactImport }) {
  const topics = useQuery(allTopicsQuery).data ?? []
  const names = imp.topicIds.map((t) => topics.find((x) => x.id === t)?.name ?? t)
  return (
    <div className="callout callout-ok">
      <Icon name="check-circle" />
      <span>
        <b>All {fmtInt(imp.rows)} rows imported.</b> {fmtInt(imp.created)} new contacts and{" "}
        {fmtInt(imp.updated)} updated{names.length ? `, each added to ${names.join(", ")}` : ""}.
      </span>
    </div>
  )
}

function Progress({ imp, onCancel }: { imp: ContactImport; onCancel: () => void }) {
  const now = useNow(1000, true)
  const write = useCan("contacts.write", "cancel an import")
  const size = num(imp.size) ?? num(imp.fileSize)
  const pct = progressPct(imp.bytesRead, size)
  const left = fmtLeft(imp.etaAt, now)
  return (
    <section
      className="panel"
      data-endpoint={`GET /v1/imports/${imp.id} → bytesRead, size, processed, ratePerMinute, etaAt, startedAt`}
      data-od-id="panel-import-progress"
      aria-labelledby="h-import-progress"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-import-progress">
          {imp.status === "queued" ? "Queued" : "Importing"}{" "}
          <span className="mono">{imp.fileName ?? imp.id}</span>
        </h2>
        <span className="panel-meta">Polling every 2 s</span>
      </header>
      <div className="panel-body">
        <div className="stack stack-16">
          <div className="bigprog">
            <div className="bp-top">
              <span>
                <span className="bp-n">{pct === null ? "—" : `${Math.round(pct)}%`}</span>{" "}
                <span className="bp-of">
                  of {fmtBytes(size)} read · {fmtInt(imp.processed)} rows so far
                </span>
              </span>
              <span className="muted">
                <span className={`pill ${imp.status === "queued" ? "pill-neutral" : "pill-info"}`}>
                  <span className="dot" />
                  {imp.status === "queued" ? "Queued" : "Running"}
                </span>{" "}
                {num(imp.startedAt) !== null ? `started ${fmtAgo(imp.startedAt, now)}` : "waiting to start"}
              </span>
            </div>
            <div
              className="progress"
              role="progressbar"
              aria-valuenow={num(imp.bytesRead) ?? 0}
              aria-valuemin={0}
              aria-valuemax={size ?? undefined}
              aria-label="File read"
            >
              <span style={{ width: `${pct ?? 0}%` }} />
            </div>
            <div className="imp-rate" aria-live="polite">
              <span>
                <b>{num(imp.ratePerMinute) === null ? "—" : fmtInt(imp.ratePerMinute)}</b> rows a minute
              </span>
              {left ? (
                <span>
                  {left.replace(/^about/, "About")}
                  {num(imp.etaAt) !== null ? ` · ETA ${fmtUtc(imp.etaAt)}` : ""}
                </span>
              ) : null}
              <span>
                {fmtBytes(imp.bytesRead)} of {fmtBytes(size)}
              </span>
            </div>
            <span className="hint">
              The bar follows bytes read (<code className="mono">bytesRead / size</code>), which is exact from
              the first second; the row count isn’t known until the end.
            </span>
          </div>
          <ImportTiles imp={imp} running />
          <p className="hint">
            You can leave this page; the import keeps going. It checks every 2 seconds until it’s completed,
            failed or cancelled.
          </p>
        </div>
      </div>
      <footer className="panel-foot">
        <span>Rows already in stay if you cancel.</span>
        <Gated allowed={write.allowed} reason="You can’t cancel imports" who={write.who} side="right">
          <button
            className="btn btn-secondary btn-sm"
            type="button"
            onClick={onCancel}
            data-od-id="cancel-import"
          >
            <Icon name="x" />
            Cancel import
          </button>
        </Gated>
      </footer>
    </section>
  )
}

function CancelSheet({ imp, onClose }: { imp: ContactImport; onClose: () => void }) {
  const cancel = useCancelImport(imp.id)
  return (
    <Sheet
      title="Cancel this import?"
      sub={
        <>
          <span className="mono">{imp.fileName ?? imp.id}</span> · {fmtInt(imp.processed)} rows in so far
        </>
      }
      onClose={onClose}
      odId="cancel-import-sheet"
      endpoint={`POST /v1/imports/${imp.id}/cancel`}
      footer={
        <>
          <button className="btn btn-ghost" type="button" onClick={onClose}>
            Keep importing
          </button>
          <button
            className={`btn btn-danger${cancel.isPending ? " is-loading" : ""}`}
            type="button"
            onClick={() => cancel.mutate(undefined, { onSuccess: onClose })}
          >
            {cancel.isPending ? <span className="spinner" aria-hidden="true" /> : null}
            Cancel import
          </button>
        </>
      }
    >
      <ul className="role-list">
        <li>
          <Icon name="check" />
          <span>
            <b>Rows already imported stay.</b> The {fmtInt(imp.created)} created and {fmtInt(imp.updated)}{" "}
            updated contacts aren’t removed or rolled back.
          </span>
        </li>
        <li>
          <Icon name="info" />
          <span>
            The rest of the file isn’t read. To bring it in later, import the file again: matching is by
            email, so rows already in are updated, not duplicated.
          </span>
        </li>
        <li>
          <Icon name="info" />
          <span>Only owners, admins and senders can cancel, and only while it’s queued or running.</span>
        </li>
      </ul>
      {cancel.isError ? <ApiErrorCallout error={cancel.error} what="The import wasn’t cancelled." /> : null}
    </Sheet>
  )
}

function Failed({ imp, onRetry }: { imp: ContactImport; onRetry: () => void }) {
  const rows = num(imp.processed) ?? 0
  const size = num(imp.size) ?? num(imp.fileSize)
  return (
    <section
      className="panel"
      data-endpoint={`GET /v1/imports/${imp.id}`}
      data-od-id="panel-import-failed"
      aria-labelledby="h-import-failed"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-import-failed">
          Import <span className="mono">{imp.fileName ?? imp.id}</span>
        </h2>
      </header>
      <div className="panel-body">
        <div className="error-block" role="alert" data-od-id="error-block">
          <h3>
            <Icon name="warn" />
            {rows === 0 ? "The import stopped before the first row" : "The import stopped partway"}
          </h3>
          <p>
            The import answered <b>status: failed</b>.
            {imp.error ? (
              <>
                {" "}
                Its <code className="mono">error</code> says: <b>{imp.error}</b>
              </>
            ) : null}{" "}
            {rows > 0 ? (
              <>
                <b>{fmtInt(rows)} rows are already in, and they stay.</b> Fix the file and import it again:
                matching is by email, so rows already in are updated, not duplicated.
              </>
            ) : (
              "Nothing was added."
            )}
          </p>
          <div className="cluster">
            <button className="btn btn-secondary btn-sm" type="button" onClick={onRetry} data-od-id="retry">
              <Icon name="refresh" />
              Retry
            </button>
            <span className="req-id">
              Import id <code className="mono">{imp.id}</code>
              <CopyButton value={imp.id} label="Copy import id" />
            </span>
          </div>
        </div>
        {rows > 0 ? (
          <div style={{ marginTop: 16 }}>
            <ImportTiles imp={imp} />
          </div>
        ) : null}
      </div>
      <footer className="panel-foot">
        <span>
          {fmtBytes(imp.bytesRead)} of {fmtBytes(size)} read before it stopped
        </span>
        <Link className="btn btn-secondary btn-sm" to="/audience/imports">
          Choose a fixed file
        </Link>
      </footer>
    </section>
  )
}

function Report({ imp }: { imp: ContactImport }) {
  const keyName = useKeyName()
  const topics = useQuery(allTopicsQuery).data ?? []
  const size = num(imp.size) ?? num(imp.fileSize)
  const mapped = Object.values(imp.mapping).filter((t) => t !== "ignore").length
  const columns = imp.headers?.length ?? Object.keys(imp.mapping).length
  const done = imp.status === "completed"
  return (
    <section
      className="panel"
      data-endpoint={`GET /v1/imports/${imp.id}`}
      data-od-id="panel-import-report"
      aria-labelledby="h-import-report"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-import-report">
          Report · <span className="mono">{imp.fileName ?? imp.id}</span>
        </h2>
        <div className="cluster">
          {done ? (
            <Gated
              allowed={false}
              reason="A completed import can’t be cancelled."
              who="Cancel is for queued and running imports; the rows are in."
              side="right"
            >
              <button className="btn btn-ghost btn-sm" type="button" data-od-id="cancel-import">
                <Icon name="x" />
                Cancel import
              </button>
            </Gated>
          ) : null}
        </div>
      </header>
      <div className="panel-body">
        <div className="stack">
          <ImportTiles imp={imp} />
          {done ? (
            <>
              <div className="divider" />
              <dl className="kv">
                <dt>Columns</dt>
                <dd>
                  {mapped} of {columns} mapped
                </dd>
                <dt>Existing contacts</dt>
                <dd>
                  {imp.onConflict === "update" ? "Updated from the file" : "Left as they were"}{" "}
                  <code className="mono">onConflict: {imp.onConflict}</code>
                </dd>
                <dt>New contacts</dt>
                <dd>
                  {imp.defaultStatus === "subscribed" ? "Subscribed" : "Unsubscribed"}{" "}
                  <code className="mono">defaultStatus</code>
                </dd>
                <dt>Topics</dt>
                <dd>
                  {imp.topicIds.length ? (
                    imp.topicIds.map((t) => topics.find((x) => x.id === t)?.name ?? t).join(", ")
                  ) : (
                    <span className="muted">None</span>
                  )}
                </dd>
                <dt>File</dt>
                <dd>
                  <span className="mono">{imp.fileName ?? "—"}</span> · {fmtBytes(size)}{" "}
                  <code className="mono muted">{imp.uploadId}</code>
                </dd>
                <dt>Consent</dt>
                <dd>
                  {imp.consent ? (
                    <>
                      Attested by {keyName(imp.consent.attestedBy)} {fmtAgo(imp.consent.attestedAt)}
                      {imp.consent.statement ? (
                        <span className="cell-sub">“{imp.consent.statement}”</span>
                      ) : null}
                    </>
                  ) : (
                    <span className="muted">No attestation</span>
                  )}
                </dd>
              </dl>
            </>
          ) : null}
        </div>
      </div>
      <footer className="panel-foot">
        {done ? (
          <>
            <span>
              Finished {fmtAgo(imp.finishedAt)} · {fmtBytes(size)}
            </span>
            <Link className="btn btn-secondary btn-sm" to="/audience/contacts">
              See the contacts
            </Link>
          </>
        ) : (
          <>
            <span>
              {fmtBytes(imp.bytesRead)} of {fmtBytes(size)} read
            </span>
            <Link className="btn btn-secondary btn-sm" to="/audience/imports">
              Import the file again
            </Link>
          </>
        )}
      </footer>
    </section>
  )
}
