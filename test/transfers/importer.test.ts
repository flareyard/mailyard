import { env } from "cloudflare:workers"
import { Effect, Layer } from "effect"
import { beforeAll, describe, expect, it } from "vitest"
import { SecretBox } from "../../src/domain/webhooks.ts"
import { finishImport, ImapConnector, planImport, runBatch } from "../../src/imports/importer.ts"
import { appLayer } from "../../src/layers.ts"

type AppServices = Layer.Success<ReturnType<typeof appLayer>>

import { installDohFixture } from "../dns.ts"
import { ADMIN, call, json } from "../helpers.ts"
import { type FakeFolder, fakeImap } from "../imap/fakeServer.ts"

installDohFixture()

const raw = (id: string, subject: string, extra = "") =>
  `From: Ada <ada@example.org>\r\nTo: sam@example.test\r\nSubject: ${subject}\r\nDate: Fri, 16 Oct 2026 10:00:00 +0000\r\nMessage-ID: <${id}@example.org>\r\n${extra}\r\nBody of ${subject}.\r\n`

/** Runs importer steps against the fake server, everything else being the real app. */
const withServer = (server: ReturnType<typeof fakeImap>) => {
  const connector = Layer.succeed(
    ImapConnector,
    ImapConnector.of({ open: () => Effect.succeed(server.transport()) }),
  )
  return <A, E>(effect: Effect.Effect<A, E, AppServices>) =>
    Effect.runPromise(effect.pipe(Effect.provide(connector), Effect.provide(appLayer(env))))
}

let mailboxId = ""
beforeAll(async () => {
  const domain = `import-${crypto.randomUUID().slice(0, 8)}.test`
  await call("/v1/domains", { method: "POST", key: ADMIN, json: { name: domain } })
  const box = await json<{ id: string; address: string }>(
    await call("/v1/mailboxes", {
      method: "POST",
      key: ADMIN,
      json: { address: `sam@${domain}`, kind: "user" },
    }),
  )
  mailboxId = box.id
})

const newImport = async (
  mailbox: string,
  fields: { username: string; password: string; mode?: "full" | "catchup" },
) => {
  const id = `imx_test_${crypto.randomUUID().slice(0, 8)}`
  const sealed = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* SecretBox).seal(fields.password)
    }).pipe(Effect.provide(appLayer(env))),
  )
  await env.DB.prepare(
    "insert into mailbox_imports (id, mailbox_id, source, mode, host, port, username, secret_ciphertext, status) values (?, ?, 'imap', ?, 'imap.example.test', 993, ?, ?, 'pending')",
  )
    .bind(id, mailbox, fields.mode ?? "full", fields.username, sealed)
    .run()
  return id
}

const run = async (exec: ReturnType<typeof withServer>, importId: string) => {
  const plan = await exec(planImport(importId))
  for (const [f, folder] of plan.folders.entries()) {
    for (let b = 0; b < folder.batches; b++) await exec(runBatch(importId, f, b))
  }
  await exec(finishImport(importId))
  return plan
}

const row = (id: string) =>
  env.DB.prepare("select * from mailbox_imports where id = ?")
    .bind(id)
    .first<{ status: string; secret_ciphertext: string | null; progress: string }>()

const box = () => env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId))

