---
summary: Every event Mailyard sends, how to check its signature, and how retries and replays work.
---

# Webhooks

Mailyard POSTs JSON to your endpoints when things happen. Add endpoints in **Transactional → Webhooks** or with `POST {{origin}}/v1/webhooks`:

```sh
curl {{origin}}/v1/webhooks \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://example.com/hooks/mailyard", "events": ["message.bounced", "mail.received"] }'
```

The answer includes the endpoint's signing secret (`whsec_…`), shown once. `POST /v1/webhooks/{id}/rotate-secret` makes a new one.

A `filter` narrows an endpoint to some `mailboxIds`, `campaignIds`, `topicIds` or `streams` (`transactional`, `campaign`, `automation`, `reply`, `mailbox`, `test`, `system`).

## Events

| Event | When |
|---|---|
| `message.sent` | Cloudflare accepted a message. |
| `message.delivered` | The receiving server accepted it. |
| `message.deferred` | A temporary failure; it will be retried. |
| `message.bounced` | It bounced. A hard bounce suppresses the address. |
| `message.failed` | It could not be sent. |
| `message.rejected` | It wasn't attempted, for example because the address is suppressed. |
| `message.complained` | The recipient marked it as spam. |
| `email.opened`, `email.clicked` | A tracked message was opened, or a link in it clicked. |
| `contact.created`, `contact.updated`, `contact.deleted` | A contact changed. |
| `contact.subscribed`, `contact.unsubscribed` | Marketing consent changed. |
| `contact.suppressed`, `contact.unsuppressed` | An address was added to or removed from the suppression list. |
| `event.tracked` | `POST /v1/track` recorded an event. |
| `campaign.sent`, `campaign.paused` | A campaign finished sending, or was paused. |
| `mail.received` | New mail reached a mailbox. |
| `mail.rule_matched` | A mailbox rule matched incoming mail. |
| `approval.pending`, `approval.approved`, `approval.rejected` | An agent's held send needs a person, or got an answer. |
| `alert.raised` | Mailyard raised an alert, such as a bounce rate over its threshold. |

Each delivery's body is `{ "id", "type", "createdAt", "data" }`. **Transactional → Webhooks** shows a sample of every event's `data`, and `POST /v1/webhooks/{id}/test` sends one.

## Checking the signature

Deliveries follow the Standard Webhooks spec. Each has three headers:

- `webhook-id`: the delivery's id. It stays the same across retries, so use it to skip duplicates.
- `webhook-timestamp`: Unix seconds.
- `webhook-signature`: `v1,` then the base64 HMAC-SHA256 of `{id}.{timestamp}.{body}`, keyed with the secret's bytes (the part after `whsec_`, base64-decoded).

```ts
import { Webhook } from "standardwebhooks"

const wh = new Webhook(process.env.MAILYARD_WEBHOOK_SECRET)
const event = wh.verify(rawBody, headers) // throws if the signature or timestamp is wrong
```

Verify against the raw body, before parsing it, and reject timestamps more than a few minutes old.

## Retries

Answer with any `2xx` within 10 seconds. Anything else is retried with growing gaps (30 seconds, then 1, 2, 4, 8, 16 and 32 minutes), 8 attempts in all. After that the delivery is marked dead. Dead deliveries wait in **Transactional → Webhooks**; replay one with `POST /v1/webhooks/{id}/deliveries/{deliveryId}/replay`, or all of them with `POST /v1/webhooks/{id}/deliveries/replay`.

## Waking an agent

The `agent-wake` preset (`"preset": { "kind": "agent-wake", "mailboxId": "…" }`) makes an endpoint that gets `mail.received` for one mailbox. [Agent mailboxes](/docs/agents) set one up for you when you give a wake URL.
