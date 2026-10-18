/**
 * One socket per mailbox for the life of the app, shared by every component that asks. Frames with counts
 * update the folder counts in the query cache, so the sidebar's unread badges move without polling.
 */
import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { fixturesEnabled } from "../fixtures/mode.ts"
import { type FolderCount, type LiveFrame, type LiveStatus, MailboxSocket } from "./socket.ts"

const sockets = new Map<string, { socket: MailboxSocket; users: number }>()

export const foldersKey = (mailboxId: string) => ["mailboxes", mailboxId, "folders"] as const

export function useMailboxLive(mailboxId: string | undefined, onFrame?: (f: LiveFrame) => void): LiveStatus {
  const qc = useQueryClient()
  const [status, setStatus] = useState<LiveStatus>("connecting")
  useEffect(() => {
    if (!mailboxId || fixturesEnabled()) {
      setStatus("closed")
      return
    }
    let entry = sockets.get(mailboxId)
    if (!entry) {
      entry = { socket: new MailboxSocket(mailboxId), users: 0 }
      sockets.set(mailboxId, entry)
    }
    entry.users++
    const { socket } = entry
    const offStatus = socket.onStatus(setStatus)
    const offFrame = socket.onFrame((f) => {
      if (Array.isArray(f.counts)) {
        qc.setQueryData(foldersKey(mailboxId), (old: { folders: FolderCount[] } | undefined) =>
          old
            ? { ...old, folders: f.counts as FolderCount[] }
            : { folders: f.counts as FolderCount[], labels: [] },
        )
      }
      if (f.type === "reset") qc.invalidateQueries({ queryKey: ["mailboxes", mailboxId] })
      onFrame?.(f)
    })
    return () => {
      offStatus()
      offFrame()
      const e = sockets.get(mailboxId)
      if (e && --e.users === 0) {
        e.socket.close()
        sockets.delete(mailboxId)
      }
    }
  }, [mailboxId, qc, onFrame])
  return status
}
