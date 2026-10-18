/**
 * The open mailbox, shared by every pane and page under /mail/$mailboxId: the mailbox itself, its folder
 * counts and labels, the addresses that are "us", the agent that owns it (if any), what the caller may do,
 * and the live socket's state.
 */
import { useQuery } from "@tanstack/react-query"
import { createContext, type ReactNode, useContext, useMemo } from "react"
import { useMe } from "../auth/session.ts"
import type { LiveStatus } from "../live/socket.ts"
import { agentFor, type MailAccess, mailAccess } from "./logic.ts"
import { agentsQuery, foldersQuery, identitiesQuery, mailboxDetailQuery, mailboxesQuery } from "./queries.ts"
import type { Agent, FoldersBody, Label, Mailbox } from "./types.ts"

export type LiveNote = { kind: "resumed"; replayed: number } | { kind: "reset" } | null

export type MailCtx = {
  mailboxId: string
  mailbox: Mailbox | undefined
  /** The mailbox's address, or its id until the list loads. */
  address: string
  /** `support@`, for placeholders and short labels. */
  local: string
  /** Every address this mailbox sends as (its own and its aliases'), lower-cased. */
  ours: ReadonlySet<string>
  folders: FoldersBody | undefined
  labels: Label[]
  labelById: ReadonlyMap<string, Label>
  agent: Agent | undefined
  access: MailAccess
  live: LiveStatus
  liveNote: LiveNote
  /** The tablet folder drawer. */
  openFolders: () => void
  closeFolders: () => void
}

const Ctx = createContext<MailCtx | null>(null)

export function useMail(): MailCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error("useMail outside a mailbox")
  return c
}

/** The same, or null outside a mailbox (the composer, which also opens from /mail). */
export const useMailOptional = () => useContext(Ctx)

export function MailProvider({
  mailboxId,
  live,
  liveNote,
  openFolders,
  closeFolders,
  children,
}: {
  mailboxId: string
  live: LiveStatus
  liveNote: LiveNote
  openFolders: () => void
  closeFolders: () => void
  children: ReactNode
}) {
  const me = useMe()
  const boxes = useQuery(mailboxesQuery)
  const folders = useQuery(foldersQuery(mailboxId))
  const identities = useQuery(identitiesQuery)
  const agents = useQuery(agentsQuery)
  // A mailbox you were linked to but that isn't in your list (yet): its detail names it.
  const listed = boxes.data?.mailboxes.some((m) => m.id === mailboxId)
  const detail = useQuery({ ...mailboxDetailQuery(mailboxId), enabled: boxes.isSuccess && !listed })
  const value = useMemo<MailCtx>(() => {
    const mailbox = boxes.data?.mailboxes.find((m) => m.id === mailboxId) ?? detail.data
    const address = mailbox?.address ?? mailboxId
    const ours = new Set<string>([address.toLowerCase()])
    for (const i of identities.data?.identities ?? [])
      if (i.mailboxId === mailboxId) ours.add(i.address.toLowerCase())
    for (const m of boxes.data?.mailboxes ?? [])
      if (m.targetIds.includes(mailboxId) && m.kind === "alias") ours.add(m.address.toLowerCase())
    const labels = folders.data?.labels ?? []
    return {
      mailboxId,
      mailbox,
      address,
      local: `${address.split("@")[0]}@`,
      ours,
      folders: folders.data,
      labels,
      labelById: new Map(labels.map((l) => [l.id, l])),
      agent: agentFor(mailboxId, agents.data?.agents),
      access: mailAccess(me.data, mailboxId),
      live,
      liveNote,
      openFolders,
      closeFolders,
    }
  }, [
    boxes.data,
    detail.data,
    folders.data,
    identities.data,
    agents.data,
    me.data,
    mailboxId,
    live,
    liveNote,
    openFolders,
    closeFolders,
  ])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
