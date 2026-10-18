import * as Cause from "effect/Cause"
import type * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import type { Env } from "../Bindings.ts"
import type { Caller } from "../domain/apiKeys.ts"
import { recordAudit } from "../domain/audit.ts"
import { linkOrigin } from "../public/origin.ts"
import { authorize, problem } from "../workers/auth.ts"
import { runtimeFor } from "../workers/inbound.ts"
import { TOOLS, type Tool } from "./tools.ts"

/**
 * Mailyard's MCP server (HAL-3303), on `/mcp` as Streamable HTTP in its stateless form: each POST
 * carries JSON-RPC (one message or a batch) and is answered with JSON. There's no session to keep and
 * nothing to stream (every tool answers at once), so no Durable Object is needed; a GET for a
 * server-sent stream is refused with 405, as the transport allows. Authenticated like the REST API,
 * with an API key as a Bearer token, and every tool checks the key's scopes and mailbox memberships.
 */

export const MCP_PATH = "/mcp"
const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const
const LATEST = SUPPORTED_VERSIONS[0]

type JsonRpcId = string | number | null
type RpcRequest = { jsonrpc: "2.0"; id?: JsonRpcId; method: string; params?: Record<string, unknown> }
type RpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string; data?: unknown } }

const ERR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
}

/** The tool's input schema as JSON Schema, definitions inlined under $defs. */
const inputSchemaOf = (tool: Tool) => {
  const doc = Schema.toJsonSchemaDocument(tool.input) as {
    schema: Record<string, unknown>
    definitions?: Record<string, unknown>
  }
  const defs = doc.definitions && Object.keys(doc.definitions).length > 0 ? { $defs: doc.definitions } : {}
  return { type: "object", ...doc.schema, ...defs }
}

const listTools = (caller: Caller) =>
  TOOLS.filter((t) => canUse(caller, t)).map((t) => ({
    name: t.name,
    title: t.annotations.title,
    description: t.description,
    inputSchema: inputSchemaOf(t),
    annotations: t.annotations,
  }))

const canUse = (caller: Caller, tool: Tool) =>
  caller.keyId === "root" || caller.scopes.includes("admin") || caller.scopes.includes(tool.scope)

const text = (value: unknown) => JSON.stringify(value, null, 2)

/** The read tools an agent's (`purpose: mcp`) key leaves an audit row for: `mcp.<tool>`. */
const AUDITED_READS = new Set([
  "list_mailboxes",
  "search_mail",
  "read_thread",
  "read_attachment",
  "wait_for_mail",
])

/** A tool's outcome as MCP content: its result, or a refusal the model can read (isError). */
const callTool = async (
  env: Env,
  caller: Caller,
  params: Record<string, unknown> | undefined,
  origin: string,
) => {
  const name = String(params?.name ?? "")
  const tool = TOOLS.find((t) => t.name === name)
  if (!tool) return { error: { code: ERR.invalidParams, message: `No tool ${name}.` } }
  if (!canUse(caller, tool))
    return {
      result: {
        content: [{ type: "text", text: `This key lacks the "${tool.scope}" scope ${tool.name} needs.` }],
        isError: true,
      },
    }
  const decoded = Schema.decodeUnknownExit(tool.input)(params?.arguments ?? {})
  if (Exit.isFailure(decoded))
    return {
      error: {
        code: ERR.invalidParams,
        message: `Invalid arguments for ${name}: ${Cause.pretty(decoded.cause)}`,
      },
    }
  const exit = await runtimeFor(env).runPromiseExit(
    tool.run(decoded.value, caller, { origin }) as Effect.Effect<unknown, unknown, never>,
  )
  if (Exit.isSuccess(exit)) {
    const value = exit.value
    // An agent's reads are audited (HAL-3461): what it looked at, never the content.
    if (caller.purpose === "mcp" && AUDITED_READS.has(tool.name)) {
      const args = decoded.value as Record<string, unknown>
      const pick = (k: string) => (typeof args[k] === "string" ? { [k]: args[k] } : {})
      await runtimeFor(env)
        .runPromise(
          recordAudit({
            actor: caller.keyId,
            action: `mcp.${tool.name}`,
            target: typeof args.mailboxId === "string" ? args.mailboxId : "workspace",
            after: {
              ...pick("mailboxId"),
              ...pick("threadId"),
              ...pick("messageId"),
              ...pick("attachmentId"),
              ...(typeof args.q === "string" ? { query: args.q } : {}),
            },
          }),
        )
        .catch((cause) => console.error(`mcp: could not audit ${tool.name}`, cause))
    }
    return {
      result: {
        content: [{ type: "text", text: text(value) }],
        structuredContent: value && typeof value === "object" && !Array.isArray(value) ? value : { value },
      },
    }
  }
  // Expected refusals (no access, not found, invalid, blocked) are answers for the model, not crashes.
  const failure = exit.cause.reasons.find(Cause.isFailReason)?.error as
    | {
        _tag?: string
        message?: string
        reason?: string
        limit?: number
        sentToday?: number
        resetsAt?: number
        notAllowed?: ReadonlyArray<string>
      }
    | undefined
  if (failure)
    return {
      result: {
        content: [
          {
            type: "text",
            text: `${failure._tag ?? "Error"}: ${failure.message ?? failure.reason ?? "refused"}`,
          },
        ],
        structuredContent: {
          error: failure._tag ?? "Error",
          message: failure.message ?? null,
          reason: failure.reason ?? null,
          // A key's send limits (HAL-3460): the cap, when it resets, who was outside the allow-list.
          ...(failure.limit !== undefined ? { limit: failure.limit } : {}),
          ...(failure.sentToday !== undefined ? { sentToday: failure.sentToday } : {}),
          ...(failure.resetsAt !== undefined ? { resetsAt: failure.resetsAt } : {}),
          ...(failure.notAllowed !== undefined ? { notAllowed: failure.notAllowed } : {}),
        },
        isError: true,
      },
    }
  console.error(`mcp: ${name} failed`, Cause.pretty(exit.cause))
  return { error: { code: ERR.internal, message: `${name} failed; try again.` } }
}

