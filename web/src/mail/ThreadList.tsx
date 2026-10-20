/**
 * The thread list (`section.mail-list`, inbox.html): the header with search, operator chips and filters;
 * the toolbar (or the bulk bar while anything is selected) with the live pill; virtualised 80 px rows
 * (88 on a phone) that page by cursor at the `.ml-more` sentinel; and every designed state (loading,
 * error, empty per folder, filtered, search, search empty, reconnecting, offline, resumed, reset).
 */
import { useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { api, unwrap } from "../api/client.ts"
import { Gated } from "../auth/NoPermission.tsx"
import { fixturesEnabled } from "../fixtures/mode.ts"
import { num } from "../lib/format.ts"
import { Icon } from "../ui/icons.tsx"
import { PanelError, RequestId } from "../ui/Panel.tsx"
import { useBulk } from "./actions.ts"
import { useMail } from "./context.tsx"
import { useMyAssignee } from "./FolderPane.tsx"
import { MIcon } from "./icons.tsx"
import { isFresh, useFreshVersion } from "./live.ts"
import {
  counterpart,
  FOLDER_TITLE,
  isFiltered,
  listSearchString,
  namesLine,
  OPERATORS,
  operatorSuggestions,
  removeOperator,
  rowTime,
  stripMarks,
  utcShort,
} from "./logic.ts"
import {
  correspondentsQuery,
  mailboxDetailQuery,
  messageQuery,
  PAGE,
  searchQuery,
  threadsQuery,
} from "./queries.ts"
import {
  clearSelection,
  getAnchor,
  getSelection as selectedNow,
  setSelection,
  toggleSelected,
  useSelection,
} from "./selection.ts"
import { toast } from "./toasts.tsx"
import type { BulkAction, ListQuery, SearchBody, Thread } from "./types.ts"
import { DeliveryPill, Hl, LabelTag, SampleMarker, ToolBtn, useMenu, Who } from "./ui.tsx"

export type ListApi = {
  rows: Thread[]
  /** Highlighted subjects and excerpts for search rows, by thread id. */
  marks: Map<string, { subject: string; excerpt: string }>
}

const ROW = 80
const ROW_PHONE = 88
const OVERSCAN = 8

/** Rows for the list's query: the folder's pages, or the search's threads. */
export function useListRows(mailboxId: string, q: ListQuery) {
  const isSearch = Boolean(q.q)
  const threads = useInfiniteQuery({ ...threadsQuery(mailboxId, q), enabled: !isSearch })
  const search = useQuery(searchQuery(mailboxId, q.q ?? "", q.sort))
  const rows = useMemo(() => {
    const all = isSearch
      ? (search.data?.threads ?? [])
      : (threads.data?.pages.flatMap((p) => p.threads) ?? [])
    return q.att ? all.filter((t) => t.hasAttachments) : all
  }, [isSearch, search.data, threads.data, q.att])
  const marks = useMemo(() => {
    const m = new Map<string, { subject: string; excerpt: string }>()
    for (const h of search.data?.hits ?? [])
      if (!m.has(h.threadId)) m.set(h.threadId, { subject: h.subjectHighlighted, excerpt: h.excerpt })
    return m
  }, [search.data])
  return { isSearch, threads, search, rows, marks }
}

export function ThreadList({
  q,
  openId,
  cursorId,
  setCursorId,
  onBulk,
  searchRef,
  pickerSlot,
}: {
  q: ListQuery
  openId: string | undefined
  cursorId: string | null
  setCursorId: (id: string | null) => void
  onBulk: (cmd: BulkCmd) => void
  searchRef: React.RefObject<HTMLInputElement | null>
  pickerSlot?: ReactNode
}) {
  const mail = useMail()
  const { mailboxId } = mail
  const navigate = useNavigate()
  const { isSearch, threads, search, rows, marks } = useListRows(mailboxId, q)
  const selected = useSelection()
  useFreshVersion()
  const listKey = listSearchString(q)
  // A new list starts with nothing selected.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the list's identity is the trigger
  useEffect(() => clearSelection(), [listKey, mailboxId])

  const title = isSearch
    ? "Search"
    : q.labelId
      ? (mail.labelById.get(q.labelId)?.name ?? "Label")
      : q.starred
        ? "Starred"
        : q.assignee
          ? "Assigned to me"
          : FOLDER_TITLE[q.folder ?? "inbox"]
  const query = isSearch ? search : threads
  const first = threads.data?.pages[0]
  const total = num(first?.total)
  const count = query.isPending
    ? "Loading…"
    : query.isError
      ? "—"
      : isSearch
        ? `${rows.length} result${rows.length === 1 ? "" : "s"}`
        : q.att || isFiltered(q) || total === null
          ? rows.length
            ? `${rows.length} shown${isFiltered(q) ? " · filtered" : ""}`
            : "0 conversations"
          : q.folder === "spam" || q.folder === "snoozed"
            ? `${total} conversation${total === 1 ? "" : "s"}`
            : total
              ? `1–${rows.length} of ${total.toLocaleString("en")}`
              : "0 conversations"

  const ids = rows.map((r) => r.id)
  const allChecked = ids.length > 0 && ids.every((id) => selected.has(id))
  const someChecked = selected.size > 0

  const copyLink = () => {
    const url = `${window.location.origin}/mail/${mailboxId}${isSearch ? "/search" : ""}${listKey}`
    navigator.clipboard?.writeText(url)
    toast({ title: "Link copied", sub: url.replace(window.location.origin, "") })
  }

  return (
    <section
      className="mail-list"
      aria-label={title}
      data-endpoint={
        isSearch
          ? "GET /v1/mailboxes/{id}/search?q=&sort="
          : "GET /v1/mailboxes/{id}/threads?folder=&labelId=&unread=&starred=&assignee=&cursor= · POST /v1/mailboxes/{id}/threads/bulk · ws /v1/mailboxes/{id}/live"
      }
      data-url={`/mail/${mailboxId}${isSearch ? "/search" : ""}${listKey}`}
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
            <span className="ml-sub">
              {isSearch ? "in " : ""}
              {mail.address}
            </span>
          </div>
          {fixturesEnabled() ? (
            <span className="hide-phone">
              <SampleMarker />
            </span>
          ) : null}
        </div>
        <SearchBox q={q} searchRef={searchRef} parsed={search.data?.parsed} />
        {isSearch ? <SearchExtras q={q} /> : <Filters q={q} />}
      </div>

      {someChecked ? (
        <BulkBar ids={ids} allChecked={allChecked} onBulk={onBulk} q={q} />
      ) : (
        <div className="ml-tools" role="toolbar" aria-label="List actions">
          <label className="check" title="Select all · ⇧ X">
            <input
              type="checkbox"
              aria-label="Select all on this page"
              checked={false}
              disabled={!ids.length}
              onChange={() => setSelection(ids, ids[0] ?? null)}
            />
          </label>
          <ToolBtn icon="refresh" label="Refresh" onClick={() => void query.refetch()} />
          <ToolBtn icon="link" label="Copy link to this view" onClick={copyLink} />
          {isSearch ? <SortSeg q={q} /> : null}
          <span className="ml-count">{count}</span>
          {!isSearch ? <LivePill /> : null}
        </div>
      )}

      <LiveNotes q={q} />
      {q.folder === "spam" || q.folder === "trash" ? (
        <PurgeNote folder={q.folder} empty={!rows.length} />
      ) : null}
      {mail.access.mailboxAccess === "viewer" ? (
        <div className="ml-note" role="note">
          <Icon name="eye" />
          <span className="grow">
            You can read and search {mail.local}, but not reply, move, label or assign.
          </span>
        </div>
      ) : null}

      <Rows
        q={q}
        rows={rows}
        marks={marks}
        openId={openId}
        cursorId={cursorId}
        setCursorId={setCursorId}
        query={query}
        isSearch={isSearch}
        hasMore={!isSearch && Boolean(threads.hasNextPage)}
        loadMore={() => void threads.fetchNextPage()}
        loadingMore={threads.isFetchingNextPage}
        nextCursor={first ? (threads.data?.pages.at(-1)?.nextCursor ?? null) : null}
        onOpen={(id) =>
          navigate({
            to: "/mail/$mailboxId/threads/$threadId",
            params: { mailboxId, threadId: id },
            search: q as never,
          })
        }
        searchData={search.data}
      />
      {pickerSlot}
    </section>
  )
}

export type BulkKind = "snooze" | "label" | "move" | "assign" | "more"
/** What the bulk bar asks for: a picker, or an action straight away. */
export type BulkCmd = BulkKind | `act:${BulkAction}`

function BulkBar({
  ids,
  allChecked,
  onBulk,
  q,
}: {
  ids: string[]
  allChecked: boolean
  onBulk: (cmd: BulkCmd) => void
  q: ListQuery
}) {
  const selected = useSelection()
  const { access } = useMail()
  const can = access.write
  const gate = (node: React.ReactElement<Record<string, unknown>>) =>
    can ? (
      node
    ) : (
      <Gated allowed={false} reason={access.writeReason} who={access.writeWho}>
        {node}
      </Gated>
    )
  const inTrash = q.folder === "trash"
  const inSpam = q.folder === "spam"
  return (
    <div
      className="ml-tools is-bulk"
      role="toolbar"
      aria-label="Bulk actions"
      data-endpoint="POST /v1/mailboxes/{id}/threads/bulk"
    >
      <label className="check" title="Select all · ⇧ X">
        <input
          type="checkbox"
          aria-label={allChecked ? "Clear selection" : "Select all"}
          checked={allChecked}
          ref={(el) => {
            if (el) el.indeterminate = !allChecked && selected.size > 0
          }}
          onChange={() => (allChecked ? clearSelection() : setSelection(ids, ids[0] ?? null))}
        />
      </label>
      <span className="bulk-n" role="status">
        {selected.size} selected
      </span>
      {inTrash
        ? gate(<ToolBtn icon="inbox" label="Restore to Inbox" onClick={() => onBulk("act:inbox")} />)
        : gate(<ToolBtn icon="archive" label="Archive" keys="E" onClick={() => onBulk("act:archive")} />)}
      {gate(
        <ToolBtn
          icon="trash"
          label={inTrash ? "Delete forever" : "Delete"}
          keys="#"
          onClick={() => onBulk(inTrash ? "act:delete" : "act:trash")}
        />,
      )}
      {gate(
        <ToolBtn
          icon="check"
          label="Mark read"
          keys="⇧ I"
          className="hide-phone"
          onClick={() => onBulk("act:read")}
        />,
      )}
      {gate(
        <ToolBtn
          icon="star"
          label="Star"
          keys="⇧ S"
          className="hide-narrow hide-phone"
          onClick={() => onBulk("act:star")}
        />,
      )}
      <span className="vdivider hide-phone" aria-hidden="true" />
      {gate(
        <ToolBtn icon="tag" label="Label" keys="L" aria-haspopup="menu" onClick={() => onBulk("label")} />,
      )}
      {gate(
        <ToolBtn
          icon="move"
          label="Move"
          keys="V"
          className="hide-phone"
          aria-haspopup="menu"
          onClick={() => onBulk("move")}
        />,
      )}
      {gate(
        <ToolBtn
          icon="clock"
          label="Snooze"
          keys="S"
          aria-haspopup="menu"
          onClick={() => onBulk("snooze")}
        />,
      )}
      {gate(
        <ToolBtn
          icon="user-check"
          label="Assign"
          keys="A"
          className="hide-phone"
          aria-haspopup="menu"
          onClick={() => onBulk("assign")}
        />,
      )}
      {gate(
        inSpam ? (
          <ToolBtn
            icon="check-circle"
            label="Not spam"
            className="hide-phone"
            onClick={() => onBulk("act:notSpam")}
          />
        ) : (
          <ToolBtn
            icon="octagon"
            label="Mark as spam"
            keys="!"
            className="hide-phone"
            onClick={() => onBulk("act:spam")}
          />
        ),
      )}
      <ToolBtn
        icon="more"
        label="More bulk actions"
        className="only-phone"
        aria-haspopup="menu"
        onClick={() => onBulk("more")}
      />
      <button
        className="btn btn-ghost btn-sm hide-phone"
        type="button"
        style={{ marginLeft: "auto" }}
        onClick={clearSelection}
        title="Clear selection · Esc"
      >
        Clear
      </button>
      <button
        className="icon-btn only-phone"
        type="button"
        aria-label="Clear selection"
        title="Clear selection · Esc"
        onClick={clearSelection}
        style={{ marginLeft: "auto" }}
      >
        <Icon name="x" />
      </button>
    </div>
  )
}

/** The Live pill: green while open, amber with the try count while reconnecting, grey offline. */
function LivePill() {
  const { live } = useMail()
  const [tries, setTries] = useState(0)
  const [asOf, setAsOf] = useState<number | null>(null)
  const prev = useRef(live)
  useEffect(() => {
    if (live === "reconnecting" && prev.current !== "reconnecting") setTries((n) => n + 1)
    if (live === "open") setTries(0)
    if (live === "offline" && prev.current !== "offline") setAsOf(Date.now())
    prev.current = live
  }, [live])
  if (live === "closed" && !fixturesEnabled()) return null
  if (live === "reconnecting" || live === "connecting")
    return (
      <span className="live is-reconnecting" role="status">
        <span className="dot" />
        {live === "connecting" ? "Connecting" : "Reconnecting"}
        {tries ? <span className="hide-phone">&nbsp;· try {tries}</span> : null}
      </span>
    )
  if (live === "offline")
    return (
      <span className="live is-offline" role="status">
        <span className="dot" />
        Offline
        {asOf ? (
          <span className="hide-phone">&nbsp;· as of {new Date(asOf).toISOString().slice(11, 16)} UTC</span>
        ) : null}
      </span>
    )
  return (
    <span className="live" role="status" title="Live over the mailbox socket">
      <span className="dot" />
      Live
    </span>
  )
}

function LiveNotes({ q }: { q: ListQuery }) {
  const { live, liveNote, local } = useMail()
  const [dismissed, setDismissed] = useState<unknown>(null)
  if (q.q) return null
  if (live === "reconnecting")
    return (
      <div className="ml-note" role="status" data-endpoint="ws /v1/mailboxes/{id}/live?since=">
        <Icon name="wifi-off" />
        <span className="grow">
          Reconnecting to {local}’s live feed. The last change seen is kept, so nothing is lost: on reconnect
          the server replays what you missed. Everything else works meanwhile.
        </span>
      </div>
    )
  if (live === "offline")
    return (
      <div className="ml-note" role="status">
        <Icon name="wifi-off" />
        <span className="grow">
          You’re offline. This list is what was loaded last; it updates when you’re back.
        </span>
      </div>
    )
  if (!liveNote || dismissed === liveNote) return null
  if (liveNote.kind === "resumed")
    return (
      <div className="ml-note" role="status" data-endpoint="ws live → {type:resumed, since, seq, replayed}">
        <span className="grow">
          Back live.{" "}
          <b>
            {liveNote.replayed} missed change{liveNote.replayed === 1 ? "" : "s"} replayed
          </b>
          .
        </span>
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setDismissed(liveNote)}>
          Dismiss
        </button>
      </div>
    )
  return (
    <div className="ml-note" role="status" data-endpoint="ws live → {type:reset, seq, counts}">
      <span className="grow">
        Too much changed while you were away to replay one by one, so the counts and this list were{" "}
        <b>refreshed in full</b>. Anything you had selected was cleared.
      </span>
      <button className="btn btn-ghost btn-sm" type="button" onClick={() => setDismissed(liveNote)}>
        Dismiss
      </button>
    </div>
  )
}

