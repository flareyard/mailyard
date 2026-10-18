/**
 * The Hermes lane (HAL-3306, live): `GET`/`PUT /v1/settings/mail-events { enabled, mailboxIds, types }`. With it
 * on, Mailyard puts mail events on the mail-events queue Hermes reads; null mailboxes or types means all of them.
 * `available` is false when the deploy has no queue bound, and then the switch says so instead of pretending.
 * PUT needs settings.write; an unknown mailbox answers 400 on `mailboxIds`, shown on the picker.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type FormEvent, useEffect, useState } from "react"
import { ApiError, api, unwrap } from "../../api/client.ts"
import { Gated } from "../../auth/NoPermission.tsx"
import { fmtInt } from "../../lib/format.ts"
import { BuiltPill, Time } from "../../ops/kit.tsx"
import { toast } from "../../ops/toast.tsx"
import { Icon } from "../../ui/icons.tsx"
import { Panel } from "../../ui/Panel.tsx"
import { useCanWriteSettings } from "../alerts/AlertsPage.tsx"
import { MutationError } from "./KeySheets.tsx"
import {
  LANE_TYPES,
  type LaneForm,
  type LaneType,
  laneBody,
  laneDirty,
  laneField,
  laneForm,
  laneProblems,
} from "./logic.ts"
import { type Body, mailboxesQuery } from "./queries.ts"

export type MailEvents = Body<"/v1/settings/mail-events">

export const mailEventsQuery = {
  queryKey: ["settings", "mail-events"],
  queryFn: () => unwrap(api.GET("/v1/settings/mail-events")),
}

export function HermesLane() {
  const q = useQuery(mailEventsQuery)
  return (
    <Panel
      id="mail-events"
      title="Hermes lane"
      endpoint="GET /v1/settings/mail-events · PUT /v1/settings/mail-events (built, HAL-3306)"
      query={q}
      meta={<BuiltPill issue="HAL-3306" />}
    >
      {(d) => <LaneEditor saved={d} />}
    </Panel>
  )
}

function LaneEditor({ saved }: { saved: MailEvents }) {
  const qc = useQueryClient()
  const canWrite = useCanWriteSettings()
  const boxes = useQuery(mailboxesQuery)
  const holding = (boxes.data?.mailboxes ?? []).filter((m) => m.holdsMail)
  const base = laneForm(saved)
  const [f, setF] = useState<LaneForm>(base)
  const [tried, setTried] = useState(false)
  const [refused, setRefused] = useState<{ field: "mailboxIds" | "types" | null; error: unknown } | null>(
    null,
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new server answer resets the form
  useEffect(() => setF(laneForm(saved)), [saved])

  const save = useMutation({
    mutationFn: () => unwrap(api.PUT("/v1/settings/mail-events", { body: laneBody(f) })),
    onSuccess: async (r) => {
      qc.setQueryData(mailEventsQuery.queryKey, r)
      setTried(false)
      setRefused(null)
      await qc.invalidateQueries({ queryKey: ["integrations"] })
      toast({
        title: r.enabled ? "The Hermes lane is on" : "The Hermes lane is off",
        sub: `Settings version ${r.version}`,
      })
    },
    onError: (e) =>
      setRefused({
        field: e instanceof ApiError && e.status === 400 ? laneField(e.body.field) : null,
        error: e,
      }),
  })
  const local = laneProblems(f)
  const dirty = laneDirty(base, f)
  const patch = (p: Partial<LaneForm>) => {
    setF((cur) => ({ ...cur, ...p }))
    if (refused?.field && (refused.field in p || ("allMailboxes" in p && refused.field === "mailboxIds")))
      setRefused(null)
  }
  const mbxError =
    refused?.field === "mailboxIds" && refused.error instanceof Error
      ? refused.error.message
      : tried
        ? local.mailboxIds
        : undefined
  const typeError =
    refused?.field === "types" && refused.error instanceof Error
      ? refused.error.message
      : tried
        ? local.types
        : undefined
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setTried(true)
    if (!canWrite || !dirty || save.isPending || local.mailboxIds || local.types) return
    save.mutate()
  }
  const toggleBox = (id: string, on: boolean) =>
    patch({ mailboxIds: on ? [...f.mailboxIds, id] : f.mailboxIds.filter((x) => x !== id) })
  const toggleType = (t: LaneType, on: boolean) =>
    patch({ types: on ? [...f.types, t] : f.types.filter((x) => x !== t) })
  const unknown = f.mailboxIds.filter((id) => boxes.isSuccess && !holding.some((m) => m.id === id))

  return (
    <form className="stack stack-12" onSubmit={submit} noValidate>
      <p className="muted" style={{ margin: 0 }}>
        With the lane on, Mailyard puts mail events on the <span className="mono">{saved.queue}</span> queue,
        and Hermes reads them there to triage, draft and follow up.
      </p>
      {saved.available ? null : (
        <div className="callout callout-warn" role="status">
          <Icon name="warn" />
          <span>
            <b>The mail-events queue isn’t bound in this deploy.</b> Bind{" "}
            <span className="mono">MAIL_EVENTS_QUEUE</span> to <span className="mono">{saved.queue}</span> in
            wrangler and deploy, then turn the lane on here.
          </span>
        </div>
      )}
      <Gated
        allowed={saved.available}
        reason="The mail-events queue isn’t bound"
        who="Bind MAIL_EVENTS_QUEUE in wrangler and deploy; then the lane can go on."
      >
        <label className="switch">
          <input type="checkbox" checked={f.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
          Send mail events to Hermes
        </label>
      </Gated>
      <fieldset
        className={`field${mbxError ? " is-invalid" : ""}`}
        style={{ border: 0, padding: 0, margin: 0 }}
        aria-describedby="lane-mbx-hint"
      >
        <legend className="label" style={{ marginBottom: 6 }}>
          Mailboxes
        </legend>
        {/* biome-ignore lint/a11y/useSemanticElements: the design's segmented control inside a fieldset */}
        <div className="seg" role="group" aria-label="Which mailboxes">
          <button type="button" aria-pressed={f.allMailboxes} onClick={() => patch({ allMailboxes: true })}>
            All mailboxes
          </button>
          <button type="button" aria-pressed={!f.allMailboxes} onClick={() => patch({ allMailboxes: false })}>
            Pick mailboxes
          </button>
        </div>
        {f.allMailboxes ? null : (
          <div
            className="pick-grid lane-grid"
            style={{ marginTop: 8 }}
            aria-invalid={mbxError ? true : undefined}
          >
            {holding.map((m) => {
              const on = f.mailboxIds.includes(m.id)
              return (
                <label key={m.id} className={`pick${on ? " is-on" : ""}`}>
                  <input
                    type="checkbox"
                    style={{ width: 16, height: 16 }}
                    checked={on}
                    onChange={(e) => toggleBox(m.id, e.target.checked)}
                  />
                  <span className="p-name mono">{m.address}</span>
                </label>
              )
            })}
            {unknown.map((id) => (
              <label key={id} className="pick is-on">
                <input
                  type="checkbox"
                  style={{ width: 16, height: 16 }}
                  checked
                  onChange={() => toggleBox(id, false)}
                />
                <span className="p-name mono">{id}</span>
                <span className="p-sub">No longer a mailbox here</span>
              </label>
            ))}
          </div>
        )}
        <span className={mbxError ? "field-error" : "hint"} id="lane-mbx-hint">
          {mbxError ??
            (f.allMailboxes ? "Including mailboxes added later." : `${fmtInt(f.mailboxIds.length)} picked.`)}
        </span>
      </fieldset>
      <fieldset
        className={`field${typeError ? " is-invalid" : ""}`}
        style={{ border: 0, padding: 0, margin: 0 }}
        aria-describedby="lane-type-hint"
      >
        <legend className="label" style={{ marginBottom: 6 }}>
          Events
        </legend>
        {/* biome-ignore lint/a11y/useSemanticElements: the design's segmented control inside a fieldset */}
        <div className="seg" role="group" aria-label="Which events">
          <button type="button" aria-pressed={f.allTypes} onClick={() => patch({ allTypes: true })}>
            Every event
          </button>
          <button type="button" aria-pressed={!f.allTypes} onClick={() => patch({ allTypes: false })}>
            Pick events
          </button>
        </div>
        {f.allTypes ? null : (
          <div className="pick-grid lane-grid" style={{ marginTop: 8 }}>
            {LANE_TYPES.map((t) => {
              const on = f.types.includes(t.value)
              return (
                <label key={t.value} className={`pick${on ? " is-on" : ""}`}>
                  <input
                    type="checkbox"
                    style={{ width: 16, height: 16 }}
                    checked={on}
                    onChange={(e) => toggleType(t.value, e.target.checked)}
                  />
                  <span className="p-name">{t.label}</span>
                  <span className="p-sub mono">{t.value}</span>
                </label>
              )
            })}
          </div>
        )}
        <span className={typeError ? "field-error" : "hint"} id="lane-type-hint">
          {typeError ?? (f.allTypes ? "Including kinds added later." : `${fmtInt(f.types.length)} picked.`)}
        </span>
      </fieldset>
      <dl className="kv">
        <dt>Queue</dt>
        <dd>
          <span className="mono">{saved.queue}</span>
        </dd>
        <dt>On since</dt>
        <dd>
          {saved.enabled && saved.since ? (
            <Time value={saved.since} mode="full" />
          ) : (
            <span className="muted">Off</span>
          )}
        </dd>
        <dt>Settings version</dt>
        <dd className="num">{fmtInt(saved.version)}</dd>
      </dl>
      {refused && !refused.field ? (
        <MutationError error={refused.error} what="The lane wasn’t saved" />
      ) : null}
      <div className="cluster" style={{ justifyContent: "space-between" }}>
        <span className="t-small muted" role="status">
          {tried && (local.mailboxIds || local.types)
            ? "Fix the marked fields to save."
            : dirty
              ? "Unsaved changes."
              : "Nothing to save."}
        </span>
        <span className="cluster">
          {dirty ? (
            <button
              className="btn btn-secondary btn-sm"
              type="button"
              onClick={() => {
                setF(base)
                setTried(false)
                setRefused(null)
              }}
            >
              Discard
            </button>
          ) : null}
          <Gated
            allowed={canWrite}
            reason="You can’t change the Hermes lane"
            who="Owners and admins, or a key with the admin scope (settings.write), can."
            side="up"
          >
            <button className="btn btn-primary btn-sm" type="submit" aria-disabled={!dirty || save.isPending}>
              {save.isPending ? "Saving…" : "Save lane"}
            </button>
          </Gated>
        </span>
      </div>
    </form>
  )
}
