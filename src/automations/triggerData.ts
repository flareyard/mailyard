import type { TriggerConfig } from "./graph.ts"

/**
 * What a run's `trigger` holds, per trigger kind (HAL-3411). An event trigger carries the tracked
 * event's own data, so any key can be there. The others carry these keys, filled in when the contact
 * enters, so a template can say `{{ trigger.years }}` on a birthday or `{{ trigger.topicName }}` on a
 * subscription. The automation's issues refuse a required `trigger.x` the kind doesn't carry.
 */
export const TRIGGER_DATA_KEYS: { readonly [K in TriggerConfig["kind"]]: ReadonlyArray<string> | "any" } = {
  event: "any",
  created: ["createdAt"],
  topic: ["topicId", "topicName"],
  segment: ["segmentId", "segmentName"],
  date: ["field", "date", "offsetDays", "years"],
  mail_received: ["mailboxId", "threadId", "messageId", "from", "fromName", "subject", "senderDomain"],
}

const DAY = 86_400_000

/** A contact field as a calendar day: an ISO date or datetime string, or epoch milliseconds. */
export const dayOf = (value: unknown): string | null => {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString().slice(0, 10)
  if (typeof value === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim())
    if (m) return `${m[1]}-${m[2]}-${m[3]}`
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10)
  }
  return null
}

/**
 * A date trigger's data for one contact, at the sweep that enters them. `years` counts to the
 * anniversary the run is about: the day the sweep matched (today minus the offset), so a reminder a
 * week before a birthday already says the age being turned.
 */
export const dateTriggerData = (
  trigger: Extract<TriggerConfig, { kind: "date" }>,
  fieldValue: unknown,
  now: number,
): Record<string, unknown> => {
  const date = dayOf(fieldValue)
  const today = new Date(now)
  const anniversary = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - trigger.offsetDays * DAY,
  )
  const years = date === null ? null : anniversary.getUTCFullYear() - Number(date.slice(0, 4))
  return { field: trigger.field, date, offsetDays: trigger.offsetDays, years }
}

/** The `trigger.<key>` placeholders a template requires that a trigger of this kind won't carry. */
export const unsuppliedTriggerKeys = (kind: TriggerConfig["kind"], required: ReadonlyArray<string>) => {
  const keys = TRIGGER_DATA_KEYS[kind]
  if (keys === "any") return []
  return [
    ...new Set(
      required
        .filter((name) => name === "trigger" || name.startsWith("trigger."))
        .map((name) => name.split(".")[1] ?? "")
        .filter((key) => !keys.includes(key)),
    ),
  ]
}
