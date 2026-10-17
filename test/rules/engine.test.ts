import { describe, expect, it } from "vitest"
import { NO_AUTH_RESULTS } from "../../src/inbound/auth.ts"
import { conditionHolds, evaluate, type Rule, type RuleInput } from "../../src/rules/engine.ts"
import { authScore, classifierPoints } from "../../src/rules/spam.ts"
import { readProbability } from "../../src/services/Classifier.ts"

const message: RuleInput = {
  from: { name: "GitHub", address: "noreply@github.com" },
  to: [{ name: "Sam", address: "sam@acme.test" }],
  cc: [{ name: null, address: "team@acme.test" }],
  subject: "[acme/api] Build failed on main",
  listId: "acme/api <api.acme.github.com>",
  tag: "ci",
  body: "The build failed. See the logs.",
  hasAttachment: false,
  automated: true,
}

const rule = (fields: Partial<Rule>): Rule => ({
  id: "r1",
  name: "Rule",
  enabled: true,
  match: "all",
  conditions: [],
  actions: [{ type: "archive" }],
  stop: false,
  ...fields,
})

describe("conditions", () => {
  it.each([
    [{ field: "from", op: "endsWith", value: "@github.com" }, true],
    [{ field: "from", op: "contains", value: "GitHub" }, true],
    [{ field: "from", op: "equals", value: "noreply@github.com" }, true],
    [{ field: "to", op: "equals", value: "sam@acme.test" }, true],
    [{ field: "cc", op: "startsWith", value: "team@" }, true],
    [{ field: "recipients", op: "contains", value: "team@acme" }, true],
    [{ field: "subject", op: "startsWith", value: "[ACME/API]" }, true],
    [{ field: "subject", op: "notContains", value: "passed" }, true],
    [{ field: "subject", op: "notContains", value: "failed" }, false],
    [{ field: "listId", op: "contains", value: "api.acme.github.com" }, true],
    [{ field: "tag", op: "equals", value: "ci" }, true],
    [{ field: "body", op: "contains", value: "see the logs" }, true],
    [{ field: "hasAttachment", value: false }, true],
    [{ field: "automated", value: true }, true],
    [{ field: "to", op: "contains", value: "nobody" }, false],
  ] as const)("%o → %s", (condition, holds) => {
    expect(conditionHolds(condition, message)).toBe(holds)
  })

  it("notContains on recipients holds only if no recipient contains the value", () => {
    expect(conditionHolds({ field: "recipients", op: "notContains", value: "team@" }, message)).toBe(false)
    expect(conditionHolds({ field: "recipients", op: "notContains", value: "boss@" }, message)).toBe(true)
  })
})

describe("evaluate", () => {
  it("matches all, any, or everything when there are no conditions; skips disabled rules", () => {
    const all = rule({
      id: "all",
      conditions: [
        { field: "from", op: "contains", value: "github" },
        { field: "subject", op: "contains", value: "passed" },
      ],
    })
    const any = rule({ id: "any", match: "any", conditions: all.conditions })
    const everything = rule({ id: "everything" })
    const off = rule({ id: "off", enabled: false })
    expect(evaluate([all, any, everything, off], message).matched).toEqual(["any", "everything"])
  })

  it("merges actions in order: labels add up, the last move wins, stop ends the run", () => {
    const outcome = evaluate(
      [
        rule({
          id: "a",
          actions: [{ type: "label", labelId: "lbl_ci" }, { type: "markRead" }, { type: "archive" }],
        }),
        rule({
          id: "b",
          actions: [
            { type: "label", labelId: "lbl_github" },
            { type: "trash" },
            { type: "webhook", endpointId: "wh_1" },
          ],
          stop: true,
        }),
        rule({ id: "c", actions: [{ type: "star" }, { type: "forward", to: ["x@example.org"] }] }),
      ],
      message,
    )
    expect(outcome).toMatchObject({
      matched: ["a", "b"],
      folder: "trash",
      labelIds: ["lbl_ci", "lbl_github"],
      markRead: true,
      star: false,
      forwards: [],
      webhooks: [{ ruleId: "b", endpointId: "wh_1" }],
    })
  })
})

describe("spam score", () => {
  const auth = (fields: Partial<typeof NO_AUTH_RESULTS>) => ({
    ...NO_AUTH_RESULTS,
    source: "authentication-results" as const,
    ...fields,
  })

  it("rewards aligned DKIM and DMARC, and adds up failures", () => {
    const good = authScore(
      auth({ spf: "pass", dmarc: "pass", dkim: [{ result: "pass", domain: "example.org", selector: "s" }] }),
      { fromDomain: "example.org" },
    )
    expect(good.score).toBe(-2.5)
    const bad = authScore(
      auth({ spf: "fail", dmarc: "fail", dkim: [{ result: "fail", domain: "x.test", selector: null }] }),
      { fromDomain: "example.org" },
    )
    expect(bad.score).toBe(9)
    expect(bad.reasons.map((r) => r.rule)).toEqual(["dmarc=fail", "spf=fail", "dkim=fail"])
    expect(authScore(NO_AUTH_RESULTS, { fromDomain: null }).score).toBe(1)
    // A signature for a subdomain sender's parent domain still counts as aligned.
    expect(
      authScore(auth({ dkim: [{ result: "pass", domain: "example.org", selector: "s" }] }), {
        fromDomain: "mail.example.org",
      }).reasons.map((r) => r.rule),
    ).toContain("dkim=pass aligned")
  })

  it("scales a classifier's probability, clamped to 0..1", () => {
    expect(classifierPoints(0.9)).toBe(5.4)
    expect(classifierPoints(2)).toBe(6)
    expect(classifierPoints(-1)).toBe(0)
  })

  it("reads the probability out of a model's reply, prose or not", () => {
    expect(readProbability('{"spam_probability": 0.8}')).toBe(0.8)
    expect(readProbability('Sure! {"spam_probability":0.05} hope that helps')).toBe(0.05)
    expect(readProbability({ spam_probability: 0.3 })).toBe(0.3)
    expect(readProbability("not json")).toBeNull()
    expect(readProbability('{"spam_probability": "high"}')).toBeNull()
  })
})
