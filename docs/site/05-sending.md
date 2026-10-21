---
summary: The send API field by field: templates, attachments, tracking, idempotency, statuses and suppression.
---

# Sending email

`POST {{origin}}/v1/send` sends transactional mail: receipts, sign-in links, alerts. It takes the same body as Plunk's API, so a Plunk client works once its base URL points at `{{origin}}`. The key needs the `send` scope.

## The request

| Field | What it is |
|---|---|
| `to` | An address, `{ "email", "name" }`, or a list of either. Each recipient gets their own message. |
| `from` | An address or `{ "email", "name" }` on a domain set up for sending in **Domains** (Cloudflare refuses others). Without it, the install's `DEFAULT_FROM`; with neither, the send is refused with `400`. |
| `name` | The sender's name, when `from` is a bare address. |
| `subject` | The subject line. A template brings its own. |
| `body` | HTML, with `{{ placeholders }}` filled from `data` and the contact. |
| `template` | A template's id or name. Its published version is sent; `body` and `subject` are ignored. |
| `data` | Values for the placeholders, such as `{ "firstName": "Ada" }`. |
| `reply` | The Reply-To address. |
| `headers` | Extra headers, as `{ "Name": "value" }`. |
| `subscribed` | Also subscribe the contact to marketing mail (`true`) or not. |
| `track` | `{ "opens": true, "clicks": true }` to track this send. Transactional mail is untracked unless asked. |
| `attachments` | A list of `{ "filename", "content" (base64), "contentType" }`. |

```sh
curl {{origin}}/v1/send \
  -H "Authorization: Bearer $MAILYARD_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-1042-receipt" \
  -d '{
    "to": { "email": "ada@example.com", "name": "Ada" },
    "from": { "email": "orders@acme.com", "name": "Acme" },
    "template": "order-receipt",
    "data": { "orderId": "1042", "total": "£18.00" }
  }'
```

## The answer

```json
{
  "success": true,
  "data": {
    "emails": [{ "contact": { "id": "…", "email": "ada@example.com" }, "email": "<message id>", "status": "sent" }],
    "timestamp": "2026-10-21T12:00:00.000Z"
  }
}
```

One entry per recipient. `email` is the message's id. `status` is:

- `sent`: Cloudflare accepted it.
- `deferred`: a temporary failure; Mailyard retries it on its own.
- `failed`: it could not be sent; the message's page in **Transactional → Messages** says why.
- `rejected`: not attempted, because the address is on the suppression list (it bounced or complained before).

A key with agent limits can get `data.approval` instead of a send: see [Agent mailboxes](/docs/agents).

## Sending the same thing once

Add an `Idempotency-Key` header (up to 255 characters) to any send you might retry. Mailyard remembers it for 24 hours per key:

- The same key with the same body answers with the first result and sends nothing new.
- The same key with a different body answers `409 IdempotencyConflict`.
- The same key while the first request is still running also answers `409`; retry after a moment.

## Templates

Make and edit templates in **Transactional → Templates** or with `/v1/templates`. Only a template's published version is sent, so editing a draft never changes what goes out. `POST /v1/templates/{id}/render` shows what a send would look like with your `data`, and `POST /v1/templates/{id}/test` sends it to you.

## Tracking events

`POST {{origin}}/v1/track` records something a contact did, such as `{ "event": "signed-up", "email": "ada@example.com", "data": { "plan": "pro" } }`. Events can start automations and build segments. A public `pk_` key can call it from a browser; it can't send.

## What happens after

Delivery, bounces, complaints, opens and clicks arrive as [webhooks](/docs/webhooks) (`message.delivered`, `message.bounced`, …) and show in **Transactional → Messages**. An address that hard-bounces or complains is suppressed, and later sends to it come back `rejected`.
