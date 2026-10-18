/**
 * The pickers (HANDOFF-mail §4, snooze.html, label-move.html, assign.html, more-menu.html): `.menu.mail-menu`
 * popovers under the reader bar or the bulk bar, bottom sheets on a phone (mail.css). Every action is one
 * `POST …/threads/bulk`, through useBulk, so it is optimistic and undoable.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useEffect, useMemo, useRef, useState } from "react"
import { api, unwrap } from "../api/client.ts"
import { Icon } from "../ui/icons.tsx"
import { cachedThreads, useBulk } from "./actions.ts"
import { useMail } from "./context.tsx"
import { useMyAssignee } from "./FolderPane.tsx"
import { MIcon } from "./icons.tsx"
import { dateInput, snoozePresets, utcFromInputs, utcShort, utcStamp } from "./logic.ts"
import { mailboxDetailQuery, mailKeys } from "./queries.ts"
import { toast } from "./toasts.tsx"
import type { FoldersBody, Label, LabelColor } from "./types.ts"
import { LabelDot, Who } from "./ui.tsx"

export type PickerKind = "snooze" | "label" | "move" | "assign" | "more"
export type PickerState = {
  kind: PickerKind
  ids: string[]
  where: "reader" | "list"
  left: number
  messageId?: string | undefined
}

const COLORS: LabelColor[] = ["blue", "navy", "sky", "teal", "pine", "slate"]

/** Closes on Escape and on a click outside; focuses the first control. */
function useMenuFrame(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>("input, button, a")
    first?.focus()
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (ref.current?.contains(t) || t.closest("[aria-haspopup='menu']")) return
      onClose()
    }
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener("mousedown", onDoc)
    document.addEventListener("keydown", onEsc, true)
    return () => {
      document.removeEventListener("mousedown", onDoc)
      document.removeEventListener("keydown", onEsc, true)
    }
  }, [onClose])
  return ref
}

/** Arrow keys move between the menu's items. */
function onMenuKeys(e: React.KeyboardEvent<HTMLDivElement>) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
  const items = [
    ...e.currentTarget.querySelectorAll<HTMLElement>(
      "button:not([aria-disabled='true']), a, input[type=checkbox]",
    ),
  ]
  const i = items.indexOf(document.activeElement as HTMLElement)
  const next = items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]
  if (next) {
    e.preventDefault()
    next.focus()
  }
}

export function Picker({
  state,
  onClose,
  onDone,
}: {
  state: PickerState
  onClose: () => void
  onDone?: () => void
}) {
  const style = { left: Math.max(8, state.left), top: 52 }
  const props = { state, onClose, onDone: onDone ?? onClose, style }
  if (state.kind === "snooze") return <SnoozeMenu {...props} />
  if (state.kind === "label" || state.kind === "move") return <LabelMenu {...props} />
  if (state.kind === "assign") return <AssignMenu {...props} />
  return <MoreMenu {...props} />
}

type MenuProps = { state: PickerState; onClose: () => void; onDone: () => void; style: React.CSSProperties }

function SnoozeMenu({ state, onClose, onDone, style }: MenuProps) {
  const { mailboxId } = useMail()
  const bulk = useBulk(mailboxId)
  const ref = useMenuFrame(onClose)
  const presets = useMemo(() => snoozePresets(), [])
  const fallback = presets[presets.length - 1]?.until ?? Date.now() + 86_400_000
  const [date, setDate] = useState(dateInput(fallback))
  const [time, setTime] = useState("09:00")
  const custom = utcFromInputs(date, time)
  const go = (until: number) => {
    onDone()
    void bulk("snooze", state.ids, { until })
  }
  return (
    <div
      className="menu mail-menu"
      role="menu"
      aria-label="Snooze until"
      style={style}
      ref={ref}
      onKeyDown={onMenuKeys}
      tabIndex={-1}
    >
      <div className="menu-label">Snooze until · comes back to the Inbox, unread</div>
      {presets.map((p) => (
        <button
          key={p.label}
          className="menu-item"
          type="button"
          role="menuitem"
          data-endpoint={`POST /v1/mailboxes/{id}/threads/bulk {action:snooze, until:${p.until}}`}
          onClick={() => go(p.until)}
        >
          <span className="grow">{p.label}</span>
          <span className="when">{utcShort(p.until)}</span>
        </button>
      ))}
      <div className="menu-sep" />
      <div className="menu-label">Pick a date and time (UTC)</div>
      <form
        className="menu-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (custom && custom > Date.now()) go(custom)
        }}
      >
        <input
          className="input"
          type="date"
          value={date}
          min={dateInput(Date.now())}
          onChange={(e) => setDate(e.target.value)}
          aria-label="Date"
        />
        <input
          className="input"
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          aria-label="Time, UTC"
        />
        <button className="btn btn-primary btn-sm" type="submit" disabled={!custom || custom <= Date.now()}>
          {custom && custom > Date.now() ? `Snooze until ${utcStamp(custom)}` : "Pick a time in the future"}
        </button>
      </form>
      <div className="menu-note">Times are UTC until your profile has a time zone.</div>
    </div>
  )
}

