import { DurableObject } from "cloudflare:workers"
import type { Env } from "../Bindings.ts"
import { MailboxStore } from "../mailbox/store.ts"
import type {
  DraftInput,
  FilingOptions,
  Folder,
  InboundDelivery,
  MailboxEvent,
  MessagePatch,
  ThreadFilter,
} from "../mailbox/types.ts"
import type { Rule } from "../rules/engine.ts"

export type { InboundDelivery } from "../mailbox/types.ts"
export { BODY_TEXT_LIMIT } from "../mailbox/types.ts"

/** WebSockets accepted on `/live` carry this tag. */
const LIVE = "live"

/** How long a due draft waits before another try when the send queue refused it. */
const REQUEUE_MS = 30_000

/** Drops the events a store call produced, once they've been broadcast. */
const withoutEvents = <T extends { readonly events: ReadonlyArray<MailboxEvent> }>({
  events: _,
  ...rest
}: T) => rest as Omit<T, "events">

/**
 * One mailbox: a single writer over its own SQLite (src/mailbox/store.ts). This class is the shell:
 * RPC methods delegate to the store, every change is pushed to open clients over hibernating
 * WebSockets, and the Durable Object alarm follows the store's schedule (snoozes, scheduled sends).
 */
export class MailboxDO extends DurableObject<Env> {
  private readonly store: MailboxStore

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.store = new MailboxStore(ctx.storage.sql, (fn) => ctx.storage.transactionSync(fn))
    ctx.blockConcurrencyWhile(async () => this.store.migrate())
    // Heartbeats are answered by the runtime, so an idle connection never wakes the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"))
  }

  // ---------------------------------------------------------------------------------------------
  // Live updates
  // ---------------------------------------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname !== "/live") return new Response("Not found", { status: 404 })
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 })
    }
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
    this.ctx.acceptWebSocket(server, [LIVE])
    server.serializeAttachment({ connectedAt: Date.now() })
    server.send(
      JSON.stringify({
        type: "hello",
        schemaVersion: this.store.schemaVersion(),
        counts: this.store.folderCounts(),
        labels: this.store.labels(),
      }),
    )
    const protocol = request.headers.get("x-mailyard-protocol")
    return new Response(null, {
      status: 101,
      webSocket: client,
      ...(protocol ? { headers: { "sec-websocket-protocol": protocol } } : {}),
    })
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    let request: { type?: unknown } | null = null
    try {
      request = typeof message === "string" ? (JSON.parse(message) as { type?: unknown }) : null
    } catch {
      request = null
    }
    if (request?.type === "counts") {
      ws.send(JSON.stringify({ type: "counts", counts: this.store.folderCounts() }))
      return
    }
    ws.send(JSON.stringify({ type: "error", message: 'Send "ping", or {"type":"counts"}' }))
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string) {
    ws.close(code, reason)
  }

  /** How many clients are connected through the hibernation API. */
  liveConnections(): number {
    return this.ctx.getWebSockets(LIVE).length
  }

  private broadcast(events: ReadonlyArray<MailboxEvent>) {
    if (events.length === 0) return
    const sockets = this.ctx.getWebSockets(LIVE)
    for (const event of events) {
      const frame = JSON.stringify(event)
      for (const ws of sockets) {
        try {
          ws.send(frame)
        } catch {
          // A socket closing as we send is fine: the close handler tidies up.
        }
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Alarm: snoozes and scheduled sends
  // ---------------------------------------------------------------------------------------------

  private async syncAlarm() {
    const next = this.store.nextDue()
    const current = await this.ctx.storage.getAlarm()
    if (next === null) {
      if (current !== null) await this.ctx.storage.deleteAlarm()
      return
    }
    if (current !== next) await this.ctx.storage.setAlarm(next)
  }

  override async alarm() {
    const result = this.store.runDue()
    this.broadcast(result.events)
    // Hand due drafts to the sender. One that can't be handed over goes back on the schedule, so a
    // queue hiccup delays a scheduled send instead of losing it.
    const mailboxId = this.store.getMeta("mailboxId")
    const origin = this.store.getMeta("origin")
    for (const draftId of result.dueDrafts) {
      if (!mailboxId) {
        // Only drafts scheduled through the API carry the mailbox id; a due draft without one stays due.
        console.error(`mailbox: draft ${draftId} is due but this mailbox's id is unknown; it stays due`)
        continue
      }
      try {
        await this.env.MAILBOX_SEND_QUEUE.send({ mailboxId, draftId, origin })
      } catch (error) {
        console.error(`mailbox: could not queue draft ${draftId}, retrying in ${REQUEUE_MS / 1000}s`, error)
        this.store.requeueDraft(draftId, Date.now() + REQUEUE_MS)
      }
    }
    await this.syncAlarm()
  }

  /** Every mutation goes through here: broadcast what changed, then follow the schedule. */
  private async apply<T extends { readonly events: ReadonlyArray<MailboxEvent> }>(result: T) {
    this.broadcast(result.events)
    await this.syncAlarm()
    return withoutEvents(result)
  }

  /** When the alarm is set for, as the runtime reports it. */
  async alarmAt(): Promise<number | null> {
    return await this.ctx.storage.getAlarm()
  }

  // ---------------------------------------------------------------------------------------------
  // RPC
  // ---------------------------------------------------------------------------------------------

  schemaVersion() {
    return this.store.schemaVersion()
  }

  /**
   * Deletes everything this mailbox stores and closes its live connections. The next call starts an
   * empty mailbox at the current schema. Callers check an export exists first.
   */
  async erase() {
    for (const ws of this.ctx.getWebSockets(LIVE)) ws.close(1001, "Mailbox removed")
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
    this.store.migrate()
  }

  /** Files one message. Idempotent on `delivery.id`: a retried delivery reports `stored: false`. */
  async deliver(delivery: InboundDelivery, filing?: Folder | FilingOptions) {
    return await this.apply(this.store.deliver(delivery, filing))
  }

  message(id: string) {
    return this.store.message(id)
  }

  messages(options: { readonly limit?: number; readonly cursor?: string | null } = {}) {
    return this.store.messages(options)
  }

  count() {
    return this.store.count()
  }

  threads(filter: ThreadFilter = {}) {
    return this.store.threads(filter)
  }

  thread(id: string) {
    return this.store.thread(id)
  }

  folderCounts() {
    return this.store.folderCounts()
  }

  attention(input: { readonly olderThan: number; readonly until: number; readonly assignee: string | null }) {
    return this.store.attention(input)
  }

  responseTimes(input: { readonly from: number; readonly to: number }) {
    return this.store.responseTimes(input)
  }

  search(query: string, options: { readonly limit?: number } = {}) {
    return this.store.search(query, options)
  }

  async updateMessages(ids: ReadonlyArray<string>, patch: MessagePatch) {
    return await this.apply(this.store.updateMessages(ids, patch))
  }

  async updateThreads(threadIds: ReadonlyArray<string>, patch: MessagePatch) {
    return await this.apply(this.store.updateThreads(threadIds, patch))
  }

  async purge(ids: ReadonlyArray<string>) {
    return await this.apply(this.store.purge(ids))
  }

  async emptyFolder(folder: "trash" | "spam") {
    return await this.apply(this.store.emptyFolder(folder))
  }

  labels() {
    return this.store.labels()
  }

  async createLabel(input: { readonly name: string; readonly color?: string | null }) {
    return await this.apply(this.store.createLabel(input))
  }

  async updateLabel(id: string, input: { readonly name?: string; readonly color?: string | null }) {
    return await this.apply(this.store.updateLabel(id, input))
  }

  async deleteLabel(id: string) {
    return await this.apply(this.store.deleteLabel(id))
  }

  async snooze(threadId: string, until: number) {
    return await this.apply(this.store.snooze(threadId, until))
  }

  async unsnooze(threadId: string) {
    return await this.apply(this.store.unsnooze(threadId))
  }

  drafts(options: { readonly status?: "draft" | "scheduled" | "due"; readonly limit?: number } = {}) {
    return this.store.drafts(options)
  }

  draft(id: string) {
    return this.store.draft(id)
  }

  async saveDraft(input: DraftInput) {
    return await this.apply(this.store.saveDraft(input))
  }

  /**
   * Schedules a draft. `mailboxId` and `origin` are kept so the alarm can hand the draft to the sender
   * (the object doesn't otherwise know its own name) and build links to large attachments.
   */
  async scheduleDraft(
    id: string,
    sendAt: number,
    context?: { readonly mailboxId: string; readonly origin: string | null },
    track?: { readonly opens: boolean; readonly clicks: boolean } | null,
  ) {
    if (context) {
      this.store.setMeta("mailboxId", context.mailboxId)
      if (context.origin) this.store.setMeta("origin", context.origin)
    }
    return await this.apply(this.store.scheduleDraft(id, sendAt, track ?? null))
  }

  async applyRule(
    rule: Rule,
    options: { readonly folder?: Folder | null; readonly cursor?: string | null; readonly limit?: number },
  ) {
    return await this.apply(this.store.applyRule(rule, options))
  }

  async assign(threadIds: ReadonlyArray<string>, assignee: string | null) {
    return await this.apply(this.store.assign(threadIds, assignee))
  }

  async failDraft(id: string, error: string) {
    return await this.apply(this.store.failDraft(id, error))
  }

  messageIdHolder(messageId: string) {
    return this.store.messageIdHolder(messageId)
  }

  async ensureLabel(name: string) {
    return await this.apply(this.store.ensureLabel(name))
  }

  async addLabelsToMessage(id: string, labelIds: ReadonlyArray<string>) {
    return await this.apply(this.store.addLabelsToMessage(id, labelIds))
  }

  hasAttachmentKey(key: string) {
    return this.store.hasAttachmentKey(key)
  }

  async setMessageId(id: string, messageId: string) {
    return await this.apply(this.store.setMessageId(id, messageId))
  }

  async unscheduleDraft(id: string) {
    return await this.apply(this.store.unscheduleDraft(id))
  }

  async deleteDraft(id: string) {
    return await this.apply(this.store.deleteDraft(id))
  }
}
