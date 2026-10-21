/**
 * The two reference pages, written from the sources at request time so they can't drift (HAL-3773):
 * the HTTP API from this Worker's own OpenAPI document, and the MCP tools from `TOOLS`. Both come out
 * as Markdown, which the docs render to HTML or serve as it is.
 */

import { anchorOf } from "./render.ts"

type JsonSchema = {
  $ref?: string
  type?: string | ReadonlyArray<string>
  enum?: ReadonlyArray<unknown>
  const?: unknown
  format?: string
  items?: JsonSchema
  anyOf?: ReadonlyArray<JsonSchema>
  oneOf?: ReadonlyArray<JsonSchema>
  allOf?: ReadonlyArray<JsonSchema>
  properties?: Record<string, JsonSchema>
  required?: ReadonlyArray<string>
  additionalProperties?: boolean | JsonSchema
  description?: string
  title?: string
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  minItems?: number
  maxItems?: number
}

type Parameter = { name: string; in: string; required?: boolean; description?: string; schema?: JsonSchema }
type Operation = {
  tags?: ReadonlyArray<string>
  operationId?: string
  summary?: string
  description?: string
  parameters?: ReadonlyArray<Parameter>
  requestBody?: { description?: string; content?: Record<string, { schema?: JsonSchema }> }
  responses?: Record<string, { description?: string; content?: Record<string, { schema?: JsonSchema }> }>
  security?: ReadonlyArray<Record<string, unknown>>
}
export type OpenApiDoc = {
  info?: { title?: string; version?: string }
  paths: Record<string, Record<string, Operation>>
  tags?: ReadonlyArray<{ name: string; description?: string }>
  components?: { schemas?: Record<string, JsonSchema> }
}

export const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const

/** One line of text for a table cell: no pipes or line breaks to break the row. */
const cell = (s: string) =>
  s
    .replace(/\|/g, "\\|")
    .replace(/\s*\n\s*/g, " ")
    .trim()

