import { describe, expect, it } from "vitest"
import { buildReply, parseInvite } from "../../src/mail/invite.ts"
import { INVITE } from "./inviteFixture.ts"

/** HAL-3369: invitations read from iCalendar, and the iTIP REPLY. */
describe("reading an invitation (HAL-3369)", () => {
  it("reads the method, times, organizer and attendees, unfolding lines and unescaping text", () => {
    const invite = parseInvite(INVITE)
    expect(invite).toMatchObject({
      method: "REQUEST",
      uid: "7kukuqrfedlm2f9t2vb0b2nqjv@google.com",
      sequence: 2,
      summary: "Planning, Q4",
      location: "https://meet.example.org/abc-defg-hij",
      description: "Agenda:\n1. Budget\n2. Hiring",
      start: "2026-10-22T15:00:00",
      end: "2026-10-22T15:30:00",
      allDay: false,
      timeZone: "Africa/Lagos",
      organizer: { address: "grace@example.org", name: "Grace Hopper" },
      attendees: [
        { address: "sam@acme.test", name: "Sam Team", partstat: "NEEDS-ACTION", role: "REQ-PARTICIPANT" },
        { address: "grace@example.org", name: "Grace Hopper", partstat: "ACCEPTED" },
      ],
    })
  })

  it("reads all-day and UTC times, and nothing from a document without an event", () => {
    const allDay = parseInvite(
      INVITE.replace("DTSTART;TZID=Africa/Lagos:20261022T150000", "DTSTART;VALUE=DATE:20261022"),
    )
    expect(allDay).toMatchObject({ start: "2026-10-22", allDay: true })
    const utc = parseInvite(
      INVITE.replace("DTSTART;TZID=Africa/Lagos:20261022T150000", "DTSTART:20261022T140000Z"),
    )
    expect(utc?.start).toBe("2026-10-22T14:00:00Z")
    expect(parseInvite("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n")).toBeNull()
  })

  it("writes the REPLY with the same UID and SEQUENCE, the new PARTSTAT, folded lines", () => {
    const invite = parseInvite(INVITE)
    if (!invite) throw new Error("no invite")
    const reply = buildReply({
      invite,
      attendee: { address: "sam@acme.test", name: "Sam Team" },
      response: "accepted",
      now: Date.UTC(2026, 9, 18, 12, 0, 0),
    })
    expect(reply).toContain("METHOD:REPLY")
    expect(reply).toContain("UID:7kukuqrfedlm2f9t2vb0b2nqjv@google.com")
    expect(reply).toContain("SEQUENCE:2")
    expect(reply).toContain("DTSTAMP:20261018T120000Z")
    expect(reply).toContain('ATTENDEE;PARTSTAT=ACCEPTED;CN="Sam Team":mailto:sam@acme.test')
    expect(reply).toContain("SUMMARY:Planning\\, Q4")
    expect(reply.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true)
    // Read back, the reply is a REPLY for the same event, with the answer.
    const read = parseInvite(reply)
    expect(read).toMatchObject({ method: "REPLY", uid: invite.uid, attendees: [{ partstat: "ACCEPTED" }] })
  })
})
