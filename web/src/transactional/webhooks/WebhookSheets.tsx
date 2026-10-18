/**
 * Webhook sheets (design: webhook-create, webhook-rotate-secret, webhook-test-sample, webhook-replay-progress).
 * The signing secret is shown once, after the endpoint is added or the secret rotated. The HAL-3464 pieces
 * (filters, per-event test samples) are drawn and stay off until the live schema carries them.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type FormEvent, useEffect, useId, useRef, useState } from "react"
import { api, type paths, unwrap } from "../../api/client.ts"
import { fmtInt, num } from "../../lib/format.ts"
import { CodeBlock, Secret } from "../../ops/Copy.tsx"
import { BuiltPill } from "../../ops/kit.tsx"
import { Sheet } from "../../ops/Overlay.tsx"
import { toast } from "../../ops/toast.tsx"
import { Icon } from "../../ui/icons.tsx"
import { ConfirmInput } from "../keys/KeySheets.tsx"
import { Refusal } from "../keys/ui.tsx"
import {
  FILTER_STREAMS,
  type Filter,
  filterBody,
  groupEvents,
  host,
  PLANNED_EVENTS,
  REPLAY_PAGE,
  type ReplayStep,
  replayAll,
  testableEvents,
  toFilter,
  toggleEvent,
  validateWebhookUrl,
} from "./logic.ts"

type Hook = {
  id: string
  url: string
  description: string | null
  events: string[]
  enabled: boolean
  deadLetters: number | string
  paused?: boolean
  held?: number | string
  filter?: Partial<Filter> | null
}

const invalidate = (qc: ReturnType<typeof useQueryClient>, id?: string) =>
  Promise.all([
    qc.invalidateQueries({ queryKey: ["webhooks"] }),
    id ? qc.invalidateQueries({ queryKey: ["webhooks", id] }) : null,
  ])

type WebhookEvent = NonNullable<
  NonNullable<
    NonNullable<paths["/v1/webhooks/{id}/test"]["post"]["requestBody"]>["content"]["application/json"]
  >["event"]
>

// ── Add or edit an endpoint ───────────────────────────────────────────────────────────────────────────────

export function EndpointSheet({
  hook,
  events,
  onClose,
  onCreated,
}: {
  hook?: Hook
  events: readonly string[]
  onClose: () => void
  onCreated?: (id: string) => void
}) {
  const qc = useQueryClient()
  const urlId = useId()
  const descId = useId()
  const [url, setUrl] = useState(hook?.url ?? "")
  const [desc, setDesc] = useState(hook?.description ?? "")
  const [picked, setPicked] = useState<string[]>(hook?.events ?? [])
  const [filter, setFilter] = useState<Filter>(() => toFilter(hook?.filter))
  const [tried, setTried] = useState(false)
  const urlProblem = validateWebhookUrl(url)
  const eventsProblem = picked.length ? null : "Pick at least one event, or All events."

  const save = useMutation({
    mutationFn: async () => {
      const events = picked as [string, ...string[]]
      const f = filterBody(filter)
      if (hook) {
        const body = { url: url.trim(), description: desc.trim() || null, events, filter: f }
        return {
          updated: await unwrap(api.PATCH("/v1/webhooks/{id}", { params: { path: { id: hook.id } }, body })),
        }
      }
      const body = {
        url: url.trim(),
        ...(desc.trim() ? { description: desc.trim() } : {}),
        events,
        ...(f ? { filter: f } : {}),
      }
      return { created: await unwrap(api.POST("/v1/webhooks", { body: body as never })) }
    },
    onSuccess: async (r) => {
      await invalidate(qc, hook?.id)
      if ("updated" in r) {
        toast({ title: "Endpoint saved", sub: host(url) })
        onClose()
      }
    },
  })

  if (save.data && "created" in save.data && save.data.created) {
    const { endpoint, secret } = save.data.created
    const finish = () => (onCreated ? onCreated(endpoint.id) : onClose())
    return (
      <Sheet
        wide
        title="Endpoint added"
        sub={endpoint.url}
        onClose={finish}
        odId="webhook-created-sheet"
        foot={
          <button className="btn btn-primary" type="button" data-autofocus="" onClick={finish}>
            <Icon name="check" />
            I’ve stored it
          </button>
        }
      >
        <Secret
          value={secret}
          label="Signing secret, shown once"
          what="secret"
          note={<b>This is the only time you’ll see it.</b>}
        />
        <CodeBlock title=".env" code={`MAILYARD_WEBHOOK_SECRET=${secret}`} />
        <p className="hint">
          Every request carries <span className="mono">webhook-id</span>,{" "}
          <span className="mono">webhook-timestamp</span> and <span className="mono">webhook-signature</span>{" "}
          (Standard Webhooks). Send a test event from the endpoint’s page to check your handler.
        </p>
      </Sheet>
    )
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setTried(true)
    if (urlProblem || eventsProblem || save.isPending) return
    save.mutate()
  }
  const total = events.length
  const groups = groupEvents(events)
  const all = picked.includes("*")
  const plannedEvents = PLANNED_EVENTS.filter((p) => !events.includes(p.event))
  return (
    <Sheet
      wide
      title={hook ? "Edit endpoint" : "Add a webhook endpoint"}
      sub={hook ? hook.url : "The signing secret is shown once, after you add it."}
      onClose={onClose}
      odId="webhook-sheet"
      foot={
        <>
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            type="submit"
            form="webhook-form"
            aria-disabled={save.isPending}
            data-endpoint={
              hook
                ? `PATCH /v1/webhooks/${hook.id} { url, description, events, filter }`
                : "POST /v1/webhooks { url, description, events, filter } (built, HAL-3416, HAL-3464)"
            }
          >
            <Icon name={hook ? "check" : "plus"} />
            {save.isPending ? "Saving…" : hook ? "Save" : "Add endpoint"}
          </button>
        </>
      }
    >
      <form id="webhook-form" className="stack stack-16" onSubmit={submit} noValidate>
        <div className="field">
          <label className="label" htmlFor={urlId}>
            Endpoint URL
          </label>
          <input
            className="input mono"
            id={urlId}
            value={url}
            inputMode="url"
            placeholder="https://api.example.com/hooks/mail"
            aria-invalid={tried && Boolean(urlProblem)}
            aria-describedby={`${urlId}-h`}
            onChange={(e) => setUrl(e.target.value)}
            data-autofocus=""
          />
          <span className="hint" id={`${urlId}-h`}>
            HTTPS only. We POST JSON and expect a 2xx within 10 seconds.
          </span>
          {tried && urlProblem ? <span className="field-error">{urlProblem}</span> : null}
        </div>
        <div className="field">
          <label className="label" htmlFor={descId}>
            Description <span className="opt">· optional</span>
          </label>
          <input
            className="input"
            id={descId}
            value={desc}
            maxLength={200}
            onChange={(e) => setDesc(e.target.value)}
          />
        </div>
        <fieldset className="field tb-fieldset">
          <legend className="label">
            Events <span className="opt">· {all ? "all" : `${picked.length} of ${total}`}, or all</span>
          </legend>
          <div className="pick-grid tb-events">
            <label className={`pick${all ? " is-on" : ""}`}>
              <input
                className="tb-check"
                type="checkbox"
                checked={all}
                onChange={() => setPicked(toggleEvent(picked, "*"))}
              />
              <span className="p-name">
                All events <code className="tag">*</code>
              </span>
              <span className="p-sub">Every type below, and any added later</span>
            </label>
            {groups.map((g) => (
              <EventGroup
                key={g.label}
                label={g.label}
                events={g.events}
                picked={picked}
                all={all}
                onToggle={(e) => setPicked(toggleEvent(picked, e))}
              />
            ))}
            {plannedEvents.length ? (
              <>
                <span className="label tb-group">Planned</span>
                {plannedEvents.map((p) => (
                  <label key={p.event} className="pick is-planned" aria-disabled="true">
                    <input className="tb-check" type="checkbox" disabled />
                    <span className="p-name mono">{p.event}</span>
                    <span className="p-sub">
                      {p.sub} <span className="tag planned-tag">planned · {p.issue}</span>
                    </span>
                  </label>
                ))}
              </>
            ) : null}
          </div>
          {tried && eventsProblem ? <span className="field-error">{eventsProblem}</span> : null}
        </fieldset>
        <FilterEditor value={filter} onChange={setFilter} />
        <span className="hint">
          The list comes from <span className="mono">GET /v1/webhooks → events</span>. Signed with Standard
          Webhooks; the <span className="mono">whsec_</span> secret is shown once, after you add the endpoint.
        </span>
        <p className="skill-hint" data-od-id="skill-hint-webhook">
          <Icon name="zap" className="icon-12" />
          <span>
            Need a new event? Ask your coding agent: the <code className="mono">add-webhook-event</code> skill
            adds one. <span className="sh-where">In your repo, not this app.</span>
          </span>
        </p>
        <Refusal
          error={save.error}
          what={hook ? "The endpoint wasn’t saved." : "The endpoint wasn’t added."}
        />
      </form>
    </Sheet>
  )
}

function EventGroup({
  label,
  events,
  picked,
  all,
  onToggle,
}: {
  label: string
  events: string[]
  picked: string[]
  all: boolean
  onToggle: (e: string) => void
}) {
  return (
    <>
      <span className="label tb-group">{label}</span>
      {events.map((e) => {
        const on = all || picked.includes(e)
        return (
          <label key={e} className={`pick${on ? " is-on" : ""}`}>
            <input className="tb-check" type="checkbox" checked={on} onChange={() => onToggle(e)} />
            <span className="p-name mono">{e}</span>
          </label>
        )
      })}
    </>
  )
}

/** "Only send events for" (HAL-3464): mailboxes, streams, campaigns and topics. Empty rows mean every one. */
export function FilterEditor({ value, onChange }: { value: Filter; onChange: (f: Filter) => void }) {
  const mailboxes = useQuery({
    queryKey: ["mailboxes", "list"],
    queryFn: () => unwrap(api.GET("/v1/mailboxes")),
  })
  const topics = useQuery({ queryKey: ["topics", "list"], queryFn: () => unwrap(api.GET("/v1/topics")) })
  const campaigns = useQuery({
    queryKey: ["campaigns", "list", "all"],
    queryFn: () => unwrap(api.GET("/v1/campaigns")),
  })
  const toggle = <K extends keyof Filter>(k: K, v: Filter[K][number]) => {
    const list = value[k] as string[]
    onChange({ ...value, [k]: list.includes(v) ? list.filter((x) => x !== v) : [...list, v] })
  }
  const label = (k: "mailboxIds" | "campaignIds" | "topicIds", id: string) =>
    k === "mailboxIds"
      ? (mailboxes.data?.mailboxes.find((m) => m.id === id)?.address ?? id)
      : k === "campaignIds"
        ? (campaigns.data?.campaigns.find((c) => c.id === id)?.name ?? id)
        : (topics.data?.topics.find((t) => t.id === id)?.name ?? id)
  const picker = (
    k: "mailboxIds" | "campaignIds" | "topicIds",
    title: string,
    options: { id: string; label: string }[],
  ) => (
    <div className="field">
      <span className="label">{title}</span>
      <div className="cluster">
        {value[k].map((id) => (
          <span key={id} className="chip">
            {label(k, id)}
            <button type="button" aria-label={`Remove ${label(k, id)}`} onClick={() => toggle(k, id)}>
              <Icon name="x" className="icon-12" />
            </button>
          </span>
        ))}
        <select
          className="select tb-auto"
          aria-label={`Add ${title.toLowerCase().replace(/s$/, "")}`}
          value=""
          onChange={(e) => e.target.value && toggle(k, e.target.value)}
        >
          <option value="">
            {value[k].length ? "Add another" : `Any ${title.toLowerCase().replace(/s$/, "")}`}
          </option>
          {options
            .filter((o) => !value[k].includes(o.id))
            .map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
        </select>
      </div>
    </div>
  )
  return (
    <fieldset className="field wh-filters tb-fieldset" data-od-id="webhook-filters">
      <legend className="label">
        Only send events for <BuiltPill issue="HAL-3464" />
      </legend>
      <p className="hint" style={{ margin: "0 0 8px" }}>
        Leave a row empty to get every one. Events that don’t match are never queued for this endpoint.
      </p>
      <div className="wh-filter-grid">
        {picker(
          "mailboxIds",
          "Mailboxes",
          (mailboxes.data?.mailboxes ?? []).map((m) => ({ id: m.id, label: m.address })),
        )}
        <div className="field">
          <span className="label">Streams</span>
          {/* biome-ignore lint/a11y/useSemanticElements: the design's segmented control */}
          <div className="seg seg-grace" role="group" aria-label="Streams">
            {FILTER_STREAMS.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={value.streams.includes(s)}
                onClick={() => toggle("streams", s)}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        {picker(
          "campaignIds",
          "Campaigns",
          (campaigns.data?.campaigns ?? []).map((c) => ({ id: c.id, label: c.name })),
        )}
        {picker(
          "topicIds",
          "Topics",
          (topics.data?.topics ?? []).filter((t) => !t.archived).map((t) => ({ id: t.id, label: t.name })),
        )}
      </div>
    </fieldset>
  )
}

// ── Rotate the signing secret ─────────────────────────────────────────────────────────────────────────────

export function RotateSecretSheet({ hook, onClose }: { hook: Hook; onClose: () => void }) {
  const qc = useQueryClient()
  const rotate = useMutation({
    mutationFn: () =>
      unwrap(api.POST("/v1/webhooks/{id}/rotate-secret", { params: { path: { id: hook.id } } })),
    onSuccess: () => invalidate(qc, hook.id),
  })
  const done = rotate.data
  return (
    <Sheet
      title={done ? "Secret rotated" : "Rotate the signing secret?"}
      sub="The old secret stops verifying as soon as you rotate."
      onClose={onClose}
      odId="rotate-sheet"
      endpoint={`POST /v1/webhooks/${hook.id}/rotate-secret`}
      foot={
        done ? (
          <button className="btn btn-primary" type="button" onClick={onClose} data-autofocus="">
            <Icon name="check" />
            I’ve deployed it
          </button>
        ) : (
          <>
            <button className="btn btn-secondary" type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              type="button"
              aria-disabled={rotate.isPending}
              onClick={() => !rotate.isPending && rotate.mutate()}
            >
              <Icon name="refresh" />
              {rotate.isPending ? "Rotating…" : "Rotate secret"}
            </button>
          </>
        )
      }
    >
      <ul className="consequences">
        <li>
          <Icon name="x-circle" />
          <span>
            Deliveries signed with the old secret will fail your check until you deploy the new one.
          </span>
        </li>
        <li className="ok">
          <Icon name="check-circle" />
          <span>
            Deliveries are signed when they’re sent, so retries already queued use the new secret. Standard
            Webhooks receivers can accept two secrets while you switch.
          </span>
        </li>
      </ul>
      {done ? (
        <Secret
          value={done.secret}
          label="New secret, shown once"
          what="secret"
          note="This is the only time you’ll see it."
        />
      ) : null}
      <Refusal error={rotate.error} what="The secret wasn’t rotated." />
    </Sheet>
  )
}

// ── Send a test event ─────────────────────────────────────────────────────────────────────────────────────

/**
 * A realistic sample of one event type (`POST …/test { event }`, marked `sample: true`), sent even while the
 * endpoint is paused. The result links to its delivery.
 */
export function TestSheet({
  hook,
  events,
  onClose,
  onOpenDelivery,
}: {
  hook: Hook
  events: readonly string[]
  onClose: () => void
  onOpenDelivery: (id: string) => void
}) {
  const qc = useQueryClient()
  const evtId = useId()
  const choices = testableEvents(hook.events, events)
  const [event, setEvent] = useState(choices[0] ?? "")
  const test = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/webhooks/{id}/test", {
          params: { path: { id: hook.id } },
          body: event ? { event: event as WebhookEvent } : null,
        }),
      ),
    onSuccess: () => invalidate(qc, hook.id),
  })
  const r = test.data
  const sample = JSON.stringify(
    {
      id: "evt_…",
      type: event || "webhook.test",
      createdAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      sample: true,
      data: sampleData(event),
    },
    null,
    2,
  )
  return (
    <Sheet
      wide
      title={r ? "Test event sent" : "Send a test event"}
      sub={`To ${hook.url}`}
      onClose={onClose}
      odId="test-sheet"
      endpoint={`POST /v1/webhooks/${hook.id}/test { event } (built, HAL-3464)`}
      foot={
        r ? (
          <>
            <button className="btn btn-secondary" type="button" onClick={() => test.reset()}>
              Send another
            </button>
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => onOpenDelivery(r.deliveryId)}
              data-autofocus=""
            >
              Open the delivery
              <Icon name="chevron-right" />
            </button>
          </>
        ) : (
          <>
            <button className="btn btn-secondary" type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              type="button"
              aria-disabled={test.isPending}
              onClick={() => !test.isPending && test.mutate()}
            >
              <Icon name="send" />
              {test.isPending ? "Sending…" : "Send test"}
            </button>
          </>
        )
      }
    >
      {r ? (
        <div className="stack stack-12" role="status">
          <div className="callout callout-ok">
            <Icon name="check-circle" />
            <span>
              <b>Queued a sample {r.eventType}.</b> It’s delivery <span className="mono">{r.deliveryId}</span>{" "}
              (event <span className="mono">{r.eventId}</span>), signed like any other, and its result appears
              under Deliveries in a moment.
            </span>
          </div>
          {hook.paused ? (
            <p className="hint">
              The endpoint is paused; tests still go out, so you can check the handler before you resume.
            </p>
          ) : null}
        </div>
      ) : (
        <>
          <div className="field">
            <label className="label" htmlFor={evtId}>
              Event
            </label>
            <select
              className="select mono"
              id={evtId}
              value={event}
              onChange={(e) => setEvent(e.target.value)}
              data-autofocus=""
            >
              {choices.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <span className="hint">
              {hook.events.includes("*")
                ? "This endpoint takes every event, so any type can be tested. "
                : "The endpoint’s own events. "}
              You get the event’s real shape with sample values, marked{" "}
              <span className="mono">"sample": true</span>.
            </span>
          </div>
          <CodeBlock title={`${event || "webhook.test"} · shape`} code={sample} wrap />
          <p className="hint">
            Signed with the endpoint’s secret like any delivery
            {hook.paused ? ", and sent even while delivery is paused" : ""}. It doesn’t count toward dead
            letters.
          </p>
          <Refusal error={test.error} what="The test event wasn’t sent." />
        </>
      )}
    </Sheet>
  )
}

