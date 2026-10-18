import { describe, expect, it } from "vitest"
import { ApiError } from "../api/client.ts"
import { findOverride } from "../fixtures/overrides.ts"
import { inviteDay, inviterName, inviteState } from "./invite.ts"

const base = { ready: true, live: true, pending: false, error: null, hasInvite: true }
const gone = (reason: string) => new ApiError(410, { _tag: "Gone", reason, message: "gone" })

describe("invite states", () => {
  it("waits for the capabilities and the invite", () => {
    expect(inviteState({ ...base, ready: false })).toBe("loading")
    expect(inviteState({ ...base, pending: true, hasInvite: false })).toBe("loading")
  })
  it("says when this deploy has no invites", () => {
    expect(inviteState({ ...base, live: false })).toBe("not-live")
  })
  it("shows a valid invite", () => {
    expect(inviteState(base)).toBe("valid")
  })
  it("maps 410 reasons to their screens", () => {
    for (const r of ["expired", "used", "revoked"])
      expect(inviteState({ ...base, hasInvite: false, error: gone(r) })).toBe(r)
  })
  it("treats 404 as an unknown link and anything else as unreachable", () => {
    expect(inviteState({ ...base, hasInvite: false, error: new ApiError(404, { message: "no" }) })).toBe(
      "unknown",
    )
    expect(inviteState({ ...base, hasInvite: false, error: new TypeError("fetch failed") })).toBe(
      "unreachable",
    )
  })
  it("follows what accepting answered", () => {
    expect(
      inviteState({ ...base, acceptError: new ApiError(409, { reason: "email-mismatch", message: "x" }) }),
    ).toBe("wrong-account")
    expect(
      inviteState({ ...base, acceptError: new ApiError(409, { reason: "already-member", message: "x" }) }),
    ).toBe("already-member")
    expect(inviteState({ ...base, acceptError: gone("revoked") })).toBe("revoked")
    // A refusal it can't place leaves the invite on screen, where the error shows under the button.
    expect(inviteState({ ...base, acceptError: new ApiError(400, { message: "bad name" }) })).toBe("valid")
  })
  it("names the inviter, or the workspace when there's no name", () => {
    expect(inviterName("Halleluyah Oludele", "Coursified")).toBe("Halleluyah Oludele")
    expect(inviterName(null, "Coursified")).toBe("Someone at Coursified")
    expect(inviterName("  ", "Coursified")).toBe("Someone at Coursified")
  })
  it("words the expiry day in UTC", () => {
    expect(inviteDay(Date.UTC(2026, 9, 23, 9))).toBe("Fri 23 Oct")
    expect(inviteDay(String(Date.UTC(2026, 9, 23, 9)))).toBe("Fri 23 Oct")
  })
})

describe("fixture overrides in the live shape", () => {
  const req = (method: string, path: string, body?: unknown) =>
    new Request(`http://localhost${path}`, {
      method,
      ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
    })

  it("describes a valid invite with the live fields", async () => {
    const a = await findOverride(req("GET", "/v1/invites/inv_abc"))
    expect(a?.status).toBe(200)
    expect(Object.keys(a?.body as object).sort()).toEqual([
      "email",
      "expiresAt",
      "invitedBy",
      "mailboxes",
      "message",
      "role",
      "workspace",
    ])
  })
  it("answers 410 and 404 for the example tokens", async () => {
    expect((await findOverride(req("GET", "/v1/invites/revoked")))?.status).toBe(410)
    expect((await findOverride(req("GET", "/v1/invites/unknown")))?.status).toBe(404)
  })
  it("accepts with the /v1/me body, or refuses as the backend does", async () => {
    const ok = await findOverride(req("POST", "/v1/invites/inv_abc/accept", {}))
    expect(ok).toMatchObject({ status: 200, body: { via: "session-member" } })
    const mismatch = await findOverride(req("POST", "/v1/invites/wrong-account/accept", {}))
    expect(mismatch).toMatchObject({ status: 409, body: { reason: "email-mismatch" } })
  })
  it("sends sign-in links, or refuses with 503 and 429 for the example domains", async () => {
    expect(await findOverride(req("POST", "/v1/session/link", { email: "a@b.com" }))).toEqual({
      status: 202,
      body: { sent: true },
    })
    expect(
      (await findOverride(req("POST", "/v1/session/link", { email: "a@no-sender.example" })))?.status,
    ).toBe(503)
    expect(
      (await findOverride(req("POST", "/v1/session/link", { email: "a@rate-limited.example" })))?.status,
    ).toBe(429)
  })
  it("leaves everything else to the design table", async () => {
    expect(await findOverride(req("GET", "/v1/invites"))).toBeUndefined()
    expect(await findOverride(req("GET", "/v1/domains"))).toBeUndefined()
  })
})
