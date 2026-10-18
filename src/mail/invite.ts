/**
 * Calendar invitations in mail (HAL-3369): the iCalendar (RFC 5545) part of a message read into an
 * invite, and the iTIP (RFC 5546) REPLY a mailbox sends when its person answers. Pure code.
 *
 * Only what the reader shows and the reply needs is read: the method, the first VEVENT's UID,
 * summary, times, location, organizer and attendees. Lines are unfolded, parameters and escapes read.
 */

export type PartStat = "NEEDS-ACTION" | "ACCEPTED" | "DECLINED" | "TENTATIVE" | "DELEGATED"

export interface Invite {
  /** REQUEST (an invitation), CANCEL, REPLY, PUBLISH … */
  readonly method: string
  readonly uid: string
  readonly sequence: number
  readonly summary: string | null
  readonly description: string | null
  readonly location: string | null
  /** ISO 8601. All-day events give a date; times without a zone are kept as written, without `Z`. */
  readonly start: string | null
  readonly end: string | null
  readonly allDay: boolean
  /** The TZID the times were written in, if any. */
  readonly timeZone: string | null
  readonly organizer: { readonly address: string; readonly name: string | null } | null
  readonly attendees: ReadonlyArray<{
    readonly address: string
    readonly name: string | null
    readonly partstat: PartStat
    readonly role: string | null
  }>
}

interface Property {
  readonly name: string
  readonly params: Readonly<Record<string, string>>
  readonly value: string
}

/** RFC 5545 §3.1: a line starting with a space or tab continues the one before. */
const unfold = (text: string) => text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n")

const unescape = (v: string) =>
  v.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\")

const escape = (v: string) =>
  v.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n")

const parseLine = (line: string): Property | null => {
  // NAME;PARAM=VALUE;PARAM="QUOTED:VALUE":value — a colon inside quotes isn't the separator.
  let inQuotes = false
  let split = -1
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') inQuotes = !inQuotes
    else if (c === ":" && !inQuotes) {
      split = i
      break
    }
  }
  if (split < 0) return null
  const head = line.slice(0, split)
  const value = line.slice(split + 1)
  const parts: Array<string> = []
  let current = ""
  inQuotes = false
  for (const c of head) {
    if (c === '"') inQuotes = !inQuotes
    if (c === ";" && !inQuotes) {
      parts.push(current)
      current = ""
    } else current += c
  }
  parts.push(current)
  const [name = "", ...rest] = parts
  const params: Record<string, string> = {}
  for (const p of rest) {
    const at = p.indexOf("=")
    if (at > 0) params[p.slice(0, at).toUpperCase()] = p.slice(at + 1).replace(/^"|"$/g, "")
  }
  return { name: name.toUpperCase(), params, value }
}

const mailto = (v: string) => v.replace(/^mailto:/i, "").trim().toLowerCase()

/** `20261020T150000Z`, `20261020T150000` or `20261020` as ISO 8601. */
const isoOf = (value: string) => {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim())
  if (!m) return null
  const [, y, mo, d, h, mi, s, z] = m
  if (h === undefined) return { iso: `${y}-${mo}-${d}`, allDay: true }
  return { iso: `${y}-${mo}-${d}T${h}:${mi}:${s}${z ? "Z" : ""}`, allDay: false }
}

const PARTSTATS: ReadonlyArray<PartStat> = ["NEEDS-ACTION", "ACCEPTED", "DECLINED", "TENTATIVE", "DELEGATED"]

