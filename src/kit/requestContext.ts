import { AsyncLocalStorage } from "node:async_hooks"

/**
 * The request a piece of work is running for, carried through every await without threading it by
 * hand (HAL-3464): a webhook delivery names the API request that caused its event, so a support
 * conversation can join the two. Set once per request at the edge (src/workers/api.ts); outside a
 * request (queues, crons, inbound mail) there is none.
 */
const storage = new AsyncLocalStorage<{ readonly requestId: string }>()

export const withRequestContext = <T>(requestId: string, run: () => T): T => storage.run({ requestId }, run)

/** The current API request's id, if this work runs inside one. */
export const currentRequestId = (): string | null => storage.getStore()?.requestId ?? null
