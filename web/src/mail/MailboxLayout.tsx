/**
 * The mail frame (HANDOFF-mail §1, §3): `.mail` with the folder pane and whatever the child route shows
 * (the list and the reader, or one wide mailbox page). Each pane scrolls on its own and `.main` is locked to
 * the viewport. Under 1280 px the folders are a drawer; under 768 px one pane shows at a time, chosen by
 * the route (`staticData.mailPane`), with real back navigation.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Outlet, useMatches, useNavigate, useParams, useSearch } from "@tanstack/react-router"
import { useCallback, useEffect, useState } from "react"
import type { LiveStatus } from "../live/socket.ts"
import { usePageTitle } from "../shell/title.tsx"
import type { LiveNote } from "./context.tsx"
import { MailProvider } from "./context.tsx"
import { FolderPane } from "./FolderPane.tsx"
import { KeyboardSheet } from "./KeyboardSheet.tsx"
import { applyFrame, useMailLive } from "./live.ts"
import { rememberMailbox } from "./MailHome.tsx"
import { LabelsSheet, RuleFromMessageSheet, SmartFoldersSheet } from "./pages/sheets.tsx"
import { mailboxesQuery } from "./queries.ts"
import { useSelection } from "./selection.ts"

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** Which pane a phone shows on this route. */
    mailPane?: "folders" | "list" | "thread"
    /** A mailbox page (rules, senders, import, export): the folders plus one wide pane. */
    mailPage?: boolean
  }
}

/** The design's `.content.mail-content`: the shell's <main> takes the class while a mailbox is open. */
function useMailContent() {
  useEffect(() => {
    const main = document.getElementById("main")
    main?.classList.add("mail-content")
    return () => main?.classList.remove("mail-content")
  }, [])
}

export function MailboxLayout() {
  const { mailboxId } = useParams({ from: "/_app/mail/$mailboxId" })
  const search = useSearch({ from: "/_app/mail/$mailboxId" })
  const navigate = useNavigate()
  const matches = useMatches()
  const leaf = [...matches].reverse().find((m) => m.staticData?.mailPane)
  const pane = leaf?.staticData?.mailPane ?? "list"
  const isPage = Boolean(leaf?.staticData?.mailPage)
  const [drawer, setDrawer] = useState(false)
  const openFolders = useCallback(() => setDrawer(true), [])
  const closeFolders = useCallback(() => setDrawer(false), [])
  const live = useMailLive(mailboxId)
  const { status, note } = useLiveSimulation(mailboxId, search.live, live.status, live.note)
  const selecting = useSelection().size > 0
  const boxes = useQuery(mailboxesQuery)
  const address = boxes.data?.mailboxes.find((m) => m.id === mailboxId)?.address
  useMailContent()
  usePageTitle(address ? `Mail · ${address.split("@")[0]}@` : "Mail")

  useEffect(() => rememberMailbox(mailboxId), [mailboxId])
  // A route change closes the tablet drawer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the leaf's id is the trigger
  useEffect(() => setDrawer(false), [leaf?.id])
  useEffect(() => {
    if (!drawer) return
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(false)
    window.addEventListener("keydown", esc)
    return () => window.removeEventListener("keydown", esc)
  }, [drawer])

  const closeSheet = () =>
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => {
        const { sheet: _s, message: _m, save: _v, ...rest } = prev
        return rest as never
      },
      replace: true,
    })

  const offline = status === "offline"
  return (
    <MailProvider
      mailboxId={mailboxId}
      live={status}
      liveNote={note}
      openFolders={openFolders}
      closeFolders={closeFolders}
    >
      <div
        className={`mail${isPage ? " is-page" : ""}${selecting ? " is-selecting" : ""}${offline ? " is-stale" : ""}`}
        data-pane={pane}
        {...(drawer ? { "data-folders": "open" } : {})}
      >
        <FolderPane />
        <Outlet />
        <button className="mail-scrim" type="button" onClick={closeFolders} aria-label="Close folders" />
      </div>
      {search.sheet === "labels" ? <LabelsSheet onClose={closeSheet} /> : null}
      {search.sheet === "smart-folders" ? (
        <SmartFoldersSheet {...(search.save ? { save: search.save } : {})} onClose={closeSheet} />
      ) : null}
      {search.sheet === "rule" && search.message ? (
        <RuleFromMessageSheet messageId={search.message} onClose={closeSheet} />
      ) : null}
      {search.sheet === "keys" ? <KeyboardSheet onClose={closeSheet} /> : null}
    </MailProvider>
  )
}

/**
 * Fixture mode can't open a socket, so `?live=` shows the socket's designed states for the audit and the
 * visual check: reconnecting, offline, a resume that replayed changes, a reset, and new mail arriving.
 * Outside fixture mode the route drops the param and this passes the real socket through.
 */
function useLiveSimulation(
  mailboxId: string,
  sim: "reconnecting" | "offline" | "resumed" | "reset" | "new" | undefined,
  status: LiveStatus,
  note: LiveNote,
): { status: LiveStatus; note: LiveNote } {
  const qc = useQueryClient()
  useEffect(() => {
    if (sim !== "new") return
    const timer = setTimeout(() => {
      const now = Date.now()
      applyFrame(qc, mailboxId, {
        type: "message.added",
        seq: 1,
        message: {
          id: "msg_new_1",
          threadId: "thr_new",
          subject: "Can I pay in two parts?",
          from: { name: "Tobi Lawal", address: "tobi.lawal@gmail.com" },
          snippet:
            "Hi, is it possible to split the Data foundations fee into two payments, one now and one in November?",
          receivedAt: now,
          folder: "inbox",
          seen: false,
        },
        thread: {
          id: "thr_new",
          subject: "Can I pay in two parts?",
          snippet:
            "Hi, is it possible to split the Data foundations fee into two payments, one now and one in November?",
          latestMessageId: "msg_new_1",
          messageCount: 1,
          unreadCount: 1,
          starred: false,
          hasAttachments: false,
          participants: [{ name: "Tobi Lawal", address: "tobi.lawal@gmail.com" }],
          folders: ["inbox"],
          labelIds: ["lbl_billing"],
          firstAt: now,
          lastAt: now,
          sortAt: now,
          snoozedUntil: null,
          assignee: null,
          assignedTo: null,
          scheduledSendAt: null,
        },
        removedThreadIds: [],
        counts: [],
      })
    }, 900)
    return () => clearTimeout(timer)
  }, [sim, qc, mailboxId])
  if (sim === "reconnecting" || sim === "offline") return { status: sim, note }
  if (sim === "resumed") return { status: "open", note: { kind: "resumed", replayed: 12 } }
  if (sim === "reset") return { status: "open", note: { kind: "reset" } }
  return { status, note }
}
