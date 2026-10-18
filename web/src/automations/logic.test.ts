import { describe, expect, it } from "vitest"
import {
  addTarget,
  classifyPlaceholders,
  deleteStep,
  describeNode,
  describeRule,
  describeTrigger,
  dryOutcomeLook,
  type FlowItem,
  flowNodeIds,
  type Graph,
  insertAt,
  insertStep,
  issuesByNode,
  layoutGraph,
  logTitle,
  mailFilters,
  mailWhere,
  missingField,
  notReadyIssues,
  overlayFromDryRun,
  overlayFromRun,
  parseDomains,
  portsOf,
  runOutcomeLook,
  runStepNow,
  stepTitle,
  TRIGGER_DATA_KEYS,
  triggerSub,
  unsuppliedTriggerKeys,
  versionLine,
} from "./logic.ts"

/** The design's Welcome series: a branch on course_viewed, then a wait for course_started on the yes path. */
const welcome: Graph = {
  nodes: [
    { id: "n_trigger", type: "trigger", config: { kind: "event", event: "signed_up" } },
    {
      id: "n_send1",
      type: "send",
      label: "Welcome to Coursified",
      config: { templateId: "tpl_welcome", version: 3 },
    },
    { id: "n_wait1", type: "wait", config: { duration: { amount: 1, unit: "days" } } },
    {
      id: "n_cond",
      type: "branch",
      label: "Viewed a course?",
      config: { kind: "event", event: "course_viewed" },
    },
    {
      id: "n_send2",
      type: "send",
      label: "Pick your first course",
      config: { templateId: "tpl_pick", version: 2 },
    },
    {
      id: "n_waitev",
      type: "wait_event",
      config: { event: "course_started", timeout: { amount: 5, unit: "days" } },
    },
    { id: "n_topic", type: "topic", config: { topicId: "top_courses", action: "subscribe" } },
    { id: "n_exit_a", type: "exit", config: {} },
    {
      id: "n_hook",
      type: "webhook",
      label: "CRM: flag for outreach",
      config: { url: "https://api.coursified.app/hooks/crm" },
    },
    { id: "n_exit_b", type: "exit", config: {} },
    {
      id: "n_send3",
      type: "send",
      label: "Did you see this?",
      config: { templateId: "tpl_nudge", version: "published" },
    },
    { id: "n_update", type: "update", config: { fields: { onboarding: "nudged" } } },
    { id: "n_exit_c", type: "exit", config: {} },
  ],
  edges: [
    { from: "n_trigger", to: "n_send1" },
    { from: "n_send1", to: "n_wait1" },
    { from: "n_wait1", to: "n_cond" },
    { from: "n_cond", to: "n_send2", port: "yes" },
    { from: "n_cond", to: "n_send3", port: "no" },
    { from: "n_send2", to: "n_waitev" },
    { from: "n_waitev", to: "n_topic", port: "event" },
    { from: "n_waitev", to: "n_hook", port: "timeout" },
    { from: "n_topic", to: "n_exit_a" },
    { from: "n_hook", to: "n_exit_b" },
    { from: "n_send3", to: "n_update" },
    { from: "n_update", to: "n_exit_c" },
  ],
}

const kinds = (items: FlowItem[]) => items.map((i) => (i.kind === "node" ? i.node.id : i.kind))

