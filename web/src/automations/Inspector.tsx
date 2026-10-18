/**
 * The node inspector (design: automation-builder.html, -send-step, -send-step-date, -redacted; HANDOFF §4
 * "Inspector", "Send step", "Redacted"). One form per node type, editing the draft graph in place; the builder
 * saves it with PATCH. A key without admin (`redacted: true`) sees every field read-only and every admin-only
 * action as a reason button; secrets show as `scheme://host/•••` with a "Hidden for your key" lock.
 */
import { useMutation, useQuery } from "@tanstack/react-query"
import { type ReactNode, useId, useRef, useState } from "react"
import { api, unwrap } from "../api/client.ts"
import {
  allTopicsQuery,
  fieldsQuery,
  identitiesQuery,
  segmentsQuery,
  templatesQuery,
} from "../audience/kit/queries.ts"
import { ApiErrorCallout, CopyButton, Planned } from "../audience/kit/ui.tsx"
import { useCapabilities } from "../auth/capabilities.ts"
import { Gated } from "../auth/NoPermission.tsx"
import { fmtInt } from "../lib/format.ts"
import { Icon } from "../ui/icons.tsx"
import { NODE_ICON } from "./Canvas.tsx"
import {
  classifyPlaceholders,
  describeNode,
  describeRule,
  type GNode,
  hh,
  type Issue,
  insertAt,
  type Names,
  PORT_LABEL,
  type Port,
  parseDomains,
  portsOf,
  type SegmentRule,
  TRIGGER_DATA_KEYS,
  TRIGGER_KEY_HINT,
  TRIGGER_KIND_LABEL,
  type Trigger,
  type TriggerKind,
  triggerKeyExample,
  WEEKDAYS,
} from "./logic.ts"
import { templateQuery } from "./queries.ts"

type Ctx = {
  automationId: string
  names: Names
  editable: boolean
  /** Why it isn't editable, for the reason buttons. */
  reason: string
  who: string
  redacted: boolean
  trigger: Trigger | null
  issues: Issue[]
  onChange: (n: GNode) => void
  onDelete: (id: string) => void
  onAddOn: (from: string, port: Port | undefined) => void
  onClose: () => void
  /** "New in v5" and similar notes, worked out by the builder. */
  note?: ReactNode
}

export function NodeInspector({ node, ctx }: { node: GNode; ctx: Ctx }) {
  const d = describeNode(node, ctx.names)
  return (
    <aside
      className="inspector"
      aria-labelledby="ins-title"
      data-od-id={node.type === "send" ? "send-inspector" : "node-inspector"}
      data-endpoint={`${ctx.editable ? "PATCH" : "GET"} /v1/automations/${ctx.automationId} {graph}`}
    >
      <div className="ins-head">
        <span className="node-ic">
          <Icon name={NODE_ICON[node.type]} />
        </span>
        <div className="grow">
          <span className="node-kind">{d.kind}</span>
          <h2 className="t-h3" id="ins-title" data-ins-title>
            {d.title}
          </h2>
          <span className="kind mono">{node.id}</span>
        </div>
        <button
          className="icon-btn ins-close"
          type="button"
          onClick={ctx.onClose}
          aria-label="Close inspector"
        >
          <Icon name="x" />
        </button>
      </div>
      <div className="ins-body">
        {ctx.issues.map((i) => (
          <div
            key={`${i.code}${i.message}`}
            className="callout callout-error"
            role="alert"
            data-od-id="send-issue"
          >
            <Icon name="x-circle" />
            <span>
              <b className="mono">{i.code}</b> {i.message}
            </span>
          </div>
        ))}
        {node.type !== "exit" ? <LabelField node={node} ctx={ctx} /> : null}
        <Body node={node} ctx={ctx} />
        {portsOf(node.type).length === 2 && ctx.editable ? (
          <div className="cluster cluster-8">
            {(portsOf(node.type) as Port[]).map((p) => (
              <button
                key={p}
                className="btn btn-secondary btn-sm"
                type="button"
                onClick={() => ctx.onAddOn(node.id, p)}
              >
                <Icon name="plus" />
                Add a step on “{PORT_LABEL[p]}”
              </button>
            ))}
          </div>
        ) : null}
        {ctx.note}
      </div>
      {node.type !== "trigger" ? (
        <div className="ins-foot">
          <Gated allowed={ctx.editable} reason={ctx.reason} who={ctx.who} side="up">
            <button
              className="btn btn-danger-ghost btn-sm"
              type="button"
              data-od-id="delete-step"
              onClick={() => ctx.onDelete(node.id)}
            >
              <Icon name="trash" />
              Delete step
            </button>
          </Gated>
          {portsOf(node.type).length === 2 ? (
            <span className="hint">
              Deleting joins what came before to the “{PORT_LABEL[portsOf(node.type)[0] as Port]}” path.
            </span>
          ) : null}
        </div>
      ) : null}
    </aside>
  )
}

function unlabelled(node: GNode): GNode {
  const { label: _l, ...rest } = node
  return rest as GNode
}

function LabelField({ node, ctx }: { node: GNode; ctx: Ctx }) {
  const id = useId()
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        Name on the canvas <span className="opt">optional</span>
      </label>
      <input
        className="input"
        id={id}
        value={node.label ?? ""}
        placeholder={describeNode(unlabelled(node), ctx.names).title}
        readOnly={!ctx.editable}
        maxLength={80}
        onChange={(e) => {
          const v = e.target.value
          const { label: _drop, ...rest } = node
          ctx.onChange((v ? { ...rest, label: v } : rest) as GNode)
        }}
      />
    </div>
  )
}

