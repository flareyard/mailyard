import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import type * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import type { Env } from "../Bindings.ts"
import {
  beginDeletion,
  eraseMailbox,
  finishDeletion,
  mailboxesToErase,
  tablesToWipe,
  wipeObjectsPage,
  wipeTablePage,
} from "../domain/workspaceDeletion.ts"
import type { appLayer } from "../layers.ts"
import { runtimeFor } from "../workers/inbound.ts"

type AppServices = Layer.Success<ReturnType<typeof appLayer>>

const RETRY = {
  retries: { limit: 5, delay: "10 seconds", backoff: "exponential" },
  timeout: "10 minutes",
} as const

/** Upper bounds that a real workspace stays far below; they only stop a runaway loop. */
const MAX_OBJECT_PAGES = 100_000
const MAX_TABLE_PAGES = 100_000
const MAX_PASSES = 5

/** The instance id for a deletion, so the request, the cron and a restore all name the same one. */
export const deletionInstanceId = (requestedAt: number) => `workspace-delete-${requestedAt}`

const released = <T>(value: T): T => {
  const disposer = (value as { [Symbol.dispose]?: () => void } | null)?.[Symbol.dispose]
  if (typeof disposer === "function") disposer.call(value)
  return value
}

/**
 * Deletes the workspace once its 7 days are up (HAL-3448). It sleeps until `deletesAt`, then checks
 * the deletion is still wanted (a restore clears it), empties every mailbox's Durable Object, the
 * R2 bucket (keeping the deletion export) and every table, and writes the tombstone. Each page is
 * its own step, so a retry repeats only what failed.
 */
export class WorkspaceDeletionWorkflow extends WorkflowEntrypoint<Env, { readonly deletesAt: number }> {
  override async run(event: WorkflowEvent<{ readonly deletesAt: number }>, step: WorkflowStep) {
    const runtime = runtimeFor(this.env)
    const run = <A, E>(effect: Effect.Effect<A, E, AppServices>) => runtime.runPromise(effect)
    await step.sleepUntil("grace window", new Date(event.payload.deletesAt))

    const started = released(await step.do("begin", RETRY, () => run(beginDeletion())))
    if (!started) return { deleted: false }

    const ids = released(await step.do("list mailboxes", RETRY, () => run(mailboxesToErase())))
    for (const id of ids) await step.do(`erase ${id}`, RETRY, () => run(eraseMailbox(id)))

    let cursor: string | null = null
    for (let n = 0; n < MAX_OBJECT_PAGES; n++) {
      const from: string | null = cursor
      const page: { readonly deleted: number; readonly cursor: string | null } = released(
        await step.do(`objects ${n}`, RETRY, () => run(wipeObjectsPage(started.exportId, from))),
      )
      cursor = page.cursor
      if (!cursor) break
    }

    let tables = released(await step.do("list tables", RETRY, () => run(tablesToWipe())))
    for (let pass = 0; pass < MAX_PASSES && tables.length > 0; pass++) {
      const blocked: Array<string> = []
      for (const table of tables) {
        for (let n = 0; n < MAX_TABLE_PAGES; n++) {
          const page = released(
            await step.do(`wipe ${table} ${pass}.${n}`, RETRY, () => run(wipeTablePage(table))),
          )
          if (page.blocked) {
            blocked.push(table)
            break
          }
          if (page.deleted === 0) break
        }
      }
      tables = blocked
    }

    await step.do("tombstone", RETRY, () => run(finishDeletion()))
    return { deleted: true, blockedTables: tables }
  }
}
