/**
 * Publish (design: template-publish.html): what changes for every future send. The API keeps only the latest
 * version's source, so the comparison is between renders: the live version (`POST /v1/templates/{id}/render
 * { version: "published" }`) and the draft as it is on screen (`POST /v1/templates/preview`), both with your
 * sample values, line by line on the plain text, plus how the variables change.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ApiError, api, unwrap } from "../../api/client.ts"
import { Sheet } from "../../ops/Overlay.tsx"
import { toast } from "../../ops/toast.tsx"
import { Icon } from "../../ui/icons.tsx"
import { PanelSkeleton, RequestId } from "../../ui/Panel.tsx"
import { andList, lineDiff, varChanges, versionStamp } from "../logic.ts"
import { type TemplateDetail, templateQuery } from "../queries.ts"

export function PublishSheet({
  t,
  draft,
  dirty,
  saveFirst,
  samples,
  draftVersion,
  onClose,
}: {
  t: TemplateDetail
  draft: { subject: string; source: string; text: string }
  dirty: boolean
  saveFirst: () => Promise<unknown>
  samples: Record<string, string>
  draftVersion: number
  onClose: () => void
}) {
  const qc = useQueryClient()
  const published = t.publishedVersion === null ? null : Number(t.publishedVersion)
  const live = useQuery({
    queryKey: ["templates", t.id, "render", "published", samples],
    queryFn: () =>
      unwrap(
        api.POST("/v1/templates/{id}/render", {
          params: { path: { id: t.id } },
          body: { version: "published", data: samples as Record<string, never> },
        }),
      ),
    enabled: published !== null,
    retry: false,
  })
  const next = useQuery({
    queryKey: ["templates", t.id, "render", "draft", draft, samples],
    queryFn: () =>
      unwrap(
        api.POST("/v1/templates/preview", {
          body: {
            kind: t.kind,
            subject: draft.subject,
            source: draft.source,
            text: draft.text.trim() ? draft.text : null,
            data: samples as Record<string, never>,
          },
        }),
      ),
    retry: false,
  })
  const publish = useMutation({
    mutationFn: async () => {
      if (dirty) await saveFirst()
      const r = await api.POST("/v1/templates/{id}/publish", { params: { path: { id: t.id } } })
      return r.data
    },
    onSuccess: (data) => {
      if (data) qc.setQueryData(templateQuery(t.id).queryKey, data)
      qc.invalidateQueries({ queryKey: ["templates"] })
      toast({
        title: `v${data?.publishedVersion ?? draftVersion} of ${t.name} is live`,
        sub: "Every send from now on uses it.",
      })
      onClose()
    },
  })

  const liveVersion = t.versions.find((v) => Number(v.version) === published)
  const diff = live.data && next.data ? lineDiff(live.data.text, next.data.text) : null
  const changed =
    diff?.some((d) => d.kind !== "same") ||
    (live.data && next.data && live.data.subject !== next.data.subject)
  const vars = live.data && next.data ? varChanges(live.data.variables, next.data.variables) : null
  const apiError = publish.error instanceof ApiError ? publish.error : null

  return (
    <Sheet
      title={`Publish v${draftVersion} of ${t.name}?`}
      sub="You can roll back to any earlier version in one step."
      wide
      onClose={onClose}
      odId="publish-sheet"
      endpoint={`POST /v1/templates/${t.id}/publish`}
      foot={
        <>
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => publish.mutate()}
            disabled={publish.isPending}
            data-autofocus=""
          >
            <Icon name="upload" />
            {publish.isPending ? "Publishing…" : `Publish v${draftVersion}`}
          </button>
        </>
      }
    >
      <p>
        Every send of <span className="mono">{t.name}</span> from now on uses v{draftVersion}.
        {published !== null
          ? ` Sends already accepted keep v${published}.`
          : " It’s the first published version."}
        {dirty ? " Your latest edits are saved first." : ""}
      </p>
      {published === null ? null : live.isPending || next.isPending ? (
        <PanelSkeleton rows={4} />
      ) : live.isError || next.isError ? (
        <p className="hint">The comparison didn’t render, so it isn’t shown. Publishing still works.</p>
      ) : (
        <>
          {live.data && next.data && live.data.subject !== next.data.subject ? (
            <div className="diff">
              <div className="diff-side is-old">
                <span className="t-small">Subject, v{published}</span>
                <code>{live.data.subject}</code>
              </div>
              <div className="diff-side is-new">
                <span className="t-small">Subject, v{draftVersion}</span>
                <code>{next.data.subject}</code>
              </div>
            </div>
          ) : null}
          {diff && changed ? (
            <div className="diff">
              <div className="diff-side is-old">
                <span className="t-small">
                  v{published} · live
                  {liveVersion?.publishedAt ? ` since ${versionStamp(Number(liveVersion.publishedAt))}` : ""}
                </span>
                <code>
                  {diff
                    .filter((d) => d.kind === "del")
                    .map((d) => d.text)
                    .join("\n") || "(no lines removed)"}
                </code>
              </div>
              <div className="diff-side is-new">
                <span className="t-small">v{draftVersion} · draft</span>
                <code>
                  {diff
                    .filter((d) => d.kind === "add")
                    .map((d) => d.text)
                    .join("\n") || "(no lines added)"}
                </code>
              </div>
            </div>
          ) : (
            <p className="hint">
              The plain text renders the same with your sample values; the change is in the HTML.
            </p>
          )}
          {vars && (vars.added.length || vars.removed.length || vars.nowRequired.length) ? (
            <div className="callout callout-info">
              <Icon name="info" />
              <span>
                v{draftVersion}
                {vars.added.length ? (
                  <>
                    {" "}
                    adds <span className="mono">{andList(vars.added)}</span>
                  </>
                ) : null}
                {vars.removed.length ? (
                  <>
                    {vars.added.length ? "," : ""} stops reading{" "}
                    <span className="mono">{andList(vars.removed)}</span>
                  </>
                ) : null}
                {vars.nowRequired.length ? (
                  <>
                    {vars.added.length || vars.removed.length ? " and" : ""} makes{" "}
                    <span className="mono">{andList(vars.nowRequired)}</span> required
                  </>
                ) : null}
                . Check your code sends {vars.nowRequired.length ? "the required ones" : "them"} before you
                publish.
              </span>
            </div>
          ) : null}
          <p className="hint">Compared as plain text, rendered with your sample values.</p>
        </>
      )}
      {apiError ? (
        <div className="callout callout-error" role="alert">
          <Icon name="x-circle" />
          <span>
            <b>Not published.</b> {apiError.message}
          </span>
          {apiError.requestId ? <RequestId id={apiError.requestId} /> : null}
        </div>
      ) : null}
    </Sheet>
  )
}
