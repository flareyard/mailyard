import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { ADMIN, call, json } from "../helpers.ts"

/**
 * HAL-3292: a segment preview over 100k contacts answers in under 200 ms. Opt-in (BENCH=1), because
 * timings taken while the whole suite runs in parallel measure the machine, not the query.
 */
const bench = (env as unknown as { BENCH?: string }).BENCH === "1"

describe.runIf(bench)("segment preview at 100k contacts", () => {
  it("counts and samples a realistic segment in under 200 ms", async () => {
    await env.DB.prepare(
      `with recursive n(i) as (select 1 union all select i + 1 from n where i < 100000)
       insert into contacts (id, email, fields, status, created_at, last_event_at)
       select printf('bench_%06d', i), printf('person%06d@bench.test', i),
              json_object('plan', case i % 3 when 0 then 'free' when 1 then 'pro' else 'team' end, 'seats', i % 50),
              case when i % 10 = 0 then 'unsubscribed' else 'subscribed' end,
              (unixepoch('subsec') * 1000) - (i % 400) * 86400000,
              case when i % 4 = 0 then null else (unixepoch('subsec') * 1000) - (i % 120) * 86400000 end
       from n`,
    ).run()
    const filter = {
      type: "all",
      rules: [
        { type: "status", in: ["subscribed"] },
        { type: "field", field: "plan", op: "eq", value: "pro" },
        {
          type: "any",
          rules: [
            { type: "engagement", in: ["active"] },
            { type: "field", field: "seats", op: "gte", value: 40 },
          ],
        },
      ],
    }
    // Saving it creates the field's index, as a real segment would.
    await call("/v1/segments", { method: "POST", key: ADMIN, json: { name: "Bench", filter } })
    const times: Array<number> = []
    let count = 0
    for (let i = 0; i < 5; i++) {
      const started = performance.now()
      const response = await call("/v1/segments/preview", { method: "POST", key: ADMIN, json: { filter } })
      count = (await json<{ count: number }>(response)).count
      times.push(performance.now() - started)
    }
    times.sort((a, b) => a - b)
    const median = times[2] ?? 0
    console.log(
      `segment preview over 100k contacts: median ${median.toFixed(1)} ms, all ${times.map((t) => t.toFixed(0)).join(", ")} ms, ${count} matches`,
    )
    expect(count).toBeGreaterThan(0)
    expect(median).toBeLessThan(200)
  }, 300_000)
})
