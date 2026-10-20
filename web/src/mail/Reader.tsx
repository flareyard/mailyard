/**
 * The reader (`section.mail-reader`, thread.html): the bar (each tooltip names its shortcut, J/K position),
 * the head (subject, labels, assignee, participants), the AI summary's planned slot, the messages (older
 * ones fold), internal notes, the reply prompt and the inline reply, and the phone's own app bar and
 * action bar. Opening a thread marks it read.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { useEffect, useMemo, useRef, useState } from "react"
import { ApiError, api, unwrap } from "../api/client.ts"
import { useCapabilities } from "../auth/capabilities.ts"
import { Gated } from "../auth/NoPermission.tsx"
import { useMe } from "../auth/session.ts"
import { fixturesEnabled } from "../fixtures/mode.ts"
import { num } from "../lib/format.ts"
import { Icon } from "../ui/icons.tsx"
import { RequestId } from "../ui/Panel.tsx"
import { useBulk } from "./actions.ts"
import { assistantQuery, type Helper, helperOff, refusalOf, refusalText } from "./assistant.ts"
import { InlineReply } from "./compose/InlineReply.tsx"
import { openReply, useComposeState } from "./compose/store.ts"
import { useMail } from "./context.tsx"
import { MIcon } from "./icons.tsx"
import { expandedByDefault, partyName, type ReaderSearch, rowTime } from "./logic.ts"
import { CollapsedMessage, MessageView } from "./Message.tsx"
import type { PickerKind } from "./Pickers.tsx"
import { mailKeys, threadQuery } from "./queries.ts"
import { DetailsDrawer, Lightbox, RawView, SmtpDrawer } from "./ReaderOverlays.tsx"
import { toast } from "./toasts.tsx"
import type {
  DraftedReply,
  ListQuery,
  MessageSummary,
  Note,
  Thread,
  ThreadDetail,
  ThreadSummary,
} from "./types.ts"
import { AgentBadge, LabelTag, SampleMarker, ToolBtn, Who } from "./ui.tsx"

export type ReaderActions = {
  act: (
    action:
      | "archive"
      | "trash"
      | "delete"
      | "spam"
      | "notSpam"
      | "inbox"
      | "unread"
      | "read"
      | "star"
      | "unstar",
  ) => void
  pick: (kind: PickerKind, left: number, messageId?: string) => void
  nav: (dir: 1 | -1) => void
}

export function ReaderEmpty({ state }: { state: "empty" | "error" | "idle" }) {
  return (
    <section className="mail-reader" aria-label="Reader">
      <div className="rd-empty">
        <div className="empty">
          <span className="empty-icon">
            <Icon name="mail" />
          </span>
          <h3>
            {state === "error"
              ? "Nothing to show yet"
              : state === "empty"
                ? "Nothing here yet"
                : "No conversation open"}
          </h3>
          <p>{state === "error" ? "The list will fill in once it loads." : "Conversations open here."}</p>
          <div className="kbd-hints">
            <span>
              <span className="kbd-group">
                <span className="kbd">J</span>
              </span>{" "}
              <span className="kbd-group">
                <span className="kbd">K</span>
              </span>
            </span>
            <span>Move</span>
            <span>
              <span className="kbd-group">
                <span className="kbd">↵</span>
              </span>
            </span>
            <span>Open</span>
            <span>
              <span className="kbd-group">
                <span className="kbd">X</span>
              </span>
            </span>
            <span>Select</span>
            <span>
              <span className="kbd-group">
                <span className="kbd">?</span>
              </span>
            </span>
            <span>All shortcuts</span>
          </div>
        </div>
      </div>
    </section>
  )
}

function ReaderSkeleton() {
  return (
    <section className="mail-reader" aria-label="Loading conversation" aria-busy="true">
      <div className="rd-bar">
        {Array.from({ length: 6 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton
          <span key={i} className="sk" style={{ width: 28, height: 28, margin: 4 }} />
        ))}
      </div>
      <div className="pane-scroll rd-scroll">
        <div className="rd-inner">
          <span className="sk sk-title" style={{ width: "60%", height: 24 }} />
          <div className="cluster">
            <span className="sk sk-chip" />
            <span className="sk sk-chip" />
          </div>
          <div className="msg" style={{ padding: 16 }}>
            <div className="stack stack-12">
              <div className="cluster" style={{ flexWrap: "nowrap" }}>
                <span className="sk sk-circle" style={{ width: 36, height: 36 }} />
                <div className="stack stack-8" style={{ flex: 1 }}>
                  <span className="sk sk-text" style={{ width: "40%" }} />
                  <span className="sk sk-text" style={{ width: "25%" }} />
                </div>
              </div>
              <span className="sk sk-text" />
              <span className="sk sk-text" style={{ width: "92%" }} />
              <span className="sk sk-text" style={{ width: "76%" }} />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

export function Reader({
  threadId,
  q,
  rs,
  position,
  actions,
  pickerSlot,
  noteRef,
}: {
  threadId: string
  q: ListQuery
  rs: ReaderSearch
  position: { index: number; total: number | null; prev?: string | undefined; next?: string | undefined }
  actions: ReaderActions
  pickerSlot: React.ReactNode
  noteRef: React.RefObject<HTMLTextAreaElement | null>
}) {
  const mail = useMail()
  const { mailboxId, access } = mail
  const navigate = useNavigate()
  const thread = useQuery(threadQuery(mailboxId, threadId))
  const bulk = useBulk(mailboxId)
  const compose = useComposeState()
  const marked = useRef<string | null>(null)

  // Opening a thread reads it (quietly, optimistically), once per open.
  useEffect(() => {
    const t = thread.data?.thread
    if (!t || marked.current === t.id || !access.write) return
    marked.current = t.id
    if ((num(t.unreadCount) ?? 0) > 0) void bulk("read", [t.id], {}, { quiet: true })
  }, [thread.data, access.write, bulk])

  // `?reply=` opens the inline reply once the thread is here, then leaves the URL.
  useEffect(() => {
    const d = thread.data
    const last = d?.messages[d.messages.length - 1]
    if (!rs.reply || !last || !access.write) return
    openReply({ mailboxId, threadId, messageId: last.id, mode: rs.reply })
    navigate({
      to: ".",
      search: ((p: Record<string, unknown>) => {
        const { reply: _r, ...rest } = p
        return rest
      }) as never,
      replace: true,
    })
  }, [rs.reply, thread.data, access.write, mailboxId, threadId, navigate])

  const backToList = () => navigate({ to: "/mail/$mailboxId", params: { mailboxId }, search: q as never })

  if (thread.isPending) return <ReaderSkeleton />
  if (thread.isError)
    return (
      <ThreadError
        error={thread.error}
        onRetry={() => thread.refetch()}
        threadId={threadId}
        back={backToList}
      />
    )
  const d = thread.data
  const t = d.thread
  const last = d.messages[d.messages.length - 1]
  const inTrash = t.folders.includes("trash")
  const inSpam = t.folders.includes("spam")
  const gate = (node: React.ReactElement<Record<string, unknown>>) =>
    access.write ? (
      node
    ) : (
      <Gated allowed={false} reason={access.writeReason} who={access.writeWho}>
        {node}
      </Gated>
    )

  const replyTo = (mode: "reply" | "replyAll" | "forward", messageId = last?.id) =>
    messageId ? openReply({ mailboxId, threadId: t.id, messageId, mode }) : undefined

  if (rs.raw)
    return (
      <section className="mail-reader" aria-label="Original message">
        <ReaderBar
          t={t}
          actions={actions}
          position={position}
          back={backToList}
          gate={gate}
          inTrash={inTrash}
          inSpam={inSpam}
          lastId={last?.id}
        />
        <RawView messageId={rs.raw} />
        {pickerSlot}
      </section>
    )

  return (
    <section
      className="mail-reader"
      aria-label="Conversation"
      data-endpoint="GET /v1/mailboxes/{id}/threads/{threadId} · GET /v1/mailboxes/{id}/messages/{messageId}"
    >
      <ReaderBar
        t={t}
        actions={actions}
        position={position}
        back={backToList}
        gate={gate}
        inTrash={inTrash}
        inSpam={inSpam}
        lastId={last?.id}
      />
      <div className="pane-scroll rd-scroll">
        <div className="rd-inner">
          <Head d={d} />
          <AiSummary key={t.id} threadId={t.id} lastMessageId={last?.id} />
          <Messages
            d={d}
            onReply={(id) => replyTo("reply", id)}
            onMore={(id, l) => actions.pick("more", l, id)}
          />
          <Notes d={d} noteRef={noteRef} />
          {access.write ? (
            compose.inline?.threadId === t.id ? null : (
              <div className="reply-prompt hide-phone">
                <button
                  className="btn btn-secondary"
                  type="button"
                  title="Reply · R"
                  aria-keyshortcuts="R"
                  onClick={() => replyTo("reply")}
                >
                  <Icon name="reply" />
                  Reply
                </button>
                <button
                  className="btn btn-secondary"
                  type="button"
                  title="Reply all · ⇧ R"
                  aria-keyshortcuts="Shift+R"
                  onClick={() => replyTo("replyAll")}
                >
                  <MIcon name="reply-all" />
                  Reply all
                </button>
                <button
                  className="btn btn-secondary"
                  type="button"
                  title="Forward · F"
                  aria-keyshortcuts="F"
                  onClick={() => replyTo("forward")}
                >
                  <Icon name="forward" />
                  Forward
                </button>
                <button
                  className="btn btn-ghost"
                  type="button"
                  title="Add an internal note · N"
                  aria-keyshortcuts="N"
                  onClick={() => noteRef.current?.focus()}
                >
                  <MIcon name="note" />
                  Note
                </button>
              </div>
            )
          ) : (
            <div className="callout callout-info" role="note">
              <Icon name="info" />
              <span>
                <b>{access.writeReason}.</b> {access.writeWho}
              </span>
            </div>
          )}
          <InlineReply threadId={t.id} />
        </div>
      </div>
      {access.write ? (
        <nav className="rd-actionbar" aria-label="Reply">
          <button className="bb-item" type="button" onClick={() => replyTo("reply")}>
            <Icon name="reply" />
            <span>Reply</span>
          </button>
          <button className="bb-item" type="button" onClick={() => replyTo("replyAll")}>
            <MIcon name="reply-all" />
            <span>Reply all</span>
          </button>
          <button className="bb-item" type="button" onClick={() => replyTo("forward")}>
            <Icon name="forward" />
            <span>Forward</span>
          </button>
          <button
            className="bb-item"
            type="button"
            aria-haspopup="menu"
            onClick={() => actions.pick("assign", 12)}
          >
            <MIcon name="user-check" />
            <span>Assign</span>
          </button>
        </nav>
      ) : null}
      {pickerSlot}
      {rs.details ? <DetailsDrawer messageId={rs.details} tab={rs.tab ?? "summary"} /> : null}
      {rs.dlv && rs.rcpt ? <SmtpDrawer messageId={rs.dlv} recipient={rs.rcpt} subject={t.subject} /> : null}
      {rs.preview ? (
        <Lightbox
          messageId={rs.preview.split(":")[0] ?? ""}
          attachmentId={rs.preview.split(":").slice(1).join(":")}
        />
      ) : null}
    </section>
  )
}

function ReaderBar({
  t,
  actions,
  position,
  back,
  gate,
  inTrash,
  inSpam,
  lastId,
}: {
  t: Thread
  actions: ReaderActions
  position: { index: number; total: number | null; prev?: string | undefined; next?: string | undefined }
  back: () => void
  gate: (n: React.ReactElement<Record<string, unknown>>) => React.ReactNode
  inTrash: boolean
  inSpam: boolean
  lastId: string | undefined
}) {
  const unread = (num(t.unreadCount) ?? 0) > 0
  return (
    <div className="rd-bar" role="toolbar" aria-label="Conversation actions">
      <button
        className="icon-btn only-phone"
        type="button"
        aria-label="Back to the list"
        title="Back to the list · U"
        onClick={back}
      >
        <MIcon name="arrow-left" />
      </button>
      {inTrash
        ? gate(<ToolBtn icon="inbox" label="Restore to Inbox" onClick={() => actions.act("inbox")} />)
        : gate(<ToolBtn icon="archive" label="Archive" keys="E" onClick={() => actions.act("archive")} />)}
      {gate(
        <ToolBtn
          icon="trash"
          label={inTrash ? "Delete forever" : "Delete"}
          keys="#"
          onClick={() => actions.act(inTrash ? "delete" : "trash")}
        />,
      )}
      {gate(<PickBtn icon="clock" label="Snooze" keys="S" kind="snooze" actions={actions} />)}
      <span className="vdivider hide-phone" aria-hidden="true" />
      {gate(
        <PickBtn icon="tag" label="Label" keys="L" kind="label" className="hide-phone" actions={actions} />,
      )}
      {gate(
        <PickBtn
          icon="move"
          label="Move"
          keys="V"
          kind="move"
          className="hide-phone hide-narrow"
          actions={actions}
        />,
      )}
      {gate(
        <PickBtn
          icon="user-check"
          label="Assign"
          keys="A"
          kind="assign"
          className="hide-phone"
          actions={actions}
        />,
      )}
      {gate(
        <ToolBtn
          icon={unread ? "check" : "mail-dot"}
          label={unread ? "Mark read" : "Mark unread"}
          keys={unread ? "⇧ I" : "⇧ U"}
          className="hide-phone hide-narrow"
          onClick={() => actions.act(unread ? "read" : "unread")}
        />,
      )}
      {gate(
        inSpam ? (
          <ToolBtn
            icon="check-circle"
            label="Not spam"
            className="hide-narrow"
            onClick={() => actions.act("notSpam")}
          />
        ) : (
          <ToolBtn
            icon="star"
            label={t.starred ? "Unstar" : "Star"}
            keys="⇧ S"
            className="hide-narrow"
            pressed={t.starred}
            onClick={() => actions.act(t.starred ? "unstar" : "star")}
          />
        ),
      )}
      <PickBtn icon="more" label="More actions" kind="more" actions={actions} messageId={lastId} />
      {fixturesEnabled() ? (
        <span className="only-phone" style={{ marginLeft: "auto", paddingRight: 4 }}>
          <SampleMarker what="The conversation is fixture data." />
        </span>
      ) : null}
      <span className="rd-pos">
        <span>
          {position.index >= 0
            ? `${position.index + 1} of ${position.total !== null ? position.total.toLocaleString("en") : "many"}`
            : ""}
        </span>
        <ToolBtn
          icon="chevron-up"
          label="Newer conversation"
          keys="K"
          disabled={!position.prev}
          onClick={() => actions.nav(-1)}
        />
        <ToolBtn
          icon="chevron-down"
          label="Older conversation"
          keys="J"
          disabled={!position.next}
          onClick={() => actions.nav(1)}
        />
      </span>
    </div>
  )
}

function PickBtn({
  icon,
  label,
  keys,
  kind,
  className,
  actions,
  messageId,
}: {
  icon: Parameters<typeof MIcon>[0]["name"]
  label: string
  keys?: string
  kind: PickerKind
  className?: string
  actions: ReaderActions
  messageId?: string | undefined
}) {
  return (
    <button
      className={`icon-btn${className ? ` ${className}` : ""}`}
      type="button"
      aria-label={label}
      title={keys ? `${label} · ${keys}` : label}
      {...(keys ? { "aria-keyshortcuts": keys } : {})}
      aria-haspopup="menu"
      onClick={(e) => actions.pick(kind, e.currentTarget.offsetLeft, messageId)}
    >
      <MIcon name={icon} />
    </button>
  )
}

function Head({ d }: { d: ThreadDetail }) {
  const mail = useMail()
  const bulk = useBulk(mail.mailboxId)
  const t = d.thread
  const people = [
    ...new Map(d.messages.filter((m) => m.from).map((m) => [m.from?.address, partyName(m.from)])).values(),
  ]
  const n = d.messages.length
  return (
    <header className="rd-head">
      <h2 className="rd-subject">{t.subject || "(no subject)"}</h2>
      <div className="rd-tags">
        {mail.agent ? <AgentBadge name={mail.agent.name} /> : null}
        {t.labelIds.map((id) => {
          const l = mail.labelById.get(id)
          return l ? (
            <LabelTag
              key={id}
              label={l}
              {...(mail.access.write
                ? { onRemove: () => void bulk("unlabel", [t.id], { labelId: id }, { labelName: l.name }) }
                : {})}
            />
          ) : null
        })}
        {t.assignedTo ? (
          <span
            className="ltag ltag-lg"
            style={{ paddingLeft: 3 }}
            title={`Key or member ${t.assignedTo.id}`}
          >
            <Who name={t.assignedTo.name} />
            Assigned to {t.assignedTo.name}
            {mail.access.write ? (
              <button
                type="button"
                aria-label="Unassign"
                onClick={() => void bulk("assign", [t.id], { assignee: null })}
              >
                <Icon name="x" />
              </button>
            ) : null}
          </span>
        ) : null}
        {num(t.snoozedUntil) ? <span className="ltag">Snoozed until {rowTime(t.snoozedUntil)}</span> : null}
        <span className="t-small muted">
          {n} message{n === 1 ? "" : "s"} · {people.slice(0, 4).join(", ")}
        </span>
      </div>
    </header>
  )
}

/**
 * The thread's summary and a drafted reply (the mailbox helpers). Shown when the summary route is live;
 * when the helpers are off it says so and who can turn them on. A summary is only ever beside the thread,
 * and a drafted reply opens as an ordinary draft under it for a person to edit and send.
 */