const answer = async (
  env: Env,
  caller: Caller,
  message: RpcRequest,
  origin: string,
): Promise<RpcResponse | null> => {
  const id = message.id ?? null
  const isNotification = message.id === undefined
  const reply = (r: { result?: unknown; error?: { code: number; message: string } }): RpcResponse | null =>
    isNotification
      ? null
      : r.error
        ? { jsonrpc: "2.0", id, error: r.error }
        : { jsonrpc: "2.0", id, result: r.result }
  switch (message.method) {
    case "initialize": {
      const asked = String(message.params?.protocolVersion ?? "")
      const protocolVersion = (SUPPORTED_VERSIONS as ReadonlyArray<string>).includes(asked) ? asked : LATEST
      return reply({
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "mailyard", title: "Mailyard", version: "0.1.0" },
          instructions:
            "Mailyard is this workspace's email: mailboxes, transactional sending, contacts and campaigns. Start with list_mailboxes or search_mail; read_thread lists attachments and read_attachment reads them. Write with compose_message or draft_reply, and tidy with mark_read, archive, label, snooze and move. Drafting never sends; send_draft and send_email need confirm: true, so show the user what will go out first. A key may have send limits or need a person's approval: a held send says so.",
        },
      })
    }
    case "ping":
      return reply({ result: {} })
    case "tools/list":
      return reply({ result: { tools: listTools(caller) } })
    case "tools/call":
      return reply(await callTool(env, caller, message.params, origin))
    default:
      if (message.method.startsWith("notifications/")) return null
      return reply({ error: { code: ERR.methodNotFound, message: `No method ${message.method}.` } })
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

export const handleMcp = async (request: Request, env: Env): Promise<Response> => {
  if (request.method === "GET" || request.method === "DELETE")
    return new Response(null, { status: 405, headers: { allow: "POST" } })
  if (request.method !== "POST") return problem(405, "POST JSON-RPC to /mcp.")
  const auth = await authorize(request, env)
  if (auth instanceof Response) return auth
  if (auth.caller.kind === "public")
    return problem(403, "Public keys can't use the MCP server.", { reason: "public-key" })
  const version = request.headers.get("mcp-protocol-version")
  if (version && !(SUPPORTED_VERSIONS as ReadonlyArray<string>).includes(version))
    return json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: ERR.invalidRequest, message: `Unsupported MCP-Protocol-Version ${version}.` },
      },
      400,
    )
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json(
      { jsonrpc: "2.0", id: null, error: { code: ERR.parse, message: "The body isn't JSON." } },
      400,
    )
  }
  const messages = Array.isArray(body) ? body : [body]
  if (
    messages.length === 0 ||
    messages.some(
      (m) =>
        !m ||
        typeof m !== "object" ||
        (m as RpcRequest).jsonrpc !== "2.0" ||
        typeof (m as RpcRequest).method !== "string",
    )
  ) {
    // Responses from the client (to requests we never send) and malformed messages.
    if (messages.every((m) => m && typeof m === "object" && ("result" in m || "error" in m)))
      return new Response(null, { status: 202 })
    return json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: ERR.invalidRequest, message: "Not a JSON-RPC 2.0 request." },
      },
      400,
    )
  }
  const answers = (
    await Promise.all(
      messages.map((m) =>
        answer(env, auth.caller, m as RpcRequest, linkOrigin(request.url) ?? new URL(request.url).origin),
      ),
    )
  ).filter((a): a is RpcResponse => a !== null)
  // Only notifications: accepted, nothing to say.
  if (answers.length === 0) return new Response(null, { status: 202 })
  return json(Array.isArray(body) ? answers : answers[0])
}
