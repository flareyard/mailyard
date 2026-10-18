/**
 * Step 6, bring your contacts · optional (design: first-run/csv-{empty,map,progress,pass,fail}.html, GAPS 4.8–
 * 4.13). The browser reads the file's header, first row and row count, then uploads it as the raw body of
 * `POST /v1/uploads?filename=` while the columns are mapped. `POST /v1/imports/contacts { uploadId, mapping,
 * topicIds, onConflict, defaultStatus, consent }` starts it; `GET /v1/imports/{id}` is polled until it ends.
 * The bar is `bytesRead / size`; cancel is `POST /v1/imports/{id}/cancel`; every row error is in errors.csv.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type DragEvent, type ReactNode, useId, useRef, useState } from "react"
import { ApiError, api, unwrap } from "../../api/client.ts"
import { Gated } from "../../auth/NoPermission.tsx"
import { fmtInt, num } from "../../lib/format.ts"
import { Icon } from "../../ui/icons.tsx"
import {
  contactProgressLine,
  countsSentence,
  ERROR_CODE_LABEL,
  FIELD_TYPE_HINT,
  FIELD_TYPE_LABEL,
  type FieldType,
  fmtBytes,
  fmtUtc,
  guessMapping,
  latest,
  MAX_CSV_BYTES,
  type MappingRow,
  previewCsv,
  progressPct,
  TARGET_LABELS,
  type Target,
  toImportMapping,
  validateMapping,
} from "../logic.ts"
import {
  type ContactImport,
  contactFieldsQuery,
  contactImportQuery,
  contactImportsQuery,
  topicsQuery,
  type Upload,
} from "../queries.ts"
import { SETUP_WHO, useMark, useSetup } from "../setup.tsx"
import { ApiErrorCallout, ConfirmButton, FieldError, StepPanel, useNow } from "../ui.tsx"

const ENDPOINT =
  "POST /v1/uploads?filename= · GET /v1/contact-fields · POST /v1/imports/contacts (built, HAL-3371) · GET /v1/imports/{id} (polled)"
const LEDE =
  "Upload a CSV with a header row and an email column. You map each column to email, name, status or a custom field before anything is added. Anyone who unsubscribed, bounced or complained stays that way."

type Picked = { file: File; headers: string[]; firstRow: string[]; rows: number }

export function CsvStep() {
  const s = useSetup()
  const qc = useQueryClient()
  const imports = useQuery(contactImportsQuery)
  const [picked, setPicked] = useState<Picked | null>(null)
  const [startedId, setStartedId] = useState<string | null>(null)
  const [fresh, setFresh] = useState(false)
  const recent = fresh ? undefined : latest(imports.data)
  const importId = startedId ?? (picked ? null : (recent?.id ?? null))

  const skip = () => {
    s.remember((m) => ({ ...m, skipped: { ...m.skipped, csv: true } }))
    s.goTo("complete")
  }
  const another = () => {
    setPicked(null)
    setStartedId(null)
    setFresh(true)
  }

  if (importId)
    return (
      <ImportView
        id={importId}
        initial={recent?.id === importId ? recent : undefined}
        onAnother={another}
        onSkip={skip}
        onFinish={() => s.goTo("complete")}
      />
    )
  if (picked)
    return (
      <MapAndStart
        picked={picked}
        onAnother={another}
        onStarted={(imp) => {
          qc.setQueryData(contactImportQuery(imp.id).queryKey, imp)
          qc.invalidateQueries({ queryKey: ["imports"], exact: true })
          s.remember((m) => ({ ...m, started: true }))
          setStartedId(imp.id)
          setPicked(null)
          setFresh(false)
        }}
      />
    )
  return <Choose onPicked={setPicked} onSkip={skip} />
}

function Choose({ onPicked, onSkip }: { onPicked: (p: Picked) => void; onSkip: () => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [hover, setHover] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reading, setReading] = useState(false)

  const take = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    if (!/\.csv$/i.test(file.name) && !/csv|plain|excel/.test(file.type))
      return setError(`${file.name} isn’t a CSV. Export the sheet as CSV (UTF-8) first.`)
    if (file.size === 0) return setError(`${file.name} is empty.`)
    if (file.size > MAX_CSV_BYTES)
      return setError(
        `${file.name} is ${fmtBytes(file.size)}; the limit is 50 MiB. Split it into smaller files.`,
      )
    setReading(true)
    try {
      const p = previewCsv(await file.text())
      if ("error" in p) return setError(p.error)
      onPicked({ file, ...p })
    } catch {
      setError(`${file.name} couldn’t be read. Check it’s a UTF-8 text file.`)
    } finally {
      setReading(false)
      if (input.current) input.current.value = ""
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setHover(false)
    void take(e.dataTransfer.files[0])
  }

  return (
    <StepPanel
      id="csv"
      n={6}
      title="Bring your contacts"
      lede={LEDE}
      endpoint={ENDPOINT}
      actions={
        <>
          <button
            className={`btn btn-secondary${reading ? " is-loading" : ""}`}
            type="button"
            onClick={() => input.current?.click()}
            disabled={reading}
          >
            {reading ? <span className="spinner" aria-hidden="true" /> : <Icon name="upload" />}
            {reading ? "Reading the file…" : "Choose a CSV"}
          </button>
          <button className="btn btn-ghost" type="button" onClick={onSkip}>
            Skip and finish
          </button>
        </>
      }
    >
      <label
        className={`dropzone${hover ? " is-hover" : ""}${error ? " is-error" : ""}`}
        htmlFor="csv-file"
        onDragOver={(e) => {
          e.preventDefault()
          setHover(true)
        }}
        onDragLeave={() => setHover(false)}
        onDrop={onDrop}
      >
        <Icon name="csv" />
        <b>Drop a CSV here, or choose a file</b>
        <span className="t-small">
          UTF-8 with a header row, up to 50 MiB. One column must hold email addresses.
        </span>
        <input
          ref={input}
          id="csv-file"
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          onChange={(e) => void take(e.target.files?.[0])}
          {...(error
            ? { "aria-invalid": true, "aria-describedby": "csv-err" }
            : { "aria-describedby": "csv-hint" })}
        />
      </label>
      {error ? <FieldError id="csv-err">{error}</FieldError> : null}
      <p className="hint" id="csv-hint">
        Your browser reads the header row first, so you can map the columns. Then the file uploads to your own
        R2 bucket and the import runs in steps of 5,000 rows.
      </p>
    </StepPanel>
  )
}

function FileCard({
  name,
  size,
  columns,
  rows,
  uploadId,
  pill,
}: {
  name: string
  size: number | null
  columns: number | null
  rows?: number | null
  uploadId?: string | null
  pill: ReactNode
}) {
  return (
    <div className="choice is-selected file-choice">
      <Icon name="csv" />
      <span className="c-name" style={{ overflowWrap: "anywhere" }}>
        {name}
      </span>
      {pill}
      <span className="c-sub">
        {[
          size !== null ? fmtBytes(size) : null,
          columns !== null ? `${columns} columns` : null,
          rows !== null && rows !== undefined ? `${fmtInt(rows)} rows` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        {uploadId ? (
          <>
            {" · "}
            <span className="mono">{uploadId}</span>
          </>
        ) : null}
      </span>
    </div>
  )
}

function MapAndStart({
  picked,
  onAnother,
  onStarted,
}: {
  picked: Picked
  onAnother: () => void
  onStarted: (imp: ContactImport) => void
}) {
  const s = useSetup()
  const ids = useId()
  const fields = useQuery(contactFieldsQuery)
  const topics = useQuery(topicsQuery)
  const types = new Map((fields.data ?? []).map((f) => [f.key, f.type as FieldType]))
  const [rows, setRows] = useState<MappingRow[] | null>(null)
  const mapping =
    rows ??
    (fields.isPending
      ? null
      : guessMapping(
          picked.headers,
          (fields.data ?? []).map((f) => f.key),
        ))
  const [onConflict, setOnConflict] = useState<"update" | "skip">("update")
  const [defaultStatus, setDefaultStatus] = useState<"subscribed" | "unsubscribed">("subscribed")
  const [topicIds, setTopicIds] = useState<string[]>([])
  const [consent, setConsent] = useState(false)
  const [statement, setStatement] = useState("")
  const [serverColumnError, setServerColumnError] = useState<{
    column: string | null
    message: string
  } | null>(null)
  const workspace = s.me?.workspace.name ?? "you"

  const upload = useQuery({
    queryKey: ["upload", picked.file.name, picked.file.size, picked.file.lastModified],
    queryFn: async () =>
      unwrap(
        api.POST("/v1/uploads", {
          params: { query: { filename: picked.file.name } },
          body: picked.file as unknown as string,
          bodySerializer: (b: unknown) => b,
          headers: { "content-type": picked.file.type || "text/csv" },
        }),
      ) as Promise<Upload>,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 30 * 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  })
  const uploaded = upload.data && "id" in upload.data ? upload.data : undefined
  useMark("csv", upload.isError ? "fail" : "running", true)

  const start = useMutation({
    mutationFn: () => {
      const st = statement.trim()
      return unwrap(
        api.POST("/v1/imports/contacts", {
          body: {
            uploadId: uploaded?.id ?? "",
            mapping: toImportMapping(mapping ?? []),
            topicIds,
            onConflict,
            defaultStatus,
            ...(consent ? { consent: { attested: true, ...(st ? { statement: st } : {}) } } : {}),
          },
        }),
      )
    },
    onSuccess: (imp) => {
      if (imp && "id" in imp) onStarted(imp)
    },
    onError: (e) => {
      if (
        e instanceof ApiError &&
        e.status === 400 &&
        typeof e.body.field === "string" &&
        e.body.field.startsWith("mapping")
      )
        setServerColumnError({
          column: e.body.field.startsWith("mapping.") ? e.body.field.slice(8) : null,
          message: e.message,
        })
    },
  })

  const errors = mapping ? validateMapping(mapping) : []
  const general = errors.filter((e) => !e.column)
  const byColumn = new Map(errors.filter((e) => e.column).map((e) => [e.column as string, e.message]))
  if (serverColumnError?.column) byColumn.set(serverColumnError.column, serverColumnError.message)

  const set = (column: string, patch: Partial<MappingRow>) => {
    setServerColumnError(null)
    setRows((mapping ?? []).map((r) => (r.column === column ? { ...r, ...patch } : r)))
  }

  const blocked = !s.canSetUp
    ? { reason: "You can’t import contacts", who: SETUP_WHO }
    : upload.isPending
      ? { reason: "The file is still uploading", who: "Start the import once it says Uploaded." }
      : !uploaded
        ? { reason: "The file didn’t upload", who: "Choose it again, or another file." }
        : errors.length
          ? { reason: "The mapping needs a fix", who: errors[0]?.message }
          : null

  return (
    <StepPanel
      id="csv"
      n={6}
      title="Bring your contacts"
      lede={LEDE}
      endpoint={ENDPOINT}
      actions={
        <>
          <Gated allowed={!blocked} reason={blocked?.reason} who={blocked?.who}>
            <button
              className={`btn btn-primary${start.isPending ? " is-loading" : ""}`}
              type="button"
              onClick={() => start.mutate()}
              disabled={start.isPending}
            >
              {start.isPending ? <span className="spinner" aria-hidden="true" /> : null}
              {start.isPending ? "Starting…" : "Start import"}
            </button>
          </Gated>
          <button className="btn btn-secondary" type="button" onClick={onAnother} disabled={start.isPending}>
            <Icon name="upload" />
            Choose another file
          </button>
        </>
      }
    >
      <FileCard
        name={picked.file.name}
        size={picked.file.size}
        columns={picked.headers.length}
        rows={picked.rows}
        uploadId={uploaded?.id ?? null}
        pill={
          uploaded ? (
            <span className="pill pill-pass">
              <span className="dot" />
              Uploaded
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
          )
        }
      />
      {upload.isError ? (
        <div className="stack stack-8">
          <ApiErrorCallout error={upload.error} what="The file didn’t upload." />
          <div>
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => upload.refetch()}>
              <Icon name="refresh" />
              Upload again
            </button>
          </div>
        </div>
      ) : null}

      <div>
        <h3 className="t-h4" style={{ marginBottom: 4 }}>
          Map the columns
        </h3>
        <p className="hint">
          One column to email. A name comes from one column, or from a first-name and a last-name column
          joined, never both. At most one column to status; up to 50 custom fields. Typed fields come from
          Audience → Fields.
        </p>
        <div className="table-wrap">
          <table className="table" data-od-id="csv-mapping">
            <thead>
              <tr>
                <th>Column · first row</th>
                <th>Becomes</th>
              </tr>
            </thead>
            <tbody>
              {(
                mapping ??
                picked.headers.map((column) => ({ column, target: "ignore" as Target, fieldKey: column }))
              ).map((r, i) => {
                const err = byColumn.get(r.column)
                const errId = `${ids}-err-${i}`
                const type = r.target === "fields" ? (types.get(r.fieldKey.trim()) ?? "string") : null
                const known = r.target === "fields" && types.has(r.fieldKey.trim())
                return (
                  <tr key={r.column}>
                    <td style={{ maxWidth: 200 }}>
                      <span className="mono" style={{ display: "block", overflowWrap: "anywhere" }}>
                        {r.column}
                      </span>
                      <span
                        className="hint"
                        style={{
                          display: "block",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {picked.firstRow[i] ?? ""}
                      </span>
                    </td>
                    <td style={{ width: "55%" }}>
                      <select
                        className="select"
                        style={{ height: 36 }}
                        aria-label={`Map ${r.column} to`}
                        value={r.target}
                        disabled={!mapping || start.isPending}
                        onChange={(e) => set(r.column, { target: e.target.value as Target })}
                        {...(err && r.target !== "fields"
                          ? { "aria-invalid": true, "aria-describedby": errId }
                          : {})}
                      >
                        {(Object.keys(TARGET_LABELS) as Target[]).map((t) => (
                          <option key={t} value={t}>
                            {TARGET_LABELS[t]}
                          </option>
                        ))}
                      </select>
                      {r.target === "fields" ? (
                        <>
                          <div className="cluster" style={{ ["--gap" as string]: "6px", marginTop: 6 }}>
                            <input
                              className="input mono"
                              style={{ height: 32, flex: "1 1 120px" }}
                              value={r.fieldKey}
                              list={`${ids}-fields`}
                              aria-label={`Field for ${r.column}`}
                              onChange={(e) => set(r.column, { fieldKey: e.target.value })}
                              disabled={start.isPending}
                              {...(err ? { "aria-invalid": true, "aria-describedby": errId } : {})}
                            />
                            <span className="pill">{FIELD_TYPE_LABEL[type ?? "string"]}</span>
                          </div>
                          <span className="hint" style={{ display: "block", marginTop: 4 }}>
                            {known
                              ? FIELD_TYPE_HINT[type ?? "string"]
                              : `${FIELD_TYPE_HINT.string} A new field is made as text.`}
                          </span>
                        </>
                      ) : null}
                      {err ? <FieldError id={errId}>{err}</FieldError> : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <datalist id={`${ids}-fields`}>
            {(fields.data ?? []).map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </datalist>
        </div>
        {general.length || (serverColumnError && !serverColumnError.column) ? (
          <div className="callout callout-warn" role="alert" style={{ marginTop: 8 }}>
            <Icon name="warn" />
            <div className="stack stack-4">
              {general.map((e) => (
                <span key={e.message}>{e.message}</span>
              ))}
              {serverColumnError && !serverColumnError.column ? (
                <span>{serverColumnError.message}</span>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }} disabled={start.isPending}>
        <legend className="label" style={{ marginBottom: 6 }}>
          Addresses that are already contacts
        </legend>
        <label className="check">
          <input
            type="radio"
            name="conflict"
            checked={onConflict === "update"}
            onChange={() => setOnConflict("update")}
          />
          <span>
            <b>Update them</b> with the file’s name, fields and status
            <span className="hint" style={{ display: "block" }}>
              Someone who unsubscribed, bounced or complained is never resubscribed.
            </span>
          </span>
        </label>
        <label className="check" style={{ marginTop: 8 }}>
          <input
            type="radio"
            name="conflict"
            checked={onConflict === "skip"}
            onChange={() => setOnConflict("skip")}
          />
          <span>
            <b>Leave them as they are</b>
            <span className="hint" style={{ display: "block" }}>
              Counted as skipped.
            </span>
          </span>
        </label>
      </fieldset>

      <div className="grid-12" style={{ gap: 12 }}>
        <div className="field span-6">
          <label className="label" htmlFor="csv-default">
            Status when a row has none
          </label>
          <select
            className="select"
            id="csv-default"
            value={defaultStatus}
            onChange={(e) => setDefaultStatus(e.target.value as "subscribed" | "unsubscribed")}
            disabled={start.isPending}
          >
            <option value="subscribed">Subscribed</option>
            <option value="unsubscribed">Unsubscribed</option>
          </select>
        </div>
        <div className="field span-6">
          {topics.data?.length ? (
            <fieldset style={{ border: 0, padding: 0, margin: 0 }} disabled={start.isPending}>
              <legend className="label">
                Add them to topics <span className="opt">· optional</span>
              </legend>
              <div className="stack stack-4" style={{ marginTop: 6 }}>
                {topics.data.map((t) => (
                  <label key={t.id} className="check">
                    <input
                      type="checkbox"
                      checked={topicIds.includes(t.id)}
                      onChange={(e) =>
                        setTopicIds((ids) =>
                          e.target.checked ? [...ids, t.id] : ids.filter((x) => x !== t.id),
                        )
                      }
                    />
                    <span>{t.name}</span>
                  </label>
                ))}
              </div>
              <p className="hint">Subscribed rows join them.</p>
            </fieldset>
          ) : (
            <>
              <label className="label" htmlFor="csv-topics">
                Add them to topics <span className="opt">· optional</span>
              </label>
              <select className="select" id="csv-topics" disabled aria-describedby="csv-topics-hint">
                <option>{topics.isPending ? "Loading topics…" : "No topics yet"}</option>
              </select>
              <p className="hint" id="csv-topics-hint">
                Create topics in Audience; subscribed rows join them.
              </p>
            </>
          )}
        </div>
      </div>

      <div className="stack stack-8" data-od-id="csv-consent-form">
        <label className="check">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            disabled={start.isPending}
          />
          <span>
            <b>These people agreed to hear from {workspace}.</b>
            <span className="hint" style={{ display: "block" }}>
              Recorded on the import with your key and the time. Leave it unticked if you can’t say so.
            </span>
          </span>
        </label>
        <div className="field" style={{ paddingLeft: 28 }}>
          <label className="label" htmlFor="csv-statement">
            How they agreed <span className="opt">· optional</span>
          </label>
          <textarea
            className="textarea"
            id="csv-statement"
            rows={2}
            value={statement}
            onChange={(e) => setStatement(e.target.value)}
            disabled={!consent || start.isPending}
            placeholder="Learners who signed up on our site and opted in to course news."
          />
        </div>
      </div>

      {start.isError && !serverColumnError ? (
        <ApiErrorCallout error={start.error} what="The import didn’t start." />
      ) : null}
    </StepPanel>
  )
}

const ACTIVE = new Set(["queued", "running"])

function ImportView({
  id,
  initial,
  onAnother,
  onSkip,
  onFinish,
}: {
  id: string
  initial: ContactImport | undefined
  onAnother: () => void
  onSkip: () => void
  onFinish: () => void
}) {
  const qc = useQueryClient()
  const q = useQuery({
    ...contactImportQuery(id),
    ...(initial ? { initialData: initial } : {}),
    refetchInterval: (query) => (query.state.data && ACTIVE.has(query.state.data.status) ? 2000 : false),
  })
  const imp = q.data && "status" in q.data ? q.data : undefined
  const now = useNow(1000, Boolean(imp && ACTIVE.has(imp.status)))
  const cancel = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/imports/{id}/cancel", { params: { path: { id } } })),
    onSuccess: (res) => {
      if (res && "id" in res) qc.setQueryData(contactImportQuery(id).queryKey, res)
      qc.invalidateQueries({ queryKey: ["imports"], exact: true })
    },
  })

  if (!imp)
    return (
      <StepPanel id="csv" n={6} title="Bring your contacts" lede={LEDE} endpoint={ENDPOINT}>
        {q.isError ? (
          <ApiErrorCallout error={q.error} what="The import didn’t load." />
        ) : (
          <div className="stack stack-8" aria-hidden="true">
            <span className="sk sk-title" />
            <span className="sk sk-bar" />
            <span className="sk sk-text" />
          </div>
        )}
      </StepPanel>
    )

  const size = num(imp.size) ?? num(imp.fileSize)
  const pct = progressPct(imp.bytesRead, size)
  const nothingAdded = (num(imp.created) ?? 0) + (num(imp.updated) ?? 0) === 0
  const pill =
    imp.status === "failed" ? (
      <span className="pill pill-fail">
        <span className="dot" />
        Import failed
      </span>
    ) : imp.status === "cancelled" ? (
      <span className="pill pill-warn">
        <span className="dot" />
        Cancelled
      </span>
    ) : (
      <span className="pill pill-pass">
        <span className="dot" />
        Uploaded
      </span>
    )

  return (
    <StepPanel
      id="csv"
      n={6}
      title="Bring your contacts"
      lede={LEDE}
      endpoint={ENDPOINT}
      actions={
        ACTIVE.has(imp.status) ? (
          <>
            <button className="btn btn-secondary" type="button" onClick={onFinish}>
              Finish setup while it runs
              <Icon name="arrow-right" />
            </button>
            <ConfirmButton
              label="Cancel import"
              confirm="Yes, cancel the import"
              hint="Rows already written stay."
              busy={cancel.isPending}
              onConfirm={() => cancel.mutate()}
            />
          </>
        ) : imp.status === "completed" ? (
          <button className="btn btn-primary" type="button" onClick={onFinish}>
            Finish setup
            <Icon name="arrow-right" />
          </button>
        ) : (
          <>
            <button className="btn btn-primary" type="button" onClick={onAnother}>
              <Icon name="upload" />
              Choose another file
            </button>
            <button
              className="btn btn-ghost"
              type="button"
              onClick={imp.status === "cancelled" && !nothingAdded ? onFinish : onSkip}
            >
              {imp.status === "cancelled" && !nothingAdded ? "Finish setup" : "Skip and finish"}
            </button>
          </>
        )
      }
    >
      <FileCard
        name={imp.fileName ?? "contacts.csv"}
        size={size}
        columns={imp.headers?.length ?? null}
        uploadId={imp.uploadId}
        pill={pill}
      />

      {ACTIVE.has(imp.status) ? (
        <>
          <div className="stack stack-8" data-od-id="csv-progress">
            <div className="spread">
              <span className="t-body">
                <b>
                  {imp.status === "queued" ? "Queued" : "Importing"} {imp.fileName ?? "the file"}
                </b>
                {size !== null ? ` · ${fmtBytes(size)}` : ""}
              </span>
              <span className="t-small num">{pct === null ? "" : `${Math.round(pct)}%`}</span>
            </div>
            <div
              className="progress"
              role="progressbar"
              aria-valuenow={pct === null ? undefined : Math.round(pct)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Share of the file read"
            >
              <span style={{ width: `${pct ?? 0}%` }} />
            </div>
            <p className="hint num" aria-live="polite">
              {contactProgressLine({ ...imp, fileSize: imp.fileSize }, now)}
            </p>
          </div>
          <p className="hint">You can finish setup; the import keeps going.</p>
        </>
      ) : imp.status === "completed" ? (
        <>
          <div className="callout callout-ok">
            <Icon name="check-circle" />
            <span>
              <b>
                {fmtInt(imp.created)} contacts added and {fmtInt(imp.updated)} updated.
              </b>{" "}
              {[
                (num(imp.invalid) ?? 0) > 0 ? `${fmtInt(imp.invalid)} rows couldn’t be imported` : null,
                (num(imp.duplicates) ?? 0) > 0
                  ? `${fmtInt(imp.duplicates)} repeated an address already in the file`
                  : null,
                (num(imp.skipped) ?? 0) > 0
                  ? `${fmtInt(imp.skipped)} were already contacts and left as they were`
                  : null,
              ]
                .filter(Boolean)
                .join(" and ")
                .replace(/^./, (c) => c.toUpperCase())}
              {(num(imp.invalid) ?? 0) + (num(imp.duplicates) ?? 0) + (num(imp.skipped) ?? 0) > 0 ? "." : ""}
            </span>
          </div>
          <p className="hint">
            {[imp.fileName, size !== null ? fmtBytes(size) : null].filter(Boolean).join(" · ")}
            {num(imp.startedAt) !== null ? ` · started ${fmtUtc(imp.startedAt)}` : ""}
            {num(imp.finishedAt) !== null ? `, finished ${fmtUtc(imp.finishedAt)}` : ""}
          </p>
        </>
      ) : imp.status === "failed" ? (
        <div className="callout callout-error" role="alert">
          <Icon name="x-circle" />
          <span>
            <b>
              {(num(imp.processed) ?? 0) === 0
                ? "The import stopped before the first row."
                : `The import stopped after ${fmtInt(imp.processed)} rows.`}
            </b>{" "}
            {imp.error ? <>Mailyard said: “{imp.error}”</> : null}
            {imp.error && /header row/i.test(imp.error) ? (
              <>
                {" "}
                The first line of a contacts CSV has to name the columns, for example{" "}
                <code className="mono">email,full_name</code>.
              </>
            ) : null}
            {nothingAdded ? " Nothing was added." : " Rows already written stay."}
          </span>
        </div>
      ) : (
        <div className="callout callout-warn" role="status">
          <Icon name="info" />
          <span>
            <b>
              The import was cancelled
              {(num(imp.processed) ?? 0) > 0 ? ` after ${fmtInt(imp.processed)} rows` : ""}.
            </b>{" "}
            Rows already written stay.
          </span>
        </div>
      )}

      {imp.status !== "failed" || (num(imp.rows) ?? 0) > 0 ? (
        <>
          <div className="stat-grid" data-od-id="csv-counts">
            {(
              [
                ["Rows", imp.rows],
                ["Created", imp.created],
                ["Updated", imp.updated],
                ["Skipped", imp.skipped],
                ["Invalid", imp.invalid],
                ["Duplicates in file", imp.duplicates],
              ] as const
            ).map(([label, v]) => (
              <div key={label} className="stat">
                <span className="stat-label">{label}</span>
                <span className="t-h3 num">{fmtInt(v)}</span>
              </div>
            ))}
          </div>
          <p className="hint">
            {countsSentence(imp)} Suppressed contacts were already on the suppression list, so they joined
            with no topics.
          </p>
        </>
      ) : null}

      {(num(imp.errorsTotal) ?? imp.errors.length) > 0 ? (
        <RowErrors imp={imp} open={imp.status === "completed"} />
      ) : null}

      {imp.consent ? (
        <div
          className="cluster hint"
          style={{ ["--gap" as string]: "6px", flexWrap: "nowrap", alignItems: "flex-start" }}
          data-od-id="csv-consent"
        >
          <Icon name="check-circle" />
          <span>
            Consent attested by <span className="mono">{imp.consent.attestedBy}</span>
            {num(imp.consent.attestedAt) !== null
              ? `, ${new Date(num(imp.consent.attestedAt) ?? 0).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}, ${fmtUtc(imp.consent.attestedAt)}`
              : ""}
            {imp.consent.statement ? `: “${imp.consent.statement}”` : "."}
          </span>
        </div>
      ) : null}
      {cancel.isError ? <ApiErrorCallout error={cancel.error} what="The import wasn’t cancelled." /> : null}
    </StepPanel>
  )
}

function RowErrors({ imp, open }: { imp: ContactImport; open: boolean }) {
  const total = num(imp.errorsTotal) ?? imp.errors.length
  const shown = imp.errors.slice(0, 5)
  return (
    <details open={open} data-od-id="csv-errors">
      <summary
        className="label"
        style={{ cursor: "pointer", minHeight: 44, display: "flex", alignItems: "center" }}
      >
        Rows that weren’t imported · {fmtInt(total)}
      </summary>
      <ul className="list" aria-label="Rows that weren’t imported">
        {shown.map((e) => (
          <li key={`${e.line}-${e.column}`} className="list-row" style={{ alignItems: "flex-start" }}>
            <span className="grow" style={{ minWidth: 0 }}>
              <span className="cluster" style={{ ["--gap" as string]: "8px" }}>
                <span className="row-title num">Line {fmtInt(e.line)}</span>
                {e.code ? <span className="pill">{ERROR_CODE_LABEL[e.code] ?? e.code}</span> : null}
                {e.column ? (
                  <span className="t-small muted">
                    column <span className="mono">{e.column}</span> · value{" "}
                    {e.value ? (
                      <span className="mono" style={{ overflowWrap: "anywhere" }}>
                        {e.value}
                      </span>
                    ) : (
                      <span className="muted">empty</span>
                    )}
                  </span>
                ) : null}
              </span>
              <span
                className="row-sub"
                style={{ display: "block", marginTop: 2, whiteSpace: "normal", overflow: "visible" }}
              >
                {e.message}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <div className="cluster cluster-12" style={{ marginTop: 8 }}>
        <p className="hint grow">
          {total > shown.length
            ? `Showing the first ${shown.length} here.${total > imp.errors.length ? ` The import keeps the first ${fmtInt(imp.errors.length)} of ${fmtInt(total)}; the CSV has every one.` : " The CSV has every one."}`
            : "The CSV has the same rows, for a spreadsheet."}
        </p>
        <a
          className="btn btn-secondary btn-sm"
          href={`/v1/imports/${encodeURIComponent(imp.id)}/errors.csv`}
          download={`${(imp.fileName ?? "contacts").replace(/\.csv$/i, "")}-errors.csv`}
          data-endpoint="GET /v1/imports/{id}/errors.csv (built, HAL-3371)"
        >
          <Icon name="csv" />
          Download all errors (CSV)
        </a>
      </div>
    </details>
  )
}