function Body({ node, ctx }: { node: GNode; ctx: Ctx }) {
  switch (node.type) {
    case "trigger":
      return <TriggerForm node={node} ctx={ctx} />
    case "wait":
      return (
        <DurationField
          label="Wait for"
          value={node.config.duration}
          ctx={ctx}
          onChange={(duration) => ctx.onChange({ ...node, config: { duration } })}
          hint="Then the run goes on to the next step."
        />
      )
    case "wait_until":
      return <WaitUntilForm node={node} ctx={ctx} />
    case "wait_event":
      return (
        <>
          <TextField
            label="Event"
            mono
            value={node.config.event}
            ctx={ctx}
            pattern={/^[A-Za-z0-9_.:-]{1,100}$/}
            bad="Letters, digits and _ . : - only, up to 100."
            onChange={(event) => ctx.onChange({ ...node, config: { ...node.config, event } })}
            hint="Continues the moment your app tracks it for this contact (POST /v1/track)."
          />
          <DurationField
            label="Give up after"
            value={node.config.timeout}
            ctx={ctx}
            onChange={(timeout) => ctx.onChange({ ...node, config: { ...node.config, timeout } })}
            hint="“It happened” and “Timed out” each lead their own way."
          />
        </>
      )
    case "branch":
      return <BranchForm node={node} ctx={ctx} />
    case "send":
      return <SendForm node={node} ctx={ctx} />
    case "update":
      return <UpdateForm node={node} ctx={ctx} />
    case "topic":
      return <TopicForm node={node} ctx={ctx} />
    case "webhook":
      return <WebhookForm node={node} ctx={ctx} />
    case "exit":
      return (
        <p className="hint">
          The run ends here and the contact can enter again only as the automation’s re-entry setting allows.
        </p>
      )
  }
}

// ---------------------------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------------------------

function TextField({
  label,
  value,
  onChange,
  ctx,
  hint,
  mono,
  pattern,
  bad,
  opt,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  ctx: Ctx
  hint?: ReactNode
  mono?: boolean
  pattern?: RegExp
  bad?: string
  opt?: string
}) {
  const id = useId()
  const invalid = Boolean(pattern && value && !pattern.test(value))
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label} {opt ? <span className="opt">{opt}</span> : null}
      </label>
      <input
        className={`input${mono ? " mono" : ""}`}
        id={id}
        value={value}
        readOnly={!ctx.editable}
        onChange={(e) => onChange(e.target.value)}
        {...(invalid
          ? { "aria-invalid": true, "aria-describedby": `${id}-e` }
          : hint
            ? { "aria-describedby": `${id}-h` }
            : {})}
      />
      {invalid ? (
        <p className="field-error" id={`${id}-e`}>
          <Icon name="x-circle" />
          <span>{bad}</span>
        </p>
      ) : null}
      {hint ? (
        <span className="hint" id={`${id}-h`}>
          {hint}
        </span>
      ) : null}
    </div>
  )
}

const UNITS = ["minutes", "hours", "days", "weeks"] as const
type Duration = { amount: number; unit: (typeof UNITS)[number] }

function DurationField({
  label,
  value,
  onChange,
  ctx,
  hint,
}: {
  label: string
  value: Duration
  onChange: (d: Duration) => void
  ctx: Ctx
  hint?: string
}) {
  const id = useId()
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <div className="fgrid">
        <input
          className="input input-num"
          id={id}
          type="number"
          min={1}
          max={100000}
          value={value.amount}
          readOnly={!ctx.editable}
          onChange={(e) =>
            onChange({ ...value, amount: Math.max(1, Math.round(Number(e.target.value) || 1)) })
          }
        />
        <select
          className="select"
          aria-label={`${label}: unit`}
          value={value.unit}
          disabled={!ctx.editable}
          onChange={(e) => onChange({ ...value, unit: e.target.value as Duration["unit"] })}
        >
          {UNITS.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
      </div>
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  )
}

const HOURS = Array.from({ length: 24 }, (_, h) => h)

function HourSelect({
  value,
  onChange,
  ctx,
  label = "At",
}: {
  value: number
  onChange: (h: number) => void
  ctx: Ctx
  label?: string
}) {
  const id = useId()
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <select
        className="select"
        id={id}
        value={value}
        disabled={!ctx.editable}
        onChange={(e) => onChange(Number(e.target.value))}
      >
        {HOURS.map((h) => (
          <option key={h} value={h}>
            {hh(h)}
          </option>
        ))}
      </select>
    </div>
  )
}

function DateFieldSelect({
  value,
  onChange,
  ctx,
}: {
  value: string
  onChange: (f: string) => void
  ctx: Ctx
}) {
  const id = useId()
  const fields = useQuery(fieldsQuery).data ?? []
  const dates = fields.filter((f) => f.type === "date")
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        Date field
      </label>
      <input
        className="input mono"
        id={id}
        list={`${id}-l`}
        value={value}
        readOnly={!ctx.editable}
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id={`${id}-l`}>
        {dates.map((f) => (
          <option key={f.key} value={f.key}>
            {f.label}
          </option>
        ))}
      </datalist>
      <span className="hint">
        A contact field holding a date{dates.length ? `: ${dates.map((f) => f.key).join(", ")}` : ""}.
        Contacts with no value never enter.
      </span>
    </div>
  )
}

function OffsetField({ value, onChange, ctx }: { value: number; onChange: (n: number) => void; ctx: Ctx }) {
  const id = useId()
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        Days before (−) or after (+)
      </label>
      <input
        className="input input-num"
        id={id}
        type="number"
        min={-365}
        max={365}
        value={value}
        readOnly={!ctx.editable}
        onChange={(e) => onChange(Math.max(-365, Math.min(365, Math.round(Number(e.target.value) || 0))))}
      />
    </div>
  )
}

/** A rule tree edited as JSON, with the sentence it reads as; the API checks it on save. */
function RuleField({
  label,
  rule,
  onChange,
  ctx,
  optional,
}: {
  label: string
  rule: SegmentRule | undefined
  onChange: (r: SegmentRule | undefined) => void
  ctx: Ctx
  optional?: boolean
}) {
  const id = useId()
  const [text, setText] = useState(() => (rule ? JSON.stringify(rule, null, 1) : ""))
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label} {optional ? <span className="opt">optional</span> : null}
      </label>
      {rule ? (
        <p className="t-small" style={{ margin: 0 }}>
          <b>Reads as:</b> {describeRule(rule, ctx.names)}
        </p>
      ) : null}
      <textarea
        className="textarea mono"
        id={id}
        rows={5}
        style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
        value={text}
        readOnly={!ctx.editable}
        placeholder='{"type": "all", "rules": [{"type": "field", "field": "plan", "op": "eq", "value": "pro"}]}'
        onChange={(e) => {
          setText(e.target.value)
          if (!e.target.value.trim()) {
            setError(null)
            if (optional) onChange(undefined)
            return
          }
          try {
            const v = JSON.parse(e.target.value) as SegmentRule
            if (!v || typeof v !== "object" || typeof (v as { type?: unknown }).type !== "string")
              throw new Error("A rule needs a type.")
            setError(null)
            onChange(v)
          } catch (err) {
            setError(err instanceof Error ? err.message : "That isn’t JSON.")
          }
        }}
        {...(error ? { "aria-invalid": true, "aria-describedby": `${id}-e` } : {})}
      />
      {error ? (
        <p className="field-error" id={`${id}-e`}>
          <Icon name="x-circle" />
          <span>{error}</span>
        </p>
      ) : null}
      <span className="hint">
        The same rule tree segments use (<span className="mono">all</span>/<span className="mono">any</span>{" "}
        groups of field, status, topic, event, engagement, campaign and created rules). The API checks it when
        you save.
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Per type
// ---------------------------------------------------------------------------------------------

