/**
 * One message (design: transactional/message-*.html; HANDOFF-ops §22, HAL-3413): its delivery trail from
 * `events[]`, the rendered copy in a sandboxed frame, Details, the headers Mailyard handed to Email Service, and
 * the raw source in a drawer. Resend repeats the stored copy with a new idempotency key.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { ApiError, api } from "../../api/client.ts"
import { Gated } from "../../auth/NoPermission.tsx"
import { useMe } from "../../auth/session.ts"
import { fmtIn, fmtInt, num } from "../../lib/format.ts"
import { CopyChip } from "../../ops/Copy.tsx"
import { fmtBytes, utcDate } from "../../ops/format.ts"
import { BuiltPill, SampleMarker, Time } from "../../ops/kit.tsx"
import { Drawer, Sheet } from "../../ops/Overlay.tsx"
import { hasScope } from "../../ops/roles.ts"
import { toast } from "../../ops/toast.tsx"
import { Icon } from "../../ui/icons.tsx"
import { PanelError, PanelSkeleton, RequestId } from "../../ui/Panel.tsx"
import { Crumbs } from "../Layout.tsx"
import {
  curlFor,
  eventView,
  MAX_ATTEMPTS,
  messageCallout,
  previewDoc,
  providerName,
  resendBlock,
  resendBody,
  resendKey,
  SIZE_LIMIT,
  STREAM_LABEL,
  sentBy,
  statusPill,
} from "../logic.ts"
import {
  type MessageDetail as Detail,
  messageQuery,
  rawQuery,
  useCampaignNames,
  useKeyNames,
  useTemplateNames,
} from "../queries.ts"

const route = getRouteApi("/_app/transactional/messages/$id")

export function MessageDetail() {
  const { id } = route.useParams()
  const search = route.useSearch()
  const navigate = useNavigate()
  const q = useQuery({
    ...messageQuery(id),
    // In flight, the trail fills in by itself.
    refetchInterval: (query) => {
      const s = query.state.data?.status
      return s === "queued" || s === "sent" || s === "deferred" ? 10_000 : false
    },
  })
  const setRaw = (open: boolean) =>
    navigate({
      to: "/transactional/messages/$id",
      params: { id },
      search: open ? { raw: 1 } : {},
      replace: true,
    })

  if (q.isPending)
    return (
      <>
        <div className="page-head">
          <div style={{ minWidth: 0 }}>
            <Crumbs
              items={[
                { to: "/transactional/messages", label: "Transactional" },
                { to: "/transactional/messages", label: "Messages" },
              ]}
            />
            <h1 className="mono-title">
              <span className="sk sk-title" style={{ width: 240, display: "inline-block" }} />
            </h1>
          </div>
        </div>
        <div className="split-2">
          <section className="panel">
            <div className="panel-body">
              <PanelSkeleton rows={5} />
            </div>
          </section>
          <section className="panel">
            <div className="panel-body">
              <PanelSkeleton rows={6} />
            </div>
          </section>
        </div>
      </>
    )
  if (q.isError)
    return (
      <>
        <div className="page-head">
          <div style={{ minWidth: 0 }}>
            <Crumbs
              items={[
                { to: "/transactional/messages", label: "Transactional" },
                { to: "/transactional/messages", label: "Messages" },
              ]}
            />
            <h1 className="mono-title">{id}</h1>
          </div>
        </div>
        <section className="panel is-error">
          <div className="panel-body">
            {q.error instanceof ApiError && q.error.status === 404 ? (
              <div className="empty">
                <span className="empty-icon">
                  <Icon name="search" />
                </span>
                <h3>No message with this id</h3>
                <p>
                  <span className="mono">{id}</span> isn’t in this workspace’s log. Search the log by message
                  id, Cloudflare id or recipient.
                </p>
                <Link className="btn btn-secondary" to="/transactional/messages" search={{ q: id }}>
                  Search the log
                </Link>
              </div>
            ) : (
              <PanelError error={q.error} onRetry={() => q.refetch()} what="This message didn’t load" />
            )}
          </div>
        </section>
      </>
    )
  return <Loaded m={q.data} rawOpen={search.raw === 1} setRaw={setRaw} />
}

function Loaded({ m, rawOpen, setRaw }: { m: Detail; rawOpen: boolean; setRaw: (open: boolean) => void }) {
  const me = useMe()
  const keys = useKeyNames()
  const campaigns = useCampaignNames()
  const templates = useTemplateNames()
  const [resend, setResend] = useState(false)
  const pill = statusPill(m.status, m.bounceType)
  const callout = messageCallout(m)
  const block = resendBlock(m)
  const canSend = hasScope(me.data, "send")
  const body = resendBody(m)
  const origin = typeof window === "undefined" ? "" : window.location.origin
  const curl = body ? curlFor(origin, body, m.idempotencyKey) : ""
  const first = m.events[0]?.at
  const last = m.events[m.events.length - 1]?.at
  const inFlight = m.status === "queued" || m.status === "sent" || m.status === "deferred"

  return (
    <>
      <div className="page-head" data-od-id="page-head">
        <div style={{ minWidth: 0 }}>
          <Crumbs
            items={[
              { to: "/transactional/messages", label: "Transactional" },
              { to: "/transactional/messages", label: "Messages" },
            ]}
          />
          <h1 data-od-id="page-title" className="mono-title">
            {m.recipient}
          </h1>
          <p className="sub">
            {m.subject} ·{" "}
            <span className="tag src-chip" data-source={m.source}>
              {m.source}
            </span>{" "}
            ·{" "}
            <span className={`pill pill-${pill.tone}`}>
              <span className="dot" />
              {pill.label}
            </span>
          </p>
        </div>
        <div className="cluster cluster-12">
          <SampleMarker />
          {curl ? <CopyChipButton value={curl} /> : null}
          <button
            className="btn btn-ghost"
            type="button"
            onClick={() => setRaw(true)}
            data-endpoint={`GET /v1/messages/${m.id}/raw`}
          >
            <Icon name="code" />
            View raw
          </button>
          <Gated
            allowed={!block && canSend}
            reason={block ? block.reason : "This key can’t send"}
            who={block ? block.who : "Resend needs the send scope. Sign in with a key that has send."}
            side="right"
          >
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => setResend(true)}
              data-endpoint="POST /v1/send (same body, new idempotency key)"
            >
              <Icon name="replay" />
              Resend
            </button>
          </Gated>
        </div>
      </div>

      {callout ? (
        <div style={{ marginBottom: 16 }}>
          <div className={`callout callout-${callout.tone} tx-callout`} role="status">
            <Icon name={callout.tone === "warn" ? "warn" : callout.tone === "info" ? "info" : "x-circle"} />
            <span>
              <b>{callout.title}</b> {callout.body}
            </span>
            {callout.link ? (
              <Link className="btn btn-secondary btn-sm" to={callout.link.to} style={{ marginLeft: "auto" }}>
                {callout.link.label}
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="split-2">
        <div className="stack">
          <section
            className="panel"
            data-endpoint={`GET /v1/messages/${m.id} → events[] (built, HAL-3413)`}
            data-od-id="panel-events"
            aria-labelledby="h-events"
          >
            <header className="panel-head">
              <h2 className="panel-title" id="h-events">
                Delivery trail
              </h2>
              <div className="cluster">
                <span className="panel-meta">
                  {inFlight ? (
                    "live while in flight"
                  ) : m.events.length && first !== undefined && last !== undefined ? (
                    <>
                      <Time value={first} mode="time" /> → <Time value={last} mode="time" />
                    </>
                  ) : (
                    utcDate(m.createdAt)
                  )}
                </span>
                <BuiltPill issue="HAL-3413" />
              </div>
            </header>
            <div className="panel-body">
              {m.events.length ? (
                <ol className="ev-tl" data-od-id="event-timeline">
                  {m.events.map((e, i) => {
                    const v = eventView(e)
                    return (
                      // biome-ignore lint/suspicious/noArrayIndexKey: events have no id; their order is the trail
                      <li className={`ev ${v.tone}`} key={i}>
                        <span className="ev-dot">
                          <Icon name={v.icon} />
                        </span>
                        <span className="ev-title">{v.label}</span>
                        <span className="ev-time">
                          <Time value={e.at} mode="time" />
                        </span>
                        <div className="ev-body">
                          {e.detail ? <span>{e.detail}</span> : null}
                          {v.meta ? <span className="ev-meta">{v.meta}</span> : null}
                          {e.smtpResponse ? (
                            <details className="ev-more">
                              <summary>SMTP response</summary>
                              <code className="smtp">{e.smtpResponse}</code>
                            </details>
                          ) : null}
                        </div>
                      </li>
                    )
                  })}
                  {m.status === "deferred" && m.nextAttemptAt ? (
                    <li className="ev is-next" data-od-id="next-attempt">
                      <span className="ev-dot">
                        <Icon name="clock" />
                      </span>
                      <span className="ev-title">
                        Next try at <Time value={m.nextAttemptAt} mode="time" />
                      </span>
                      <span className="ev-time">
                        {Number(m.nextAttemptAt) > Date.now() ? fmtIn(m.nextAttemptAt) : "due now"}
                      </span>
                      <div className="ev-body">
                        <span>
                          Attempt {fmtInt((num(m.attempts) ?? 0) + 1)} of {MAX_ATTEMPTS}. Mailyard waits 1, 2,
                          4, 8… minutes between tries, and an hour when the daily quota is the reason.
                        </span>
                      </div>
                    </li>
                  ) : null}
                </ol>
              ) : (
                <div className="empty" data-od-id="empty-state">
                  <span className="empty-icon">
                    <Icon name="history" />
                  </span>
                  <h3>This message was sent before event history was recorded.</h3>
                  <p>
                    Mailyard keeps each message’s trail from 18 Oct 2026. This one was sent on{" "}
                    {utcDate(m.createdAt)}, so only its final status, attempts and last SMTP response are
                    known; they’re under Details.
                  </p>
                </div>
              )}
            </div>
          </section>
          <Rendered m={m} />
        </div>
        <div className="stack">
          <Details m={m} keys={keys} campaigns={campaigns} templates={templates} />
          <section
            className="panel"
            data-endpoint={`GET /v1/messages/${m.id} → headers[] (built, HAL-3413)`}
            data-od-id="panel-headers"
            aria-labelledby="h-headers"
          >
            <header className="panel-head">
              <h2 className="panel-title" id="h-headers">
                Headers
              </h2>
              <div className="cluster">
                <BuiltPill issue="HAL-3413" />
              </div>
            </header>
            <div className="panel-body">
              <p className="hint" style={{ margin: "0 0 10px" }}>
                <b>What Mailyard handed to Email Service</b>, in order. Email Service adds its own on the way
                out (Received, DKIM-Signature, Date), so those aren’t here.
              </p>
              {m.headers.length ? (
                <dl className="kv is-headers">
                  {m.headers.map((h, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: headers repeat by name; their order matters
                    <HeaderRow key={i} name={h.name} value={h.value} />
                  ))}
                </dl>
              ) : (
                <p className="muted t-small">No headers were stored for this message.</p>
              )}
            </div>
            <footer className="panel-foot">
              <button
                className="btn btn-secondary btn-sm"
                type="button"
                onClick={() => setRaw(true)}
                data-endpoint={`GET /v1/messages/${m.id}/raw`}
              >
                <Icon name="code" />
                View raw
              </button>
              <a className="btn btn-ghost btn-sm" href={`/v1/messages/${m.id}/raw`} download={`${m.id}.eml`}>
                <Icon name="download" />
                Download .eml
              </a>
            </footer>
          </section>
        </div>
      </div>
      {rawOpen ? <RawDrawer id={m.id} onClose={() => setRaw(false)} /> : null}
      {resend && body ? <ResendSheet m={m} body={body} onClose={() => setResend(false)} /> : null}
    </>
  )
}

function HeaderRow({ name, value }: { name: string; value: string }) {
  return (
    <>
      <dt>{name}</dt>
      <dd>{value}</dd>
    </>
  )
}

function CopyChipButton({ value }: { value: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="btn btn-ghost"
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard?.writeText(value)
          setDone(true)
          setTimeout(() => setDone(false), 1600)
        } catch {}
      }}
    >
      <Icon name={done ? "check" : "copy"} />
      <span className="copy-label">{done ? "Copied" : "Copy as curl"}</span>
    </button>
  )
}

function Details({
  m,
  keys,
  campaigns,
  templates,
}: {
  m: Detail
  keys: Map<string, { name: string; prefix: string }>
  campaigns: Map<string, string>
  templates: Map<string, string>
}) {
  const by = sentBy(m, keys, campaigns)
  const tpl = m.templateId ? (templates.get(m.templateId) ?? m.templateId) : null
  const provider = providerName(m.provider)
  const transactional = m.stream === "transactional" || m.stream === "test"
  const lastSmtp = !m.events.length && m.smtpResponse
  return (
    <section
      className="panel"
      data-endpoint={`GET /v1/messages/${m.id}`}
      data-od-id="panel-meta"
      aria-labelledby="h-meta"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-meta">
          Details
        </h2>
      </header>
      <div className="panel-body">
        <dl className="kv">
          <dt>Message id</dt>
          <dd>
            <span className="mono">{m.id}</span>
            <CopyBtn value={m.id} label="message id" />
          </dd>
          {m.cfMessageId ? (
            <>
              <dt>Cloudflare id</dt>
              <dd>
                <span className="mono">{m.cfMessageId}</span>
                <CopyBtn value={m.cfMessageId} label="Cloudflare message id" />
              </dd>
            </>
          ) : null}
          {m.idempotencyKey ? (
            <>
              <dt>Your idempotency key</dt>
              <dd>
                <span className="mono">{m.idempotencyKey}</span>
                <CopyBtn value={m.idempotencyKey} label="idempotency key" />
              </dd>
            </>
          ) : null}
          <dt>Source</dt>
          <dd>
            <span>
              <span className="tag src-chip" data-source={m.source}>
                {m.source}
              </span>{" "}
              <span className="muted">{STREAM_LABEL[m.stream] ?? m.stream} stream</span>
            </span>
          </dd>
          <dt>Template</dt>
          <dd>
            <span>
              {tpl && m.templateId ? (
                <>
                  <Link className="link mono" to="/transactional/templates/$id" params={{ id: m.templateId }}>
                    {tpl}
                  </Link>
                  {m.templateVersion !== null ? (
                    <span className="muted"> version {m.templateVersion}</span>
                  ) : null}
                </>
              ) : (
                <span className="muted">None: sent with its own subject and body</span>
              )}
            </span>
          </dd>
          <dt>Sent by</dt>
          <dd>
            <span>
              {by.kind === "campaign" ? (
                <>
                  Campaign:{" "}
                  <Link className="link" to={campaignHref(m.campaignId)}>
                    {by.name}
                  </Link>
                </>
              ) : by.kind === "key" ? (
                <>
                  {by.prefix ? by.name : <span className="mono">{by.name}</span>}{" "}
                  {by.prefix ? <span className="mono muted">{by.prefix}…</span> : null}
                </>
              ) : (
                by.name
              )}
            </span>
          </dd>
          <dt>Provider</dt>
          <dd>{provider ?? <span className="muted">Not known yet</span>}</dd>
          <dt>Attempts</dt>
          <dd className="num">{fmtInt(m.attempts)}</dd>
          {lastSmtp ? (
            <>
              <dt>Last SMTP response</dt>
              <dd>
                <code className="smtp">{m.smtpResponse}</code>
              </dd>
            </>
          ) : null}
          {m.tracked || !transactional ? (
            <>
              <dt>Opens</dt>
              <dd>
                <span>
                  {fmtInt(m.opens)}{" "}
                  <span className="muted">estimate · {fmtInt(m.machineOpens)} by mail privacy proxies</span>
                </span>
              </dd>
              <dt>Clicks</dt>
              <dd>
                <span>
                  {fmtInt(m.clicks)}
                  {num(m.machineClicks) ? (
                    <span className="muted"> · {fmtInt(m.machineClicks)} by link scanners</span>
                  ) : null}
                </span>
              </dd>
            </>
          ) : (
            <>
              <dt>Tracking</dt>
              <dd className="muted">Off for transactional mail</dd>
            </>
          )}
        </dl>
      </div>
    </section>
  )
}

/** Campaign pages belong to the Audience run; the link is a plain path so it works whichever route ships. */
const campaignHref = (id: string | null): string => (id ? `/campaigns/${id}` : "/campaigns")