describe("layoutGraph", () => {
  it("walks the trigger's path and forks into lanes at a branch and a wait for event", () => {
    const l = layoutGraph(welcome)
    expect(kinds(l.main)).toEqual(["n_trigger", "n_send1", "n_wait1", "n_cond", "fork"])
    const fork = l.main[4]
    if (fork?.kind !== "fork") throw new Error("expected a fork")
    expect(fork.lanes.map((x) => [x.port, x.label])).toEqual([
      ["yes", "Yes"],
      ["no", "No"],
    ])
    expect(kinds(fork.lanes[0]?.items ?? [])).toEqual(["n_send2", "n_waitev", "fork"])
    const inner = fork.lanes[0]?.items[2]
    if (inner?.kind !== "fork") throw new Error("expected the wait's fork")
    expect(inner.lanes.map((x) => x.label)).toEqual(["It happened", "Timed out"])
    expect(l.orphans).toEqual([])
    expect(l.reachable.size).toBe(welcome.nodes.length)
  })

  it("draws every node once, in drawing order, for Tab", () => {
    const ids = flowNodeIds(layoutGraph(welcome).main)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(welcome.nodes.length)
    expect(ids.slice(0, 5)).toEqual(["n_trigger", "n_send1", "n_wait1", "n_cond", "n_send2"])
  })

  it("marks an open way out, and lays out nodes nothing reaches as orphans", () => {
    const g: Graph = {
      nodes: [
        { id: "t", type: "trigger", config: { kind: "created" } },
        { id: "w", type: "wait", config: { duration: { amount: 2, unit: "hours" } } },
        { id: "lost", type: "exit", config: {} },
      ],
      edges: [{ from: "t", to: "w" }],
    }
    const l = layoutGraph(g)
    expect(kinds(l.main)).toEqual(["t", "w", "open"])
    expect(l.orphans.map(kinds)).toEqual([["lost"]])
    expect(l.reachable.has("lost")).toBe(false)
  })

  it("turns a join into a reference and never loops on a cycle", () => {
    const g: Graph = {
      nodes: [
        { id: "t", type: "trigger", config: { kind: "created" } },
        { id: "b", type: "branch", config: { kind: "event", event: "x" } },
        { id: "a", type: "wait", config: { duration: { amount: 1, unit: "days" } } },
        { id: "e", type: "exit", config: {} },
      ],
      edges: [
        { from: "t", to: "b" },
        { from: "b", to: "a", port: "yes" },
        { from: "b", to: "a", port: "no" },
        { from: "a", to: "b" },
      ],
    }
    const l = layoutGraph(g)
    const fork = l.main[2]
    if (fork?.kind !== "fork") throw new Error("expected a fork")
    expect(kinds(fork.lanes[0]?.items ?? [])).toEqual(["a", "ref"])
    expect(kinds(fork.lanes[1]?.items ?? [])).toEqual(["ref"])
    expect(l.orphans.map(kinds)).toEqual([["e"]])
  })
})

