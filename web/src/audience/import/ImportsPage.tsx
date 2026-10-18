/**
 * Audience → Imports (design: import-upload, import-wrong-file, import-mapping, import-mapping-consent;
 * GAPS-audience A5). Choose a CSV: the browser reads its header and first 20 rows, caught here if it isn't a
 * CSV (nothing is sent). While the columns are mapped the file uploads as the raw body of
 * `POST /v1/uploads?filename=`; Start import sends `POST /v1/imports/contacts` and opens the import's page.
 * Past imports list `GET /v1/imports`.
 */
import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { type DragEvent, useId, useMemo, useRef, useState } from "react"
import { ApiError } from "../../api/client.ts"
import { Gated } from "../../auth/NoPermission.tsx"
import { fmtInt, num } from "../../lib/format.ts"
import { Icon } from "../../ui/icons.tsx"
import { AudienceTabs } from "../AudienceHead.tsx"
import { fmtDateTime } from "../kit/format.ts"
import { allTopicsQuery, type ContactField, fieldLabel, fieldsQuery, useKeyName } from "../kit/queries.ts"
import { ApiErrorCallout, EmptyState, PageHead, SkeletonRows, useCan } from "../kit/ui.tsx"
import {
  checkCsvFile,
  type FieldType,
  fieldKeyFor,
  fmtBytes,
  guessMapping,
  importResult,
  type MappingRow,
  previewCsv,
  type SampleRow,
  sampleIssues,
  samplesOf,
  type Target,
  validateMapping,
  wireTarget,
} from "./logic.ts"
import { ImportSteps } from "./parts.tsx"
import { contactImportsQuery, useStartImport, useUpload } from "./queries.ts"

type Picked = { file: File; headers: string[]; rows: number; sample: SampleRow[] }

const EXAMPLE =
  "email,first_name,last_name,plan\nada@example.com,Ada,Okafor,pro\nkemi@example.com,Kemi,Lawal,free\n"

export function ImportsPage() {
  const [picked, setPicked] = useState<Picked | null>(null)
  return (
    <>
      <PageHead
        title="Import contacts"
        sub="Bring contacts in from a CSV: map its columns, choose how existing contacts are handled, and pick their topics."
        actions={
          <a
            className="btn btn-ghost btn-sm"
            href={`data:text/csv;charset=utf-8,${encodeURIComponent(EXAMPLE)}`}
            download="mailyard-contacts-example.csv"
          >
            <Icon name="download" />
            Example CSV
          </a>
        }
      />
      <AudienceTabs current="imports" />
      {picked ? (
        <MapImport picked={picked} onAnother={() => setPicked(null)} />
      ) : (
        <>
          <ImportSteps current={1} />
          <Choose onPicked={setPicked} />
        </>
      )}
    </>
  )
}

