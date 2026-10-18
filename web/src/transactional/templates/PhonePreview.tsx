/**
 * The phone preview (design: template-preview-phone-dark.html): the latest version rendered with your sample
 * values, as a phone sees it in light and in dark mode. Dark mode is the receiver's, so both are worth a look.
 */
import { useQuery } from "@tanstack/react-query"
import { getRouteApi, Link } from "@tanstack/react-router"
import { api, unwrap } from "../../api/client.ts"
import { SampleMarker } from "../../ops/kit.tsx"
import { usePageTitle } from "../../shell/title.tsx"
import { Icon } from "../../ui/icons.tsx"
import { PanelError, PanelSkeleton } from "../../ui/Panel.tsx"
import { Crumbs } from "../Layout.tsx"
import { sampleData } from "../logic.ts"
import { templateQuery } from "../queries.ts"
import { DeviceFrame } from "./Preview.tsx"
import { readSamples } from "./samples.ts"

const route = getRouteApi("/_app/transactional/templates/$id/preview")

export function PhonePreview() {
  const { id } = route.useParams()
  const t = useQuery(templateQuery(id))
  const data = sampleData(readSamples(id))
  const r = useQuery({
    queryKey: ["templates", id, "render", "latest", data],
    queryFn: () =>
      unwrap(
        api.POST("/v1/templates/{id}/render", {
          params: { path: { id } },
          body: { version: "latest", data: data as Record<string, never> },
        }),
      ),
    retry: false,
  })
  usePageTitle(t.data ? `${t.data.name} preview` : "Template preview")
  const panel = (label: string, meta: string, dark: boolean, odId: string) => (
    <section className="panel" data-endpoint={`POST /v1/templates/${id}/render`} data-od-id={odId}>
      <header className="panel-head">
        <h2 className="panel-title">{label}</h2>
        <span className="panel-meta">{meta}</span>
      </header>
      <div className="panel-body">
        {r.isPending ? (
          <PanelSkeleton rows={8} />
        ) : r.isError ? (
          <PanelError error={r.error} onRetry={() => r.refetch()} what="The preview didn’t render" />
        ) : (
          <DeviceFrame
            html={r.data.html}
            subject={r.data.subject}
            from={`${t.data?.name ?? "Template"} · now`}
            device={dark ? "phone-dark" : "phone"}
            title={`Phone preview, ${dark ? "dark" : "light"} mode`}
            height={560}
          />
        )}
      </div>
    </section>
  )
  return (
    <>
      <div className="page-head" data-od-id="page-head">
        <div style={{ minWidth: 0 }}>
          <Crumbs
            items={[
              { to: "/transactional/messages", label: "Transactional" },
              { to: "/transactional/templates", label: "Templates" },
            ]}
          />
          <h1 data-od-id="page-title">
            <span className="mono" style={{ fontFamily: "var(--font-mono)", fontWeight: 400 }}>
              {t.data?.name ?? id}
            </span>{" "}
            preview
          </h1>
          <p className="sub">
            The same render as a phone sees it, light and dark. Dark mode is the receiver’s, so check contrast
            in both.
          </p>
        </div>
        <div className="cluster cluster-12">
          <SampleMarker />
          <Link className="btn btn-secondary" to="/transactional/templates/$id" params={{ id }}>
            <Icon name="chevron-left" />
            Back to editor
          </Link>
        </div>
      </div>
      <div className="split-even tx-phones">
        {panel("Phone · light", "375 px", false, "panel-phone-light")}
        {panel("Phone · dark", "375 px · prefers-color-scheme: dark", true, "panel-phone-dark")}
      </div>
    </>
  )
}