function PurgeNote({ folder, empty }: { folder: "spam" | "trash"; empty: boolean }) {
  const { mailboxId, access } = useMail()
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const word = folder === "spam" ? "Spam" : "Trash"
  const purge = async () => {
    setBusy(true)
    try {
      const r = await unwrap(
        api.POST("/v1/mailboxes/{id}/folders/{folder}/empty", {
          params: { path: { id: mailboxId, folder } },
        }),
      )
      toast({ title: `${word} emptied`, sub: `${num(r?.purged) ?? 0} conversations deleted for good` })
    } catch {
      toast({ title: `${word} wasn’t emptied`, sub: "Try again in a moment.", tone: "error" })
    } finally {
      setBusy(false)
      setConfirm(false)
    }
  }
  return (
    <div className="ml-note" role="note">
      <span className="grow">{word} is deleted for good after 30 days.</span>
      {empty ? null : confirm ? (
        <span className="cluster cluster-4">
          <button className="btn btn-danger btn-sm" type="button" onClick={purge} disabled={busy}>
            {busy ? "Emptying…" : `Delete all forever`}
          </button>
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => setConfirm(false)}>
            Cancel
          </button>
        </span>
      ) : (
        <Gated allowed={access.write} reason={access.writeReason} who={access.writeWho} side="right">
          <button
            className="btn btn-danger-ghost btn-sm"
            type="button"
            data-endpoint={`POST /v1/mailboxes/{id}/folders/${folder}/empty`}
            onClick={() => setConfirm(true)}
          >
            Empty {word.toLowerCase()} now
          </button>
        </Gated>
      )}
    </div>
  )
}

