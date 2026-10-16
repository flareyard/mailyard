import { describe, expect, it } from "vitest"
import { CONSUMED_QUEUES } from "../src/workers/queue.ts"
import config from "../wrangler.jsonc?raw"

/** JSONC to JSON: drop // comments that are not inside strings. */
const parseJsonc = (text: string) =>
  JSON.parse(text.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*/g, (_, s: string | undefined) => s ?? ""))

describe("wrangler.jsonc queues", () => {
  const wrangler = parseJsonc(config) as {
    queues: {
      producers: Array<{ binding: string; queue: string }>
      consumers: Array<{ queue: string; dead_letter_queue?: string; max_retries?: number }>
    }
  }

  it("binds a consumer, with a dead-letter queue, for every queue queue.ts routes", () => {
    const consumers = new Map(wrangler.queues.consumers.map((c) => [c.queue, c]))
    for (const queue of CONSUMED_QUEUES) {
      expect(consumers.get(queue), `no consumer for ${queue}`).toBeDefined()
      expect(consumers.get(queue)?.dead_letter_queue).toBe(`${queue}-dlq`)
    }
    expect([...consumers.keys()].sort()).toEqual([...CONSUMED_QUEUES].sort())
  })

  it("produces to every queue the Worker sends to itself", () => {
    expect(wrangler.queues.producers.map((p) => p.queue).sort()).toEqual(
      ["mailyard-inbound", "mailyard-send", "mailyard-webhooks"].sort(),
    )
  })
})