const refName = (ref: string) => ref.replace(/^#\/(components\/schemas|\$defs|definitions)\//, "")
/** Effect names a schema's wire form `XEncoded`; the reader knows it as X. */
const schemaName = (ref: string) => refName(ref).replace(/Encoded$/, "")

const resolve = (
  doc: { components?: { schemas?: Record<string, JsonSchema> } },
  s: JsonSchema | undefined,
) => {
  let schema = s
  for (let i = 0; i < 5 && schema?.$ref; i++) {
    const name = refName(schema.$ref)
    schema = doc.components?.schemas?.[name]
  }
  return schema
}

const NON_FINITE = new Set(['"Infinity"', '"-Infinity"', '"NaN"'])

/** A short type, such as `string`, `"all" \| "any"`, `Rule[]` or `object`. */
export const typeOf = (s: JsonSchema | undefined, depth = 0): string => {
  if (!s) return "any"
  if (s.$ref) return schemaName(s.$ref)
  if (s.const !== undefined) return JSON.stringify(s.const)
  if (s.enum) {
    const values = s.enum.map((v) => JSON.stringify(v))
    return values.length > 8 ? `${values.slice(0, 8).join(" | ")} | …` : values.join(" | ")
  }
  const union = s.anyOf ?? s.oneOf
  if (union) {
    if (depth > 2) return "…"
    const parts = [...new Set(union.map((u) => typeOf(u, depth + 1)))]
    // Effect writes a Number that may be non-finite as number | "Infinity" | "-Infinity" | "NaN": to a
    // reader it's a number.
    const finite = parts.includes("number") ? parts.filter((p) => !NON_FINITE.has(p)) : parts
    return finite.join(" | ")
  }
  if (s.allOf?.length === 1) return typeOf(s.allOf[0], depth)
  const type = Array.isArray(s.type) ? s.type.join(" | ") : (s.type as string | undefined)
  if (type === "array") {
    const inner = typeOf(s.items, depth + 1)
    return inner.includes(" ") ? `(${inner})[]` : `${inner}[]`
  }
  if (type === "string" && s.format) return `string (${s.format})`
  if (type) return type
  if (s.properties) return "object"
  return "any"
}

/** Limits worth stating: lengths, ranges and counts. */
const limitsOf = (s: JsonSchema | undefined) => {
  if (!s) return ""
  const parts: Array<string> = []
  if (s.minLength !== undefined && s.minLength > 0) parts.push(`at least ${s.minLength} characters`)
  if (s.maxLength !== undefined) parts.push(`at most ${s.maxLength} characters`)
  if (s.minimum !== undefined) parts.push(`≥ ${s.minimum}`)
  if (s.maximum !== undefined) parts.push(`≤ ${s.maximum}`)
  if (s.minItems !== undefined && s.minItems > 0) parts.push(`at least ${s.minItems} items`)
  if (s.maxItems !== undefined) parts.push(`at most ${s.maxItems} items`)
  return parts.join(", ")
}

/** A table of an object's fields: name, type, whether it's required, and what it is. */
const fieldsTable = (
  doc: { components?: { schemas?: Record<string, JsonSchema> } },
  schema: JsonSchema | undefined,
) => {
  const s = resolve(doc, schema)
  const props = s?.properties
  if (!props || Object.keys(props).length === 0) return null
  const required = new Set(s?.required ?? [])
  const rows = Object.entries(props).map(([name, p]) => {
    const about = [p.description ?? resolve(doc, p)?.description ?? "", limitsOf(p)]
      .filter(Boolean)
      .join(". ")
    return `| \`${name}\` | \`${cell(typeOf(p))}\` | ${required.has(name) ? "yes" : ""} | ${cell(about)} |`
  })
  return ["| Field | Type | Required | About |", "|---|---|---|---|", ...rows].join("\n")
}

/** "apiKeys" → "API keys", "Actions" stays. */
export const groupTitle = (name: string) => {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .toLowerCase()
    .split(" ")
    .map(
      (w) =>
        ({ api: "API", mcp: "MCP", oauth: "OAuth", ai: "AI", dns: "DNS", imap: "IMAP", csv: "CSV" })[w] ?? w,
    )
  const first = words[0] ?? ""
  return [first.charAt(0).toUpperCase() + first.slice(1), ...words.slice(1)].join(" ")
}

/** Every operation in the document, in path order, grouped by its first tag. */
export const operationsOf = (doc: OpenApiDoc) => {
  const groups = new Map<string, Array<{ method: string; path: string; op: Operation }>>()
  for (const tag of doc.tags ?? []) groups.set(tag.name, [])
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of HTTP_METHODS) {
      const op = item[method]
      if (!op) continue
      const tag = op.tags?.[0] ?? "other"
      if (!groups.has(tag)) groups.set(tag, [])
      groups.get(tag)?.push({ method, path, op })
    }
  }
  return [...groups.entries()].filter(([, ops]) => ops.length > 0)
}

