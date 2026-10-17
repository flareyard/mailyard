import type { Rule } from "../../segments/rules.ts"
import type { Duration, NodeOf, NodeType, Port, Settings } from "../graph.ts"

/**
 * What a step can see and do. The run Workflow (src/workflows/automation.ts) implements it against
 * the real database and sender; the dry run (src/automations/dryRun.ts) implements it in memory and
 * records instead of acting. Steps never touch anything else, so the two can't drift (HAL-3301).
 */
export interface StepContext {
  /** Now, for this step: real time in a run, simulated time in a dry run. */
  readonly now: number
  readonly runStartedAt: number
  readonly contact: {
    readonly id: string
    readonly email: string
    readonly name: string | null
    readonly status: string
    readonly fields: Readonly<Record<string, unknown>>
  }
  readonly settings: Settings
  /** Does the contact match this rule tree now? */
  matches(rule: Rule): Promise<boolean>
  /** Did the contact do `event` at or after `since`? */
  didEvent(event: string, since: number): Promise<boolean>
  send(input: SendInput): Promise<SendResult>
  updateFields(fields: Readonly<Record<string, string | number | boolean | null>>): Promise<void>
  setTopic(topicId: string, action: "subscribe" | "unsubscribe"): Promise<void>
  webhook(url: string, payload: Readonly<Record<string, unknown>>): Promise<{ readonly status: number }>
}

export interface SendInput {
  readonly templateId: string
  readonly version: number | "published"
  readonly subject: string | null
  readonly fromAddress: string | null
  readonly topicId: string | null
  readonly trackOpens: boolean
  readonly trackClicks: boolean
}

export type SendResult =
  | {
      readonly status: "sent"
      readonly messageId: string
      readonly subject: string
      readonly preview: string
    }
  | {
      readonly status: "skipped"
      readonly reason: "cadence" | "suppressed" | "unsubscribed"
      readonly detail: string
    }
  /** The governor can't send it yet (pacing or the daily quota): try this step again at `retryAt`. */
  | { readonly status: "deferred"; readonly retryAt: number; readonly detail: string }

/** Where a run goes after a step. */
export type StepOutcome =
  | { readonly kind: "next"; readonly port?: Port; readonly detail: string; readonly messageId?: string }
  | { readonly kind: "sleep"; readonly until: number; readonly detail: string }
  | { readonly kind: "wait_event"; readonly event: string; readonly until: number; readonly detail: string }
  | { readonly kind: "exit"; readonly detail: string }
  /** Run this same step again at `until` (a send the governor deferred). */
  | { readonly kind: "retry"; readonly until: number; readonly detail: string }

export interface StepDefinition<T extends NodeType> {
  readonly type: T
  /** What's wrong with this step's settings, beyond the schema, or null. */
  readonly validate: (node: NodeOf<T>) => string | null
  readonly run: (node: NodeOf<T>, ctx: StepContext) => Promise<StepOutcome>
}

export type { Duration }
