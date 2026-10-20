/**
 * The automation builder (design: automation-builder*.html, -add-step, -send-step*, -dry-run*, -versions,
 * -publish, -redacted; GAPS A8.2–A8.5, A8.11–A8.16). The draft graph is edited locally and saved with PATCH;
 * publish freezes it as a version (409 NotReady lists what to fix). The side panel is in the URL
 * (`?panel=&node=`), so a step, the dry run or the versions list is a link. Read keys (`redacted`) see it all
 * read-only; dry runs and runs stay open to them. Phones get the read-only outline.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api, unwrap } from "../api/client.ts"
import { useKeyName } from "../audience/kit/queries.ts"
import { ApiErrorCallout, BackLink, SampleMarker, StatusPill, useCan } from "../audience/kit/ui.tsx"
import { Gated } from "../auth/NoPermission.tsx"
import { fmtAgo, num } from "../lib/format.ts"
import { usePageTitle } from "../shell/title.tsx"
import { Icon } from "../ui/icons.tsx"
import { PanelError } from "../ui/Panel.tsx"
import { Canvas, clampZoom, NODE_ICON, Outline } from "./Canvas.tsx"
import { NodeInspector } from "./Inspector.tsx"
import { useNames } from "./List.tsx"
import {
  ADDABLE,
  type Automation,
  addTarget,
  type DryRun,
  deleteStep,
  describeTrigger,
  type GNode,
  type Graph,
  type Issue,
  insertStep,
  issuesByNode,
  layoutGraph,
  type NodeType,
  overlayFromDryRun,
  overlayFromRun,
  type Port,
  replaceNode,
  runSummary,
  type Settings,
  sameGraph,
} from "./logic.ts"
import {
  DryRunPanel,
  IssueList,
  IssuesPanel,
  type Published,
  PublishSheet,
  SettingsPanel,
  VersionsPanel,
} from "./Panels.tsx"
import { automationQuery, runQuery } from "./queries.ts"
import "./automations.css"

export type BuilderPanel = "versions" | "dry-run" | "issues" | "publish" | "settings"
type Search = { panel?: BuilderPanel; node?: string; run?: string; fx?: string }

export function Builder({ id, search }: { id: string; search: Search }) {
  const q = useQuery(automationQuery(id))
  usePageTitle(q.data && "name" in q.data ? q.data.name : "Automation")
  if (q.isPending) return <BuilderSkeleton />
  if (q.isError || !q.data)
    return (
      <>
        <BackLink to="/automations">Automations</BackLink>
        <section
          className="panel is-error"
          data-endpoint={`GET /v1/automations/${id}`}
          data-od-id="panel-builder"
        >
          <header className="panel-head">
            <h2 className="panel-title">Builder</h2>
          </header>
          <div className="panel-body">
            <PanelError error={q.error} onRetry={() => q.refetch()} what="This automation didn’t load" />
            <p className="hint" style={{ marginTop: 8 }}>
              It’s still running: live versions don’t depend on this page. Retry to edit it.
            </p>
          </div>
        </section>
      </>
    )
  return <Loaded a={q.data} search={search} />
}

function BuilderSkeleton() {
  return (
    <div aria-busy="true">
      <BackLink to="/automations">Automations</BackLink>
      <div className="obj-head" data-od-id="object-head">
        <div className="oh-main stack stack-8" aria-hidden="true">
          <span className="sk sk-title" style={{ width: 240 }} />
          <span className="sk sk-text" style={{ width: 360 }} />
        </div>
      </div>
      <div className="autobar desk-only" aria-hidden="true">
        <span className="sk sk-chip" />
        <span className="sk sk-chip" />
      </div>
      <div className="workspace no-inspector desk-only">
        <div className="canvas">
          <div className="canvas-inner">
            <div className="flow" aria-hidden="true">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="stack" style={{ alignItems: "center" }}>
                  {i ? <div className="edge" /> : null}
                  <span
                    className="sk"
                    style={{ width: 220, height: 84, display: "block", borderRadius: 8 }}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="phone-only stack stack-8" aria-hidden="true">
        <span className="sk sk-text" />
        <span className="sk sk-text" />
        <span className="sk sk-text" />
      </div>
    </div>
  )
}

type Draft = { graph: Graph; name: string; settings: Settings }

function Loaded({ a, search }: { a: Automation; search: Search }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const names = useNames()
  const keyName = useKeyName()
  const write = useCan("automations.write", "change automations")
  const redacted = a.redacted
  const editable = write.allowed && !redacted
  const reason = redacted ? "Your key can’t change automations" : "You can’t change automations"
  const who = redacted
    ? "Changing an automation needs a key with the admin scope. Reading, dry runs and run history need read."
    : write.who

  const [draft, setDraft] = useState<Draft | null>(null)
  const [history, setHistory] = useState<Draft[]>([])
  const [zoom, setZoom] = useState(1)
  const [menu, setMenu] = useState(false)
  const [refusal, setRefusal] = useState<{ issues: Issue[]; body: unknown } | null>(null)
  const [published, setPublished] = useState<Published | null>(null)
  const [dry, setDry] = useState<DryRun | null>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)

  const server: Draft = useMemo(() => ({ graph: a.graph, name: a.name, settings: a.settings }), [a])
  const cur = draft ?? server
  const dirty =
    draft !== null &&
    (!sameGraph(draft.graph, a.graph) ||
      draft.name !== a.name ||
      JSON.stringify(draft.settings) !== JSON.stringify(a.settings))

  const edit = useCallback(
    (fn: (d: Draft) => Draft) => {
      setHistory((h) => [...h.slice(-49), draft ?? server])
      setDraft(fn(draft ?? server))
    },
    [draft, server],
  )
  const undo = () => {
    const prev = history[history.length - 1]
    if (!prev) return
    setHistory((h) => h.slice(0, -1))
    setDraft(prev)
  }

  const setSearch = useCallback(
    (next: Search) =>
      navigate({
        to: "/automations/$automationId",
        params: { automationId: a.id },
        search: search.fx ? { ...next, fx: search.fx } : next,
        replace: true,
      }),
    [navigate, a.id, search.fx],
  )
  const select = useCallback(
    (nodeId: string | null) => setSearch(nodeId ? { node: nodeId } : {}),
    [setSearch],
  )
  const openPanel = (panel: BuilderPanel | null) => setSearch(panel ? { panel } : {})

  const save = useMutation({
    mutationFn: (d: Draft) =>
      unwrap(
        api.PATCH("/v1/automations/{id}", {
          params: { path: { id: a.id } },
          body: { name: d.name, graph: d.graph, settings: d.settings },
        }),
      ),
    onSuccess: (res) => {
      if (res && "graph" in res) qc.setQueryData(automationQuery(a.id).queryKey, res)
      qc.invalidateQueries({ queryKey: ["automations"] })
      setDraft(null)
      setHistory([])
      setRefusal(null)
    },
  })

  const run = useQuery({ ...runQuery(search.run ?? ""), enabled: Boolean(search.run) })
  const overlay = useMemo(() => {
    if (search.panel === "dry-run" && dry) return overlayFromDryRun(dry)
    if (search.run && run.data && "steps" in run.data) return overlayFromRun(run.data)
    return null
  }, [search.panel, dry, search.run, run.data])

  const layout = useMemo(() => layoutGraph(cur.graph), [cur.graph])
  const issues = refusal && !dirty ? refusal.issues : a.issues
  const byNode = useMemo(() => issuesByNode(issues), [issues])
  const selectedNode = search.node ? cur.graph.nodes.find((n) => n.id === search.node) : undefined
  const trigger =
    cur.graph.nodes.find((n): n is Extract<GNode, { type: "trigger" }> => n.type === "trigger")?.config ??
    null

  const onZoom = useCallback((z: number | "fit") => {
    if (z !== "fit") return setZoom(z)
    const c = canvasRef.current
    const inner = innerRef.current
    if (!c || !inner) return setZoom(1)
    setZoom((cur) => {
      const natural = inner.scrollWidth / cur
      return clampZoom(Math.min(1, (c.clientWidth - 16) / Math.max(1, natural)))
    })
  }, [])

  const goto = (nodeId: string) => {
    setSearch({ node: nodeId })
    requestAnimationFrame(() => {
      const el = canvasRef.current?.querySelector<HTMLElement>(`[data-node="${CSS.escape(nodeId)}"]`)
      el?.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" })
      el?.focus({ preventScroll: true })
    })
  }

  const insert = (from: string, port: Port | undefined, type: Exclude<NodeType, "trigger">) => {
    let added = ""
    edit((d) => {
      const r = insertStep(d.graph, from, port, type)
      added = r.id
      return { ...d, graph: r.graph }
    })
    setMenu(false)
    requestAnimationFrame(() => added && goto(added))
  }
  const [pendingInsert, setPendingInsert] = useState<{ from: string; port: Port | undefined } | null>(null)

  // Esc closes the add-step menu.
  useEffect(() => {
    if (!menu && !pendingInsert) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenu(false)
        setPendingInsert(null)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [menu, pendingInsert])

  // Leaving with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return
    const onBefore = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener("beforeunload", onBefore)
    return () => window.removeEventListener("beforeunload", onBefore)
  }, [dirty])

  const pub = num(a.publishedVersion)
  const ver = num(a.version) ?? 1
  const pubBlocked = refusal && !dirty && refusal.issues.length
  const firstNames = refusal?.issues
    .map((i) => (i.nodeId ? cur.graph.nodes.find((n) => n.id === i.nodeId) : undefined))
    .filter((n): n is GNode => Boolean(n))
    .map((n) => `“${n.label ?? n.id}”`)

  let aside: React.ReactNode = null
  if (search.panel === "dry-run")
    aside = (
      <DryRunPanel a={a} names={names} dirty={dirty} onResult={setDry} onClose={() => openPanel(null)} />
    )
  else if (search.panel === "versions")
    aside = (
      <VersionsPanel
        a={a}
        canWrite={editable}
        reason={reason}
        who={who}
        onRestored={(res) => {
          qc.setQueryData(automationQuery(a.id).queryKey, res)
          setDraft(null)
          setHistory([])
        }}
        onClose={() => openPanel(null)}
      />
    )
  else if (search.panel === "issues")
    aside = (
      <IssuesPanel
        a={a}
        issues={issues}
        refusal={refusal && !dirty ? refusal.body : null}
        names={names}
        onGoto={goto}
        onClose={() => openPanel(null)}
      />
    )
  else if (search.panel === "settings")
    aside = (
      <SettingsPanel
        name={cur.name}
        settings={cur.settings}
        editable={editable}
        onName={(name) => edit((d) => ({ ...d, name }))}
        onChange={(settings) => edit((d) => ({ ...d, settings }))}
        onClose={() => openPanel(null)}
      />
    )
  else if (selectedNode)
    aside = (
      <NodeInspector
        key={selectedNode.id}
        node={selectedNode}
        ctx={{
          automationId: a.id,
          names,
          editable,
          reason,
          who,
          redacted,
          trigger,
          issues: byNode.get(selectedNode.id) ?? [],
          onChange: (n) => edit((d) => ({ ...d, graph: replaceNode(d.graph, n) })),
          onDelete: (nid) => {
            edit((d) => ({ ...d, graph: deleteStep(d.graph, nid) }))
            select(null)
          },
          onAddOn: (from, port) => setPendingInsert({ from, port }),
          onClose: () => select(null),
        }}
      />
    )

  const statusPill =
    a.status === "live" ? (
      <StatusPill status="live" label={`Live · v${pub ?? ver}`} />
    ) : a.status === "paused" ? (
      <StatusPill status="paused" label={`Paused · v${pub ?? ver}`} />
    ) : (
      <StatusPill
        status="draft"
        label={pub === null ? "Draft · never published" : `Draft · v${pub} retired`}
      />
    )

  return (
    <>
      <BackLink to="/automations">Automations</BackLink>
      <div className="obj-head" data-od-id="object-head">
        <div className="oh-main">
          <h1 data-od-id="page-title">{cur.name}</h1>
          <div className="oh-sub">
            {statusPill}
            {pub !== null && ver > pub ? (
              <span className="pill">Draft v{ver} · unpublished changes</span>
            ) : null}
            <code className="mono">{a.id}</code>
            <span>Trigger: {describeTrigger(trigger, names)}</span>
            <span>
              {a.status === "draft" && a.updatedAt
                ? `Edited ${fmtAgo(a.updatedAt)}${a.updatedBy ? ` with ${keyName(a.updatedBy)}` : ""}`
                : runSummary(a)}
            </span>
          </div>
        </div>
        <div className="oh-actions">
          <SampleMarker />
          <Link
            className="btn btn-ghost btn-sm"
            to="/automations/$automationId/runs"
            params={{ automationId: a.id }}
          >
            <Icon name="list" />
            Runs
          </Link>
          <button
            className="btn btn-ghost btn-sm edit-only"
            type="button"
            aria-pressed={search.panel === "versions"}
            onClick={() => openPanel(search.panel === "versions" ? null : "versions")}
          >
            <Icon name="history" />
            Versions
          </button>
          <button
            className="btn btn-secondary btn-sm edit-only"
            type="button"
            aria-pressed={search.panel === "dry-run"}
            onClick={() => openPanel(search.panel === "dry-run" ? null : "dry-run")}
          >
            <Icon name="play" />
            Dry run
          </button>
          <span className="edit-only">
            <Gated
              allowed={editable && !pubBlocked}
              reason={
                !editable
                  ? redacted
                    ? "Your key can’t publish"
                    : "You can’t publish automations"
                  : `${issues.length} issue${issues.length === 1 ? "" : "s"} block publishing`
              }
              who={
                !editable
                  ? who
                  : `Publish answered 409 NotReady. Fix ${firstNames?.join(" and ") || "them"}, then publish.`
              }
              side="right"
            >
              <button
                className="btn btn-primary btn-sm"
                type="button"
                data-od-id="publish"
                data-endpoint={`POST /v1/automations/${a.id}/publish`}
                onClick={() => setSearch({ ...(search.node ? { node: search.node } : {}), panel: "publish" })}
              >
                {pubBlocked ? <Icon name="warn" /> : null}
                Publish{pub === null && ver === 1 ? "" : ` v${ver}`}
              </button>
            </Gated>
          </span>
        </div>
      </div>

      {redacted ? (
        <div className="callout callout-info ro-banner" role="note" data-od-id="redacted-banner">
          <Icon name="lock" />
          <span>
            <b>Read-only for your key.</b> You’re signed in with{" "}
            {write.me?.key ? (
              <>
                the {write.me.key.name} key (<span className="mono">{write.me.key.prefix}…</span>, scopes{" "}
                {write.me.scopes.join(", ")})
              </>
            ) : (
              "a key without admin"
            )}
            . Only <b>admin keys</b> can edit, publish, pause or restore an automation, and only they see step
            secrets: a webhook URL shows as <span className="mono">https://host/•••</span>. You can still run
            a dry run and read the run history.
          </span>
        </div>
      ) : null}

      {published ? (
        <div className="callout callout-ok" role="status" style={{ marginBottom: 12 }}>
          <Icon name="check-circle" />
          <span>
            <b>v{published.version} is live.</b> Contacts who enter from now on follow it.
            {published.runsByVersion.filter((r) => r.version !== published.version && r.active > 0).length
              ? ` ${published.runsByVersion
                  .filter((r) => r.version !== published.version && r.active > 0)
                  .map((r) => `${r.active} on v${r.version}`)
                  .join(" and ")} finish on their version.`
              : ""}
          </span>
          <button className="icon-btn" type="button" aria-label="Dismiss" onClick={() => setPublished(null)}>
            <Icon name="x" />
          </button>
        </div>
      ) : null}

      <div className="ro-note phone-only" role="note" data-od-id="phone-read-only">
        <Icon name="monitor" />
        <span>
          <b>Read-only on a phone.</b> The automation builder needs a wider screen to edit. Everything here is
          current; open it on a tablet or computer to change it.
        </span>
      </div>
      {issues.length ? (
        <div className="phone-only" data-od-id="issues-phone">
          <section className="panel" aria-labelledby="h-issues-phone" style={{ marginBottom: 12 }}>
            <header className="panel-head">
              <h2 className="panel-title" id="h-issues-phone">
                Can’t publish yet
              </h2>
            </header>
            <div className="panel-body">
              <IssueList
                a={a}
                issues={issues}
                refusal={refusal && !dirty ? refusal.body : null}
                names={names}
              />
            </div>
          </section>
        </div>
      ) : null}
      <div className="phone-only" data-od-id="automation-outline">
        <section className="panel" data-endpoint={`GET /v1/automations/${a.id}`} aria-labelledby="h-outline">
          <header className="panel-head">
            <h2 className="panel-title" id="h-outline">
              Steps
            </h2>
          </header>
          <div className="panel-body">
            <Outline
              items={layout.main}
              names={names}
              counts={pub === null ? {} : a.counts}
              issues={byNode}
            />
          </div>
        </section>
      </div>

      <div className="autobar desk-only" role="toolbar" aria-label="Canvas" data-od-id="canvas-toolbar">
        <span className="add-step-anchor">
          <Gated allowed={editable} reason={reason} who={who}>
            <button
              className="btn btn-secondary btn-sm"
              type="button"
              aria-haspopup="menu"
              aria-expanded={menu}
              data-od-id="add-step"
              onClick={() => setMenu((m) => !m)}
            >
              <Icon name="plus" />
              Add step
            </button>
          </Gated>
          {menu || pendingInsert ? (
            <AddMenu
              onPick={(t) => {
                const target = pendingInsert ?? addTarget(cur.graph, search.node ?? null)
                setPendingInsert(null)
                if (target) insert(target.from, target.port, t)
              }}
              onClose={() => {
                setMenu(false)
                setPendingInsert(null)
              }}
            />
          ) : null}
        </span>
        {/* biome-ignore lint/a11y/useSemanticElements: the design's zoom control is a styled group */}
        <div className="zoom" role="group" aria-label="Zoom">
          <button
            type="button"
            aria-label="Zoom out"
            data-tip="Zoom out · −"
            onClick={() => onZoom(clampZoom(zoom - 0.1))}
          >
            <Icon name="suppress" />
          </button>
          <span data-zoom-label aria-live="polite">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            aria-label="Zoom in"
            data-tip="Zoom in · +"
            onClick={() => onZoom(clampZoom(zoom + 0.1))}
          >
            <Icon name="plus" />
          </button>
        </div>
        <button
          className="btn btn-ghost btn-sm"
          type="button"
          data-tip="Fit · 0"
          onClick={() => onZoom("fit")}
        >
          <Icon name="monitor" />
          Fit
        </button>
        {editable ? (
          <button className="btn btn-ghost btn-sm" type="button" onClick={undo} disabled={!history.length}>
            <Icon name="undo" />
            Undo
          </button>
        ) : null}
        <button
          className="btn btn-ghost btn-sm"
          type="button"
          aria-pressed={search.panel === "settings"}
          onClick={() => openPanel(search.panel === "settings" ? null : "settings")}
        >
          <Icon name="settings" />
          Settings
        </button>
        <span className="grow" />
        <button
          className="btn btn-ghost btn-sm ab-issues"
          type="button"
          onClick={() => openPanel(search.panel === "issues" ? null : "issues")}
          style={issues.length ? { color: "var(--red-900)" } : undefined}
        >
          <Icon name={issues.length ? "x-circle" : "check-circle"} />
          {issues.length ? `${issues.length} issue${issues.length === 1 ? "" : "s"}` : "No issues"}
        </button>
        {dirty ? (
          <>
            <span className="savestate" role="status">
              <Icon name="pencil" />
              Unsaved changes{issues.length ? " · issues update when saved" : ""}
            </span>
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              onClick={() => {
                setDraft(null)
                setHistory([])
              }}
            >
              Discard
            </button>
            <button
              className={`btn btn-primary btn-sm${save.isPending ? " is-loading" : ""}`}
              type="button"
              onClick={() => draft && save.mutate(draft)}
            >
              {save.isPending ? <span className="spinner" aria-hidden="true" /> : <Icon name="check" />}
              Save draft
            </button>
          </>
        ) : (
          <span className="savestate">
            <Icon name="check" />
            {a.updatedAt
              ? `Draft v${ver} saved ${fmtAgo(a.updatedAt)}${a.updatedBy ? ` with ${keyName(a.updatedBy)}` : ""}`
              : `Draft v${ver}`}
          </span>
        )}
      </div>
      {save.isError ? (
        <div className="desk-only" style={{ margin: "8px 0" }}>
          <ApiErrorCallout error={save.error} what="The draft wasn’t saved." />
        </div>
      ) : null}
      {overlay ? (
        <div className="callout callout-info desk-only au-overlay-bar" role="status">
          <Icon name="pulse" />
          <span className="grow">
            {search.panel === "dry-run" && dry
              ? `Showing the dry run for ${dry.contact.email} on the canvas: ${dry.path.length} steps.`
              : run.data && "steps" in run.data
                ? `Showing run ${run.data.id} (${run.data.email ?? run.data.contactId}, v${num(run.data.version)}) on the canvas.`
                : ""}
          </span>
          {search.run ? (
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => setSearch({})}>
              Clear
            </button>
          ) : null}
        </div>
      ) : null}
      <div className={`workspace desk-only${aside ? "" : " no-inspector"}`}>
        <Canvas
          layout={layout}
          names={names}
          selected={search.node ?? null}
          onSelect={select}
          issues={byNode}
          counts={pub === null ? {} : a.counts}
          overlay={overlay}
          editable={editable}
          redacted={redacted}
          onInsert={(from, port) => {
            setMenu(false)
            setPendingInsert({ from, port })
          }}
          zoom={zoom}
          onZoom={onZoom}
          canvasRef={canvasRef}
          innerRef={innerRef}
          legend={
            overlay ? (
              <div className="canvas-legend" aria-hidden="true">
                <span>
                  <span className="ncount is-skip">Skipped</span>no mail; the run goes on
                </span>
                <span>
                  <span className="ncount is-fail">Failed</span>the run stops
                </span>
              </div>
            ) : pub === null ? null : (
              <div className="canvas-legend" aria-hidden="true">
                <span>
                  <span className="ncount is-here">n here</span>contacts waiting at a step now
                </span>
                <span>
                  <span className="ncount">n passed</span>since v{pub} went live
                </span>
              </div>
            )
          }
        />
        {aside}
      </div>

      {search.panel === "publish" ? (
        <PublishSheet
          a={a}
          dirty={dirty}
          save={() => (draft ? save.mutateAsync(draft) : Promise.resolve())}
          onClose={() => setSearch(search.node ? { node: search.node } : {})}
          onPublished={(p) => {
            setPublished(p)
            setRefusal(null)
            setSearch({})
          }}
          onRefused={(iss, body) => {
            setRefusal({ issues: iss, body })
            setSearch({ panel: "issues" })
          }}
        />
      ) : null}
    </>
  )
}