/** The HTTP API reference, as Markdown, from the OpenAPI document this Worker serves. */
export const apiReferenceMarkdown = (doc: OpenApiDoc, origin: string) => {
  const groups = operationsOf(doc)
  const total = groups.reduce((n, [, ops]) => n + ops.length, 0)
  const tagInfo = new Map((doc.tags ?? []).map((t) => [t.name, t]))
  const out: Array<string> = [
    "# HTTP API",
    "",
    `Every endpoint this Mailyard serves: ${total} operations in ${groups.length} groups, written from its own OpenAPI document, [\`${origin}/openapi.json\`](${origin}/openapi.json), so it always matches the version you're running. Load that document into any OpenAPI tool for the full schemas.`,
    "",
    "Send a key as `Authorization: Bearer sk_…` (see [Get started](/docs/getting-started)). Every error has the same shape: see [Errors](/docs/errors).",
    "",
    "## Groups",
    "",
    ...groups.map(([tag, ops]) => `- [${groupTitle(tag)}](#${anchorOf(groupTitle(tag))}) (${ops.length})`),
  ]
  for (const [tag, ops] of groups) {
    out.push("", `## ${groupTitle(tag)}`, "")
    const about = tagInfo.get(tag)?.description
    if (about) out.push(about, "")
    for (const { method, path, op } of ops) {
      out.push(`### ${method.toUpperCase()} ${path}`, "")
      const text = [op.summary, op.description].filter(Boolean).join("\n\n")
      if (text) out.push(text, "")
      if (!op.security || op.security.length === 0 || op.security.every((s) => Object.keys(s).length === 0))
        out.push("No key needed.", "")
      const params = op.parameters ?? []
      if (params.length > 0) {
        out.push("| Parameter | In | Type | Required | About |", "|---|---|---|---|---|")
        for (const p of params)
          out.push(
            `| \`${p.name}\` | ${p.in} | \`${cell(typeOf(p.schema))}\` | ${p.required ? "yes" : ""} | ${cell(
              [p.description ?? p.schema?.description ?? "", limitsOf(p.schema)].filter(Boolean).join(". "),
            )} |`,
          )
        out.push("")
      }
      const body = op.requestBody?.content
      if (body) {
        const [type, media] = Object.entries(body)[0] ?? []
        const table = type === "application/json" ? fieldsTable(doc, media?.schema) : null
        if (op.requestBody?.description) out.push(op.requestBody.description, "")
        if (table) out.push("Body (JSON):", "", table, "")
        else if (type) out.push(`Body: \`${type}\`.`, "")
      }
      const responses = Object.entries(op.responses ?? {})
      const ok = responses.filter(([code]) => code.startsWith("2"))
      const errors = responses.filter(([code]) => !code.startsWith("2"))
      for (const [code, r] of ok) {
        const schema = r.content?.["application/json"]?.schema
        const table = schema ? fieldsTable(doc, schema) : null
        out.push(
          `Answers \`${code}\`${table ? ":" : r.description && r.description !== "Success" ? `: ${r.description}.` : "."}`,
          "",
        )
        if (table) out.push(table, "")
      }
      if (errors.length > 0)
        out.push(
          `Errors: ${errors
            .map(([code, r]) => {
              const schema = r.content?.["application/json"]?.schema
              const names = (schema?.anyOf ?? schema?.oneOf ?? (schema ? [schema] : []))
                .map((s) => (s.$ref ? schemaName(s.$ref) : (r.description ?? "")))
                .filter(Boolean)
              const label = names.length > 0 ? [...new Set(names)].join(", ") : (r.description ?? "")
              return `\`${code}\`${label ? ` ${label}` : ""}`
            })
            .join(" · ")}.`,
          "",
        )
    }
  }
  return `${out.join("\n").trimEnd()}\n`
}

export interface ToolDoc {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly scope: string
  readonly readOnly: boolean
  readonly destructive: boolean
  readonly inputSchema: JsonSchema & { $defs?: Record<string, JsonSchema> }
}

/** The MCP tool reference, as Markdown, from the tools the server offers. */
export const mcpToolsMarkdown = (tools: ReadonlyArray<ToolDoc>, origin: string) => {
  const out: Array<string> = [
    "# MCP tools",
    "",
    `Every tool the MCP server at \`${origin}/mcp\` offers: ${tools.length} in all, written from the server's own list, so it always matches the version you're running. A client sees only the tools its key's scopes allow; an \`admin\` key sees them all. How to connect: [Connect an MCP client](/docs/mcp).`,
    "",
    "| Tool | Scope | Does |",
    "|---|---|---|",
    ...tools.map(
      (t) =>
        `| [\`${t.name}\`](#${anchorOf(t.name)}) | \`${t.scope}\` | ${cell(t.readOnly ? "Reads" : t.destructive ? "Changes or sends" : "Writes")} |`,
    ),
  ]
  for (const t of tools) {
    out.push(
      "",
      `## ${t.name}`,
      "",
      `${t.title}. Needs the \`${t.scope}\` scope.`,
      "",
      t.description.trim(),
      "",
    )
    const defs = { components: { schemas: t.inputSchema.$defs ?? {} } }
    const table = fieldsTable(defs, t.inputSchema)
    out.push(table ? `Input:\n\n${table}` : "No input.")
  }
  return `${out.join("\n").trimEnd()}\n`
}
