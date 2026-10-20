/**
 * Step 1, content (design: campaign-content.html, -html, -template, -conflict, -section-error, -footer-error,
 * -subject-error; GAPS-audience A7.15, A7.16). The envelope (From, reply-to, subject, the A/B split, the
 * preheader), then the body: blocks, HTML or a template, one at a time. Merge fields list what the content uses
 * with their fallbacks, written into the text as `{{ name ?? "there" }}`. A 400 marks the string its `field`
 * names, with the API's message as is; nothing re-parses the template here.
 */
import { useQuery } from "@tanstack/react-query"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { api, unwrap } from "../../api/client.ts"
import { fieldsQuery, identitiesQuery, templatesQuery } from "../../audience/kit/queries.ts"
import { FieldError } from "../../audience/kit/ui.tsx"
import { Icon } from "../../ui/icons.tsx"
import { docTexts, emptyDoc, mapDocTexts } from "../blocks.ts"
import { errorTarget, goesOutAsTyped, mergeFields, setFallback } from "../logic.ts"
import type { BlocksDoc, Campaign } from "../queries.ts"
import { complianceQuery } from "../queries.ts"
import { AppLink } from "../ui.tsx"
import { BlockCanvas, type BlockError } from "./BlockCanvas.tsx"
import { useEditor } from "./EditorContext.tsx"
import { EditorFrame } from "./EditorFrame.tsx"
import { useFocusParam } from "./focus.ts"

type Mode = "blocks" | "html" | "template"
const modeOf = (c: Campaign): Mode | null =>
  c.bodyBlocks ? "blocks" : c.templateId ? "template" : c.bodyHtml !== null ? "html" : null

/** `?focus=` (from a check's fix) to the element it means. */
const FOCUS: Record<string, string> = {
  subject: "subj",
  subjectB: "subj-b",
  fromAddress: "from",
  replyTo: "reply",
  preheader: "pre",
  bodyHtml: "html-body",
  bodyBlocks: "block-canvas",
  bodyText: "text-body",
  templateId: "template",
  trackClicks: "track-clicks",
  trackOpens: "track-opens",
}