describe("IMAP import", () => {
  const folders: Array<FakeFolder> = [
    {
      name: "INBOX",
      uidValidity: 7,
      messages: [
        { uid: 1, raw: raw("in1", "Hello"), flags: ["\\Seen"] },
        { uid: 2, raw: raw("in2", "Important"), flags: ["\\Flagged", "\\Answered"] },
        { uid: 3, raw: raw("in3", "Going away"), flags: ["\\Deleted"] },
        // The same message also filed in Projects/Acme below.
        { uid: 4, raw: raw("shared", "Acme kickoff") },
      ],
    },
    { name: "Sent", flags: ["\\Sent"], messages: [{ uid: 1, raw: raw("sent1", "Re: Hello") }] },
    { name: "Drafts", flags: ["\\Drafts"], messages: [{ uid: 1, raw: raw("draft1", "Unfinished") }] },
    {
      name: "Projects/Acme",
      messages: [
        { uid: 9, raw: raw("shared", "Acme kickoff") },
        { uid: 10, raw: raw("acme2", "Acme budget") },
      ],
    },
  ]

  it("copies every folder with its flags, labels custom folders, skips drafts and deleted mail, and accounts for everything", async () => {
    const server = fakeImap({ username: "sam", password: "s3cret", folders })
    const exec = withServer(server)
    const id = await newImport(mailboxId, { username: "sam", password: "s3cret" })
    const plan = await run(exec, id)
    expect(plan.folders.map((f) => f.name)).toEqual(["INBOX", "Sent", "Projects/Acme"])

    const done = await row(id)
    expect(done?.status).toBe("complete")
    expect(done?.secret_ciphertext).toBeNull()
    const progress = JSON.parse(done?.progress ?? "[]") as Array<Record<string, unknown>>
    expect(progress.map((p) => [p.name, p.source, p.imported, p.duplicates, p.skipped, p.lastUid])).toEqual([
      ["INBOX", 4, 3, 0, 1, 4],
      ["Sent", 1, 1, 0, 0, 1],
      ["Projects/Acme", 2, 1, 1, 0, 10],
    ])

    const all = (await box().messages({ limit: 200 })).messages
    expect(all.map((m) => m.subject).sort()).toEqual([
      "Acme budget",
      "Acme kickoff",
      "Hello",
      "Important",
      "Re: Hello",
    ])
    const bySubject = new Map(all.map((m) => [m.subject, m]))
    expect(bySubject.get("Hello")).toMatchObject({ folder: "inbox", seen: true, starred: false })
    expect(bySubject.get("Important")).toMatchObject({
      folder: "inbox",
      seen: false,
      starred: true,
      answered: true,
    })
    expect(bySubject.get("Re: Hello")).toMatchObject({ folder: "sent", seen: true })
    const labels = await box().labels()
    const acme = labels.find((l) => l.name === "Projects/Acme")
    expect(acme).toBeDefined()
    // The kickoff stays in the inbox (where it was first) and gains the Acme label from its second copy.
    expect(bySubject.get("Acme kickoff")).toMatchObject({ folder: "inbox", labelIds: [acme?.id] })
    expect(bySubject.get("Acme budget")).toMatchObject({ folder: "archive", labelIds: [acme?.id] })
    // Read-only on the source, the whole way through.
    expect(server.log.some((c) => /^(SELECT|STORE|UID STORE|EXPUNGE|COPY|MOVE)/i.test(c))).toBe(false)
  })

  it("batches large folders and catches up later with only what's new", async () => {
    const domain = `catchup-${crypto.randomUUID().slice(0, 8)}.test`
    await call("/v1/domains", { method: "POST", key: ADMIN, json: { name: domain } })
    const target = await json<{ id: string }>(
      await call("/v1/mailboxes", {
        method: "POST",
        key: ADMIN,
        json: { address: `x@${domain}`, kind: "user" },
      }),
    )
    const many = Array.from({ length: 60 }, (_, i) => ({ uid: i + 1, raw: raw(`bulk${i}`, `Bulk ${i}`) }))
    const inbox = { name: "INBOX", uidValidity: 3, messages: many }
    const first = withServer(fakeImap({ username: "u", password: "p", folders: [inbox] }))
    const firstId = await newImport(target.id, { username: "u", password: "p" })
    const plan = await run(first, firstId)
    expect(plan.folders[0]?.batches).toBe(2)
    expect(await env.MAILBOX.get(env.MAILBOX.idFromName(target.id)).count()).toBe(60)

    // Two new messages arrive at the old provider before the MX switch.
    const server = fakeImap({
      username: "u",
      password: "p",
      folders: [
        {
          ...inbox,
          messages: [
            ...many,
            { uid: 61, raw: raw("late1", "Late 1") },
            { uid: 62, raw: raw("late2", "Late 2") },
          ],
        },
      ],
    })
    const catchupId = await newImport(target.id, { username: "u", password: "p", mode: "catchup" })
    await run(withServer(server), catchupId)
    expect(server.log).toContain("UID SEARCH UID 61:*")
    const progress = JSON.parse((await row(catchupId))?.progress ?? "[]") as Array<{
      source: number
      imported: number
    }>
    expect(progress[0]).toMatchObject({ source: 2, imported: 2 })
    expect(await env.MAILBOX.get(env.MAILBOX.idFromName(target.id)).count()).toBe(62)

    // A server that renumbered (UIDVALIDITY changed) gets a full pass; nothing is stored twice.
    const renumbered = fakeImap({
      username: "u",
      password: "p",
      folders: [{ name: "INBOX", uidValidity: 99, messages: many.slice(0, 5) }],
    })
    const resyncId = await newImport(target.id, { username: "u", password: "p", mode: "catchup" })
    await run(withServer(renumbered), resyncId)
    expect(renumbered.log).toContain("UID SEARCH UID 1:*")
    expect(JSON.parse((await row(resyncId))?.progress ?? "[]")[0]).toMatchObject({
      source: 5,
      imported: 0,
      duplicates: 5,
    })
    expect(await env.MAILBOX.get(env.MAILBOX.idFromName(target.id)).count()).toBe(62)
  })

  it("fails with a clear message on a wrong password", async () => {
    const exec = withServer(fakeImap({ username: "u", password: "right", folders: [] }))
    const id = await newImport(mailboxId, { username: "u", password: "wrong" })
    await expect(exec(planImport(id))).rejects.toMatchObject({ _tag: "ImportFailed" })
  })

  it("files a re-run batch once: the same batch twice stores nothing twice", async () => {
    const server = fakeImap({
      username: "u",
      password: "p",
      folders: [{ name: "INBOX", messages: [{ uid: 1, raw: raw("again", "Again") }] }],
    })
    const exec = withServer(server)
    const id = await newImport(mailboxId, { username: "u", password: "p" })
    await exec(planImport(id))
    const before = await box().count()
    await exec(runBatch(id, 0, 0))
    await exec(runBatch(id, 0, 0))
    expect(await box().count()).toBe(before + 1)
  })
})

