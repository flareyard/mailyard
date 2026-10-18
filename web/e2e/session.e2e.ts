/**
 * End to end against a running Mailyard (the Worker serving web/dist), through the real UI:
 * signed out → redirected to /sign-in → a bad key is refused with its message → the right key signs in → the
 * shell loads with /v1/me → sign out → /signed-out → the app is closed again.
 *
 *   MAILYARD_E2E_BASE=http://127.0.0.1:8811 MAILYARD_E2E_KEY=… bun e2e/session.e2e.ts
 *
 * Use a local `wrangler dev` with a throwaway ADMIN_KEY in .dev.vars, never a production key. The key is read
 * from the environment and typed into the field; it is never printed.
 */
import { chromium } from "@playwright/test"

const base = process.env.MAILYARD_E2E_BASE ?? "http://127.0.0.1:8787"
const key = process.env.MAILYARD_E2E_KEY
if (!key) throw new Error("Set MAILYARD_E2E_KEY (a local key, never production's).")

const steps: string[] = []
const step = (s: string) => {
  steps.push(s)
  console.log(`✓ ${s}`)
}
const fail = (s: string): never => {
  console.error(`✗ ${s}`)
  process.exit(1)
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(String(e)))

try {
  await page.goto(`${base}/`)
  await page.waitForURL(/\/sign-in/)
  step("signed out, / redirects to /sign-in")

  await page.getByLabel("Access key").fill("sk_definitelynotarealkey123")
  await page.getByRole("button", { name: "Sign in with key" }).click()
  await page.getByRole("alert").first().waitFor()
  const refusal = await page.getByRole("alert").first().innerText()
  if (!/recognise|exists|revoked/i.test(refusal)) fail(`unexpected refusal text: ${refusal}`)
  step("a wrong key is refused with the API's typed reason")

  await page.getByLabel("Access key").fill(key)
  await page.getByRole("button", { name: "Sign in with key" }).click()
  await page.waitForURL((u) => !u.pathname.startsWith("/sign-in"), { timeout: 15_000 })
  await page.locator("aside.sidebar").waitFor()
  step(`signed in, landed on ${new URL(page.url()).pathname}`)

  const cookies = await page.context().cookies()
  const session = cookies.find((c) => c.name.includes("mailyard_session"))
  if (!session) fail("no session cookie was set")
  if (!session?.httpOnly) fail("the session cookie is readable by scripts")
  const readable = await page.evaluate(() => document.cookie.includes("mailyard_session"))
  if (readable) fail("document.cookie exposes the session")
  step("the session cookie is HttpOnly and invisible to page scripts")

  const me = await page.evaluate(async () => (await fetch("/v1/me")).status)
  if (me !== 200) fail(`/v1/me answered ${me} with the cookie`)
  step("/v1/me answers 200 on the cookie alone")

  const ended = await page.evaluate(async () => (await fetch("/v1/session", { method: "DELETE" })).status)
  if (ended !== 204) fail(`DELETE /v1/session answered ${ended}`)
  await page.goto(`${base}/`)
  await page.waitForURL(/\/sign-in/)
  step("a same-origin DELETE /v1/session passes the CSRF check and ends the session (204, then /sign-in)")

  await page.getByLabel("Access key").fill(key)
  await page.getByRole("button", { name: "Sign in with key" }).click()
  await page.locator("aside.sidebar").waitFor()
  step("signing in again restores the shell")

  await page.locator("button.me").click()
  await page.getByRole("menuitem", { name: "Sign out" }).click()
  await page.waitForURL(/\/signed-out/)
  step("sign out lands on /signed-out")

  await page.goto(`${base}/`)
  await page.waitForURL(/\/sign-in/)
  step("after signing out the app is closed again")

  if (errors.length) fail(`page errors: ${errors.join(" | ")}`)
  console.log(`\n${steps.length} steps passed against ${base}`)
} finally {
  await browser.close()
}
