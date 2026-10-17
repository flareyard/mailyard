import type { StepDefinition } from "./types.ts"

const DAY = 86_400_000

/** The next moment (strictly after `now`) that is `weekday` at `hour`:00 UTC. */
export const nextWeekdayHour = (now: number, weekday: number, hour: number) => {
  const d = new Date(now)
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour)
  const ahead = (weekday - d.getUTCDay() + 7) % 7
  const at = today + ahead * DAY
  return at > now ? at : at + 7 * DAY
}

/** A date from a contact field (ISO date or epoch ms), shifted by days, at an hour UTC; null when unreadable. */
export const fieldDate = (value: unknown, offsetDays: number, hour: number) => {
  const ms =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Date.parse(value)
        : Number.NaN
  if (!Number.isFinite(ms)) return null
  const d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour) + offsetDays * DAY
}

/** Waits until a weekday and hour, or a date held on the contact. A date already past continues at once. */
export const waitUntil: StepDefinition<"wait_until"> = {
  type: "wait_until",
  validate: () => null,
  run: async (node, ctx) => {
    const c = node.config
    if (c.kind === "weekday") {
      const until = nextWeekdayHour(ctx.now, c.weekday, c.hour)
      return { kind: "sleep", until, detail: `Waiting until ${new Date(until).toISOString()}.` }
    }
    const until = fieldDate(ctx.contact.fields[c.field], c.offsetDays, c.hour)
    if (until === null) return { kind: "next", detail: `No date in ${c.field}; continuing.` }
    if (until <= ctx.now) return { kind: "next", detail: `${c.field} has passed; continuing.` }
    return { kind: "sleep", until, detail: `Waiting until ${new Date(until).toISOString()} (${c.field}).` }
  },
}
