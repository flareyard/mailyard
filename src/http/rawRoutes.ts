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
  "/v1/session/link/{token}": {
    get: {
      tags: ["signInLink"],
      operationId: "signInLink.page",
      summary: "The page a sign-in link opens (HAL-3361)",
      description:
        "An HTML page with one button: opening the link signs nobody in, so a mail scanner that fetches it can't use it up. The button POSTs to the same path.",
      parameters: [idParam("token", "The token from the emailed link.")],
      responses: { "200": bytes("The page.", "text/html") },
    },
    post: {
      tags: ["signInLink"],
      operationId: "signInLink.use",
      summary: "Use a sign-in link from its page",
      description:
        "Uses the link (once, within 15 minutes), sets the session cookie and redirects to the app (303 to /). Needs this site's Origin. The app's own screen can call POST /v1/session/link/verify instead.",
      parameters: [idParam("token", "The token from the emailed link.")],
      responses: {
        "303": { description: "Signed in; Set-Cookie carries the session." },
        "400": bytes("The link isn't valid.", "text/html"),
        "403": bytes("The request didn't come from this site.", "text/html"),
        "410": bytes("The link was used or has expired.", "text/html"),
      },
    },
  },
  "/.well-known/oauth-protected-resource": {
    get: {
      tags: ["oauth"],
      operationId: "oauth.protectedResource",
      summary: "Protected-resource metadata for /mcp (RFC 9728, HAL-3462)",
      description:
        "Names /mcp as the resource, this origin as its authorization server, and the scopes a client asks for by default (read, send). /mcp's 401 points here in WWW-Authenticate's resource_metadata.",
      responses: { "200": { description: "The metadata document (JSON)." } },
    },
  },
  "/.well-known/oauth-protected-resource/mcp": {
    get: {
      tags: ["oauth"],
      operationId: "oauth.protectedResourceMcp",
      summary: "The same metadata, at the path-specific address for /mcp",
      responses: { "200": { description: "The metadata document (JSON)." } },
    },
  },
  "/.well-known/oauth-authorization-server": {
    get: {
      tags: ["oauth"],
      operationId: "oauth.serverMetadata",
      summary: "Authorization-server metadata (RFC 8414)",
      description:
        "The authorize, token, registration and revocation endpoints. Codes only, PKCE S256 only, public clients only. Client ID metadata documents are supported, and so is iss in the authorization response (RFC 9207).",
      responses: { "200": { description: "The metadata document (JSON)." } },
    },
  },
  "/oauth/authorize": {
    get: {
      tags: ["oauth"],
      operationId: "oauth.authorize",
      summary: "Ask a person to connect an MCP client",
      description:
        "response_type=code, client_id (an https URL to the client's metadata document, or an id from /oauth/register), redirect_uri, state, code_challenge with code_challenge_method=S256, resource (this origin's /mcp) and optionally scope (read, send, admin). Shows a consent page where the person picks scopes and mailboxes, or a sign-in page first. A request whose client or redirect_uri can't be trusted is shown as an error page; any other problem is sent back to redirect_uri as error.",
      responses: {
        "200": bytes("The consent or sign-in page.", "text/html"),
        "303": { description: "Sent back to redirect_uri with error, state and iss." },
        "400": bytes("The client or redirect_uri can't be used.", "text/html"),
      },
    },
    post: {
      tags: ["oauth"],
      operationId: "oauth.consent",
      summary: "The consent page's answer",
      description:
        "From the consent page only (this site's Origin, with the session cookie). decision=allow with the ticked grant_scope and grant_mailbox values issues a ten-minute, single-use code; anything else denies.",
      responses: {
        "303": { description: "Back to redirect_uri with code, state and iss, or error=access_denied." },
        "403": bytes("The answer didn't come from this site.", "text/html"),
      },
    },
  },
  "/oauth/authorize/sign-in": {
    post: {
      tags: ["oauth"],
      operationId: "oauth.signIn",
      summary: "Email a sign-in link that comes back to the authorization",
      description:
        "From the sign-in page: email and return (the /oauth/authorize URL). The link signs the person in and lands them back on the consent page. The answer is the same whether or not the address belongs to someone.",
      responses: { "200": bytes("The check-your-email page.", "text/html") },
    },
  },
  "/oauth/token": {
    post: {
      tags: ["oauth"],
      operationId: "oauth.token",
      summary: "Exchange a code, or refresh",
      description:
        "Form body. grant_type=authorization_code with code, redirect_uri, code_verifier, client_id and resource; or grant_type=refresh_token with refresh_token and client_id. Answers an access token (one hour, only for /mcp) and a refresh token. Each refresh token works once: using a used one revokes the whole grant.",
      responses: {
        "200": { description: "access_token, token_type Bearer, expires_in, refresh_token, scope." },
        "400": { description: "error and error_description (RFC 6749 §5.2)." },
        "401": { description: "invalid_client." },
      },
    },
  },
  "/oauth/register": {
    post: {
      tags: ["oauth"],
      operationId: "oauth.register",
      summary: "Register a public client (RFC 7591)",
      description:
        "For clients without a metadata document. JSON with redirect_uris (https, http on a loopback address, or a private-use scheme) and client_name. Public clients only. A client unused within a day is dropped.",
      responses: {
        "201": { description: "The client, with its client_id." },
        "400": { description: "invalid_client_metadata or invalid_redirect_uri." },
      },
    },
  },
  "/oauth/revoke": {
    post: {
      tags: ["oauth"],
      operationId: "oauth.revoke",
      summary: "Revoke a token (RFC 7009)",
      description:
        "Form body with token (access or refresh) and client_id. Ends the whole grant and its key. Answers 200 whether or not the token existed.",
      responses: { "200": { description: "Done." } },
    },
  },
  "/v1/mailboxes/{id}/wait": {
    get: {
      tags: ["mail"],
      operationId: "mail.wait",
      summary: "Wait for new mail (long-poll, HAL-3461)",
      description:
        "Blocks until mail newer than `since` is in the mailbox, at once if it already is, else answers 204 at the timeout. Sent copies don't count. Wait again from the `cursor` (also in `x-mailyard-cursor`). `reset: true` means the cursor was older than the kept log: refetch, then wait from `cursor`. Without `since` it waits for mail from now on. For an agent that can't run a webhook receiver.",
      security: bearer,
      parameters: [
        idParam("id", "The mailbox."),
        {
          name: "since",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 0 },
          description: "The cursor from the last answer.",
        },
        {
          name: "timeout",
          in: "query",
          required: false,
          schema: { type: "number", minimum: 0, maximum: 50, default: 25 },
          description: "Seconds to wait.",
        },
      ],
      responses: {
        "200": {
          description: "Mail arrived.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["cursor", "messages", "reset"],
                properties: {
                  cursor: { type: "integer" },
                  reset: { type: "boolean" },
                  messages: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        threadId: { type: "string" },
                        subject: { type: "string" },
                        from: { type: "object", nullable: true },
                        snippet: { type: "string" },
                        receivedAt: { type: "number" },
                        folder: { type: "string" },
                        seen: { type: "boolean" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "204": { description: "Nothing arrived before the timeout; the cursor is in x-mailyard-cursor." },
        "400": problem("since or timeout isn't valid."),
        "401": problem("No key or session, or one that no longer works."),
        "403": problem("The key can't read this mailbox."),
        "404": problem("No such mailbox."),
      },
    },
  },
}

/**
 * Request bodies whose `filter` is a segment rule tree. The segment code decodes it itself (so a bad
 * tree is a 400 naming the rule at fault), which leaves the schema `unknown` in the generated document;
 * pointing it at the `SegmentRule` component lets generated clients type what they send (HAL-3427).
 */
const SEGMENT_RULE_BODIES: ReadonlyArray<readonly [string, string]> = [
  ["/v1/segments", "post"],
  ["/v1/segments/{id}", "patch"],
  ["/v1/segments/preview", "post"],
]

const withSegmentRules = (paths: Record<string, any>) => {
  const out = { ...paths }
  for (const [path, method] of SEGMENT_RULE_BODIES) {
    const schema = out[path]?.[method]?.requestBody?.content?.["application/json"]?.schema
    if (!schema?.properties?.filter) continue
    const rule = {
      $ref: "#/components/schemas/SegmentRule",
      description: "A SegmentRule tree. A tree that can't work is a 400 with the rule's path in `field`.",
    }
    out[path] = {
      ...out[path],
      [method]: {
        ...out[path][method],
        requestBody: {
          ...out[path][method].requestBody,
          content: {
            ...out[path][method].requestBody.content,
            "application/json": {
              ...out[path][method].requestBody.content["application/json"],
              schema: { ...schema, properties: { ...schema.properties, filter: rule } },
            },
          },
        },
      },
    }
  }
  return out
}

/** Adds the raw routes to the generated document, and types the segment rule bodies. */
export const withRawRoutes = (spec: Record<string, any>) => ({
  ...spec,
  paths: { ...withSegmentRules(spec.paths), ...RAW_PATHS },
})