describe("what nodes say", () => {
  const names = {
    template: (id: string) => ({ tpl_welcome: "welcome", tpl_nudge: "nudge" })[id],
    topic: () => "New courses",
  }
  it("describes each type as the canvas shows it", () => {
    const by = (id: string) => welcome.nodes.find((n) => n.id === id) as Graph["nodes"][number]
    expect(describeNode(by("n_trigger"))).toMatchObject({
      kind: "Trigger · event",
      title: "signed_up",
      mono: "POST /v1/track",
    })
    expect(describeNode(by("n_send1"), names)).toMatchObject({
      title: "Welcome to Coursified",
      meta: "Template welcome v3",
      mono: "welcome",
    })
    expect(describeNode(by("n_send3"), names).meta).toBe("Template nudge · published")
    expect(describeNode(by("n_wait1")).title).toBe("1 day")
    expect(describeNode(by("n_waitev")).title).toBe("course_started, up to 5 days")
    expect(describeNode(by("n_cond")).meta).toBe("Did course_viewed since they entered")
    expect(describeNode(by("n_update")).title).toBe("onboarding = nudged")
    expect(describeNode(by("n_topic"), names).title).toBe("Subscribe to New courses")
    expect(describeNode(by("n_hook")).meta).toBe("POST api.coursified.app/hooks/crm")
  })

  it("titles steps for the step log, with timeouts worded as such", () => {
    const by = (id: string) => welcome.nodes.find((n) => n.id === id)
    expect(stepTitle(by("n_trigger"))).toBe("Trigger · signed_up")
    expect(stepTitle(by("n_send1"))).toBe("Send · Welcome to Coursified")
    expect(stepTitle(by("n_wait1"))).toBe("Wait 1 day")
    expect(stepTitle(by("n_waitev"))).toBe("Wait for course_started, up to 5 days")
    expect(logTitle(by("n_waitev"), true, {})).toBe("Timed out waiting for course_started")
    expect(stepTitle(by("n_hook"))).toBe("Call webhook · CRM: flag for outreach")
    expect(stepTitle(by("n_exit_a"))).toBe("Exit")
    expect(stepTitle(undefined, { type: "send", label: null })).toBe("Send email")
  })

  it("words triggers and rule trees", () => {
    expect(
      describeTrigger({ kind: "date", field: "signed_up_at", offsetDays: 0, hour: 9, repeat: "yearly" }),
    ).toBe("date signed_up_at, yearly at 09:00 UTC")
    expect(
      triggerSub({ kind: "date", field: "signed_up_at", offsetDays: 0, hour: 9, repeat: "yearly" }),
    ).toBe("Every year on signed_up_at")
    expect(
      triggerSub({ kind: "segment", segmentId: "seg_1" }, { segment: () => "Trial ends this week" }),
    ).toBe("Enters Trial ends this week")
    expect(
      describeRule({
        type: "all",
        rules: [
          { type: "field", field: "country", op: "in", value: ["NG", "GH"] },
          {
            type: "any",
            rules: [
              { type: "campaign", activity: "clicked", withinDays: 30 },
              { type: "engagement", in: ["active"] },
            ],
          },
        ],
      }),
    ).toBe(
      "country is any of NG, GH and (was clicked any campaign in the last 30 days or engagement is active)",
    )
  })

  it("reads the list's version column", () => {
    expect(versionLine({ version: 5, publishedVersion: 4 })).toBe("v4 · draft v5")
    expect(versionLine({ version: 2, publishedVersion: 2 })).toBe("v2")
    expect(versionLine({ version: 1, publishedVersion: null })).toBe("Never published")
  })

  it("names the step a run is on", () => {
    const wait = welcome.nodes.find((n) => n.id === "n_wait1")
    expect(runStepNow({ status: "waiting", nodeId: "n_wait1", waitingFor: null, exitedBy: null }, wait)).toBe(
      "Wait 1 day",
    )
    expect(
      runStepNow({ status: "exited", nodeId: null, waitingFor: null, exitedBy: "unsubscribed" }, undefined),
    ).toBe("Exited: unsubscribed")
    expect(
      runStepNow({ status: "completed", nodeId: "n_exit_a", waitingFor: null, exitedBy: null }, undefined),
    ).toBe("Finished")
  })
})

describe("trigger data and placeholders (HAL-3411)", () => {
  it("carries the API's keys per kind", () => {
    expect(TRIGGER_DATA_KEYS.date).toEqual(["field", "date", "offsetDays", "years"])
    expect(TRIGGER_DATA_KEYS.event).toBe("any")
  })

  it("says who fills each required placeholder", () => {
    const ph = classifyPlaceholders(
      ["first_name", "trigger.topicName", "trigger.years", "unsubscribe_url"],
      "date",
    )
    expect(ph.map((p) => [p.name, p.cls])).toEqual([
      ["first_name", "is-field"],
      ["trigger.topicName", "is-bad"],
      ["trigger.years", "is-ok"],
      ["unsubscribe_url", "is-ok"],
    ])
    expect(ph[1]?.why).toBe("a date trigger can’t")
    expect(classifyPlaceholders(["trigger.plan"], "event")[0]?.cls).toBe("is-event")
  })

  it("lists the trigger keys a kind can't carry, as the publish check does", () => {
    expect(unsuppliedTriggerKeys("date", ["first_name", "trigger.topicName", "trigger.years"])).toEqual([
      "topicName",
    ])
    expect(unsuppliedTriggerKeys("event", ["trigger.anything"])).toEqual([])
  })

  it("inserts a placeholder at the caret with spacing", () => {
    expect(insertAt("Hi there", 2, "{{ trigger.plan }}")).toEqual({
      value: "Hi {{ trigger.plan }} there",
      caret: 21,
    })
    expect(insertAt("", null, "{{ x }}")).toEqual({ value: "{{ x }}", caret: 7 })
    expect(insertAt("Hello ", 6, "{{ x }}").value).toBe("Hello {{ x }}")
  })

  it("words a mail_received trigger and reads its domains as the API matches them (HAL-3467)", () => {
    const t = {
      kind: "mail_received" as const,
      mailboxIds: ["mbx_support", "mbx_billing"],
      senderDomains: ["stripe.com"],
      subjectContains: "invoice",
    }
    const names = { mailbox: (id: string) => ({ mbx_support: "support@", mbx_billing: "billing@" })[id] }
    expect(mailWhere(t, names)).toBe("support@ or billing@")
    expect(mailWhere({ kind: "mail_received" })).toBe("any mailbox")
    expect(mailFilters(t)).toBe("from stripe.com, subject has “invoice”")
    expect(describeTrigger(t, names)).toBe(
      "mail arrives in support@ or billing@, from stripe.com, subject has “invoice”",
    )
    expect(TRIGGER_DATA_KEYS.mail_received).toEqual([
      "mailboxId",
      "threadId",
      "messageId",
      "from",
      "fromName",
      "subject",
      "senderDomain",
    ])
    expect(parseDomains("@Stripe.com, coursified.app stripe.com")).toEqual({
      domains: ["stripe.com", "coursified.app"],
      error: null,
    })
    expect(parseDomains("not a domain").error).toMatch(/isn’t a domain/)
  })
})

