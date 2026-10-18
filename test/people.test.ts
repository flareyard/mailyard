import { env, exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { installDohFixture } from "./dns.ts"
import { ADMIN, call, createKey, json } from "./helpers.ts"

installDohFixture()

const ORIGIN = "https://mailyard.test"
const COOKIE = "__Host-mailyard_session"
const uid = () => crypto.randomUUID().slice(0, 8)

type Me = {
  user: { id: string; name: string; email: string; timeZone: string } | null
  role: string | null
  via: string
  key: unknown
  permissions: string[]
  mailboxes: Array<{ id: string; address: string; access: string | null }> | null
  workspace: { name: string; claimed: boolean }
}
type Refusal = { _tag: string; reason?: string; allowedRoles?: string[]; role?: string; owners?: string[] }

/** A request signed in by a session cookie, from this site. */
const as = (cookie: string, path: string, init: RequestInit & { json?: unknown } = {}) =>
  call(path, { ...init, headers: { cookie, origin: ORIGIN, ...(init.headers as Record<string, string>) } })

const cookieOf = (res: Response) => {
  const token = (res.headers.get("set-cookie") ?? "").match(new RegExp(`${COOKIE}=([^;]+)`))?.[1]
  if (!token) throw new Error(`no session cookie (${res.status})`)
  return `${COOKIE}=${token}`
}

/** The last system mail to an address: its subject and HTML, read from the stored copy. */
const lastMailTo = async (email: string) => {
  const row = await env.DB.prepare(
    "select id, subject, rendered_key as key, stream, contact_id as contactId from messages_out where recipient = ? order by created_at desc, rowid desc limit 1",
  )
    .bind(email)
    .first<{ id: string; subject: string; key: string; stream: string; contactId: string | null }>()
  if (!row) return null
  const blob = await env.STORE.get(row.key)
  const message = JSON.parse((await blob?.text()) ?? "{}") as { html?: string; from?: { email: string } }
  return { ...row, html: message.html ?? "", from: message.from?.email ?? null }
}
const countMailTo = async (email: string) =>
  (
    await env.DB.prepare("select count(*) as n from messages_out where recipient = ?")
      .bind(email)
      .first<{ n: number }>()
  )?.n ?? 0

const linkToken = (html: string, prefix: string) => {
  const token = html.match(new RegExp(`${prefix}([A-Za-z0-9]+)`))?.[1]
  if (!token) throw new Error(`no ${prefix} link in ${html.slice(0, 200)}`)
  return token
}

/** Asks for a sign-in link and uses it through the app's verify call. */
const signIn = async (email: string) => {
  const ask = await call("/v1/session/link", { method: "POST", json: { email }, headers: { origin: ORIGIN } })
  expect(ask.status).toBe(202)
  const mail = await lastMailTo(email)
  const token = linkToken(mail?.html ?? "", "/v1/session/link/")
  const res = await call("/v1/session/link/verify", {
    method: "POST",
    json: { token },
    headers: { origin: ORIGIN },
  })
  expect(res.status).toBe(200)
  return { cookie: cookieOf(res), me: await json<Me>(res) }
}

/** Invites someone, sends it, and accepts it as them; returns their session. */
const invite = async (
  cookie: string,
  input: { email: string; role: string; mailboxes?: Array<{ mailboxId: string; access: string }> },
  name = "Invited",
) => {
  const created = await json<{ invite: { id: string } }>(
    await as(cookie, "/v1/invites", { method: "POST", json: input }),
  )
  expect((await as(cookie, `/v1/invites/${created.invite.id}/send`, { method: "POST" })).status).toBe(200)
  const token = linkToken((await lastMailTo(input.email))?.html ?? "", "/invite/")
  const accepted = await call(`/v1/invites/${token}/accept`, {
    method: "POST",
    json: { name },
    headers: { origin: ORIGIN },
  })
  expect(accepted.status).toBe(200)
  return { cookie: cookieOf(accepted), me: await json<Me>(accepted), inviteId: created.invite.id, token }
}

/** A mailbox that holds mail, on a fresh domain. */
const mailbox = async () => {
  const domain = `people-${uid()}.test`
  await call("/v1/domains", { method: "POST", key: ADMIN, json: { name: domain } })
  return json<{ id: string; address: string }>(
    await call("/v1/mailboxes", {
      method: "POST",
      key: ADMIN,
      json: { address: `team@${domain}`, kind: "user", displayName: "Team" },
    }),
  )
}

describe("people, roles and invitations (HAL-3361)", () => {
  const ownerEmail = `owner-${uid()}@example.org`
  let owner = ""

  it("claims the workspace once, with the admin key, and mails the owner a sign-in link", async () => {
    const adminScoped = (await createKey("secret", ["read", "admin"])).key
    const notRoot = await call("/v1/workspace/claim", {
      method: "POST",
      key: adminScoped,
      json: { workspaceName: "Yard Co", name: "Ada", email: ownerEmail },
    })
    expect(notRoot.status).toBe(403)

    const claimed = await call("/v1/workspace/claim", {
      method: "POST",
      key: ADMIN,
      json: { workspaceName: "Yard Co", name: "Ada Owner", email: ownerEmail.toUpperCase() },
    })
    expect(claimed.status).toBe(200)
    const body = await json<{ member: { id: string; role: string; email: string }; signInLinkSent: boolean }>(
      claimed,
    )
    expect(body).toMatchObject({ member: { role: "owner", email: ownerEmail }, signInLinkSent: true })

    const again = await call("/v1/workspace/claim", {
      method: "POST",
      key: ADMIN,
      json: { workspaceName: "Other", name: "Eve", email: `eve-${uid()}@example.org` },
    })
    expect(again.status).toBe(409)
    expect(await json(again)).toMatchObject({ reason: "already-claimed", claimedBy: body.member.id })

    // The link is Mailyard's own mail: the system sender, the system stream, and no contact made.
    const mail = await lastMailTo(ownerEmail)
    expect(mail).toMatchObject({ stream: "system", contactId: null, from: "hello@people.mailyard.test" })
    expect(mail?.subject).toBe("Sign in to Yard Co")
    const contact = await env.DB.prepare("select id from contacts where email = ?").bind(ownerEmail).first()
    expect(contact).toBeNull()

    const session = await signIn(ownerEmail)
    owner = session.cookie
    expect(session.me).toMatchObject({
      user: { name: "Ada Owner", email: ownerEmail, timeZone: "UTC" },
      role: "owner",
      via: "session-member",
      key: null,
      workspace: { name: "Yard Co", claimed: true },
    })
    expect(session.me.permissions).toEqual(
      expect.arrayContaining(["workspace.owner", "members.manage", "keys.manage"]),
    )
  })

  it("uses a sign-in link once, from its page's button, never from just opening it", async () => {
    await call("/v1/session/link", {
      method: "POST",
      json: { email: ownerEmail },
      headers: { origin: ORIGIN },
    })
    const token = linkToken((await lastMailTo(ownerEmail))?.html ?? "", "/v1/session/link/")
    // A mail scanner opening the link signs nobody in.
    const page = await call(`/v1/session/link/${token}`)
    expect(page.status).toBe(200)
    expect(page.headers.get("set-cookie")).toBeNull()
    expect(await page.text()).toContain(`action="/v1/session/link/${token}"`)
    // The button's POST from another site is refused; from this site it signs in and goes to the app.
    const forged = await call(`/v1/session/link/${token}`, {
      method: "POST",
      headers: { origin: "https://evil.example" },
    })
    expect(forged.status).toBe(403)
    const used = await exports.default.fetch(
      new Request(`${ORIGIN}/v1/session/link/${token}`, {
        method: "POST",
        headers: { origin: ORIGIN },
        redirect: "manual",
      }),
    )
    expect(used.status).toBe(303)
    expect(used.headers.get("location")).toBe("/")
    expect((await as(cookieOf(used), "/v1/me")).status).toBe(200)
    // Once only, by either route.
    expect(
      (await call(`/v1/session/link/${token}`, { method: "POST", headers: { origin: ORIGIN } })).status,
    ).toBe(410)
    const again = await call("/v1/session/link/verify", {
      method: "POST",
      json: { token },
      headers: { origin: ORIGIN },
    })
    expect(again.status).toBe(410)
    expect(await json(again)).toMatchObject({ _tag: "Gone", reason: "used" })
    const unknown = await call("/v1/session/link/verify", {
      method: "POST",
      json: { token: "nope" },
      headers: { origin: ORIGIN },
    })
    expect(unknown.status).toBe(400)
  })

  it("expires sign-in links after 15 minutes, and says nothing about unknown addresses", async () => {
    await call("/v1/session/link", {
      method: "POST",
      json: { email: ownerEmail },
      headers: { origin: ORIGIN },
    })
    const token = linkToken((await lastMailTo(ownerEmail))?.html ?? "", "/v1/session/link/")
    await env.DB.prepare("update sign_in_links set expires_at = ? where used_at is null")
      .bind(Date.now() - 1)
      .run()
    const expired = await call("/v1/session/link/verify", {
      method: "POST",
      json: { token },
      headers: { origin: ORIGIN },
    })
    expect(await json(expired)).toMatchObject({ reason: "expired" })

    const nobody = `nobody-${uid()}@example.org`
    const res = await call("/v1/session/link", {
      method: "POST",
      json: { email: nobody },
      headers: { origin: ORIGIN },
    })
    expect(res.status).toBe(202)
    expect(await json(res)).toEqual({ sent: true })
    expect(await countMailTo(nobody)).toBe(0)
  })

  it("drafts an invitation, sends it only when asked, and joins with its role and mailboxes", async () => {
    const box = await mailbox()
    const email = `sender-${uid()}@example.org`
    const created = await as(owner, "/v1/invites", {
      method: "POST",
      json: {
        email,
        role: "sender",
        mailboxes: [{ mailboxId: box.id, access: "member" }],
        message: "Welcome aboard",
      },
    })
    expect(created.status).toBe(200)
    const draft = await json<{
      invite: { id: string; status: string }
      draft: { subject: string; to: string }
    }>(created)
    expect(draft.invite.status).toBe("draft")
    expect(draft.draft).toMatchObject({ to: email, subject: "Ada Owner invited you to Yard Co on Mailyard" })
    // Drafting sends nothing.
    expect(await countMailTo(email)).toBe(0)
    const dup = await as(owner, "/v1/invites", { method: "POST", json: { email, role: "viewer" } })
    expect(await json(dup)).toMatchObject({ reason: "already-invited" })
    const existing = await as(owner, "/v1/invites", {
      method: "POST",
      json: { email: ownerEmail, role: "viewer" },
    })
    expect(await json(existing)).toMatchObject({ reason: "already-member" })

    expect((await as(owner, `/v1/invites/${draft.invite.id}/send`, { method: "POST" })).status).toBe(200)
    expect(await countMailTo(email)).toBe(1)
    const token = linkToken((await lastMailTo(email))?.html ?? "", "/invite/")
    const seen = await json(await call(`/v1/invites/${token}`))
    expect(seen).toMatchObject({
      email,
      role: "sender",
      workspace: "Yard Co",
      invitedBy: "Ada Owner",
      message: "Welcome aboard",
      mailboxes: [{ mailboxId: box.id, access: "member", address: box.address }],
    })
    const forged = await call(`/v1/invites/${token}/accept`, {
      method: "POST",
      json: {},
      headers: { origin: "https://evil.example" },
    })
    expect(forged.status).toBe(403)
    const accepted = await call(`/v1/invites/${token}/accept`, {
      method: "POST",
      json: { name: "Sam Sender" },
      headers: { origin: ORIGIN },
    })
    expect(accepted.status).toBe(200)
    const me = await json<Me>(accepted)
    expect(me).toMatchObject({ role: "sender", user: { name: "Sam Sender", email }, via: "session-member" })
    expect(me.mailboxes).toEqual(
      expect.arrayContaining([{ id: box.id, address: box.address, access: "member" }]),
    )
    const reuse = await call(`/v1/invites/${token}/accept`, {
      method: "POST",
      json: {},
      headers: { origin: ORIGIN },
    })
    expect(reuse.status).toBe(410)
  })

  it("resends with a fresh link, revokes, expires, and refuses the wrong account", async () => {
    const email = `viewer-${uid()}@example.org`
    const { invite: inv } = await json<{ invite: { id: string } }>(
      await as(owner, "/v1/invites", { method: "POST", json: { email, role: "viewer" } }),
    )
    await as(owner, `/v1/invites/${inv.id}/send`, { method: "POST" })
    const first = linkToken((await lastMailTo(email))?.html ?? "", "/invite/")
    await as(owner, `/v1/invites/${inv.id}/resend`, { method: "POST" })
    const second = linkToken((await lastMailTo(email))?.html ?? "", "/invite/")
    expect(second).not.toBe(first)
    expect((await call(`/v1/invites/${first}`)).status).toBe(404)
    // Signed in as the owner, accepting someone else's invitation is a mismatch.
    const mismatch = await as(owner, `/v1/invites/${second}/accept`, { method: "POST", json: {} })
    expect(mismatch.status).toBe(409)
    expect(await json(mismatch)).toMatchObject({ reason: "email-mismatch" })
    await env.DB.prepare("update invites set expires_at = ? where id = ?")
      .bind(Date.now() - 1, inv.id)
      .run()
    expect(await json(await call(`/v1/invites/${second}`))).toMatchObject({ reason: "expired" })
    expect((await as(owner, `/v1/invites/${inv.id}`, { method: "DELETE" })).status).toBe(200)
    await env.DB.prepare("update invites set expires_at = ? where id = ?")
      .bind(Date.now() + 60_000, inv.id)
      .run()
    expect(await json(await call(`/v1/invites/${second}`))).toMatchObject({ reason: "revoked" })
  })

  it("checks every role against the matrix, and keys keep their scopes", async () => {
    const sender = await invite(owner, { email: `s-${uid()}@example.org`, role: "sender" })
    const viewer = await invite(owner, { email: `v-${uid()}@example.org`, role: "viewer" })
    const agent = await invite(owner, { email: `a-${uid()}@example.org`, role: "agent" })

    // A sender edits contacts, which a key needs the admin scope for…
    const contact = await as(sender.cookie, "/v1/contacts", {
      method: "POST",
      json: { email: `c-${uid()}@example.net` },
    })
    expect(contact.status).toBeLessThan(300)
    const { id } = await json<{ id: string }>(contact)
    // …but can't erase one, make keys, or invite people.
    for (const [path, init] of [
      [`/v1/contacts/${id}/erase`, { method: "POST", json: {} }],
      ["/v1/api-keys", { method: "POST", json: { name: "x", kind: "secret" } }],
      ["/v1/invites", { method: "POST", json: { email: `x-${uid()}@example.org`, role: "viewer" } }],
    ] as const) {
      const res = await as(sender.cookie, path, init)
      expect(res.status).toBe(403)
      expect(await json<Refusal>(res)).toMatchObject({
        reason: "role",
        role: "sender",
        allowedRoles: ["owner", "admin"],
      })
    }
    // A viewer reads but doesn't write.
    expect((await as(viewer.cookie, "/v1/contacts")).status).toBe(200)
    expect((await as(viewer.cookie, "/v1/campaigns")).status).toBe(200)
    const viewerWrite = await as(viewer.cookie, "/v1/contacts", {
      method: "POST",
      json: { email: `d-${uid()}@example.net` },
    })
    expect(await json<Refusal>(viewerWrite)).toMatchObject({
      reason: "role",
      allowedRoles: ["owner", "admin", "sender"],
    })
    // An agent reads contacts and their mail, not campaigns or settings.
    expect((await as(agent.cookie, "/v1/contacts")).status).toBe(200)
    expect((await as(agent.cookie, "/v1/campaigns")).status).toBe(403)
    expect((await as(agent.cookie, "/v1/webhooks")).status).toBe(403)
    expect(agent.me.permissions).not.toContain("campaigns.read")
    expect(sender.me.permissions).toEqual(expect.arrayContaining(["contacts.write", "campaigns.write"]))
    expect(sender.me.permissions).not.toContain("contacts.erase")
    // A key is still checked by its scopes alone.
    const readKey = (await createKey("secret", ["read"])).key
    const keyWrite = await call("/v1/contacts", {
      method: "POST",
      key: readKey,
      json: { email: `k-${uid()}@example.net` },
    })
    expect(await json<Refusal>(keyWrite)).toMatchObject({ reason: "insufficient-scope" })
  })

  it("gives agents only their mailboxes, and mailbox viewers read without writing", async () => {
    const mine = await mailbox()
    const theirs = await mailbox()
    const agent = await invite(owner, {
      email: `agent-${uid()}@example.org`,
      role: "agent",
      mailboxes: [{ mailboxId: mine.id, access: "member" }],
    })
    const list = await json<{ mailboxes: Array<{ id: string }> }>(await as(agent.cookie, "/v1/mailboxes"))
    expect(list.mailboxes.map((m) => m.id)).toEqual([mine.id])
    expect((await as(agent.cookie, `/v1/mailboxes/${mine.id}/threads`)).status).toBe(200)
    expect((await as(agent.cookie, `/v1/mailboxes/${theirs.id}/threads`)).status).toBe(403)
    expect((await as(agent.cookie, `/v1/mailboxes/${theirs.id}`)).status).toBe(404)
    expect(
      (
        await as(agent.cookie, `/v1/mailboxes/${mine.id}/labels`, {
          method: "POST",
          json: { name: `L ${uid()}` },
        })
      ).status,
    ).toBeLessThan(300)
    expect(agent.me.mailboxes).toEqual([{ id: mine.id, address: mine.address, access: "member" }])

    // A sender reads every mailbox, but writes only where they're given owner or member access.
    const sender = await invite(owner, {
      email: `sv-${uid()}@example.org`,
      role: "sender",
      mailboxes: [{ mailboxId: theirs.id, access: "viewer" }],
    })
    // Ada owns the mailbox, so a viewer's refusal names her.
    const ownerId = (await json<Me>(await as(owner, "/v1/me"))).user?.id as string
    await call(`/v1/mailboxes/${theirs.id}/members`, {
      method: "PUT",
      key: ADMIN,
      json: {
        members: [
          { memberId: ownerId, access: "owner" },
          { memberId: sender.me.user?.id, access: "viewer" },
        ],
      },
    })
    expect((await as(sender.cookie, `/v1/mailboxes/${mine.id}/threads`)).status).toBe(200)
    const viewerWrite = await as(sender.cookie, `/v1/mailboxes/${theirs.id}/labels`, {
      method: "POST",
      json: { name: `L ${uid()}` },
    })
    expect(viewerWrite.status).toBe(403)
    expect(await json<Refusal>(viewerWrite)).toMatchObject({
      reason: "mailbox_role",
      role: "viewer",
      owners: ["Ada Owner"],
    })
    const detail = await json<{ people: Array<{ memberId: string; access: string }> }>(
      await call(`/v1/mailboxes/${theirs.id}`, { key: ADMIN }),
    )
    expect(detail.people.map((p) => p.access).sort()).toEqual(["owner", "viewer"])
  })

  it("lists, changes and removes members; the owner is protected and can hand ownership on", async () => {
    const admin = await invite(owner, { email: `ad-${uid()}@example.org`, role: "admin" }, "Grace Admin")
    const sender = await invite(owner, { email: `sx-${uid()}@example.org`, role: "sender" })
    const listed = await json<{ members: Array<{ id: string; role: string }>; invites: unknown[] }>(
      await as(admin.cookie, "/v1/members"),
    )
    expect(listed.members.find((m) => m.id === admin.me.user?.id)?.role).toBe("admin")
    const ownerId = (await json<Me>(await as(owner, "/v1/me"))).user?.id as string

    // The owner can't be demoted or removed.
    const demote = await as(admin.cookie, `/v1/members/${ownerId}`, {
      method: "PATCH",
      json: { role: "viewer" },
    })
    expect(await json<Refusal>(demote)).toMatchObject({ reason: "owner" })
    expect((await as(admin.cookie, `/v1/members/${ownerId}`, { method: "DELETE" })).status).toBe(403)

    // A new role applies at once: the old sessions end.
    const changed = await as(admin.cookie, `/v1/members/${sender.me.user?.id}`, {
      method: "PATCH",
      json: { role: "viewer", timeZone: "Africa/Lagos" },
    })
    expect(await json(changed)).toMatchObject({ role: "viewer", timeZone: "Africa/Lagos" })
    expect(await json(await as(sender.cookie, "/v1/me"))).toMatchObject({ reason: "session-expired" })
    expect(
      (
        await as(admin.cookie, `/v1/members/${sender.me.user?.id}`, {
          method: "PATCH",
          json: { timeZone: "Mars/Base" },
        })
      ).status,
    ).toBe(400)

    // Removing someone ends their sessions; they can be invited back.
    const back = await signIn(sender.me.user?.email as string)
    expect((await as(admin.cookie, `/v1/members/${sender.me.user?.id}`, { method: "DELETE" })).status).toBe(
      200,
    )
    expect((await as(back.cookie, "/v1/me")).status).toBe(401)
    const rejoined = await invite(admin.cookie, { email: sender.me.user?.email as string, role: "agent" })
    expect(rejoined.me.user?.id).toBe(sender.me.user?.id)
    expect(rejoined.me.role).toBe("agent")

    // Only the owner hands ownership on; they become an admin.
    expect(
      (
        await as(admin.cookie, "/v1/workspace/transfer", {
          method: "POST",
          json: { memberId: admin.me.user?.id },
        })
      ).status,
    ).toBe(403)
    const handed = await as(owner, "/v1/workspace/transfer", {
      method: "POST",
      json: { memberId: admin.me.user?.id },
    })
    expect(await json(handed)).toMatchObject({ role: "owner" })
    const formerOwner = await signIn(ownerEmail)
    expect(formerOwner.me.role).toBe("admin")
    owner = (await signIn(admin.me.user?.email as string)).cookie
  })

  it("lets people change their own name and time zone, and keys have no profile", async () => {
    const me = await as(owner, "/v1/me", {
      method: "PATCH",
      json: { timeZone: "Europe/London", name: "Grace H." },
    })
    expect(await json(me)).toMatchObject({ user: { name: "Grace H.", timeZone: "Europe/London" } })
    expect((await as(owner, "/v1/me", { method: "PATCH", json: { timeZone: "Nowhere/Land" } })).status).toBe(
      400,
    )
    expect((await call("/v1/me", { method: "PATCH", key: ADMIN, json: { name: "Root" } })).status).toBe(403)
  })
})
