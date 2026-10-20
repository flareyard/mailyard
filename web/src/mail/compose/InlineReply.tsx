/**
 * The inline reply at the end of an open thread (`section.reply`). When no reply is open but the thread has
 * a reply in progress or one scheduled (GET …/threads/{threadId} → drafts), it offers to resume or cancel it.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Icon } from "../../ui/icons.tsx"
import { useMailOptional } from "../context.tsx"
import { utcStamp } from "../logic.ts"
import { mailKeys, threadQuery } from "../queries.ts"
import { toast } from "../toasts.tsx"
import { cancelSend } from "./api.ts"
import { Composer } from "./Composer.tsx"
import { refusalFrom } from "./logic.ts"
import { awaitingApproval } from "./sendState.ts"
import { openReply, useComposeState } from "./store.ts"

export function InlineReply({ threadId }: { threadId: string }) {
  const state = useComposeState()
  const ctx = useMailOptional()
  const qc = useQueryClient()
  const mailboxId = state.inline?.mailboxId ?? ctx?.mailboxId
  const thread = useQuery({ ...threadQuery(mailboxId ?? "", threadId), enabled: Boolean(mailboxId) })
  if (state.inline?.threadId === threadId)
    return (
      <Composer
        key={`r-${state.seq}-${state.inline.draftId ?? state.inline.mode}`}
        request={state.inline}
        variant="inline"
      />
    )
  if (!mailboxId) return null
  const drafts = thread.data?.drafts ?? []
  const open = drafts.filter((d) => d.status === "draft")
  const waiting = drafts.filter((d) => d.status === "scheduled" || d.status === "due")
  if (!open.length && !waiting.length) return null
  return (
    <div className="stack stack-8">
      {open.map((d) => (
        <div key={d.id} className="queued compose-resume">
          <Icon name="pencil" />
          <span className="grow">
            <b>{awaitingApproval(d.id) ? "Reply waiting for approval" : "Reply in progress"}</b>
            <span className="t-small">
              {d.to.map((p) => p.address).join(", ") || "No recipients yet"} · saved {utcStamp(d.updatedAt)}
              {d.blockedReason ? " · can’t send yet" : ""}
            </span>
          </span>
          <button
            className="btn btn-secondary btn-sm"
            type="button"
            onClick={() =>
              openReply({
                mailboxId,
                threadId,
                mode: d.replyMode ?? "reply",
                draftId: d.id,
                ...(d.sourceMessageId ? { messageId: d.sourceMessageId } : {}),
              })
            }
          >
            Resume
          </button>
        </div>
      ))}
      {waiting.map((d) => (
        <div key={d.id} className="queued compose-resume">
          <Icon name="clock" />
          <span className="grow">
            <b>{d.sendAt ? `Reply sends ${utcStamp(d.sendAt)}` : "Reply waiting for approval"}</b>
            <span className="t-small">To {d.to.map((p) => p.address).join(", ")}</span>
          </span>
          <button
            className="btn btn-secondary btn-sm"
            type="button"
            onClick={async () => {
              try {
                await cancelSend(mailboxId, d.id)
                qc.invalidateQueries({ queryKey: mailKeys.thread(mailboxId, threadId) })
                qc.invalidateQueries({ queryKey: mailKeys.draftLists(mailboxId) })
                toast({ title: "Schedule cancelled", sub: "The reply is back in Drafts." })
              } catch (e) {
                toast({ title: "Couldn’t cancel", sub: refusalFrom(e).notice.body, tone: "error" })
              }
            }}
          >
            {d.sendAt ? "Cancel schedule" : "Withdraw"}
          </button>
        </div>
      ))}
    </div>
  )
}
