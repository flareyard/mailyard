# The mail-events lane

Mailyard can put the mail that moves through its mailboxes on a Cloudflare Queue,
`mailyard-mail-events`, for another Worker in the same account to read. Hermes's email lane is
that reader. Anything else that wants to react to mailbox mail without polling, or without
running a public webhook endpoint, can read it too.

Mailyard only produces. The consumer owns its consumer settings and its dead-letter queue.

## Turning it on

The lane is off by default. While it's off, nothing is written to the queue and nothing is billed
for it.

```http
PUT /v1/settings/mail-events
{ "enabled": true, "mailboxIds": ["mbx_…"], "types": null }
```

- `mailboxIds`: the mailboxes whose events go on the lane; `null` means every mailbox.
- `types`: some of `message.received`, `message.sent`, `thread.assigned` and `delivery`; `null`
  means all of them.

Changing the settings needs `settings.write` and is audit-logged as `settings.mail_events`.
`GET /v1/settings/mail-events` returns the settings, plus:

- `queue`: the queue's name.
- `version`: the contract version.
- `available`: false where the queue isn't bound, as off Cloudflare.

`GET /v1/integrations` reports the lane under `hermes`.

A change can take up to 30 seconds to reach every isolate, because each one caches the settings.

## Consuming it

In the consumer's `wrangler.jsonc`:

```jsonc
"queues": {
  "consumers": [
    {
      "queue": "mailyard-mail-events",
      "max_batch_size": 50,
      "max_retries": 5,
      "dead_letter_queue": "mailyard-mail-events-dlq"
    }
  ]
}
```

Decode each message body with the contract, then switch on `type`:

```ts
import { decodeMailEvent } from "mailyard/contracts/mail-events"

export default {
  async queue(batch: MessageBatch<unknown>) {
    for (const message of batch.messages) {
      const event = decodeMailEvent(message.body)
      switch (event.type) {
        case "message.received": /* … */ break
        case "message.sent": /* … */ break
        case "thread.assigned": /* … */ break
        case "delivery": /* … */ break
      }
      message.ack()
    }
  },
}
```

The contract has two sources:

- **TypeScript:** `src/contracts/mailEvents.ts`. It imports only `effect`, so it can also be copied
  into the consumer.
- **JSON Schema:** `docs/mail-events.schema.json`, for consumers in other languages. It's generated
  by `bun run contracts`, and a test fails if it drifts from the TypeScript.

Delivery is at least once. Deduplicate on `id`, which a redelivered event keeps.

## Events

Every event carries:

| Field | Meaning |
|---|---|
| `version` | `1`. Fields are only ever added within a version. Any other change raises it. |
| `id` | `mev_…`, unique per event. |
| `type` | One of the four below. |
| `at` | Milliseconds since the epoch. |
| `mailboxId` | The mailbox the event is about. |

| Type | When | Other fields |
|---|---|---|
| `message.received` | Inbound mail is filed in the mailbox, once per stored copy. | `threadId`, `messageId`, `internetMessageId`, `from` `{ email, name }`, `to` (the envelope recipient), `subject`, `snippet`, `folder`, `spam`, `automated`, `attachments` |
| `message.sent` | Email Sending accepts a mail sent from the mailbox. | `outId`, `messageId` (the sent copy), `recipient`, `subject` |
| `thread.assigned` | A conversation is handed to someone, or unassigned, through the API or by a mailbox rule at filing. | `threadId`, `assignee` (null when unassigned), `by` (a key or member id, or `rule`) |
| `delivery` | A delivery event arrives for a mailbox send. | `kind` (`delivered`, `deferred`, `bounced`, `failed`, `rejected`, `complained`), `outId`, `recipient`, `subject`, `bounce`, `smtpResponse` |

`automated` is true for auto-replies, bulk mail and list mail. A consumer that answers mail should
leave those alone, or two auto-responders will write to each other forever.

Campaign and automation mail isn't on the lane. Webhooks carry it (`message.*`, `email.*`).
