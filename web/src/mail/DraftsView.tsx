/**
 * Drafts and Scheduled (drafts.html, scheduled.html): autosaved drafts, including one that couldn't send and
 * why (`blockedReason`, `lastError`), and replies waiting to send with Send now and Cancel schedule. The
 * selected draft is in the URL (`?draft=`); editing opens it in the composer.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate, useSearch } from "@tanstack/react-router"
import { ApiError, api, unwrap } from "../api/client.ts"
import { Gated } from "../auth/NoPermission.tsx"
import { fixturesEnabled } from "../fixtures/mode.ts"
import { fmtIn, num } from "../lib/format.ts"
import { Icon } from "../ui/icons.tsx"
import { PanelError } from "../ui/Panel.tsx"
import { openCompose } from "./compose/store.ts"
import { useMail } from "./context.tsx"
import { MIcon } from "./icons.tsx"
import { fileSize, rowTime, textBlocks, utcStamp } from "./logic.ts"
import { draftsQuery, mailKeys } from "./queries.ts"
import { ReaderEmpty } from "./Reader.tsx"
import { toast } from "./toasts.tsx"
import type { Draft } from "./types.ts"
import { SampleMarker, ToolBtn, Who } from "./ui.tsx"

const BLOCKED: Record<string, { title: string; body: string }> = {
  quota_exhausted: {
    title: "Today’s quota is used.",
    body: "The draft is safe; it goes out with the reset unless you change it.",
  },
  domain_unhealthy: {
    title: "The sending domain isn’t healthy.",
    body: "Fix its DNS records in Domains, then send again.",
  },
  all_recipients_suppressed: {
    title: "Every recipient is suppressed.",
    body: "They bounced, complained or unsubscribed before. Remove them or lift the suppression.",
  },
}

export function DraftsView({ status }: { status: "draft" | "scheduled" }) {
  const mail = useMail()
  const { mailboxId } = mail
  const search = useSearch({ strict: false }) as { draft?: string }
  const navigate = useNavigate()
  const q = useQuery(draftsQuery(mailboxId, status === "scheduled" ? "scheduled" : "all"))
  const drafts = (q.data?.drafts ?? []).filter((d) =>
    status === "scheduled" ? d.status === "scheduled" : d.status !== "scheduled",
  )
  const selected = drafts.find((d) => d.id === search.draft)
  const title = status === "scheduled" ? "Scheduled" : "Drafts"
  const select = (id: string) =>
    navigate({
      to: status === "scheduled" ? "/mail/$mailboxId/scheduled" : "/mail/$mailboxId/drafts",
      params: { mailboxId },
      search: { draft: id } as never,
    })
  return (
    <>
      <section
        className="mail-list"
        aria-label={title}
        data-endpoint={`GET /v1/mailboxes/{id}/drafts${status === "scheduled" ? "?status=scheduled" : ""} · ws live → drafts.changed`}
      >
        <div className="ml-head">
          <div className="ml-title-row">
            <Link
              className="icon-btn only-phone"
              to="/mail/$mailboxId/folders"
              params={{ mailboxId }}
              aria-label="Mailboxes and folders"
            >
              <Icon name="menu" />
            </Link>
            <button
              className="icon-btn only-tablet"
              type="button"
              onClick={mail.openFolders}
              aria-label="Show folders"
              title="Folders"
            >
              <Icon name="sidebar" />
            </button>
            <div className="ml-title">
              <h1>{title}</h1>
              <span className="ml-sub">{mail.address}</span>
            </div>
            {fixturesEnabled() ? (
              <span className="hide-phone">
                <SampleMarker />
              </span>
            ) : null}
          </div>
          <div style={{ paddingBottom: 10 }} />
        </div>
        <div className="ml-tools" role="toolbar" aria-label="List actions">
          <ToolBtn icon="refresh" label="Refresh" onClick={() => void q.refetch()} />
          <span className="ml-count">
            {q.isPending
              ? "Loading…"
              : `${drafts.length} ${status === "scheduled" ? "scheduled" : drafts.length === 1 ? "draft" : "drafts"}`}
          </span>
        </div>
        <div className="pane-scroll">
          {q.isPending ? (
            <ul className="ml-rows" aria-label={title}>
              {Array.from({ length: 4 }, (_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton rows
                <li key={i} className="tr is-sk" aria-hidden="true">
                  <div className="tr-gutter" />
                  <div className="tr-body">
                    <span className="sk sk-text" style={{ width: "44%" }} />
                    <span className="sk sk-text" style={{ width: "70%", height: 12, marginTop: 3 }} />
                    <span className="sk sk-text" style={{ width: "90%", height: 10, marginTop: 6 }} />
                  </div>
                </li>
              ))}
            </ul>
          ) : q.isError ? (
            <div style={{ padding: 16 }}>
              <PanelError error={q.error} onRetry={() => q.refetch()} what={`${title} didn’t load`} />
            </div>
          ) : !drafts.length ? (
            <ul className="ml-rows" aria-label={title}>
              <li className="empty" style={{ padding: "48px 20px" }}>
                <span className="empty-icon">
                  <MIcon name={status === "scheduled" ? "clock" : "pencil"} />
                </span>
                <h3>{status === "scheduled" ? "Nothing scheduled" : "No drafts"}</h3>
                <p>
                  {status === "scheduled"
                    ? "Use the arrow beside Send to pick when a reply goes. It waits here until then."
                    : "Anything you start writing is saved here as you type, so nothing is lost."}
                </p>
                {mail.access.write ? (
                  <button
                    className="btn btn-secondary btn-sm"
                    type="button"
                    onClick={() => openCompose({ mailboxId, mode: "new" })}
                    title="Compose · C"
                  >
                    Compose · C
                  </button>
                ) : null}
              </li>
            </ul>
          ) : (
            <ul className="ml-rows" aria-label={title}>
              {drafts.map((d) => (
                <DraftRow key={d.id} d={d} current={d.id === selected?.id} onOpen={() => select(d.id)} />
              ))}
            </ul>
          )}
        </div>
      </section>
      {selected ? (
        <DraftReader d={selected} status={status} />
      ) : (
        <ReaderEmpty state={drafts.length ? "idle" : "empty"} />
      )}
    </>
  )
}

function DraftRow({ d, current, onOpen }: { d: Draft; current: boolean; onOpen: () => void }) {
  const to = d.to[0]
  const sendAt = num(d.sendAt)
  return (
    <li className="tr" {...(current ? { "aria-current": "true" as const } : {})}>
      <div className="tr-gutter">
        <Who name={to?.name} address={to?.address} className="tr-avatar" />
      </div>
      <a
        className="tr-body tr-link"
        href={`?draft=${d.id}`}
        aria-label={`To ${to ? (to.name ?? to.address) : "no one yet"}: ${d.subject || "(no subject)"}`}
        onClick={(e) => {
          e.preventDefault()
          onOpen()
        }}
      >
        <span className="tr-l1">
          <span className="tr-names">
            <span className="me-tag">To</span> {to ? (to.name ?? to.address) : "No recipients yet"}
            {d.to.length > 1 ? ` +${d.to.length - 1}` : ""}
          </span>
          <span className="tr-meta">
            {d.attachments.length ? <Icon name="paperclip" label="Has attachments" /> : null}
            <time>{rowTime(d.updatedAt)}</time>
          </span>
        </span>
        <span className="tr-l2">{d.subject || "(no subject)"}</span>
        <span className="tr-l3">
          <span className="tr-snip">{d.bodyText}</span>
          <span className="tr-tags">
            {d.blockedReason || d.lastError ? (
              <span className="pill pill-fail" style={{ height: 20 }}>
                <span className="dot" />
                Not sent
              </span>
            ) : d.status === "scheduled" && sendAt ? (
              <span className="ltag">Sends {utcStamp(sendAt).replace(" UTC", "")} UTC</span>
            ) : (
              <span className="ltag">Draft</span>
            )}
          </span>
        </span>
      </a>
    </li>
  )
}

function DraftReader({ d, status }: { d: Draft; status: "draft" | "scheduled" }) {
  const mail = useMail()
  const { mailboxId, access } = mail
  const qc = useQueryClient()
  const navigate = useNavigate()
  const sendAt = num(d.sendAt)
  const blocked = d.blockedReason ? BLOCKED[d.blockedReason] : null
  const refresh = () => qc.invalidateQueries({ queryKey: mailKeys.draftLists(mailboxId) })
  const back = () =>
    navigate({
      to: status === "scheduled" ? "/mail/$mailboxId/scheduled" : "/mail/$mailboxId/drafts",
      params: { mailboxId },
      search: {} as never,
    })
  const fail = (what: string, e: unknown) =>
    toast({
      title: what,
      sub:
        e instanceof ApiError
          ? `${e.message}${e.requestId ? ` · ${e.requestId}` : ""}`
          : "Mailyard couldn’t be reached.",
      tone: "error",
    })
  const discard = async () => {
    try {
      await unwrap(
        api.DELETE("/v1/mailboxes/{id}/drafts/{draftId}", {
          params: { path: { id: mailboxId, draftId: d.id } },
        }),
      )
      toast({ title: "Draft discarded" })
      refresh()
      back()
    } catch (e) {
      fail("The draft wasn’t discarded", e)
    }
  }
  const cancel = async () => {
    try {
      await unwrap(
        api.POST("/v1/mailboxes/{id}/drafts/{draftId}/cancel", {
          params: { path: { id: mailboxId, draftId: d.id } },
        }),
      )
      toast({ title: "Schedule cancelled", sub: "It’s back in Drafts." })
      refresh()
      back()
    } catch (e) {
      fail("The schedule wasn’t cancelled", e)
    }
  }
  const sendNow = async () => {
    try {
      const r = await unwrap(
        api.POST("/v1/mailboxes/{id}/drafts/{draftId}/send", {
          params: { path: { id: mailboxId, draftId: d.id } },
          body: { undoSeconds: 10 },
        }),
      )
      refresh()
      if (r?.approval) {
        toast({
          title: "Waiting for approval",
          sub: "This key’s sends wait for a person to approve them in Settings → Approvals.",
        })
        return
      }
      const until = num(r?.undoUntil)
      if (until && until > Date.now())
        toast({
          title: "Sending",
          countdown: "Sends in {n} s",
          until,
          action: {
            label: "Undo",
            onClick: () => {
              void api
                .POST("/v1/mailboxes/{id}/drafts/{draftId}/cancel", {
                  params: { path: { id: mailboxId, draftId: d.id } },
                })
                .then(() => {
                  refresh()
                  toast({ title: "Send undone", sub: "It’s back in Drafts." })
                })
            },
          },
        })
      else toast({ title: "Sent" })
    } catch (e) {
      fail("It didn’t send", e)
    }
  }
  const gate = (node: React.ReactElement<Record<string, unknown>>) =>
    access.write ? (
      node
    ) : (
      <Gated allowed={false} reason={access.writeReason} who={access.writeWho}>
        {node}
      </Gated>
    )
  const recipients = [
    ...d.to.map((p) => ({ ...p, k: "to" })),
    ...d.cc.map((p) => ({ ...p, k: "cc" })),
    ...d.bcc.map((p) => ({ ...p, k: "bcc" })),
  ]
  return (
    <section
      className="mail-reader"
      aria-label="Draft"
      data-endpoint="GET /v1/mailboxes/{id}/drafts/{draftId} · POST …/send · POST …/cancel · DELETE …"
    >
      <div className="rd-bar" role="toolbar" aria-label="Draft actions">
        <button className="icon-btn only-phone" type="button" aria-label="Back" onClick={back}>
          <MIcon name="arrow-left" />
        </button>
        {gate(
          <ToolBtn
            icon="pencil"
            label="Edit"
            onClick={() => openCompose({ mailboxId, mode: "new", draftId: d.id })}
          />,
        )}
        {gate(<ToolBtn icon="trash" label="Discard" keys="#" onClick={() => void discard()} />)}
        {fixturesEnabled() ? (
          <span className="only-phone" style={{ marginLeft: "auto" }}>
            <SampleMarker />
          </span>
        ) : null}
      </div>
      <div className="pane-scroll rd-scroll">
        <div className="rd-inner">
          <header className="rd-head">
            <h2 className="rd-subject">{d.subject || "(no subject)"}</h2>
            <div className="rd-tags">
              <span className="t-small muted">
                {d.status === "scheduled" ? "Scheduled reply" : "Draft"} · saved{" "}
                {rowTime(d.updatedAt) === "now" ? "just now" : `${rowTime(d.updatedAt)} ago`} ·{" "}
                <span className="mono">{d.id}</span>
              </span>
            </div>
          </header>
          {blocked ? (
            <div
              className="callout callout-error"
              role="alert"
              data-endpoint={`draft.blockedReason: ${d.blockedReason}`}
            >
              <Icon name="octagon" />
              <span>
                <b>{blocked.title}</b> {d.lastError ? `${d.lastError} ` : ""}
                {blocked.body}
                {d.blockedReason === "domain_unhealthy" ? (
                  <>
                    {" "}
                    <Link to="/domains">Open Domains</Link>
                  </>
                ) : null}
              </span>
            </div>
          ) : d.lastError ? (
            <div className="callout callout-error" role="alert">
              <Icon name="warn" />
              <span>
                <b>It didn’t send.</b> {d.lastError}
              </span>
            </div>
          ) : d.status === "scheduled" && sendAt ? (
            <div className="callout callout-info" role="status">
              <Icon name="clock" />
              <span>
                <b>Sends {utcStamp(sendAt)}</b> ({fmtIn(sendAt)}) from{" "}
                <span className="mono">{d.from ?? mail.address}</span>. It counts against that day’s quota.
              </span>
            </div>
          ) : null}
          <div className="cluster">
            {d.status === "scheduled" ? (
              <>
                {gate(
                  <button
                    className="btn btn-primary"
                    type="button"
                    onClick={() => void sendNow()}
                    data-endpoint="POST /v1/mailboxes/{id}/drafts/{draftId}/send {undoSeconds:10}"
                  >
                    Send now
                  </button>,
                )}
                {gate(
                  <button
                    className="btn btn-secondary"
                    type="button"
                    onClick={() => void cancel()}
                    data-endpoint="POST /v1/mailboxes/{id}/drafts/{draftId}/cancel"
                  >
                    Cancel schedule
                  </button>,
                )}
                {gate(
                  <button
                    className="btn btn-ghost"
                    type="button"
                    onClick={() => openCompose({ mailboxId, mode: "new", draftId: d.id })}
                  >
                    Edit
                  </button>,
                )}
              </>
            ) : (
              <>
                {gate(
                  <button
                    className="btn btn-primary"
                    type="button"
                    onClick={() => openCompose({ mailboxId, mode: "new", draftId: d.id })}
                  >
                    Edit draft
                  </button>,
                )}
                {d.status === "due" || d.blockedReason
                  ? gate(
                      <button
                        className="btn btn-secondary"
                        type="button"
                        onClick={() => openCompose({ mailboxId, mode: "new", draftId: d.id })}
                        data-endpoint="POST /v1/mailboxes/{id}/drafts/{draftId}/send {sendAt}"
                      >
                        Reschedule
                      </button>,
                    )
                  : null}
                {gate(
                  <button
                    className="btn btn-danger-ghost"
                    type="button"
                    onClick={() => void discard()}
                    data-endpoint="DELETE /v1/mailboxes/{id}/drafts/{draftId}"
                  >
                    Discard
                  </button>,
                )}
              </>
            )}
          </div>
          <article className="msg">
            <header className="msg-head">
              <Who name={mail.mailbox?.displayName} address={d.from ?? mail.address} us lg />
              <div className="msg-from">
                <b>{mail.mailbox?.displayName ?? d.from ?? mail.address}</b>
                <span className="msg-addr">{d.from ?? mail.address}</span>
              </div>
              <span className="msg-side" />
              <div className="msg-to">
                {recipients.length
                  ? recipients.map((p, i) => (
                      <span key={`${p.k}:${p.address}`}>
                        {i ? ", " : ""}
                        {p.k} <span className="mono">{p.address}</span>
                      </span>
                    ))
                  : "No recipients yet"}
              </div>
            </header>
            <div className="msg-body">
              {textBlocks(d.bodyText || " ").map((b) => (
                <p
                  key={`${b.kind}:${b.text.slice(0, 40)}`}
                  className={b.kind === "quote" ? "quote" : undefined}
                  style={{ whiteSpace: "pre-wrap" }}
                >
                  {b.text}
                </p>
              ))}
              {d.attachments.length ? (
                <div className="cluster" style={{ marginTop: 12 }}>
                  {d.attachments.map((a) => (
                    <span key={a.key} className="chip" style={{ fontFamily: "var(--font-sans)" }}>
                      {a.filename} · {fileSize(a.size)}
                      {a.delivery === "link" ? " · as a link" : ""}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </article>
          {d.threadId ? (
            <Link
              className="link-quiet"
              to="/mail/$mailboxId/threads/$threadId"
              params={{ mailboxId, threadId: d.threadId }}
            >
              Open the conversation it replies to
            </Link>
          ) : null}
        </div>
      </div>
    </section>
  )
}
