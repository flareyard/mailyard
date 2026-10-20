/**
 * Step 4, checks (design: campaign-checks.html, campaign-blocked.html, -blocked-sender, -checks-new-domain;
 * GAPS-audience A7.8). `GET /v1/campaigns/{id}/checks`: ready or blocked, then each check with the API's title,
 * id and detail. The fix button reads `fix.label` and goes where `fix.target` says: a content field focused,
 * the audience, Settings → Tracking and compliance, or the domain. `unsubscribe` has no fix, and says why.
 * Fixes outside the campaign need an owner or admin; for anyone else they stay visible with who can.
 */
import { useQuery } from "@tanstack/react-query"
import { useRouter } from "@tanstack/react-router"
import { useCan, useNow } from "../../audience/kit/ui.tsx"
import { Gated } from "../../auth/NoPermission.tsx"
import { fmtAgo } from "../../lib/format.ts"
import { Icon, type IconName } from "../../ui/icons.tsx"
import { PanelError } from "../../ui/Panel.tsx"
import { checksSummary, fixHref, fixPermission, readySentence } from "../logic.ts"
import { type Check, checksQuery, complianceQuery } from "../queries.ts"
import { AppLink } from "../ui.tsx"
import { useEditor } from "./EditorContext.tsx"
import { EditorFrame } from "./EditorFrame.tsx"

const ICON: Record<Check["status"], { icon: IconName; cls: string }> = {
  pass: { icon: "check-circle", cls: "status-pass" },
  warn: { icon: "warn", cls: "status-warn" },
  fail: { icon: "x-circle", cls: "status-fail" },
}

export function ChecksStep(_: { focus?: string | undefined }) {
  const ed = useEditor()
  const q = useQuery(checksQuery(ed.id))
  const now = useNow(10_000)
  const data = q.data && "checks" in q.data ? q.data : null
  const sum = data ? checksSummary(data.checks) : null
  const ready = sum ? readySentence(sum) : null
  return (
    <EditorFrame step="checks">
      <div className="editor cmp-editor">
        <div className="stack">
          <section
            className={`panel${q.isError ? " is-error" : ""}`}
            data-endpoint={`GET /v1/campaigns/${ed.id}/checks → checks[{id, status, title, detail, fix}]`}
            data-od-id="panel-checks"
            aria-labelledby="h-checks"
            aria-busy={q.isFetching}
          >
            <header className="panel-head">
              <h2 className="panel-title" id="h-checks">
                Pre-flight checks
              </h2>
              <div className="cluster">
                {q.dataUpdatedAt ? (
                  <span className="panel-meta">Checked {fmtAgo(q.dataUpdatedAt, now)}</span>
                ) : null}
                <button
                  className={`btn btn-ghost btn-sm${q.isFetching ? " is-loading" : ""}`}
                  type="button"
                  onClick={async () => {
                    if (ed.editable && ed.state === "dirty") await ed.flush()
                    void q.refetch()
                  }}
                >
                  <Icon name="refresh" />
                  Re-check
                </button>
              </div>
            </header>
            <div className="panel-body">
              {q.isPending ? (
                <div className="stack stack-8" aria-hidden="true">
                  <span className="sk sk-title" />
                  {Array.from({ length: 8 }, (_, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows
                    <span key={i} className="sk sk-text" />
                  ))}
                </div>
              ) : q.isError || !data || !sum || !ready ? (
                <PanelError error={q.error} onRetry={() => q.refetch()} what="The checks didn’t run" />
              ) : (
                <div className="stack">
                  <div
                    className={`ready ${sum.ready ? "is-ready" : "is-blocked"}`}
                    role={sum.ready ? "status" : "alert"}
                  >
                    <Icon name={sum.ready ? "check-circle" : "octagon"} />
                    <div>
                      <div className="r-title">{ready.title}</div>
                      <div className="r-sub">{ready.sub}</div>
                    </div>
                  </div>
                  <ul className="checks" data-od-id="preflight-checks">
                    {data.checks.map((c) => (
                      <CheckRow key={c.id} c={c} campaignId={ed.id} />
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </section>
        </div>
        <div className="side">
          <FooterPanel />
        </div>
      </div>
    </EditorFrame>
  )
}

function CheckRow({ c, campaignId }: { c: Check; campaignId: string }) {
  const router = useRouter()
  const perm = c.fix ? fixPermission(c.fix) : "campaigns.write"
  const can = useCan(perm, perm === "campaigns.write" ? "edit campaigns" : "change settings and domains")
  const ic = ICON[c.status]
  const primary = c.status !== "pass"
  return (
    <li className={`chk is-${c.status}`}>
      <Icon
        name={ic.icon}
        className={`status-icon ${ic.cls}`}
        label={c.status === "pass" ? "Passes" : c.status === "warn" ? "Warning" : "Fails"}
      />
      <span className="chk-title">
        {c.title}
        <code className="mono chk-id">{c.id}</code>
      </span>
      {c.fix ? (
        <span className="chk-fix">
          <Gated
            allowed={can.allowed}
            reason={
              perm === "campaigns.write" ? "You can’t edit campaigns" : "Only owners and admins change this"
            }
            who={perm === "campaigns.write" ? can.who : "Settings and domains are for owners and admins."}
            side="right"
          >
            <button
              className={`btn ${primary ? "btn-secondary" : "btn-ghost"} btn-sm`}
              type="button"
              data-fix-target={c.fix.target}
              data-fix-field={c.fix.field}
              onClick={() => {
                if (!c.fix) return
                router.history.push(fixHref(campaignId, c.fix))
              }}
            >
              {c.fix.label}
              <Icon name="chevron-right" />
            </button>
          </Gated>
        </span>
      ) : (
        <span className="chk-fix chk-nofix" data-od-id={`${c.id}-nofix`}>
          Nothing to fix
        </span>
      )}
      <span className="chk-detail">
        {c.detail}
        {c.id === "unsubscribe" && !c.fix ? (
          <span className="chk-why">
            {" "}
            Mailyard always adds the one-click headers, and the footer when your content has no link to the
            preference page. It’s required, so it can’t be removed or turned off.
          </span>
        ) : null}
      </span>
    </li>
  )
}

function FooterPanel() {
  const ed = useEditor()
  const compliance = useQuery(complianceQuery)
  const addr = compliance.data?.postalAddress
  const reason =
    ed.draft.bodyBlocks?.footer.reason ?? "You’re getting this because you subscribed to this topic."
  return (
    <section
      className="panel"
      data-endpoint="GET /v1/settings/compliance"
      data-od-id="panel-footer"
      aria-labelledby="h-footer"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-footer">
          Compliance footer
        </h2>
      </header>
      <div className="panel-body">
        <div className="paper" style={{ padding: 12 }}>
          <div className="paper-inner" style={{ padding: 0 }}>
            <div
              className={`footer-lock${compliance.data && !addr ? " is-missing" : ""}`}
              data-od-id="unsubscribe-footer"
            >
              <span className="fl-tag">
                <Icon name="lock" />
                Unsubscribe footer · always on
              </span>
              <span>{reason}</span>
              <p style={{ margin: 0 }}>
                Changed your mind? <span className="cmp-link-like">Unsubscribe</span> ·{" "}
                <span className="cmp-link-like">Manage your topics</span>
              </p>
              <span className="fl-addr">
                {compliance.isPending ? "…" : (addr ?? "No postal address set")}
              </span>
              <span className="hint">
                <AppLink className="link" href="/settings/tracking?field=postalAddress">
                  {addr ? "Edit in Settings" : "Set it in Settings"}
                </AppLink>
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
