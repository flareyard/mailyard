import { writeFileSync } from "node:fs"
import path from "node:path"
import * as Schema from "effect/Schema"
import { MAIL_EVENTS_VERSION, MailEvent } from "../../src/contracts/mailEvents.ts"

/** The mail-events contract as JSON Schema, for consumers not written in TypeScript (HAL-3306). */
export const mailEventsJsonSchema = () => {
  const doc = Schema.toJsonSchemaDocument(MailEvent)
  return `${JSON.stringify(
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://github.com/flareyard/mailyard/blob/main/docs/mail-events.schema.json",
      title: `Mailyard mail event, version ${MAIL_EVENTS_VERSION}`,
      $comment: "Generated from src/contracts/mailEvents.ts by bun run contracts. Don't edit by hand.",
      ...doc.schema,
      ...(Object.keys(doc.definitions).length > 0 ? { definitions: doc.definitions } : {}),
    },
    null,
    2,
  )}\n`
}

export const SCHEMA_FILE = path.join(import.meta.dirname, "..", "..", "docs", "mail-events.schema.json")

if (import.meta.main) {
  writeFileSync(SCHEMA_FILE, mailEventsJsonSchema())
  console.log(`wrote ${path.relative(process.cwd(), SCHEMA_FILE)}`)
}