function AiSummary({ threadId, lastMessageId }: { threadId: string; lastMessageId: string | undefined }) {
  const caps = useCapabilities()
  const { mailboxId, access } = useMail()
  const settings = useQuery({
    ...assistantQuery,
    enabled: caps.has("post", "/v1/mailboxes/{id}/threads/{threadId}/summary"),
  })
  const [summary, setSummary] = useState<ThreadSummary | null>(null)
  const [busy, setBusy] = useState<"summary" | "draft" | null>(null)
  const [refused, setRefused] = useState<{ helper: Helper; reason: string | undefined } | null>(null)
  if (!caps.ready || !caps.has("post", "/v1/mailboxes/{id}/threads/{threadId}/summary")) return null
  // A key without the settings' read access gets a refusal; the reader then simply leaves the slot out.
  if (settings.isError || !settings.data) return null
  const s = settings.data
  const summaryOff = helperOff(s, "summaries")
  const draftOff = helperOff(s, "drafts")
  if (summaryOff && draftOff)
    return (
      <section className="ai-sum" aria-label="Summary" data-od-id="ai-summary-off">
        <div className="ai-head">
          <MIcon name="sparkles" />
          Summary
          <span className="grow" />
        </div>
        <span className="ai-foot">
          {refusalText(summaryOff, "summaries")}{" "}
          <Link className="link" to="/settings/ai">
            Settings → AI
          </Link>
        </span>
      </section>
    )

  const summarize = async (refresh: boolean) => {
    setBusy("summary")
    setRefused(null)
    try {
      const r = await unwrap(
        api.POST("/v1/mailboxes/{id}/threads/{threadId}/summary", {
          params: { path: { id: mailboxId, threadId } },
          body: refresh ? { refresh: true } : {},
        }),
      )
      setSummary(r as ThreadSummary)
    } catch (e) {
      const reason = refusalOf(e)
      if (reason) setRefused({ helper: "summaries", reason })
      else
        toast({
          title: "The summary didn’t load",
          sub:
            e instanceof ApiError
              ? `${e.message}${e.requestId ? ` · ${e.requestId}` : ""}`
              : "Mailyard couldn’t be reached.",
          tone: "error",
        })
    } finally {
      setBusy(null)
    }
  }
  const draftReply = async () => {
    if (!lastMessageId) return
    setBusy("draft")
    setRefused(null)
    try {
      const r = (await unwrap(
        api.POST("/v1/mailboxes/{id}/threads/{threadId}/draft", {
          params: { path: { id: mailboxId, threadId } },
          body: {},
        }),
      )) as DraftedReply
      openReply({ mailboxId, threadId, messageId: lastMessageId, mode: "reply", draftId: r.draft.id })
      toast({ title: "Reply drafted", sub: "Check it and edit before you send. Nothing was sent." })
    } catch (e) {
      const reason = refusalOf(e)
      if (reason) setRefused({ helper: "drafts", reason })
      else
        toast({
          title: "The reply wasn’t drafted",
          sub:
            e instanceof ApiError
              ? `${e.message}${e.requestId ? ` · ${e.requestId}` : ""}`
              : "Mailyard couldn’t be reached.",
          tone: "error",
        })
    } finally {
      setBusy(null)
    }
  }
  const generated = summary ? num(summary.generatedAt) : null
  return (
    <section className="ai-sum" aria-label="Summary" aria-busy={busy !== null} data-od-id="ai-summary">
      <div className="ai-head">
        <MIcon name="sparkles" />
        Summary
        {summary ? (
          <span className="t-small">
            {summary.cached ? "Saved" : "New"}
            {generated ? ` · ${rowTime(generated)}` : ""}
          </span>
        ) : null}
        <span className="grow" />
        {draftOff ? null : (
          <Gated allowed={access.write} reason={access.writeReason} who={access.writeWho} side="right">
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              disabled={busy !== null || !lastMessageId}
              onClick={() => void draftReply()}
            >
              <Icon name="reply" />
              {busy === "draft" ? "Drafting…" : "Draft a reply"}
            </button>
          </Gated>
        )}
        {summaryOff ? null : (
          <button
            className="btn btn-secondary btn-sm"
            type="button"
            disabled={busy !== null}
            onClick={() => void summarize(Boolean(summary))}
          >
            <MIcon name="sparkles" />
            {busy === "summary" ? "Summarizing…" : summary ? "Refresh" : "Summarize"}
          </button>
        )}
      </div>
      {summary ? (
        <>
          <p>{summary.summary}</p>
          {summary.bullets.length ? (
            <ul className="ai-bullets">
              {summary.bullets.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
      {refused ? (
        <span className="ai-foot" role="status">
          {refusalText(refused.reason, refused.helper, s)}
          {refused.reason === "off" || refused.reason === "disabled" ? (
            <>
              {" "}
              <Link className="link" to="/settings/ai">
                Settings → AI
              </Link>
            </>
          ) : null}
        </span>
      ) : (
        <span className="ai-foot">
          {summary?.model || s.model ? `Written by ${summary?.model ?? s.model}. ` : ""}A suggestion from the
          thread’s text; check it against the messages.
          {summaryOff ? ` ${refusalText(summaryOff, "summaries")}` : ""}
        </span>
      )}
    </section>
  )
}

function Messages({
  d,
  onReply,
  onMore,
}: {
  d: ThreadDetail
  onReply: (id: string) => void
  onMore: (id: string, left: number) => void
}) {
  const [open, setOpen] = useState<Set<string>>(() => expandedByDefault(d.messages))
  const [unfolded, setUnfolded] = useState(false)
  // A new message (live) opens itself.
  const lastId = d.messages[d.messages.length - 1]?.id
  useEffect(() => {
    if (lastId) setOpen((s) => new Set([...s, lastId]))
  }, [lastId])
  const msgs = d.messages
  // Fold three or more older collapsed messages at the top into one row.
  const firstOpen = msgs.findIndex((m) => open.has(m.id))
  const foldable = firstOpen > 3 && !unfolded ? msgs.slice(0, firstOpen - 1) : []
  const rest = msgs.slice(foldable.length)
  return (
    <>
      {foldable.length ? (
        <button className="msg-fold" type="button" aria-expanded="false" onClick={() => setUnfolded(true)}>
          <span className="stackav">
            {foldable.slice(0, 3).map((m) => (
              <Who key={m.id} name={m.from?.name} address={m.from?.address} />
            ))}
          </span>
          {foldable.length} earlier messages
        </button>
      ) : null}
      {rest.map((m: MessageSummary) =>
        open.has(m.id) ? (
          <MessageView key={m.id} m={m} onReply={() => onReply(m.id)} onMore={(l) => onMore(m.id, l)} />
        ) : (
          <CollapsedMessage key={m.id} m={m} onExpand={() => setOpen((s) => new Set([...s, m.id]))} />
        ),
      )}
    </>
  )
}

/** Internal notes (HAL-3407, live): a dashed edge, members only; delete is the author's, an owner's or an admin's. */
function Notes({ d, noteRef }: { d: ThreadDetail; noteRef: React.RefObject<HTMLTextAreaElement | null> }) {
  const mail = useMail()
  const me = useMe()
  const qc = useQueryClient()
  const [body, setBody] = useState("")
  const [busy, setBusy] = useState(false)
  const t = d.thread
  const myIds = useMemo(
    () => new Set([me.data?.user?.id, me.data?.key?.id].filter(Boolean) as string[]),
    [me.data],
  )
  const canDeleteAny =
    me.data?.via === "admin-key" ||
    me.data?.role === "owner" ||
    me.data?.role === "admin" ||
    (!me.data?.role && (me.data?.scopes as string[] | undefined)?.includes("admin"))
  const add = async () => {
    const text = body.trim()
    if (!text) return
    setBusy(true)
    try {
      const note = await unwrap(
        api.POST("/v1/mailboxes/{id}/threads/{threadId}/notes", {
          params: { path: { id: mail.mailboxId, threadId: t.id } },
          body: { body: text },
        }),
      )
      if (note)
        qc.setQueryData<ThreadDetail>(mailKeys.thread(mail.mailboxId, t.id), (old) =>
          old && !old.notes.some((n) => n.id === note.id) ? { ...old, notes: [...old.notes, note] } : old,
        )
      setBody("")
    } catch (e) {
      toast({
        title: "The note wasn’t added",
        sub: e instanceof ApiError ? e.message : "Mailyard couldn’t be reached.",
        tone: "error",
      })
    } finally {
      setBusy(false)
    }
  }
  const remove = async (n: Note) => {
    const key = mailKeys.thread(mail.mailboxId, t.id)
    const before = qc.getQueryData<ThreadDetail>(key)
    qc.setQueryData<ThreadDetail>(key, (old) =>
      old ? { ...old, notes: old.notes.filter((x) => x.id !== n.id) } : old,
    )
    try {
      await unwrap(
        api.DELETE("/v1/mailboxes/{id}/notes/{noteId}", {
          params: { path: { id: mail.mailboxId, noteId: n.id } },
        }),
      )
    } catch (e) {
      qc.setQueryData(key, before)
      toast({
        title: "The note wasn’t deleted",
        sub: e instanceof ApiError ? e.message : "Mailyard couldn’t be reached.",
        tone: "error",
      })
    }
  }
  return (
    <section
      className="note"
      aria-label="Internal notes"
      data-endpoint="GET …/threads/{threadId} → notes · POST …/notes · DELETE …/notes/{noteId} · ws live → notes.changed"
    >
      {d.notes.length ? (
        d.notes.map((n) => {
          const mine = myIds.has(n.author.id)
          return (
            <div key={n.id} className="stack stack-4">
              <div className="note-head">
                <b>Internal note</b>
                <span className="t-small">
                  {n.author.name} ·{" "}
                  {rowTime(n.createdAt) === "now" ? "just now" : `${rowTime(n.createdAt)} ago`}
                </span>
                <span className="grow" />
                <Gated
                  allowed={mine || Boolean(canDeleteAny)}
                  side="right"
                  reason="You can’t delete this note"
                  who="Its author, an owner or an admin can."
                >
                  <button
                    className="icon-btn"
                    type="button"
                    aria-label="Delete note"
                    title="Delete note"
                    onClick={() => void remove(n)}
                  >
                    <Icon name="trash" />
                  </button>
                </Gated>
              </div>
              <p style={{ whiteSpace: "pre-wrap" }}>{n.body}</p>
            </div>
          )
        })
      ) : (
        <div className="note-head">
          <b>Internal notes</b>
          <span className="t-small">None yet</span>
        </div>
      )}
      <span className="note-foot">
        Only members of {mail.local} see notes; they never go to the customer.
      </span>
      {mail.access.write ? (
        <form
          className="note-add"
          onSubmit={(e) => {
            e.preventDefault()
            void add()
          }}
        >
          <textarea
            ref={noteRef}
            className="textarea"
            aria-label="Add an internal note"
            placeholder="Add a note for the team. The customer never sees it."
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void add()
              }
              if (e.key === "Escape") e.currentTarget.blur()
            }}
          />
          <button className="btn btn-secondary" type="submit" disabled={busy || !body.trim()}>
            {busy ? "Adding…" : "Add note"}
          </button>
        </form>
      ) : null}
    </section>
  )
}

function ThreadError({
  error,
  onRetry,
  threadId,
  back,
}: {
  error: unknown
  onRetry: () => void
  threadId: string
  back: () => void
}) {
  const { mailboxId } = useMail()
  const e = error instanceof ApiError ? error : null
  const gone = e?.status === 404
  return (
    <section className="mail-reader" aria-label="Conversation">
      <div className="rd-bar" role="toolbar" aria-label="Conversation actions">
        <button className="icon-btn only-phone" type="button" aria-label="Back to the list" onClick={back}>
          <MIcon name="arrow-left" />
        </button>
      </div>
      <div className="pane-scroll rd-scroll">
        <div className="rd-inner">
          <div className="error-block" role="alert">
            <h3>
              <Icon name="warn" />
              {gone ? "This conversation isn’t here any more" : "This conversation didn’t open"}
            </h3>
            <p>
              {gone
                ? "It may have been deleted for good, or moved out of this mailbox. The list is unaffected."
                : e
                  ? `The mailbox answered ${e.status}: ${e.message} The list stays put.`
                  : "Mailyard couldn’t be reached. The list stays put; try again in a moment."}
            </p>
            <p className="mono" style={{ color: "var(--my-muted)", overflowWrap: "anywhere" }}>
              GET /v1/mailboxes/{mailboxId}/threads/{threadId}
              {e ? ` → ${e.status}` : ""}
            </p>
            <div className="cluster">
              {!gone ? (
                <button className="btn btn-secondary btn-sm" type="button" onClick={onRetry}>
                  <Icon name="refresh" />
                  Retry
                </button>
              ) : null}
              <button className="btn btn-ghost btn-sm" type="button" onClick={back}>
                Back to the list
              </button>
              {e?.requestId ? <RequestId id={e.requestId} /> : null}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
