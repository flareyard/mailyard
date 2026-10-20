/**
 * A template's versions (design: template-versions.html): newest first, the draft, the live one, and every
 * earlier one with Preview and Roll back. A rollback publishes a copy of that version as a new version
 * (src/domain/templates.ts), so history only grows and nothing already sent changes.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router"
import { ApiError, api, unwrap } from "../../api/client.ts"
import { Gated } from "../../auth/NoPermission.tsx"
import { useMe } from "../../auth/session.ts"
import { SampleMarker } from "../../ops/kit.tsx"
import { Drawer, Sheet } from "../../ops/Overlay.tsx"
import { hasScope } from "../../ops/roles.ts"
import { toast } from "../../ops/toast.tsx"
import { usePageTitle } from "../../shell/title.tsx"
import { Icon } from "../../ui/icons.tsx"
import { PanelError, PanelSkeleton, RequestId } from "../../ui/Panel.tsx"
import { Crumbs } from "../Layout.tsx"
import { actorName, andList, type VersionRow, varChanges, versionRows, versionStamp } from "../logic.ts"
import { type TemplateDetail, templateQuery, useKeyNames } from "../queries.ts"
import { DeviceFrame } from "./Preview.tsx"
import { readSamples } from "./samples.ts"

const route = getRouteApi("/_app/transactional/templates/$id/versions")

export function TemplateVersions() {
  const { id } = route.useParams()
  const search = route.useSearch()
  const navigate = useNavigate()
  const q = useQuery(templateQuery(id))
  const me = useMe()
  const keys = useKeyNames()
  usePageTitle(q.data ? `${q.data.name} versions` : "Template versions")
  const canWrite = hasScope(me.data, "admin")
  const set = (k: "rollback" | "preview", v?: number) =>
    navigate({
      to: "/transactional/templates/$id/versions",
      params: { id },
      search: v ? { [k]: v } : {},
      replace: true,
    })

  const head = (
    <div className="page-head" data-od-id="page-head">
      <div style={{ minWidth: 0 }}>
        <Crumbs
          items={[
            { to: "/transactional/messages", label: "Transactional" },
            { to: "/transactional/templates", label: "Templates" },
            ...(q.data ? [{ to: `/transactional/templates/${id}`, label: q.data.name }] : []),
          ]}
        />
        <h1 data-od-id="page-title">
          <span className="mono" style={{ fontFamily: "var(--font-mono)", fontWeight: 400 }}>
            {q.data?.name ?? id}
          </span>{" "}
          versions
        </h1>
        <p className="sub">
          Roll back sends the chosen version from the next message on. Nothing already sent changes.
        </p>
      </div>
      <div className="cluster cluster-12">
        <SampleMarker />
      </div>
    </div>
  )

  if (q.isPending || q.isError)
    return (
      <>
        {head}
        <section className={`panel${q.isError ? " is-error" : ""}`}>
          <div className="panel-body">
            {q.isPending ? (
              <PanelSkeleton rows={6} />
            ) : (
              <PanelError error={q.error} onRetry={() => q.refetch()} what="Versions didn’t load" />
            )}
          </div>
        </section>
      </>
    )

  const t = q.data
  const rows = versionRows(t)
  const target = rows.find((r) => r.version === search.rollback)
  const previewing = rows.find((r) => r.version === search.preview)

  return (
    <>
      {head}
      <section
        className="panel"
        data-endpoint={`GET /v1/templates/${t.id} → versions[] · POST /v1/templates/${t.id}/rollback`}
        data-od-id="panel-versions"
        aria-labelledby="h-versions"
      >
        <header className="panel-head">
          <h2 className="panel-title" id="h-versions">
            Versions
          </h2>
          <div className="cluster">
            <span className="panel-meta">
              {rows.length} version{rows.length === 1 ? "" : "s"}
            </span>
          </div>
        </header>
        <div className="panel-body">
          <ol className="ver-list" data-od-id="version-list">
            {rows.map((r) => (
              <li
                key={r.version}
                className={`ver${r.state === "draft" ? " is-draft" : r.state === "live" ? " is-live" : ""}`}
              >
                <span className="ver-n">v{r.version}</span>
                <span className="ver-title">{r.subject}</span>
                <span className="actions">
                  {r.state === "draft" ? (
                    <Link
                      className="btn btn-secondary btn-sm"
                      to="/transactional/templates/$id"
                      params={{ id: t.id }}
                    >
                      Open draft
                    </Link>
                  ) : r.state === "live" ? (
                    <span className="pill pill-pass">
                      <span className="dot" />
                      Live
                    </span>
                  ) : (
                    <>
                      <button
                        className="btn btn-ghost btn-sm"
                        type="button"
                        onClick={() => set("preview", r.version)}
                        data-endpoint={`POST /v1/templates/${t.id}/render { version: ${r.version} }`}
                      >
                        <Icon name="eye" />
                        Preview
                      </button>
                      <Gated
                        allowed={canWrite}
                        reason="You can’t roll back templates"
                        who="Rolling back publishes a version, which needs the admin scope."
                        side="right"
                      >
                        <button
                          className="btn btn-secondary btn-sm"
                          type="button"
                          onClick={() => set("rollback", r.version)}
                          data-endpoint={`POST /v1/templates/${t.id}/rollback { version: ${r.version} }`}
                        >
                          <Icon name="undo" />
                          Roll back to v{r.version}
                        </button>
                      </Gated>
                    </>
                  )}
                </span>
                <span className="ver-sub">{verSub(r, keys)}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>
      {previewing ? <PreviewDrawer t={t} v={previewing} onClose={() => set("preview")} /> : null}
      {target && canWrite ? <RollbackSheet t={t} v={target} onClose={() => set("rollback")} /> : null}
    </>
  )
}

function verSub(r: VersionRow, keys: Map<string, { name: string }>) {
  const by = actorName(r.createdBy, keys)
  const when = versionStamp(r.publishedAt ?? r.createdAt)
  const what =
    r.state === "draft"
      ? "Draft, not published"
      : r.state === "live"
        ? "Live"
        : r.state === "superseded"
          ? "Draft, replaced by a later version"
          : `Published ${versionStamp(r.publishedAt ?? r.createdAt).replace(/,.*$/, "")}`
  return `${what}${by ? ` · by ${by}` : ""} · ${when}`
}

function useRender(t: TemplateDetail, version: number | "published") {
  const samples = readSamples(t.id)
  return useQuery({
    queryKey: ["templates", t.id, "render", version, samples],
    queryFn: () =>
      unwrap(
        api.POST("/v1/templates/{id}/render", {
          params: { path: { id: t.id } },
          body: { version, data: samples as Record<string, never> },
        }),
      ),
    retry: false,
    staleTime: 60_000,
  })
}

function PreviewDrawer({ t, v, onClose }: { t: TemplateDetail; v: VersionRow; onClose: () => void }) {
  const r = useRender(t, v.version)
  return (
    <Drawer
      title={`v${v.version} · ${v.subject}`}
      sub={`POST /v1/templates/${t.id}/render { version: ${v.version} }`}
      wide
      onClose={onClose}
      odId="version-preview"
    >
      {r.isPending ? (
        <PanelSkeleton rows={8} />
      ) : r.isError ? (
        <PanelError error={r.error} onRetry={() => r.refetch()} what="This version didn’t render" />
      ) : (
        <div className="stack stack-12">
          <DeviceFrame
            html={r.data.html}
            subject={r.data.subject}
            from="Rendered with your sample values"
            title={`Preview of ${t.name} v${v.version}`}
            height={520}
          />
          {r.data.variables.missing.length ? (
            <p className="hint">
              Missing sample values: <span className="mono">{andList(r.data.variables.missing)}</span>; they
              show as raw placeholders.
            </p>
          ) : null}
        </div>
      )}
    </Drawer>
  )
}

function RollbackSheet({ t, v, onClose }: { t: TemplateDetail; v: VersionRow; onClose: () => void }) {
  const qc = useQueryClient()
  const published = t.publishedVersion === null ? null : Number(t.publishedVersion)
  const liveRow = t.versions.find((x) => Number(x.version) === published)
  const latest = Number(t.latestVersion)
  const old = useRender(t, v.version)
  const live = useRender(t, "published")
  const roll = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/templates/{id}/rollback", {
          params: { path: { id: t.id } },
          body: { version: v.version },
        }),
      ),
    onSuccess: (data) => {
      if (data) qc.setQueryData(templateQuery(t.id).queryKey, data)
      qc.invalidateQueries({ queryKey: ["templates"] })
      toast({
        title: `v${v.version} is live again`,
        sub: `Published as v${data?.publishedVersion ?? latest + 1}.`,
      })
      onClose()
    },
  })
  const changes = old.data && live.data ? varChanges(live.data.variables, old.data.variables) : null
  const apiError = roll.error instanceof ApiError ? roll.error : null
  return (
    <Sheet
      title={`Roll back to v${v.version}?`}
      sub={`v${v.version} is published again as v${latest + 1}. Every other version stays in history.`}
      onClose={onClose}
      odId="rollback-sheet"
      endpoint={`POST /v1/templates/${t.id}/rollback`}
      foot={
        <>
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => roll.mutate()}
            disabled={roll.isPending}
            data-autofocus=""
          >
            <Icon name="undo" />
            {roll.isPending ? "Rolling back…" : `Roll back to v${v.version}`}
          </button>
        </>
      }
    >
      <dl className="kv">
        <dt>Live now</dt>
        <dd>{liveRow ? `v${published} · “${liveRow.subject}”` : "Nothing is published"}</dd>
        <dt>After rollback</dt>
        <dd>
          v{latest + 1} · a copy of v{v.version}, “{v.subject}”
        </dd>
        <dt>Variables</dt>
        <dd>
          {old.data ? (
            old.data.variables.required.length ? (
              <span>
                v{v.version} needs <span className="mono">{andList(old.data.variables.required)}</span>
              </span>
            ) : (
              `v${v.version} needs no variables`
            )
          ) : old.isError ? (
            "Couldn’t render it to check"
          ) : (
            "Checking…"
          )}
        </dd>
      </dl>
      {t.hasUnpublishedChanges ? (
        <div className="callout callout-info">
          <Icon name="info" />
          <span>
            The unpublished draft v{latest} stays in history; it won’t be the latest version any more, so edit
            from the rolled-back copy.
          </span>
        </div>
      ) : null}
      {changes?.removed.length || changes?.nowRequired.length ? (
        <div className="callout callout-warn">
          <Icon name="warn" />
          <span>
            {changes.removed.length ? (
              <>
                v{v.version} doesn’t read <span className="mono">{andList(changes.removed)}</span>, which the
                live version does.{" "}
              </>
            ) : null}
            {changes.nowRequired.length ? (
              <>
                It requires <span className="mono">{andList(changes.nowRequired)}</span>; check your code
                sends {changes.nowRequired.length === 1 ? "it" : "them"}.
              </>
            ) : null}
          </span>
        </div>
      ) : null}
      {apiError ? (
        <div className="callout callout-error" role="alert">
          <Icon name="x-circle" />
          <span>
            <b>Not rolled back.</b> {apiError.message}
          </span>
          {apiError.requestId ? <RequestId id={apiError.requestId} /> : null}
        </div>
      ) : null}
    </Sheet>
  )
}
