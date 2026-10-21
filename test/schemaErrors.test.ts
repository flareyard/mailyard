import { describe, expect, it } from "vitest"
import { RAW_PATHS } from "../src/http/rawRoutes.ts"
import { ADMIN, call, createKey, json } from "./helpers.ts"

type Invalid = { _tag: string; message: string; field?: string; requestId?: string }

const expectInvalid = async (response: Response, field?: string) => {
  expect(response.status).toBe(400)
  expect(response.headers.get("content-type")).toContain("application/json")
  const body = await json<Invalid>(response)
  expect(body._tag).toBe("InvalidRequest")
  expect(body.message.length).toBeGreaterThan(20)
  expect(body.requestId).toBe(response.headers.get("x-request-id"))
  if (field) expect(body.field).toBe(field)
  return body
}

describe("a request that fails the API's schema (HAL-3781)", () => {
  it("says what's wrong in the body", async () => {
    const { key } = await createKey("secret", ["send"])
    const send = (body: unknown) => call("/v1/send", { method: "POST", key, json: body })
    const from = await expectInvalid(
      await send({ to: "a@example.com", from: "Acme <x@acme.com>", subject: "s", body: "b" }),
      "from",
    )
    expect(from.message).toContain("from: Expected an email address")
    await expectInvalid(await send({}), "to")
    await expectInvalid(
      await call("/v1/send", {
        method: "POST",
        key,
        headers: { "content-type": "application/json" },
        body: "{",
      }),
    )
  })

  it("says what's wrong in the query and the headers", async () => {
    const query = await expectInvalid(
      await call("/v1/mailboxes/x/threads?folder=nope", { key: ADMIN }),
      "folder",
    )
    expect(query.message).toContain("query")
    const { key } = await createKey("secret", ["send"])
    const header = await call("/v1/send", {
      method: "POST",
      key,
      headers: { "idempotency-key": "k".repeat(300) },
      json: { to: "a@example.com", subject: "s", body: "b" },
    })
    expect((await expectInvalid(header, "idempotency-key")).message).toContain("header")
  })

  it("never answers an endpoint's bad JSON body with an empty 4xx", async () => {
    const doc = await json<{
      paths: Record<string, Record<string, { requestBody?: { content?: Record<string, unknown> } }>>
    }>(await call("/openapi.json"))
    const targets = Object.entries(doc.paths).flatMap(([path, item]) =>
      (["post", "put", "patch"] as const)
        .filter((m) => item[m]?.requestBody?.content?.["application/json"])
        .map((m) => ({ method: m.toUpperCase(), path: path.replace(/\{[^}]+\}/g, "x") })),
    )
    expect(targets.length).toBeGreaterThan(80)
    const empty: Array<string> = []
    for (const t of targets) {
      const res = await call(t.path, { method: t.method, key: ADMIN, json: "not an object" })
      if (res.status >= 400 && res.status < 500 && !(res.headers.get("content-type") ?? "").includes("json"))
        empty.push(`${t.method} ${t.path} → ${res.status}`)
    }
    expect(empty).toEqual([])
  })

  it("is declared in /openapi.json wherever input is decoded", async () => {
    const doc = await json<{
      paths: Record<
        string,
        Record<
          string,
          { requestBody?: unknown; parameters?: Array<unknown>; responses?: Record<string, unknown> }
        >
      >
    }>(await call("/openapi.json"))
    // The byte and socket routes (rawRoutes.ts) are served beside HttpApi and never decode a schema.
    const raw = new Set(Object.keys(RAW_PATHS))
    const undeclared = Object.entries(doc.paths)
      .filter(([path]) => !raw.has(path))
      .flatMap(([path, item]) =>
        (["get", "post", "put", "patch", "delete"] as const)
          .filter((m) => {
            const op = item[m]
            return op && (op.requestBody || (op.parameters?.length ?? 0) > 0) && !op.responses?.["400"]
          })
          .map((m) => `${m.toUpperCase()} ${path}`),
      )
    expect(undeclared).toEqual([])
  })
})