/** The workspace's mailboxes, from the same read (and cache key) the sidebar uses. */
function useMailboxes() {
  const q = useQuery({
    queryKey: ["mailboxes"],
    queryFn: () => unwrap(api.GET("/v1/mailboxes")),
  })
  const list = (q.data as { mailboxes?: { id: string; address: string; kind?: string }[] } | undefined)
    ?.mailboxes
  return Array.isArray(list) ? list : []
}

const TRIGGER_KINDS: TriggerKind[] = ["event", "created", "segment", "topic", "date", "mail_received"]

function TriggerForm({ node, ctx }: { node: Extract<GNode, { type: "trigger" }>; ctx: Ctx }) {
  const id = useId()
  const t = node.config
  const segments = useQuery(segmentsQuery).data ?? []
  const topics = (useQuery(allTopicsQuery).data ?? []).filter((x) => !x.archived)
  const set = (config: Trigger) => ctx.onChange({ ...node, config })
  const change = (kind: TriggerKind | string) => {
    if (kind === t.kind) return
    if (kind === "mail_received") set({ kind })
    else if (kind === "event") set({ kind, event: "signed_up" })
    else if (kind === "created") set({ kind })
    else if (kind === "segment") set({ kind, segmentId: segments[0]?.id ?? "" })
    else if (kind === "topic") set({ kind, topicId: topics[0]?.id ?? "" })
    else if (kind === "date") set({ kind, field: "signed_up_at", offsetDays: 0, hour: 9, repeat: "yearly" })
  }
  return (
    <>
      <div className="field">
        <label className="label" htmlFor={id}>
          Starts when
        </label>
        <select
          className="select"
          id={id}
          value={t.kind}
          disabled={!ctx.editable}
          onChange={(e) => change(e.target.value)}
        >
          {TRIGGER_KINDS.map((k) => (
            <option key={k} value={k}>
              {k === "event"
                ? "An event is tracked"
                : k === "created"
                  ? "A contact is created"
                  : k === "segment"
                    ? "A contact enters a segment"
                    : k === "topic"
                      ? "A contact subscribes to a topic"
                      : k === "date"
                        ? "A date in a contact field"
                        : "Mail arrives in a mailbox"}
            </option>
          ))}
        </select>
      </div>
      {t.kind === "mail_received" ? <MailTriggerForm t={t} ctx={ctx} onChange={set} /> : null}
      {t.kind === "event" ? (
        <>
          <TextField
            label="Event name"
            mono
            value={t.event}
            ctx={ctx}
            pattern={/^[A-Za-z0-9_.:-]{1,100}$/}
            bad="Letters, digits and _ . : - only, up to 100."
            onChange={(event) => set({ ...t, event })}
            hint={
              <>
                Your app sends it with <span className="mono">POST /v1/track</span>. Its data is the run’s{" "}
                <span className="mono">trigger.*</span>.
              </>
            }
          />
          <RuleField
            label="Only contacts who match"
            optional
            rule={t.filter}
            ctx={ctx}
            onChange={(filter) => {
              const { filter: _f, ...rest } = t
              set(filter ? { ...rest, filter } : rest)
            }}
          />
        </>
      ) : null}
      {t.kind === "segment" ? (
        <SelectField
          label="Segment"
          value={t.segmentId}
          options={segments.map((s) => [s.id, s.name])}
          ctx={ctx}
          onChange={(segmentId) => set({ ...t, segmentId })}
          hint="Checked when a contact changes, and nightly."
        />
      ) : null}
      {t.kind === "topic" ? (
        <SelectField
          label="Topic"
          value={t.topicId}
          options={topics.map((x) => [x.id, x.name])}
          ctx={ctx}
          onChange={(topicId) => set({ ...t, topicId })}
        />
      ) : null}
      {t.kind === "date" ? (
        <>
          <DateFieldSelect value={t.field} ctx={ctx} onChange={(field) => set({ ...t, field })} />
          <div className="fgrid">
            <OffsetField
              value={t.offsetDays}
              ctx={ctx}
              onChange={(offsetDays) => set({ ...t, offsetDays })}
            />
            <HourSelect value={t.hour} ctx={ctx} onChange={(hour) => set({ ...t, hour })} />
          </div>
          <SelectField
            label="Repeat"
            value={t.repeat}
            options={[
              ["yearly", "Every year"],
              ["once", "Once"],
            ]}
            ctx={ctx}
            onChange={(repeat) => set({ ...t, repeat: repeat as "yearly" | "once" })}
          />
        </>
      ) : null}
      <TriggerKeys trigger={t} ctx={ctx} />
    </>
  )
}

/**
 * A mail_received trigger (HAL-3467): which mailboxes, which sender domains (a subdomain matches too) and words
 * in the subject, each optional. The sender becomes the contact, added unconfirmed if new and never subscribed;
 * automated mail (auto-replies, bulk, lists), spam and the mailbox writing to itself never start a run.
 */
