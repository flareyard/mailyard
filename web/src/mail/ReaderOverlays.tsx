/**
 * What opens over the reader, each addressable in the URL so a link reopens it: the details drawer
 * (thread-details: authentication, spam score against the mailbox's threshold, envelope, rules matched, full
 * headers), the original .eml (thread-raw), one recipient's SMTP answer (thread-delivery-smtp) and the
 * attachment preview (thread-attachment).
 */
import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { type ReactNode, useEffect, useRef } from "react"
import { api } from "../api/client.ts"
import { fixturesEnabled } from "../fixtures/mode.ts"
import { num } from "../lib/format.ts"
import { Icon } from "../ui/icons.tsx"
import { PanelError, PanelSkeleton } from "../ui/Panel.tsx"
import { useMail } from "./context.tsx"
import {
  authChips,
  DELIVERY_WORDS,
  fileExt,
  fileSize,
  isImage,
  isPdf,
  partyName,
  readerTime,
  utcStamp,
} from "./logic.ts"
import { mailboxDetailQuery, messageQuery } from "./queries.ts"
import { DeliveryPill, SampleMarker, ToolBtn } from "./ui.tsx"

const drop = (keys: string[]) => (p: Record<string, unknown>) => {
  const next = { ...p }
  for (const k of keys) delete next[k]
  return next as never
}

function Drawer({
  title,
  sub,
  label,
  onClose,
  children,
  foot,
}: {
  title: ReactNode
  sub?: ReactNode
  label: string
  onClose: () => void
  children: ReactNode
  foot?: ReactNode
}) {
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    close.current?.focus()
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener("keydown", esc, true)
    return () => window.removeEventListener("keydown", esc, true)
  }, [onClose])
  return (
    <div role="dialog" aria-modal="true" aria-label={label}>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <aside className="drawer">
        <div className="drawer-head">
          <div className="stack stack-4" style={{ minWidth: 0 }}>
            <h2 className="t-h2" style={{ overflowWrap: "anywhere" }}>
              {title}
            </h2>
            {sub ? <span className="t-small muted">{sub}</span> : null}
          </div>
          <button
            ref={close}
            className="icon-btn"
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close · esc"
          >
            <Icon name="x" />
          </button>
        </div>
        {children}
        {foot ? <div className="drawer-foot">{foot}</div> : null}
      </aside>
    </div>
  )
}