function CopyBtn({ value, label }: { value: string; label: string }) {
  return (
    <button
      className="copy-btn"
      type="button"
      aria-label={`Copy ${label}`}
      data-tip="Copy"
      onClick={() => navigator.clipboard?.writeText(value).catch(() => {})}
    >
      <Icon name="copy" />
    </button>
  )
}

function Rendered({ m }: { m: Detail }) {
  const [images, setImages] = useState(false)
  const r = m.rendered
  const size = r ? new Blob([r.html ?? r.text ?? ""]).size : 0
  return (
    <section
      className="panel"
      data-endpoint={`GET /v1/messages/${m.id} → rendered`}
      data-od-id="panel-rendered"
      aria-labelledby="h-rendered"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-rendered">
          Rendered body
        </h2>
        {r?.html && /<img\b[^>]*src=["']https?:/i.test(r.html) ? (
          <div className="cluster">
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              aria-pressed={images}
              onClick={() => setImages((v) => !v)}
            >
              <Icon name="eye" />
              {images ? "Hide remote images" : "Show remote images"}
            </button>
          </div>
        ) : null}
      </header>
      <div className="panel-body">
        {r ? (
          <div className="stack stack-12">
            <div className="preview-meta">
              <span>
                From <b>{r.from}</b>
              </span>
              <span>
                To <b className="mono">{r.to.join(", ")}</b>
              </span>
              <span>
                {fmtInt(size)} bytes of {fmtBytes(SIZE_LIMIT).replace(" MB", " MiB")}
              </span>
            </div>
            <div className="preview-stage" style={{ padding: 12 }}>
              <div className="device">
                <div className="device-bar">
                  <b>{r.subject}</b>
                  <span>{r.from}</span>
                </div>
                {r.html ? (
                  <iframe
                    title={`Rendered body of ${r.subject}`}
                    sandbox=""
                    tabIndex={-1}
                    srcDoc={previewDoc(r.html, { allowImages: images })}
                    style={{ height: 420 }}
                  />
                ) : (
                  <pre className="tx-plain">{r.text}</pre>
                )}
              </div>
            </div>
            {r.attachments.length ? (
              <ul className="tx-attachments">
                {r.attachments.map((a) => (
                  <li key={a.filename}>
                    <Icon name="paperclip" />
                    <span className="mono">{a.filename}</span>
                    <span className="muted t-small">
                      {a.type} · {fmtBytes(a.size)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="hint">
              Rendered in a sandboxed frame, with remote images held back until you allow them. This is the
              copy that was sent, with this recipient’s variables.
            </p>
          </div>
        ) : (
          <div className="empty">
            <span className="empty-icon">
              <Icon name="file" />
            </span>
            <h3>No stored copy</h3>
            <p>
              Mailyard didn’t keep the rendered body for this message, so only its trail and headers are
              shown.
            </p>
          </div>
        )}
      </div>
    </section>
  )
}

/** The raw source drawer (design: message-raw.html): GET /v1/messages/{id}/raw as message/rfc822. */
function RawDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery(rawQuery(id))
  const bytes = q.data ? new Blob([q.data]).size : null
  return (
    <Drawer
      title="Raw source"
      sub={`GET /v1/messages/${id}/raw`}
      wide
      onClose={onClose}
      odId="raw-drawer"
      endpoint={`GET /v1/messages/${id}/raw`}
      foot={
        <>
          <span className="t-small muted">Opens in any mail client.</span>
          <a
            className="btn btn-primary"
            href={`/v1/messages/${id}/raw`}
            download={`${id}.eml`}
            data-endpoint={`GET /v1/messages/${id}/raw`}
          >
            <Icon name="download" />
            Download .eml
          </a>
        </>
      }
    >
      <div className="stack stack-12">
        <dl className="kv">
          <dt>Format</dt>
          <dd>
            <span>
              <span className="mono">message/rfc822</span>
              {bytes !== null ? `, ${fmtInt(bytes)} bytes` : null}
            </span>
          </dd>
          <dt>Copy</dt>
          <dd>
            <span>
              Rebuilt from the copy Mailyard stored, marked <span className="mono">X-Mailyard-Copy</span>.
              Email Service builds the MIME it actually transmits, adding its own headers and signature.
            </span>
          </dd>
        </dl>
        {q.isPending ? (
          <PanelSkeleton rows={8} />
        ) : q.isError ? (
          <PanelError error={q.error} onRetry={() => q.refetch()} what="The raw source didn’t load" />
        ) : (
          <div className="code" data-od-id="raw-source" data-wrap="">
            <div className="code-head">
              <span className="code-title">{id}.eml</span>
              <CopyChip value={q.data} />
            </div>
            <pre>
              <code>{q.data}</code>
            </pre>
          </div>
        )}
      </div>
    </Drawer>
  )
}

/** Resend: the exact stored copy to the same recipient, as a new send with a fresh idempotency key. */
function ResendSheet({
  m,
  body,
  onClose,
}: {
  m: Detail
  body: NonNullable<ReturnType<typeof resendBody>>
  onClose: () => void
}) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const send = useMutation({
    mutationFn: async () => {
      const { data } = await api.POST("/v1/send", {
        params: { header: { "idempotency-key": resendKey(m.id) } },
        body,
      })
      return data
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["messages", "list"] })
      const status = data?.data.emails[0]?.status
      toast({ title: `Resent to ${m.recipient}`, sub: status ? `Status: ${status}` : "It’s in the log." })
      onClose()
      navigate({ to: "/transactional/messages", search: { q: m.recipient } })
    },
  })
  return (
    <Sheet
      title={`Resend to ${m.recipient}?`}
      sub="A new send of the exact copy that went out, with a new idempotency key."
      onClose={onClose}
      endpoint="POST /v1/send (same body, new idempotency key)"
      odId="resend-sheet"
      foot={
        <>
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => send.mutate()}
            disabled={send.isPending}
            data-autofocus=""
          >
            <Icon name="replay" />
            {send.isPending ? "Sending…" : "Resend"}
          </button>
        </>
      }
    >
      <dl className="kv">
        <dt>To</dt>
        <dd className="mono">{m.recipient}</dd>
        <dt>From</dt>
        <dd>{body.from}</dd>
        <dt>Subject</dt>
        <dd>{body.subject}</dd>
      </dl>
      <p className="hint">
        It counts as a new send: it’s billed, it shows in the log as its own message, and it gets its own
        trail.
      </p>
      {send.isError ? (
        <div className="callout callout-error" role="alert">
          <Icon name="x-circle" />
          <span>
            <b>Not sent.</b>{" "}
            {send.error instanceof ApiError ? send.error.message : "Mailyard couldn’t be reached."}
          </span>
          {send.error instanceof ApiError && send.error.requestId ? (
            <RequestId id={send.error.requestId} />
          ) : null}
        </div>
      ) : null}
    </Sheet>
  )
}