function MailTriggerForm({
  t,
  ctx,
  onChange,
}: {
  t: Extract<Trigger, { kind: "mail_received" }>
  ctx: Ctx
  onChange: (t: Trigger) => void
}) {
  const id = useId()
  const mailboxes = useMailboxes().filter((m) => m.kind !== "alias")
  const chosen = t.mailboxIds ?? []
  const [domainText, setDomainText] = useState((t.senderDomains ?? []).join(", "))
  const parsed = parseDomains(domainText)
  const subjectBad = t.subjectContains !== undefined && t.subjectContains.length > 200
  const write = (patch: Partial<Extract<Trigger, { kind: "mail_received" }>>) => {
    const next = { ...t, ...patch }
    const out: Extract<Trigger, { kind: "mail_received" }> = { kind: "mail_received" }
    if (next.mailboxIds?.length) out.mailboxIds = next.mailboxIds
    if (next.senderDomains?.length) out.senderDomains = next.senderDomains
    if (next.subjectContains) out.subjectContains = next.subjectContains
    onChange(out)
  }
  return (
    <>
      <fieldset className="stack stack-8" style={{ border: 0, margin: 0, padding: 0 }}>
        <legend className="label">
          Mailboxes <span className="opt">optional · none ticked means any mailbox</span>
        </legend>
        {mailboxes.length ? (
          mailboxes.map((m) => (
            <label key={m.id} className="check">
              <input
                type="checkbox"
                checked={chosen.includes(m.id)}
                disabled={!ctx.editable}
                onChange={(e) =>
                  write({
                    mailboxIds: e.target.checked ? [...chosen, m.id] : chosen.filter((x) => x !== m.id),
                  })
                }
              />
              <span className="mono">{m.address}</span>
            </label>
          ))
        ) : (
          <span className="hint">No mailboxes yet; the trigger listens to every mailbox you add.</span>
        )}
      </fieldset>
      <div className="field">
        <label className="label" htmlFor={`${id}-d`}>
          Sender domains <span className="opt">optional · comma separated, up to 50</span>
        </label>
        <input
          className="input mono"
          id={`${id}-d`}
          value={domainText}
          readOnly={!ctx.editable}
          placeholder="stripe.com, coursified.app"
          onChange={(e) => {
            setDomainText(e.target.value)
            const p = parseDomains(e.target.value)
            if (!p.error) write({ senderDomains: p.domains })
          }}
          {...(parsed.error ? { "aria-invalid": true, "aria-describedby": `${id}-de` } : {})}
        />
        {parsed.error ? (
          <p className="field-error" id={`${id}-de`}>
            <Icon name="x-circle" />
            <span>{parsed.error}</span>
          </p>
        ) : (
          <span className="hint">
            A subdomain matches too: stripe.com also takes mail from billing.stripe.com.
          </span>
        )}
      </div>
      <div className="field">
        <label className="label" htmlFor={`${id}-s`}>
          Subject contains <span className="opt">optional · not case sensitive</span>
        </label>
        <input
          className="input"
          id={`${id}-s`}
          value={t.subjectContains ?? ""}
          readOnly={!ctx.editable}
          maxLength={200}
          placeholder="invoice"
          onChange={(e) => write({ subjectContains: e.target.value })}
          {...(subjectBad ? { "aria-invalid": true } : {})}
        />
      </div>
      <div className="callout callout-info">
        <Icon name="info" />
        <span>
          The sender becomes the contact: added as unconfirmed if they’re new, and never subscribed to
          anything. Auto-replies, bulk and list mail, spam and the mailbox writing to itself never start a
          run. Mail only creates contacts while a live automation listens.
        </span>
      </div>
    </>
  )
}

function SelectField({
  label,
  value,
  options,
  onChange,
  ctx,
  hint,
  mono,
}: {
  label: string
  value: string
  options: [string, string][]
  onChange: (v: string) => void
  ctx: Ctx
  hint?: ReactNode
  mono?: boolean
}) {
  const id = useId()
  const known = options.some(([v]) => v === value)
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <select
        className={`select${mono ? " mono" : ""}`}
        id={id}
        value={value}
        disabled={!ctx.editable}
        onChange={(e) => onChange(e.target.value)}
      >
        {!known ? <option value={value}>{value || "Choose…"}</option> : null}
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  )
}

function WaitUntilForm({ node, ctx }: { node: Extract<GNode, { type: "wait_until" }>; ctx: Ctx }) {
  const c = node.config
  const set = (config: typeof c) => ctx.onChange({ ...node, config })
  return (
    <>
      <SelectField
        label="Until"
        value={c.kind}
        options={[
          ["weekday", "A day of the week"],
          ["field", "A date in a contact field"],
        ]}
        ctx={ctx}
        onChange={(k) =>
          k === c.kind
            ? undefined
            : set(
                k === "weekday"
                  ? { kind: "weekday", weekday: 1, hour: 9 }
                  : { kind: "field", field: "signed_up_at", offsetDays: 0, hour: 9 },
              )
        }
      />
      {c.kind === "weekday" ? (
        <div className="fgrid">
          <SelectField
            label="Day"
            value={String(c.weekday)}
            options={WEEKDAYS.map((w, i) => [String(i), w])}
            ctx={ctx}
            onChange={(v) => set({ ...c, weekday: Number(v) })}
          />
          <HourSelect value={c.hour} ctx={ctx} onChange={(hour) => set({ ...c, hour })} />
        </div>
      ) : (
        <>
          <DateFieldSelect value={c.field} ctx={ctx} onChange={(field) => set({ ...c, field })} />
          <div className="fgrid">
            <OffsetField
              value={c.offsetDays}
              ctx={ctx}
              onChange={(offsetDays) => set({ ...c, offsetDays })}
            />
            <HourSelect value={c.hour} ctx={ctx} onChange={(hour) => set({ ...c, hour })} />
          </div>
          <p className="hint">If that day has already passed, the run continues at once.</p>
        </>
      )}
    </>
  )
}