/** An illustration of the data block for the picked event; the API fills in the real sample. */
function sampleData(event: string): Record<string, unknown> {
  if (event.startsWith("message.") || event.startsWith("email."))
    return { messageId: "msg_sample", recipient: "sample@example.com", stream: "transactional" }
  if (event.startsWith("contact.")) return { contactId: "con_sample", email: "sample@example.com" }
  if (event.startsWith("mail."))
    return { mailboxId: "mbx_sample", threadId: "thr_sample", from: "sample@example.com" }
  if (event.startsWith("campaign.")) return { campaignId: "cmp_sample" }
  if (event.startsWith("approval."))
    return { approvalId: "apr_sample", agentId: "agt_sample", to: ["sample@example.com"] }
  if (event === "event.tracked") return { event: "signed_up", email: "sample@example.com" }
  return {}
}

// ── Replay every dead letter ──────────────────────────────────────────────────────────────────────────────

/**
 * Calls `POST …/deliveries/replay { status: "dead" }` while `remaining > 0` (HANDOFF-ops §22). A small backlog
 * is one call and a toast; a big one shows each call. Closing keeps it going until the tab closes; "Stop
 * after this call" ends it.
 */
export function ReplaySheet({ hook, onClose }: { hook: Hook; onClose: () => void }) {
  const qc = useQueryClient()
  const start = num(hook.deadLetters) ?? 0
  const [steps, setSteps] = useState<ReplayStep[]>([])
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ replayed: number; remaining: number; stopped: boolean } | null>(null)
  const [error, setError] = useState<unknown>(null)
  const stop = useRef(false)
  const started = useRef(false)

  const run = async () => {
    if (started.current) return
    started.current = true
    setRunning(true)
    try {
      const r = await replayAll(
        () =>
          unwrap(
            api.POST("/v1/webhooks/{id}/deliveries/replay", {
              params: { path: { id: hook.id } },
              body: { status: "dead" },
            }),
          ),
        (s) => setSteps((prev) => [...prev, s]),
        () => stop.current,
      )
      setResult(r)
      await invalidate(qc, hook.id)
      if (r.calls === 1 && !r.stopped) {
        toast({
          title: `Replayed ${fmtInt(r.replayed)}, ${fmtInt(r.remaining)} remaining`,
          sub: "One call to POST …/deliveries/replay; the deliveries are queued and their results appear in the list",
        })
        onClose()
      }
    } catch (e) {
      setError(e)
      await invalidate(qc, hook.id)
    } finally {
      setRunning(false)
    }
  }

  // Small backlogs replay straight away: one call and a toast, no sheet to read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once, when the sheet opens on a small backlog
  useEffect(() => {
    if (start > 0 && start <= REPLAY_PAGE) void run()
  }, [])

  const replayed = steps.reduce((n, s) => n + s.replayed, 0)
  const remaining = steps.at(-1)?.remaining ?? start
  const total = Math.max(start, replayed + remaining)
  return (
    <Sheet
      title={
        result ? "Dead letters replayed" : running ? "Replaying dead letters" : "Replay every dead letter?"
      }
      sub={`${fmtInt(start)} dead letters for ${host(hook.url)}`}
      onClose={onClose}
      odId="replay-sheet"
      endpoint={`POST /v1/webhooks/${hook.id}/deliveries/replay { status: dead } (loops while remaining > 0)`}
      foot={
        result || error ? (
          <button className="btn btn-primary" type="button" onClick={onClose} data-autofocus="">
            Done
          </button>
        ) : running ? (
          <>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => {
                stop.current = true
              }}
            >
              Stop after this call
            </button>
            <button className="btn btn-primary" type="button" aria-disabled="true">
              <Icon name="replay" />
              Replaying…
            </button>
          </>
        ) : (
          <>
            <button className="btn btn-secondary" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" type="button" onClick={() => void run()} data-autofocus="">
              <Icon name="replay" />
              Replay all {fmtInt(start)}
            </button>
          </>
        )
      }
    >
      <div className="stack stack-12" role="status" aria-live="polite">
        {steps.length || running ? (
          <>
            <p>
              <b>
                Replayed {fmtInt(replayed)}, {fmtInt(remaining)} remaining.
              </b>
            </p>
            <div
              className="progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={replayed}
              aria-label="Dead letters replayed"
            >
              <span style={{ width: `${total ? ((replayed / total) * 100).toFixed(1) : 0}%` }} />
            </div>
            <ol className="replay-calls">
              {steps.map((s) => (
                <li key={s.call}>
                  <span className="mono">Call {s.call}</span> replayed <b>{fmtInt(s.replayed)}</b>,{" "}
                  <b>{fmtInt(s.remaining)}</b> remaining
                </li>
              ))}
              {running ? (
                <li className="is-now">
                  <span className="mono">Call {steps.length + 1}</span> replaying up to {REPLAY_PAGE}…
                </li>
              ) : null}
            </ol>
          </>
        ) : (
          <p>
            Each delivery is sent again from attempt one, oldest first, with a fresh signature. Results appear
            in the list as they land.
          </p>
        )}
        {result?.stopped ? (
          <div className="callout callout-warn">
            <Icon name="pause" />
            <span>
              <b>Stopped.</b> {fmtInt(result.remaining)} are still dead letters; replay them any time.
            </span>
          </div>
        ) : null}
        <p className="hint">
          Each call replays at most {REPLAY_PAGE}, oldest first. The app keeps calling while{" "}
          <span className="mono">remaining</span> is above 0; you can close this and it carries on until the
          tab closes. Already replayed deliveries stay replayed if you stop.
        </p>
        <Refusal error={error} what="The replay stopped." />
      </div>
    </Sheet>
  )
}