describe("step logs", () => {
  it("never colours a skip red; a failure is red and stops", () => {
    expect(dryOutcomeLook("skipped")).toEqual({ cls: "is-skip", pill: "skip" })
    expect(dryOutcomeLook("timed-out").cls).toBe("is-warn")
    expect(dryOutcomeLook("would-wait").cls).toBe("is-wait")
    expect(dryOutcomeLook("would-send").cls).toBe("is-pass")
    expect(runOutcomeLook("skipped")).toEqual({ cls: "is-skip", pill: "skip" })
    expect(runOutcomeLook("failed")).toEqual({ cls: "is-fail", pill: "fail" })
  })

  it("reads the missing field from the API's words, or from steps[].missing once it exists", () => {
    const detail = "Skipped: The template needs {{ first_name }}, which has no value for this contact."
    expect(missingField(detail)).toBe("first_name")
    expect(missingField("Skipped: The template needs {{ trigger.topicName }}, …")).toBeNull()
    expect(missingField("Sent.")).toBeNull()
    expect(missingField(detail, ["company"])).toBe("company")
  })

  it("draws a dry run's path, skips and taken ports on the canvas", () => {
    const o = overlayFromDryRun({
      version: 5,
      contact: { id: "con_1", email: "priya.r@hey.com" },
      startedAt: 0,
      endsAt: 0,
      endedBy: "exit",
      sends: 0,
      path: [
        {
          nodeId: "n_trigger",
          label: null,
          type: "trigger",
          at: 0,
          outcome: "would-run",
          detail: "Entered.",
        },
        {
          nodeId: "n_send1",
          label: null,
          type: "send",
          at: 0,
          outcome: "skipped",
          detail: "Skipped: The template needs {{ first_name }}, which…",
        },
        { nodeId: "n_cond", label: null, type: "branch", at: 0, outcome: "yes", detail: "Yes" },
        {
          nodeId: "n_waitev",
          label: null,
          type: "wait_event",
          at: 0,
          outcome: "would-wait",
          detail: "Waiting",
        },
        { nodeId: "n_waitev", label: null, type: "wait_event", at: 0, outcome: "timed-out", detail: "No" },
      ],
    })
    expect([...o.order.entries()]).toEqual([
      ["n_trigger", 1],
      ["n_send1", 2],
      ["n_cond", 3],
      ["n_waitev", 4],
    ])
    expect(o.skipped.has("n_send1")).toBe(true)
    expect(o.why.get("n_send1")).toBe("first_name")
    expect([...o.ports]).toEqual(["n_cond:yes", "n_waitev:timeout"])
  })

  it("draws a run's failed step", () => {
    const o = overlayFromRun({
      id: "run_1",
      automationId: "aut_1",
      contactId: "con_1",
      email: null,
      version: 4,
      nodeId: "n_hook",
      status: "failed",
      enteredAt: 0,
      nextAt: null,
      waitingFor: null,
      error: "The webhook answered 500.",
      exitedBy: null,
      finishedAt: 1,
      steps: [
        { seq: 2, nodeId: "n_hook", outcome: "failed", port: null, detail: "x", messageId: null, at: 1 },
        {
          seq: 1,
          nodeId: "n_waitev",
          outcome: "passed",
          port: "timeout",
          detail: "x",
          messageId: null,
          at: 0,
        },
      ],
    })
    expect(o.order.get("n_waitev")).toBe(1)
    expect(o.failed.has("n_hook")).toBe(true)
    expect(o.ports.has("n_waitev:timeout")).toBe(true)
  })
})