export function DetailsDrawer({
  messageId,
  tab,
}: {
  messageId: string
  tab: "summary" | "headers" | "spam"
}) {
  const { mailboxId, local, labels } = useMail()
  const navigate = useNavigate()
  const q = useQuery(messageQuery(mailboxId, messageId, true))
  const box = useQuery(mailboxDetailQuery(mailboxId))
  const onClose = () => navigate({ to: ".", search: drop(["details", "tab"]), replace: true })
  const setTab = (t: string) =>
    navigate({
      to: ".",
      search: ((p: Record<string, unknown>) => ({ ...p, tab: t })) as never,
      replace: true,
    })
  const m = q.data
  const threshold = num(box.data?.spamThreshold) ?? 5
  const isDefault = box.data?.spamThresholdIsDefault ?? true
  const score = num(m?.spamScore)
  return (
    <Drawer
      label="Message details"
      title="Message details"
      sub={m ? `${partyName(m.from)} · ${readerTime(m.receivedAt)}` : "Loading…"}
      onClose={onClose}
      foot={
        m ? (
          <>
            <a className="btn btn-secondary btn-sm" href={m.rawUrl} download={`${m.id}.eml`}>
              <Icon name="download" />
              Download .eml
            </a>
            {fixturesEnabled() ? <SampleMarker /> : null}
          </>
        ) : undefined
      }
    >
      <div
        className="drawer-tabs"
        role="tablist"
        data-endpoint="GET /v1/mailboxes/{id}/messages/{messageId}?include=headers · GET /v1/mailboxes/{id} → spamThreshold"
      >
        {(["summary", "headers", "spam"] as const).map((t) => (
          <button
            key={t}
            className="tab"
            role="tab"
            type="button"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
          >
            {t === "summary" ? "Summary" : t === "headers" ? "Headers" : "Spam"}
          </button>
        ))}
      </div>
      <div className="drawer-body stack stack-24" style={{ paddingTop: 16 }}>
        {q.isPending ? (
          <PanelSkeleton rows={6} />
        ) : q.isError || !m ? (
          <PanelError error={q.error} onRetry={() => q.refetch()} what="The message’s details didn’t load" />
        ) : tab === "headers" ? (
          <section className="stack stack-8">
            <h3 className="t-h4">Headers, in the order they arrived</h3>
            {m.headers?.length ? (
              <div className="hdrs">
                {m.headers.map((h, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: headers repeat (Received) and keep their order
                  <div key={i}>
                    <b>{h.name}:</b> {h.value}
                  </div>
                ))}
              </div>
            ) : (
              <p className="hint">
                No headers were kept for this message (mail we sent keeps only the copy we built).
              </p>
            )}
            <Link
              className="link-quiet"
              to="."
              search={
                ((p: Record<string, unknown>) => ({
                  ...(drop(["details", "tab"])(p) as Record<string, unknown>),
                  raw: m.id,
                })) as never
              }
            >
              View the original message
            </Link>
          </section>
        ) : tab === "spam" ? (
          <SpamScore
            score={score}
            threshold={threshold}
            isDefault={isDefault}
            local={local}
            reasons={m.spamReasons}
          />
        ) : (
          <>
            <section className="stack stack-8">
              <h3 className="t-h4">Authentication</h3>
              <div className="cluster cluster-4">
                {authChips(m.auth).map((c) => (
                  <span key={c.key} className={`check-chip ${c.tone === "neutral" ? "off" : c.tone}`}>
                    {c.label} {c.result}
                    {c.key === "dkim" && m.auth.dkim[0] ? (
                      <span className="sub">
                        {m.auth.dkim[0].domain ? `d=${m.auth.dkim[0].domain}` : ""}
                        {m.auth.dkim[0].selector ? ` s=${m.auth.dkim[0].selector}` : ""}
                      </span>
                    ) : c.sub ? (
                      <span className="sub">{c.sub}</span>
                    ) : null}
                  </span>
                ))}
                {!authChips(m.auth).length ? (
                  <span className="t-small muted">No authentication results recorded.</span>
                ) : null}
              </div>
              <p className="hint">
                As {m.auth.source === "cloudflare" ? "Cloudflare" : m.auth.source} saw it on arrival (
                <span className="mono">auth.source: {m.auth.source}</span>).
                {m.auth.arc ? (
                  <>
                    {" "}
                    ARC is the seal {m.auth.arc.sealer ?? "a forwarder"} added when the message passed through
                    it.
                  </>
                ) : null}
              </p>
            </section>
            <SpamScore
              score={score}
              threshold={threshold}
              isDefault={isDefault}
              local={local}
              reasons={m.spamReasons}
              compact
            />
            <section className="stack stack-8">
              <h3 className="t-h4">Envelope and size</h3>
              <dl className="kv">
                <dt>Size</dt>
                <dd className="num">
                  {fileSize(m.size)}
                  {m.attachments.length
                    ? ` · ${m.attachments.length} attachment${m.attachments.length === 1 ? "" : "s"} ${fileSize(m.attachments.reduce((n, a) => n + (num(a.size) ?? 0), 0))}`
                    : ""}
                </dd>
                <dt>Envelope from</dt>
                <dd className="mono">{m.envelopeFrom || "—"}</dd>
                <dt>Envelope to</dt>
                <dd className="mono">{m.envelopeTo || "—"}</dd>
                <dt>Arrived via</dt>
                <dd className="mono">{m.via}</dd>
                {m.tag ? (
                  <>
                    <dt>Tag</dt>
                    <dd className="mono">{m.tag}</dd>
                  </>
                ) : null}
                <dt>Message-ID</dt>
                <dd className="mono">{m.messageId ?? "—"}</dd>
                {m.listId ? (
                  <>
                    <dt>List</dt>
                    <dd className="mono">{m.listId}</dd>
                  </>
                ) : null}
                <dt>Rules matched</dt>
                <dd>
                  {m.rulesMatched.length
                    ? m.rulesMatched.map((r) => (
                        <span key={r} className="ltag" style={{ marginRight: 4 }}>
                          {labels.find((l) => l.id === r)?.name ?? r}
                        </span>
                      ))
                    : "None"}
                </dd>
                <dt>Id</dt>
                <dd className="mono">{m.id}</dd>
              </dl>
            </section>
          </>
        )}
      </div>
    </Drawer>
  )
}

