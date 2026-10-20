/**
 * One suppression (design: suppression-detail, -complaint, -unsubscribe, -push-errors): why it's blocked, the
 * contact it changed and what Cloudflare holds for it. Edit, push and a guarded remove; a complaint's Remove
 * stays off with the reason, and the API refuses it too (409 `complaint`).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router"
import { ApiError, api, unwrap } from "../../api/client.ts"
import { utcShort } from "../../ops/format.ts"
import { BuiltPill, SampleMarker, Time } from "../../ops/kit.tsx"
import { toast } from "../../ops/toast.tsx"
import { Icon } from "../../ui/icons.tsx"
import { PanelError, PanelSkeleton, RequestId } from "../../ui/Panel.tsx"
import { AdminOnly, Pill } from "../keys/ui.tsx"
import { Crumbs } from "../Layout.tsx"
import { blocksLabel, bulkOnlyFixed, CF, pushBlocked, REASON, removeBlocked, SOURCE } from "./logic.ts"
import { type SupSearch, supQuery, supsQuery } from "./queries.ts"
import { EditSheet, keepRemoval, RemoveSheet } from "./SupSheets.tsx"
import "../keys/keys.css"

const route = getRouteApi("/_app/transactional/suppressions/$email")

export function SuppressionDetail() {
  const { email } = route.useParams()
  const search = route.useSearch()
  const navigate = route.useNavigate()
  const go = useNavigate()
  const qc = useQueryClient()
  const q = useQuery(supQuery(email))
  // The Cloudflare connection state rides on the list call; one row is enough to read it.
  const list = useQuery(supsQuery({ q: email }))
  const fixture = {
    ...(search.state ? { state: search.state } : {}),
    ...(search.as ? { as: search.as } : {}),
  }
  const set = (sheet?: SupSearch["sheet"]) =>
    navigate({
      search: (p) => {
        const { sheet: _s, ...rest } = p
        return sheet ? { ...rest, sheet } : rest
      },
    })
  const push = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/suppressions/{email}/push", { params: { path: { email } } })),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["suppressions"] })
      toast({
        title:
          r.cloudflare.state === "already-listed" ? "Already on Cloudflare’s list" : "Pushed to Cloudflare",
        sub: "Every sender on the account is blocked from this address, SMTP included.",
      })
    },
  })

  const head = (title: string, sub?: React.ReactNode, actions?: React.ReactNode) => (
    <div className="page-head" data-od-id="page-head">
      <div style={{ minWidth: 0 }}>
        <Crumbs
          items={[
            { to: "/transactional/messages", label: "Transactional" },
            { to: "/transactional/suppressions", label: "Suppressions", search: fixture },
          ]}
        />
        <h1 data-od-id="page-title" className="mono-title">
          {title}
        </h1>
        {sub ? <p className="sub">{sub}</p> : null}
      </div>
      <div className="cluster cluster-12">
        <SampleMarker />
        {actions}
      </div>
    </div>
  )

  if (q.isPending)
    return (
      <>
        {head(email)}
        <PanelSkeleton rows={6} />
      </>
    )
  if (q.isError) {
    const gone = q.error instanceof ApiError && q.error.status === 404
    return (
      <>
        {head(email)}
        {gone ? (
          <div className="empty">
            <span className="empty-icon">
              <Icon name="check-circle" />
            </span>
            <h3>Not suppressed</h3>
            <p>
              <span className="mono">{email}</span> isn’t on the list, so mail can reach it.
            </p>
            <Link className="btn btn-secondary" to="/transactional/suppressions" search={fixture}>
              Back to suppressions
            </Link>
          </div>
        ) : (
          <PanelError error={q.error} onRetry={() => q.refetch()} what="This suppression didn’t load" />
        )}
      </>
    )
  }

  const s = q.data
  const cf = list.data?.cloudflare
  const rm = removeBlocked(s)
  const pb = pushBlocked(s, cf)
  const showPush = s.cloudflare !== "in-sync"
  return (
    <>
      {head(
        s.email,
        <>
          <Pill tone={REASON[s.reason].tone}>{REASON[s.reason].label}</Pill> · {blocksLabel(s)} ·{" "}
          <Pill tone={CF[s.cloudflare].tone}>{CF[s.cloudflare].label}</Pill>
        </>,
        <>
          {showPush ? (
            <AdminOnly allowed={!pb} reason={pb?.reason ?? ""} who={pb?.who ?? ""} side="right">
              <button
                className="btn btn-secondary"
                type="button"
                aria-disabled={push.isPending}
                onClick={() => !push.isPending && push.mutate()}
                data-endpoint="POST /v1/suppressions/{email}/push (built, HAL-3372)"
              >
                <Icon name="upload" />
                {push.isPending ? "Pushing…" : "Push to Cloudflare"}
              </button>
            </AdminOnly>
          ) : null}
          <button
            className="btn btn-secondary"
            type="button"
            onClick={() => set("edit")}
            data-endpoint="PATCH /v1/suppressions/{email} (built, HAL-3372)"
          >
            <Icon name="pencil" />
            Edit
          </button>
          <AdminOnly allowed={!rm} reason={rm?.reason ?? ""} who={rm?.who ?? ""} side="right">
            <button
              className="btn btn-danger-ghost"
              type="button"
              onClick={() => set("remove")}
              data-endpoint="DELETE /v1/suppressions/{email} { confirm: true } (built, HAL-3372)"
            >
              <Icon name="trash" />
              Remove
            </button>
          </AdminOnly>
        </>,
      )}
      {push.error ? <PushRefusal error={push.error} onRetry={() => push.mutate()} /> : null}
      <div className="split-2">
        <div className="stack">
          <section
            className="panel"
            data-endpoint="GET /v1/suppressions/{email} (built, HAL-3372)"
            data-od-id="panel-detail"
            aria-labelledby="h-detail"
          >
            <header className="panel-head">
              <h2 className="panel-title" id="h-detail">
                Suppression
              </h2>
              <div className="cluster">
                <BuiltPill issue="HAL-3372" />
              </div>
            </header>
            <div className="panel-body">
              {s.reason === "complaint" ? (
                <div className="callout callout-error" style={{ marginBottom: 12 }}>
                  <Icon name="octagon" />
                  <span>
                    <b>A complaint can never be removed.</b> Gmail and Yahoo require it. To let transactional
                    mail (receipts, password resets) reach this person again, set Bulk only: campaigns and
                    automations stay blocked. The API refuses it too: <span className="mono">DELETE</span>{" "}
                    answers <span className="mono">{'409 { _tag: "Conflict", reason: "complaint" }'}</span>.
                  </span>
                </div>
              ) : bulkOnlyFixed(s) ? (
                <div className="callout callout-info" style={{ marginBottom: 12 }}>
                  <Icon name="info" />
                  <span>
                    <b>Bulk only, always.</b> An unsubscribe stops campaigns and automations; receipts and
                    password resets still arrive. To block everything, add a manual suppression.
                  </span>
                </div>
              ) : null}
              <dl className="kv">
                <dt>Reason</dt>
                <dd>
                  <Pill tone={REASON[s.reason].tone}>{REASON[s.reason].label}</Pill>
                </dd>
                <dt>Source</dt>
                <dd>{SOURCE[s.source]}</dd>
                <dt>Blocks</dt>
                <dd>{blocksLabel(s)}</dd>
                <dt>Message</dt>
                <dd>
                  {s.messageId ? (
                    <Link className="link mono" to="/transactional/messages/$id" params={{ id: s.messageId }}>
                      {s.messageId}
                    </Link>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </dd>
                <dt>Note</dt>
                <dd>{s.note ?? <span className="muted">None</span>}</dd>
                <dt>Contact</dt>
                <dd>
                  {s.contact ? (
                    <>
                      {/* Audience owns the contact page; a plain link so it works whichever branch lands first. */}
                      <a
                        className="link mono"
                        href={`/audience/contacts/${encodeURIComponent(s.contact.id)}`}
                      >
                        {s.contact.id}
                      </a>{" "}
                      · now {s.contact.status}
                    </>
                  ) : (
                    <span className="muted">No contact with this address</span>
                  )}
                </dd>
                <dt>Status before</dt>
                <dd>
                  {s.contactStatusBefore ?? <span className="muted">—</span>}{" "}
                  <span className="muted t-small">· restored if the suppression is removed</span>
                </dd>
                <dt>Added</dt>
                <dd>
                  <Time value={s.at} mode="full" />
                </dd>
                <dt>Updated</dt>
                <dd>
                  <Time value={s.updatedAt} mode="full" />
                </dd>
              </dl>
            </div>
          </section>
        </div>
        <div className="stack">
          <section
            className="panel"
            data-endpoint="GET /v1/suppressions/{email} → cloudflareEntries (built, HAL-3372)"
            data-od-id="panel-cf-entries"
            aria-labelledby="h-cf-entries"
          >
            <header className="panel-head">
              <h2 className="panel-title" id="h-cf-entries">
                On Cloudflare
              </h2>
              <div className="cluster">
                <BuiltPill issue="HAL-3372" />
              </div>
            </header>
            <div className="panel-body">
              <div className="stack stack-12">
                <div>
                  <Pill tone={CF[s.cloudflare].tone}>{CF[s.cloudflare].label}</Pill>
                </div>
                {s.cloudflareEntries === null ? (
                  <p className="muted">
                    {cf && !cf.readable
                      ? "Cloudflare isn’t connected, so Mailyard can’t see its entries for this address."
                      : "Not checked yet."}
                  </p>
                ) : s.cloudflareEntries.length ? (
                  <ul className="list">
                    {s.cloudflareEntries.map((e) => (
                      <li key={e.id} className="list-row">
                        <span className="grow">
                          <span className="row-title mono">{e.id}</span>
                          <span className="row-sub">
                            {REASON[e.reason as keyof typeof REASON]?.label ?? e.reason} · scope {e.scope} ·{" "}
                            {e.expiresAt ? `expires ${utcShort(e.expiresAt)}` : "permanent"}
                          </span>
                        </span>
                        {e.readOnly ? <span className="pill pill-neutral">Read only</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">Cloudflare has no entry for this address.</p>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
      {search.sheet === "edit" ? <EditSheet s={s} onClose={() => set()} /> : null}
      {search.sheet === "remove" && !rm ? (
        <RemoveSheet
          s={s}
          onClose={() => set()}
          onRemoved={(r) => {
            keepRemoval(r)
            go({ to: "/transactional/suppressions", search: fixture })
          }}
        />
      ) : null}
    </>
  )
}

/** Push refused: 409 not-applicable, 409 CloudflareNotConnected or 502 CloudflareRefused, each in its words. */
function PushRefusal({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const e = error instanceof ApiError ? error : null
  const tag = e?.body._tag
  const title =
    e?.status === 409 && e.body.reason === "not-applicable"
      ? "409 Conflict · not-applicable"
      : tag === "CloudflareNotConnected"
        ? "409 CloudflareNotConnected"
        : tag === "CloudflareRefused"
          ? "502 CloudflareRefused"
          : `${e?.status ?? "Network"} ${tag ?? "error"}`
  const text =
    e?.status === 409 && e.body.reason === "not-applicable"
      ? "This row only blocks bulk mail (or is an unsubscribe), so it isn’t pushed: Cloudflare’s list would block transactional mail too."
      : tag === "CloudflareNotConnected"
        ? "There’s no Cloudflare write token, so Mailyard can’t add to the account list. Connect one in Settings → Sending."
        : tag === "CloudflareRefused"
          ? `Cloudflare refused the entry: “${e?.message}”. Nothing changed in Mailyard.`
          : (e?.message ?? "Mailyard couldn’t be reached.")
  return (
    <div className="error-block" role="alert" style={{ marginBottom: 16 }} data-od-id="panel-push-errors">
      <h3>
        <Icon name="warn" />
        {title}
      </h3>
      <p>{text}</p>
      <div className="cluster">
        <button className="btn btn-secondary btn-sm" type="button" onClick={onRetry}>
          <Icon name="refresh" className="icon-12" />
          Try again
        </button>
        {e?.requestId ? <RequestId id={e.requestId} /> : null}
      </div>
    </div>
  )
}