function BranchForm({ node, ctx }: { node: Extract<GNode, { type: "branch" }>; ctx: Ctx }) {
  const c = node.config
  const set = (config: typeof c) => ctx.onChange({ ...node, config })
  return (
    <>
      <SelectField
        label="Branch on"
        value={c.kind}
        options={[
          ["event", "Whether they did an event"],
          ["rule", "Whether they match a rule"],
        ]}
        ctx={ctx}
        onChange={(k) =>
          k === c.kind
            ? undefined
            : set(
                k === "event"
                  ? { kind: "event", event: "event_name" }
                  : { kind: "rule", rule: { type: "all", rules: [] } },
              )
        }
      />
      {c.kind === "event" ? (
        <>
          <TextField
            label="Event"
            mono
            value={c.event}
            ctx={ctx}
            pattern={/^[A-Za-z0-9_.:-]{1,100}$/}
            bad="Letters, digits and _ . : - only, up to 100."
            onChange={(event) => set({ ...c, event })}
          />
          <div className="field">
            <label className="label" htmlFor={`${node.id}-within`}>
              Within <span className="opt">days, optional</span>
            </label>
            <input
              className="input input-num"
              id={`${node.id}-within`}
              type="number"
              min={1}
              max={3650}
              value={c.withinDays ?? ""}
              readOnly={!ctx.editable}
              placeholder="Since they entered"
              onChange={(e) => {
                const v = Math.round(Number(e.target.value))
                const { withinDays: _w, ...rest } = c
                set(v >= 1 ? { ...rest, withinDays: Math.min(3650, v) } : rest)
              }}
            />
            <span className="hint">Empty: did it any time since entering this run.</span>
          </div>
        </>
      ) : (
        <RuleField
          label="Yes when they match"
          rule={c.rule}
          ctx={ctx}
          onChange={(rule) => rule && set({ ...c, rule })}
        />
      )}
      <p className="hint">
        A dry run can assume either answer. Branches on whether an automation email was opened aren’t
        supported; branch on an event your app tracks instead.
      </p>
    </>
  )
}

