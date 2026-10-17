#!/usr/bin/env bun
/**
 * Puts Coursified's lifecycle emails into a Mailyard install (HAL-3383): the six ported templates
 * (published, so automations can use them; a template sends nothing on its own), and the six
 * automations as DRAFTS that follow packages/emails/FLOWS.md. Nothing here publishes an automation:
 * switching Coursified over is the founder's call (HAL-3302). Then it dry-runs each automation with
 * a sample contact and writes the paths to dry-runs.md.
 *
 *   MAILYARD_URL=https://… MAILYARD_KEY=… MAILYARD_FROM="Coursified <hello@coursified.app>" \
 *     bun tools/coursified/install.ts
 *
 * Idempotent: templates and automations are matched by name and updated in place.
 */
import { writeFileSync } from "node:fs"
import path from "node:path"
import { dataFor, EVENTS, type LifecycleKey, SAMPLES } from "./data.ts"
import templates from "./generated/templates.json"

const base = process.env.MAILYARD_URL ?? ""
const key = process.env.MAILYARD_KEY ?? ""
const from = process.env.MAILYARD_FROM ?? "Coursified <hello@coursified.app>"
if (!base || !key) throw new Error("Set MAILYARD_URL and MAILYARD_KEY.")

const api = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "user-agent": "mailyard-coursified-port/1",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  if (!res.ok) throw new Error(`${method} ${route}: ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

type Ported = { name: string; subject: string; html: string; text: string }
const ported = templates as Record<LifecycleKey, Ported>

// Templates, by name: create, or add a new version and publish it.
const existing = await api<{ templates: Array<{ id: string; name: string }> }>("GET", "/v1/templates")
const templateIds = {} as Record<LifecycleKey, string>
for (const k of Object.keys(ported) as Array<LifecycleKey>) {
  const t = ported[k]
  const body = { subject: t.subject, source: t.html, text: t.text }
  const found = existing.templates.find((x) => x.name === t.name)
  if (found) {
    await api("PUT", `/v1/templates/${found.id}/draft`, body)
    await api("POST", `/v1/templates/${found.id}/publish`)
    templateIds[k] = found.id
  } else {
    templateIds[k] = (
      await api<{ id: string }>("POST", "/v1/templates", {
        name: t.name,
        kind: "html",
        ...body,
        publish: true,
      })
    ).id
  }
}

// The automations, from FLOWS.md. Lifecycle mail: at most two a week across all of them.
const lifecycle = { fromAddress: from, topicId: null, cadence: { max: 2, days: 7 } }
const send = (id: string, k: LifecycleKey, label: string) => ({
  id,
  type: "send",
  label,
  config: { templateId: templateIds[k], version: "published" },
})
const exit = (id: string) => ({ id, type: "exit", config: {} })
const trigger = (k: LifecycleKey) => ({
  id: "t",
  type: "trigger",
  config: { kind: "event", event: EVENTS[k] },
})
const single = (k: LifecycleKey, label: string) => ({
  nodes: [trigger(k), send("s", k, label), exit("x")],
  edges: [
    { from: "t", to: "s" },
    { from: "s", to: "x" },
  ],
})

const AUTOMATIONS: Array<{ name: string; graph: unknown; settings: Record<string, unknown> }> = [
  {
    name: "Coursified B1 · Welcome",
    graph: single("welcome", "Welcome"),
    settings: { ...lifecycle, reentry: { mode: "never" }, stopEvents: [] },
  },
  {
    // Day 3 with no conversion: a nudge; one more four days later if still nothing; then stop.
    name: "Coursified B2 · Activation nudge",
    graph: {
      nodes: [
        trigger("activationNudge"),
        { id: "w1", type: "wait", label: "Day 3", config: { duration: { amount: 3, unit: "days" } } },
        {
          id: "b1",
          type: "branch",
          label: "Converted yet?",
          config: { kind: "event", event: "course_converted" },
        },
        send("s1", "activationNudge", "Nudge"),
        { id: "w2", type: "wait", label: "Day 7", config: { duration: { amount: 4, unit: "days" } } },
        {
          id: "b2",
          type: "branch",
          label: "Converted yet?",
          config: { kind: "event", event: "course_converted" },
        },
        send("s2", "activationNudge", "Last nudge"),
        exit("x1"),
        exit("x2"),
        exit("x3"),
      ],
      edges: [
        { from: "t", to: "w1" },
        { from: "w1", to: "b1" },
        { from: "b1", to: "x1", port: "yes" },
        { from: "b1", to: "s1", port: "no" },
        { from: "s1", to: "w2" },
        { from: "w2", to: "b2" },
        { from: "b2", to: "x2", port: "yes" },
        { from: "b2", to: "s2", port: "no" },
        { from: "s2", to: "x3" },
      ],
    },
    settings: { ...lifecycle, reentry: { mode: "never" }, stopEvents: ["course_converted"] },
  },
  {
    // Coursified's daily cron tracks streak_at_risk the evening before a live streak resets.
    name: "Coursified B3 · Streak rescue",
    graph: single("streakRescue", "Streak rescue"),
    settings: { ...lifecycle, reentry: { mode: "after", days: 1 }, stopEvents: [] },
  },
  {
    name: "Coursified B4 · Retake unlocked",
    graph: single("retakeUnlocked", "Retake unlocked"),
    settings: { ...lifecycle, reentry: { mode: "after", days: 1 }, stopEvents: [] },
  },
  {
    // "Last email unless you come back": once.
    name: "Coursified B5 · Win-back",
    graph: single("winBack", "Win-back"),
    settings: { ...lifecycle, reentry: { mode: "never" }, stopEvents: [] },
  },
  {
    // Once per limit hit; the next hit is a month on.
    name: "Coursified B6 · Upgrade to Pro",
    graph: single("upgradeToPro", "Upgrade to Pro"),
    settings: { ...lifecycle, reentry: { mode: "after", days: 1 }, stopEvents: [] },
  },
]
const KEYS: Array<LifecycleKey> = [
  "welcome",
  "activationNudge",
  "streakRescue",
  "retakeUnlocked",
  "winBack",
  "upgradeToPro",
]

const list = await api<{ automations: Array<{ id: string; name: string; status: string }> }>(
  "GET",
  "/v1/automations?range=30d",
)
const report: Array<string> = [
  "# Coursified lifecycle automations: dry runs",
  "",
  `Against ${base}, ${new Date().toISOString()}.`,
  "",
]
for (const [i, a] of AUTOMATIONS.entries()) {
  const found = list.automations.find((x) => x.name === a.name)
  if (found && found.status !== "draft") {
    console.log(`${a.name}: ${found.status}, left as it is`)
    continue
  }
  const saved = found
    ? await api<{ id: string; issues: Array<{ message: string }> }>("PATCH", `/v1/automations/${found.id}`, {
        graph: a.graph,
        settings: a.settings,
      })
    : await api<{ id: string; issues: Array<{ message: string }> }>("POST", "/v1/automations", a)
  const k = KEYS[i] as LifecycleKey
  const sample = SAMPLES[k][0] as never
  const scenarios: Array<[string, Record<string, unknown>]> =
    k === "activationNudge"
      ? [
          ["never converts", {}],
          ["converts on day 5", { events: [{ name: "course_converted", afterMinutes: 5 * 24 * 60 }] }],
          ["converts on day 1", { events: [{ name: "course_converted", afterMinutes: 24 * 60 }] }],
        ]
      : [["sample", {}]]
  report.push(
    `## ${a.name}`,
    "",
    `Trigger: \`${EVENTS[k]}\`. Draft issues: ${saved.issues.map((x) => x.message.replace(/\.$/, "")).join("; ") || "none"}.`,
    "",
  )
  for (const [label, extra] of scenarios) {
    const run = await api<{
      path: Array<{ nodeId: string; at: number; outcome: string; detail: string; send?: { subject: string } }>
      startedAt: number
    }>("POST", `/v1/automations/${saved.id}/dry-run`, {
      contact: { email: "learner@example.com", name: "Ada Lovelace" },
      triggerData: (dataFor[k] as (p: unknown) => Record<string, unknown>)(sample),
      ...extra,
    })
    report.push(`**${label}**`, "", "| Day | Step | Outcome | Detail |", "|---|---|---|---|")
    for (const s of run.path)
      report.push(
        `| ${((s.at - run.startedAt) / 86_400_000).toFixed(2)} | ${s.nodeId} | ${s.outcome} | ${s.send ? `"${s.send.subject}"` : s.detail} |`,
      )
    report.push("")
  }
  console.log(`${a.name}: draft ${saved.id}`)
}
writeFileSync(path.join(import.meta.dirname, "dry-runs.md"), `${report.join("\n")}\n`)
console.log("dry runs → tools/coursified/dry-runs.md")
