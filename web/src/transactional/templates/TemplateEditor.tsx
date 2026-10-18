/**
 * The template editor (design: template-editor, template-missing-variables, template-publish, template-test*;
 * HANDOFF-ops §23). Edits save themselves as the draft (`PUT /v1/templates/{id}/draft`); the preview renders the
 * draft with your sample values as you type (`POST /v1/templates/preview`). Publishing makes the draft what
 * every send uses; "Send a test" mails it to up to five people on the test stream.
 *
 * Writing needs the admin scope and testing the send scope (src/http/templateHandlers.ts); without them the
 * source is read-only and the buttons say why.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { ApiError, api, unwrap } from "../../api/client.ts"
import { Gated } from "../../auth/NoPermission.tsx"
import { useMe } from "../../auth/session.ts"
import { fmtBytes } from "../../ops/format.ts"
import { SampleMarker, Time } from "../../ops/kit.tsx"
import { hasScope } from "../../ops/roles.ts"
import { usePageTitle } from "../../shell/title.tsx"
import { Icon } from "../../ui/icons.tsx"
import { PanelError, PanelSkeleton } from "../../ui/Panel.tsx"
import { Crumbs } from "../Layout.tsx"
import { actorName, andList, missingVars, SIZE_LIMIT, sampleData, variablesIn } from "../logic.ts"
import { type TemplateDetail, templateQuery, useKeyNames } from "../queries.ts"
import { type Device, DeviceFrame, DeviceToggle } from "./Preview.tsx"
import { PublishSheet } from "./PublishSheet.tsx"
import { SourceEditor } from "./SourceEditor.tsx"
import { readSamples, writeSamples } from "./samples.ts"
import { TestSheet } from "./TestSheet.tsx"

const route = getRouteApi("/_app/transactional/templates/$id/")

export function TemplateEditor() {
  const { id } = route.useParams()
  const q = useQuery(templateQuery(id))
  if (q.isPending)
    return (
      <>
        <EditorHead name={null} />
        <div className="editor">
          <div className="editor-pane">
            <section className="panel">
              <div className="panel-body">
                <PanelSkeleton rows={8} />
              </div>
            </section>
          </div>
          <div className="editor-pane">
            <section className="panel">
              <div className="panel-body">
                <PanelSkeleton rows={6} />
              </div>
            </section>
          </div>
        </div>
      </>
    )
  if (q.isError)
    return (
      <>
        <EditorHead name={id} />
        <section className="panel is-error">
          <div className="panel-body">
            <PanelError error={q.error} onRetry={() => q.refetch()} what="This template didn’t load" />
          </div>
        </section>
      </>
    )
  return <Editor key={id} t={q.data} />
}

function EditorHead({ name, sub, actions }: { name: string | null; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head" data-od-id="page-head">
      <div style={{ minWidth: 0 }}>
        <Crumbs
          items={[
            { to: "/transactional/messages", label: "Transactional" },
            { to: "/transactional/templates", label: "Templates" },
          ]}
        />
        <h1 data-od-id="page-title">
          {name ? (
            <span
              className="mono"
              style={{ font: "inherit", fontFamily: "var(--font-mono)", fontWeight: 400 }}
            >
              {name}
            </span>
          ) : (
            <span className="sk sk-title" style={{ width: 200, display: "inline-block" }} />
          )}
        </h1>
        {sub ? <p className="sub">{sub}</p> : null}
      </div>
      <div className="cluster cluster-12">
        <SampleMarker />
        {actions}
      </div>
    </div>
  )
}

type SaveState = "saved" | "dirty" | "saving" | "error"

function Editor({ t }: { t: TemplateDetail }) {
  const me = useMe()
  const keys = useKeyNames()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const search = route.useSearch()
  usePageTitle(t.name)
  const canWrite = hasScope(me.data, "admin")
  const canSend = hasScope(me.data, "send")

  const [subject, setSubject] = useState(t.latest?.subject ?? "")
  const [source, setSource] = useState(t.latest?.source ?? "")
  const [text, setText] = useState(t.latest?.text ?? "")
  const [samples, setSamples] = useState<Record<string, string>>(() => readSamples(t.id))
  const saved = useRef({
    subject: t.latest?.subject ?? "",
    source: t.latest?.source ?? "",
    text: t.latest?.text ?? "",
  })
  const dirty =
    subject !== saved.current.subject || source !== saved.current.source || text !== saved.current.text
  const [state, setState] = useState<SaveState>("saved")

  const save = useMutation({
    mutationFn: (body: { subject: string; source: string; text: string }) =>
      unwrap(
        api.PUT("/v1/templates/{id}/draft", {
          params: { path: { id: t.id } },
          body: { subject: body.subject, source: body.source, text: body.text.trim() ? body.text : null },
        }),
      ),
    onMutate: () => setState("saving"),
    onSuccess: (data, body) => {
      saved.current = body
      if (data) qc.setQueryData(templateQuery(t.id).queryKey, data)
      qc.invalidateQueries({ queryKey: ["templates", "list"] })
      setState("saved")
    },
    onError: () => setState("error"),
  })

  // Edits save themselves a moment after you stop typing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the mutation object changes every render; the timer re-arms on edits only
  useEffect(() => {
    if (!dirty || !canWrite) return
    setState("dirty")
    const h = setTimeout(() => save.mutate({ subject, source, text }), 1200)
    return () => clearTimeout(h)
  }, [subject, source, text, dirty, canWrite])

  // The live preview: the draft as it is on screen, with the sample values. Debounced, keeps the last render.
  const [debounced, setDebounced] = useState({ subject, source, text, samples })
  useEffect(() => {
    const h = setTimeout(() => setDebounced({ subject, source, text, samples }), 350)
    return () => clearTimeout(h)
  }, [subject, source, text, samples])
  const data = sampleData(debounced.samples)
  const preview = useQuery({
    queryKey: ["templates", t.id, "preview", debounced.subject, debounced.source, debounced.text, data],
    queryFn: () =>
      unwrap(
        api.POST("/v1/templates/preview", {
          body: {
            kind: t.kind,
            subject: debounced.subject,
            source: debounced.source,
            text: debounced.text.trim() ? debounced.text : null,
            data: data as Record<string, never>,
          },
        }),
      ),
    placeholderData: keepPreviousData,
    retry: false,
  })

  const used = preview.data?.variables.used ?? t.latest?.variables.used ?? variablesIn(source)
  const required = preview.data?.variables.required ?? t.latest?.variables.required ?? []
  const missing = preview.data?.variables.missing ?? missingVars(required, samples)
  const published = t.publishedVersion === null ? null : Number(t.publishedVersion)
  const latest = Number(t.latestVersion)
  const hasDraft = t.hasUnpublishedChanges || dirty
  const draftVersion = t.hasUnpublishedChanges || published === null ? latest : latest + 1

  const setSearch = (next: typeof search) =>
    navigate({ to: "/transactional/templates/$id", params: { id: t.id }, search: next, replace: true })
  const setDevice = (d: Device) => {
    const { device: _, ...rest } = search
    setSearch(d === "desktop" ? rest : { ...rest, device: d })
  }
  const setSheet = (k: "test" | "publish", open: boolean) => {
    const { [k]: _, ...rest } = search
    setSearch(open ? { ...rest, [k]: 1 as const } : rest)
  }
  const device: Device = search.device ?? "desktop"

  const savedBy = actorName(t.latest?.updatedBy, keys)
  const sub = (
    <>
      {t.kind === "html" ? "Code template" : "Blocks template"} ·{" "}
      {published ? `v${published} is live` : "Not published yet"}
      {t.hasUnpublishedChanges ? (
        <>
          {" "}
          · <b style={{ color: "var(--my-fg)" }}>draft v{latest}</b> has unpublished changes
        </>
      ) : null}
    </>
  )

  return (
    <>
      <EditorHead
        name={t.name}
        sub={sub}
        actions={
          <>
            <Link className="btn btn-ghost" to="/transactional/templates/$id/versions" params={{ id: t.id }}>
              <Icon name="history" />
              Versions
            </Link>
            <Gated
              allowed={canSend}
              reason="This key can’t send"
              who={`Test sends need the send scope.${me.data?.key ? ` The key you’re signed in with, ${me.data.key.name}, has ${andList(me.data.scopes) || "no scopes"}.` : ""} Sign in with a key that has send.`}
              side="right"
            >
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => setSheet("test", true)}
                data-endpoint={`POST /v1/templates/${t.id}/test`}
              >
                <Icon name="send" />
                Send a test
              </button>
            </Gated>
            <Gated
              allowed={canWrite && hasDraft}
              reason={canWrite ? "Nothing to publish" : "You can’t publish templates"}
              who={
                canWrite
                  ? `v${published ?? latest} is live and there’s no draft. Edit the source to start one.`
                  : "Publishing needs the admin scope. Owners and admins can publish."
              }
              side="right"
            >
              <button
                className="btn btn-primary"
                type="button"
                onClick={() => setSheet("publish", true)}
                data-endpoint={`POST /v1/templates/${t.id}/publish`}
              >
                <Icon name="upload" />
                Publish v{hasDraft ? draftVersion : (published ?? latest)}
              </button>
            </Gated>
          </>
        }
      />
      {!canWrite ? (
        <div className="callout callout-info" role="status" style={{ marginBottom: 16 }}>
          <Icon name="lock" />
          <span>
            <b>Read-only.</b> Editing and publishing templates needs the admin scope; you can still preview
            {canSend ? " and send tests" : ""}.
          </span>
        </div>
      ) : null}
      <div className="editor">
        <div className="editor-pane">
          <section
            className="panel"
            data-endpoint={`GET /v1/templates/${t.id} · PUT /v1/templates/${t.id}/draft`}
            data-od-id="panel-source"
            aria-labelledby="h-source"
          >
            <header className="panel-head">
              <h2 className="panel-title" id="h-source">
                Source
              </h2>
            </header>
            <div className="panel-body">
              <div className="stack stack-12">
                <div className="field">
                  <label className="label" htmlFor="tpl-subject">
                    Subject
                  </label>
                  <input
                    className="input"
                    id="tpl-subject"
                    value={subject}
                    readOnly={!canWrite}
                    onChange={(e) => setSubject(e.target.value)}
                  />
                </div>
                <div className="field">
                  <span className="label" id="src-label">
                    {t.kind === "html" ? "HTML source" : "Blocks source (JSON)"}
                  </span>
                  <SourceEditor
                    value={source}
                    onChange={setSource}
                    missing={missing}
                    readOnly={!canWrite}
                    labelledBy="src-label"
                    describedBy="src-foot"
                  />
                  <div className="src-foot" id="src-foot">
                    <span className="save-state" data-od-id="last-saved" aria-live="polite">
                      <Icon name={state === "error" ? "warn" : state === "saved" ? "check" : "clock"} />
                      {state === "saving" ? (
                        "Saving draft…"
                      ) : state === "dirty" ? (
                        "Unsaved changes"
                      ) : state === "error" ? (
                        <>
                          Didn’t save:{" "}
                          {save.error instanceof ApiError
                            ? save.error.message
                            : "Mailyard couldn’t be reached"}
                          .{" "}
                          <button
                            className="link"
                            type="button"
                            onClick={() => save.mutate({ subject, source, text })}
                          >
                            Try again
                          </button>
                        </>
                      ) : t.latest ? (
                        <>
                          Last saved <Time value={t.latest.updatedAt} />
                          {savedBy ? ` by ${savedBy}` : ""}
                        </>
                      ) : (
                        "Not saved yet"
                      )}
                    </span>
                    <span>
                      {used.length} variable{used.length === 1 ? "" : "s"} · {required.length} required
                    </span>
                  </div>
                </div>
                <details className="field">
                  <summary
                    className="label"
                    style={{ cursor: "pointer", minHeight: 32, display: "flex", alignItems: "center" }}
                  >
                    Plain-text part
                  </summary>
                  <textarea
                    className="textarea mono"
                    rows={4}
                    aria-label="Plain-text part"
                    value={text}
                    readOnly={!canWrite}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="Left empty, Mailyard writes one from the HTML."
                  />
                </details>
              </div>
            </div>
          </section>
          <section
            className="panel"
            data-endpoint="POST /v1/templates/preview { data }"
            data-od-id="panel-vars"
            aria-labelledby="h-vars"
          >
            <header className="panel-head">
              <h2 className="panel-title" id="h-vars">
                Variables and sample data
              </h2>
            </header>
            <div className="panel-body">
              {used.length ? (
                <table className="vars" data-od-id="variables">
                  <thead>
                    <tr>
                      <th>Variable</th>
                      <th />
                      <th>Sample value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {used.map((v) => {
                      const isMissing = missing.includes(v)
                      return (
                        <tr key={v} className={isMissing ? "is-missing" : ""}>
                          <td>
                            <code className="mono">{v}</code>
                          </td>
                          <td>
                            {required.includes(v) ? "Required" : <span className="muted">Optional</span>}
                          </td>
                          <td>
                            <input
                              className={`input${/url|email|link/i.test(v) ? " mono" : ""}`}
                              value={samples[v] ?? ""}
                              aria-label={`Sample value for ${v}`}
                              aria-invalid={isMissing ? true : undefined}
                              placeholder={isMissing ? `Missing: renders as {{${v}}}` : ""}
                              onChange={(e) => {
                                const next = { ...samples, [v]: e.target.value }
                                setSamples(next)
                                writeSamples(t.id, next)
                              }}
                            />
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              ) : (
                <p className="muted t-small">
                  This template has no variables. Add one in double braces, like{" "}
                  <code className="mono">{"{{name}}"}</code>.
                </p>
              )}
              <p className="hint" style={{ marginTop: 10 }}>
                Sample values only shape the preview and the test send. Required comes from the template; your
                code must send these.
              </p>
            </div>
          </section>
        </div>
        <div className="editor-pane">
          <section
            className="panel"
            data-endpoint="POST /v1/templates/preview (draft) · POST /v1/templates/{id}/render (a version)"
            data-od-id="panel-preview"
            aria-labelledby="h-preview"
          >
            <header className="panel-head">
              <h2 className="panel-title" id="h-preview">
                Live preview
              </h2>
              <div className="cluster">
                <span className="panel-meta">
                  {preview.isFetching ? "rendering…" : "updates as you type"}
                </span>
                <Link className="panel-link" to="/transactional/templates/$id/preview" params={{ id: t.id }}>
                  Phones
                  <Icon name="chevron-right" />
                </Link>
              </div>
            </header>
            <div className="panel-body">
              <div className="stack stack-12">
                <div className="preview-bar">
                  <DeviceToggle value={device} onChange={setDevice} />
                  {preview.data ? (
                    <div className="preview-meta">
                      <span>
                        <b>{new Intl.NumberFormat("en").format(Number(preview.data.size))}</b> bytes of{" "}
                        {fmtBytes(SIZE_LIMIT).replace("MB", "MiB")}
                      </span>
                      <span style={preview.data.withinLimit ? undefined : { color: "var(--red-900)" }}>
                        {preview.data.withinLimit ? "Within the limit" : "Over the limit: sends would fail"}
                      </span>
                    </div>
                  ) : null}
                </div>
                {missing.length ? (
                  <div className="callout callout-error" role="alert">
                    <Icon name="warn" />
                    <span>
                      <b>
                        Missing:{" "}
                        {missing.map((v, i) => (
                          <span key={v}>
                            {i ? ", " : ""}
                            <span className="mono">{v}</span>
                          </span>
                        ))}
                        .
                      </b>{" "}
                      The preview shows{" "}
                      {missing.length === 1 ? "it as a raw placeholder" : "them as raw placeholders"},
                      highlighted. A real send without {missing.length === 1 ? "it" : "them"} fails with{" "}
                      <span className="mono">422 Unprocessable</span> and never reaches the customer.
                    </span>
                  </div>
                ) : null}
                {preview.isError && !preview.data ? (
                  <PanelError
                    error={preview.error}
                    onRetry={() => preview.refetch()}
                    what="The preview didn’t render"
                  />
                ) : preview.data ? (
                  <>
                    {preview.isError ? (
                      <p className="field-error" role="alert">
                        {preview.error instanceof ApiError
                          ? preview.error.message
                          : "The latest edit didn’t render."}{" "}
                        Showing the last render that worked.
                      </p>
                    ) : null}
                    <DeviceFrame
                      html={preview.data.html}
                      subject={preview.data.subject}
                      from={samples.email ? `to ${samples.email}` : "Preview"}
                      device={device}
                      title={`Preview of ${t.name} draft`}
                    />
                  </>
                ) : (
                  <PanelSkeleton rows={6} />
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
      {search.test === 1 && canSend ? (
        <TestSheet
          t={t}
          samples={sampleData(samples)}
          used={used}
          {...(me.data?.user?.email ? { initialTo: [me.data.user.email] } : {})}
          onClose={() => setSheet("test", false)}
        />
      ) : null}
      {search.publish === 1 && canWrite && hasDraft ? (
        <PublishSheet
          t={t}
          draft={{ subject, source, text }}
          dirty={dirty}
          saveFirst={() => save.mutateAsync({ subject, source, text })}
          samples={sampleData(samples)}
          draftVersion={draftVersion}
          onClose={() => setSheet("publish", false)}
        />
      ) : null}
    </>
  )
}
