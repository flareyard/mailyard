/**
 * One webhook endpoint (design: webhook-detail, webhook-dead-letters, webhook-delivery, webhook-paused,
 * webhook-test-sample;
 * HANDOFF-ops §22, §33): its deliveries with a status filter and paging, each delivery's attempts in a drawer,
 * replay one or every dead letter, test, rotate the secret, disable. Pause delivery and the request-id echo
 * (HAL-3464): Pause holds deliveries and sends them oldest first on resume; Disable drops them.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { getRouteApi, Link } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { api, unwrap } from "../../api/client.ts"
import { fmtIn, fmtInt, num } from "../../lib/format.ts"
import { CodeBlock, CopyChip } from "../../ops/Copy.tsx"
import { fmtDuration, utcDate, utcTime } from "../../ops/format.ts"
import { BuiltPill, SampleMarker, Time } from "../../ops/kit.tsx"
import { Drawer } from "../../ops/Overlay.tsx"
import { toast } from "../../ops/toast.tsx"
import { Icon, type IconName } from "../../ui/icons.tsx"
import { Panel, PanelError, PanelSkeleton } from "../../ui/Panel.tsx"
import { AdminOnly, Pill, useIsAdmin } from "../keys/ui.tsx"
import { Crumbs } from "../Layout.tsx"
import {
  attemptTrail,
  type DeliveryLike,
  deliveryHeaders,
  type Filter,
  filterSummary,
  HEALTH_PILL,
  MAX_ATTEMPTS,
  STATUS_PILL,
  VERIFY_SNIPPET,
  webhookHealth,
} from "./logic.ts"
import { type DeliveryFilter, deliveriesQuery, type HookSearch, hookQuery, hooksQuery } from "./queries.ts"
import {
  EndpointSheet,
  RemoveEndpointSheet,
  ReplaySheet,
  RotateSecretSheet,
  TestSheet,
} from "./WebhookSheets.tsx"
import "../keys/keys.css"

const route = getRouteApi("/_app/transactional/webhooks/$id")

export function WebhookDetail() {
  const { id } = route.useParams()
  const search = route.useSearch()
  const navigate = route.useNavigate()
  const { admin } = useIsAdmin()
  const qc = useQueryClient()
  const hook = useQuery(hookQuery(id))
  const list = useQuery(hooksQuery)
  const deliveries = useQuery(deliveriesQuery(id, search.status, search.cursor))

  const set = (patch: { [K in keyof HookSearch]?: HookSearch[K] | undefined }) =>
    navigate({
      search: (p) => {
        const next: Record<string, unknown> = { ...p, ...patch }
        for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k]
        return next as HookSearch
      },
    })

  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      unwrap(api.PATCH("/v1/webhooks/{id}", { params: { path: { id } }, body: { enabled } })),
    onSuccess: async (w) => {
      await qc.invalidateQueries({ queryKey: ["webhooks"] })
      toast({
        title: w.enabled ? "Endpoint enabled" : "Endpoint disabled",
        sub: w.enabled ? "New events go to it again." : "New events for it are dropped until you enable it.",
      })
    },
    onError: (e) =>
      toast({ title: "That didn’t change", sub: e instanceof Error ? e.message : undefined, tone: "bad" }),
  })
  const pause = useMutation({
    mutationFn: (paused: boolean) =>
      unwrap(api.PATCH("/v1/webhooks/{id}", { params: { path: { id } }, body: { paused } })),
    onSuccess: async (_w, paused) => {
      await qc.invalidateQueries({ queryKey: ["webhooks"] })
      toast({
        title: paused ? "Delivery paused" : "Delivery resumed",
        sub: paused
          ? "Events queue up and go out in order when you resume."
          : "Queued events go out in order.",
      })
    },
  })

  if (hook.isPending)
    return (
      <div className="stack stack-16">
        <PanelSkeleton rows={2} />
        <PanelSkeleton rows={6} />
      </div>
    )
  if (hook.isError)
    return (
      <>
        <DetailHead title="Webhook endpoint" />
        <PanelError error={hook.error} onRetry={() => hook.refetch()} what="This endpoint didn’t load" />
      </>
    )

  const w = hook.data
  const health = webhookHealth(w)
  const pill = HEALTH_PILL[health]
  const dead = num(w.deadLetters) ?? 0
  const paused = w.paused
  const held = num(w.held) ?? 0
  const selected = search.delivery
    ? deliveries.data?.deliveries.find((d) => d.id === search.delivery)
    : undefined
  const close = () => set({ sheet: undefined })
  const deny = "Senders can’t change webhooks"
  const who = "Owners and admins manage webhooks."

  return (
    <>
      <DetailHead
        title={w.url}
        sub={
          <>
            {w.description ?? "No description"} ·{" "}
            {paused ? (
              <Pill tone="pill-neutral">Paused</Pill>
            ) : health === "failing" && w.lastFailureAt ? (
              <Pill tone="pill-fail">Failing since {utcTime(w.lastFailureAt)}</Pill>
            ) : (
              <Pill tone={pill.tone}>{pill.label}</Pill>
            )}
            {dead ? (
              <>
                {" "}
                ·{" "}
                <Link
                  className="dead-badge"
                  to="/transactional/webhooks/$id"
                  params={{ id }}
                  search={{ status: "dead" }}
                >
                  <Icon name="warn" className="icon-12" />
                  {fmtInt(dead)} dead letter{dead === 1 ? "" : "s"}
                </Link>
              </>
            ) : null}
          </>
        }
        actions={
          <>
            <AdminOnly allowed={admin} reason={deny} who={who}>
              <button
                className="btn btn-ghost"
                type="button"
                onClick={() => set({ sheet: "rotate" })}
                data-endpoint={`POST /v1/webhooks/${id}/rotate-secret`}
              >
                <Icon name="key" />
                Rotate secret
              </button>
            </AdminOnly>
            <AdminOnly allowed={admin} reason={deny} who={who}>
              <button
                className={paused ? "btn btn-primary" : "btn btn-secondary"}
                type="button"
                aria-disabled={pause.isPending}
                onClick={() => !pause.isPending && pause.mutate(!paused)}
                title={
                  paused
                    ? "Send the held deliveries, oldest first"
                    : "Hold deliveries and send them when you resume"
                }
                data-endpoint={`PATCH /v1/webhooks/${id} { paused: ${!paused} } (built, HAL-3464)`}
              >
                <Icon name={paused ? "play" : "pause"} />
                {paused ? "Resume delivery" : "Pause delivery"}
              </button>
            </AdminOnly>
            <AdminOnly allowed={admin} reason={deny} who={who}>
              <button
                className="btn btn-ghost"
                type="button"
                aria-disabled={toggle.isPending}
                onClick={() => !toggle.isPending && toggle.mutate(!w.enabled)}
                title={w.enabled ? "Stop and drop events until enabled again" : "Send events to it again"}
                data-endpoint={`PATCH /v1/webhooks/${id} { enabled: ${!w.enabled} }`}
              >
                <Icon name={w.enabled ? "ban" : "check-circle"} />
                {w.enabled ? "Disable" : "Enable"}
              </button>
            </AdminOnly>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => set({ sheet: "test" })}
              data-endpoint={`POST /v1/webhooks/${id}/test`}
            >
              <Icon name="send" />
              Send a test event
            </button>
          </>
        }
      />
      {paused ? (
        <div className="callout callout-info" style={{ marginBottom: 12 }} data-od-id="webhook-paused">
          <Icon name="pause" />
          <span>
            <b>Delivery is paused.</b>{" "}
            {held
              ? `${fmtInt(held)} deliver${held === 1 ? "y is" : "ies are"} held`
              : "New deliveries are held"}{" "}
            and go out oldest first when you resume. Test events still go out. To drop events instead, Disable
            it.
          </span>
        </div>
      ) : null}
      {!w.enabled ? (
        <div className="callout callout-warn" style={{ marginBottom: 12 }}>
          <Icon name="ban" />
          <span>
            <b>This endpoint is disabled.</b> New events for it are dropped, not queued. Enable it to start
            again.
          </span>
        </div>
      ) : null}
      <div className="split-2">
        <div className="stack">
          <Panel
            id="deliveries"
            title="Deliveries"
            endpoint={`GET /v1/webhooks/${id}/deliveries?status=${search.status ?? ""}&cursor= · POST …/replay`}
            query={deliveries}
            meta={
              <span className="cluster">
                {search.status === "dead" ? <BuiltPill issue="HAL-3416" /> : null}
                <StatusFilter
                  value={search.status}
                  dead={dead}
                  onChange={(status) => set({ status, cursor: undefined, delivery: undefined })}
                />
              </span>
            }
            isEmpty={(d) => d.deliveries.length === 0}
            empty={
              <p className="muted t-small">
                {search.status === "dead"
                  ? "No dead letters. Everything that failed was retried and delivered, or is still retrying."
                  : search.status
                    ? `No ${STATUS_PILL[search.status].label.toLowerCase()} deliveries.`
                    : "No deliveries yet. Send a test event to see one here."}
              </p>
            }
          >
            {(d) => (
              <>
                {search.status === "dead" && dead ? (
                  <>
                    <div className="callout callout-error" style={{ marginBottom: 12 }}>
                      <Icon name="warn" />
                      <span>
                        <b>
                          {fmtInt(dead)} event{dead === 1 ? "" : "s"} gave up after {MAX_ATTEMPTS} attempts.
                        </b>{" "}
                        Your endpoint didn’t answer 2xx on any try. Fix it, send a test event, then replay
                        them all.
                      </span>
                    </div>
                    <div className="cluster tb-between" style={{ marginBottom: 12 }}>
                      <p className="hint" style={{ margin: 0 }} data-od-id="replay-help">
                        Replay all calls{" "}
                        <span className="mono">POST …/deliveries/replay {'{ status: "dead" }'}</span>, which
                        replays up to <b>500 a call</b> in the order they died and answers{" "}
                        <span className="mono">{"{ replayed, remaining }"}</span>. The app calls again while{" "}
                        <span className="mono">remaining</span> is above 0.
                      </p>
                      <AdminOnly allowed={admin} reason="Senders can’t replay dead letters" who={who}>
                        <button
                          className="btn btn-secondary btn-sm"
                          type="button"
                          onClick={() => set({ sheet: "replay" })}
                          data-endpoint={`POST /v1/webhooks/${id}/deliveries/replay { status: dead } (loops while remaining > 0)`}
                        >
                          <Icon name="replay" className="icon-12" />
                          Replay all dead letters
                        </button>
                      </AdminOnly>
                    </div>
                  </>
                ) : null}
                <div className="table-wrap rtable-wrap">
                  <table className="rtable">
                    <thead>
                      <tr>
                        <th>Created</th>
                        <th>Event</th>
                        <th>Response</th>
                        <th className="r">Latency</th>
                        <th className="r">Attempt</th>
                        <th>
                          <span className="sr-only">Actions</span>
                        </th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.deliveries.map((x) => (
                        <DeliveryRow
                          key={x.id}
                          d={x}
                          hookId={id}
                          admin={admin}
                          onOpen={() => set({ delivery: x.id })}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </Panel>
          {deliveries.data ? (
            <footer className="cluster tb-between tb-pager">
              <span className="url-state">
                <Icon name="link" className="icon-12" />
                This view is a link:{" "}
                <code className="mono">{search.status ? `?status=${search.status}` : "?"}</code>
              </span>
              <span className="cluster">
                {search.cursor ? (
                  <button
                    className="btn btn-secondary btn-sm"
                    type="button"
                    onClick={() => set({ cursor: undefined })}
                  >
                    <Icon name="chevron-left" className="icon-12" />
                    Newest
                  </button>
                ) : null}
                {deliveries.data.nextCursor ? (
                  <button
                    className="btn btn-secondary btn-sm"
                    type="button"
                    onClick={() => set({ cursor: deliveries.data?.nextCursor ?? undefined })}
                  >
                    Older
                    <Icon name="chevron-right" className="icon-12" />
                  </button>
                ) : null}
              </span>
            </footer>
          ) : null}
        </div>
        <div className="stack">
          <EndpointPanel
            w={w}
            admin={admin}
            onEdit={() => set({ sheet: "edit" })}
            onRemove={() => set({ sheet: "remove" })}
          />
          <section
            className="panel"
            data-endpoint="static"
            data-od-id="panel-verify"
            aria-labelledby="h-verify"
          >
            <header className="panel-head">
              <h2 className="panel-title" id="h-verify">
                Verify the signature
              </h2>
            </header>
            <div className="panel-body">
              <CodeBlock title="handler.ts" code={VERIFY_SNIPPET} wrap />
            </div>
            <footer className="panel-foot">
              <span>
                Any Standard Webhooks library works (standardwebhooks.com); verify the raw body, before
                parsing it.
              </span>
            </footer>
          </section>
        </div>
      </div>
      {selected ? (
        <DeliveryDrawer d={selected} hookId={id} admin={admin} onClose={() => set({ delivery: undefined })} />
      ) : search.delivery && deliveries.isSuccess ? (
        <Drawer title={`Delivery ${search.delivery}`} onClose={() => set({ delivery: undefined })}>
          <p className="muted">
            That delivery isn’t on this page of the list. It may be older, or filtered out.
          </p>
        </Drawer>
      ) : null}
      {search.sheet === "rotate" && admin ? <RotateSecretSheet hook={w} onClose={close} /> : null}
      {search.sheet === "test" ? (
        <TestSheet
          hook={w}
          events={list.data?.events ?? []}
          onClose={close}
          onOpenDelivery={(delivery) =>
            set({ sheet: undefined, delivery, status: undefined, cursor: undefined })
          }
        />
      ) : null}
      {search.sheet === "replay" && admin ? <ReplaySheet hook={w} onClose={close} /> : null}
      {search.sheet === "edit" && admin ? (
        <EndpointSheet hook={w} events={list.data?.events ?? w.events} onClose={close} />
      ) : null}
      {search.sheet === "remove" && admin ? (
        <RemoveEndpointSheet
          hook={w}
          onClose={close}
          onRemoved={() => navigate({ to: "/transactional/webhooks", search: {} })}
        />
      ) : null}
    </>
  )
}

function DetailHead({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head" data-od-id="page-head">
      <div style={{ minWidth: 0 }}>
        <Crumbs
          items={[
            { to: "/transactional/messages", label: "Transactional" },
            { to: "/transactional/webhooks", label: "Webhooks" },
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
}

function StatusFilter({
  value,
  dead,
  onChange,
}: {
  value: DeliveryFilter | undefined
  dead: number
  onChange: (v: DeliveryFilter | undefined) => void
}) {
  const opts: { v: DeliveryFilter | undefined; label: string }[] = [
    { v: undefined, label: "All" },
    { v: "retrying", label: "Retrying" },
    { v: "dead", label: dead ? `Dead letters · ${fmtInt(dead)}` : "Dead letters" },
    { v: "succeeded", label: "Succeeded" },
    { v: "paused", label: "Held" },
  ]
  return (
    // biome-ignore lint/a11y/useSemanticElements: the design's segmented control
    <div className="seg seg-grace" role="group" aria-label="Show deliveries">
      {opts.map((o) => (
        <button key={o.label} type="button" aria-pressed={value === o.v} onClick={() => onChange(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

function ReplayOne({
  hookId,
  d,
  admin,
  block,
}: {
  hookId: string
  d: DeliveryLike
  admin: boolean
  block?: boolean
}) {
  const qc = useQueryClient()
  const replay = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/webhooks/{id}/deliveries/{deliveryId}/replay", {
          params: { path: { id: hookId, deliveryId: d.id } },
        }),
      ),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["webhooks"] })
      toast({
        title: `Replaying ${d.id}`,
        sub: `${d.eventType} · ${STATUS_PILL[r.status].label.toLowerCase()}, re-signed with the current secret`,
      })
    },
    onError: (e) =>
      toast({
        title: `${d.id} wasn’t replayed`,
        sub: e instanceof Error ? e.message : undefined,
        tone: "bad",
      }),
  })
  return (
    <AdminOnly
      allowed={admin}
      reason="Senders can’t replay deliveries"
      who="Owners and admins manage webhooks."
      side="right"
    >
      <button
        className={block ? "btn btn-primary" : "btn btn-secondary btn-sm"}
        type="button"
        aria-disabled={replay.isPending}
        onClick={() => !replay.isPending && replay.mutate()}
        data-endpoint={`POST /v1/webhooks/${hookId}/deliveries/${d.id}/replay`}
        aria-label={block ? undefined : `Replay ${d.id}`}
      >
        {block ? <Icon name="replay" /> : <Icon name="replay" className="icon-12" />}
        {replay.isPending ? "Replaying…" : "Replay"}
      </button>
    </AdminOnly>
  )
}

const responseText = (d: DeliveryLike) => {
  const code = num(d.lastStatusCode)
  return { code: code === null ? "—" : String(code), detail: d.lastError ?? "" }
}

function DeliveryRow({
  d,
  hookId,
  admin,
  onOpen,
}: {
  d: DeliveryLike
  hookId: string
  admin: boolean
  onOpen: () => void
}) {
  const st = STATUS_PILL[d.status]
  const r = responseText(d)
  const [kind, name] = d.eventType.split(".")
  const reqId = d.requestId
  return (
    <tr>
      <td className="nowrap" data-label="Created">
        <time dateTime={new Date(num(d.createdAt) ?? 0).toISOString()} title={utcDate(d.createdAt)}>
          {utcTime(d.createdAt, true)}
        </time>
      </td>
      <td className="is-head">
        <div className="cell-main">
          <Link
            className="mono tb-ev-link"
            to="/transactional/webhooks/$id"
            params={{ id: hookId }}
            search={{ delivery: d.id }}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey) return
              e.preventDefault()
              onOpen()
            }}
          >
            {name ? (
              <>
                {kind}.<wbr />
                {name}
              </>
            ) : (
              d.eventType
            )}
          </Link>
          <span className="cell-sub mono">
            {d.id} · {d.eventId}
          </span>
          {reqId ? <span className="cell-sub mono req-id">req {reqId.slice(0, 8)}…</span> : null}
        </div>
      </td>
      <td data-label="Response">
        <span className="mono">{r.code}</span>{" "}
        {r.detail ? <span className="cell-sub">{r.detail}</span> : null}
      </td>
      <td className="r" data-label="Latency">
        {d.lastDurationMs === null ? "—" : fmtDuration(d.lastDurationMs)}
      </td>
      <td className="r" data-label="Attempt">
        {fmtInt(d.attempts)}
        {d.status === "retrying" && d.nextAttemptAt ? (
          <span className="cell-sub" style={{ display: "block" }}>
            next {fmtIn(d.nextAttemptAt)}
          </span>
        ) : null}
      </td>
      <td className="actions">
        {d.status === "dead" || d.status === "retrying" ? (
          <ReplayOne hookId={hookId} d={d} admin={admin} />
        ) : null}
      </td>
      <td className="is-aside">
        <Pill tone={st.tone}>{st.label}</Pill>
      </td>
    </tr>
  )
}

const OUTCOME: Record<string, { cls: string; icon: IconName }> = {
  fail: { cls: "is-fail", icon: "x" },
  pass: { cls: "is-pass", icon: "check" },
  next: { cls: "is-next", icon: "clock" },
  unknown: { cls: "is-warn", icon: "dot" },
}

function DeliveryDrawer({
  d,
  hookId,
  admin,
  onClose,
}: {
  d: DeliveryLike
  hookId: string
  admin: boolean
  onClose: () => void
}) {
  const st = STATUS_PILL[d.status]
  const trail = attemptTrail(d)
  const r = responseText(d)
  const reqId = d.requestId
  const body = JSON.stringify(d.payload, null, 2)
  return (
    <Drawer
      wide
      title={`Delivery ${d.id}`}
      sub={`${d.eventType} · ${d.status === "dead" ? `dead letter after ${fmtInt(d.attempts)} attempts` : st.label.toLowerCase()}`}
      onClose={onClose}
      odId="delivery-drawer"
      endpoint={`GET /v1/webhooks/${hookId}/deliveries`}
      foot={
        <>
          <span className="t-small muted">Replaying re-signs with the current secret.</span>
          {d.status === "dead" || d.status === "retrying" ? (
            <ReplayOne hookId={hookId} d={d} admin={admin} block />
          ) : null}
        </>
      }
    >
      <div className="stack stack-16">
        <dl className="kv">
          <dt>Delivery</dt>
          <dd>
            <span className="mono">{d.id}</span>
          </dd>
          <dt>Event</dt>
          <dd>
            <span className="mono">
              {d.eventType} · {d.eventId}
            </span>
          </dd>
          <dt>Status</dt>
          <dd>
            <Pill tone={st.tone}>{st.label}</Pill>
          </dd>
          <dt>Last response</dt>
          <dd>
            <span className="mono">{r.code}</span>
            {d.lastDurationMs !== null ? <> after {fmtDuration(d.lastDurationMs)}</> : null}
            {r.detail ? <span className="cell-sub"> · {r.detail}</span> : null}
          </dd>
          <dt>Request id</dt>
          <dd>
            {reqId ? (
              <>
                <span className="mono">{reqId}</span> <CopyChip value={reqId} what="request id" />
                <span className="cell-sub" style={{ display: "block" }}>
                  Your server’s <span className="mono">x-request-id</span>, so this delivery matches one line
                  in its logs.
                </span>
              </>
            ) : (
              <span className="muted">
                Your server sent no <span className="mono">x-request-id</span>. Answer with one and it shows
                here.
              </span>
            )}
          </dd>
        </dl>
        <div>
          <h3 className="t-h4" style={{ marginBottom: 10 }}>
            Attempts
          </h3>
          <ol className="ev-tl">
            {trail.map((a) => {
              const o = OUTCOME[a.outcome] ?? { cls: "is-info", icon: "dot" as IconName }
              return (
                <li key={`${a.n}-${a.outcome}`} className={`ev ${o.cls}`}>
                  <span className="ev-dot">
                    <Icon name={o.icon} />
                  </span>
                  <span className="ev-title">{a.title}</span>
                  <span
                    className="ev-time"
                    title={
                      a.exact ? "Recorded" : "From the retry schedule; Mailyard keeps only the last attempt"
                    }
                  >
                    {a.exact ? "" : "≈ "}
                    {utcTime(a.at, true)}
                  </span>
                  <div className="ev-body">
                    <span>{a.outcome === "next" ? <Time value={a.at} /> : a.detail}</span>
                  </div>
                </li>
              )
            })}
            {d.status === "dead" ? (
              <li className="ev is-fail">
                <span className="ev-dot">
                  <Icon name="octagon" />
                </span>
                <span className="ev-title">Dead letter</span>
                <span className="ev-time">{utcTime(d.lastAttemptAt, true)}</span>
                <div className="ev-body">
                  <span>Kept until you replay it. Replay sends it again with a fresh signature.</span>
                </div>
              </li>
            ) : null}
          </ol>
          <p className="hint" style={{ marginTop: 8 }}>
            Mailyard records the last attempt’s response; earlier ones are shown at the times the retry
            schedule (30 s, then 1, 2, 4, 8, 16 and 32 min) put them, marked ≈.
          </p>
        </div>
        <CodeBlock title="Request body" code={body} wrap />
        <CodeBlock title="Request headers" code={deliveryHeaders(d)} wrap />
      </div>
    </Drawer>
  )
}

/** The endpoint panel: events, secret, signing, retries, and the planned rows. */
function EndpointPanel({
  w,
  admin,
  onEdit,
  onRemove,
}: {
  w: {
    id: string
    url: string
    events: string[]
    createdAt: number | string
    updatedAt: number | string
    lastSuccessAt: number | string | null
    filter: Partial<Filter> | null
  }
  admin: boolean
  onEdit: () => void
  onRemove: () => void
}) {
  const mailboxes = useQuery({
    queryKey: ["mailboxes", "list"],
    queryFn: () => unwrap(api.GET("/v1/mailboxes")),
    enabled: Boolean(w.filter?.mailboxIds?.length),
  })
  const campaigns = useQuery({
    queryKey: ["campaigns", "list", "all"],
    queryFn: () => unwrap(api.GET("/v1/campaigns")),
    enabled: Boolean(w.filter?.campaignIds?.length),
  })
  const topics = useQuery({
    queryKey: ["topics", "list"],
    queryFn: () => unwrap(api.GET("/v1/topics")),
    enabled: Boolean(w.filter?.topicIds?.length),
  })
  const summary = filterSummary(w.filter, {
    mailbox: (id) => mailboxes.data?.mailboxes.find((m) => m.id === id)?.address,
    campaign: (id) => campaigns.data?.campaigns.find((c) => c.id === id)?.name,
    topic: (id) => topics.data?.topics.find((t) => t.id === id)?.name,
  })
  return (
    <section
      className="panel"
      data-endpoint={`GET /v1/webhooks/${w.id} (built, HAL-3416, HAL-3464)`}
      data-od-id="panel-endpoint"
      aria-labelledby="h-endpoint"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-endpoint">
          Endpoint
        </h2>
        <div className="cluster">
          <AdminOnly
            allowed={admin}
            reason="Senders can’t change webhooks"
            who="Owners and admins manage webhooks."
            side="right"
          >
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              onClick={onEdit}
              data-endpoint={`PATCH /v1/webhooks/${w.id}`}
            >
              <Icon name="pencil" className="icon-12" />
              Edit
            </button>
          </AdminOnly>
        </div>
      </header>
      <div className="panel-body">
        <dl className="kv">
          <dt>Events</dt>
          <dd>
            <span className="scope-tags">
              {w.events.map((e) => (
                <span key={e} className="tag">
                  {e === "*" ? "All events (*)" : e}
                </span>
              ))}
            </span>
          </dd>
          <dt>Signing secret</dt>
          <dd>
            <span className="masked">whsec_••••••••••••••••••••=</span>{" "}
            <span className="muted t-small">shown once; rotate for a new one</span>
          </dd>
          <dt>Signing</dt>
          <dd>
            Standard Webhooks: <span className="mono">webhook-id</span>,{" "}
            <span className="mono">webhook-timestamp</span> and{" "}
            <span className="mono">
              webhook-signature: v1,&lt;base64 HMAC-SHA256 of "id.timestamp.body"&gt;
            </span>
          </dd>
          <dt>Body</dt>
          <dd>
            <span className="mono">{"{ id, type, createdAt, data }"}</span>;{" "}
            <span className="mono">webhook-id</span> is the same <span className="mono">id</span>
          </dd>
          <dt>Retries</dt>
          <dd>
            8 attempts, waiting 30 s, then 1, 2, 4, 8, 16 and 32 min (about an hour); then a dead letter you
            can replay
          </dd>
          <dt>Added</dt>
          <dd>
            <Time value={w.createdAt} mode="full" />
          </dd>
          <dt>Only for</dt>
          <dd>
            {summary ? (
              <span className="mono">{summary}</span>
            ) : (
              <span className="t-small muted">No filter: every event it subscribes to.</span>
            )}
          </dd>
          <dt>Pause or disable</dt>
          <dd>
            <b>Pause delivery</b> holds deliveries and sends them oldest first when you resume. <b>Disable</b>{" "}
            stops and drops them.
          </dd>
        </dl>
      </div>
      <footer className="panel-foot">
        <span>
          Last success {w.lastSuccessAt ? <Time value={w.lastSuccessAt} /> : "never"} · updated{" "}
          <Time value={w.updatedAt} />
        </span>
        <AdminOnly
          allowed={admin}
          reason="Senders can’t delete endpoints"
          who="Owners and admins manage webhooks."
          side="up"
        >
          <button
            className="btn btn-danger-ghost btn-sm"
            type="button"
            onClick={onRemove}
            data-endpoint={`DELETE /v1/webhooks/${w.id}`}
          >
            <Icon name="trash" className="icon-12" />
            Delete
          </button>
        </AdminOnly>
      </footer>
    </section>
  )
}
