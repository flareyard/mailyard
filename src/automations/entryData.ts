import { eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { segments, topics } from "../db/schema.ts"
import { Database } from "../services/Database.ts"
import type { TriggerConfig } from "./graph.ts"
import { dateTriggerData } from "./triggerData.ts"

/**
 * What a run's `trigger` holds when a contact enters (HAL-3411, keys in TRIGGER_DATA_KEYS). An event
 * trigger keeps the event's own data. The other kinds get theirs filled in, with anything the entry
 * brought (the date sweep's data, the API's) on top. The real entry and the dry run both use this, so
 * a dry run shows what the run will see.
 */
export const entryTriggerData = (
  trigger: TriggerConfig | undefined,
  contact: { readonly createdAt: number; readonly fields: Readonly<Record<string, unknown>> },
  data: Readonly<Record<string, unknown>> | null,
  now: number,
) =>
  Effect.gen(function* () {
    if (!trigger || trigger.kind === "event") return data ? { ...data } : null
    const database = yield* Database
    switch (trigger.kind) {
      case "created":
        return { createdAt: contact.createdAt, ...data }
      case "topic": {
        const topic = yield* database.query("automations.entryTopic", (db) =>
          db.select({ name: topics.name }).from(topics).where(eq(topics.id, trigger.topicId)).get(),
        )
        return { topicId: trigger.topicId, topicName: topic?.name ?? null, ...data }
      }
      case "segment": {
        const segment = yield* database.query("automations.entrySegment", (db) =>
          db.select({ name: segments.name }).from(segments).where(eq(segments.id, trigger.segmentId)).get(),
        )
        return { segmentId: trigger.segmentId, segmentName: segment?.name ?? null, ...data }
      }
      case "date":
        // The sweep brings the date as of the day it matched; any other entry gets it as of now.
        return data ? { ...data } : dateTriggerData(trigger, contact.fields[trigger.field], now)
      case "mail_received":
        // The message that started it, as the inbound pipeline handed it over.
        return data ? { ...data } : null
    }
  })
