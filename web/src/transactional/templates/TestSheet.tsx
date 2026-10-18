/**
 * Send a test (design: template-test, template-test-sent; HANDOFF-ops §23, HAL-3415): one to five recipients,
 * the version (latest draft by default, published, or a number), JSON test data prefilled from the sample
 * values, and an optional From. The result lists each recipient's status, linked to its message in the log.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { type FormEvent, useId, useState } from "react"
import { ApiError, api } from "../../api/client.ts"
import { Sheet } from "../../ops/Overlay.tsx"
import { toast } from "../../ops/toast.tsx"
import { Icon } from "../../ui/icons.tsx"
import { RequestId } from "../../ui/Panel.tsx"
import {
  checkTest,
  type TestErrors,
  type TestForm,
  type TestVersion,
  testBody,
  testStatus,
} from "../logic.ts"
import type { TemplateDetail } from "../queries.ts"

type Sent = { version: number | string; sent: { email: string; messageId: string; status: string }[] }

export function TestSheet({
  t,
  samples,
  used,
  onClose,
  initialTo,
}: {
  t: TemplateDetail
  samples: Record<string, string>
  used: readonly string[]
  onClose: () => void
  initialTo?: string[]
}) {
  const id = useId()
  const qc = useQueryClient()
  const latest = Number(t.latestVersion)
  const published = t.publishedVersion === null ? null : Number(t.publishedVersion)
  const prefill = Object.fromEntries(used.filter((v) => samples[v]).map((v) => [v, samples[v]]))
  const [form, setForm] = useState<TestForm>({
    to: initialTo?.length ? initialTo : [""],
    version: { kind: "latest" },
    data: Object.keys(prefill).length ? JSON.stringify(prefill, null, 2) : "",
    from: "",
  })
  const [numberDraft, setNumberDraft] = useState(String(published ?? latest))
  const [errors, setErrors] = useState<TestErrors>({})
  const [result, setResult] = useState<Sent | null>(null)

  const send = useMutation({
    mutationFn: (body: ReturnType<typeof testBody>) =>
      api
        .POST("/v1/templates/{id}/test", {
          params: { path: { id: t.id } },
          // `data` is free-form JSON; the generated type narrows it to an empty record.
          body: body as never,
        })
        .then((r) => r.data as Sent),
    onSuccess: (r) => {
      setResult(r)
      qc.invalidateQueries({ queryKey: ["messages", "list"] })
      toast({
        title: `${r.sent.length} test${r.sent.length === 1 ? "" : "s"} sent`,
        sub: `Version ${r.version}`,
      })
    },
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const errs = checkTest(form, latest)
    setErrors(errs)
    if (Object.keys(errs).length) return
    send.mutate(testBody(form))
  }

  const setTo = (i: number, v: string) =>
    setForm((f) => ({ ...f, to: f.to.map((x, j) => (j === i ? v : x)) }))
  const filled = form.to.filter((x) => x.trim()).length
  const setVersion = (v: TestVersion) => setForm((f) => ({ ...f, version: v }))
  const apiError = send.error instanceof ApiError ? send.error : null

  if (result) {
    const label =
      published !== null && Number(result.version) === published
        ? "the published version"
        : Number(result.version) === latest && t.hasUnpublishedChanges
          ? "the latest draft"
          : "a past version"
    return (
      <Sheet
        title="Tests sent"
        sub={`POST /v1/templates/${t.id}/test → 200`}
        wide
        onClose={onClose}
        odId="test-sheet"
        foot={
          <>
            <Link className="btn btn-secondary" to="/transactional/messages" search={{ stream: "test" }}>
              View test sends
            </Link>
            <button className="btn btn-primary" type="button" onClick={onClose} data-autofocus="">
              <Icon name="check" />
              Done
            </button>
          </>
        }
      >
        <p>
          Version <b>{String(result.version)}</b> ({label}) went to {result.sent.length} address
          {result.sent.length === 1 ? "" : "es"} as <b>“[Test] {t.latest?.subject ?? t.name}”</b>, on the{" "}
          <span className="mono">test</span> stream.
        </p>
        <table className="rtable" data-od-id="test-sent">
          <thead>
            <tr>
              <th>Recipient</th>
              <th>Status</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            {result.sent.map((s) => {
              const p = testStatus(s.status)
              return (
                <tr key={s.messageId || s.email}>
                  <td className="is-head">
                    <span className="mono">{s.email}</span>
                  </td>
                  <td data-label="Status">
                    <span className={`pill pill-${p.tone}`}>
                      <span className="dot" />
                      {p.label}
                    </span>
                  </td>
                  <td data-label="Message">
                    {s.messageId ? (
                      <Link className="link mono" to="/transactional/messages" search={{ q: s.messageId }}>
                        {s.messageId}
                      </Link>
                    ) : (
                      <span className="muted">Not sent</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <p className="hint">
          Each links to its message in the log, where its delivery trail fills in.
          {result.sent.some((s) => /suppress/i.test(s.status))
            ? " A suppressed address was refused before sending, as a real send would be."
            : ""}{" "}
          None of these count toward usage.
        </p>
      </Sheet>
    )
  }

  return (
    <Sheet
      title={`Send a test of ${t.name}`}
      sub="Needs the send scope."
      wide
      onClose={onClose}
      odId="test-sheet"
      endpoint={`POST /v1/templates/${t.id}/test { to, version, data, from? }`}
      foot={
        <>
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" form={`${id}-f`} disabled={send.isPending}>
            <Icon name="send" />
            {send.isPending ? "Sending…" : `Send ${filled || 1} test${filled > 1 ? "s" : ""}`}
          </button>
        </>
      }
    >
      <form id={`${id}-f`} className="stack stack-16" onSubmit={submit} noValidate>
        <fieldset
          className="field"
          style={{ border: 0, padding: 0, margin: 0 }}
          aria-describedby={`${id}-toh`}
        >
          <legend className="label" style={{ marginBottom: 6 }}>
            Send to <span className="opt">· {filled} of 5</span>
          </legend>
          <div className="stack stack-8">
            {form.to.map((v, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: recipient rows are positional
              <div className="test-to" key={i}>
                <input
                  className="input mono"
                  value={v}
                  onChange={(e) => setTo(i, e.target.value)}
                  aria-label={`Recipient ${i + 1}`}
                  inputMode="email"
                  type="email"
                  autoComplete="email"
                  aria-invalid={errors.to ? true : undefined}
                  {...(i === 0 ? { "data-autofocus": "" } : {})}
                />
                <button
                  className="icon-btn"
                  type="button"
                  aria-label={v ? `Remove ${v}` : `Remove recipient ${i + 1}`}
                  disabled={form.to.length === 1}
                  onClick={() => setForm((f) => ({ ...f, to: f.to.filter((_, j) => j !== i) }))}
                >
                  <Icon name="x" />
                </button>
              </div>
            ))}
          </div>
          {form.to.length < 5 ? (
            <div style={{ marginTop: 8 }}>
              <button
                className="btn btn-ghost btn-sm"
                type="button"
                onClick={() => setForm((f) => ({ ...f, to: [...f.to, ""] }))}
              >
                <Icon name="plus" />
                Add a recipient
              </button>
            </div>
          ) : null}
          <span className={errors.to ? "field-error" : "hint"} id={`${id}-toh`}>
            {errors.to ??
              "One to five addresses. A suppressed address is refused, as it would be for a real send."}
          </span>
        </fieldset>
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }} data-od-id="test-version">
          <legend className="label" style={{ marginBottom: 6 }}>
            Version
          </legend>
          <div className="stack stack-8">
            <label className={`choice${form.version.kind === "latest" ? " is-selected" : ""}`}>
              <input
                className="check"
                type="radio"
                name={`${id}-v`}
                checked={form.version.kind === "latest"}
                onChange={() => setVersion({ kind: "latest" })}
                style={{ appearance: "auto", width: 16, height: 16 }}
              />
              <span>
                <b>Latest {t.hasUnpublishedChanges ? "draft" : "version"}</b> · v{latest}
              </span>
              <span />
              <span className="c-sub">
                {t.hasUnpublishedChanges
                  ? "The default, so you can try a draft before publishing it."
                  : "The same as the published version: there’s no draft."}
              </span>
            </label>
            {published !== null ? (
              <label className={`choice${form.version.kind === "published" ? " is-selected" : ""}`}>
                <input
                  className="check"
                  type="radio"
                  name={`${id}-v`}
                  checked={form.version.kind === "published"}
                  onChange={() => setVersion({ kind: "published" })}
                  style={{ appearance: "auto", width: 16, height: 16 }}
                />
                <span>
                  <b>Published</b> · v{published}
                </span>
                <span />
                <span className="c-sub">What real sends use right now.</span>
              </label>
            ) : null}
            <label className={`choice${form.version.kind === "number" ? " is-selected" : ""}`}>
              <input
                className="check"
                type="radio"
                name={`${id}-v`}
                checked={form.version.kind === "number"}
                onChange={() => setVersion({ kind: "number", n: Number(numberDraft) })}
                style={{ appearance: "auto", width: 16, height: 16 }}
              />
              <span>
                <b>A specific version</b>
              </span>
              <span />
              <span className="c-sub">
                <input
                  className="input num"
                  style={{ width: 96, height: 36 }}
                  type="number"
                  min={1}
                  max={latest}
                  value={numberDraft}
                  aria-label="Version number"
                  aria-invalid={errors.version ? true : undefined}
                  onChange={(e) => {
                    setNumberDraft(e.target.value)
                    setVersion({ kind: "number", n: Number(e.target.value) })
                  }}
                />
              </span>
            </label>
          </div>
          {errors.version ? <span className="field-error">{errors.version}</span> : null}
        </fieldset>
        <div className="field">
          <label className="label" htmlFor={`${id}-data`}>
            Test data <span className="opt">· optional</span>
          </label>
          <textarea
            className="textarea mono"
            id={`${id}-data`}
            rows={5}
            value={form.data}
            onChange={(e) => setForm((f) => ({ ...f, data: e.target.value }))}
            aria-invalid={errors.data ? true : undefined}
            aria-describedby={`${id}-dh`}
            spellCheck={false}
          />
          <span className={errors.data ? "field-error" : "hint"} id={`${id}-dh`}>
            {errors.data ??
              "The variables to fill in, as JSON. Prefilled from the sample data in the editor."}
          </span>
        </div>
        <div className="field">
          <label className="label" htmlFor={`${id}-from`}>
            From <span className="opt">· optional</span>
          </label>
          <input
            className="input mono"
            id={`${id}-from`}
            value={form.from}
            onChange={(e) => setForm((f) => ({ ...f, from: e.target.value }))}
            placeholder="Name <no-reply@your.domain>"
            aria-invalid={errors.from ? true : undefined}
            aria-describedby={`${id}-fh`}
          />
          <span className={errors.from ? "field-error" : "hint"} id={`${id}-fh`}>
            {errors.from ?? "Left empty, it comes from the workspace’s DEFAULT_FROM."}
          </span>
        </div>
        <div className="callout callout-info">
          <Icon name="info" />
          <span>
            The subject gets <b>“[Test] ”</b> in front, the mail goes out on the{" "}
            <span className="mono">test</span> stream, and it <b>doesn’t count</b> toward usage, the
            template’s numbers or the bulk quota.
          </span>
        </div>
        {apiError ? (
          <div className="callout callout-error" role="alert">
            <Icon name="x-circle" />
            <span>
              <b>Not sent.</b> {apiError.message}
            </span>
            {apiError.requestId ? <RequestId id={apiError.requestId} /> : null}
          </div>
        ) : send.isError ? (
          <div className="callout callout-error" role="alert">
            <Icon name="x-circle" />
            <span>
              <b>Not sent.</b> Mailyard couldn’t be reached.
            </span>
          </div>
        ) : null}
      </form>
    </Sheet>
  )
}
