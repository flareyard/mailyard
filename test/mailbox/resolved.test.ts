import { describe, expect, it } from "vitest"
import { delivery, freshMailbox } from "./deliveries.ts"

/** HAL-3392: when a conversation is resolved, for resolution times. */
const HOUR = 3_600_000

describe("a conversation's resolution (HAL-3392)", () => {
  it("is set when its last open message is archived, cleared when mail arrives, and set again", async () => {
    const box = freshMailbox()
    const now = Date.now()
    const first = (await box.deliver(
      delivery({ messageId: "<r1@x>", subject: "Refund", receivedAt: now - 5 * HOUR }),
    )) as { threadId: string }
    const threadId = first.threadId
    const resolvedAt = async () => (await box.thread(threadId))?.thread.resolvedAt ?? null
    expect(await resolvedAt()).toBeNull()

    // Snoozed is still open.
    await box.snooze(threadId, now + HOUR)
    expect(await resolvedAt()).toBeNull()
    await box.unsnooze(threadId)

    const before = Date.now()
    await box.updateThreads([threadId], { folder: "archive" })
    const resolved = await resolvedAt()
    expect(resolved).toBeGreaterThanOrEqual(before)

    // Archiving again (it's already resolved) keeps the first resolution.
    await box.updateThreads([threadId], { folder: "archive" })
    expect(await resolvedAt()).toBe(resolved)

    // A reply arrives: open again.
    await box.deliver(
      delivery({ messageId: "<r2@x>", inReplyTo: "<r1@x>", references: ["<r1@x>"], subject: "Re: Refund" }),
    )
    expect(await resolvedAt()).toBeNull()
    // Moved back to the inbox by hand works the same way; archived once more resolves it again.
    await box.updateThreads([threadId], { folder: "archive" })
    expect(await resolvedAt()).toBeGreaterThanOrEqual(resolved ?? 0)
    await box.updateThreads([threadId], { folder: "inbox" })
    expect(await resolvedAt()).toBeNull()
  })

  it("never resolves mail that was never open, or that went to the trash", async () => {
    const box = freshMailbox()
    const imported = (await box.deliver(delivery({ messageId: "<old@x>" }), "archive")) as {
      threadId: string
    }
    expect((await box.thread(imported.threadId))?.thread.resolvedAt).toBeNull()
    const binned = (await box.deliver(delivery({ messageId: "<bin@x>" }))) as { threadId: string }
    await box.updateThreads([binned.threadId], { folder: "trash" })
    expect((await box.thread(binned.threadId))?.thread.resolvedAt).toBeNull()
  })

  it("gives resolution medians per assignee", async () => {
    const box = freshMailbox()
    const now = Date.now()
    const a = (await box.deliver(delivery({ messageId: "<m1@x>", receivedAt: now - 4 * HOUR }))) as {
      threadId: string
    }
    const b = (await box.deliver(delivery({ messageId: "<m2@x>", receivedAt: now - 2 * HOUR }))) as {
      threadId: string
    }
    await box.deliver(delivery({ messageId: "<m3@x>", receivedAt: now - HOUR }))
    await box.updateThreads([a.threadId, b.threadId], { folder: "archive" })
    const times = await box.responseTimes({ from: now - 24 * HOUR, to: now + HOUR })
    const row = times.find((t) => t.assignee === null)
    expect(row).toMatchObject({ threads: 3, resolved: 2 })
    // Resolved just now: about 4 and 2 hours after they arrived, so a median near 3 hours.
    expect(row?.resolutionMedianMs).toBeGreaterThan(2.9 * HOUR)
    expect(row?.resolutionMedianMs).toBeLessThan(3.1 * HOUR)
  })
})