describe("/v1/mailboxes/{id}/imports", () => {
  it("validates requests, starts a Workflow, never shows the password, and cancels", async () => {
    const base = `/v1/mailboxes/${mailboxId}/imports`
    const bad = async (body: Record<string, unknown>) =>
      expect((await call(base, { method: "POST", key: ADMIN, json: body })).status).toBe(400)
    await bad({ source: "imap", host: "not a host", username: "u", password: "p" })
    await bad({ source: "imap", host: "imap.example.test", port: 143, username: "u", password: "p" })
    await bad({ source: "imap", host: "imap.example.test", username: "u", password: "" })
    await bad({ source: "mbox", uploadKey: "upl/mbx_someone_else/x" })
    await bad({ source: "mbox", exportId: "exp_missing" })

    const created = await call(base, {
      method: "POST",
      key: ADMIN,
      json: { source: "imap", host: "imap.unreachable.invalid", username: "sam", password: "do-not-show" },
    })
    expect(created.status).toBe(200)
    const text = await created.text()
    expect(text).not.toContain("do-not-show")
    const started = JSON.parse(text) as { id: string; status: string; credentialsHeld: boolean }
    expect(started.credentialsHeld).toBe(true)
    const cancelled = await json<{ status: string; credentialsHeld: boolean }>(
      await call(`${base}/${started.id}/cancel`, { method: "POST", key: ADMIN }),
    )
    expect(cancelled).toMatchObject({ status: "cancelled", credentialsHeld: false })
    const listed = await json<{ imports: Array<{ id: string }> }>(await call(base, { key: ADMIN }))
    expect(listed.imports.map((i) => i.id)).toContain(started.id)
    expect((await call(`${base}/imx_missing`, { key: ADMIN })).status).toBe(404)
  })
})