function SpamScore({
  score,
  threshold,
  isDefault,
  local,
  reasons,
  compact,
}: {
  score: number | null
  threshold: number
  isDefault: boolean
  local: string
  reasons: { rule: string; points: number | string }[]
  compact?: boolean
}) {
  const spam = score !== null && score >= threshold
  return (
    <section className="stack stack-8">
      <h3 className="t-h4">Spam score</h3>
      <div className="score">
        <div className="score-n">
          <span className="t-stat">{score === null ? "—" : score.toFixed(1)}</span>
          <span className="t-small muted">
            {score === null
              ? "Not scored (mail we sent, or allowed before scoring)."
              : spam
                ? "Spam"
                : "Not spam"}
            {score !== null ? (
              <>
                : {local} files mail as spam at <b>{threshold}</b> or above{isDefault ? " (the default)" : ""}
                .
              </>
            ) : null}
          </span>
        </div>
        {score !== null ? (
          // biome-ignore lint/a11y/useSemanticElements: the design's .meter bar with its threshold mark
          <div
            className="meter"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={20}
            aria-valuenow={score}
            aria-label={`Spam score against the threshold of ${threshold}`}
          >
            <span style={{ width: `${Math.min(100, (score / 20) * 100)}%` }} />
            <i className="meter-mark" style={{ left: `${(threshold / 20) * 100}%` }} />
          </div>
        ) : null}
        {!compact ? (
          <p className="hint">
            The threshold is set per mailbox, from 1 to 20. Owners and admins change it in Settings →
            Mailboxes.
          </p>
        ) : null}
        {reasons.length ? (
          <ul className="reasons">
            {reasons.map((r) => {
              const p = num(r.points) ?? 0
              return (
                <li key={r.rule}>
                  <span className="mono">{r.rule}</span>
                  <span className="pts">
                    {p > 0 ? "+" : p < 0 ? "−" : ""}
                    {Math.abs(p).toFixed(1)}
                  </span>
                </li>
              )
            })}
          </ul>
        ) : null}
      </div>
    </section>
  )
}

