import { describe, expect, it } from "vitest"
import { noteResponse, parseDeletingHeader, setDeleting } from "./deletion.ts"

const at = "2026-10-25T17:48:00.000Z"
const json = (headers: Record<string, string> = {}, status = 200) =>
  new Response("{}", { status, headers: { "content-type": "application/json", ...headers } })

describe("x-workspace-deleting", () => {
  it("parses the ISO deletion time, and nothing else", () => {
    expect(parseDeletingHeader(at)).toBe(Date.parse(at))
    expect(parseDeletingHeader(null)).toBeNull()
    expect(parseDeletingHeader("")).toBeNull()
    expect(parseDeletingHeader("soon")).toBeNull()
  })

  it("follows every JSON answer, refusals included, and clears when the header goes", async () => {
    const seen: (number | null)[] = []
    const mod = await import("./deletion.ts")
    const off = mod.subscribeForTests(() => seen.push(mod.peekForTests()))
    noteResponse(json({ "x-workspace-deleting": at }))
    noteResponse(json({ "x-workspace-deleting": at }, 409))
    noteResponse(new Response("<html>", { status: 502, headers: { "content-type": "text/html" } }))
    noteResponse(json())
    off()
    expect(seen).toEqual([Date.parse(at), null])
    setDeleting(Date.parse(at))
    setDeleting(null)
    expect(mod.peekForTests()).toBeNull()
  })
})