/** The search box: `/` focuses it; typing suggests operators and people; Enter searches. */
function SearchBox({
  q,
  searchRef,
  parsed,
}: {
  q: ListQuery
  searchRef: React.RefObject<HTMLInputElement | null>
  parsed: SearchBody["parsed"] | undefined
}) {
  const { mailboxId, local, live } = useMail()
  const navigate = useNavigate()
  const [value, setValue] = useState(q.q ?? "")
  const [focus, setFocus] = useState(false)
  const [sel, setSel] = useState(0)
  useEffect(() => setValue(q.q ?? ""), [q.q])
  const last = value.split(/\s+/).pop() ?? ""
  const person = /^(from|to):(.+)$/i.exec(last)
  const people = useQuery({
    ...correspondentsQuery(mailboxId, person?.[2] ?? ""),
    enabled: Boolean(person?.[2] && person[2].length >= 2 && focus),
  })
  const ops = operatorSuggestions(value)
  const suggestions: { key: string; node: ReactNode; apply: () => void }[] = [
    ...(people.data?.correspondents ?? []).slice(0, 4).map((c) => ({
      key: `p:${c.address}`,
      node: (
        <>
          <Who name={c.name} address={c.address} />
          <span className="grow">
            {c.name ?? c.address} {c.name ? <span className="mono t-small muted">{c.address}</span> : null}
          </span>
        </>
      ),
      apply: () => setValue(`${value.slice(0, value.length - last.length)}${person?.[1]}:${c.address} `),
    })),
    ...ops.map((o) => ({
      key: `o:${o.op}`,
      node: (
        <>
          <span className="mono" style={{ minWidth: 112 }}>
            {o.op}
          </span>
          <span className="grow">{o.hint}</span>
          <span className="t-small muted mono hide-phone">{o.example === o.op ? "" : o.example}</span>
        </>
      ),
      apply: () =>
        setValue(`${value.slice(0, value.length - last.length)}${o.op}${o.op.endsWith(":") ? "" : " "}`),
    })),
  ]
  const showMenu = focus && (suggestions.length > 0 || (!value && focus))
  const submit = (text: string) => {
    const t = text.trim()
    if (!t) {
      navigate({ to: "/mail/$mailboxId", params: { mailboxId }, search: {} as never })
      return
    }
    navigate({
      to: "/mail/$mailboxId/search",
      params: { mailboxId },
      search: { q: t, ...(q.sort ? { sort: q.sort } : {}) } as never,
    })
  }
  const offline = live === "offline"
  const input = (
    <input
      ref={searchRef}
      className="input"
      type="search"
      aria-label="Search this mailbox"
      placeholder={`Search ${local} · from: subject: has:attachment …`}
      value={value}
      disabled={offline}
      onChange={(e) => {
        setValue(e.target.value)
        setSel(0)
      }}
      onFocus={() => setFocus(true)}
      onBlur={() => setTimeout(() => setFocus(false), 150)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.currentTarget.blur()
          return
        }
        if (showMenu && suggestions.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
          e.preventDefault()
          setSel((s) => (s + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length)
          return
        }
        if (e.key === "Tab" && showMenu && suggestions[sel]) {
          e.preventDefault()
          suggestions[sel]?.apply()
          return
        }
        if (e.key === "Enter") {
          e.preventDefault()
          submit(value)
          e.currentTarget.blur()
        }
      }}
      aria-keyshortcuts="/"
    />
  )
  return (
    <div className="ml-search" data-endpoint="GET /v1/mailboxes/{id}/search?q=">
      <div className="input-group">
        <span className="addon">
          <Icon name="search" />
        </span>
        {offline ? (
          <Gated
            allowed={false}
            reason="Search needs a connection"
            who="It searches on the server; it comes back when you’re online."
            block
          >
            {input}
          </Gated>
        ) : (
          input
        )}
        <span className="kbd" aria-hidden="true">
          /
        </span>
      </div>
      {showMenu ? (
        <div
          className="menu"
          role="listbox"
          aria-label="Search suggestions"
          style={{ position: "absolute", left: 0, right: 0, top: "calc(100% + 4px)", zIndex: 66 }}
        >
          {people.data?.correspondents.length ? (
            <div className="menu-label">People matching “{person?.[2]}”</div>
          ) : null}
          {suggestions.length ? (
            suggestions.map((s, i) => (
              <button
                key={s.key}
                className="menu-item"
                type="button"
                role="option"
                aria-selected={i === sel}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  s.apply()
                  searchRef.current?.focus()
                }}
              >
                {s.node}
              </button>
            ))
          ) : (
            <>
              <div className="menu-label">Operators</div>
              {OPERATORS.map((o) => (
                <button
                  key={o.op}
                  className="menu-item"
                  type="button"
                  role="option"
                  aria-selected={false}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setValue(o.op + (o.op.endsWith(":") ? "" : " "))
                    searchRef.current?.focus()
                  }}
                >
                  <span className="mono" style={{ minWidth: 112 }}>
                    {o.op}
                  </span>
                  <span className="grow">{o.hint}</span>
                  <span className="t-small muted mono hide-phone">{o.example === o.op ? "" : o.example}</span>
                </button>
              ))}
            </>
          )}
          <div className="menu-note">
            Operators combine with AND. Quote phrases: <span className="mono">"payment link"</span>.
          </div>
        </div>
      ) : null}
      {q.q && parsed ? (
        <>
          {parsed.operators.length || parsed.terms.length ? (
            <div
              className="cluster cluster-4"
              style={{ marginTop: 8 }}
              data-label="Operators the server applied"
              data-endpoint="search → parsed.operators, parsed.terms"
            >
              {parsed.operators.map((o) => (
                <span key={`${o.op}:${o.value}`} className="op-chip">
                  <span className="op-k">{o.op}:</span>
                  {o.value}
                  <button
                    type="button"
                    aria-label={`Remove ${o.op}:`}
                    onClick={() => submit(removeOperator(q.q ?? "", o.op, o.value))}
                  >
                    <Icon name="x" />
                  </button>
                </span>
              ))}
              {parsed.terms.length ? (
                <span className="t-small muted" style={{ paddingLeft: 4 }}>
                  + words: {parsed.terms.join(" ")}
                </span>
              ) : null}
            </div>
          ) : null}
          {parsed.unsupported.length ? (
            <p
              className="field-error"
              role="status"
              style={{ marginTop: 6, color: "var(--amber-900)" }}
              data-endpoint="search → parsed.unsupported"
            >
              <span>
                Ignored:{" "}
                {parsed.unsupported.map((u, i) => (
                  <span key={`${u.op}:${u.value}`}>
                    {i ? ", " : ""}
                    <span className="mono">
                      {u.op}:{u.value}
                    </span>
                  </span>
                ))}{" "}
                {parsed.unsupported.length === 1 ? "isn’t an operator" : "aren’t operators"} search
                understands, so the results don’t use {parsed.unsupported.length === 1 ? "it" : "them"}.
              </span>
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

function SearchExtras({ q }: { q: ListQuery }) {
  const { mailboxId } = useMail()
  return (
    <div className="spread" style={{ paddingBottom: 10, gap: 8, flexWrap: "wrap" }}>
      <Link
        className="switch"
        to="/mail/search"
        search={{ q: q.q, ...(q.sort ? { sort: q.sort } : {}) } as never}
      >
        <span className="mail-switch" aria-hidden="true" />
        Search all mailboxes
      </Link>
      <span className="cluster cluster-4">
        <Link
          className="btn btn-ghost btn-sm"
          to="/mail/$mailboxId/search"
          params={{ mailboxId }}
          search={{ ...q, sheet: "smart-folders", save: q.q } as never}
          data-endpoint="POST /v1/mailboxes/{id}/smart-folders {name, q}"
        >
          Save as smart folder
        </Link>
      </span>
    </div>
  )
}

function SortSeg({ q }: { q: ListQuery }) {
  const { mailboxId } = useMail()
  const navigate = useNavigate()
  const sort = q.sort ?? "recent"
  return (
    // biome-ignore lint/a11y/useSemanticElements: the design's segmented control
    <div className="seg" role="group" aria-label="Sort results" data-endpoint="search?sort=recent|relevance">
      {(["recent", "relevance"] as const).map((s) => (
        <button
          key={s}
          type="button"
          aria-pressed={sort === s}
          onClick={() =>
            navigate({
              to: "/mail/$mailboxId/search",
              params: { mailboxId },
              search: { q: q.q, ...(s === "relevance" ? { sort: s } : {}) } as never,
            })
          }
        >
          {s === "recent" ? "Recent" : "Relevance"}
        </button>
      ))}
    </div>
  )
}

/** Unread, Has attachment, Label and Assignee: all in the URL. */
function Filters({ q }: { q: ListQuery }) {
  const mail = useMail()
  const navigate = useNavigate()
  const labelMenu = useMenu<HTMLSpanElement>()
  const assigneeMenu = useMenu<HTMLSpanElement>()
  const detail = useQuery({ ...mailboxDetailQuery(mail.mailboxId), enabled: assigneeMenu.open })
  const me = useMyAssignee()
  const go = (patch: { [K in keyof ListQuery]?: ListQuery[K] | undefined }) =>
    navigate({
      to: "/mail/$mailboxId",
      params: { mailboxId: mail.mailboxId },
      search: ((prev: ListQuery) => {
        const next = { ...prev, ...patch } as Record<string, unknown>
        for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === false) delete next[k]
        return next
      }) as never,
    })
  const label = q.labelId ? mail.labelById.get(q.labelId) : undefined
  const assignees = [
    ...(detail.data?.people ?? [])
      .filter((p) => p.access !== "viewer")
      .map((p) => ({ id: p.memberId, name: p.name })),
    ...(detail.data?.members ?? [])
      .filter((m) => !m.revoked && m.role !== "viewer")
      .map((m) => ({ id: m.apiKeyId, name: m.name })),
  ]
  return (
    // biome-ignore lint/a11y/useSemanticElements: the design's filter chips row, a group without a fieldset legend
    <div className="ml-filters" role="group" aria-label="Filters">
      <button
        className="fchip"
        type="button"
        aria-pressed={Boolean(q.unread)}
        onClick={() => go({ unread: !q.unread || undefined })}
      >
        Unread
      </button>
      <button
        className="fchip"
        type="button"
        aria-pressed={Boolean(q.att)}
        onClick={() => go({ att: !q.att || undefined })}
      >
        Has attachment
      </button>
      <span ref={labelMenu.ref} style={{ position: "relative", flex: "none" }}>
        <button
          className="fchip"
          type="button"
          aria-pressed={Boolean(q.labelId)}
          aria-haspopup="menu"
          aria-expanded={labelMenu.open}
          onClick={() => labelMenu.setOpen(!labelMenu.open)}
        >
          {label ? (
            <>
              <i className={`label-dot${label.color ? ` lc-${label.color}` : ""}`} aria-hidden="true" />
              {label.name}
            </>
          ) : (
            "Label"
          )}
          <Icon name="chevron-down" />
        </button>
      </span>
      <span ref={assigneeMenu.ref} style={{ position: "relative", flex: "none" }}>
        <button
          className="fchip"
          type="button"
          aria-pressed={Boolean(q.assignee)}
          aria-haspopup="menu"
          aria-expanded={assigneeMenu.open}
          onClick={() => assigneeMenu.setOpen(!assigneeMenu.open)}
        >
          {q.assignee
            ? q.assignee === me
              ? "Assigned to me"
              : (assignees.find((a) => a.id === q.assignee)?.name ?? "Assignee")
            : "Assignee"}
          <Icon name="chevron-down" />
        </button>
      </span>
      {labelMenu.open ? (
        <div
          className="menu mail-menu"
          role="menu"
          aria-label="Filter by label"
          style={{ left: 12, top: "calc(100% - 6px)" }}
        >
          {mail.labels.map((l) => (
            <button
              key={l.id}
              className="menu-item"
              type="button"
              role="menuitemradio"
              aria-checked={q.labelId === l.id}
              onClick={() => {
                labelMenu.setOpen(false)
                go({ labelId: l.id, folder: undefined })
              }}
            >
              <i className={`label-dot${l.color ? ` lc-${l.color}` : ""}`} aria-hidden="true" />
              <span className="grow">{l.name}</span>
              {q.labelId === l.id ? <Icon name="check" /> : null}
            </button>
          ))}
          {!mail.labels.length ? <div className="menu-note">No labels yet.</div> : null}
          {q.labelId ? (
            <>
              <div className="menu-sep" />
              <button
                className="menu-item"
                type="button"
                role="menuitem"
                onClick={() => go({ labelId: undefined })}
              >
                <span className="grow">Any label</span>
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {assigneeMenu.open ? (
        <div
          className="menu mail-menu"
          role="menu"
          aria-label="Filter by assignee"
          style={{ left: 12, top: "calc(100% - 6px)" }}
          data-endpoint="GET /v1/mailboxes/{id} → members, people"
        >
          {me ? (
            <button
              className="menu-item"
              type="button"
              role="menuitemradio"
              aria-checked={q.assignee === me}
              onClick={() => go({ assignee: me })}
            >
              <span className="grow">Assigned to me</span>
            </button>
          ) : null}
          {detail.isPending ? <div className="menu-note">Loading members…</div> : null}
          {assignees
            .filter((a) => a.id !== me)
            .map((a) => (
              <button
                key={a.id}
                className="menu-item"
                type="button"
                role="menuitemradio"
                aria-checked={q.assignee === a.id}
                onClick={() => {
                  assigneeMenu.setOpen(false)
                  go({ assignee: a.id })
                }}
              >
                <Who name={a.name} />
                <span className="grow">{a.name}</span>
              </button>
            ))}
          {q.assignee ? (
            <>
              <div className="menu-sep" />
              <button
                className="menu-item"
                type="button"
                role="menuitem"
                onClick={() => go({ assignee: undefined })}
              >
                <span className="grow">Anyone</span>
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function useIsPhone() {
  const [phone, setPhone] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches,
  )
  useEffect(() => {
    const m = window.matchMedia("(max-width: 767px)")
    const on = () => setPhone(m.matches)
    m.addEventListener("change", on)
    return () => m.removeEventListener("change", on)
  }, [])
  return phone
}

function Rows({
  q,
  rows,
  marks,
  openId,
  cursorId,
  setCursorId,
  query,
  isSearch,
  hasMore,
  loadMore,
  loadingMore,
  nextCursor,
  onOpen,
  searchData,
}: {
  q: ListQuery
  rows: Thread[]
  marks: Map<string, { subject: string; excerpt: string }>
  openId: string | undefined
  cursorId: string | null
  setCursorId: (id: string | null) => void
  query: { isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown }
  isSearch: boolean
  hasMore: boolean
  loadMore: () => void
  loadingMore: boolean
  nextCursor: string | null
  onOpen: (id: string) => void
  searchData: SearchBody | undefined
}) {
  const mail = useMail()
  const scroller = useRef<HTMLDivElement>(null)
  const phone = useIsPhone()
  const h = phone ? ROW_PHONE : ROW
  const [range, setRange] = useState({ start: 0, end: PAGE })
  const selected = useSelection()

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const update = () => {
      const start = Math.max(0, Math.floor(el.scrollTop / h) - OVERSCAN)
      const end = Math.min(rows.length, Math.ceil((el.scrollTop + el.clientHeight) / h) + OVERSCAN)
      setRange((r) => (r.start === start && r.end === end ? r : { start, end }))
      if (hasMore && !loadingMore && el.scrollTop + el.clientHeight > el.scrollHeight - h * 6) loadMore()
    }
    update()
    el.addEventListener("scroll", update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      el.removeEventListener("scroll", update)
      ro.disconnect()
    }
  }, [h, rows.length, hasMore, loadingMore, loadMore])

  // Keep the keyboard cursor (and the open row) in view.
  useEffect(() => {
    const el = scroller.current
    const id = cursorId ?? openId
    if (!el || !id) return
    const i = rows.findIndex((r) => r.id === id)
    if (i < 0) return
    const top = i * h
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + h > el.scrollTop + el.clientHeight) el.scrollTop = top + h - el.clientHeight
  }, [cursorId, openId, rows, h])

  // Sent rows show the latest reply's delivery: fetched for the visible rows only.
  const visible = rows.slice(range.start, range.end)
  const sentDetails = useQueries({
    queries: (q.folder === "sent" ? visible : []).map((t) => ({
      ...messageQuery(mail.mailboxId, t.latestMessageId),
      staleTime: 5 * 60_000,
    })),
  })
  const delivery = new Map<string, string>()
  if (q.folder === "sent")
    visible.forEach((t, i) => {
      const s = sentDetails[i]?.data?.delivery?.status
      if (s) delivery.set(t.id, s)
    })

  if (query.isPending)
    return (
      <div className="pane-scroll" aria-busy="true">
        <ul className="ml-rows" aria-label="Conversations">
          {Array.from({ length: 8 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton rows
            <li key={i} className="tr is-sk" aria-hidden="true">
              <div className="tr-gutter">
                <span className="sk" style={{ width: 16, height: 16, margin: 6 }} />
              </div>
              <div className="tr-body">
                <div className="tr-l1">
                  <span className="sk sk-text" style={{ width: "44%" }} />
                  <span className="sk sk-text" style={{ width: 36, marginLeft: "auto" }} />
                </div>
                <span className="sk sk-text" style={{ width: "70%", height: 12, marginTop: 3 }} />
                <span className="sk sk-text" style={{ width: "90%", height: 10, marginTop: 6 }} />
              </div>
            </li>
          ))}
        </ul>
      </div>
    )

  if (query.isError)
    return (
      <div className="pane-scroll">
        <ul className="ml-rows" aria-label="Conversations">
          <li style={{ padding: 16 }}>
            <ListError error={query.error} onRetry={() => query.refetch()} q={q} />
          </li>
        </ul>
      </div>
    )

  if (!rows.length)
    return (
      <div className="pane-scroll">
        <ul className="ml-rows" aria-label="Conversations">
          <EmptyList q={q} isSearch={isSearch} searchData={searchData} />
        </ul>
      </div>
    )

  return (
    <div className="pane-scroll" ref={scroller} data-virtual={`row-height:${h}px; overscan:${OVERSCAN}`}>
      <ul
        className="ml-rows"
        aria-label="Conversations"
        style={{ paddingTop: range.start * h, paddingBottom: Math.max(0, rows.length - range.end) * h }}
      >
        {visible.map((t) => (
          <Row
            key={t.id}
            t={t}
            q={q}
            mark={marks.get(t.id)}
            open={t.id === openId}
            cursor={t.id === cursorId}
            checked={selected.has(t.id)}
            delivery={delivery.get(t.id)}
            order={rows}
            onOpen={onOpen}
            onFocus={() => setCursorId(t.id)}
          />
        ))}
      </ul>
      {hasMore || loadingMore ? (
        <div className="ml-more" role="status">
          {loadingMore ? (
            <>
              <span className="spinner" aria-hidden="true" />
              Loading older conversations…
            </>
          ) : (
            <>
              Older conversations load as you scroll
              {nextCursor ? (
                <>
                  {" "}
                  · <span className="mono">cursor={nextCursor.slice(0, 10)}…</span>
                </>
              ) : null}
            </>
          )}
        </div>
      ) : rows.length > 12 ? (
        <div className="ml-more" role="status">
          That’s everything{q.att ? " with an attachment on the loaded pages" : ""}.
        </div>
      ) : null}
    </div>
  )
}

function ListError({ error, onRetry, q }: { error: unknown; onRetry: () => void; q: ListQuery }) {
  const { mailboxId, local } = useMail()
  const e = error as { status?: number; requestId?: string; message?: string }
  const title = q.q ? "Search didn’t run" : `The ${q.folder ? FOLDER_TITLE[q.folder] : "Inbox"} didn’t load`
  const endpoint = q.q
    ? `GET /v1/mailboxes/${mailboxId}/search?q=${encodeURIComponent(q.q)}`
    : `GET /v1/mailboxes/${mailboxId}/threads${listSearchString(q) || "?folder=inbox"}`
  if (!e?.status) return <PanelError error={error} onRetry={onRetry} what={title} />
  return (
    <div className="error-block" role="alert">
      <h3>
        <Icon name="warn" />
        {title}
      </h3>
      <p>
        {e.status >= 500
          ? `${local}’s mailbox didn’t answer. Your mail is safe; this is the list failing to load, not the mail.`
          : (e.message ?? "The request was refused.")}
      </p>
      <p className="mono" style={{ color: "var(--my-muted)", overflowWrap: "anywhere" }}>
        {endpoint} → {e.status}
      </p>
      <div className="cluster">
        <button className="btn btn-secondary btn-sm" type="button" onClick={onRetry}>
          <Icon name="refresh" />
          Retry
        </button>
        {e.requestId ? <RequestId id={e.requestId} /> : null}
      </div>
    </div>
  )
}

function EmptyList({
  q,
  isSearch,
  searchData,
}: {
  q: ListQuery
  isSearch: boolean
  searchData: SearchBody | undefined
}) {
  const { mailboxId, address, local, access } = useMail()
  const navigate = useNavigate()
  if (isSearch) {
    const ops = searchData?.parsed.operators ?? []
    const dropOne = ops.find((o) => o.op === "after" || o.op === "before") ?? ops[0]
    return (
      <li className="empty" style={{ padding: "40px 20px" }}>
        <span className="empty-icon">
          <Icon name="search" />
        </span>
        <h3>Nothing matches</h3>
        <p>
          No thread in {local} matches <span className="mono">{q.q}</span>.
        </p>
        {dropOne ? (
          <button
            className="btn btn-secondary btn-sm"
            type="button"
            onClick={() =>
              navigate({
                to: "/mail/$mailboxId/search",
                params: { mailboxId },
                search: { q: removeOperator(q.q ?? "", dropOne.op, dropOne.value) } as never,
              })
            }
          >
            Search without <span className="mono">{dropOne.op}:</span>
          </button>
        ) : null}
        <Link className="btn btn-ghost btn-sm" to="/mail/search" search={{ q: q.q } as never}>
          or search all mailboxes
        </Link>
      </li>
    )
  }
  const kind = q.labelId ? "label" : q.starred ? "starred" : q.assignee ? "assigned" : (q.folder ?? "inbox")
  const copy: Record<
    string,
    { icon: Parameters<typeof MIcon>[0]["name"]; title: string; body: ReactNode; action?: ReactNode }
  > = {
    inbox:
      q.unread || q.att
        ? {
            icon: "check-circle",
            title: "Nothing matches these filters",
            body: "Clear a filter to see the rest of the Inbox.",
          }
        : {
            icon: "inbox",
            title: `No mail in ${local} yet`,
            body: (
              <>
                Mail sent to <span className="mono">{address}</span> lands here the moment it arrives. Moving
                from another provider? Bring the old mail across.
              </>
            ),
            action: access.manage ? (
              <Link className="btn btn-primary btn-sm" to="/mail/$mailboxId/imports" params={{ mailboxId }}>
                Import over IMAP
              </Link>
            ) : undefined,
          },
    snoozed: {
      icon: "clock",
      title: "Nothing snoozed",
      body: "Snooze a conversation and it leaves the Inbox until the time you pick, then comes back unread.",
      action: (
        <Link
          className="btn btn-secondary btn-sm"
          to="/mail/$mailboxId"
          params={{ mailboxId }}
          title="Snooze · S"
        >
          Snooze from the Inbox · S
        </Link>
      ),
    },
    spam: {
      icon: "shield",
      title: "No spam",
      body: "Mail that fails authentication, trips the classifier, a rule or the block list lands here for 30 days.",
      action: access.manage ? (
        <Link className="btn btn-secondary btn-sm" to="/mail/$mailboxId/senders" params={{ mailboxId }}>
          Review blocked senders
        </Link>
      ) : undefined,
    },
    trash: {
      icon: "trash",
      title: "Trash is empty",
      body: "Deleted conversations wait here for 30 days, then go for good.",
    },
    sent: {
      icon: "send",
      title: "Nothing sent yet",
      body: `Replies and new mail sent from ${local} appear here with their delivery.`,
    },
    archive: {
      icon: "archive",
      title: "Nothing archived",
      body: "Archive (E) takes a conversation out of the Inbox without deleting it.",
    },
    all: {
      icon: "mail",
      title: `No mail in ${local} yet`,
      body: "Every conversation except Spam and Trash shows here.",
    },
    starred: { icon: "star", title: "Nothing starred", body: "Star a conversation (⇧ S) to keep it here." },
    assigned: {
      icon: "user-check",
      title: "Nothing assigned to you",
      body: "Conversations assigned to you (A) show here.",
    },
    label: {
      icon: "tag",
      title: "No conversations with this label",
      body: "Label a conversation (L) to file it here.",
    },
  }
  const c = copy[kind] ?? copy.inbox
  if (!c) return null
  return (
    <li className="empty" style={{ padding: "48px 20px" }}>
      <span className="empty-icon">
        <MIcon name={c.icon} />
      </span>
      <h3>{c.title}</h3>
      <p>{c.body}</p>
      {c.action}
    </li>
  )
}

function Row({
  t,
  q,
  mark,
  open,
  cursor,
  checked,
  delivery,
  order,
  onOpen,
  onFocus,
}: {
  t: Thread
  q: ListQuery
  mark: { subject: string; excerpt: string } | undefined
  open: boolean
  cursor: boolean
  checked: boolean
  delivery: string | undefined
  order: Thread[]
  onOpen: (id: string) => void
  onFocus: () => void
}) {
  const mail = useMail()
  const unread = (num(t.unreadCount) ?? 0) > 0
  const names = namesLine(t.participants, mail.ours)
  const other = counterpart(t.participants, mail.ours)
  const n = num(t.messageCount) ?? 1
  const subject = mark ? stripMarks(mark.subject) : t.subject
  const fresh = isFresh(t.id)
  const label = `${names.map((x) => x.name).join(", ")}${unread ? ", unread" : ""}: ${subject || "(no subject)"}`
  const snoozed = num(t.snoozedUntil)
  const scheduled = num(t.scheduledSendAt)
  const spamScore = num(t.spamScore)
  const folderTag = q.folder === "all" || q.q ? t.folders.find((f) => f !== "inbox") : undefined
  return (
    <li
      className={`tr${unread ? " is-unread" : ""}${checked ? " is-checked" : ""}${cursor ? " is-cursor" : ""}${fresh ? " is-new" : ""}`}
      {...(open ? { "aria-current": "true" as const } : {})}
      data-thread={t.id}
    >
      <div className="tr-gutter">
        <label className="tr-check" title="Select · X">
          <input
            type="checkbox"
            aria-label={`Select “${subject || "(no subject)"}”`}
            checked={checked}
            onChange={() => toggleSelected(t.id)}
            onClick={(e) => {
              if (e.shiftKey) {
                e.preventDefault()
                const ids = order.map((r) => r.id)
                const a = getAnchor()
                const lo = a ? ids.indexOf(a) : -1
                const hi = ids.indexOf(t.id)
                if (lo >= 0 && hi >= 0) {
                  const [s, en] = lo < hi ? [lo, hi] : [hi, lo]
                  setSelection([...new Set([...selectedNow(), ...ids.slice(s, en + 1)])], t.id)
                }
              }
            }}
          />
        </label>
        <StarButton t={t} />
        <Who name={other?.name} address={other?.address} className="tr-avatar" />
      </div>
      <Link
        className="tr-body tr-link"
        to="/mail/$mailboxId/threads/$threadId"
        params={{ mailboxId: mail.mailboxId, threadId: t.id }}
        search={q as never}
        aria-label={label}
        onFocus={onFocus}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey) return
          e.preventDefault()
          onOpen(t.id)
        }}
      >
        <span className="tr-l1">
          <span className="tr-dot" aria-hidden="true" />
          <span className="tr-names">
            {names.map((x, i) => (
              <span key={x.us ? "us" : `${x.name}:${i > 0}`}>
                {i ? ", " : ""}
                {x.us ? <span className="me-tag">us</span> : x.name}
              </span>
            ))}
          </span>
          {n > 1 ? <span className="tr-n">{n}</span> : null}
          <span className="tr-meta">
            {t.hasAttachments ? <Icon name="paperclip" label="Has attachments" /> : null}
            <time dateTime={new Date(num(t.lastAt) ?? 0).toISOString()}>{rowTime(t.lastAt)}</time>
          </span>
        </span>
        <span className="tr-l2">{mark ? <Hl text={mark.subject} /> : subject || "(no subject)"}</span>
        <span className="tr-l3">
          <span className="tr-snip">{mark ? <Hl text={mark.excerpt} /> : t.snippet}</span>
          <span className="tr-tags">
            {fresh ? (
              <span className="pill pill-info" style={{ height: 20 }}>
                New
              </span>
            ) : null}
            {delivery ? <DeliveryPill status={delivery} small /> : null}
            {spamScore !== null && q.folder === "spam" ? (
              <span className="ltag" title="Spam score: higher is more likely spam">
                Score {spamScore.toFixed(1)}
              </span>
            ) : null}
            {snoozed && (q.folder === "snoozed" || t.folders.includes("snoozed")) ? (
              <span className="ltag">Until {utcShort(snoozed)}</span>
            ) : null}
            {scheduled ? <span className="ltag">Reply sends {utcShort(scheduled)}</span> : null}
            {folderTag ? <span className="ltag">{FOLDER_TITLE[folderTag]}</span> : null}
            {t.labelIds
              .filter((id) => id !== q.labelId)
              .slice(0, 2)
              .map((id) => {
                const l = mail.labelById.get(id)
                return l ? <LabelTag key={id} label={l} /> : null
              })}
            {t.assignedTo ? (
              <Who name={t.assignedTo.name} label={`Assigned to ${t.assignedTo.name}`} />
            ) : null}
          </span>
        </span>
      </Link>
    </li>
  )
}

function StarButton({ t }: { t: Thread }) {
  const mail = useMail()
  const bulk = useBulk(mail.mailboxId)
  const btn = (
    <button
      className="tr-star"
      type="button"
      aria-pressed={t.starred}
      aria-label={t.starred ? "Starred" : "Star"}
      title="Star · ⇧ S"
      onClick={() => void bulk(t.starred ? "unstar" : "star", [t.id], {}, { quiet: true })}
    >
      <MIcon name="star" />
    </button>
  )
  return mail.access.write ? (
    btn
  ) : (
    <Gated allowed={false} reason={mail.access.writeReason} who={mail.access.writeWho}>
      {btn}
    </Gated>
  )
}
