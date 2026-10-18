import { and, desc, eq, gt, isNull, or } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { agents, apiKeys, mailboxes } from "../db/schema.ts"
import { Database } from "../services/Database.ts"
import { describeLane } from "./mailEvents.ts"
import { listEndpoints } from "./webhooks.ts"

/**
 * What's connected to this workspace (HAL-3466), read-only: the MCP keys agents use, how the webhook
 * endpoints are doing, the Hermes mail-events lane, and sibling apps. Sibling apps talk to Mailyard through MCP
 * (Support Inbox) and the mail-events queue (Hermes), so this reports on those links rather than
 * owning them. Keys are still made and revoked on `/v1/api-keys` (`purpose: mcp`) and `/v1/agents`.
 */

/** A sibling app is recognised by an MCP key named for it, until the platform says what's installed. */
export const SIBLINGS = [
  { app: "support-inbox", name: "Support Inbox", match: /support[\s-]*inbox/i },
] as const

/** An endpoint counts as failing when it has dead deliveries, or its last attempt failed. */
const failing = (e: {
  readonly enabled: boolean
  readonly paused: boolean
  readonly deadLetters: number
  readonly lastFailureAt: number | null
  readonly lastSuccessAt: number | null
}) => e.enabled && !e.paused && (e.deadLetters > 0 || (e.lastFailureAt ?? 0) > (e.lastSuccessAt ?? 0))

export const describeIntegrations = Effect.fn("integrations.describe")(function* (input: {
  /** Where `/mcp` is reached from outside, for the connection snippet. */
  readonly origin: string | null
  /** Whether the caller may see the keys themselves (`keys.manage`); counts are shown either way. */
  readonly showKeys: boolean
}) {
  const database = yield* Database
  const now = Date.now()
  const keys = yield* database.query("integrations.mcpKeys", (db) =>
    db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        prefix: apiKeys.prefix,
        scopes: apiKeys.scopes,
        lastUsedAt: apiKeys.lastUsedAt,
        createdAt: apiKeys.createdAt,
        agentId: agents.id,
        agentName: agents.name,
        mailboxId: agents.mailboxId,
        mailboxAddress: mailboxes.address,
      })
      .from(apiKeys)
      .leftJoin(agents, and(eq(agents.keyId, apiKeys.id), isNull(agents.removedAt)))
      .leftJoin(mailboxes, eq(mailboxes.id, agents.mailboxId))
      .where(and(eq(apiKeys.purpose, "mcp"), or(isNull(apiKeys.revokedAt), gt(apiKeys.revokedAt, now))))
      .orderBy(desc(apiKeys.createdAt))
      .limit(500)
      .all(),
  )
  const endpoints = yield* listEndpoints()
  const lane = yield* describeLane()
  const lastUsed = keys.reduce<number | null>(
    (latest, k) =>
      k.lastUsedAt !== null && (latest === null || k.lastUsedAt > latest) ? k.lastUsedAt : latest,
    null,
  )
  return {
    mcp: {
      endpoint: input.origin ? `${input.origin}/mcp` : null,
      keyCount: keys.length,
      agentCount: keys.filter((k) => k.agentId !== null).length,
      lastUsedAt: lastUsed,
      keys: input.showKeys
        ? keys.map((k) => ({
            id: k.id,
            name: k.name,
            prefix: k.prefix,
            scopes: [...k.scopes],
            lastUsedAt: k.lastUsedAt,
            createdAt: k.createdAt,
            agent:
              k.agentId !== null
                ? {
                    id: k.agentId,
                    name: k.agentName ?? k.name,
                    mailboxId: k.mailboxId ?? "",
                    address: k.mailboxAddress ?? null,
                  }
                : null,
          }))
        : null,
    },
    webhooks: {
      count: endpoints.length,
      enabled: endpoints.filter((e) => e.enabled).length,
      paused: endpoints.filter((e) => e.paused).length,
      failing: endpoints.filter(failing).length,
      deadLetters: endpoints.reduce((n, e) => n + e.deadLetters, 0),
      held: endpoints.reduce((n, e) => n + e.held, 0),
      failingEndpoints: endpoints.filter(failing).map((e) => ({
        id: e.id,
        url: e.url,
        deadLetters: e.deadLetters,
        lastFailureAt: e.lastFailureAt,
        lastSuccessAt: e.lastSuccessAt,
      })),
    },
    /** The Hermes email lane (HAL-3306). */
    hermes: {
      connected: lane.enabled && lane.available,
      lane: lane.enabled ? lane.queue : null,
      mailboxes: lane.enabled ? [...(lane.mailboxIds ?? [])] : [],
      allMailboxes: lane.enabled && lane.mailboxIds === null,
      since: lane.enabled ? lane.since : null,
      available: lane.available,
    },
    siblings: SIBLINGS.map((s) => {
      const key = keys.find((k) => s.match.test(k.name))
      return {
        app: s.app,
        name: s.name,
        via: "mcp" as const,
        connected: key !== undefined,
        keyId: key && input.showKeys ? key.id : null,
        lastUsedAt: key?.lastUsedAt ?? null,
      }
    }),
  }
})
