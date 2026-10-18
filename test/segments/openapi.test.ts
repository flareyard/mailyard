import { describe, expect, it } from "vitest"
import { ADMIN, call, json } from "../helpers.ts"

/** HAL-3427: segment request bodies name the rule tree's schema, so generated clients type it. */
describe("segment rule bodies in the OpenAPI document", () => {
  it("point filter at the SegmentRule component", async () => {
    const doc = await json<{
      paths: Record<string, Record<string, { requestBody?: { content: Record<string, { schema: any }> } }>>
      components: { schemas: Record<string, unknown> }
    }>(await call("/openapi.json"))
    expect(doc.components.schemas.SegmentRule).toBeDefined()
    for (const [path, method] of [
      ["/v1/segments", "post"],
      ["/v1/segments/{id}", "patch"],
      ["/v1/segments/preview", "post"],
    ] as const) {
      const schema = doc.paths[path]?.[method]?.requestBody?.content["application/json"]?.schema
      expect({ path, filter: schema?.properties?.filter?.$ref }).toEqual({
        path,
        filter: "#/components/schemas/SegmentRule",
      })
    }
  })

  it("still decodes the tree in the segment code, naming the rule at fault", async () => {
    const res = await call("/v1/segments/preview", {
      method: "POST",
      key: ADMIN,
      json: { filter: { type: "group", combinator: "and", rules: [{ type: "field", field: "plan" }] } },
    })
    expect(res.status).toBe(400)
    expect((await json<{ field: string }>(res)).field).toMatch(/^filter/)
  })
})
