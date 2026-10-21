/**
 * One cache key, one shape (2026-10-21). The founder hit "can't access property 'length', e.domains is
 * undefined" and "… data.imports is undefined" on the live app: first-run's queries stored the bare list
 * under ["domains"] and ["mailboxes", id, "imports"], while Overview, Domains, Settings and Mail store the
 * API's whole response under the same keys. Whichever screen loaded first decided what the others read.
 *
 * Rule: a queryFn returns the API's response untouched. A screen that wants a list or a filter uses
 * `select`, which shapes its own copy and never the cache. This test finds every key defined with a
 * queryFn and fails when two definitions fetch different endpoints or one reshapes inside the queryFn.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const SRC = path.join(import.meta.dirname, "..")

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) return name === "fixtures" ? [] : files(p)
    return /\.tsx?$/.test(name) && !/\.test\.|fixture|\.d\.ts$/i.test(name) ? [p] : []
  })

type Def = { at: string; endpoint: string; reshapes: boolean }

/** Every `queryKey: [...]` written with a `queryFn` beside it. */
const DEF = /queryKey:\s*(\[[^\]]*\])\s*,\s*queryFn:\s*/g

/** The queryFn's own text: read with bracket balancing until the property ends, so nothing after it counts. */
const fnText = (source: string, from: number) => {
  let depth = 0
  for (let i = from; i < source.length; i++) {
    const c = source[i]
    if (c === "(" || c === "[" || c === "{") depth++
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return source.slice(from, i)
      depth--
    } else if (c === "," && depth === 0) return source.slice(from, i)
  }
  return source.slice(from)
}

/** A queryFn that hands the cache something other than the response: a picked field, a list helper, a map. */
const RESHAPES = /\barr<|\)\)?\?\.\w+|\)\)\.\w+(?!\()|\.(map|filter)\(|\?\?\s*(\[\]|null)/

const definitions = () => {
  const byKey = new Map<string, Def[]>()
  for (const file of files(SRC)) {
    const source = readFileSync(file, "utf8")
    for (const m of source.matchAll(DEF)) {
      const key = (m[1] ?? "").replace(/\s+/g, " ")
      const fn = fnText(source, (m.index ?? 0) + m[0].length).replace(/\s+/g, " ")
      const def: Def = {
        at: `${path.relative(SRC, file)}:${source.slice(0, m.index).split("\n").length}`,
        endpoint: fn.match(/api\.\w+\("([^"]+)"/)?.[1] ?? "?",
        reshapes: RESHAPES.test(fn),
      }
      byKey.set(key, [...(byKey.get(key) ?? []), def])
    }
  }
  return byKey
}

describe("query keys", () => {
  it("never cache a reshaped response", () => {
    const reshaped = [...definitions().values()].flat().filter((d) => d.reshapes && d.endpoint !== "?")
    expect(reshaped.map((d) => `${d.at} ${d.endpoint}`)).toEqual([])
  })

  it("never share a key between different endpoints", () => {
    const clashes = [...definitions()]
      .filter(([, defs]) => new Set(defs.map((d) => d.endpoint).filter((e) => e !== "?")).size > 1)
      .map(([key, defs]) => `${key}: ${defs.map((d) => `${d.at} ${d.endpoint}`).join(" | ")}`)
    expect(clashes).toEqual([])
  })
})
