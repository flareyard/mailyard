/**
 * One message in the reader (thread.html): the header in order (avatar, sender and address, the UTC stamp,
 * reply and more), who it went to, the agent's "Sent by" mark, the authentication line (SPF, DKIM, DMARC,
 * ARC) with a plain-words warning when it failed, the remote-images bar, the body in a sandboxed frame (or
 * text), attachments through their signed links, a calendar invite card, and for our own sent copies the
 * live delivery block and the per-recipient table.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { useEffect, useMemo, useRef, useState } from "react"
import { ApiError, api, unwrap } from "../api/client.ts"
import { Gated } from "../auth/NoPermission.tsx"
import { num } from "../lib/format.ts"
import tokensCss from "../styles/tokens.css?raw"
import { Icon } from "../ui/icons.tsx"
import { PanelError } from "../ui/Panel.tsx"
import { useMail } from "./context.tsx"
import { MIcon } from "./icons.tsx"
import {
  authChips,
  authWarning,
  buildSrcdoc,
  DELIVERY_TONE,
  deliveryCounts,
  fileExt,
  fileSize,
  isImage,
  partyName,
  readerTime,
  remoteImageCount,
  textBlocks,
  utcStamp,
} from "./logic.ts"
import { mailKeys, messageQuery } from "./queries.ts"
import { toast } from "./toasts.tsx"
import type { Delivery, MessageDetail, MessageSummary } from "./types.ts"
import { DeliveryPill, ToolBtn, Who } from "./ui.tsx"

export function CollapsedMessage({ m, onExpand }: { m: MessageSummary; onExpand: () => void }) {
  const mail = useMail()
  const us = Boolean(m.from && mail.ours.has(m.from.address.toLowerCase()))
  const name = partyName(m.from)
  return (
    <article
      className="msg is-collapsed"
      aria-label={`Message from ${name}, collapsed`}
      data-message={m.id}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the design's collapsed message is focusable and opens on Enter
      tabIndex={0}
      onClick={onExpand}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onExpand()
        }
      }}
    >
      <div className="msg-head">
        <Who name={m.from?.name} address={m.from?.address} us={us} lg />
        <div className="msg-from" style={{ minWidth: 0 }}>
          <b>{name}</b>
          <span className="msg-snip">{m.snippet}</span>
        </div>
        <span className="msg-side">
          {us && m.folder === "sent" ? <SentDeliveryPill m={m} /> : null}
          <span style={{ paddingLeft: 8 }}>{readerTime(m.receivedAt).split(" · ")[1]}</span>
        </span>
      </div>
    </article>
  )
}

/** A sent copy's delivery status for the collapsed row: from the message detail, fetched on demand. */
function SentDeliveryPill({ m }: { m: MessageSummary }) {
  const { mailboxId } = useMail()
  const q = useQuery(messageQuery(mailboxId, m.id))
  const s = q.data?.delivery?.status
  return s ? <DeliveryPill status={s} small /> : null
}