function UpdateForm({ node, ctx }: { node: Extract<GNode, { type: "update" }>; ctx: Ctx }) {
  const id = useId()
  const fields = useQuery(fieldsQuery).data ?? []
  const entries = Object.entries(node.config.fields)
  const set = (list: [string, string | number | boolean | null][]) =>
    ctx.onChange({ ...node, config: { fields: Object.fromEntries(list) } })
  return (
    <div className="field">
      <span className="label">Set these fields</span>
      <ul className="list" style={{ gap: 8, display: "flex", flexDirection: "column" }}>
        {entries.map(([k, v], i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a row keeps its place while its key is being typed
          <li key={i} className="cluster cluster-8" style={{ flexWrap: "nowrap" }}>
            <input
              className="input mono"
              aria-label="Field"
              list={`${id}-f`}
              value={k}
              readOnly={!ctx.editable}
              style={{ flex: "1 1 0", minWidth: 0 }}
              onChange={(e) => set(entries.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))}
            />
            <input
              className="input"
              aria-label={`Value for ${k}`}
              value={v === null ? "" : String(v)}
              placeholder="Empty clears it"
              readOnly={!ctx.editable}
              style={{ flex: "1 1 0", minWidth: 0 }}
              onChange={(e) => {
                const raw = e.target.value
                const typed = fields.find((f) => f.key === k)?.type
                const val: string | number | boolean | null =
                  raw === ""
                    ? null
                    : typed === "number" && Number.isFinite(Number(raw))
                      ? Number(raw)
                      : typed === "boolean" && /^(true|false)$/i.test(raw)
                        ? raw.toLowerCase() === "true"
                        : raw
                set(entries.map((x, j) => (j === i ? [x[0], val] : x)))
              }}
            />
            {ctx.editable ? (
              <button
                className="icon-btn"
                type="button"
                aria-label={`Remove ${k}`}
                onClick={() => set(entries.filter((_, j) => j !== i))}
              >
                <Icon name="x" />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      <datalist id={`${id}-f`}>
        {fields.map((f) => (
          <option key={f.key} value={f.key}>
            {f.label}
          </option>
        ))}
      </datalist>
      {ctx.editable ? (
        <div>
          <button
            className="btn btn-secondary btn-sm"
            type="button"
            onClick={() => set([...entries, [`field_${entries.length + 1}`, ""]])}
          >
            <Icon name="plus" />
            Add a field
          </button>
        </div>
      ) : null}
      <span className="hint">
        Custom fields only. An empty value clears the field. Numbers and yes/no follow the field’s type.
      </span>
    </div>
  )
}

function TopicForm({ node, ctx }: { node: Extract<GNode, { type: "topic" }>; ctx: Ctx }) {
  const topics = (useQuery(allTopicsQuery).data ?? []).filter((t) => !t.archived)
  const c = node.config
  return (
    <div className="fgrid">
      <SelectField
        label="Topic"
        value={c.topicId}
        options={topics.map((t) => [t.id, t.name])}
        ctx={ctx}
        onChange={(topicId) => ctx.onChange({ ...node, config: { ...c, topicId } })}
      />
      <SelectField
        label="Action"
        value={c.action}
        options={[
          ["subscribe", "Subscribe"],
          ["unsubscribe", "Unsubscribe"],
        ]}
        ctx={ctx}
        onChange={(a) =>
          ctx.onChange({ ...node, config: { ...c, action: a as "subscribe" | "unsubscribe" } })
        }
      />
    </div>
  )
}

function WebhookForm({ node, ctx }: { node: Extract<GNode, { type: "webhook" }>; ctx: Ctx }) {
  const id = useId()
  const caps = useCapabilities()
  const testPath = "/v1/automations/{id}/nodes/{nodeId}/test"
  // Built with HAL-3417; the capability check keeps it honest against a deploy that hasn't caught up.
  const testLive = caps.has("POST", testPath)
  const hidden = node.config.url.includes("•••")
  const [payload, setPayload] = useState(() =>
    node.config.payload ? JSON.stringify(node.config.payload, null, 1) : "",
  )
  const [payloadError, setPayloadError] = useState<string | null>(null)
  const secret = useMutation({
    mutationFn: () =>
      unwrap(api.GET("/v1/automations/{id}/webhook-secret", { params: { path: { id: ctx.automationId } } })),
  })
  // Sends one real request to the saved step's URL, as the draft has it (HAL-3417); a sample contact unless one
  // is given. It needs automations.write; a step that isn't a webhook answers 400.
  const test = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/automations/{id}/nodes/{nodeId}/test", {
          params: { path: { id: ctx.automationId, nodeId: node.id } },
          body: {},
        }),
      ),
  })
  const canSecret = !ctx.redacted && ctx.editable
  return (
    <>
      <div className="field">
        <span className="spread">
          <label className="label" htmlFor={id}>
            URL
          </label>
          {hidden ? (
            <span className="pill pill-lock" data-od-id="hidden-for-key">
              <Icon name="lock" />
              Hidden for your key
            </span>
          ) : null}
        </span>
        <input
          className={`input mono${hidden ? " is-redacted" : ""}`}
          id={id}
          value={node.config.url}
          readOnly={!ctx.editable || hidden}
          aria-describedby={`${id}-h`}
          onChange={(e) => ctx.onChange({ ...node, config: { ...node.config, url: e.target.value } })}
          {...(!hidden && node.config.url && !/^https:\/\//.test(node.config.url)
            ? { "aria-invalid": true }
            : {})}
        />
        <span className="hint" id={`${id}-h`}>
          {hidden ? (
            <>
              Only the scheme and host show: a webhook URL can be a secret (whoever holds a Slack or Zapier
              hook can post to it). Admin keys see the full URL. Saving never overwrites a hidden value: a
              graph that still holds <span className="mono">•••</span> keeps the stored URL.
            </>
          ) : (
            <>
              HTTPS only. Keys without admin see <span className="mono">https://host/•••</span>, since a hook
              URL can be a secret.
            </>
          )}
        </span>
      </div>
      <div className="field">
        <label className="label" htmlFor={`${id}-p`}>
          Payload <span className="opt">JSON, optional</span>
        </label>
        <textarea
          className="textarea mono"
          id={`${id}-p`}
          rows={4}
          style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
          value={payload}
          disabled={!ctx.editable}
          onChange={(e) => {
            setPayload(e.target.value)
            const v = e.target.value.trim()
            const { payload: _p, ...rest } = node.config
            if (!v) {
              setPayloadError(null)
              ctx.onChange({ ...node, config: rest })
              return
            }
            try {
              const parsed = JSON.parse(v)
              if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
                throw new Error("The payload is a JSON object.")
              setPayloadError(null)
              ctx.onChange({ ...node, config: { ...rest, payload: parsed } })
            } catch (err) {
              setPayloadError(err instanceof Error ? err.message : "That isn’t JSON.")
            }
          }}
          {...(payloadError ? { "aria-invalid": true, "aria-describedby": `${id}-pe` } : {})}
        />
        {payloadError ? (
          <p className="field-error" id={`${id}-pe`}>
            <Icon name="x-circle" />
            <span>{payloadError}</span>
          </p>
        ) : null}
        <span className="hint">
          Mailyard adds <span className="mono">contact</span>: its id, email, name and fields. Posted as JSON
          and signed as Standard Webhooks (<span className="mono">webhook-id</span>,{" "}
          <span className="mono">webhook-timestamp</span>, <span className="mono">webhook-signature</span>).
        </span>
      </div>
      <div className="field">
        <span className="label">Signing secret</span>
        {secret.data ? (
          <div className="input-group">
            <input className="input mono" readOnly value={secret.data.secret} aria-label="Signing secret" />
            <CopyButton value={secret.data.secret} label="Copy signing secret" />
          </div>
        ) : (
          <div className="cluster">
            <Gated
              allowed={canSecret}
              reason="Your key can’t see the signing secret"
              who="GET /v1/automations/:id/webhook-secret needs admin."
            >
              <button
                className={`btn btn-secondary btn-sm${secret.isPending ? " is-loading" : ""}`}
                type="button"
                data-od-id="show-secret"
                data-endpoint={`GET /v1/automations/${ctx.automationId}/webhook-secret`}
                onClick={() => secret.mutate()}
              >
                <Icon name="eye" />
                Show secret
              </button>
            </Gated>
          </div>
        )}
        {secret.isError ? <ApiErrorCallout error={secret.error} what="The secret didn’t load." /> : null}
      </div>
      <div className="field">
        <span className="cluster cluster-8">
          <Gated
            allowed={testLive && ctx.editable}
            reason={testLive ? ctx.reason : "Testing one step isn’t on this deploy yet"}
            who={
              testLive
                ? ctx.who
                : "A dry run counts the webhook as answered 200 without calling it. Deploy the latest Mailyard (HAL-3417) to send a real test request."
            }
          >
            <button
              className={`btn btn-secondary btn-sm${test.isPending ? " is-loading" : ""}`}
              type="button"
              data-endpoint={`POST ${testPath}`}
              disabled={test.isPending}
              onClick={() => test.mutate()}
            >
              {test.isPending ? <span className="spinner" aria-hidden="true" /> : <Icon name="send" />}
              Send a test request
            </button>
          </Gated>
          {!testLive ? (
            <Planned issue="HAL-3417" what="this deploy doesn't have the one-step test yet." />
          ) : null}
        </span>
        <span className="hint">
          Sends one real request to the saved step’s URL, as the draft has it: save first to test an edit. It
          posts a sample contact unless the run has one, signed like a real run.
        </span>
        {test.data ? (
          <div
            className={`callout ${test.data.ok ? "callout-ok" : "callout-error"}`}
            role="status"
            data-od-id="webhook-test-result"
          >
            <Icon name={test.data.ok ? "check-circle" : "x-circle"} />
            <div className="stack stack-4" style={{ minWidth: 0 }}>
              <span>
                <b>
                  {test.data.error === "timeout"
                    ? "No answer in time."
                    : test.data.error === "network"
                      ? "The URL couldn’t be reached."
                      : `Answered ${fmtInt(test.data.status)}${test.data.ok ? "" : ", outside 2xx: a run would retry, then fail"}.`}
                </b>{" "}
                {fmtInt(test.data.tookMs)} ms ·{" "}
                <span className="mono" style={{ overflowWrap: "anywhere" }}>
                  {test.data.url}
                </span>
              </span>
              <span className="t-small muted">
                As <span className="mono">{test.data.contact.email}</span>
                {test.data.contact.sample ? " (a sample contact)" : ""}
              </span>
              {test.data.response ? (
                <pre
                  className="mono t-small"
                  style={{
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                    margin: 0,
                    maxHeight: 160,
                    overflow: "auto",
                  }}
                >
                  {test.data.response}
                </pre>
              ) : null}
            </div>
          </div>
        ) : null}
        {test.isError ? <ApiErrorCallout error={test.error} what="The test wasn’t sent." /> : null}
      </div>
      <p className="hint">
        An answer outside 2xx fails the step: it retries, and if it keeps failing the run fails and raises{" "}
        <span className="mono">automation_failed</span>. A dry run doesn’t call it; it counts it as answered
        200.
      </p>
    </>
  )
}

// ---------------------------------------------------------------------------------------------
// Send (HAL-3411)
// ---------------------------------------------------------------------------------------------

