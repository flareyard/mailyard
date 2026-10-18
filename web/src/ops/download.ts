/**
 * Downloads from the API (CSV exports, raw messages): fetched with the session cookie, then handed to the
 * browser as a file. In fixture mode the request never leaves the page, so a small file says so instead.
 */
import { ApiError } from "../api/client.ts"
import { fixturesEnabled } from "../fixtures/mode.ts"

export async function fetchText(path: string): Promise<{ text: string; headers: Headers }> {
  if (fixturesEnabled()) {
    return {
      text: `# Fixture mode: ${path} is downloaded from the live API.\n`,
      headers: new Headers({ "content-type": "text/plain" }),
    }
  }
  const r = await fetch(path, { credentials: "same-origin" })
  if (!r.ok) {
    let body: Record<string, unknown> = {}
    try {
      body = (await r.json()) as Record<string, unknown>
    } catch {
      body = { message: r.statusText }
    }
    throw new ApiError(r.status, body)
  }
  return { text: await r.text(), headers: r.headers }
}

export function saveFile(name: string, text: string, type = "text/csv") {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement("a")
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Fetches `path` and saves it as `name`. Returns the response headers (an export may say `x-truncated`). */
export async function download(path: string, name: string, type = "text/csv"): Promise<Headers> {
  const { text, headers } = await fetchText(path)
  saveFile(name, text, type)
  return headers
}

/** A query string from the set values only. */
export function qs(params: Record<string, string | number | null | undefined>): string {
  const u = new URLSearchParams()
  for (const [k, v] of Object.entries(params))
    if (v !== null && v !== undefined && v !== "") u.set(k, String(v))
  const s = u.toString()
  return s ? `?${s}` : ""
}
