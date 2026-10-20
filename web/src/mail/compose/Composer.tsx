/**
 * The composer, as the full window (`section.compose.is-window`, docked or minimised on request) or the
 * inline reply at the end of a thread (`section.reply`). One component for both: From, recipients with
 * suggestions, subject, the body with the signature and the quoted original, attachments with the message
 * budget, tracking, autosave, the split Send button with scheduling and the undo window, and every refusal.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
import { api, unwrap } from "../../api/client.ts"
import { Gated } from "../../auth/NoPermission.tsx"
import { num } from "../../lib/format.ts"
import { usageQuery } from "../../shell/QuotaMeter.tsx"
import { Icon } from "../../ui/icons.tsx"
import { RequestId } from "../../ui/Panel.tsx"
import { useMailOptional } from "../context.tsx"
import { agentFor, utcStamp } from "../logic.ts"
import { agentsQuery, identitiesQuery, mailboxesQuery, mailKeys, threadQuery } from "../queries.ts"
import { toast } from "../toasts.tsx"
import type { Draft, DraftPatch, Identity, SendBody } from "../types.ts"
import { cancelSend, createDraft, discardDraft, getDraft, saveDraft, sendDraft, uploadFile } from "./api.ts"
import { Editor, type EditorHandle } from "./Editor.tsx"
import { CIcon } from "./icons.tsx"
import {
  batches,
  blockedRefusal,
  budgetPlan,
  canInline,
  checkRecipients,
  defaultIdentity,
  fileRefusal,
  isBlank,
  joinBody,
  joinHtml,
  MAX_RECIPIENTS,
  newIdempotencyKey,
  type Rcpt,
  type Refusal,
  recipientRefusal,
  refusalFrom,
  signatureSource,
  splitBody,
  textToHtml,
  toParties,
  type UploadRow,
  userHtmlOf,
} from "./logic.ts"
import { FromMenu, ScheduleMenu, useMenu } from "./Menus.tsx"
import { RecipientRow } from "./Recipients.tsx"
import {
  awaitingApproval,
  enqueueSend,
  markAwaitingApproval,
  setUndoSecondsPref,
  setUndoWindow,
  undoSecondsPref,
} from "./sendState.ts"
import {
  type ComposeMode,
  type ComposeRequest,
  closeCompose,
  closeReply,
  openCompose,
  openReply,
  popOutReply,
} from "./store.ts"
import { Uploads } from "./Uploads.tsx"
import "./compose.css"

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: number }
  | { kind: "error"; message: string }
  | { kind: "local" }

const MODE_LABEL: Record<ComposeMode, string> = {
  new: "New message",
  reply: "Reply",
  replyAll: "Reply all",
  forward: "Forward",
}

const hhmm = (v: number) => {
  const d = new Date(v)
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`
}

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null
  return Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)))
}

export function Composer({ request, variant }: { request: ComposeRequest; variant: "window" | "inline" }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const ctx = useMailOptional()
  const mailboxId = request.mailboxId
  const identities = useQuery(identitiesQuery)
  const boxes = useQuery(mailboxesQuery)
  const agents = useQuery(agentsQuery)
  const reputation = useQuery({
    queryKey: ["reputation"],
    queryFn: () => unwrap(api.GET("/v1/reputation")),
    staleTime: 5 * 60_000,
    retry: false,
  })
  const usage = useQuery(usageQuery)
  const mailbox = boxes.data?.mailboxes.find((m) => m.id === mailboxId)
  const address = ctx?.mailboxId === mailboxId ? ctx.address : (mailbox?.address ?? mailboxId)
  const local = `${address.split("@")[0]}@`
  const agent = ctx?.mailboxId === mailboxId ? ctx.agent : agentFor(mailboxId, agents.data?.agents)
  const canWrite = ctx?.mailboxId === mailboxId ? ctx.access.write : true
  const ids = identities.data?.identities ?? []

  // ── Form state
  const [mode, setMode] = useState<ComposeMode>(request.mode)
  const [phase, setPhase] = useState<"loading" | "ready" | "error">(
    request.draftId || (request.mode !== "new" && request.messageId) ? "loading" : "ready",
  )
  const [loadError, setLoadError] = useState<unknown>(null)
  const [from, setFrom] = useState<string>("")
  const [to, setTo] = useState<Rcpt[]>(
    request.to?.map((p) => ({ name: p.name ?? null, address: p.address })) ?? [],
  )
  const [cc, setCc] = useState<Rcpt[]>([])
  const [bcc, setBcc] = useState<Rcpt[]>([])
  const [showCc, setShowCc] = useState(false)
  const [showBcc, setShowBcc] = useState(false)
  const [subject, setSubject] = useState(request.subject ?? "")
  const [initialHtml, setInitialHtml] = useState("")
  const [editorKey, setEditorKey] = useState(0)
  const [quote, setQuote] = useState("")
  const [sigOn, setSigOn] = useState(true)
  const [uploads, setUploads] = useState<UploadRow[]>([])
  const [track, setTrack] = useState({ opens: false, clicks: false })
  const [undoSeconds, setUndoSecondsState] = useState<0 | 10>(undoSecondsPref())
  const [save, setSave] = useState<SaveState>({ kind: "idle" })
  const [rawRefusal, setRefusal] = useState<Refusal | null>(null)
  // A quota refusal reads the day's figures and reset time from GET /v1/usage when it has them.
  const today = usage.data?.today
  const refusal: Refusal | null =
    rawRefusal?.kind === "quota_exhausted"
      ? {
          ...blockedRefusal("quota_exhausted", {
            resetsAt: rawRefusal.queueAt ?? (today?.resetsAt ? Date.parse(today.resetsAt) : null),
            quota:
              num(today?.quota) !== null
                ? { sent: num(today?.sent) ?? 0, quota: num(today?.quota) ?? 0 }
                : null,
          }),
          ...(rawRefusal.requestId ? { requestId: rawRefusal.requestId } : {}),
        }
      : rawRefusal
  const [sending, setSending] = useState(false)
  const [queued, setQueued] = useState<string | null>(null)
  const [size, setSize] = useState<"window" | "docked" | "min">("window")
  const [dirty, setDirty] = useState(0)
  const editor = useRef<EditorHandle>(null)
  const draftId = useRef<string | null>(request.draftId ?? null)
  const createKey = useRef(newIdempotencyKey())
  const sendKey = useRef(newIdempotencyKey())
  const threadId = useRef<string | null>(request.threadId ?? null)
  const sourceId = useRef<string | null>(request.messageId ?? null)
  /** A reply the server built that nobody has touched: closing it discards it. */
  const pristine = useRef(false)
  const chain = useRef<Promise<unknown>>(Promise.resolve())
  const fromMenu = useMenu()
  const schedMenu = useMenu()
  const fileInput = useRef<HTMLInputElement>(null)
  const titleId = useId()

  const identity: Identity | undefined = ids.find((i) => i.address === from)
  const sig = identity ? signatureSource(identity, ids, boxes.data?.mailboxes) : null
  const signature = sigOn ? (sig?.signature ?? null) : null

  // Default From once identities load.
  useEffect(() => {
    if (from || !ids.length) return
    const def = defaultIdentity(ids, mailboxId, ctx?.mailboxId === mailboxId ? ctx.address : mailbox?.address)
    if (def) setFrom(def.address)
  }, [ids, from, mailboxId, ctx, mailbox])

  const hydrate = useCallback((d: Draft) => {
    draftId.current = d.id
    threadId.current = d.threadId
    sourceId.current = d.sourceMessageId
    if (d.replyMode) setMode(d.replyMode)
    const parts = splitBody(d.bodyText)
    if (d.from) setFrom(d.from)
    setTo(d.to.map((p) => ({ name: p.name, address: p.address })))
    setCc(d.cc.map((p) => ({ name: p.name, address: p.address })))
    setBcc(d.bcc.map((p) => ({ name: p.name, address: p.address })))
    if (d.cc.length) setShowCc(true)
    if (d.bcc.length) setShowBcc(true)
    setSubject(d.subject)
    setQuote(parts.quote)
    setInitialHtml(userHtmlOf(d.bodyHtml) ?? textToHtml(parts.text))
    setEditorKey((k) => k + 1)
    setSigOn(parts.signature !== null || isBlank(parts.text))
    setUploads(
      d.attachments.map((a, i) => ({
        id: `${a.key}-${i}`,
        filename: a.filename,
        mimeType: a.mimeType,
        size: Number(a.size) || 0,
        status: "done" as const,
        progress: 1,
        key: a.key,
        delivery: a.delivery ?? "inline",
        carried: d.replyMode === "forward" && !a.key.startsWith("upl/"),
      })),
    )
    if (d.track) setTrack({ opens: d.track.opens, clicks: d.track.clicks })
    if (d.blockedReason)
      setRefusal(
        blockedRefusal(d.blockedReason, {
          recipients: d.to.map((p) => p.address),
          ...(d.from ? { domain: d.from.split("@")[1] as string } : {}),
        }),
      )
    else
      setRefusal((r) =>
        r &&
        r.kind !== "invalid" &&
        r.sticky &&
        ["quota_exhausted", "domain_unhealthy", "all_recipients_suppressed"].includes(r.kind)
          ? null
          : r,
      )
  }, [])

  // ── Open: resume a draft, or build a reply/forward on the server.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per request
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      try {
        if (request.draftId) {
          const d = await getDraft(mailboxId, request.draftId)
          if (!cancelled) hydrate(d)
        } else if (request.mode !== "new" && request.messageId) {
          const existing = request.threadId
            ? (await qc.fetchQuery(threadQuery(mailboxId, request.threadId)).catch(() => null))?.drafts.find(
                (d) =>
                  d.status === "draft" &&
                  d.sourceMessageId === request.messageId &&
                  d.replyMode === request.mode,
              )
            : undefined
          const d =
            existing ??
            (await createDraft(
              mailboxId,
              { replyTo: { messageId: request.messageId, mode: request.mode } },
              createKey.current,
            ))
          if (!existing) pristine.current = true
          if (!cancelled) hydrate(d)
          qc.invalidateQueries({ queryKey: mailKeys.draftLists(mailboxId) })
        }
        if (!cancelled) setPhase("ready")
      } catch (e) {
        if (!cancelled) {
          setLoadError(e)
          setPhase("error")
        }
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [])

  // ── Build the save body from the form.
  const body = useCallback((): DraftPatch => {
    const text = editor.current?.text() ?? ""
    const html = editor.current?.html() ?? ""
    const plan = budgetPlan(uploads)
    return {
      from: from || null,
      to: toParties(to),
      cc: toParties(cc),
      bcc: toParties(bcc),
      subject,
      bodyText: joinBody(text, signature?.text ?? null, quote),
      bodyHtml: joinHtml(html, signature, quote),
      attachments: uploads
        .filter((u) => u.status === "done" && u.key)
        .map((u) => ({
          key: u.key as string,
          filename: u.filename,
          mimeType: u.mimeType,
          size: u.size,
          delivery: !canInline(u.size) || plan.forced.has(u.id) ? ("link" as const) : u.delivery,
        })),
    }
  }, [from, to, cc, bcc, subject, signature, quote, uploads])

  /** Saves now (creating the draft the first time), one save at a time. */
  const flush = useCallback((): Promise<Draft | null> => {
    const run = async (): Promise<Draft | null> => {
      const b = body()
      const empty =
        !draftId.current &&
        isBlank(editor.current?.text() ?? "") &&
        !b.to?.length &&
        !b.subject &&
        !b.attachments?.length
      if (empty) return null
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        setSave({ kind: "local" })
        return null
      }
      setSave({ kind: "saving" })
      try {
        const d = draftId.current
          ? await saveDraft(mailboxId, draftId.current, b)
          : await createDraft(
              mailboxId,
              { ...b, ...(threadId.current ? { threadId: threadId.current } : {}) },
              createKey.current,
            )
        draftId.current = d.id
        setSave({ kind: "saved", at: Date.now() })
        if (d.blockedReason)
          setRefusal(
            blockedRefusal(d.blockedReason, {
              recipients: d.to.map((p) => p.address),
              ...(d.from ? { domain: d.from.split("@")[1] as string } : {}),
            }),
          )
        qc.invalidateQueries({ queryKey: mailKeys.draftLists(mailboxId) })
        return d
      } catch (e) {
        setSave({ kind: "error", message: e instanceof Error ? e.message : "Not saved" })
        throw e
      }
    }
    const next = chain.current.then(run, run)
    chain.current = next.catch(() => null)
    return next
  }, [body, mailboxId, qc])

  // ── Autosave: 700 ms after the last change.
  useEffect(() => {
    if (!dirty || phase !== "ready") return
    pristine.current = false
    const t = setTimeout(() => {
      flush().catch(() => {})
    }, 700)
    return () => clearTimeout(t)
  }, [dirty, phase, flush])

  const touch = useCallback(() => setDirty((n) => n + 1), [])
  // Editing recipients or From clears a refusal those fields caused.
  const editRecipients = (set: (v: Rcpt[]) => void) => (v: Rcpt[]) => {
    set(v)
    setRefusal((r) =>
      r &&
      (r.kind === "all_recipients_suppressed" || r.kind === "recipient_not_allowed" || r.kind === "invalid")
        ? null
        : r,
    )
    touch()
  }

  // ── Uploads
  const startUpload = useCallback(
    (row: UploadRow, file: File) => {
      uploadFile(mailboxId, file, (share) =>
        setUploads((rs) => rs.map((r) => (r.id === row.id ? { ...r, progress: share } : r))),
      )
        .then((u) => {
          setUploads((rs) =>
            rs.map((r) =>
              r.id === row.id
                ? {
                    ...r,
                    status: "done",
                    progress: 1,
                    key: u.key,
                    mimeType: u.mimeType || r.mimeType,
                    size: Number(u.size) || r.size,
                  }
                : r,
            ),
          )
          touch()
        })
        .catch((e) => {
          const r = refusalFrom(e)
          setUploads((rs) =>
            rs.map((x) =>
              x.id === row.id
                ? {
                    ...x,
                    status: "failed",
                    error:
                      e && (e as { status?: number }).status === 413
                        ? (fileRefusal(Number.MAX_SAFE_INTEGER) ?? "Too big")
                        : `Didn’t upload: ${r.notice.lead} ${r.notice.body}`.trim(),
                  }
                : x,
            ),
          )
        })
    },
    [mailboxId, touch],
  )
  const files = useRef(new Map<string, File>())
  const addFiles = (list: FileList | File[]) => {
    for (const file of Array.from(list)) {
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
      const problem = fileRefusal(file.size)
      const row: UploadRow = {
        id,
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        status: problem ? "too-big" : "uploading",
        progress: 0,
        delivery: canInline(file.size) ? "inline" : "link",
        ...(problem ? { error: problem } : {}),
      }
      setUploads((rs) => [...rs, row])
      if (!problem) {
        files.current.set(id, file)
        startUpload(row, file)
      }
    }
  }

  // ── Checks before Send
  const rcheck = checkRecipients(to, cc, bcc)
  const clientRefusal = recipientRefusal(rcheck)
  const uploading = uploads.some((u) => u.status === "uploading")
  const blocked: Refusal | null = refusal?.sticky ? refusal : clientRefusal
  const marked = useMemo(() => new Set((refusal?.marked ?? []).map((a) => a.toLowerCase())), [refusal])
  const markedWhy =
    refusal?.kind === "all_recipients_suppressed"
      ? "suppressed"
      : refusal?.kind === "recipient_not_allowed"
        ? "not on the allow-list"
        : undefined
  const atRisk =
    reputation.data &&
    (reputation.data.levels.bounce === "at-risk" ||
      reputation.data.levels.complaint === "at-risk" ||
      reputation.data.levels.spamRejection === "at-risk")
  const heldFor = awaitingApproval(draftId.current ?? undefined)

  const close = useCallback(
    async (opts: { discard?: boolean } = {}) => {
      if (variant === "window") closeCompose()
      else closeReply()
      try {
        if ((opts.discard || pristine.current) && draftId.current) {
          await discardDraft(mailboxId, draftId.current)
          qc.invalidateQueries({ queryKey: mailKeys.draftLists(mailboxId) })
          if (threadId.current)
            qc.invalidateQueries({ queryKey: mailKeys.thread(mailboxId, threadId.current) })
          if (opts.discard) toast({ title: "Draft discarded" })
        } else if (!opts.discard) {
          const d = await flush()
          if (d) toast({ title: "Draft saved", sub: `In Drafts · ${local}` })
        }
      } catch {
        toast({ title: "The draft couldn’t be saved", sub: "Your last edits may be missing.", tone: "error" })
      }
    },
    [variant, mailboxId, qc, flush, local],
  )

  const reopen = useCallback(
    (id: string): ComposeRequest => ({
      mailboxId,
      mode,
      draftId: id,
      ...(threadId.current ? { threadId: threadId.current } : {}),
      ...(sourceId.current ? { messageId: sourceId.current } : {}),
    }),
    [mailboxId, mode],
  )

  const send = useCallback(
    async (sendAt?: number) => {
      if (sending) return
      if (blocked && !(sendAt && blocked.kind === "quota_exhausted")) return
      if (uploading) {
        toast({ title: "Wait for the uploads to finish", sub: "Send is ready once every file is attached." })
        return
      }
      const payload: SendBody = {
        ...(sendAt ? { sendAt } : { undoSeconds }),
        track: { opens: track.opens, clicks: track.clicks },
      }
      const firstTo = to[0]?.address ?? cc[0]?.address ?? bcc[0]?.address ?? ""
      // Offline: keep it on this device and send when the connection is back (same idempotency keys).
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        const id = draftId.current ?? createKey.current
        const b = body()
        enqueueSend({
          id,
          mailboxId,
          draftId: draftId.current,
          create: draftId.current
            ? null
            : {
                body: { ...b, ...(threadId.current ? { threadId: threadId.current } : {}) },
                key: createKey.current,
              },
          patch: draftId.current ? (b as Record<string, unknown>) : null,
          send: payload,
          sendKey: sendKey.current,
          to: firstTo,
          subject,
          queuedAt: Date.now(),
          threadId: threadId.current,
        })
        setQueued(id)
        toast({ title: "Queued on this device", sub: `Sends to ${firstTo} when you’re back online.` })
        return
      }
      setSending(true)
      try {
        const d = await flush()
        const id = d?.id ?? draftId.current
        if (!id) {
          setSending(false)
          return
        }
        const res = await sendDraft(mailboxId, id, payload, sendKey.current)
        qc.invalidateQueries({ queryKey: mailKeys.draftLists(mailboxId) })
        if (threadId.current) qc.invalidateQueries({ queryKey: mailKeys.thread(mailboxId, threadId.current) })
        if (variant === "window") closeCompose()
        else closeReply()
        const back = reopen(id)
        if (res.approval) {
          markAwaitingApproval(id, res.approval.id)
          toast({
            title: "Waiting for approval",
            sub: `This mailbox’s sends wait for an owner or admin. It goes to ${firstTo} once they approve it.`,
          })
        } else if (sendAt) {
          toast({
            title: `Scheduled for ${utcStamp(res.sendAt ?? sendAt)}`,
            sub: `To ${firstTo} · waits in Scheduled`,
            action: {
              label: "Cancel schedule",
              onClick: async () => {
                await cancelSend(mailboxId, id)
                qc.invalidateQueries({ queryKey: mailKeys.draftLists(mailboxId) })
                if (back.threadId && variant === "inline") openReply({ ...back, threadId: back.threadId })
                else openCompose(back)
              },
            },
          })
        } else if (res.undoUntil) {
          const until = Number(res.undoUntil)
          const doUndo = async () => {
            setUndoWindow(null)
            try {
              await cancelSend(mailboxId, id)
              qc.invalidateQueries({ queryKey: mailKeys.draftLists(mailboxId) })
              if (back.threadId) qc.invalidateQueries({ queryKey: mailKeys.thread(mailboxId, back.threadId) })
              toast({ title: "Send undone", sub: "Back in the composer, nothing went out." })
              if (back.threadId && variant === "inline") openReply({ ...back, threadId: back.threadId })
              else openCompose(back)
            } catch (e) {
              toast({
                title: "Too late to undo",
                sub: refusalFrom(e).notice.body || "It already went out.",
                tone: "error",
              })
            }
          }
          const toastId = toast({
            title: `Sending to ${firstTo}`,
            countdown: `Sending in {n} s · from ${from || address}`,
            until,
            action: { label: "Undo", onClick: doUndo, shortcut: "Z" },
            onExpire: () => setUndoWindow(null),
          })
          setUndoWindow({ mailboxId, draftId: id, until, reopen: back, toastId })
          undoHandler = doUndo
        } else {
          toast({
            title: `Sent to ${firstTo}`,
            sub: "Undo is off for this send, so it went straight out.",
            ...(back.threadId
              ? {
                  action: {
                    label: "View",
                    onClick: () =>
                      navigate({
                        to: "/mail/$mailboxId/threads/$threadId",
                        params: { mailboxId, threadId: back.threadId as string },
                      }),
                  },
                }
              : {}),
          })
        }
      } catch (e) {
        sendKey.current = newIdempotencyKey()
        setRefusal(
          refusalFrom(e, {
            recipients: [...to, ...cc, ...bcc].map((r) => r.address),
            domain: (from || address).split("@")[1] as string,
          }),
        )
        setSending(false)
      }
    },
    [
      sending,
      blocked,
      uploading,
      undoSeconds,
      track,
      to,
      cc,
      bcc,
      body,
      mailboxId,
      subject,
      flush,
      qc,
      variant,
      reopen,
      from,
      address,
      navigate,
    ],
  )

  // ── Mode switch on the inline reply: rebuild on the server, carrying what you wrote.
  const switchMode = async (next: ComposeMode) => {
    if (next === mode || !sourceId.current || next === "new") return
    const old = draftId.current
    const text = editor.current?.text() ?? ""
    setPhase("loading")
    try {
      const d = await createDraft(
        mailboxId,
        {
          replyTo: { messageId: sourceId.current, mode: next },
          ...(isBlank(text) ? {} : { bodyText: text }),
        },
        newIdempotencyKey(),
      )
      createKey.current = newIdempotencyKey()
      if (old) await discardDraft(mailboxId, old).catch(() => {})
      setMode(next)
      hydrate(d)
      pristine.current = isBlank(text)
      setPhase("ready")
      qc.invalidateQueries({ queryKey: mailKeys.draftLists(mailboxId) })
    } catch (e) {
      setLoadError(e)
      setPhase("error")
    }
  }

  // ── Split a list over 50 into more drafts (compose-recipients).
  const splitBatches = async () => {
    const all = [...to, ...cc, ...bcc]
    const [first, ...rest] = batches(all)
    setTo([])
    setCc([])
    setBcc(first ?? [])
    setShowBcc(true)
    touch()
    try {
      const b = body()
      for (const group of rest)
        await createDraft(mailboxId, { ...b, to: [], cc: [], bcc: toParties(group) }, newIdempotencyKey())
      qc.invalidateQueries({ queryKey: mailKeys.draftLists(mailboxId) })
      toast({
        title: `Split into ${rest.length + 1} drafts of up to ${MAX_RECIPIENTS}`,
        sub: "Everyone is in Bcc. The others wait in Drafts.",
      })
    } catch (e) {
      toast({ title: "Couldn’t make the other drafts", sub: refusalFrom(e).notice.body, tone: "error" })
    }
  }

  // ── Keys: ⌘↵ sends; Escape closes the window (keeping the draft); ⇧C pops the reply out.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        variant === "inline" &&
        e.key === "C" &&
        e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !isTyping(e.target)
      ) {
        e.preventDefault()
        void flush().then((d) => popOutReply(d?.id ?? draftId.current ?? undefined))
      }
      if (variant === "window" && e.key === "Escape" && !e.defaultPrevented && size === "window") {
        e.preventDefault()
        void close()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [variant, flush, close, size])
  const onComposerKey = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault()
      void send()
    }
  }

  if (phase === "error") {
    const r = refusalFrom(loadError)
    const inner = (
      <div className="compose-notice is-error" role="alert">
        <Icon name="warn" />
        <div className="grow">
          <span>
            <b>
              {request.draftId
                ? "This draft didn’t open."
                : `The ${MODE_LABEL[mode].toLowerCase()} couldn’t be started.`}
            </b>{" "}
            {r.notice.lead} {r.notice.body}
          </span>
          <span className="cluster">
            <button
              className="btn btn-secondary btn-sm"
              type="button"
              onClick={() => (variant === "window" ? closeCompose() : closeReply())}
            >
              Close
            </button>
            {r.requestId ? <RequestId id={r.requestId} /> : null}
          </span>
        </div>
      </div>
    )
    return variant === "window" ? (
      <section className="compose is-window" role="dialog" aria-label={MODE_LABEL[mode]}>
        {inner}
      </section>
    ) : (
      <section className="reply" aria-label={MODE_LABEL[mode]}>
        {inner}
      </section>
    )
  }

  const saveText =
    save.kind === "saving"
      ? "Saving…"
      : save.kind === "saved"
        ? `Saved ${hhmm(save.at)}`
        : save.kind === "error"
          ? "Not saved"
          : save.kind === "local"
            ? "Offline · kept on this device"
            : draftId.current
              ? "Draft"
              : ""
  const saveEl = saveText ? (
    <span className="save-state" role="status" title={save.kind === "error" ? save.message : undefined}>
      {save.kind === "saving" ? <span className="spinner" aria-hidden="true" /> : null}
      {saveText}
    </span>
  ) : null

  const fromRow = (
    <div className="compose-row" ref={fromMenu.ref}>
      <span className="lbl">From</span>
      <button
        className="btn btn-ghost btn-sm from-btn"
        type="button"
        aria-haspopup="menu"
        aria-expanded={fromMenu.open}
        data-endpoint="GET /v1/identities"
        onClick={() => fromMenu.setOpen(!fromMenu.open)}
      >
        <span className="from-name">
          {identity?.displayName ? <span className="dn">{identity.displayName} </span> : null}
          <span className="mono">&lt;{from || address}&gt;</span>
        </span>
        <Icon name="chevron-down" />
      </button>
      {fromMenu.open ? (
        <FromMenu
          id={`${titleId}-from`}
          identities={ids}
          anyAddressOn={identities.data?.anyAddressOn ?? []}
          mailboxes={boxes.data?.mailboxes}
          value={from}
          onPick={(a) => {
            setFrom(a)
            fromMenu.setOpen(false)
            setRefusal((r) => (r?.kind === "domain_unhealthy" ? null : r))
            touch()
          }}
        />
      ) : null}
    </div>
  )

  const ccBcc = (
    <>
      {!showCc ? (
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setShowCc(true)}>
          Cc
        </button>
      ) : null}
      {!showBcc ? (
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setShowBcc(true)}>
          Bcc
        </button>
      ) : null}
    </>
  )

  const notices = (
    <>
      {refusal && !(refusal.kind === "invalid" && !refusal.notice.lead) ? (
        <div
          className={`compose-notice is-${refusal.notice.tone}`}
          role={refusal.notice.tone === "error" ? "alert" : "status"}
        >
          <Icon name={refusal.notice.tone === "info" ? "info" : "warn"} />
          <div className="grow">
            <span>
              <b>{refusal.notice.lead}</b> {refusal.notice.body}
            </span>
            {refusal.notice.link ? (
              <Link className="link" to={refusal.notice.link.to}>
                {refusal.notice.link.label}
              </Link>
            ) : null}
            {refusal.requestId && !refusal.sticky ? <RequestId id={refusal.requestId} /> : null}
          </div>
        </div>
      ) : null}
      {rcheck.overLimit ? (
        <div className="compose-notice is-warn" role="alert">
          <Icon name="warn" />
          <div className="grow">
            <span>
              <b>{rcheck.total} recipients.</b> Cloudflare takes at most {MAX_RECIPIENTS} per message, and a
              message to a list this size reads as bulk mail.
            </span>
            <span className="cluster">
              <Link className="btn btn-secondary btn-sm" to="/campaigns">
                Send as a campaign instead
              </Link>
              <button className="btn btn-ghost btn-sm" type="button" onClick={splitBatches}>
                Move them to Bcc in batches
              </button>
            </span>
          </div>
        </div>
      ) : null}
      {rcheck.invalid.map((i) => (
        <div key={i.address} className="compose-notice is-error" role="alert">
          <Icon name="warn" />
          <div className="grow">
            <span>
              <b>{i.address}</b> isn’t an email address: {i.problem}.
            </span>
          </div>
        </div>
      ))}
      {atRisk ? (
        <div className="compose-notice is-warn" role="status">
          <Icon name="warn" />
          <div className="grow">
            <span>
              <b>Reputation is at risk, but this reply still goes.</b> Mailyard pauses campaigns and
              automations on reputation, never one-to-one mail. Every send still counts toward the bounce and
              complaint rates, so check the address before you send.
            </span>
            <Link className="link" to="/domains">
              See what drove it
            </Link>
          </div>
        </div>
      ) : null}
      {agent ? (
        <div className="compose-notice is-info" role="status">
          <Icon name="bot" />
          <div className="grow">
            <span>
              <b>You’re writing from {agent.name}’s mailbox.</b> {local} belongs to an agent. Messages don’t
              yet record which person sent them, so this reply will show as sent by {agent.name}.
            </span>
          </div>
        </div>
      ) : null}
      {heldFor ? (
        <div className="compose-notice is-info" role="status">
          <Icon name="clock" />
          <div className="grow">
            <span>
              <b>Waiting for approval.</b> An owner or admin decides in Settings → Approvals; it sends as soon
              as they approve it.
            </span>
          </div>
        </div>
      ) : null}
      {queued ? (
        <div className="queued" role="status" style={{ margin: "10px 12px 0" }}>
          <Icon name="wifi-off" />
          <span className="grow">
            <b>Queued on this device</b>
            <span className="t-small">
              It sends the moment you’re back online. Keep this tab open or come back to it.
            </span>
          </span>
        </div>
      ) : null}
    </>
  )

  const sendLabel = sending ? "Sending…" : "Send"
  const footer = (
    <div className="compose-foot">
      <span className="send-group" ref={schedMenu.ref} style={{ position: "relative" }}>
        <Gated
          allowed={!blocked && canWrite}
          reason={
            !canWrite ? (ctx?.access.writeReason ?? "You can’t send from here") : (blocked?.title ?? "")
          }
          who={!canWrite ? ctx?.access.writeWho : blocked?.who}
          side="up"
        >
          <button
            className="btn btn-primary"
            type="button"
            title="Send · ⌘↵"
            aria-keyshortcuts="Meta+Enter Control+Enter"
            data-endpoint="POST /v1/mailboxes/{id}/drafts/{draftId}/send"
            disabled={sending || phase !== "ready"}
            onClick={() => void send()}
          >
            {!canWrite ? "Can’t send" : blocked && blocked.button !== "Send" ? blocked.button : sendLabel}
          </button>
        </Gated>
        <button
          className="btn btn-primary"
          type="button"
          aria-label={
            blocked && blocked.kind !== "quota_exhausted" ? "Schedule send unavailable" : "Schedule send"
          }
          title="Schedule send"
          aria-haspopup="menu"
          aria-expanded={schedMenu.open}
          {...(blocked && blocked.kind !== "quota_exhausted" ? { "aria-disabled": true } : {})}
          onClick={() =>
            !(blocked && blocked.kind !== "quota_exhausted") && schedMenu.setOpen(!schedMenu.open)
          }
        >
          <Icon name="chevron-down" />
        </button>
        {schedMenu.open ? (
          <ScheduleMenu
            id={`${titleId}-schedule`}
            undoSeconds={undoSeconds}
            onUndoSeconds={(v) => {
              setUndoSecondsState(v)
              setUndoSecondsPref(v)
            }}
            {...(refusal?.queueAt ? { queueAt: refusal.queueAt } : {})}
            onSchedule={(at) => {
              schedMenu.setOpen(false)
              void send(at)
            }}
          />
        ) : null}
      </span>
      {refusal?.kind === "quota_exhausted" && refusal.queueAt ? (
        <button
          className="btn btn-secondary"
          type="button"
          data-endpoint="POST …/drafts/{draftId}/send {sendAt: resetsAt}"
          onClick={() => void send(refusal.queueAt)}
        >
          Queue for {hhmm(refusal.queueAt)} UTC
        </button>
      ) : null}
      <button
        className="icon-btn"
        type="button"
        aria-label="Attach files (up to 25 MiB each)"
        title="Attach files (up to 25 MiB each)"
        onClick={() => fileInput.current?.click()}
      >
        <Icon name="paperclip" />
      </button>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) addFiles(e.target.files)
          e.target.value = ""
        }}
      />
      <span className="grow" />
      {sig ? (
        <button
          className="link-quiet t-small hide-phone"
          type="button"
          title={sigOn ? "Remove the signature from this message" : "Add the signature back"}
          onClick={() => {
            setSigOn(!sigOn)
            touch()
          }}
          data-endpoint="GET /v1/identities → signature"
        >
          {sigOn ? sig.footer : "Signature off"}
        </button>
      ) : null}
      <button
        className="icon-btn"
        type="button"
        aria-label="Discard draft"
        title="Discard draft"
        onClick={() => void close({ discard: true })}
      >
        <Icon name="trash" />
      </button>
    </div>
  )

  const signatureBlock =
    signature && sigOn ? (
      <div className="compose-sig sig">
        {signature.text.split("\n").map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static signature lines
          <span key={i}>
            {l}
            <br />
          </span>
        ))}
      </div>
    ) : null
  const quoteBlock = quote.trim() ? (
    <div className="compose-quote msg-body">
      <div className="quote">
        {quote
          .trim()
          .split("\n")
          .map((l, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static quoted lines
            <span key={i}>
              {l}
              <br />
            </span>
          ))}
      </div>
    </div>
  ) : null

  const track$ = (
    // biome-ignore lint/a11y/useSemanticElements: the design's .track-opts row, not a fieldset with a legend
    <div
      className="track-opts"
      role="group"
      aria-labelledby={`${titleId}-track`}
      data-endpoint="POST …/drafts/{draftId}/send {track}"
    >
      <span className="lbl" id={`${titleId}-track`}>
        Tracking
      </span>
      <label className="check">
        <input
          type="checkbox"
          checked={track.opens}
          onChange={(e) => setTrack({ ...track, opens: e.target.checked })}
        />
        <span>Opens</span>
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={track.clicks}
          onChange={(e) => setTrack({ ...track, clicks: e.target.checked })}
        />
        <span>Clicks</span>
      </label>
      <span className="track-hint">
        <b>Off by default.</b> One-to-one mail goes out untracked unless you tick a box here, for this message
        only. Opens by mail-privacy proxies and scanners are counted apart from people.
      </span>
    </div>
  )

  const loading = phase === "loading"
  const fields = loading ? (
    <div className="compose-loading" aria-busy="true">
      <span className="sk sk-text" style={{ width: "60%" }} />
      <span className="sk sk-text" style={{ width: "40%" }} />
      <span className="sk sk-text" style={{ width: "80%" }} />
    </div>
  ) : (
    <>
      {fromRow}
      <RecipientRow
        label="To"
        kind="to"
        mailboxId={mailboxId}
        local={local}
        value={to}
        onChange={editRecipients(setTo)}
        marked={marked}
        {...(markedWhy ? { markedWhy } : {})}
        actions={ccBcc}
        autoFocus={variant === "window" && to.length === 0}
      />
      {showCc ? (
        <RecipientRow
          label="Cc"
          kind="cc"
          mailboxId={mailboxId}
          local={local}
          value={cc}
          onChange={editRecipients(setCc)}
          marked={marked}
        />
      ) : null}
      {showBcc ? (
        <RecipientRow
          label="Bcc"
          kind="bcc"
          mailboxId={mailboxId}
          local={local}
          value={bcc}
          onChange={editRecipients(setBcc)}
          marked={marked}
        />
      ) : null}
      {variant === "window" ? (
        <label className="compose-row">
          <span className="lbl">Subject</span>
          <input
            value={subject}
            aria-label="Subject"
            onChange={(e) => {
              setSubject(e.target.value)
              touch()
            }}
          />
        </label>
      ) : null}
      {notices}
      <Editor
        key={editorKey}
        ref={editor}
        label={variant === "window" ? "Message" : "Reply"}
        initialHtml={initialHtml}
        onInput={touch}
        onKeyDown={onComposerKey}
        autoFocus={variant === "inline" || to.length > 0}
        aiContext={{ mailboxId, ...(threadId.current ? { threadId: threadId.current } : {}) }}
        onTemplateSubject={(s) => {
          if (!subject) setSubject(s)
        }}
        after={
          <>
            {signatureBlock}
            {quoteBlock}
          </>
        }
      />
      {track$}
      <Uploads
        rows={uploads}
        onRemove={(id) => {
          setUploads((rs) => rs.filter((r) => r.id !== id))
          files.current.delete(id)
          touch()
        }}
        onDelivery={(id, d) => {
          setUploads((rs) => rs.map((r) => (r.id === id ? { ...r, delivery: d } : r)))
          touch()
        }}
        onRetry={(id) => {
          const file = files.current.get(id)
          const row = uploads.find((r) => r.id === id)
          if (!file || !row) return
          const next = { ...row, status: "uploading" as const, progress: 0 }
          setUploads((rs) => rs.map((r) => (r.id === id ? next : r)))
          startUpload(next, file)
        }}
      />
    </>
  )

  const drop = {
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes("Files")) e.preventDefault()
    },
    onDrop: (e: React.DragEvent) => {
      if (!e.dataTransfer.files.length) return
      e.preventDefault()
      addFiles(e.dataTransfer.files)
    },
  }

  if (variant === "inline") {
    return (
      <section
        className="reply"
        aria-label={MODE_LABEL[mode]}
        data-endpoint="POST /v1/mailboxes/{id}/drafts {replyTo:{messageId, mode}} · PATCH …/drafts/{draftId} (autosave)"
        onKeyDown={onComposerKey}
        {...drop}
      >
        <div className="reply-mode">
          {/* biome-ignore lint/a11y/useSemanticElements: the design's .seg control */}
          <div className="seg" role="group" aria-label="Reply mode">
            {(["reply", "replyAll", "forward"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => void switchMode(m)}
                disabled={loading}
              >
                <Icon name={m === "forward" ? "forward" : "reply"} /> {MODE_LABEL[m]}
              </button>
            ))}
          </div>
          <span className="grow" />
          {saveEl}
          <button
            className="icon-btn"
            type="button"
            aria-label="Open in a full window"
            title="Open in a full window · ⇧C"
            aria-keyshortcuts="Shift+C"
            onClick={() => void flush().then((d) => popOutReply(d?.id ?? draftId.current ?? undefined))}
          >
            <Icon name="external" />
          </button>
          <button
            className="icon-btn"
            type="button"
            aria-label="Close and keep the draft"
            title="Close · keeps the draft"
            onClick={() => void close()}
          >
            <Icon name="x" />
          </button>
        </div>
        {fields}
        {footer}
      </section>
    )
  }

  const title = mode === "new" ? subject.trim() || "New message" : MODE_LABEL[mode]
  return (
    <>
      {size === "window" ? (
        <div className="scrim compose-scrim" onClick={() => void close()} aria-hidden="true" />
      ) : null}
      <section
        className={`compose${size === "window" ? " is-window" : ""}${size === "min" ? " is-min" : ""}`}
        role="dialog"
        aria-modal={size === "window"}
        aria-labelledby={titleId}
        data-endpoint="POST /v1/mailboxes/{id}/drafts · PATCH /v1/mailboxes/{id}/drafts/{draftId} (autosave)"
        onKeyDown={onComposerKey}
        {...drop}
      >
        <div className="compose-head">
          <span className="t-h4 compose-title" id={titleId}>
            {title}
          </span>
          <span className="cluster cluster-4">
            {saveEl}
            <button
              className="icon-btn"
              type="button"
              aria-label={size === "min" ? "Restore" : "Minimise"}
              title={size === "min" ? "Restore" : "Minimise"}
              onClick={() => setSize(size === "min" ? "docked" : "min")}
            >
              <CIcon name={size === "min" ? "maximize" : "minimize"} />
            </button>
            <button
              className="icon-btn hide-phone"
              type="button"
              aria-label={size === "window" ? "Dock" : "Full window"}
              title={size === "window" ? "Dock" : "Full window"}
              onClick={() => setSize(size === "window" ? "docked" : "window")}
            >
              <CIcon name={size === "window" ? "dock" : "maximize"} />
            </button>
            <button
              className="icon-btn"
              type="button"
              aria-label="Close and keep draft"
              title="Close · esc"
              onClick={() => void close()}
            >
              <Icon name="x" />
            </button>
          </span>
        </div>
        {size === "min" ? null : (
          <>
            {fields}
            {footer}
          </>
        )}
      </section>
    </>
  )
}

/** The Undo of the open undo window, for Z (set by the last send that had one). */
let undoHandler: (() => Promise<void>) | null = null
export const runUndo = () => {
  const h = undoHandler
  undoHandler = null
  return h ? h() : null
}
