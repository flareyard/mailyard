---
summary: The error shape, what each error and reason means, and which ones to retry.
---

# Errors

Every error is JSON with the same core:

```json
{ "_tag": "Forbidden", "message": "This key needs the send scope.", "reason": "insufficient-scope", "required": "send", "requestId": "…" }
```

- `_tag` names the kind of error. Branch on it, not on `message`.
- `message` is written for a person: show it as it is.
- `reason`, when present, says which case of that kind it is.
- `requestId` is also in the `x-request-id` header. Quote it when asking for help; it finds the request in the logs.

## Signing in and permission

| `_tag` | Status | `reason` | What to do |
|---|---|---|---|
| `Unauthorized` | 401 | `format` | The `Authorization` header isn't `Bearer sk_…` or `Bearer pk_…`. |
| | | `unknown` | No such key. Check you copied the whole key, for this Mailyard. |
| | | `revoked` | The key was revoked (`revokedAt` says when). Make a new one. |
| | | `session-expired` | A signed-in session ended. Sign in again. |
| `Forbidden` | 403 | `insufficient-scope` | The key lacks the scope in `required`. Make a key with it. |
| | | `public-key` | A `pk_` key can only call `/v1/track`. |
| | | `role` | The person's role can't do this; `allowedRoles` lists who can. |
| | | `mailbox_role` | A mailbox viewer tried to change or send. |
| | | `csrf` | A cookie-signed write came from another site. |
| `RateLimited` | 429 | | Too many failed attempts from one address. Wait `retryAfter` seconds. |

## Agent limits

A key with [agent limits](/docs/agents) can be refused with `409 Conflict`:

| `reason` | Extra fields | What to do |
|---|---|---|
| `agent_limit` | `limit`, `sentToday`, `resetsAt` | Over the daily cap, or a kind of send a limited key can't make (campaigns). Wait for `resetsAt` or ask a person. |
| `recipient_not_allowed` | `notAllowed` | These recipients are outside the key's allow-list. Remove them, or ask a person to widen it. |

Over [MCP](/docs/mcp) the same refusals come back as tool results with `isError: true` and the same `reason` and fields.

## The request itself

| `_tag` | Status | Meaning |
|---|---|---|
| `InvalidRequest` | 400 | The body or a parameter doesn't fit the schema. `message` says which field. |
| `NotFound` | 404 | No such thing, or not one this key can see. Also a `template` that's archived or has no published version. |
| `IdempotencyConflict` | 409 | The `Idempotency-Key` was used for a different request, or the first one is still running. |
| `Conflict` | 409 | It clashes with the current state (it exists already, it's in use, the workspace is being deleted). `reason` says which. |
| `NotReady` | 409 | An automation can't be turned on yet; `issues` lists each step that needs fixing. |
| `Gone` | 410 | A link that worked once doesn't any more: `reason` is `expired`, `used` or `revoked`. |
| `Unprocessable` | 422 | The message can't be sent as written: no body, too many recipients or attachments, too large, or a header that isn't allowed. `message` says which. |

## Mailyard and Cloudflare

| `_tag` | Status | Meaning |
|---|---|---|
| `NoSystemSender` | 503 | Mailyard has no address to send its own mail from (sign-in links, alerts). Set `MAILYARD_SYSTEM_FROM` or `DEFAULT_FROM`. |
| `CloudflareNotConnected` | 409 | Changing this in Cloudflare needs Flareyard or a token the install doesn't have (see [Self-deploy or Flareyard](/docs/deploying)). |
| `CloudflareRefused` | 502 | Cloudflare, or Flareyard's relay, refused the change; `message` carries its answer. |
| `GovernorUnreachable` | 503 | The sending governor didn't answer. Retry shortly. |
| `AssistantRefused` | 409 | The built-in AI assistant can't help: `off`, `disabled`, `cap` (its daily limit), `no_answer` or `invalid`. |

## Retrying

Retry `429`, `502` and `503` with a growing pause, and only with an `Idempotency-Key` on anything that sends. Don't retry `4xx` other than `429`: the same request gets the same answer.
