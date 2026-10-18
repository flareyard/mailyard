/**
 * An object's own alert, shown on its screen (HANDOFF-audience §6 "Alerts", HAL-3364): the alert's title, its
 * severity, the exact kind string, how many times and when it last fired, its subject, and how it clears
 * (conditions by their sweep, notices by expiry). "In alerts" opens the shell's drawer (Shift+A).
 */
import { useQuery } from "@tanstack/react-query"
import { api, type paths, unwrap } from "../../api/client.ts"
import { fmtAgo, fmtInt } from "../../lib/format.ts"
import { Icon } from "../../ui/icons.tsx"

type AlertKind = NonNullable<NonNullable<paths["/v1/alerts"]["get"]["parameters"]["query"]>["kind"]>

const CLEARS: Partial<Record<AlertKind, string>> = {
  import_failed: "A notice: it expires after a week (resolvedBy: expired).",
  export_ready: "A notice: it expires after a day (resolvedBy: expired).",
  campaign_paused: "A condition: it clears when the campaign resumes (resolvedBy: sweep).",
  automation_failed:
    "A condition: it clears when the failed runs are retried or exited (resolvedBy: automations).",
}

const SEVERITY: Record<string, string> = { critical: "pill-fail", warning: "pill-warn", info: "pill-info" }

export function AlertRef({ kind, subjectId }: { kind: AlertKind; subjectId: string }) {
  const q = useQuery({
    queryKey: ["alerts", kind, "all"],
    queryFn: () => unwrap(api.GET("/v1/alerts", { params: { query: { kind, status: "all" } } })),
    staleTime: 30_000,
  })
  const a = q.data?.alerts.find((x) => x.subject?.id === subjectId && x.resolvedAt === null)
  if (!a) return null
  return (
    <div className="alert-ref" data-od-id={`alert-ref-${kind}`} data-endpoint={`GET /v1/alerts?kind=${kind}`}>
      <Icon name="bell" />
      <div className="grow">
        <div className="cluster cluster-4">
          <b>{a.title}</b>
          <span className={`pill ${SEVERITY[a.severity] ?? "pill-neutral"}`}>
            <span className="dot" />
            {a.severity.replace(/^./, (c) => c.toUpperCase())}
          </span>
        </div>
        <span className="ar-meta">
          <code className="mono">{a.kind}</code> · {fmtInt(a.count)}× · updated {fmtAgo(a.updatedAt)}
          {a.subject ? (
            <>
              {" "}
              · subject <code className="mono">{`{type: "${a.subject.type}", id: "${a.subject.id}"}`}</code>
            </>
          ) : null}
        </span>
        {CLEARS[a.kind] ? <span className="ar-meta">{CLEARS[a.kind]}</span> : null}
      </div>
      <button
        className="btn btn-ghost btn-sm"
        type="button"
        onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "A", shiftKey: true }))}
      >
        In alerts
      </button>
    </div>
  )
}