function LabelMenu({ state, onClose, onDone, style }: MenuProps) {
  const { mailboxId, labels } = useMail()
  const bulk = useBulk(mailboxId)
  const qc = useQueryClient()
  const navigate = useNavigate()
  const ref = useMenuFrame(onClose)
  const [find, setFind] = useState("")
  const [creating, setCreating] = useState(false)
  const threads = cachedThreads(qc, mailboxId, state.ids)
  const has = (l: Label) => {
    const n = threads.filter((t) => t.labelIds.includes(l.id)).length
    return n === 0 ? "none" : n === threads.length ? "all" : "some"
  }
  const shown = labels.filter((l) => l.name.toLowerCase().includes(find.trim().toLowerCase()))
  const exact = labels.some((l) => l.name.toLowerCase() === find.trim().toLowerCase())
  const toggle = (l: Label) => {
    const state_ = has(l)
    void bulk(state_ === "all" ? "unlabel" : "label", state.ids, { labelId: l.id }, { labelName: l.name })
  }
  const create = async () => {
    const name = find.trim()
    if (!name) return
    setCreating(true)
    try {
      const color = COLORS[labels.length % COLORS.length] ?? null
      const label = await unwrap(
        api.POST("/v1/mailboxes/{id}/labels", { params: { path: { id: mailboxId } }, body: { name, color } }),
      )
      if (label) {
        qc.setQueryData<FoldersBody>(mailKeys.folders(mailboxId), (old) =>
          old ? { ...old, labels: [...old.labels, label] } : old,
        )
        await bulk("label", state.ids, { labelId: label.id }, { labelName: label.name })
      }
      setFind("")
    } catch {
      toast({
        title: `“${name}” wasn’t created`,
        sub: "A label with that name may already exist.",
        tone: "error",
      })
    } finally {
      setCreating(false)
    }
  }
  const move = (action: "inbox" | "archive" | "spam" | "trash") => {
    onDone()
    void bulk(action, state.ids)
  }
  return (
    <div
      className="menu mail-menu"
      role="menu"
      aria-label={state.kind === "move" ? "Move to" : "Label as"}
      style={style}
      ref={ref}
      onKeyDown={onMenuKeys}
      tabIndex={-1}
      data-endpoint="POST /v1/mailboxes/{id}/threads/bulk {action:label|unlabel|move, labelId}"
    >
      {state.kind === "label" ? (
        <>
          <div className="menu-search">
            <input
              className="input"
              type="text"
              placeholder="Find or create a label"
              aria-label="Find or create a label"
              value={find}
              onChange={(e) => setFind(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  const only = shown.length === 1 ? shown[0] : undefined
                  if (only) toggle(only)
                  else if (!exact && find.trim()) void create()
                }
              }}
            />
          </div>
          {shown.map((l) => {
            const h = has(l)
            return (
              <label key={l.id} className="check">
                <input
                  type="checkbox"
                  checked={h === "all"}
                  ref={(el) => {
                    if (el) el.indeterminate = h === "some"
                  }}
                  onChange={() => toggle(l)}
                />
                <LabelDot color={l.color} />
                <span className="grow">{l.name}</span>
              </label>
            )
          })}
          {find.trim() && !exact ? (
            <button
              className="menu-item"
              type="button"
              role="menuitem"
              onClick={create}
              disabled={creating}
              data-endpoint="POST /v1/mailboxes/{id}/labels"
            >
              <Icon name="plus" />
              <span className="grow">{creating ? "Creating…" : `Create “${find.trim()}”`}</span>
            </button>
          ) : null}
          {!labels.length && !find ? (
            <div className="menu-note">No labels yet: type a name to create one.</div>
          ) : null}
          <div className="menu-sep" />
        </>
      ) : null}
      <div className="menu-label">Move to</div>
      <button className="menu-item" type="button" role="menuitem" onClick={() => move("inbox")}>
        <MIcon name="inbox" />
        <span className="grow">Inbox</span>
      </button>
      <button className="menu-item" type="button" role="menuitem" onClick={() => move("archive")}>
        <MIcon name="archive" />
        <span className="grow">Archive</span>
        <span className="kbd">E</span>
      </button>
      <button className="menu-item" type="button" role="menuitem" onClick={() => move("spam")}>
        <Icon name="octagon" />
        <span className="grow">Spam</span>
        <span className="kbd">!</span>
      </button>
      <button className="menu-item" type="button" role="menuitem" onClick={() => move("trash")}>
        <Icon name="trash" />
        <span className="grow">Trash</span>
        <span className="kbd">#</span>
      </button>
      <div className="menu-sep" />
      <button
        className="menu-item"
        type="button"
        role="menuitem"
        onClick={() => {
          onClose()
          navigate({
            to: ".",
            search: ((p: Record<string, unknown>) => ({ ...p, sheet: "labels" })) as never,
          })
        }}
      >
        <span className="grow">Edit labels</span>
      </button>
    </div>
  )
}