function AddMenu({
  onPick,
  onClose,
}: {
  onPick: (t: Exclude<NodeType, "trigger">) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("button")?.focus()
    const onDown = (e: MouseEvent) => {
      if (
        ref.current &&
        !ref.current.contains(e.target as Node) &&
        !(e.target as HTMLElement).closest?.(".edge-add, [data-od-id=add-step]")
      )
        onClose()
    }
    window.addEventListener("mousedown", onDown)
    return () => window.removeEventListener("mousedown", onDown)
  }, [onClose])
  return (
    <div
      className="menu add-step-menu"
      role="menu"
      aria-label="Add a step"
      ref={ref}
      onKeyDown={(e) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
        e.preventDefault()
        const items = [...(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])]
        const i = items.indexOf(document.activeElement as HTMLElement)
        items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus()
      }}
    >
      <div className="menu-label">Add a step</div>
      {ADDABLE.map((s) => (
        <button
          key={s.type}
          className="menu-item"
          type="button"
          role="menuitem"
          onClick={() => onPick(s.type)}
        >
          <Icon name={NODE_ICON[s.type]} />
          <span className="grow">{s.label}</span>
        </button>
      ))}
      <div className="menu-sep" />
      <div className="skill-hint" role="note" data-od-id="add-step-skill-hint">
        <span className="cluster cluster-4">
          <Icon name="code" />
          <span className="pill pill-inrepo">In your repo</span>
        </span>
        <p>
          Need a step that isn’t here? Ask your coding agent: the{" "}
          <code className="mono">add-automation-step</code> skill adds one (for example a Slack notification).
        </p>
        <p className="hint">
          Try: <code className="mono">Add a slack_notify step that posts to a channel</code>. The skill lives
          in <code className="mono">skills/</code>, linked into <code className="mono">.claude/skills</code>;{" "}
          <code className="mono">bun run check</code> proves the change and the{" "}
          <code className="mono">deploy</code> skill ships it. It doesn’t run from here.
        </p>
      </div>
    </div>
  )
}