// ── Delete an endpoint ────────────────────────────────────────────────────────────────────────────────────

export function RemoveEndpointSheet({
  hook,
  onClose,
  onRemoved,
}: {
  hook: Hook
  onClose: () => void
  onRemoved: () => void
}) {
  const qc = useQueryClient()
  const [v, setV] = useState("")
  const match = host(hook.url)
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE("/v1/webhooks/{id}", { params: { path: { id: hook.id } } })),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["webhooks"] })
      toast({ title: `Deleted ${match}`, sub: "No more events go to it; its dead letters are gone too." })
      onRemoved()
    },
  })
  const ok = v.trim() === match && !remove.isPending
  return (
    <Sheet
      title="Delete this endpoint?"
      sub="Events stop going to it at once. This can’t be undone."
      onClose={onClose}
      odId="remove-webhook-sheet"
      foot={
        <>
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-danger"
            type="button"
            aria-disabled={!ok}
            onClick={() => ok && remove.mutate()}
            data-endpoint={`DELETE /v1/webhooks/${hook.id}`}
          >
            {remove.isPending ? "Deleting…" : "Delete endpoint"}
          </button>
        </>
      }
    >
      <ul className="consequences">
        <li>
          <Icon name="x-circle" />
          <span>
            Queued and dead deliveries for <span className="mono">{hook.url}</span> are dropped.
          </span>
        </li>
        <li className="ok">
          <Icon name="check-circle" />
          <span>To stop for a while instead, Disable it: you can turn it back on.</span>
        </li>
      </ul>
      <ConfirmInput match={match} verb="delete it" value={v} onChange={setV} />
      <Refusal error={remove.error} what="The endpoint wasn’t deleted." />
    </Sheet>
  )
}
