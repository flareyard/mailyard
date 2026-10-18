/**
 * People end to end (HAL-3361) against a running Mailyard, through the real invite screen:
 * the admin key claims the workspace (once) and invites a sender → the invitation's link is read from the
 * message log → a fresh browser opens /invite/{token}, sees the workspace and role, accepts with a name → it
 * lands signed in as that person, with role "sender" from /v1/me → the same link then shows "already used".
 *
 *   MAILYARD_E2E_BASE=http://127.0.0.1:8811 MAILYARD_E2E_KEY=… bun e2e/people.e2e.ts
 *
 * Needs MAILYARD_SYSTEM_FROM set on that Mailyard so invitations send (MAILYARD_SENDER=memory keeps them local).
 * Local only: it claims the workspace and creates members. Never point it at production.
 */
import { chromium } from "@playwright/test"

const base = process.env.MAILYARD_E2E_BASE ?? "http://127.0.0.1:8787"
const key = process.env.MAILYARD_E2E_KEY
if (!key) throw new Error("Set MAILYARD_E2E_KEY (a local key, never production's).")
if (/flareyard\.dev|workers\.dev/.test(base))
  throw new Error("people.e2e claims and invites: local Mailyards only.")

let n = 0
const step = (s: string) => console.log(`✓ ${++n}. ${s}`)
const fail = (s: string): never => {
  console.error(`✗ ${s}`)
  process.exit(1)
}
const admin = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(init.headers ?? {}) },
  })

const claim = await admin("/v1/workspace/claim", {
  method: "POST",
  body: JSON.stringify({ workspaceName: "Local Yard", name: "Owner Person", email: "owner@local.test" }),
})
if (claim.status !== 200 && claim.status !== 201 && claim.status !== 409)
  fail(`claim answered ${claim.status}`)
step(
  claim.status === 409
    ? "the workspace was already claimed (409 already-claimed)"
    : "the admin key claimed the workspace",
)

const email = `sender-${Date.now()}@local.test`
const created = await admin("/v1/invites", {
  method: "POST",
  body: JSON.stringify({ email, role: "sender" }),
})
if (!created.ok) fail(`create invite answered ${created.status}`)
const { invite } = (await created.json()) as { invite: { id: string; status: string } }
if (invite.status !== "draft") fail(`a new invite should be a draft, got ${invite.status}`)
const sent = await admin(`/v1/invites/${invite.id}/send`, { method: "POST" })
if (!sent.ok) fail(`send invite answered ${sent.status} (is MAILYARD_SYSTEM_FROM set?)`)
step(`invited ${email} as a sender: drafted, then sent`)

const log = (await (await admin("/v1/messages?stream=system&limit=10")).json()) as {
  messages: { id: string; recipient: string }[]
}
const msg = log.messages.find((m) => m.recipient === email)
if (!msg) fail("the invitation isn't in the message log")
const detail = JSON.stringify(await (await admin(`/v1/messages/${msg?.id}`)).json())
const link = detail.match(/https?:\/\/[^"\\\s]*\/invite\/[A-Za-z0-9_-]+/)?.[0]
if (!link) fail("no /invite/{token} link in the invitation")
const path = new URL(link as string).pathname
step(`the invitation links to the app route ${path.replace(/[^/]+$/, "{token}")}`)

const browser = await chromium.launch()
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.goto(`${base}${path}`)
  await page.getByText("Local Yard").first().waitFor()
  await page
    .getByText(/sender/i)
    .first()
    .waitFor()
  step("the invite screen shows the workspace and the role")

  const name = page.getByLabel(/your name/i)
  if (await name.count()) await name.fill("Sam Sender")
  await page
    .getByRole("button", { name: /accept|join/i })
    .first()
    .click()
  await page.waitForURL((u) => !u.pathname.startsWith("/invite"), { timeout: 15_000 })
  await page.locator("aside.sidebar").waitFor()
  const me = (await page.evaluate(async () => (await fetch("/v1/me")).json())) as {
    role: string | null
    user: { email: string; name: string } | null
    via: string
  }
  if (me.role !== "sender" || me.user?.email !== email) fail(`/v1/me after accepting: ${JSON.stringify(me)}`)
  step(`accepted: signed in as ${me.user?.name} (${me.role}, via ${me.via})`)

  const shown = await page.locator("button.me .me-name").innerText()
  if (!shown.includes(me.user?.name ?? "")) fail(`the avatar menu shows "${shown}"`)
  step("the shell names the person, not a key")

  const after = await fetch(`${base}/v1/invites/${path.split("/").pop()}`)
  if (after.status !== 410) fail(`GET /v1/invites/{token} after accepting answered ${after.status}, not 410`)
  const again = await (await browser.newContext()).newPage()
  await again.goto(`${base}${path}`)
  await again
    .getByText(/already accepted/i)
    .first()
    .waitFor()
  step("the same link then answers 410 used, and the screen says it was already accepted")

  if (errors.length) fail(`page errors: ${errors.join(" | ")}`)
  console.log(`\n${n} steps passed against ${base}`)
} finally {
  await browser.close()
}