export function MessageView({
  m,
  onReply,
  onMore,
}: {
  m: MessageSummary
  onReply: () => void
  onMore: (left: number) => void
}) {
  const mail = useMail()
  const navigate = useNavigate()
  const detail = useQuery(messageQuery(mail.mailboxId, m.id))
  const [shownHere, setShowImages] = useState(false)
  const us = Boolean(m.from && mail.ours.has(m.from.address.toLowerCase()))
  const name = partyName(m.from)
  const chips = authChips(m.auth)
  const warning = us ? null : authWarning(m.auth)
  const d = detail.data
  const html = d?.body.html ?? null
  const remote = html ? remoteImageCount(html) : 0
  const files = m.attachments.filter((a) => !a.related)
  const invite = m.attachments.find((a) => a.mimeType.toLowerCase().startsWith("text/calendar"))
  const sentByAgent = us && m.folder === "sent" && mail.agent
  const recipients = [...m.to.map((p) => ({ ...p, kind: "to" })), ...m.cc.map((p) => ({ ...p, kind: "cc" }))]
  const senderDomain = m.from?.address.split("@")[1]
  // A sender this mailbox trusts (image-senders, HAL-3369) loads its images without asking.
  const showImages = shownHere || d?.remoteImages === "show"
  const qcImages = useQueryClient()
  const [trusting, setTrusting] = useState(false)
  const trustSender = async () => {
    if (!senderDomain) return
    setTrusting(true)
    try {
      await unwrap(
        api.POST("/v1/mailboxes/{id}/image-senders", {
          params: { path: { id: mail.mailboxId } },
          // A whole domain is stored as `@domain` (an address would be name@domain).
          body: { value: `@${senderDomain}` },
        }),
      )
      setShowImages(true)
      await qcImages.invalidateQueries({ queryKey: mailKeys.message(mail.mailboxId, m.id) })
      await qcImages.invalidateQueries({ queryKey: ["mailboxes", mail.mailboxId, "image-senders"] })
      toast({
        title: `Images from ${senderDomain} will always show`,
        sub: "Remove it in this mailbox’s Senders → Images.",
      })
    } catch (e) {
      toast({
        title: "That sender wasn’t saved",
        sub:
          e instanceof ApiError
            ? `${e.message}${e.requestId ? ` · ${e.requestId}` : ""}`
            : "Mailyard couldn’t be reached.",
        tone: "error",
      })
    } finally {
      setTrusting(false)
    }
  }
  return (
    <article
      className="msg"
      aria-label={`Message from ${name}`}
      data-message={m.id}
      data-endpoint="GET /v1/mailboxes/{id}/messages/{messageId}"
    >
      <header className="msg-head">
        <Who name={m.from?.name} address={m.from?.address} us={us} lg />
        <div className="msg-from">
          <b>{name}</b>
          {m.from ? <span className="msg-addr">{m.from.address}</span> : null}
          {m.automated ? (
            <span className="pill pill-neutral" style={{ height: 20 }}>
              Automated
            </span>
          ) : null}
        </div>
        <span className="msg-side">
          <time dateTime={new Date(num(m.receivedAt) ?? 0).toISOString()}>{readerTime(m.receivedAt)}</time>
          {mail.access.write ? <ToolBtn icon="reply" label="Reply" keys="R" onClick={onReply} /> : null}
          <button
            className="icon-btn"
            type="button"
            aria-label="More for this message"
            title="More for this message"
            aria-haspopup="menu"
            onClick={(e) => onMore(e.currentTarget.getBoundingClientRect().left)}
          >
            <Icon name="more" />
          </button>
        </span>
        <div className="msg-to">
          {recipients.length ? (
            recipients.map((p, i) => (
              <span key={`${p.kind}:${p.address}`}>
                {i
                  ? p.kind === "cc" && recipients[i - 1]?.kind === "to"
                    ? " · cc "
                    : ", "
                  : p.kind === "cc"
                    ? "cc "
                    : "to "}
                {p.name ? `${p.name} ` : ""}
                <span className="mono">{p.address}</span>
              </span>
            ))
          ) : (
            <>
              to <span className="mono">{m.envelopeTo}</span>
            </>
          )}
        </div>
        {us && m.folder === "sent" && d?.delivery?.recipients.length ? (
          <DeliverySummary delivery={d.delivery} />
        ) : null}
      </header>
      {sentByAgent && mail.agent ? (
        <div style={{ padding: "0 16px 10px 64px" }}>
          <span
            className="sent-by"
            title={`Sent from ${mail.agent.name}’s mailbox; replies a person sends from it look the same, because messages don’t yet record which person sent them.`}
          >
            <MIcon name="bot" />
            Sent by {mail.agent.name}
          </span>
        </div>
      ) : null}
      {chips.length && !us ? (
        <div
          className="msg-auth"
          data-label="Authentication as Cloudflare saw it"
          data-endpoint="message.auth (spf, dkim, dmarc, arc)"
        >
          {chips.map((c) => (
            <span key={c.key} className={`check-chip ${c.tone === "neutral" ? "off" : c.tone}`}>
              {c.label} {c.result}
              {c.sub ? <span className="sub">{c.sub}</span> : null}
            </span>
          ))}
          <Link
            className="link-quiet"
            to="."
            search={((p: Record<string, unknown>) => ({ ...p, details: m.id })) as never}
          >
            Details
          </Link>
        </div>
      ) : null}
      {warning ? (
        <div className="callout callout-warn msg-warn" role="status">
          <Icon name="warn" />
          <span>
            <b>{m.auth.dmarc === "fail" ? "This message failed DMARC." : "Authentication failed."}</b>{" "}
            {warning}
          </span>
        </div>
      ) : null}
      {us && m.folder === "sent" && d?.delivery !== undefined ? <DeliveryCard delivery={d.delivery} /> : null}
      {us && m.folder === "sent" && d?.delivery?.recipients.length ? (
        <DeliveryTable messageId={m.id} delivery={d.delivery} />
      ) : null}
      {html && remote > 0 && !showImages ? (
        <div
          className="remote-bar"
          role="status"
          data-endpoint="client-side CSP · POST /v1/mailboxes/{id}/image-senders (built, HAL-3369)"
        >
          <MIcon name="image" />
          <span className="grow">
            Remote images are blocked ({remote}), so the sender can’t see when you open this.
          </span>
          <button className="btn btn-secondary btn-sm" type="button" onClick={() => setShowImages(true)}>
            Show images
          </button>
          {senderDomain ? (
            <Gated allowed={mail.access.write} reason={mail.access.writeReason} who={mail.access.writeWho}>
              <button
                className="btn btn-ghost btn-sm"
                type="button"
                disabled={trusting}
                onClick={() => void trustSender()}
              >
                {trusting ? (
                  "Saving…"
                ) : (
                  <>
                    Always show from <span className="mono">{senderDomain}</span>
                  </>
                )}
              </button>
            </Gated>
          ) : null}
        </div>
      ) : null}
      {detail.isPending ? (
        <div className="msg-body" aria-busy="true">
          <div className="stack stack-8">
            <span className="sk sk-text" />
            <span className="sk sk-text" style={{ width: "88%" }} />
            <span className="sk sk-text" style={{ width: "64%" }} />
          </div>
        </div>
      ) : detail.isError ? (
        <div className="msg-body">
          <PanelError
            error={detail.error}
            onRetry={() => detail.refetch()}
            what="This message’s body didn’t load"
          />
        </div>
      ) : html ? (
        <BodyFrame
          html={html}
          showImages={showImages}
          title={`Message body from ${name}`}
          cid={Object.fromEntries(
            m.attachments
              .filter((a) => a.contentId && d?.attachmentUrls[a.id])
              .map((a) => [(a.contentId ?? "").replace(/^<|>$/g, ""), d?.attachmentUrls[a.id] ?? ""]),
          )}
        />
      ) : (
        <div className="msg-body">
          {textBlocks(d?.body.text ?? m.snippet).map((b, i) =>
            b.kind === "quote" ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs are positional
              <p key={i} className="quote" style={{ whiteSpace: "pre-wrap" }}>
                {b.text}
              </p>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs are positional
              <p key={i} style={{ whiteSpace: "pre-wrap" }}>
                {b.text}
              </p>
            ),
          )}
        </div>
      )}
      {invite || d?.invite ? (
        <InviteCard
          mailboxId={mail.mailboxId}
          messageId={m.id}
          invite={d?.invite}
          filename={invite?.filename ?? "invite.ics"}
        />
      ) : null}
      {files.length ? (
        // biome-ignore lint/a11y/useSemanticElements: the design's attachment grid is a div list of cards
        <div className="msg-atts" role="list" aria-label="Attachments">
          {files.map((a) => {
            const url = d?.attachmentUrls[a.id]
            const preview = isImage(a.mimeType) || a.mimeType === "application/pdf"
            const open = () =>
              navigate({
                to: ".",
                search: ((p: Record<string, unknown>) => ({ ...p, preview: `${m.id}:${a.id}` })) as never,
              })
            return (
              // biome-ignore lint/a11y/useSemanticElements: the design's attachment card, a listitem of the grid
              <div
                key={a.id}
                className="att-card"
                role="listitem"
                data-endpoint="attachmentUrls[id] (signed)"
              >
                {preview ? (
                  <button
                    className="att-thumb"
                    type="button"
                    aria-label={`Preview ${a.filename ?? "attachment"}`}
                    onClick={open}
                    style={{ padding: 0, cursor: "pointer" }}
                  >
                    {isImage(a.mimeType) && url ? (
                      <img src={url} alt="" loading="lazy" />
                    ) : (
                      <span className="ext">{fileExt(a.filename, a.mimeType)}</span>
                    )}
                  </button>
                ) : (
                  <span className="att-thumb" aria-hidden="true">
                    <span className="ext">{fileExt(a.filename, a.mimeType)}</span>
                  </span>
                )}
                <div className="att-meta">
                  {url ? (
                    <a className="att-name" href={url} download={a.filename ?? true} rel="noreferrer">
                      {a.filename ?? "attachment"}
                    </a>
                  ) : (
                    <span className="att-name">{a.filename ?? "attachment"}</span>
                  )}
                  <span className="att-sub">
                    {fileExt(a.filename, a.mimeType)} · {fileSize(a.size)}
                  </span>
                </div>
                <div className="att-actions">
                  {preview ? <ToolBtn icon="eye" label="Preview" onClick={open} /> : null}
                  {url ? (
                    <a
                      className="icon-btn"
                      href={url}
                      download={a.filename ?? true}
                      aria-label={`Download ${a.filename ?? "attachment"}`}
                      title={`Download ${a.filename ?? "attachment"}`}
                      rel="noreferrer"
                    >
                      <Icon name="download" />
                    </a>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      ) : null}
    </article>
  )
}

/** The sandboxed frame, sized to its content and re-rendered when images are allowed. */
function BodyFrame({
  html,
  showImages,
  title,
  cid,
}: {
  html: string
  showImages: boolean
  title: string
  cid: Record<string, string>
}) {
  const ref = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(240)
  const cidKey = JSON.stringify(cid)
  // biome-ignore lint/correctness/useExhaustiveDependencies: cidKey stands for cid
  const srcdoc = useMemo(() => buildSrcdoc(html, { showImages, cid, tokensCss }), [html, showImages, cidKey])
  useEffect(() => {
    const frame = ref.current
    if (!frame) return
    let ro: ResizeObserver | null = null
    const size = () => {
      const doc = frame.contentDocument
      if (!doc?.documentElement) return
      setHeight(Math.max(80, Math.ceil(doc.documentElement.scrollHeight)))
    }
    const onLoad = () => {
      size()
      const body = frame.contentDocument?.body
      if (body && typeof ResizeObserver !== "undefined") {
        ro = new ResizeObserver(size)
        ro.observe(body)
      }
    }
    frame.addEventListener("load", onLoad)
    return () => {
      frame.removeEventListener("load", onLoad)
      ro?.disconnect()
    }
  }, [])
  return (
    <div className="msg-frame-wrap">
      <iframe
        ref={ref}
        className="msg-frame"
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        title={title}
        height={height}
        srcDoc={srcdoc}
      />
      <p className="frame-note">
        <Icon name="shield" />
        Shown in a sandboxed frame: no scripts, no forms, links open in a new tab.
      </p>
    </div>
  )
}

type Invite = NonNullable<MessageDetail["invite"]>
type Partstat = NonNullable<Invite["myStatus"]>
const RSVP = [
  { label: "Yes", response: "accepted", partstat: "ACCEPTED" },
  { label: "Maybe", response: "tentative", partstat: "TENTATIVE" },
  { label: "No", response: "declined", partstat: "DECLINED" },
] as const
const REPLIED: Partial<Record<Partstat, string>> = {
  ACCEPTED: "You said yes.",
  TENTATIVE: "You said maybe.",
  DECLINED: "You said no.",
}

/** When the event is, in the viewer's time: "Tue 21 Oct, 14:00–15:00", or the date alone for all-day. */
function inviteWhen(inv: Invite): string | null {
  const start = inv.start ? new Date(inv.start) : null
  if (!start || Number.isNaN(start.getTime())) return null
  const day = start.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })
  if (inv.allDay) return `${day}, all day`
  const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  const end = inv.end ? new Date(inv.end) : null
  return end && !Number.isNaN(end.getTime())
    ? `${day}, ${time(start)}–${time(end)}`
    : `${day}, ${time(start)}`
}

/**
 * A text/calendar invite (HAL-3369): what Mailyard parsed from it, and Yes / Maybe / No, which send an iTIP
 * REPLY from this mailbox through `POST /v1/mailboxes/{id}/messages/{messageId}/rsvp`.
 */
function InviteCard({
  mailboxId,
  messageId,
  invite,
  filename,
}: {
  mailboxId: string
  messageId: string
  invite: Invite | null | undefined
  filename: string
}) {
  const mail = useMail()
  const qc = useQueryClient()
  const [sending, setSending] = useState<string | null>(null)
  const start = invite?.start ? new Date(invite.start) : null
  const when = invite ? inviteWhen(invite) : null
  const reply = async (r: (typeof RSVP)[number]) => {
    setSending(r.response)
    try {
      await unwrap(
        api.POST("/v1/mailboxes/{id}/messages/{messageId}/rsvp", {
          params: { path: { id: mailboxId, messageId } },
          body: { response: r.response },
        }),
      )
      await qc.invalidateQueries({ queryKey: mailKeys.message(mailboxId, messageId) })
      toast({
        title: `Replied ${r.label.toLowerCase()}`,
        ...(invite?.organizer?.address ? { sub: `Sent to ${invite.organizer.address}.` } : {}),
      })
    } catch (e) {
      toast({
        title: "The reply wasn’t sent",
        sub:
          e instanceof ApiError
            ? `${e.message}${e.requestId ? ` · ${e.requestId}` : ""}`
            : "Mailyard couldn’t be reached.",
        tone: "error",
      })
    } finally {
      setSending(null)
    }
  }
  const guests = invite?.attendees ?? []
  const going = guests.filter((a) => a.partstat === "ACCEPTED").length
  return (
    <div
      className="invite"
      data-endpoint="message.invite · POST /v1/mailboxes/{id}/messages/{messageId}/rsvp"
    >
      <div className="inv-date" aria-hidden="true">
        {start && !Number.isNaN(start.getTime()) ? (
          <>
            <span className="m">{start.toLocaleDateString(undefined, { month: "short" })}</span>
            <span className="d">{start.getDate()}</span>
          </>
        ) : (
          <Icon name="calendar" />
        )}
      </div>
      <div className="inv-body">
        <span className="inv-title">{invite?.summary || "Calendar invite"}</span>
        {when ? (
          <span className="inv-line">
            <Icon name="clock" />
            <span>
              {when}
              {invite?.timeZone ? <span className="muted"> · {invite.timeZone}</span> : null}
            </span>
          </span>
        ) : null}
        {invite?.location ? (
          <span className="inv-line">
            <Icon name="pin" />
            <span className="mono">{invite.location}</span>
          </span>
        ) : null}
        {invite?.organizer ? (
          <span className="inv-line">
            <Icon name="user" />
            <span>
              From {invite.organizer.name || invite.organizer.address}
              {guests.length
                ? ` · ${guests.length} guest${guests.length === 1 ? "" : "s"}, ${going} going`
                : ""}
            </span>
          </span>
        ) : null}
        {!invite ? (
          <span className="inv-line">
            <Icon name="file" />
            <span>
              <span className="mono">{filename}</span> is attached below; download it to add the event to your
              calendar.
            </span>
          </span>
        ) : null}
        {invite?.canRespond ? (
          <div className="inv-rsvp">
            {RSVP.map((r) => (
              <Gated
                key={r.response}
                allowed={mail.access.write}
                reason={mail.access.writeReason}
                who={mail.access.writeWho}
              >
                <button
                  className={`btn btn-sm ${invite.myStatus === r.partstat ? "btn-primary" : "btn-secondary"}`}
                  type="button"
                  aria-pressed={invite.myStatus === r.partstat}
                  disabled={sending !== null}
                  onClick={() => void reply(r)}
                >
                  {sending === r.response ? "Sending…" : r.label}
                </button>
              </Gated>
            ))}
            {invite.myStatus && REPLIED[invite.myStatus] ? (
              <span className="t-small muted">
                {REPLIED[invite.myStatus]} Changing it sends the organiser a new reply.
              </span>
            ) : null}
          </div>
        ) : invite ? (
          <span className="t-small muted">This invite doesn’t ask for a reply from this mailbox.</span>
        ) : null}
      </div>
    </div>
  )
}

function DeliverySummary({ delivery }: { delivery: Delivery }) {
  const counts = deliveryCounts(delivery.recipients)
  const total = delivery.recipients.length
  const bad = counts.filter((c) => c.tone === "fail")
  const warn = counts.filter((c) => c.tone === "warn")
  return (
    <div className="msg-dlv">
      {bad.map((c) => (
        <span key={c.status} className="pill pill-fail">
          <span className="dot" />
          {c.n} of {total} {c.status}
        </span>
      ))}
      {warn.map((c) => (
        <span key={c.status} className="pill pill-warn">
          <span className="dot" />
          {c.n} {c.status}
        </span>
      ))}
      {!bad.length && !warn.length ? (
        <DeliveryPill
          status={delivery.recipients.every((r) => r.status === "delivered") ? "delivered" : delivery.status}
        />
      ) : null}
      <span className="t-small muted">Delivery is per recipient</span>
    </div>
  )
}

/** The live delivery block (thread-sent-copy): status, tracking, people's opens and clicks, machines apart. */
function DeliveryCard({ delivery }: { delivery: Delivery | null }) {
  if (!delivery) return null
  const tone = DELIVERY_TONE[delivery.status] ?? "neutral"
  const firstOpen = num(delivery.firstOpenedAt)
  const firstClick = num(delivery.firstClickedAt)
  return (
    <section
      className="dlv-card"
      aria-label="Delivery of this message"
      data-endpoint="GET /v1/mailboxes/{id}/messages/{messageId} → delivery · ws live → delivery.changed"
    >
      <div className="dlv-top">
        <span className={`pill pill-${tone === "neutral" ? "neutral" : tone}`}>
          <span className="dot" />
          {delivery.status === "deferred"
            ? "Deferred, still retrying"
            : delivery.status[0]?.toUpperCase() + delivery.status.slice(1)}
        </span>
        <span className="pill pill-neutral">
          {delivery.tracked ? "Tracked: opens and clicks" : "Not tracked"}
        </span>
        <span className="grow" />
        <a
          className="link-quiet mono"
          href={`/transactional?message=${encodeURIComponent(delivery.messageId)}`}
          title="Open in the message log"
        >
          {delivery.messageId}
        </a>
      </div>
      {delivery.tracked ? (
        <div className="dlv-stats">
          <div className="dlv-stat">
            <span className="stat-label">Opened by people</span>
            <span className="dlv-n num">{num(delivery.opens) ?? 0}</span>
            <span className="dlv-sub">{firstOpen ? `first ${utcStamp(firstOpen)}` : "not yet"}</span>
          </div>
          <div className="dlv-stat">
            <span className="stat-label">Clicked by people</span>
            <span className="dlv-n num">{num(delivery.clicks) ?? 0}</span>
            <span className="dlv-sub">{firstClick ? `first ${utcStamp(firstClick)}` : "not yet"}</span>
          </div>
          <div className="dlv-stat is-machine">
            <span className="stat-label">Machine opens</span>
            <span className="dlv-n num">{num(delivery.machineOpens) ?? 0}</span>
            <span className="dlv-sub">Apple MPP, scanners and fetches under 3 s; not counted as opened</span>
          </div>
          <div className="dlv-stat is-machine">
            <span className="stat-label">Machine clicks</span>
            <span className="dlv-n num">{num(delivery.machineClicks) ?? 0}</span>
            <span className="dlv-sub">link scanners and fetches under 3 s; not counted as clicked</span>
          </div>
        </div>
      ) : (
        <p className="dlv-off">
          Opens and clicks weren’t recorded: tracking was off when this was sent, which is the default for
          one-to-one mail.
        </p>
      )}
    </section>
  )
}

function DeliveryTable({ messageId, delivery }: { messageId: string; delivery: Delivery }) {
  return (
    <div
      className="dlv-list"
      data-label="Delivery to each recipient"
      data-endpoint="message.delivery.recipients · ws live → delivery.changed"
    >
      <div className="table-wrap" style={{ margin: 0 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Recipient</th>
              <th>Kind</th>
              <th>Status</th>
              <th>When</th>
              <th className="r">Attempts</th>
              <th>
                <span className="sr-only">Details</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {delivery.recipients.map((r) => (
              <tr key={r.recipient}>
                <td>
                  <span className="mono">{r.recipient}</span>
                </td>
                <td>{r.kind}</td>
                <td>
                  <DeliveryPill status={r.status} />
                </td>
                <td className="num">{utcStamp(r.at)}</td>
                <td className="r num">{num(r.attempts) ?? 0}</td>
                <td className="r">
                  <Link
                    className="btn btn-ghost btn-sm"
                    to="."
                    search={
                      ((p: Record<string, unknown>) => ({ ...p, dlv: messageId, rcpt: r.recipient })) as never
                    }
                  >
                    SMTP reply
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
