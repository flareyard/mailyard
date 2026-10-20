/**
 * The empty state's recipes (design: automations-empty.html): each makes a draft with a starting graph. Event
 * names and the template are placeholders the person replaces; until then the draft's `issues` say so.
 */
import type { Graph } from "./logic.ts"

export const RECIPES = [
  {
    id: "welcome",
    name: "Welcome series",
    desc: "Greet new sign-ups, then nudge the ones who don’t look at a course.",
    steps: ["Event", "Send", "Wait", "Branch"],
  },
  {
    id: "trial",
    name: "Trial ending",
    desc: "Remind trials three days and one day before they end.",
    steps: ["Date", "Send", "Wait", "Send"],
  },
  {
    id: "winback",
    name: "Win back",
    desc: "Reach contacts who went dormant, then stop mailing those who stay quiet.",
    steps: ["Created", "Wait", "Branch", "Send"],
  },
] as const

export type RecipeId = (typeof RECIPES)[number]["id"]

/** The recipe's graph; `templateId` is the first published template, or empty for the person to pick. */
export function recipeGraph(id: RecipeId, templateId: string): Graph {
  const send = (nid: string, label: string) =>
    ({ id: nid, type: "send", label, config: { templateId, version: "published" } }) as const
  const exit = (nid: string) => ({ id: nid, type: "exit", config: {} }) as const
  if (id === "welcome")
    return {
      nodes: [
        { id: "n_trigger", type: "trigger", config: { kind: "event", event: "signed_up" } },
        send("n_send1", "Welcome"),
        { id: "n_wait1", type: "wait", config: { duration: { amount: 1, unit: "days" } } },
        {
          id: "n_cond",
          type: "branch",
          label: "Viewed a course?",
          config: { kind: "event", event: "course_viewed" },
        },
        exit("n_exit_a"),
        send("n_send2", "Did you see this?"),
        exit("n_exit_b"),
      ],
      edges: [
        { from: "n_trigger", to: "n_send1" },
        { from: "n_send1", to: "n_wait1" },
        { from: "n_wait1", to: "n_cond" },
        { from: "n_cond", to: "n_exit_a", port: "yes" },
        { from: "n_cond", to: "n_send2", port: "no" },
        { from: "n_send2", to: "n_exit_b" },
      ],
    }
  if (id === "trial")
    return {
      nodes: [
        {
          id: "n_trigger",
          type: "trigger",
          config: { kind: "date", field: "trial_ends_at", offsetDays: -3, hour: 9, repeat: "once" },
        },
        send("n_send1", "Three days left"),
        { id: "n_wait1", type: "wait", config: { duration: { amount: 2, unit: "days" } } },
        send("n_send2", "Your trial ends tomorrow"),
        exit("n_exit"),
      ],
      edges: [
        { from: "n_trigger", to: "n_send1" },
        { from: "n_send1", to: "n_wait1" },
        { from: "n_wait1", to: "n_send2" },
        { from: "n_send2", to: "n_exit" },
      ],
    }
  return {
    nodes: [
      { id: "n_trigger", type: "trigger", config: { kind: "created" } },
      { id: "n_wait1", type: "wait", config: { duration: { amount: 90, unit: "days" } } },
      {
        id: "n_cond",
        type: "branch",
        label: "Still dormant?",
        config: { kind: "rule", rule: { type: "engagement", in: ["dormant"] } },
      },
      send("n_send1", "We miss you"),
      exit("n_exit_a"),
      exit("n_exit_b"),
    ],
    edges: [
      { from: "n_trigger", to: "n_wait1" },
      { from: "n_wait1", to: "n_cond" },
      { from: "n_cond", to: "n_send1", port: "yes" },
      { from: "n_cond", to: "n_exit_b", port: "no" },
      { from: "n_send1", to: "n_exit_a" },
    ],
  }
}
