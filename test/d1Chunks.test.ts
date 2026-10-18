import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { ADMIN, call, json } from "./helpers.ts"

/** HAL-3425: lists longer than D1 binds in one statement go in chunks. */
describe("chunked lookups", () => {
  it("lists a 200-contact page with every contact's topics", async () => {
    const tag = crypto.randomUUID().slice(0, 8)
    const topic = await json<{ id: string }>(
      await call("/v1/topics", {
        method: "POST",
        key: ADMIN,
        json: { name: `Chunk ${tag}`, doubleOptIn: false },
      }),
    )
    const statements: Array<D1PreparedStatement> = []
    for (let i = 0; i < 150; i++) {
      const id = `c_chunk_${tag}_${String(i).padStart(3, "0")}`
      statements.push(
        env.DB.prepare(
          "insert into contacts (id, email, status, fields) values (?, ?, 'subscribed', '{}')",
        ).bind(id, `chunk${i}-${tag}@example.net`),
        env.DB.prepare(
          "insert into subscriptions (contact_id, topic_id, state, source, changed_at) values (?, ?, 'subscribed', 'test', ?)",
        ).bind(id, topic.id, Date.now()),
      )
    }
    for (let i = 0; i < statements.length; i += 100) await env.DB.batch(statements.slice(i, i + 100))
    const res = await call(`/v1/contacts?q=${tag}&limit=200`, { key: ADMIN })
    expect(res.status).toBe(200)
    const page = await json<{ contacts: Array<{ topics: Array<{ topicId: string }> }> }>(res)
    expect(page.contacts).toHaveLength(150)
    expect(page.contacts.every((c) => c.topics.some((t) => t.topicId === topic.id))).toBe(true)
  })
})
