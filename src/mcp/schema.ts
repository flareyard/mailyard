import * as Schema from "effect/Schema"
import type { Tool } from "./tools.ts"

/** The tool's input schema as JSON Schema, definitions inlined under $defs. */
export const inputSchemaOf = (tool: Tool) => {
  const doc = Schema.toJsonSchemaDocument(tool.input) as {
    schema: Record<string, unknown>
    definitions?: Record<string, unknown>
  }
  const defs = doc.definitions && Object.keys(doc.definitions).length > 0 ? { $defs: doc.definitions } : {}
  return { type: "object", ...doc.schema, ...defs }
}
