---
summary: Make an API key, then send your first email with one request to POST /v1/send.
---

# Get started

Send your first email from this Mailyard in two steps: make a key, then call `POST /v1/send`.

## 1. Make an API key

In the app, open **Transactional → API keys** and create a key. Keys start with `sk_` (secret) or `pk_` (public, which can only track events). A key carries scopes:

| Scope | Lets the key |
|---|---|
| `send` | Send email (`POST /v1/send`) |
| `track` | Record events (`POST /v1/track`) |
| `read` | Read mailboxes, contacts, campaigns and reports |
| `admin` | Everything, including settings and other keys |

The key is shown once. Keep it in a secret store and send it as a bearer token:

```
Authorization: Bearer sk_…
```

## 2. Send an email

```sh
curl {{origin}}/v1/send \
  -H "Authorization: Bearer $MAILYARD_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "ada@example.com",
    "from": { "email": "hello@acme.com", "name": "Acme" },
    "subject": "Welcome to Acme",
    "body": "<p>Thanks for signing up.</p>"
  }'
```

Use a `from` address on a domain set up for sending in **Domains**: Cloudflare sends only from those, and refuses anything else, so the message comes back `failed`. The answer lists each recipient with its status:

```json
{
  "success": true,
  "data": {
    "emails": [{ "contact": { "id": "con_…", "email": "ada@example.com" }, "email": "<message id>", "status": "sent" }],
    "timestamp": "2026-10-21T12:00:00.000Z"
  }
}
```

`email` is the message's id (the name follows Plunk's API, so Plunk clients work unchanged). `status` is `sent`, `deferred` (queued for a retry), `failed` or `rejected`. Each message's delivery shows in **Transactional → Messages**.

Repeat-safe: add `Idempotency-Key: <your own id>` and a retried request sends once.

## Next

- [Sending email](/docs/sending): templates, attachments, tracking and suppression.
- [Agent mailboxes](/docs/agents): an address an AI agent reads and replies from.
- [HTTP API](/docs/api): every endpoint.
