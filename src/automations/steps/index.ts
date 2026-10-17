import type { GraphNode, NodeType } from "../graph.ts"
import { branch } from "./branch.ts"
import { exit } from "./exit.ts"
import { send } from "./send.ts"
import { topic } from "./topic.ts"
import { trigger } from "./trigger.ts"
import type { StepContext, StepDefinition, StepOutcome } from "./types.ts"
import { update } from "./update.ts"
import { wait } from "./wait.ts"
import { waitEvent } from "./waitEvent.ts"
import { waitUntil } from "./waitUntil.ts"
import { webhook } from "./webhook.ts"

/**
 * Every step type, one file each. To add one: a node schema in ../graph.ts, a file here exporting a
 * StepDefinition, and an entry below. The run Workflow and the dry run both go through `runStep`.
 */
export const STEPS: { readonly [T in NodeType]: StepDefinition<T> } = {
  trigger,
  wait,
  wait_until: waitUntil,
  wait_event: waitEvent,
  branch,
  send,
  update,
  topic,
  webhook,
  exit,
}

export const runStep = (node: GraphNode, ctx: StepContext): Promise<StepOutcome> =>
  (STEPS[node.type] as StepDefinition<typeof node.type>).run(node as never, ctx)

export const validateStep = (node: GraphNode): string | null =>
  (STEPS[node.type] as StepDefinition<typeof node.type>).validate(node as never)

export type { SendInput, SendResult, StepContext, StepOutcome } from "./types.ts"