function AssignMenu({ state, onClose, onDone, style }: MenuProps) {
  const { mailboxId, local } = useMail()
  const bulk = useBulk(mailboxId)
  const qc = useQueryClient()
  const ref = useMenuFrame(onClose)
  const detail = useQuery(mailboxDetailQuery(mailboxId))
  const me = useMyAssignee()
  const [find, setFind] = useState("")
  const current = new Set(cachedThreads(qc, mailboxId, state.ids).map((t) => t.assignee ?? ""))
  const people = [
    ...(detail.data?.people ?? []).map((p) => ({
      id: p.memberId,
      name: p.name,
      sub: p.email,
      viewer: p.access === "viewer",
      key: false,
    })),
    ...(detail.data?.members ?? [])
      .filter((m) => !m.revoked)
      .map((m) => ({ id: m.apiKeyId, name: m.name, sub: "API key", viewer: m.role === "viewer", key: true })),
  ].filter((p) => p.name.toLowerCase().includes(find.trim().toLowerCase()))
  const assign = (id: string | null, name: string | null) => {
    onDone()
    void bulk("assign", state.ids, { assignee: id, assigneeName: name })
  }
  return (
    <div
      className="menu mail-menu"
      role="menu"
      aria-label="Assign to"
      style={style}
      ref={ref}
      onKeyDown={onMenuKeys}
      tabIndex={-1}
      data-endpoint="GET /v1/mailboxes/{id} → members, people · POST …/threads/bulk {action:assign}"
    >
      <div className="menu-search">
        <input
          className="input"
          type="text"
          placeholder="Assign to…"
          aria-label="Find a member"
          value={find}
          onChange={(e) => setFind(e.target.value)}
        />
      </div>
      <div className="menu-label">Members of {local}</div>
      {detail.isPending ? <div className="menu-note">Loading members…</div> : null}
      {detail.isError ? <div className="menu-note">Members didn’t load; you can still unassign.</div> : null}
      {people.map((p) =>
        p.viewer ? (
          <span
            key={p.id}
            className="menu-item"
            aria-disabled="true"
            style={{ color: "var(--gray-900)", cursor: "not-allowed" }}
          >
            <Who name={p.name} />
            <span className="grow">
              {p.name}
              <span className="ws-host" style={{ display: "block", fontFamily: "var(--font-sans)" }}>
                Viewer on this mailbox · can’t reply
              </span>
            </span>
          </span>
        ) : (
          <button
            key={p.id}
            className="menu-item"
            type="button"
            role="menuitemradio"
            aria-checked={current.size === 1 && current.has(p.id)}
            onClick={() => assign(p.id, p.name)}
          >
            {p.key ? <Icon name="key" /> : <Who name={p.name} />}
            <span className="grow">
              {p.name}
              {p.id === me ? " (you)" : ""}
            </span>
            {current.size === 1 && current.has(p.id) ? <Icon name="check" /> : null}
          </button>
        ),
      )}
      {!detail.isPending && !people.length ? <div className="menu-note">No members match.</div> : null}
      <div className="menu-sep" />
      <button
        className="menu-item"
        type="button"
        role="menuitem"
        onClick={() => assign(null, null)}
        disabled={current.size === 1 && current.has("")}
      >
        <span className="grow">Unassign</span>
      </button>
      <div className="menu-note">Assigning moves the thread into that person’s “Assigned to me”.</div>
    </div>
  )
}