describe("editing the draft", () => {
  it("puts a one-way step on an edge without dropping what came after", () => {
    const { graph, id } = insertStep(welcome, "n_send1", undefined, "update")
    expect(id).toBe("n_update1")
    expect(graph.edges).toContainEqual({ from: "n_send1", to: id })
    expect(graph.edges).toContainEqual({ from: id, to: "n_wait1" })
    expect(graph.edges.filter((e) => e.from === "n_send1")).toHaveLength(1)
    expect(layoutGraph(graph).orphans).toEqual([])
  })

  it("gives a new fork's second way out its own exit", () => {
    const { graph, id } = insertStep(welcome, "n_trigger", undefined, "branch")
    const out = graph.edges.filter((e) => e.from === id)
    expect(out.map((e) => e.port)).toEqual(["yes", "no"])
    expect(out[0]?.to).toBe("n_send1")
    expect(graph.nodes.find((n) => n.id === out[1]?.to)?.type).toBe("exit")
    expect(portsOf("branch")).toEqual(["yes", "no"])
  })

  it("puts a step on a lane", () => {
    const { graph, id } = insertStep(welcome, "n_cond", "no", "wait")
    expect(graph.edges).toContainEqual({ from: "n_cond", to: id, port: "no" })
    expect(graph.edges).toContainEqual({ from: id, to: "n_send3" })
  })

  it("deletes a step and joins its neighbours; never the trigger", () => {
    const g = deleteStep(welcome, "n_wait1")
    expect(g.nodes.some((n) => n.id === "n_wait1")).toBe(false)
    expect(g.edges).toContainEqual({ from: "n_send1", to: "n_cond" })
    expect(deleteStep(welcome, "n_trigger")).toBe(welcome)
  })

  it("adds after the selected step, else before the main path's first exit", () => {
    expect(addTarget(welcome, "n_wait1")).toEqual({ from: "n_wait1", port: undefined })
    expect(addTarget(welcome, "n_cond")).toEqual({ from: "n_cond", port: "yes" })
    const line: Graph = {
      nodes: [
        { id: "t", type: "trigger", config: { kind: "created" } },
        { id: "s", type: "wait", config: { duration: { amount: 1, unit: "days" } } },
        { id: "x", type: "exit", config: {} },
      ],
      edges: [
        { from: "t", to: "s" },
        { from: "s", to: "x" },
      ],
    }
    expect(addTarget(line, null)).toEqual({ from: "s", port: undefined })
  })
})

describe("issues", () => {
  it("groups issues by node and reads a 409 NotReady", () => {
    const issues = [
      { nodeId: "n_send1", code: "invalid_config", message: "a" },
      { nodeId: null, code: "cycle", message: "b" },
    ]
    const m = issuesByNode(issues)
    expect(m.get("n_send1")).toHaveLength(1)
    expect(m.get("")).toHaveLength(1)
    expect(notReadyIssues({ _tag: "NotReady", message: "2 thing(s)", issues })).toEqual(issues)
    expect(notReadyIssues({ _tag: "Conflict" })).toBeNull()
  })
})