function SendForm({ node, ctx }: { node: Extract<GNode, { type: "send" }>; ctx: Ctx }) {
  const c = node.config
  const set = (config: typeof c) => ctx.onChange({ ...node, config })
  const templates = (useQuery(templatesQuery).data ?? []).filter((t) => !t.archived || t.id === c.templateId)
  const identities = useQuery(identitiesQuery).data ?? []
  const topics = (useQuery(allTopicsQuery).data ?? []).filter((t) => !t.archived)
  const selected = useQuery({ ...templateQuery(c.templateId), enabled: Boolean(c.templateId) })
  const subjectRef = useRef<HTMLInputElement>(null)
  const kind = ctx.trigger?.kind ?? null
  const subj = useId()
  const tp = useId()

  const insert = (token: string) => {
    const el = subjectRef.current
    const { value, caret } = insertAt(c.subject ?? "", el?.selectionStart ?? null, token)
    const { subject: _s, ...rest } = c
    set(value ? { ...rest, subject: value } : rest)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(caret, caret)
    })
  }

  const versions = selected.data && "versions" in selected.data ? selected.data.versions : []
  return (
    <>
      <div className="field">
        <span className="label" id={tp}>
          Template
        </span>
        <div
          className="tpl-pick"
          role="listbox"
          aria-labelledby={tp}
          aria-readonly={!ctx.editable}
          data-od-id="template-picker"
          data-endpoint="GET /v1/templates · GET /v1/templates/{id} → latest.variables {used, required}"
        >
          {templates.length === 0 ? (
            <div className="tpl-row" role="option" aria-selected="false" aria-disabled="true" tabIndex={-1}>
              <span className="hint">No templates yet. Make one in Transactional → Templates.</span>
            </div>
          ) : (
            templates.map((t) => (
              <TemplateRow
                key={t.id}
                t={t}
                kind={kind}
                selected={t.id === c.templateId}
                editable={ctx.editable}
                onPick={() => set({ ...c, templateId: t.id, version: "published" })}
              />
            ))
          )}
        </div>
        <span className="hint">
          “Needs” lists required placeholders: those with no <span className="mono">??</span> fallback. A
          contact field with no value skips the send for that contact; the run goes on.
        </span>
      </div>
      <div className="fgrid">
        <SelectField
          label="Version"
          value={String(c.version)}
          options={[
            ["published", "Published"],
            ...versions.map(
              (v) =>
                [String(v.version), `v${v.version}${v.publishedAt ? "" : " · unpublished"}`] as [
                  string,
                  string,
                ],
            ),
          ]}
          ctx={ctx}
          onChange={(v) => set({ ...c, version: v === "published" ? "published" : Number(v) })}
        />
        <SelectField
          label="From"
          value={c.fromAddress ?? ""}
          options={[
            ["", "Automation default"],
            ...identities.map(
              (i) =>
                [i.displayName ? `${i.displayName} <${i.address}>` : i.address, i.address] as [
                  string,
                  string,
                ],
            ),
          ]}
          ctx={ctx}
          mono
          onChange={(v) => {
            const { fromAddress: _f, ...rest } = c
            set(v ? { ...rest, fromAddress: v } : rest)
          }}
        />
      </div>
      <div className="field">
        <label className="label" htmlFor={subj}>
          Subject <span className="opt">override</span>
        </label>
        <input
          className="input"
          id={subj}
          ref={subjectRef}
          data-insert-target
          maxLength={200}
          value={c.subject ?? ""}
          placeholder={
            selected.data && "latest" in selected.data ? (selected.data.latest?.subject ?? "") : ""
          }
          readOnly={!ctx.editable}
          onChange={(e) => {
            const { subject: _s, ...rest } = c
            set(e.target.value ? { ...rest, subject: e.target.value } : rest)
          }}
        />
        <span className="hint">
          Write a fallback with <span className="mono">??</span> so a contact without the field still gets
          mail: <span className="mono">{'{{ first_name ?? "there" }}'}</span>.
        </span>
      </div>
      {ctx.trigger ? (
        <TriggerKeys trigger={ctx.trigger} ctx={ctx} onInsert={ctx.editable ? insert : undefined} />
      ) : null}
      <SelectField
        label="Unsubscribe topic"
        value={c.topicId ?? ""}
        options={[["", "Automation default"], ...topics.map((t) => [t.id, t.name] as [string, string])]}
        ctx={ctx}
        onChange={(v) => {
          const { topicId: _t, ...rest } = c
          set(v ? { ...rest, topicId: v } : rest)
        }}
        hint="Whose unsubscribe link the mail carries."
      />
      <div className="cluster cluster-16">
        <label className="cluster cluster-8">
          <input
            type="checkbox"
            checked={c.trackOpens !== false}
            disabled={!ctx.editable}
            onChange={(e) => set({ ...c, trackOpens: e.target.checked })}
          />{" "}
          Track opens
        </label>
        <label className="cluster cluster-8">
          <input
            type="checkbox"
            checked={c.trackClicks !== false}
            disabled={!ctx.editable}
            onChange={(e) => set({ ...c, trackClicks: e.target.checked })}
          />{" "}
          Track clicks
        </label>
      </div>
    </>
  )
}

function TemplateRow({
  t,
  kind,
  selected,
  editable,
  onPick,
}: {
  t: { id: string; name: string; publishedVersion: number | string | null }
  kind: TriggerKind | null
  selected: boolean
  editable: boolean
  onPick: () => void
}) {
  const detail = useQuery(templateQuery(t.id))
  const latest = detail.data && "latest" in detail.data && detail.data.id === t.id ? detail.data.latest : null
  const required = latest?.variables.required ?? []
  const ph = classifyPlaceholders(required, kind)
  const bad = ph.some((p) => p.cls === "is-bad") || t.publishedVersion === null
  return (
    <div
      className={`tpl-row${selected ? " is-selected" : ""}${bad && selected ? " is-bad" : ""}`}
      role="option"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      onClick={editable ? onPick : undefined}
      onKeyDown={(e) => {
        if (editable && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault()
          onPick()
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault()
          const sib = (
            e.key === "ArrowDown"
              ? e.currentTarget.nextElementSibling
              : e.currentTarget.previousElementSibling
          ) as HTMLElement | null
          sib?.focus()
        }
      }}
    >
      <span className="tpl-top">
        <span className="mono strong">{t.name}</span>
        <span className="tpl-ver">
          {t.publishedVersion === null ? (
            <span style={{ color: "var(--red-900)" }}>No published version</span>
          ) : (
            `v${t.publishedVersion} published`
          )}
        </span>
        {selected ? <Icon name="check" className="tpl-check" /> : null}
      </span>
      <span className="tpl-ph">
        <span className="tpl-lab">Needs</span>
        {detail.isPending ? (
          <span className="sk sk-chip" aria-hidden="true" />
        ) : !latest ? (
          <span className="ph is-field">
            Not read
            <span className="ph-why">{detail.isError ? "the template didn’t load" : "no version yet"}</span>
          </span>
        ) : ph.length === 0 ? (
          <span className="ph is-ok">No required placeholders</span>
        ) : (
          ph.map((p) => (
            <span key={p.name} className={`ph ${p.cls}`}>
              {p.cls === "is-bad" ? <Icon name="x-circle" /> : null}
              {`{{ ${p.name} }}`}
              <span className="ph-why">{p.why}</span>
            </span>
          ))
        )}
      </span>
    </div>
  )
}

