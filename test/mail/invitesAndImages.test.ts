import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { handleEmail } from "../../src/workers/inbound.ts"
import { goodDomain, installDohFixture, setDns } from "../dns.ts"
import { ADMIN, call, createKey, json } from "../helpers.ts"
import { INVITE } from "./inviteFixture.ts"

/** HAL-3369: calendar invites with RSVP, and the always-show-images list. */
installDohFixture()

const uid = () => crypto.randomUUID().slice(0, 8)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const admin = (path: string, method = "GET", body?: unknown) =>
  call(path, { method, key: ADMIN, ...(body !== undefined ? { json: body } : {}) })

const setup = async () => {
  const domain = `iv-${uid()}.test`
  setDns(goodDomain(domain))
  await admin("/v1/domains", "POST", { name: domain })
  const box = await json<{ id: string; address: string }>(
    await admin("/v1/mailboxes", "POST", { address: `sam@${domain}`, kind: "user" }),
  )
  return { domain, box }
}

const deliver = async (to: string, raw: string, from = "grace@example.org") => {
  const bytes = new TextEncoder().encode(raw)
  await handleEmail(
    {
      from,
      to,
      headers: new Headers(),
      raw: new Blob([bytes]).stream(),
      rawSize: bytes.byteLength,
      canBeForwarded: true,
      setReject: () => {},
      forward: async () => {},
      reply: async () => {},
    } as unknown as ForwardableEmailMessage,
    env,
  )
}

/** An invitation as Google Calendar sends it: text, and the event as a text/calendar part. */
const inviteMail = (to: string) =>
  [
    'From: "Grace Hopper" <grace@example.org>',
    `To: ${to}`,
    "Subject: Invitation: Planning, Q4 @ Thu 22 Oct 2026 15:00 - 15:30",
    `Message-ID: <${uid()}@example.org>`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="m"',
    "",
    "--m",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "You have been invited to Planning, Q4.",
    "--m",
    'Content-Type: text/calendar; charset="UTF-8"; method=REQUEST',
    'Content-Disposition: attachment; filename="invite.ics"',
    "",
    INVITE.replaceAll("sam@acme.test", to),
    "--m--",
    "",
  ].join("\r\n")

const firstMessage = async (mailboxId: string) => {
  const thread = (
    await json<{ threads: Array<{ id: string }> }>(await admin(`/v1/mailboxes/${mailboxId}/threads`))
  ).threads[0]
  const detail = await json<{ messages: Array<{ id: string }> }>(
    await admin(`/v1/mailboxes/${mailboxId}/threads/${thread?.id}`),
  )
  return detail.messages[0]?.id ?? ""
}

type Detail = {
  invite: {
    method: string
    summary: string
    organizer: { address: string }
    myStatus: string | null
    canRespond: boolean
    start: string
    timeZone: string
  } | null
  remoteImages: "show" | "ask"
}

describe("calendar invites (HAL-3369)", () => {
  it("reads the invitation on the message and answers it with an iTIP REPLY from the mailbox", async () => {
    const { box } = await setup()
    await deliver(box.address, inviteMail(box.address))
    const messageId = await firstMessage(box.id)
    const detail = await json<Detail>(await admin(`/v1/mailboxes/${box.id}/messages/${messageId}`))
    expect(detail.invite).toMatchObject({
      method: "REQUEST",
      summary: "Planning, Q4",
      organizer: { address: "grace@example.org" },
      myStatus: "NEEDS-ACTION",
      canRespond: true,
      start: "2026-10-22T15:00:00",
      timeZone: "Africa/Lagos",
    })

    const res = await admin(`/v1/mailboxes/${box.id}/messages/${messageId}/rsvp`, "POST", {
      response: "accepted",
      comment: "See you there.",
    })
    expect(res.status).toBe(200)
    const answer = await json<{
      response: string
      draft: {
        id: string
        subject: string
        to: Array<{ address: string }>
        bodyText: string
        attachments: Array<{ key: string; filename: string; mimeType: string }>
      }
    }>(res)
    expect(answer.response).toBe("accepted")
    expect(answer.draft).toMatchObject({
      subject: "Accepted: Planning, Q4",
      to: [{ address: "grace@example.org" }],
    })
    expect(answer.draft.bodyText).toContain("has accepted Planning, Q4")
    expect(answer.draft.bodyText).toContain("See you there.")
    const ics = answer.draft.attachments[0]
    expect(ics).toMatchObject({ filename: "invite.ics", mimeType: "text/calendar; method=REPLY" })
    const stored = await (await env.STORE.get(ics?.key ?? ""))?.text()
    expect(stored).toContain("METHOD:REPLY")
    expect(stored).toContain(`ATTENDEE;PARTSTAT=ACCEPTED;CN="Sam Team":mailto:${box.address}`)
    // It goes out as one normal send, after the undo window.
    const stub = env.MAILBOX.get(env.MAILBOX.idFromName(box.id))
    const deadline = Date.now() + 15_000
    while ((await stub.draft(answer.draft.id))?.status === "scheduled" && Date.now() < deadline)
      await sleep(50)
    expect((await stub.draft(answer.draft.id))?.status).not.toBe("draft")
  })

  it("refuses to answer what isn't an invitation to this mailbox, and needs send access", async () => {
    const { box } = await setup()
    await deliver(box.address, inviteMail("someone-else@example.net"))
    const messageId = await firstMessage(box.id)
    const detail = await json<Detail>(await admin(`/v1/mailboxes/${box.id}/messages/${messageId}`))
    expect(detail.invite).toMatchObject({ canRespond: false, myStatus: null })
    expect(
      (await admin(`/v1/mailboxes/${box.id}/messages/${messageId}/rsvp`, "POST", { response: "declined" }))
        .status,
    ).toBe(400)
    const reader = await createKey("secret", ["read"])
    expect(
      (
        await call(`/v1/mailboxes/${box.id}/messages/${messageId}/rsvp`, {
          method: "POST",
          key: reader.key,
          json: { response: "declined" },
        })
      ).status,
    ).toBe(403)
  })
})

describe("always show images (HAL-3369)", () => {
  it("lists senders by address or domain, and the message says whether to show its images", async () => {
    const { box } = await setup()
    await deliver(
      box.address,
      `From: News <news@shop.example>\r\nTo: ${box.address}\r\nSubject: Sale\r\nMessage-ID: <${uid()}@shop.example>\r\nContent-Type: text/html\r\n\r\n<img src="https://shop.example/pixel.png">Sale!\r\n`,
      "news@shop.example",
    )
    const messageId = await firstMessage(box.id)
    const show = async () =>
      (await json<Detail>(await admin(`/v1/mailboxes/${box.id}/messages/${messageId}`))).remoteImages
    expect(await show()).toBe("ask")
    expect(
      (await admin(`/v1/mailboxes/${box.id}/image-senders`, "POST", { value: "not a sender" })).status,
    ).toBe(400)
    const added = await json<{ value: string }>(
      await admin(`/v1/mailboxes/${box.id}/image-senders`, "POST", { value: "@Shop.Example" }),
    )
    expect(added.value).toBe("@shop.example")
    expect(await show()).toBe("show")
    const listed = await json<{ senders: Array<{ value: string }> }>(
      await admin(`/v1/mailboxes/${box.id}/image-senders`),
    )
    expect(listed.senders.map((s) => s.value)).toEqual(["@shop.example"])
    await admin(`/v1/mailboxes/${box.id}/image-senders/${encodeURIComponent("@shop.example")}`, "DELETE")
    expect(await show()).toBe("ask")
  })
})