/** Reads the invitation in an iCalendar document, or null when it has no event. */
export const parseInvite = (text: string): Invite | null => {
  const lines = unfold(text)
  let method = "PUBLISH"
  let inEvent = false
  let seenEvent = false
  const event: Array<Property> = []
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line) continue
    const upper = line.toUpperCase()
    if (upper === "BEGIN:VEVENT" && !seenEvent) {
      inEvent = true
      continue
    }
    if (upper === "END:VEVENT" && inEvent) {
      inEvent = false
      seenEvent = true
      continue
    }
    const prop = parseLine(line)
    if (!prop) continue
    if (!inEvent && !seenEvent && prop.name === "METHOD") method = prop.value.trim().toUpperCase()
    // Nested components (VALARM) inside the event: skip their lines.
    if (inEvent && !/^(BEGIN|END)$/.test(prop.name)) event.push(prop)
  }
  if (!seenEvent) return null
  const one = (name: string) => event.find((p) => p.name === name)
  const uid = one("UID")?.value.trim()
  if (!uid) return null
  const start = one("DTSTART")
  const end = one("DTEND")
  const s = start ? isoOf(start.value) : null
  const e = end ? isoOf(end.value) : null
  const organizer = one("ORGANIZER")
  return {
    method,
    uid,
    sequence: Number(one("SEQUENCE")?.value ?? "0") || 0,
    summary: one("SUMMARY") ? unescape(one("SUMMARY")?.value ?? "") : null,
    description: one("DESCRIPTION") ? unescape(one("DESCRIPTION")?.value ?? "").slice(0, 2_000) : null,
    location: one("LOCATION") ? unescape(one("LOCATION")?.value ?? "") : null,
    start: s?.iso ?? null,
    end: e?.iso ?? null,
    allDay: s?.allDay ?? false,
    timeZone: start?.params.TZID ?? null,
    organizer: organizer ? { address: mailto(organizer.value), name: organizer.params.CN ?? null } : null,
    attendees: event
      .filter((p) => p.name === "ATTENDEE")
      .slice(0, 200)
      .map((p) => {
        const stat = (p.params.PARTSTAT ?? "NEEDS-ACTION").toUpperCase() as PartStat
        return {
          address: mailto(p.value),
          name: p.params.CN ?? null,
          partstat: PARTSTATS.includes(stat) ? stat : "NEEDS-ACTION",
          role: p.params.ROLE ?? null,
        }
      }),
  }
}

/** RFC 5545 §3.1: lines longer than 75 octets fold onto continuation lines. */
const fold = (line: string) => {
  const bytes = new TextEncoder().encode(line)
  if (bytes.length <= 75) return line
  const out: Array<string> = []
  let current = ""
  let size = 0
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length
    if (size + n > (out.length === 0 ? 75 : 74)) {
      out.push(current)
      current = ""
      size = 0
    }
    current += ch
    size += n
  }
  out.push(current)
  return out.join("\r\n ")
}

const stamp = (now: number) => new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")

/**
 * The iTIP REPLY an attendee sends: the same UID and SEQUENCE, the attendee with its new PARTSTAT,
 * and the organizer, so the organizer's calendar updates its copy.
 */
export const buildReply = (input: {
  readonly invite: Invite
  readonly attendee: { readonly address: string; readonly name: string | null }
  readonly response: "accepted" | "tentative" | "declined"
  readonly now?: number
  readonly prodId?: string
}) => {
  const partstat = input.response.toUpperCase()
  const invite = input.invite
  const lines = [
    "BEGIN:VCALENDAR",
    `PRODID:${input.prodId ?? "-//Mailyard//Mail//EN"}`,
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "METHOD:REPLY",
    "BEGIN:VEVENT",
    `UID:${invite.uid}`,
    `SEQUENCE:${invite.sequence}`,
    `DTSTAMP:${stamp(input.now ?? Date.now())}`,
    ...(invite.organizer
      ? [
          `ORGANIZER${invite.organizer.name ? `;CN="${invite.organizer.name.replace(/"/g, "'")}"` : ""}:mailto:${invite.organizer.address}`,
        ]
      : []),
    `ATTENDEE;PARTSTAT=${partstat}${input.attendee.name ? `;CN="${input.attendee.name.replace(/"/g, "'")}"` : ""}:mailto:${input.attendee.address}`,
    ...(invite.summary ? [`SUMMARY:${escape(invite.summary)}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ]
  return `${lines.map(fold).join("\r\n")}\r\n`
}

export const RESPONSE_WORDS = { accepted: "Accepted", tentative: "Tentative", declined: "Declined" } as const