/** The original .eml in the reader pane (thread-raw): headers marked, copy and download. */
export function RawView({ messageId }: { messageId: string }) {
  const { mailboxId } = useMail()
  const navigate = useNavigate()
  const m = useQuery(messageQuery(mailboxId, messageId))
  const raw = useQuery({
    queryKey: ["mailboxes", mailboxId, "raw", messageId],
    queryFn: async () => {
      const { data, response } = await api.GET("/v1/mailboxes/{id}/messages/{messageId}/raw", {
        params: { path: { id: mailboxId, messageId } },
        parseAs: "text",
      })
      if (!response.ok) throw new Error(`raw answered ${response.status}`)
      const text = String(data ?? "")
      // Fixture mode answers JSON; the live route answers message/rfc822.
      return fixturesEnabled() && text.startsWith('"') ? (JSON.parse(text) as string) : text
    },
    staleTime: 10 * 60_000,
  })
  const close = () => navigate({ to: ".", search: drop(["raw"]), replace: true })
  const text = raw.data ?? ""
  const split = text.search(/\r?\n\r?\n/)
  const head = split > 0 ? text.slice(0, split) : text
  const rest = split > 0 ? text.slice(split) : ""
  const shown =
    rest.length > 200_000
      ? `${rest.slice(0, 200_000)}\n\n(${fileSize(rest.length - 200_000)} more not shown; download the .eml for all of it)`
      : rest
  return (
    <div className="pane-scroll rd-scroll">
      <div className="rd-inner">
        <div className="spread" style={{ flexWrap: "wrap", gap: 12 }}>
          <div className="stack stack-4" style={{ minWidth: 0 }}>
            <h2 className="t-h2">Original message</h2>
            <span className="t-small muted">
              Exactly as it arrived · {fileSize(m.data?.size)}
              {m.data?.messageId ? (
                <>
                  {" "}
                  · <span className="mono">{m.data.messageId}</span>
                </>
              ) : null}
            </span>
          </div>
          <div className="cluster">
            <button className="btn btn-ghost btn-sm" type="button" onClick={close}>
              <Icon name="chevron-left" />
              Back to the conversation
            </button>
            <button
              className="btn btn-secondary btn-sm"
              type="button"
              disabled={!text}
              onClick={() => navigator.clipboard?.writeText(text)}
            >
              <Icon name="copy" />
              Copy
            </button>
            {m.data?.rawUrl ? (
              <a
                className="btn btn-secondary btn-sm"
                href={m.data.rawUrl}
                download={`${messageId}.eml`}
                data-endpoint="rawUrl (signed)"
              >
                <Icon name="download" />
                Download .eml
              </a>
            ) : null}
          </div>
        </div>
        {raw.isPending ? (
          <PanelSkeleton rows={10} />
        ) : raw.isError ? (
          <PanelError error={raw.error} onRetry={() => raw.refetch()} what="The original didn’t load" />
        ) : (
          <pre
            className="raw"
            data-endpoint="GET /v1/mailboxes/{id}/messages/{messageId}/raw → message/rfc822"
          >
            {head.split(/\r?\n/).map((line, i) => {
              const mm = /^([A-Za-z0-9-]+):(.*)$/.exec(line)
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: header lines are positional
                <span key={i}>
                  {mm ? (
                    <>
                      <span className="h">{mm[1]}:</span>
                      {mm[2]}
                    </>
                  ) : (
                    line
                  )}
                  {"\n"}
                </span>
              )
            })}
            {shown}
          </pre>
        )}
      </div>
    </div>
  )
}

