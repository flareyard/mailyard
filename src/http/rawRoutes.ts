/**
 * The routes that carry bytes or a socket, served beside the schema-first API (src/workers/api.ts:
 * uploads, files, raw messages, attachments, the live socket), described here so the OpenAPI document
 * lists every route that exists (HAL-3398). Added to the generated document by MailApi's transform;
 * test/health.test.ts checks each path is both described and routed.
 */

const bearer = [{ bearer: [] }]
const problem = (description: string) => ({
  description,
  content: {
    "application/json": {
      schema: {
        type: "object",
        properties: {
          error: { type: "object", properties: { message: { type: "string" }, reason: { type: "string" } } },
        },
      },
    },
  },
})
const idParam = (name: string, description: string) => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string" },
  description,
})
const filenameParam = {
  name: "filename",
  in: "query",
  required: true,
  schema: { type: "string", maxLength: 255 },
  description: "The file's name, without slashes. An x-filename header works too.",
}
const binaryBody = (description: string) => ({
  required: true,
  description,
  content: { "*/*": { schema: { type: "string", format: "binary" } } },
})
const bytes = (description: string, type = "application/octet-stream") => ({
  description,
  content: { [type]: { schema: { type: "string", format: "binary" } } },
})

export const RAW_PATHS: Record<string, Record<string, unknown>> = {
  "/mcp": {
    post: {
      tags: ["mcp"],
      operationId: "mcp.rpc",
      summary: "The MCP server (Streamable HTTP, stateless)",
      description:
        "JSON-RPC 2.0, one message or a batch: initialize, ping, tools/list and tools/call. Tools: list_mailboxes, search_mail, read_thread, draft_reply, send_draft, send_email, preview_segment, campaign_stats, contact_lookup, track_event, each limited by the key's scopes and mailbox memberships. send_draft and send_email need confirm: true. Notifications are answered 202. GET (no server stream) and DELETE (no sessions) answer 405.",
      security: bearer,
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { type: "object", description: "A JSON-RPC 2.0 request, or an array of them." },
          },
        },
      },
      responses: {
        "200": {
          description: "The JSON-RPC response (or array of them).",
          content: { "application/json": { schema: { type: "object" } } },
        },
        "202": { description: "Only notifications: accepted." },
        "400": problem("Not JSON-RPC, or an unsupported MCP-Protocol-Version."),
        "401": problem("No key, or not a key Mailyard knows."),
        "403": problem("A public key."),
        "405": problem("Not a POST."),
      },
    },
  },
  "/v1/uploads": {
    post: {
      tags: ["imports"],
      operationId: "uploads.create",
      summary: "Upload a file to import",
      description:
        "The request body is the file: a contact or suppression CSV, at most 50 MiB. Its Content-Type is kept. Answers an id that POST /v1/imports/contacts and POST /v1/suppressions/import take. Needs the admin scope.",
      security: bearer,
      parameters: [filenameParam],
      requestBody: binaryBody("The file's bytes."),
      responses: {
        "201": {
          description: "Stored.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["id", "filename", "mimeType", "size", "sha256", "createdAt"],
                properties: {
                  id: { type: "string" },
                  filename: { type: "string" },
                  mimeType: { type: "string" },
                  size: { type: "number" },
                  sha256: { type: "string" },
                  createdAt: { type: "number" },
                },
              },
            },
          },
        },
        "400": problem("No filename, or an empty file."),
        "401": problem("No key, or not a key Mailyard knows."),
        "403": problem("The key lacks the admin scope."),
        "413": problem("Over 50 MiB."),
      },
    },
  },
  "/v1/mailboxes/{id}/uploads": {
    post: {
      tags: ["mail"],
      operationId: "mail.upload",
      summary: "Upload an attachment for a draft",
      description:
        "The request body is the file, at most 25 MiB. Put the answered key in a draft's attachments; ones too big for Email Service's 5 MiB go as expiring links (see each draft attachment's delivery). Needs write access to the mailbox.",
      security: bearer,
      parameters: [idParam("id", "The mailbox."), filenameParam],
      requestBody: binaryBody("The file's bytes."),
      responses: {
        "201": {
          description: "Stored.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["key", "filename", "mimeType", "size", "sha256"],
                properties: {
                  key: { type: "string" },
                  filename: { type: "string" },
                  mimeType: { type: "string" },
                  size: { type: "number" },
                  sha256: { type: "string" },
                },
              },
            },
          },
        },
        "400": problem("No filename, or an empty file."),
        "401": problem("No key, or not a key Mailyard knows."),
        "403": problem("No write access to the mailbox."),
        "404": problem("No such mailbox."),
        "413": problem("Over 25 MiB."),
      },
    },
  },
  "/v1/mailboxes/{id}/live": {
    get: {
      tags: ["mail"],
      operationId: "mail.live",
      summary: "Live changes over a WebSocket",
      description:
        'Upgrade: websocket. Frames are JSON: hello { seq, schemaVersion, counts, labels }, then message.added, threads.changed, drafts.changed and counts, each with a seq. Reconnect with ?since=<seq>, or send {"type":"resume","since":n}, to replay what was missed: the frames, then resumed { since, seq, replayed }, or reset { seq, counts } when they\'re older than the kept 1,000 or a day. Send "ping" for "pong". A browser that can\'t set headers offers the subprotocols "mailyard.v1, bearer.<key>" instead of an Authorization header.',
      security: bearer,
      parameters: [
        idParam("id", "The mailbox."),
        {
          name: "since",
          in: "query",
          required: false,
          schema: { type: "number" },
          description: "The last seq this client saw.",
        },
      ],
      responses: {
        "101": { description: "Switching to the WebSocket." },
        "401": problem("No key, or not a key Mailyard knows."),
        "403": problem("No read access to the mailbox."),
        "404": problem("No such mailbox."),
        "426": problem("Not a WebSocket upgrade."),
      },
    },
  },
  "/v1/mailboxes/{id}/messages/{messageId}/raw": {
    get: {
      tags: ["mail"],
      operationId: "mail.raw",
      summary: "A message's original .eml",
      security: bearer,
      parameters: [idParam("id", "The mailbox."), idParam("messageId", "The message.")],
      responses: {
        "200": bytes("The message as received or sent.", "message/rfc822"),
        "401": problem("No key, or not a key Mailyard knows."),
        "403": problem("No read access to the mailbox."),
        "404": problem("No such message, or its original is no longer stored."),
      },
    },
  },
  "/v1/stats/{chart}.csv": {
    get: {
      tags: ["insights"],
      operationId: "insights.csv",
      summary: "An Analytics chart as CSV",
      description:
        "The same numbers as the chart's JSON endpoint. Charts: volume (by=day|hour), delivery (per day, with rates), providers, deferrals, engagement (campaigns), engagement-hours (weekday × UTC hour), unsubscribes (by topic), inbound, audience. Rates stay fractions; an empty cell means not enough data.",
      security: bearer,
      parameters: [
        idParam("chart", "Which chart."),
        {
          name: "range",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["24h", "7d", "30d", "90d"] },
        },
        { name: "by", in: "query", required: false, schema: { type: "string", enum: ["day", "hour"] } },
      ],
      responses: {
        "200": bytes("RFC 4180 CSV with a header row.", "text/csv"),
        "401": problem("No key, or not a key Mailyard knows."),
        "403": problem("A public key, or a key without the read scope."),
        "404": problem("No such chart."),
      },
    },
  },
  "/v1/messages/{id}/raw": {
    get: {
      tags: ["messages"],
      operationId: "messages.raw",
      summary: "A sent message's source (.eml)",
      description:
        "Rebuilt as RFC 5322 from the copy Mailyard stored when it sent the message, with Email Service's Message-ID. Email Service builds the MIME it transmits and adds its own headers (DKIM-Signature, Received), so this is what Mailyard sent, not a capture of the wire.",
      security: bearer,
      parameters: [idParam("id", "The message, as GET /v1/messages lists it.")],
      responses: {
        "200": bytes("The message.", "message/rfc822"),
        "401": problem("No key, or not a key Mailyard knows."),
        "403": problem("A public key, or a key without the read scope."),
        "404": problem("No such message, or its copy is no longer stored."),
      },
    },
  },
  "/v1/mailboxes/{id}/messages/{messageId}/attachments/{attachmentId}": {
    get: {
      tags: ["mail"],
      operationId: "mail.attachment",
      summary: "One attachment's bytes",
      description: "Served as a download, never rendered from Mailyard's origin (nosniff, a sandboxing CSP).",
      security: bearer,
      parameters: [
        idParam("id", "The mailbox."),
        idParam("messageId", "The message."),
        idParam("attachmentId", "The attachment."),
      ],
      responses: {
        "200": bytes("The attachment, with its own Content-Type."),
        "401": problem("No key, or not a key Mailyard knows."),
        "403": problem("No read access to the mailbox."),
        "404": problem("No such attachment."),
      },
    },
  },
  "/v1/files/{token}": {
    get: {
      tags: ["mail"],
      operationId: "files.get",
      summary: "A file through a signed link",
      description:
        "The links in message detail, large-attachment links in sent mail, and export downloads. The token is signed and expires; no key is needed.",
      parameters: [idParam("token", "The signed token from the link.")],
      responses: {
        "200": bytes("The file."),
        "403": problem("The link isn't valid."),
        "404": problem("The file is no longer stored."),
        "410": problem("The link has expired."),
      },
    },
  },
}

/** Adds the raw routes to the generated document. */
export const withRawRoutes = (spec: Record<string, any>) => ({
  ...spec,
  paths: { ...spec.paths, ...RAW_PATHS },
})
