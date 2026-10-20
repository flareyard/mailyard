/**
 * Templates (design: transactional/templates*.html; HANDOFF-ops §21, §23): every template with its live
 * version, draft state, where it's used (`usage.usedBy`) and sends in 30 days, plus the library that ships in
 * the repo. "New template" opens a sheet that creates one and lands in the editor.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router"
import { type FormEvent, useId, useState } from "react"
import { ApiError, api, unwrap } from "../../api/client.ts"
import { fmtInt } from "../../lib/format.ts"
import { BuiltPill, Time } from "../../ops/kit.tsx"
import { Sheet } from "../../ops/Overlay.tsx"
import { toast } from "../../ops/toast.tsx"
import { Icon, type IconName } from "../../ui/icons.tsx"
import { PanelError, RequestId } from "../../ui/Panel.tsx"
import { HeadActions } from "../Layout.tsx"
import { versionState } from "../logic.ts"
import { type TemplateRow, templatesQuery } from "../queries.ts"
import { Library } from "./Library.tsx"

const route = getRouteApi("/_app/transactional/templates/")

const USED_ICON: Record<string, IconName> = {
  apiKey: "key",
  automation: "automations",
  campaign: "campaigns",
}
const USED_LABEL: Record<string, string> = {
  apiKey: "API key",
  automation: "Automation",
  campaign: "Campaign",
}
const usedHref = (u: { type: string; id: string }): string =>
  u.type === "apiKey"
    ? "/transactional/keys"
    : u.type === "automation"
      ? `/automations/${u.id}`
      : `/campaigns/${u.id}`

export function TemplateList() {
  const search = route.useSearch()
  const navigate = useNavigate()
  const archived = search.archived === true
  const q = useQuery(templatesQuery(archived))
  const list = (q.data?.templates ?? []).filter((t) => (archived ? true : !t.archived))
  const setNew = (open: boolean) =>
    navigate({
      to: "/transactional/templates",
      search: { ...(archived ? { archived: true as const } : {}), ...(open ? { new: 1 as const } : {}) },
      replace: true,
    })

  return (
    <>
      <HeadActions>
        <button
          className="btn btn-primary"
          type="button"
          data-endpoint="POST /v1/templates"
          onClick={() => setNew(true)}
        >
          <Icon name="plus" />
          New template
        </button>
      </HeadActions>
      <div className="stack">
        <section
          className={`panel${q.isError ? " is-error" : ""}`}
          data-endpoint="GET /v1/templates?include=usage (built, HAL-3415)"
          data-od-id="panel-templates"
          aria-labelledby="h-templates"
          aria-busy={q.isPending}
        >
          <header className="panel-head">
            <h2 className="panel-title" id="h-templates">
              Templates
            </h2>
            <div className="cluster">
              {q.isSuccess && list.length ? (
                <>
                  <span className="panel-meta">
                    {list.length === 1 ? "1 template" : `${list.length} templates`}
                  </span>
                  <BuiltPill issue="HAL-3415" />
                </>
              ) : null}
            </div>
          </header>
          <div className="panel-body">
            {q.isPending ? (
              <ListSkeleton />
            ) : q.isError ? (
              <PanelError error={q.error} onRetry={() => q.refetch()} what="Templates didn’t load" />
            ) : !list.length ? (
              <div className="empty" data-od-id="empty-state">
                <span className="empty-icon">
                  <Icon name="file" />
                </span>
                <h3>{archived ? "No templates, archived or not" : "No templates yet"}</h3>
                <p>
                  A template is a subject and body with <code className="mono">{"{{variables}}"}</code>. Your
                  code sends it by name, and publishing a new version changes every future send without a
                  deploy. To start from a finished one, install <b>welcome</b> or <b>receipt</b> from the
                  library below, or ask your coding agent to write one with the{" "}
                  <code className="mono">add-template</code> skill.
                </p>
                <div className="cluster" style={{ justifyContent: "center" }}>
                  <button className="btn btn-secondary" type="button" onClick={() => setNew(true)}>
                    <Icon name="plus" />
                    Create a template
                  </button>
                  <a className="btn btn-ghost" href="#h-library">
                    <Icon name="box" />
                    From the library
                  </a>
                </div>
              </div>
            ) : (
              <table className="rtable">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Version</th>
                    <th>Draft</th>
                    <th>Used by</th>
                    <th className="r">Sends, 30d</th>
                    <th>Edited</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((t) => (
                    <Row key={t.id} t={t} />
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {q.isSuccess ? (
            <footer className="panel-foot">
              <span>
                {archived ? "Archived templates are shown. " : "Archived templates are hidden. "}
                <span className="url-state">
                  <Icon name="link" />
                  This view is a link: <code className="mono">?archived={archived ? "true" : "false"}</code>
                </span>
              </span>
              <Link
                className="link-quiet"
                to="/transactional/templates"
                search={archived ? {} : { archived: true }}
              >
                {archived ? "Hide archived" : "Show archived"}
              </Link>
            </footer>
          ) : null}
        </section>
        <Library existing={new Set((q.data?.templates ?? []).map((t) => t.name))} />
      </div>
      {search.new === 1 ? <NewTemplateSheet onClose={() => setNew(false)} /> : null}
    </>
  )
}

function Row({ t }: { t: TemplateRow }) {
  const v = versionState(t)
  return (
    <tr className={t.archived ? "is-muted" : undefined}>
      <td className="is-head">
        <div className="cell-main">
          <Link className="mono" to="/transactional/templates/$id" params={{ id: t.id }}>
            {t.name}
          </Link>
          <span className="cell-sub">
            {t.kind === "html" ? "Code (HTML)" : "Blocks"}
            {t.archived ? " · archived" : ""}
          </span>
        </div>
      </td>
      <td data-label="Version">{v.live}</td>
      <td className="is-aside">
        <span className={`pill pill-${v.draft.tone}`}>
          <span className="dot" />
          {v.draft.label}
        </span>
      </td>
      <td data-label="Used by">
        {t.usage?.usedBy.length ? (
          <span className="used-by">
            {t.usage.usedBy.map((u) => (
              <Link
                key={`${u.type}:${u.id}`}
                className="used-chip"
                to={usedHref(u)}
                data-type={u.type}
                title={`${USED_LABEL[u.type] ?? u.type}: ${u.name}`}
              >
                <Icon name={USED_ICON[u.type] ?? "link"} />
                <span className="sr-only">{USED_LABEL[u.type] ?? u.type}: </span>
                {u.name}
              </Link>
            ))}
          </span>
        ) : (
          <span className="muted">Nothing yet</span>
        )}
      </td>
      <td className="r" data-label="Sends, 30d">
        {t.usage ? fmtInt(t.usage.sends30d) : "—"}
      </td>
      <td data-label="Edited">
        <Time value={t.updatedAt} />
      </td>
    </tr>
  )
}

function ListSkeleton() {
  return (
    <table className="rtable" aria-busy="true">
      <tbody>
        {[0, 1, 2, 3].map((r) => (
          <tr key={r}>
            {[62, 40, 48, 70, 30, 44].map((w, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder cells
              <td key={i}>
                <span className="sk sk-text" style={{ width: `${w + ((r * 9) % 25)}%` }} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const STARTER = `<h1>Hi {{name}},</h1>
<p>Write your message here. Variables in double braces, like {{name}}, are filled in by your code.</p>`

/** New template: a name your code sends it by, a subject and a first body; it lands in the editor as a draft. */
function NewTemplateSheet({ onClose }: { onClose: () => void }) {
  const id = useId()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState("")
  const [subject, setSubject] = useState("")
  const [nameError, setNameError] = useState<string | null>(null)
  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/templates", {
          body: { name: name.trim(), kind: "html", subject: subject.trim(), source: STARTER },
        }),
      ),
    onSuccess: (t) => {
      qc.invalidateQueries({ queryKey: ["templates"] })
      toast({ title: `Created ${t?.name ?? name}`, sub: "It’s a draft until you publish it." })
      if (t) navigate({ to: "/transactional/templates/$id", params: { id: t.id } })
      else onClose()
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const n = name.trim()
    if (!n || n.length > 120) {
      setNameError(n ? "120 characters at most." : "Give it a name, like password-reset.")
      return
    }
    if (!subject.trim()) {
      setNameError(null)
      return
    }
    setNameError(null)
    create.mutate()
  }
  const apiError = create.error instanceof ApiError ? create.error : null
  return (
    <Sheet
      title="New template"
      sub="It starts as a draft. Your code sends it by name once it’s published."
      onClose={onClose}
      endpoint="POST /v1/templates"
      odId="new-template-sheet"
      foot={
        <>
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" form={`${id}-f`} disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create and edit"}
          </button>
        </>
      }
    >
      <form id={`${id}-f`} className="stack stack-12" onSubmit={submit} noValidate>
        <div className="field">
          <label className="label" htmlFor={`${id}-n`}>
            Name
          </label>
          <input
            className="input mono"
            id={`${id}-n`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="password-reset"
            aria-invalid={nameError || apiError ? true : undefined}
            aria-describedby={`${id}-nh`}
            autoComplete="off"
            data-autofocus=""
            required
          />
          <span className={nameError || apiError ? "field-error" : "hint"} id={`${id}-nh`}>
            {nameError ??
              (apiError
                ? `Not created: ${apiError.message}`
                : "What your code passes as template in POST /v1/send. It can’t change later.")}
          </span>
        </div>
        <div className="field">
          <label className="label" htmlFor={`${id}-s`}>
            Subject
          </label>
          <input
            className="input"
            id={`${id}-s`}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Reset your password"
            required
          />
          <span className="hint">Variables work here too: “Your receipt for {"{{course}}"}”.</span>
        </div>
        {apiError?.requestId ? <RequestId id={apiError.requestId} /> : null}
      </form>
    </Sheet>
  )
}
