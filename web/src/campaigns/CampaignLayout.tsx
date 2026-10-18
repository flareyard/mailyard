/**
 * `/campaigns/:id`: loads the campaign once for every view under it and holds the editor's unsaved edits, so
 * moving between steps keeps them. The index opens where the campaign is (HANDOFF-audience §3): a draft's
 * editor, a scheduled campaign's schedule, the sending view while it sends or is paused, the report after.
 */
import "./campaigns.css"
import { Navigate, Outlet, useParams } from "@tanstack/react-router"
import { ApiError } from "../api/client.ts"
import { BackLink, SampleMarker } from "../audience/kit/ui.tsx"
import { Icon } from "../ui/icons.tsx"
import { PanelError } from "../ui/Panel.tsx"
import { CampaignEditorProvider, useCampaign } from "./editor/EditorContext.tsx"
import { landingFor } from "./logic.ts"
import { SendingView } from "./sending/SendingView.tsx"

export function CampaignLayout({ id }: { id: string }) {
  const q = useCampaign(id)
  if (q.isPending) return <EditorSkeleton />
  if (q.isError || !q.data || !("id" in q.data)) {
    const notFound = q.error instanceof ApiError && q.error.status === 404
    return (
      <>
        <BackLink to="/campaigns">Campaigns</BackLink>
        <section className="panel is-error" data-endpoint={`GET /v1/campaigns/${id}`} aria-label="Campaign">
          <div className="panel-body">
            {notFound ? (
              <div className="empty" data-od-id="empty-state">
                <span className="empty-icon">
                  <Icon name="campaigns" />
                </span>
                <h3>No campaign with this id</h3>
                <p>
                  <code className="mono">{id}</code> doesn’t exist in this workspace. It may have been a draft
                  that was deleted.
                </p>
              </div>
            ) : (
              <PanelError error={q.error} onRetry={() => q.refetch()} what="This campaign didn’t load" />
            )}
          </div>
        </section>
      </>
    )
  }
  return (
    <CampaignEditorProvider key={q.data.id} campaign={q.data}>
      <Outlet />
    </CampaignEditorProvider>
  )
}

export function CampaignLanding() {
  const { campaignId } = useParams({ from: "/_app/campaigns/$campaignId/" })
  const q = useCampaign(campaignId)
  if (!q.data || !("status" in q.data)) return null
  const to = landingFor(q.data.status)
  if (to === "sending") return <SendingView campaign={q.data} />
  return <Navigate to={`/campaigns/$campaignId/${to}`} params={{ campaignId }} replace />
}

/** The editor in its final layout while the campaign loads (campaign-editor-loading.html). */
export function EditorSkeleton() {
  const lines = (widths: number[]) => (
    <div className="stack stack-12">
      {widths.map((w, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder lines
        <span key={i} className="sk sk-text" style={{ width: `${w}%` }} />
      ))}
    </div>
  )
  return (
    <div aria-busy="true">
      <BackLink to="/campaigns">Campaigns</BackLink>
      <div className="obj-head" data-od-id="object-head">
        <div className="oh-main">
          <h1 data-od-id="page-title">
            <span
              className="sk sk-title"
              style={{ width: "min(320px, 80%)", height: 24, display: "block" }}
            />
          </h1>
          <div className="oh-sub">
            <span className="sk sk-text" style={{ width: 240 }} />
          </div>
        </div>
        <div className="oh-actions">
          <SampleMarker />
        </div>
      </div>
      <ol className="hsteps" aria-label="Campaign steps" data-od-id="editor-steps">
        {["Content", "Audience", "Preview", "Checks", "Schedule"].map((s, i) => (
          <li key={s} className="hstep">
            <span>
              <span className="hs-ic">{i + 1}</span>
              {s}
            </span>
          </li>
        ))}
      </ol>
      <div className="editor cmp-editor">
        <div className="stack">
          <section className="panel" aria-busy="true">
            <header className="panel-head">
              <h2 className="panel-title">Envelope</h2>
            </header>
            <div className="panel-body">{lines([100, 86, 92, 70, 80])}</div>
          </section>
          <section className="panel" aria-busy="true">
            <header className="panel-head">
              <h2 className="panel-title">Body</h2>
            </header>
            <div className="panel-body">
              <div className="paper">
                <div className="paper-inner" style={{ padding: 24 }}>
                  {lines([100, 86, 92, 70, 80, 60, 75, 100, 86])}
                </div>
              </div>
            </div>
          </section>
        </div>
        <div className="side">
          <section className="panel" aria-busy="true">
            <header className="panel-head">
              <h2 className="panel-title">Merge fields</h2>
            </header>
            <div className="panel-body">{lines([100, 86, 92])}</div>
          </section>
          <section className="panel" aria-busy="true">
            <header className="panel-head">
              <h2 className="panel-title">Compliance</h2>
            </header>
            <div className="panel-body">{lines([100, 86, 92, 70])}</div>
          </section>
        </div>
      </div>
    </div>
  )
}
