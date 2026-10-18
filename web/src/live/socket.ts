/**
 * The mailbox live socket: `GET /v1/mailboxes/{id}/live` (MailboxDO, HAL-3397).
 *
 * Protocol, from src/objects/MailboxDO.ts:
 * - On connect the server sends `hello { seq, counts, labels }`. With `?since=<seq>` it then replays every
 *   event after that seq and ends with `resumed`, or sends `reset { seq, counts }` when it no longer keeps them.
 * - Each event frame carries its `seq`. Events: message.added, threads.changed, labels.changed, drafts.changed,
 *   draft.due, delivery.changed.
 * - "ping" is answered "pong" by the runtime without waking the object; we ping every 25 s.
 *
 * Reconnect: exponential backoff from 1 s to 30 s with full jitter, reset after a connection holds for 10 s.
 * Every reconnect resumes from the last seq seen, so nothing is missed while away. The browser sends the
 * session cookie with the upgrade, because the socket is same-origin.
 */
export type FolderCount = { folder: string; threads: number; unreadThreads: number }
export type LiveFrame = { type: string; seq?: number; counts?: FolderCount[]; [k: string]: unknown }
export type LiveStatus = "connecting" | "open" | "reconnecting" | "offline" | "closed"

type Listener = (f: LiveFrame) => void
type StatusListener = (s: LiveStatus) => void

export class MailboxSocket {
  private ws: WebSocket | null = null
  private seq: number | null = null
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private ping: ReturnType<typeof setInterval> | null = null
  private stable: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private readonly listeners = new Set<Listener>()
  private readonly statusListeners = new Set<StatusListener>()
  status: LiveStatus = "connecting"

  constructor(
    readonly mailboxId: string,
    private readonly origin = window.location.origin,
  ) {
    window.addEventListener("online", this.onOnline)
    window.addEventListener("offline", this.onOffline)
    this.connect()
  }

  onFrame(fn: Listener) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  onStatus(fn: StatusListener) {
    this.statusListeners.add(fn)
    fn(this.status)
    return () => this.statusListeners.delete(fn)
  }

  /** Ask for fresh folder counts, answered with a `counts` frame. */
  requestCounts() {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "counts" }))
  }

  close() {
    this.closed = true
    window.removeEventListener("online", this.onOnline)
    window.removeEventListener("offline", this.onOffline)
    this.clearTimers()
    this.ws?.close(1000, "closed by the app")
    this.setStatus("closed")
  }

  private url() {
    const u = new URL(`/v1/mailboxes/${encodeURIComponent(this.mailboxId)}/live`, this.origin)
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:"
    if (this.seq !== null) u.searchParams.set("since", String(this.seq))
    return u.toString()
  }

  private connect() {
    if (this.closed) return
    if (typeof navigator !== "undefined" && navigator.onLine === false) return this.setStatus("offline")
    this.setStatus(this.attempt ? "reconnecting" : "connecting")
    const ws = new WebSocket(this.url())
    this.ws = ws
    ws.onopen = () => {
      this.setStatus("open")
      this.ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 25_000)
      this.stable = setTimeout(() => {
        this.attempt = 0
      }, 10_000)
    }
    ws.onmessage = (ev) => {
      if (ev.data === "pong" || typeof ev.data !== "string") return
      let frame: LiveFrame
      try {
        frame = JSON.parse(ev.data) as LiveFrame
      } catch {
        return
      }
      if (typeof frame.seq === "number") this.seq = Math.max(this.seq ?? 0, frame.seq)
      for (const fn of this.listeners) fn(frame)
    }
    ws.onclose = (ev) => {
      this.clearTimers()
      this.ws = null
      if (this.closed) return
      // 1008 is a policy refusal (auth): retrying with the same cookie won't help, so stop until the app
      // signs in again and opens a new socket.
      if (ev.code === 1008) return this.setStatus("closed")
      this.schedule()
    }
    ws.onerror = () => ws.close()
  }

  private schedule() {
    const cap = Math.min(30_000, 1000 * 2 ** this.attempt)
    this.attempt++
    this.setStatus("reconnecting")
    this.timer = setTimeout(() => this.connect(), Math.random() * cap)
  }

  private clearTimers() {
    if (this.timer) clearTimeout(this.timer)
    if (this.ping) clearInterval(this.ping)
    if (this.stable) clearTimeout(this.stable)
    this.timer = this.ping = this.stable = null
  }

  private setStatus(s: LiveStatus) {
    this.status = s
    for (const fn of this.statusListeners) fn(s)
  }

  private onOnline = () => {
    if (!this.ws && !this.closed) {
      this.attempt = 0
      this.connect()
    }
  }
  private onOffline = () => {
    this.setStatus("offline")
    this.ws?.close()
  }
}

/** Backoff cap for attempt n, exported for tests: 1 s, 2 s, 4 s … up to 30 s. */
export const backoffCap = (n: number) => Math.min(30_000, 1000 * 2 ** n)