/**
 * An event trigger's data keys, as recent events carried them (`GET /v1/events/{name}/keys`, HAL-3417): each key
 * with how often it was seen, its types and an example (null without `contacts.read`). Any key the app sends
 * is there, so a key not seen yet can still be typed.
 */
function EventKeys({
  event,
  row,
  custom,
  setCustom,
}: {
  event: string
  row: (key: string, hint: ReactNode) => ReactNode
  custom: string
  setCustom: (v: string) => void
}) {
  const caps = useCapabilities()
  const live = caps.has("GET", "/v1/events/{name}/keys")
  const q = useQuery({
    queryKey: ["events", event, "keys"],
    queryFn: () => unwrap(api.GET("/v1/events/{name}/keys", { params: { path: { name: event } } })),
    enabled: live && Boolean(event),
    staleTime: 60_000,
  })
  const keys = q.data?.keys ?? []
  const example = (v: unknown) =>
    v === null || v === undefined ? null : typeof v === "string" ? v : JSON.stringify(v).slice(0, 60)
  return (
    <>
      <p className="hint">
        An event trigger carries the event’s own <span className="mono">data</span>, so any key your app sends
        to <span className="mono">POST /v1/track</span> is there.
        {q.data
          ? ` These are the keys on the last ${fmtInt(q.data.sampled)} ${event} events.`
          : live
            ? ""
            : " This deploy can’t list the keys recent events carried yet (HAL-3417), so type the one you send."}
      </p>
      {!live ? <Planned issue="HAL-3417" what="this deploy doesn't list an event's data keys yet." /> : null}
      {q.isPending && live ? <span className="sk sk-text" aria-hidden="true" /> : null}
      {q.isError ? <ApiErrorCallout error={q.error} what="The event’s keys didn’t load." /> : null}
      {keys.length ? (
        <ul className="tkey-list">
          {keys.map((k) =>
            row(
              k.key,
              <>
                Seen on {fmtInt(k.seen)} · {k.types.join(", ")}
                {example(k.example) ? (
                  <>
                    {" "}
                    · e.g. <span className="mono">{example(k.example)}</span>
                  </>
                ) : null}
              </>,
            ),
          )}
        </ul>
      ) : q.data ? (
        <p className="hint">No recent {event} event carried data yet.</p>
      ) : null}
      <div className="input-group">
        <input
          className="input mono"
          aria-label="Another event data key"
          placeholder="a key not seen yet"
          value={custom}
          onChange={(e) => setCustom(e.target.value.replace(/[^A-Za-z0-9_]/g, ""))}
        />
      </div>
      {custom ? <ul className="tkey-list">{row(custom, "A key your app sends with the event")}</ul> : null}
    </>
  )
}

/** The keys a run's `trigger.*` holds for this trigger kind (TRIGGER_DATA_KEYS), with Insert and Copy. */
function TriggerKeys({
  trigger,
  ctx,
  onInsert,
}: {
  trigger: Trigger
  ctx: Ctx
  onInsert?: ((token: string) => void) | undefined
}) {
  const keys = TRIGGER_DATA_KEYS[trigger.kind]
  const [custom, setCustom] = useState("")
  const head = `Trigger data · ${TRIGGER_KIND_LABEL[trigger.kind]}${
    trigger.kind === "event" ? `, ${trigger.event}` : trigger.kind === "date" ? `, ${trigger.field}` : ""
  }`
  const row = (key: string, hint: ReactNode) => {
    const token = `{{ trigger.${key} }}`
    return (
      <li key={key} className="tkey">
        <code className="mono">{token}</code>
        <span className="tk-hint">{hint}</span>
        <span className="tk-acts">
          {onInsert ? (
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              data-insert={token}
              aria-label={`Insert trigger.${key} into the subject`}
              onClick={() => onInsert(token)}
            >
              Insert
            </button>
          ) : null}
          <CopyButton value={token} label={`Copy trigger.${key}`} />
        </span>
      </li>
    )
  }
  return (
    <section className="tkeys" aria-labelledby={`tk-${trigger.kind}`} data-od-id="trigger-data">
      <div className="spread">
        <h3 className="label" id={`tk-${trigger.kind}`}>
          {head}
        </h3>
      </div>
      {keys === "any" && trigger.kind === "event" ? (
        <EventKeys event={trigger.event} row={row} custom={custom} setCustom={setCustom} />
      ) : (
        <>
          <p className="hint">
            A {TRIGGER_KIND_LABEL[trigger.kind]} trigger fills exactly these. A template that requires any
            other <span className="mono">trigger.*</span> key can’t publish.
          </p>
          <ul className="tkey-list">
            {(keys === "any" ? [] : keys).map((k) => {
              const ex = triggerKeyExample(k, trigger, ctx.names)
              return row(
                k,
                <>
                  {TRIGGER_KEY_HINT[k] ?? k}
                  {ex ? (
                    <>
                      {" "}
                      · e.g. <span className="mono">{ex}</span>
                    </>
                  ) : null}
                </>,
              )
            })}
          </ul>
        </>
      )}
      <p className="hint">
        {onInsert
          ? "Insert puts it in the subject override; copy it to paste into the template."
          : "Copy it to paste into a template."}
      </p>
    </section>
  )
}
