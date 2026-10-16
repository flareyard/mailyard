import { exports } from "cloudflare:workers"

export const ADMIN = "test-admin-key"

export const call = (path: string, init: RequestInit & { key?: string; json?: unknown } = {}) => {
  const headers = new Headers(init.headers)
  if (init.key) headers.set("authorization", `Bearer ${init.key}`)
  if (init.json !== undefined) headers.set("content-type", "application/json")
  return exports.default.fetch(
    new Request(`https://mailflare.test${path}`, {
      ...init,
      headers,
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
    }),
  )
}

export const json = async <T = Record<string, unknown>>(response: Response) => (await response.json()) as T

export const createKey = async (kind: "secret" | "public", scopes?: Array<string>) => {
  const response = await call("/v1/api-keys", {
    method: "POST",
    key: ADMIN,
    json: { name: `${kind} test key`, kind, ...(scopes ? { scopes } : {}) },
  })
  if (response.status !== 200) throw new Error(`create key: ${response.status} ${await response.text()}`)
  return await json<{ key: string; apiKey: { id: string } }>(response)
}