function MoreMenu({ state, onClose, onDone, style }: MenuProps) {
  const mail = useMail()
  const { mailboxId } = mail
  const bulk = useBulk(mailboxId)
  const qc = useQueryClient()
  const navigate = useNavigate()
  const ref = useMenuFrame(onClose)
  const threads = cachedThreads(qc, mailboxId, state.ids)
  const t = threads[0]
  const sender = t?.participants.find((p) => !mail.ours.has(p.address.toLowerCase()))?.address
  const single = state.ids.length === 1
  const link = single && t ? `/mail/${mailboxId}/threads/${t.id}` : ""
  const block = async () => {
    if (!sender) return
    onDone()
    try {
      await unwrap(
        api.POST("/v1/mailboxes/{id}/senders", {
          params: { path: { id: mailboxId } },
          body: { value: sender, list: "block" },
        }),
      )
      toast({ title: `Blocked ${sender}`, sub: "Their mail goes to Spam from now on." })
      await bulk("spam", state.ids, {}, { quiet: true })
    } catch {
      toast({ title: `${sender} wasn’t blocked`, tone: "error" })
    }
  }
  return (
    <div
      className="menu mail-menu"
      role="menu"
      aria-label="More actions"
      style={{ ...style, left: "auto", right: 12 }}
      ref={ref}
      onKeyDown={onMenuKeys}
      tabIndex={-1}
    >
      <button
        className="menu-item"
        type="button"
        role="menuitem"
        onClick={() => {
          onDone()
          void bulk("unread", state.ids)
        }}
      >
        <span className="grow">Mark unread</span>
        <span className="kbd">⇧ U</span>
      </button>
      <button
        className="menu-item"
        type="button"
        role="menuitem"
        onClick={() => {
          onDone()
          void bulk("read", state.ids)
        }}
      >
        <span className="grow">Mark read</span>
        <span className="kbd">⇧ I</span>
      </button>
      <button
        className="menu-item"
        type="button"
        role="menuitem"
        onClick={() => {
          onDone()
          void bulk(t?.starred ? "unstar" : "star", state.ids)
        }}
      >
        <span className="grow">{t?.starred ? "Unstar" : "Star"}</span>
        <span className="kbd">⇧ S</span>
      </button>
      <button
        className="menu-item"
        type="button"
        role="menuitem"
        data-endpoint="POST …/threads/bulk {action:spam}"
        onClick={() => {
          onDone()
          void bulk("spam", state.ids)
        }}
      >
        <span className="grow">Mark as spam</span>
        <span className="kbd">!</span>
      </button>
      {sender && mail.access.manage ? (
        <button
          className="menu-item danger"
          type="button"
          role="menuitem"
          data-endpoint="POST /v1/mailboxes/{id}/senders {list:block}"
          onClick={block}
        >
          <span className="grow">Block {sender}</span>
        </button>
      ) : null}
      {single && state.messageId ? (
        <>
          <div className="menu-sep" />
          {mail.access.manage ? (
            <button
              className="menu-item"
              type="button"
              role="menuitem"
              data-endpoint="POST /v1/mailboxes/{id}/rules"
              onClick={() => {
                onClose()
                navigate({
                  to: ".",
                  search: ((p: Record<string, unknown>) => ({
                    ...p,
                    sheet: "rule",
                    message: state.messageId,
                  })) as never,
                })
              }}
            >
              <span className="grow">Create a rule from this</span>
            </button>
          ) : null}
          <button
            className="menu-item"
            type="button"
            role="menuitem"
            data-endpoint="GET /v1/mailboxes/{id}/messages/{messageId}/raw"
            onClick={() => {
              onClose()
              navigate({
                to: ".",
                search: ((p: Record<string, unknown>) => ({ ...p, raw: state.messageId })) as never,
              })
            }}
          >
            <span className="grow">View original (.eml)</span>
          </button>
          <button
            className="menu-item"
            type="button"
            role="menuitem"
            onClick={() => {
              onClose()
              navigate({
                to: ".",
                search: ((p: Record<string, unknown>) => ({ ...p, details: state.messageId })) as never,
              })
            }}
          >
            <span className="grow">Message details</span>
          </button>
          <button
            className="menu-item"
            type="button"
            role="menuitem"
            onClick={() => {
              onClose()
              setTimeout(() => window.print(), 50)
            }}
          >
            <span className="grow">Print</span>
            <span className="kbd">⌘ P</span>
          </button>
          <button
            className="menu-item"
            type="button"
            role="menuitem"
            onClick={() => {
              onClose()
              navigator.clipboard?.writeText(`${window.location.origin}${link}`)
              toast({ title: "Link copied", sub: link })
            }}
          >
            <span className="grow">Copy link</span>
          </button>
          <div className="menu-sep" />
          <div className="menu-note mono" style={{ fontSize: 11, overflowWrap: "anywhere" }}>
            {link}
          </div>
        </>
      ) : null}
    </div>
  )
}