function Choose({ onPicked }: { onPicked: (p: Picked) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [hover, setHover] = useState(false)
  const [bad, setBad] = useState<{ name: string; message: string } | null>(null)
  const [reading, setReading] = useState(false)
  const write = useCan("contacts.write", "import contacts")

  const take = async (file: File | undefined) => {
    if (!file) return
    setBad(null)
    const problem = checkCsvFile(file)
    if (problem) return setBad({ name: file.name, message: problem })
    setReading(true)
    try {
      const p = previewCsv(await file.text(), { sample: 20 })
      if ("error" in p) return setBad({ name: file.name, message: p.error })
      onPicked({ file, headers: p.headers, rows: p.rows, sample: p.sample ?? [] })
    } catch {
      setBad({ name: file.name, message: `${file.name} couldn’t be read. Check it’s a UTF-8 text file.` })
    } finally {
      setReading(false)
      if (input.current) input.current.value = ""
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setHover(false)
    if (write.allowed) void take(e.dataTransfer.files[0])
  }

  const workbook = bad && /workbook/.test(bad.message)

  return (
    <div className="grid-12">
      <section
        className="panel span-8 lg-span-12"
        data-endpoint="POST /v1/uploads?filename= → id (upl_…)"
        data-od-id="panel-upload"
        aria-labelledby="h-upload"
      >
        <header className="panel-head">
          <h2 className="panel-title" id="h-upload">
            Choose a CSV
          </h2>
        </header>
        <div className="panel-body stack">
          <label
            className={`dropzone${hover ? " is-hover" : ""}${bad ? " is-error" : ""}`}
            htmlFor="import-file"
            data-od-id="dropzone"
            onDragOver={(e) => {
              e.preventDefault()
              setHover(true)
            }}
            onDragLeave={() => setHover(false)}
            onDrop={onDrop}
          >
            <Icon name={bad ? "x-circle" : "upload"} />
            <b>{bad ? bad.name : reading ? "Reading the file…" : "Drop a CSV here, or choose a file"}</b>
            <span>
              {bad
                ? workbook
                  ? "This is a spreadsheet workbook, not a CSV."
                  : bad.message
                : "UTF-8, comma separated, with a header row, up to 50 MiB. Your browser reads the headers and first rows to map them; nothing is imported until you start it."}
            </span>
            <Gated allowed={write.allowed} reason="You can’t import contacts" who={write.who}>
              <button
                className="btn btn-secondary btn-sm"
                type="button"
                onClick={(e) => {
                  e.preventDefault()
                  input.current?.click()
                }}
              >
                {bad ? "Choose another file" : "Choose file"}
              </button>
            </Gated>
            <input
              ref={input}
              id="import-file"
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              tabIndex={-1}
              disabled={!write.allowed}
              onChange={(e) => void take(e.target.files?.[0])}
            />
          </label>
          {bad ? (
            <div className="callout callout-error" role="alert">
              <Icon name="x-circle" />
              <span>
                <b>{workbook ? "Mailyard reads CSV only." : "This file can’t be imported."}</b>{" "}
                {workbook
                  ? "In Excel or Sheets, use File → Download → CSV, then choose that file. "
                  : `${bad.message} `}
                Your browser caught this before uploading, so nothing was sent and there’s no request id.
              </span>
            </div>
          ) : (
            <ul className="role-list">
              <li>
                <Icon name="check" />
                <span>
                  One row per contact; a column mapped to <code className="mono">email</code> is the only one
                  required.
                </span>
              </li>
              <li>
                <Icon name="check" />
                <span>
                  Other columns become custom fields (<code className="mono">fields.&lt;key&gt;</code>), read
                  as their registered type: number, yes/no or date.
                </span>
              </li>
              <li>
                <Icon name="check" />
                <span>
                  Addresses on the suppression list join as suppressed contacts, so they’re never mailed.
                </span>
              </li>
            </ul>
          )}
        </div>
      </section>
      <aside className="panel span-4 lg-span-12" data-od-id="panel-import-help">
        <header className="panel-head">
          <h2 className="panel-title">Moving from another tool?</h2>
        </header>
        <div className="panel-body stack stack-12">
          <p className="hint">
            Export subscribers as CSV from Mailchimp, ConvertKit, Plunk or Resend, then drop the file here.
          </p>
          <p className="hint">
            Only import people who agreed to hear from you. Bought or scraped lists bounce and complain, and
            Cloudflare counts both against this account.
          </p>
        </div>
      </aside>
      <PastImports />
    </div>
  )
}

function PastImports() {
  const q = useQuery(contactImportsQuery)
  const keyName = useKeyName()
  return (
    <section
      className="panel span-12"
      data-endpoint="GET /v1/imports?cursor=&limit="
      data-od-id="panel-past-imports"
      aria-labelledby="h-past-imports"
      aria-busy={q.isPending}
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-past-imports">
          Past imports
        </h2>
      </header>
      <div className="panel-body">
        {q.isPending ? (
          <SkeletonRows rows={4} cols={6} />
        ) : q.isError ? (
          <ApiErrorCallout error={q.error} what="Past imports didn’t load." />
        ) : !q.data.length ? (
          <EmptyState icon="csv" title="No imports yet">
            Each import you start lands here with its counts and who attested consent.
          </EmptyState>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table dt">
                <thead>
                  <tr>
                    <th>File</th>
                    <th className="r">Rows</th>
                    <th className="r">Created</th>
                    <th className="r">Updated</th>
                    <th className="r">Skipped</th>
                    <th className="r">Duplicates</th>
                    <th className="r">Invalid</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.map((i) => {
                    const r = importResult(i)
                    return (
                      <tr key={i.id}>
                        <td style={{ minWidth: 220 }}>
                          <Link
                            className="cell-link mono-cell"
                            to="/audience/imports/$importId"
                            params={{ importId: i.id }}
                          >
                            {i.fileName ?? i.id}
                          </Link>
                          <span className="cell-sub">
                            {fmtDateTime(i.createdAt)}
                            {num(i.fileSize ?? i.size) !== null ? ` · ${fmtBytes(i.fileSize ?? i.size)}` : ""}{" "}
                            ·{" "}
                            {i.consent ? (
                              `Attested by ${keyName(i.consent.attestedBy)}`
                            ) : (
                              <span className="muted">No attestation</span>
                            )}
                          </span>
                        </td>
                        <td className="r num">{fmtInt(i.rows)}</td>
                        <td className="r num">{fmtInt(i.created)}</td>
                        <td className="r num">{fmtInt(i.updated)}</td>
                        <td className="r num">{fmtInt(i.skipped)}</td>
                        <td className="r num">{fmtInt(i.duplicates)}</td>
                        <td className="r num">{fmtInt(i.invalid)}</td>
                        <td>
                          <span className={`pill ${r.cls}`}>
                            <span className="dot" />
                            {r.label}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <p className="hint" style={{ marginTop: 8 }}>
              Rows = created + updated + skipped + invalid + duplicates; suppressed contacts count inside
              created. A cancelled or failed import keeps the rows it already wrote.
            </p>
          </>
        )}
      </div>
    </section>
  )
}

const NEW_FIELD = "fields.__new"

/** The select's value for a row: a target, `fields.<key>` for a registry field, or the "new field" choice. */
const selectValue = (r: MappingRow, known: Set<string>) =>
  r.target === "fields"
    ? known.has(r.fieldKey.trim())
      ? `fields.${r.fieldKey.trim()}`
      : NEW_FIELD
    : r.target

function MapImport({ picked, onAnother }: { picked: Picked; onAnother: () => void }) {
  const ids = useId()
  const navigate = useNavigate()
  const me = useCan("contacts.write", "import contacts")
  const fields = useQuery(fieldsQuery)
  const topics = useQuery(allTopicsQuery)
  const registry = fields.data ?? []
  const byKey = useMemo(() => new Map(registry.map((f) => [f.key, f])), [registry])
  const known = useMemo(() => new Set(registry.map((f) => f.key)), [registry])
  const [rows, setRows] = useState<MappingRow[] | null>(null)
  const mapping =
    rows ??
    (fields.isPending
      ? null
      : guessMapping(
          picked.headers,
          registry.map((f) => f.key),
          Object.fromEntries(registry.map((f) => [f.key, f.label])),
        ))
  const [onConflict, setOnConflict] = useState<"update" | "skip">("update")
  const [defaultStatus, setDefaultStatus] = useState<"subscribed" | "unsubscribed">("subscribed")
  const [topicIds, setTopicIds] = useState<string[]>([])
  const [consent, setConsent] = useState(false)
  const [statement, setStatement] = useState("")
  const upload = useUpload(picked.file)
  const uploaded = upload.data && "id" in upload.data ? upload.data : undefined
  const start = useStartImport((imp) =>
    navigate({ to: "/audience/imports/$importId", params: { importId: imp.id } }),
  )

  const typeOf = (key: string) => (byKey.get(key)?.type as FieldType | undefined) ?? "string"
  const issues = mapping ? sampleIssues(mapping, picked.sample, typeOf) : new Map<string, string>()
  const errors = mapping ? validateMapping(mapping) : []
  const serverField =
    start.error instanceof ApiError && start.error.status === 400 ? start.error.body.field : null
  const serverColumn =
    typeof serverField === "string" && serverField.startsWith("mapping.") ? serverField.slice(8) : null
  const consentError =
    serverField === "consent.attested" || serverField === "consent" ? start.error?.message : null
  const general = errors.filter((e) => !e.column)
  const byColumn = new Map(errors.filter((e) => e.column).map((e) => [e.column as string, e.message]))
  if (serverColumn && start.error) byColumn.set(serverColumn, start.error.message)

  const set = (column: string, patch: Partial<MappingRow>) => {
    start.reset()
    setRows((mapping ?? []).map((r) => (r.column === column ? { ...r, ...patch } : r)))
  }
  const onSelect = (r: MappingRow, v: string) => {
    if (v === NEW_FIELD) set(r.column, { target: "fields", fieldKey: fieldKeyFor(r.column) })
    else if (v.startsWith("fields.")) set(r.column, { target: "fields", fieldKey: v.slice(7) })
    else set(r.column, { target: v as Target })
  }

  const imported = (mapping ?? []).filter((r) => r.target !== "ignore").length
  const ignored = (mapping ?? []).length - imported
  const blocked = !me.allowed
    ? { reason: "You can’t import contacts", who: me.who }
    : upload.isPending
      ? { reason: "The file is still uploading", who: "Start the import once it says Uploaded." }
      : !uploaded
        ? { reason: "The file didn’t upload", who: "Upload it again, or choose another file." }
        : errors.length
          ? { reason: "The mapping needs a fix", who: errors[0]?.message }
          : null

  const begin = () =>
    start.mutate({
      uploadId: uploaded?.id ?? "",
      mapping: mapping ?? [],
      topicIds,
      onConflict,
      defaultStatus,
      consent: { attested: consent, statement },
    })

  return (
    <>
      <ImportSteps current={2} />
      <div className="spread" style={{ marginBottom: 16 }}>
        <div className="cluster" style={{ minWidth: 0 }}>
          <Icon name="csv" />
          <span className="mono" style={{ overflowWrap: "anywhere" }}>
            {picked.file.name}
          </span>
          <span className="muted">
            · {fmtBytes(picked.file.size)} · {picked.headers.length} columns · {fmtInt(picked.rows)} rows ·
            read in your browser
          </span>
          {uploaded ? (
            <span className="pill pill-pass">
              <span className="dot" />
              Uploaded <span className="mono">{uploaded.id}</span>
            </span>
          ) : upload.isError ? (
            <span className="pill pill-fail">
              <span className="dot" />
              Upload failed
            </span>
          ) : (
            <span className="pill pill-info" role="status">
              <span className="dot" />
              Uploading…
            </span>
          )}
        </div>
        <button className="link-quiet" type="button" onClick={onAnother} style={{ minHeight: 44 }}>
          Choose another file
        </button>
      </div>
      {upload.isError ? (
        <div className="stack stack-8" style={{ marginBottom: 16 }}>
          <ApiErrorCallout error={upload.error} what="The file didn’t upload." />
          <div>
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => upload.refetch()}>
              <Icon name="refresh" />
              Upload again
            </button>
          </div>
        </div>
      ) : null}
      <div className="grid-12">
        <section
          className="panel span-12"
          data-od-id="panel-mapping"
          aria-labelledby="h-map"
          data-endpoint="POST /v1/imports/contacts {mapping}"
        >
          <header className="panel-head">
            <h2 className="panel-title" id="h-map">
              Map columns
            </h2>
            <span className="panel-meta">
              {imported} imported · {ignored} ignored
            </span>
          </header>
          <div className="panel-body stack stack-12">
            {!mapping ? (
              <SkeletonRows rows={picked.headers.length} cols={4} />
            ) : (
              <div className="mapping" data-od-id="column-mapping">
                <div className="map-head">
                  <span>CSV column</span>
                  <span>Sample values</span>
                  <span />
                  <span>Imports as</span>
                  <span>Type</span>
                </div>
                {mapping.map((r, ci) => (
                  <MapRow
                    key={r.column}
                    r={r}
                    ci={ci}
                    picked={picked}
                    registry={registry}
                    byKey={byKey}
                    value={selectValue(r, known)}
                    error={byColumn.get(r.column) ?? null}
                    firstBad={firstBad(issues, ci, picked.sample)}
                    errId={`${ids}-e${ci}`}
                    disabled={start.isPending || !me.allowed}
                    onSelect={(v) => onSelect(r, v)}
                    onKey={(k) => set(r.column, { fieldKey: k })}
                  />
                ))}
              </div>
            )}
            {general.length ? (
              <div className="callout callout-warn" role="alert">
                <Icon name="warn" />
                <div className="stack stack-4">
                  {general.map((e) => (
                    <span key={e.message}>{e.message}</span>
                  ))}
                </div>
              </div>
            ) : null}
            <p className="hint">
              Targets are <code className="mono">email</code>, <code className="mono">name</code> or{" "}
              <code className="mono">name.first</code> + <code className="mono">name.last</code> (joined;
              never both), <code className="mono">status</code>,{" "}
              <code className="mono">fields.&lt;key&gt;</code> and <code className="mono">ignore</code>. A
              field’s type comes from the{" "}
              <Link className="link" to="/audience/fields">
                field registry
              </Link>
              .
            </p>
          </div>
        </section>

        <section className="panel span-12" data-od-id="panel-preview" aria-labelledby="h-prev">
          <header className="panel-head">
            <h2 className="panel-title" id="h-prev">
              First rows
            </h2>
            <span className="panel-meta">
              Read in your browser
              {issues.size ? ` · ${issues.size} cell${issues.size === 1 ? "" : "s"} won’t import` : ""}
            </span>
          </header>
          <div className="panel-body">
            <section
              className="preview-grid"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: the grid scrolls in its own box, so it takes focus to scroll by keyboard
              tabIndex={0}
              aria-label="First rows"
              data-od-id="csv-preview"
            >
              <table>
                <thead>
                  <tr>
                    <th className="rn">Line</th>
                    {picked.headers.map((h) => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {picked.sample.map((s, ri) => (
                    <tr key={s.line}>
                      <td className="rn">{s.line}</td>
                      {picked.headers.map((h, ci) => {
                        const msg = issues.get(`${ri}:${ci}`)
                        return (
                          <td key={h} className={msg ? "is-bad" : undefined} title={msg}>
                            {s.cells[ci] ?? ""}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
        </section>

        <section
          className="panel span-12"
          data-od-id="panel-options"
          aria-labelledby="h-opt"
          data-endpoint="POST /v1/imports/contacts {onConflict, defaultStatus, topicIds, consent}"
        >
          <header className="panel-head">
            <h2 className="panel-title" id="h-opt">
              Options
            </h2>
          </header>
          <div className="panel-body stack stack-24">
            {consentError ? (
              <div className="callout callout-error" role="alert">
                <Icon name="x-circle" />
                <span>
                  <b>Not started.</b> The import was refused on <code className="mono">consent.attested</code>
                  . Tick the attestation, or leave consent out.
                </span>
              </div>
            ) : null}
            <Choices
              legend="When an email is already a contact"
              code="onConflict"
              name={`${ids}-conflict`}
              value={onConflict}
              onChange={setOnConflict}
              disabled={start.isPending}
              options={[
                { value: "update", title: "Update", sub: "Change their fields to what’s in the file." },
                { value: "skip", title: "Skip", sub: "Leave existing contacts exactly as they are." },
              ]}
            />
            <Choices
              legend="New contacts start as"
              code="defaultStatus"
              name={`${ids}-status`}
              value={defaultStatus}
              onChange={setDefaultStatus}
              disabled={start.isPending}
              options={[
                {
                  value: "subscribed",
                  title: "Subscribed",
                  sub: "They can receive campaigns on the topics below.",
                },
                {
                  value: "unsubscribed",
                  title: "Unsubscribed",
                  sub: "Keep them as records only; nothing is sent to them.",
                },
              ]}
            />
            <fieldset
              className="stack stack-8"
              style={{ border: 0, margin: 0, padding: 0 }}
              disabled={start.isPending}
            >
              <legend className="label" style={{ marginBottom: 8 }}>
                Add everyone to topics{" "}
                <span className="opt">
                  optional · <code className="mono">topicIds</code>
                </span>
              </legend>
              {topics.isPending ? (
                <span className="hint">Loading topics…</span>
              ) : (topics.data ?? []).filter((t) => !t.archived).length ? (
                (topics.data ?? [])
                  .filter((t) => !t.archived)
                  .map((t) => (
                    <label key={t.id} className="check">
                      <input
                        type="checkbox"
                        checked={topicIds.includes(t.id)}
                        onChange={(e) =>
                          setTopicIds((v) => (e.target.checked ? [...v, t.id] : v.filter((x) => x !== t.id)))
                        }
                      />
                      <span>
                        {t.name}
                        {t.doubleOptIn ? " · double opt-in: Mailyard emails a confirmation first" : ""}
                      </span>
                    </label>
                  ))
              ) : (
                <span className="hint">
                  No topics yet. <Link to="/audience/topics">Create one</Link>; subscribed rows join the ones
                  you tick.
                </span>
              )}
            </fieldset>
            <div
              className={`stack stack-8${consentError ? " has-error" : ""}`}
              data-od-id="consent-attestation"
              data-endpoint="POST /v1/imports/contacts {consent: {attested: true, statement?}}"
            >
              <label className="check">
                <input
                  type="checkbox"
                  checked={consent}
                  disabled={start.isPending}
                  onChange={(e) => {
                    setConsent(e.target.checked)
                    start.reset()
                  }}
                  {...(consentError ? { "aria-invalid": true, "aria-describedby": `${ids}-consent` } : {})}
                />
                <span>
                  <b>Everyone in this file agreed to receive email from {me.me?.workspace.name ?? "you"}.</b>{" "}
                  Recorded on the import with your key and the time. Don’t import bought or scraped lists.
                </span>
              </label>
              {consentError ? (
                <span className="field-error" id={`${ids}-consent`} role="alert">
                  <Icon name="x-circle" />
                  {consentError} <code className="mono">consent.attested</code>
                </span>
              ) : null}
              <div className="field" style={{ paddingLeft: 28 }}>
                <label className="label" htmlFor={`${ids}-statement`}>
                  How they agreed{" "}
                  <span className="opt">
                    optional · <code className="mono">statement</code>
                  </span>
                </label>
                <textarea
                  className="textarea"
                  id={`${ids}-statement`}
                  rows={2}
                  value={statement}
                  disabled={!consent || start.isPending}
                  onChange={(e) => setStatement(e.target.value)}
                  placeholder="Everyone signed up on our site and agreed to course news."
                />
                <span className="hint">
                  Kept with the import, so past imports can show who attested and when. Leave the box unticked
                  to import without an attestation.
                </span>
              </div>
            </div>
            {start.isError && !consentError && !serverColumn ? (
              <ApiErrorCallout error={start.error} what="The import didn’t start." />
            ) : null}
          </div>
          <footer className="panel-foot">
            <span>Invalid rows are reported with their line, column and value.</span>
            <div className="cluster">
              <button
                className="btn btn-ghost btn-sm"
                type="button"
                onClick={onAnother}
                disabled={start.isPending}
              >
                Back
              </button>
              <Gated allowed={!blocked} reason={blocked?.reason} who={blocked?.who} side="up">
                <button
                  className={`btn btn-primary btn-sm${start.isPending ? " is-loading" : ""}`}
                  type="button"
                  data-od-id="start-import"
                  onClick={begin}
                  disabled={start.isPending}
                >
                  {start.isPending ? <span className="spinner" aria-hidden="true" /> : null}
                  {start.isPending ? "Starting…" : "Start import"}
                </button>
              </Gated>
            </div>
          </footer>
        </section>
      </div>
    </>
  )
}

function firstBad(issues: Map<string, string>, ci: number, sample: readonly SampleRow[]) {
  for (let ri = 0; ri < sample.length; ri++) {
    if (issues.has(`${ri}:${ci}`)) return (sample[ri]?.cells[ci] ?? "").trim()
  }
  return null
}

function MapRow({
  r,
  ci,
  picked,
  registry,
  byKey,
  value,
  error,
  firstBad: bad,
  errId,
  disabled,
  onSelect,
  onKey,
}: {
  r: MappingRow
  ci: number
  picked: Picked
  registry: ContactField[]
  byKey: Map<string, ContactField>
  value: string
  error: string | null
  firstBad: string | null
  errId: string
  disabled: boolean
  onSelect: (v: string) => void
  onKey: (k: string) => void
}) {
  const samples = samplesOf(picked.sample, ci)
  const f = r.target === "fields" ? byKey.get(r.fieldKey.trim()) : undefined
  const type = r.target === "fields" ? (f?.type ?? "string") : null
  const typePill =
    r.target === "email"
      ? "email"
      : r.target === "name.first" || r.target === "name.last"
        ? "joined"
        : r.target === "name"
          ? "name"
          : r.target === "status"
            ? "status"
            : r.target === "ignore"
              ? "Ignored"
              : f
                ? type
                : "new · string"
  return (
    <div className={`map-row${r.target === "ignore" ? " is-skip" : ""}${error ? " is-error" : ""}`}>
      <span className="map-col">{r.column}</span>
      <span className="map-samples" title={samples.join(" · ")}>
        {samples.length ? samples.join(" · ") : <span className="muted">empty in the first rows</span>}
      </span>
      <Icon name="arrow-right" />
      <select
        className="select"
        aria-label={`Map ${r.column} to`}
        value={value}
        disabled={disabled}
        onChange={(e) => onSelect(e.target.value)}
        {...(error ? { "aria-invalid": true, "aria-describedby": errId } : {})}
      >
        <option value="email">Email</option>
        <option value="name">Name (one column)</option>
        <option value="name.first">First name, joined into name</option>
        <option value="name.last">Last name, joined into name</option>
        <option value="status">Status</option>
        {registry.map((x) => (
          <option key={x.key} value={`fields.${x.key}`}>
            Field: {fieldLabel(x, x.key)} · {x.type}
          </option>
        ))}
        <option value={NEW_FIELD}>New field…</option>
        <option value="ignore">Ignore this column</option>
      </select>
      <span
        className={`pill map-type${type && type !== "string" ? " is-typed" : ""}`}
        title={f ? "From the field registry" : undefined}
      >
        {typePill}
      </span>
      {r.target === "fields" && !f ? (
        <span className="cluster" style={{ gridColumn: "1 / -1", ["--gap" as string]: "8px" }}>
          <label className="label" htmlFor={`${errId}-key`} style={{ margin: 0 }}>
            New field key
          </label>
          <input
            id={`${errId}-key`}
            className="input mono"
            style={{ height: 36, flex: "1 1 160px", maxWidth: 320 }}
            value={r.fieldKey}
            disabled={disabled}
            onChange={(e) => onKey(e.target.value)}
            {...(error ? { "aria-invalid": true, "aria-describedby": errId } : {})}
          />
          <span className="hint">
            Registered as text by the first value written; rename and retype it in Fields.
          </span>
        </span>
      ) : null}
      <span className="hint" style={{ gridColumn: "1 / -1" }}>
        Sends <code className="mono">{wireTarget(r)}</code>
      </span>
      {r.target === "name.first" ? (
        <span className="hint map-note" style={{ gridColumn: "1 / -1" }}>
          <Icon name="info" />
          First and last names are joined into one name (“Ada Okafor”). Use them, or a single Name column,
          never both.
        </span>
      ) : null}
      {f && type && type !== "string" ? (
        <span className="hint map-note" style={{ gridColumn: "1 / -1" }}>
          <Icon name="info" />
          <span>
            <code className="mono">{f.key}</code> is a {type} field:{" "}
            {type === "number"
              ? "each cell must be a number; commas are ignored (1,200 reads as 1200)."
              : type === "boolean"
                ? "each cell must be yes/no, true/false, y/n or 1/0."
                : "each cell must be a date: ISO such as 2026-03-11 is safest; it’s stored as ISO."}{" "}
            A cell that isn’t is an <code className="mono">invalid_value</code> row.
          </span>
        </span>
      ) : null}
      {error ? (
        <span className="field-error" id={errId} role="alert" style={{ gridColumn: "1 / -1" }}>
          <Icon name="x-circle" />
          {error}
        </span>
      ) : bad !== null ? (
        <span className="field-error" style={{ gridColumn: "1 / -1" }}>
          <Icon name="x-circle" />
          {bad
            ? `“${bad}” in the first rows won’t fit, so that row will be rejected.`
            : "An empty cell in the first rows has no email, so that row will be rejected."}
        </span>
      ) : null}
    </div>
  )
}

function Choices<V extends string>({
  legend,
  code,
  name,
  value,
  onChange,
  options,
  disabled,
}: {
  legend: string
  code: string
  name: string
  value: V
  onChange: (v: V) => void
  options: { value: V; title: string; sub: string }[]
  disabled?: boolean
}) {
  return (
    <fieldset className="stack stack-8" style={{ border: 0, margin: 0, padding: 0 }} disabled={disabled}>
      <legend className="label" style={{ marginBottom: 8 }}>
        {legend} <code className="mono muted">{code}</code>
      </legend>
      <div className="choices">
        {options.map((o) => (
          <label key={o.value} className={`choice${value === o.value ? " is-selected" : ""}`}>
            <input
              type="radio"
              name={name}
              className="sr-only"
              checked={value === o.value}
              onChange={() => onChange(o.value)}
            />
            <span className={`status-icon${value === o.value ? "" : " status-idle"}`}>
              <Icon name={value === o.value ? "check-circle" : "circle"} />
            </span>
            <span className="strong">{o.title}</span>
            <span />
            <span className="c-sub">{o.sub}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}
