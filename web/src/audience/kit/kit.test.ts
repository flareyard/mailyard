import { describe, expect, it } from "vitest"
import { ApiError } from "../../api/client.ts"
import type { Me } from "../../auth/session.ts"
import { andList, fieldError, fmtAgoShort, fmtDateTime, fmtDay, initialsOf, pct, plural } from "./format.ts"
import { can, whoCanDo } from "./perm.ts"

const base = {
  user: null,
  workspace: { id: "ws", name: "Coursified", logoUrl: null, url: "", host: "", claimed: true },
  role: null,
  via: "session-key",
  key: { id: "key_1", name: "Support desk", prefix: "sk_" },
  scopes: ["read", "send"],
  permissions: [],
  mailboxes: null,
  workspaces: [],
  session: null,
} as unknown as Me

describe("permissions", () => {
  it("reads /v1/me.permissions when the API sends them", () => {
    expect(can({ ...base, role: "agent", permissions: ["contacts.read"] } as Me, "contacts.write")).toBe(
      false,
    )
    expect(can({ ...base, role: "sender", permissions: ["contacts.write"] } as Me, "contacts.write")).toBe(
      true,
    )
  })
  it("falls back to the role, then to the key's scope", () => {
    expect(can({ ...base, role: "sender" } as Me, "contacts.erase")).toBe(false)
    expect(can({ ...base, role: "admin" } as Me, "contacts.erase")).toBe(true)
    expect(can(base, "contacts.read")).toBe(true)
    expect(can(base, "campaigns.write")).toBe(false)
    expect(can({ ...base, via: "admin-key" } as Me, "campaigns.write")).toBe(true)
    expect(can(undefined, "contacts.read")).toBe(false)
  })
  it("words who can", () => {
    expect(
      whoCanDo({ ...base, role: "agent", via: "session-member" } as Me, "contacts.write", "change contacts"),
    ).toBe("Owners, admins and senders can change contacts.")
    expect(whoCanDo(base, "contacts.erase", "erase")).toBe(
      "Needs a key with the admin scope, or a person who is an owner or an admin.",
    )
  })
})

describe("formatting", () => {
  const now = Date.UTC(2026, 9, 18, 12)
  it("dates in UTC", () => {
    expect(fmtDay(Date.UTC(2026, 2, 11), now)).toBe("11 Mar")
    expect(fmtDay(Date.UTC(2025, 2, 11), now)).toBe("11 Mar 2025")
    expect(fmtDateTime(Date.UTC(2026, 9, 17, 17, 34))).toBe("17 Oct 2026, 17:34 UTC")
  })
  it("short ages round to the next unit", () => {
    expect(fmtAgoShort(now - 23.6 * 3600_000, now)).toBe("1 d ago")
    expect(fmtAgoShort(now - 5 * 3600_000, now)).toBe("5 h ago")
    expect(fmtAgoShort(now - 30_000, now)).toBe("just now")
  })
  it("rates, plurals, lists and initials", () => {
    expect(pct(0.051)).toBe("5.1%")
    expect(pct(0.1)).toBe("10%")
    expect(pct(null)).toBe("—")
    expect(plural(1, "contact")).toBe("1 contact")
    expect(plural(4812, "contact")).toBe("4,812 contacts")
    expect(andList(["a", "b", "c"])).toBe("a, b and c")
    expect(initialsOf("Ada Okafor")).toBe("AO")
    expect(initialsOf(null, "zed@x")).toBe("Z")
  })
  it("matches a 400 to its field", () => {
    const e = new ApiError(400, { _tag: "InvalidRequest", field: "exclude.segmentIds", message: "Too many." })
    expect(fieldError(e, "exclude.segmentIds")).toBe("Too many.")
    expect(fieldError(e, "exclude", { prefix: true })).toBe("Too many.")
    expect(fieldError(e, "subject")).toBeNull()
    expect(fieldError(new Error("x"), "subject")).toBeNull()
  })
})
