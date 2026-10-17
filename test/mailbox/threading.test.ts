import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { linkIds, SUBJECT_WINDOW_MS, subjectKey, subjectLinked } from "../../src/mailbox/threading.ts"
import { delivery, freshMailbox } from "./deliveries.ts"

describe("subjectKey", () => {
  it.each([
    ["Re: Budget", "budget", true],
    ["RE: re: Fwd: Budget", "budget", true],
    ["AW: Budget", "budget", true],
    ["Re[2]: Budget", "budget", true],
    ["[team] Re: [team] Budget  review", "budget review", true],
    ["Budget", "budget", false],
    ["Regarding the budget", "regarding the budget", false],
    ["  ", "", false],
  ])("%s → %s", (subject, key, reply) => {
    expect(subjectKey(subject)).toEqual({ key, reply })
  })
})

describe("subjectLinked", () => {
  const base = { subjectKey: "budget", reply: false, headerless: false, sentAt: 0 }
  it("links a header-less reply to the same subject inside the window, in either order", () => {
    const reply = { ...base, reply: true, headerless: true, sentAt: SUBJECT_WINDOW_MS }
    expect(subjectLinked(base, reply)).toBe(true)
    expect(subjectLinked(reply, base)).toBe(true)
  })
  it("doesn't link outside the window, without a reply prefix, or when headers exist", () => {
    expect(
      subjectLinked(base, { ...base, reply: true, headerless: true, sentAt: SUBJECT_WINDOW_MS + 1 }),
    ).toBe(false)
    expect(subjectLinked(base, { ...base, headerless: true })).toBe(false)
    expect(subjectLinked(base, { ...base, reply: true })).toBe(false)
    expect(
      subjectLinked({ ...base, subjectKey: "" }, { ...base, subjectKey: "", reply: true, headerless: true }),
    ).toBe(false)
  })
})

describe("linkIds", () => {
  it("normalises and deduplicates the ids a message links through", () => {
    expect(
      linkIds({ messageId: "<A@x>", inReplyTo: "<b@x>", references: ["<a@x>", "<B@x>", "<c@x>"] }),
    ).toEqual(["<a@x>", "<b@x>", "<c@x>"])
  })
})

// ---------------------------------------------------------------------------------------------
// Property: any arrival order of a set of conversations yields the same threads.
// ---------------------------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000
const T0 = Date.parse("2026-10-01T09:00:00Z")

type Shape = "full" | "parent-only" | "truncated" | "headerless"

interface Generated {
  readonly conversation: number
  readonly delivery: ReturnType<typeof delivery>
}

/**
 * A conversation is a reply tree. Each reply keeps its headers in one of four ways real clients do:
 * all References, only In-Reply-To, the last few References, or none at all with a "Re:" subject,
 * which the subject fallback has to catch. Conversations that share a subject never drop headers, so
 * the fallback must not join them.
 */
const conversation = (index: number, sharedSubject: boolean) =>
  fc
    .array(fc.tuple(fc.nat(), fc.constantFrom<Shape>("full", "parent-only", "truncated", "headerless")), {
      minLength: 0,
      maxLength: 6,
    })
    .map((replies) => {
      const subject = sharedSubject ? "Weekly sync" : `Topic ${index}`
      const ids = [`<c${index}m0@example.org>`]
      const ancestry: Array<Array<string>> = [[]]
      const out: Array<Generated> = [
        {
          conversation: index,
          delivery: delivery({
            id: `inb_c${index}m0`,
            messageId: ids[0] ?? null,
            subject,
            date: T0 + index * 400 * HOUR,
          }),
        },
      ]
      replies.forEach(([pick, shape], i) => {
        const n = i + 1
        const parent = pick % n
        const own = `<c${index}m${n}@example.org>`
        const chain = [...(ancestry[parent] ?? []), ids[parent] ?? ""]
        ids.push(own)
        ancestry.push(chain)
        const headerless = shape === "headerless" && !sharedSubject
        const references =
          headerless || shape === "parent-only" ? [] : shape === "truncated" ? chain.slice(-1) : chain
        out.push({
          conversation: index,
          delivery: delivery({
            id: `inb_c${index}m${n}`,
            messageId: own,
            inReplyTo: headerless ? null : (ids[parent] ?? null),
            references,
            subject: `Re: ${subject}`,
            date: T0 + index * 400 * HOUR + n * HOUR,
          }),
        })
      })
      return out
    })

const scenario = fc
  .tuple(fc.integer({ min: 1, max: 3 }), fc.boolean())
  .chain(([count, shareSubject]) =>
    fc.tuple(...Array.from({ length: count }, (_, i) => conversation(i, shareSubject && count > 1))),
  )
  .map((conversations) => conversations.flat())
  .chain((messages) =>
    fc.tuple(
      fc.constant(messages),
      fc.shuffledSubarray(messages, { minLength: messages.length, maxLength: messages.length }),
    ),
  )

const partition = (groups: Map<string, Array<string>>) =>
  [...groups.values()].map((g) => [...g].sort().join(",")).sort()

describe("threading is independent of arrival order", () => {
  it("files every conversation as exactly one thread, whatever order its messages arrive in", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async ([messages, order]) => {
        const mailbox = freshMailbox()
        for (const m of order) await mailbox.deliver(m.delivery)
        const actual = new Map<string, Array<string>>()
        for (const m of messages) {
          const stored = await mailbox.message(m.delivery.id)
          if (!stored) throw new Error(`lost ${m.delivery.id}`)
          actual.set(stored.threadId, [...(actual.get(stored.threadId) ?? []), m.delivery.id])
        }
        const expected = new Map<string, Array<string>>()
        for (const m of messages) {
          expected.set(String(m.conversation), [
            ...(expected.get(String(m.conversation)) ?? []),
            m.delivery.id,
          ])
        }
        expect(partition(actual)).toEqual(partition(expected))
        const { threads } = await mailbox.threads({ limit: 200 })
        expect(threads.length).toBe(expected.size)
        expect(threads.reduce((sum, t) => sum + t.messageCount, 0)).toBe(messages.length)
      }),
      { numRuns: 60 },
    )
  }, 120_000)
})
