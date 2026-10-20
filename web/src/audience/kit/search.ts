/**
 * Search params that read like the API's (HAL-3310): a list of plain strings is written as the key repeated
 * (`field=plan:eq:pro&field=country:eq:NG`), exactly as `GET /v1/contacts` takes it, instead of a JSON array;
 * commas, colons, `!` and `@` stay readable. Everything else is the router's default (JSON for objects).
 * Reading is the default too: repeated keys already come back as an array.
 */
import { defaultParseSearch, defaultStringifySearch } from "@tanstack/react-router"

const plainList = (v: unknown): v is string[] =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.every((x) => typeof x === "string" && !/^(?:\s|["[{\d-]|fa|nu|tr)/.test(x))

const READABLE: Record<string, string> = { "%2C": ",", "%3A": ":", "%21": "!", "%40": "@" }

export function stringifySearch(search: Record<string, unknown>): string {
  const rest: Record<string, unknown> = {}
  const lists: [string, string[]][] = []
  for (const [k, v] of Object.entries(search)) {
    if (plainList(v)) lists.push([k, v])
    else rest[k] = v
  }
  const base = defaultStringifySearch(rest).replace(/^\?/, "")
  const extra = new URLSearchParams()
  for (const [k, vs] of lists) for (const v of vs) extra.append(k, v)
  const all = [base, extra.toString()].filter(Boolean).join("&")
  const pretty = all.replace(/%2C|%3A|%21|%40/gi, (m) => READABLE[m.toUpperCase()] ?? m)
  return pretty ? `?${pretty}` : ""
}

export const parseSearch = defaultParseSearch