export function SmtpDrawer({
  messageId,
  recipient,
  subject,
}: {
  messageId: string
  recipient: string
  subject: string
}) {
  const { mailboxId } = useMail()
  const navigate = useNavigate()
  const q = useQuery(messageQuery(mailboxId, messageId))
  const r = q.data?.delivery?.recipients.find((x) => x.recipient === recipient)
  const onClose = () => navigate({ to: ".", search: drop(["dlv", "rcpt"]), replace: true })
  return (
    <Drawer
      label={`Delivery to ${recipient}`}
      title={
        <>
          Delivery to <span className="mono">{recipient}</span>
        </>
      }
      sub={`${r?.kind ?? ""}${r ? " · " : ""}${subject}`}
      onClose={onClose}
      foot={
        <>
          <span className="t-small muted">
            Live: changes arrive as <span className="mono">delivery.changed</span>.
          </span>
          {fixturesEnabled() ? <SampleMarker /> : null}
        </>
      }
    >
      <div
        className="drawer-body stack stack-24"
        style={{ paddingTop: 16 }}
        data-endpoint="delivery.recipients[]"
      >
        {q.isPending ? (
          <PanelSkeleton rows={4} />
        ) : !r ? (
          <p className="t-small muted">No delivery is recorded for this recipient.</p>
        ) : (
          <>
            <dl className="kv">
              <dt>Status</dt>
              <dd>
                <DeliveryPill status={r.status} /> {DELIVERY_WORDS[r.status]?.split(": ")[1] ?? ""}
              </dd>
              <dt>When</dt>
              <dd>{utcStamp(r.at)}</dd>
              <dt>Attempts</dt>
              <dd className="num">{num(r.attempts) ?? 0}</dd>
              <dt>Kind</dt>
              <dd>{r.kind}</dd>
            </dl>
            <section className="stack stack-8">
              <h3 className="t-h4">The receiving server’s answer</h3>
              {r.smtpResponse ? (
                <pre className="raw">{r.smtpResponse}</pre>
              ) : (
                <p className="t-small muted">No answer recorded yet.</p>
              )}
              <p className="hint">
                5xx means a permanent refusal and the address is now suppressed; 4xx means try later, and
                Mailyard retries on its own.
              </p>
            </section>
          </>
        )}
        <section className="stack stack-8">
          <h3 className="t-h4">What each status means</h3>
          <ul className="reasons dlv-legend">
            {Object.entries(DELIVERY_WORDS).map(([status, words]) => (
              <li key={status}>
                <DeliveryPill status={status} />
                <span>{words.split(": ")[1]}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Drawer>
  )
}

/** An attachment full screen from its signed URL (thread-attachment). */
export function Lightbox({ messageId, attachmentId }: { messageId: string; attachmentId: string }) {
  const { mailboxId } = useMail()
  const navigate = useNavigate()
  const q = useQuery(messageQuery(mailboxId, messageId))
  const a = q.data?.attachments.find((x) => x.id === attachmentId)
  const url = q.data?.attachmentUrls[attachmentId]
  const onClose = () => navigate({ to: ".", search: drop(["preview"]), replace: true })
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    close.current?.focus()
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener("keydown", esc, true)
    return () => window.removeEventListener("keydown", esc, true)
  })
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={a?.filename ?? "Attachment"}>
      <div className="lb-bar">
        <span className="grow">
          <span className="lb-name">{a?.filename ?? "Attachment"}</span>
          <span className="lb-sub">
            {a ? `${fileExt(a.filename, a.mimeType)} · ${fileSize(a.size)}` : ""}
            {q.data ? ` · from ${partyName(q.data.from)}` : ""}
          </span>
        </span>
        {url ? (
          <a
            className="icon-btn"
            href={url}
            download={a?.filename ?? true}
            aria-label="Download"
            title="Download"
          >
            <Icon name="download" />
          </a>
        ) : null}
        {url ? (
          <a
            className="icon-btn"
            href={url}
            target="_blank"
            rel="noreferrer"
            aria-label="Open in a new tab"
            title="Open in a new tab"
          >
            <Icon name="external" />
          </a>
        ) : null}
        <ToolBtn icon="x" label="Close" keys="Esc" onClick={onClose} />
      </div>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: a click on the backdrop closes; Escape and the Close button do the same from the keyboard */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the backdrop's click-to-close is a convenience for pointers only */}
      <div className="lb-stage" onClick={(e) => e.target === e.currentTarget && onClose()}>
        {q.isPending ? (
          <span className="spinner" role="status" aria-label="Loading" />
        ) : !a || !url ? (
          <p className="t-small" style={{ color: "var(--background-100)" }}>
            This attachment isn’t available.
          </p>
        ) : isImage(a.mimeType) ? (
          <img src={url} alt={a.filename ?? "Attachment"} />
        ) : isPdf(a.mimeType) ? (
          <iframe
            className="msg-frame"
            title={a.filename ?? "PDF"}
            src={url}
            sandbox=""
            style={{ width: "min(900px, 100%)", height: "100%" }}
          />
        ) : (
          <a className="btn btn-secondary" href={url} download={a.filename ?? true}>
            Download {a.filename}
          </a>
        )}
      </div>
    </div>
  )
}
