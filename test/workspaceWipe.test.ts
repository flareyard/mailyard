import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import {
  beginDeletion,
  deletionStatus,
  finishDeletion,
  tablesToWipe,
  wipeObjectsPage,
  wipeTablePage,
} from "../src/domain/workspaceDeletion.ts"
import { runtimeFor } from "../src/workers/inbound.ts"
import { ADMIN, call } from "./helpers.ts"

/**
 * The Workflow's steps, run here in order (HAL-3448). It lives in its own file because it empties
 * every table this file's storage holds.
 */
const run = <A>(effect: unknown) => runtimeFor(env).runPromise(effect as never) as Promise<A>

describe("the deletion itself (HAL-3448)", () => {
  it("does nothing early or after a restore, then empties R2 and every table, keeping the export and a tombstone", async () => {
    // Something to delete: a contact, a setting, objects in R2, and the deletion's export.
    await call("/v1/contacts", { method: "POST", key: ADMIN, json: { email: "wiped@example.net" } })
    await call("/v1/me", { key: ADMIN }) // mints the workspace id
    const workspaceId = (
      await env.DB.prepare("select value from settings where key = 'workspace'").first<{ value: string }>()
    )?.value
    const exportId = "exp_kept"
    await env.STORE.put(`exports/${exportId}/manifest.json`, "{}")
    await env.STORE.put(`exports/${exportId}/contacts.csv`, "email\n")
    await env.STORE.put("exports/exp_other.csv", "x")
    for (let i = 0; i < 5; i++) await env.STORE.put(`raw/${i}.eml`, "mail")

    // Not requested: nothing begins.
    expect(await run(beginDeletion())).toBeNull()
    const record = {
      requestedAt: Date.now() - 1000,
      requestedBy: "root",
      deletesAt: Date.now() + 60_000,
      exportId,
    }
    await env.DB.prepare("insert into settings (key, value, updated_at) values ('workspace_deletion', ?, ?)")
      .bind(JSON.stringify(record), Date.now())
      .run()
    // Not due yet: nothing begins.
    expect(await run(beginDeletion())).toBeNull()
    await env.DB.prepare("update settings set value = ? where key = 'workspace_deletion'")
      .bind(JSON.stringify({ ...record, deletesAt: Date.now() - 1 }))
      .run()
    const started = await run<{ startedAt: number }>(beginDeletion())
    expect(started.startedAt).toBeGreaterThan(0)
    // Once started it can't be called off.
    const restore = await call("/v1/workspace/restore", { method: "POST", key: ADMIN })
    expect(restore.status).toBe(409)

    let cursor: string | null = null
    do {
      const page: { cursor: string | null } = await run(wipeObjectsPage(exportId, cursor))
      cursor = page.cursor
    } while (cursor)
    const left = await env.STORE.list()
    expect(left.objects.map((o) => o.key).sort()).toEqual([
      `exports/${exportId}/contacts.csv`,
      `exports/${exportId}/manifest.json`,
    ])

    const tables = await run<string[]>(tablesToWipe())
    expect(tables).toContain("contacts")
    expect(tables).not.toContain("d1_migrations")
    expect(tables.some((t) => t.startsWith("_cf_") || t.startsWith("sqlite_"))).toBe(false)
    let pending = tables
    for (let pass = 0; pass < 5 && pending.length; pass++) {
      const blocked: string[] = []
      for (const table of pending) {
        for (;;) {
          const page = await run<{ deleted: number; blocked: boolean }>(wipeTablePage(table))
          if (page.blocked) {
            blocked.push(table)
            break
          }
          if (page.deleted === 0) break
        }
      }
      pending = blocked
    }
    expect(pending).toEqual([])
    for (const table of tables.filter((t) => t !== "settings")) {
      const n = await env.DB.prepare(`select count(*) as n from "${table}"`).first<{ n: number }>()
      expect({ table, n: n?.n }).toEqual({ table, n: 0 })
    }
    // A table name that isn't a plain identifier is never touched.
    expect(await run(wipeTablePage('contacts"; drop table x; --'))).toEqual({ deleted: 0, blocked: false })

    const tombstone = await run<{ completedAt: number; exportId: string }>(finishDeletion())
    expect(tombstone).toMatchObject({ exportId })
    const settings = await env.DB.prepare("select key from settings order by key").all<{ key: string }>()
    expect(settings.results.map((r) => r.key)).toEqual(["workspace", "workspace_deleted"])
    expect(
      (await env.DB.prepare("select value from settings where key = 'workspace'").first<{ value: string }>())
        ?.value,
    ).toBe(workspaceId)

    // The tombstone hands the owner fresh links to the export it kept; deleting again is refused.
    const status = await run<{ status: string; files: Array<{ name: string; url: string }> }>(
      deletionStatus({ keyId: "root", kind: "secret", scopes: ["admin"] }, "https://mailyard.test"),
    )
    expect(status.status).toBe("deleted")
    expect(status.files.map((f) => f.name).sort()).toEqual(["contacts.csv", "manifest.json"])
    expect(status.files[0]?.url).toMatch(/^https:\/\/mailyard\.test\/v1\/files\//)
    const file = await call(new URL(status.files[0]?.url ?? "").pathname)
    expect(file.status).toBe(200)
    const again = await call("/v1/workspace", { method: "DELETE", key: ADMIN, json: { confirm: "Mailyard" } })
    expect(again.status).toBe(409)
  })
})