export function ContentStep({ focus }: { focus?: string | undefined }) {
  const ed = useEditor()
  const c = ed.draft
  const fields = useQuery(fieldsQuery)
  const fieldKeys = fields.data ? fields.data.map((f) => f.key) : null
  const [mode, setMode] = useState<Mode>(() => modeOf(c) ?? "blocks")
  const lastText = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  useFocusParam(focus ? (FOCUS[focus] ?? focus) : undefined)

  const target = errorTarget(
    ed.error?.status === 400 && typeof ed.error.body.field === "string" ? ed.error.body.field : null,
  )
  const errFor = (f: string) =>
    target?.kind === "field" && target.field === f ? (ed.error?.message ?? null) : null
  const blockError: BlockError | null =
    target?.kind === "block"
      ? { index: target.index, message: ed.error?.message ?? "", path: target.path }
      : target?.kind === "footer"
        ? { index: "footer", message: ed.error?.message ?? "", path: target.path }
        : null

  const switchMode = (m: Mode) => {
    if (m === mode || !ed.editable) return setMode(m)
    const stash = { ...ed.stash }
    if (mode === "blocks") stash.blocks = c.bodyBlocks
    if (mode === "html") stash.html = c.bodyHtml
    if (mode === "template") stash.templateId = c.templateId
    ed.setStash(stash)
    setMode(m)
    if (m === "blocks") ed.set({ bodyBlocks: stash.blocks ?? emptyDoc(), bodyHtml: null, templateId: null })
    if (m === "html") ed.set({ bodyHtml: stash.html ?? "", bodyBlocks: null, templateId: null })
    if (m === "template") ed.set({ templateId: stash.templateId ?? null, bodyBlocks: null, bodyHtml: null })
  }

  const doc: BlocksDoc = c.bodyBlocks ?? emptyDoc()
  const texts = [
    c.subject,
    c.subjectB ?? "",
    c.preheader ?? "",
    ...(mode === "blocks" ? docTexts(doc) : mode === "html" ? [c.bodyHtml ?? ""] : []),
    c.bodyText ?? "",
  ]

  const insert = (token: string) => {
    const el = lastText.current
    if (el?.isConnected) {
      insertAtCursor(el, token)
      return
    }
    if (mode === "blocks")
      ed.set({
        bodyBlocks: {
          ...doc,
          blocks: [...doc.blocks, { type: "paragraph", text: `View this email in your browser: ${token}` }],
        },
      })
    else if (mode === "html")
      ed.set({
        bodyHtml: `${c.bodyHtml ?? ""}\n<p><a href="${token}">View this email in your browser</a></p>`,
      })
  }

  const rewriteFallback = (key: string, fb: string) => {
    const f = (s: string) => setFallback(s, key, fb)
    const patch: Parameters<typeof ed.set>[0] = { subject: f(c.subject) }
    if (c.subjectB !== null) patch.subjectB = f(c.subjectB)
    if (c.preheader !== null) patch.preheader = f(c.preheader)
    if (c.bodyText !== null) patch.bodyText = f(c.bodyText)
    if (mode === "blocks" && c.bodyBlocks) patch.bodyBlocks = mapDocTexts(c.bodyBlocks, f)
    if (mode === "html" && c.bodyHtml !== null) patch.bodyHtml = f(c.bodyHtml)
    ed.set(patch)
  }

  const bodyLevelError =
    ed.error?.status === 400 &&
    target &&
    (target.kind === "blocks" ||
      target.kind === "block" ||
      target.kind === "footer" ||
      (target.kind === "field" && ["bodyHtml", "templateId", "bodyText", "subject"].includes(target.field)))

  return (
    <EditorFrame step="content">
      <div
        className="editor cmp-editor"
        onFocusCapture={(e) => {
          const t = e.target
          if (
            (t instanceof HTMLInputElement && (t.type === "text" || t.type === "")) ||
            t instanceof HTMLTextAreaElement
          )
            lastText.current = t
        }}
      >
        <div className="stack">
          <Envelope errFor={errFor} />
          <section
            className="panel"
            data-endpoint="PATCH /v1/campaigns/:id {bodyBlocks | bodyHtml | templateId}"
            data-od-id="panel-body"
            aria-labelledby="h-body"
          >
            <header className="panel-head">
              <h2 className="panel-title" id="h-body">
                Body
              </h2>
              <div className="cluster">
                {/* biome-ignore lint/a11y/useSemanticElements: the design's .seg control is a styled button group */}
                <div className="seg" role="group" aria-label="Body" data-od-id="body-mode">
                  {(
                    [
                      ["blocks", "Blocks", "list"],
                      ["html", "HTML", "code"],
                      ["template", "Template", "file"],
                    ] as const
                  ).map(([m, label, icon]) => (
                    <button
                      key={m}
                      type="button"
                      aria-pressed={mode === m}
                      onClick={() => switchMode(m)}
                      disabled={!ed.editable && mode !== m}
                    >
                      <Icon name={icon} />
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </header>
            <div className="panel-body">
              {bodyLevelError && ed.error ? (
                <div
                  className="callout callout-error"
                  role="alert"
                  style={{ marginBottom: 12 }}
                  data-od-id="blocks-400"
                >
                  <Icon name="x-circle" />
                  <span>
                    <b>Not saved.</b> <code className="mono">PATCH /v1/campaigns/{ed.id}</code> answered{" "}
                    <b>400</b> on <code className="mono">{String(ed.error.body.field)}</code>: “
                    {ed.error.message}”{" "}
                    {target?.kind === "blocks"
                      ? "The API takes one body. Pick blocks, HTML or the template; the others are dropped when you save."
                      : target?.kind === "block" || target?.kind === "footer"
                        ? "Sections are checked on save; the string it names is marked below."
                        : "The field it names is marked."}
                  </span>
                </div>
              ) : null}
              <div className="callout callout-info view-note" data-od-id="view-url-note">
                <Icon name="info" />
                <span>
                  Every campaign ends with “View this email in your browser” (in the text part too), unless
                  you place <code className="mono">{"{{ view_url }}"}</code> yourself. It opens the copy the
                  recipient got, at <code className="mono">/v/:token</code>.
                </span>
              </div>
              <p className="hint" data-od-id="body-mode-note" style={{ marginBottom: 12 }}>
                One kind of body at a time: <code className="mono">bodyBlocks</code>,{" "}
                <code className="mono">bodyHtml</code> or <code className="mono">templateId</code>. Switching
                keeps the others’ content in this tab until you save; saving sends only the one you picked.
              </p>
              {mode === "blocks" ? (
                <BlocksBody doc={doc} fieldKeys={fieldKeys} blockError={blockError} />
              ) : mode === "html" ? (
                <HtmlBody errFor={errFor} />
              ) : (
                <TemplateBody />
              )}
              <PlainText errFor={errFor} mode={mode} />
            </div>
          </section>
        </div>
        <div className="side">
          <MergePanel
            texts={texts}
            fieldKeys={fieldKeys}
            templateId={mode === "template" ? c.templateId : null}
            onFallback={rewriteFallback}
            onInsert={insert}
          />
          <CompliancePanel />
        </div>
      </div>
    </EditorFrame>
  )
}

/** Writes text at the cursor of a controlled input, the way typing would, so React sees the change. */
function insertAtCursor(el: HTMLInputElement | HTMLTextAreaElement, token: string) {
  const start = el.selectionStart ?? el.value.length
  const end = el.selectionEnd ?? start
  const next = el.value.slice(0, start) + token + el.value.slice(end)
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, next)
  el.dispatchEvent(new Event("input", { bubbles: true }))
  el.focus()
  el.setSelectionRange(start + token.length, start + token.length)
}

function Envelope({ errFor }: { errFor: (f: string) => string | null }) {
  const ed = useEditor()
  const c = ed.draft
  const identities = useQuery(identitiesQuery)
  const ro = !ed.editable
  const options = (identities.data ?? []).map((i) =>
    i.displayName ? `${i.displayName} <${i.address}>` : i.address,
  )
  if (c.fromAddress && !options.includes(c.fromAddress)) options.unshift(c.fromAddress)
  const ab = c.ab
  const abOn = c.subjectB !== null
  const pct = Number(ab?.percent ?? 20)
  const wait = Number(ab?.waitHours ?? 4)
  const half = pct / 2
  const err = (f: string, id: string) => {
    const m = errFor(f)
    return m ? (
      <FieldError id={`${id}-err`}>
        {m} <code className="mono">{f}</code>
      </FieldError>
    ) : null
  }
  const inv = (f: string, id: string) =>
    errFor(f) ? { "aria-invalid": true, "aria-describedby": `${id}-err` } : {}
  return (
    <section
      className="panel"
      data-endpoint="PATCH /v1/campaigns/:id {fromAddress, replyTo, subject, subjectB, ab, preheader}"
      data-od-id="panel-envelope"
      aria-labelledby="h-envelope"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-envelope">
          Envelope
        </h2>
      </header>
      <div className="panel-body">
        <div className="fgrid" data-od-id="content-fields">
          <div className="field">
            <label className="label" htmlFor="from">
              From
            </label>
            <select
              className="select mono"
              id="from"
              data-endpoint="GET /v1/identities"
              value={c.fromAddress}
              disabled={ro}
              onChange={(e) => ed.set({ fromAddress: e.target.value })}
              {...inv("fromAddress", "from")}
            >
              {options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            {err("fromAddress", "from")}
          </div>
          <div className="field">
            <label className="label" htmlFor="reply">
              Reply-to
            </label>
            <input
              className="input mono"
              id="reply"
              value={c.replyTo ?? ""}
              readOnly={ro}
              placeholder="hello@your-domain"
              onChange={(e) => ed.set({ replyTo: e.target.value.trim() ? e.target.value : null })}
              {...inv("replyTo", "reply")}
            />
            {err("replyTo", "reply")}
          </div>
          <div className="field full">
            <label className="label" htmlFor="subj">
              {abOn ? "Subject A" : "Subject"}
            </label>
            <div className="subject-ab">
              <span className="ab-tag" aria-hidden="true">
                A
              </span>
              <input
                className="input"
                id="subj"
                value={c.subject}
                maxLength={998}
                readOnly={ro}
                onChange={(e) => ed.set({ subject: e.target.value })}
                {...inv("subject", "subj")}
              />
            </div>
            {err("subject", "subj")}
          </div>
          <label className="switch full">
            <input
              type="checkbox"
              checked={abOn}
              disabled={ro}
              onChange={(e) =>
                e.target.checked
                  ? ed.set({ subjectB: "", ab: ab ?? { percent: 20, waitHours: 4, metric: "clicks" } })
                  : ed.set({ subjectB: null, ab: null })
              }
            />{" "}
            A/B test a second subject
          </label>
          {abOn ? (
            <>
              <div className="field full" id="subject-b">
                <label className="label" htmlFor="subj-b">
                  Subject B
                </label>
                <div className="subject-ab">
                  <span className="ab-tag" aria-hidden="true">
                    B
                  </span>
                  <input
                    className="input"
                    id="subj-b"
                    value={c.subjectB ?? ""}
                    maxLength={998}
                    readOnly={ro}
                    onChange={(e) => ed.set({ subjectB: e.target.value })}
                    {...inv("subjectB", "subj-b")}
                  />
                </div>
                {err("subjectB", "subj-b")}
              </div>
              <div className="field full">
                <span className="label">Split test</span>
                <div
                  className="splitline"
                  role="img"
                  aria-label={`${pct}% split: ${half}% get A, ${half}% get B, the winner goes to the other ${100 - pct}% after ${wait} hours`}
                >
                  <span className="sa" style={{ flex: `0 0 ${half}%` }}>
                    A {half}%
                  </span>
                  <span className="sb" style={{ flex: `0 0 ${half}%` }}>
                    B {half}%
                  </span>
                  <span className="sr">
                    Winner to the other {100 - pct}% after {wait} h
                  </span>
                </div>
                <div className="fgrid fgrid-3" style={{ marginTop: 8 }}>
                  <div className="field">
                    <label className="label" htmlFor="ab-pct">
                      Test on
                    </label>
                    <select
                      className="select"
                      id="ab-pct"
                      value={pct}
                      disabled={ro}
                      onChange={(e) =>
                        ed.set({
                          ab: {
                            ...(ab ?? { waitHours: 4, metric: "clicks" }),
                            percent: Number(e.target.value),
                          },
                        })
                      }
                    >
                      {[10, 20, 30, 40, 50].map((p) => (
                        <option key={p} value={p}>
                          {p}% of the audience
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label className="label" htmlFor="ab-metric">
                      Pick the winner by
                    </label>
                    <select
                      className="select"
                      id="ab-metric"
                      value={ab?.metric ?? "clicks"}
                      disabled={ro}
                      onChange={(e) =>
                        ed.set({
                          ab: {
                            ...(ab ?? { percent: 20, waitHours: 4 }),
                            metric: e.target.value as "clicks" | "opens",
                          },
                        })
                      }
                    >
                      <option value="clicks">Clicks</option>
                      <option value="opens">Opens (counts machine opens)</option>
                    </select>
                  </div>
                  <div className="field">
                    <label className="label" htmlFor="ab-wait">
                      After
                    </label>
                    <select
                      className="select"
                      id="ab-wait"
                      value={wait}
                      disabled={ro}
                      onChange={(e) =>
                        ed.set({
                          ab: {
                            ...(ab ?? { percent: 20, metric: "clicks" }),
                            waitHours: Number(e.target.value),
                          },
                        })
                      }
                    >
                      {[1, 2, 4, 8, 12, 24].map((h) => (
                        <option key={h} value={h}>
                          {h} hour{h === 1 ? "" : "s"}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                {errFor("ab") ? <FieldError id="ab-err">{errFor("ab")}</FieldError> : null}
                <span className="hint">
                  Clicks are the better signal: Apple Mail opens every message automatically, which inflates
                  opens.
                </span>
              </div>
            </>
          ) : null}
          <div className="field full">
            <label className="label" htmlFor="pre">
              Preheader <span className="opt">the grey line after the subject in most inboxes</span>
            </label>
            <input
              className="input"
              id="pre"
              value={c.preheader ?? ""}
              readOnly={ro}
              onChange={(e) => ed.set({ preheader: e.target.value ? e.target.value : null })}
              {...inv("preheader", "pre")}
            />
            {err("preheader", "pre")}
          </div>
        </div>
      </div>
    </section>
  )
}

function BlocksBody({
  doc,
  fieldKeys,
  blockError,
}: {
  doc: BlocksDoc
  fieldKeys: readonly string[] | null
  blockError: BlockError | null
}) {
  const ed = useEditor()
  const compliance = useQuery(complianceQuery)
  const ro = !ed.editable
  return (
    <>
      <div className="fgrid" style={{ marginBottom: 12 }}>
        <div className="field">
          <label className="label" htmlFor="bb-label">
            Label{" "}
            <span className="opt">
              <code className="mono">label</code> · above the heading
            </span>
          </label>
          <input
            className="input"
            id="bb-label"
            value={doc.label}
            readOnly={ro}
            onChange={(e) => ed.set({ bodyBlocks: { ...doc, label: e.target.value } })}
          />
        </div>
        <div className="field">
          <label className="label" htmlFor="bb-pre">
            Preheader{" "}
            <span className="opt">
              <code className="mono">preheader</code>
            </span>
          </label>
          <input
            className="input"
            id="bb-pre"
            value={doc.preheader}
            readOnly={ro}
            onChange={(e) => ed.set({ bodyBlocks: { ...doc, preheader: e.target.value } })}
          />
        </div>
      </div>
      <BlockCanvas
        key={blockError ? `${blockError.index}` : "canvas"}
        doc={doc}
        editable={ed.editable}
        fieldKeys={fieldKeys}
        postalAddress={compliance.data?.postalAddress}
        error={blockError}
        onChange={(d) => ed.set({ bodyBlocks: d, bodyHtml: null, templateId: null })}
      />
      <p className="hint" style={{ marginTop: 8 }}>
        The same blocks as a blocks template, saved as <code className="mono">bodyBlocks</code>: a preheader,
        a label, the blocks, and a footer with the reason and its links.
      </p>
    </>
  )
}

function HtmlBody({ errFor }: { errFor: (f: string) => string | null }) {
  const ed = useEditor()
  const m = errFor("bodyHtml")
  return (
    <div className="stack stack-8">
      <label className="label" htmlFor="html-body">
        HTML body{" "}
        <span className="opt">
          <code className="mono">bodyHtml</code>
        </span>
      </label>
      <textarea
        className="textarea mono"
        id="html-body"
        rows={12}
        value={ed.draft.bodyHtml ?? ""}
        readOnly={!ed.editable}
        onChange={(e) => ed.set({ bodyHtml: e.target.value, bodyBlocks: null, templateId: null })}
        {...(m ? { "aria-invalid": true, "aria-describedby": "html-body-err" } : {})}
      />
      {m ? (
        <FieldError id="html-body-err">
          {m} <code className="mono">bodyHtml</code>
        </FieldError>
      ) : null}
      <span className="hint">
        Mailyard adds the unsubscribe footer when the HTML has no link to the preference page.
      </span>
    </div>
  )
}

function TemplateBody() {
  const ed = useEditor()
  const templates = useQuery(templatesQuery)
  const id = ed.draft.templateId
  const detail = useQuery({
    queryKey: ["templates", id],
    queryFn: () => unwrap(api.GET("/v1/templates/{id}", { params: { path: { id: id ?? "" } } })),
    enabled: Boolean(id),
  })
  const list = (templates.data ?? []).filter((t) => !t.archived || t.id === id)
  return (
    <div className="stack" id="template" tabIndex={-1}>
      {templates.isPending ? (
        <span className="sk sk-text" style={{ height: 56 }} />
      ) : list.length === 0 ? (
        <p className="hint">
          No templates yet. Make one under{" "}
          <AppLink href="/transactional/templates" className="link">
            Transactional → Templates
          </AppLink>
          .
        </p>
      ) : (
        <div
          className="stack stack-8"
          data-endpoint="GET /v1/templates"
          role="radiogroup"
          aria-label="Template"
        >
          {list.map((t) => {
            const sel = t.id === id
            const pub = t.publishedVersion
            return (
              <label
                key={t.id}
                className={`choice${sel ? " is-selected" : ""}`}
                style={{ gridTemplateColumns: "20px minmax(0,1fr) auto" }}
              >
                <input
                  type="radio"
                  name="tpl"
                  className="sr-only"
                  checked={sel}
                  disabled={!ed.editable}
                  onChange={() => ed.set({ templateId: t.id, bodyBlocks: null, bodyHtml: null })}
                />
                <span className={`status-icon${sel ? "" : " status-idle"}`}>
                  <Icon name={sel ? "check-circle" : "circle"} />
                </span>
                <span className="c-name">{t.name}</span>
                <span className="pill">
                  {t.kind} · v{pub ?? t.latestVersion}
                </span>
                <span className="c-sub">
                  {pub === null
                    ? "Not published yet; a campaign sends a published version"
                    : t.hasUnpublishedChanges
                      ? `Unpublished changes in v${t.latestVersion}; the campaign uses the published v${pub}`
                      : `Published v${pub}`}
                </span>
              </label>
            )
          })}
        </div>
      )}
      {id && detail.data && "latest" in detail.data && detail.data.latest ? (
        <div className="codeblock">
          <pre className="snip-pre">{detail.data.latest.source}</pre>
        </div>
      ) : null}
      <p className="hint">
        The campaign pins the template’s published version (<code className="mono">templateId</code>,{" "}
        <code className="mono">templateVersion</code>) when it’s scheduled. Edit it under Transactional →
        Templates.
      </p>
    </div>
  )
}

function PlainText({ errFor, mode }: { errFor: (f: string) => string | null; mode: Mode }) {
  const ed = useEditor()
  const v = ed.draft.bodyText
  const m = errFor("bodyText")
  const [open, setOpen] = useState(v !== null || Boolean(m))
  useEffect(() => {
    if (m) setOpen(true)
  }, [m])
  return (
    <details
      className="stack stack-8"
      style={{ marginTop: 12 }}
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="label" style={{ cursor: "pointer", minHeight: 24 }}>
        Plain-text part <span className="opt">{v === null ? "made from the body" : "your own"}</span>
      </summary>
      <textarea
        className="textarea mono"
        id="text-body"
        rows={6}
        value={v ?? ""}
        readOnly={!ed.editable}
        placeholder={
          mode === "template"
            ? "The template’s text part is used."
            : "Leave empty and Mailyard writes it from the body."
        }
        onChange={(e) => ed.set({ bodyText: e.target.value ? e.target.value : null })}
        {...(m ? { "aria-invalid": true, "aria-describedby": "text-body-err" } : {})}
      />
      {m ? (
        <FieldError id="text-body-err">
          {m} <code className="mono">bodyText</code>
        </FieldError>
      ) : null}
    </details>
  )
}

function MergePanel({
  texts,
  fieldKeys,
  templateId,
  onFallback,
  onInsert,
}: {
  texts: string[]
  fieldKeys: readonly string[] | null
  templateId: string | null
  onFallback: (key: string, fb: string) => void
  onInsert: (token: string) => void
}) {
  const ed = useEditor()
  const tpl = useQuery({
    queryKey: ["templates", templateId],
    queryFn: () => unwrap(api.GET("/v1/templates/{id}", { params: { path: { id: templateId ?? "" } } })),
    enabled: Boolean(templateId),
  })
  const used = templateId && tpl.data && "latest" in tpl.data ? (tpl.data.latest?.variables.used ?? []) : []
  const fields = mergeFields([...texts, ...used.map((k) => `{{ ${k} }}`)], fieldKeys).filter(
    (f) => f.key !== "view_url",
  )
  const typos = goesOutAsTyped(texts, fieldKeys)
  return (
    <section
      className="panel"
      data-endpoint="GET /v1/contact-fields · placeholders in the content"
      data-od-id="panel-merge"
      aria-labelledby="h-merge"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-merge">
          Merge fields
        </h2>
      </header>
      <div className="panel-body">
        <div className="mergelist">
          {fields.length === 0 ? (
            <p className="hint" style={{ padding: "8px 0" }}>
              No merge fields yet. Write <code className="mono">{"{{ first_name }}"}</code> in any text.
            </p>
          ) : null}
          {fields.map((f) => (
            <FallbackRow
              key={f.key}
              field={f.key}
              fallback={f.fallback}
              known={f.known}
              readOnly={!ed.editable || Boolean(templateId)}
              onChange={onFallback}
            />
          ))}
          <div className="ml-row ml-link" data-od-id="merge-view-url">
            <code className="mono">{"{{ view_url }}"}</code>
            <span className="ml-label">View in browser link</span>
            <button
              className="btn btn-ghost btn-sm edit-only"
              type="button"
              disabled={!ed.editable || Boolean(templateId)}
              aria-label="Insert view_url, the view in browser link"
              onClick={() => onInsert("{{ view_url }}")}
            >
              Insert
            </button>
          </div>
        </div>
        {typos.length ? (
          <div className="callout callout-warn" style={{ marginTop: 8 }} data-od-id="merge-typo">
            <Icon name="warn" />
            <span>
              <b>
                {typos.map((t, i) => (
                  <span key={t}>
                    {i ? ", " : ""}
                    <code className="mono">{t}</code>
                  </span>
                ))}{" "}
                would go out as typed.
              </b>{" "}
              No contact field has that name, or the syntax isn’t one the renderer reads, so it renders as the
              braces. The <code className="mono">merge_fields</code> check warns about it.
            </span>
          </div>
        ) : null}
        <p className="hint" style={{ marginTop: 8 }}>
          Fallbacks fill in when a contact’s field is empty. Write{" "}
          <code className="mono">{'{{ first_name ?? "there" }}'}</code> in text; single quotes work too:{" "}
          <code className="mono">{"{{ first_name ?? 'there' }}"}</code>. Anything else, like{" "}
          <code className="mono">|</code>, isn’t parsed and goes out as typed. Place{" "}
          <code className="mono">{"{{ view_url }}"}</code> where you want the view-in-browser link, and
          Mailyard won’t add its own line at the end.
        </p>
      </div>
    </section>
  )
}

function FallbackRow({
  field,
  fallback,
  known,
  readOnly,
  onChange,
}: {
  field: string
  fallback: string | null
  known: boolean | null
  readOnly: boolean
  onChange: (key: string, fb: string) => void
}) {
  const [v, setV] = useState(fallback ?? "")
  useEffect(() => setV(fallback ?? ""), [fallback])
  return (
    <div className={`ml-row${known === false ? " is-error" : ""}`}>
      <code
        className="mono"
        title={known === false ? "No contact field has this name" : undefined}
      >{`{{ ${field} }}`}</code>
      <input
        className="input"
        value={v}
        placeholder="Fallback"
        aria-label={`Fallback for ${field}`}
        readOnly={readOnly}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          if ((fallback ?? "") !== v) onChange(field, v)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur()
        }}
      />
    </div>
  )
}

function CompliancePanel() {
  const ed = useEditor()
  const compliance = useQuery(complianceQuery)
  const addr = compliance.data?.postalAddress
  const row = (ok: boolean, label: ReactNode) => (
    <div className="cluster" style={{ flexWrap: "nowrap" }}>
      <Icon
        name={ok ? "check-circle" : "warn"}
        className={`status-icon ${ok ? "status-pass" : "status-warn"}`}
      />
      <span>{label}</span>
    </div>
  )
  return (
    <section
      className="panel"
      data-endpoint="GET /v1/settings/compliance · postalAddress · PATCH /v1/campaigns/:id {trackOpens, trackClicks}"
      data-od-id="panel-compliance"
      aria-labelledby="h-compliance"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-compliance">
          Compliance
        </h2>
      </header>
      <div className="panel-body">
        <div className="stack stack-12">
          {compliance.isPending ? (
            <span className="sk sk-text" />
          ) : (
            <>
              {row(Boolean(addr), addr ? "Postal address is set" : "No postal address yet")}
              <p className="hint">
                {addr ?? (
                  <>
                    Commercial mail needs one (CAN-SPAM).{" "}
                    <AppLink href="/settings/tracking?field=postalAddress" className="link">
                      Set it in Settings
                    </AppLink>
                    .
                  </>
                )}
              </p>
            </>
          )}
          {row(true, "One-click unsubscribe header")}
          <p className="hint">
            Mailyard adds <code className="mono">List-Unsubscribe</code> and{" "}
            <code className="mono">List-Unsubscribe-Post</code> to every campaign; the footer can’t be
            removed.
          </p>
          <label className="switch">
            <input
              type="checkbox"
              id="track-opens"
              checked={ed.draft.trackOpens}
              disabled={!ed.editable}
              onChange={(e) => ed.set({ trackOpens: e.target.checked })}
            />{" "}
            Track opens
          </label>
          <label className="switch">
            <input
              type="checkbox"
              id="track-clicks"
              checked={ed.draft.trackClicks}
              disabled={!ed.editable}
              onChange={(e) => ed.set({ trackClicks: e.target.checked })}
            />{" "}
            Track clicks
          </label>
        </div>
      </div>
    </section>
  )
}
