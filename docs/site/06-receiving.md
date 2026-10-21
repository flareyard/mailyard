---
summary: How mail reaches mailboxes: addresses and catch-alls, reading over the API, rules, spam and the inbound ledger.
---

# Receiving email

Mail to your domain reaches Mailyard through Cloudflare Email Routing. Mailyard files it into mailboxes, runs each mailbox's rules and spam check, and keeps every message it was handed in the inbound ledger.

## Mailboxes and addresses

Turn on receiving for a domain in **Domains**; Mailyard shows the MX and other records it needs and checks them. Then make mailboxes in **Settings → Mailboxes and addresses** or with `POST {{origin}}/v1/mailboxes`. A mailbox is one of:

| Kind | What it is |
|---|---|
| `user` | One person's mail. |
| `shared` | A team inbox, such as `support@`, that several people read. |
| `group` | Delivers to each of its members. |
| `alias` | Another address for an existing mailbox. |
| `catch_all` | Takes mail for any address on the domain no other mailbox claims. |

Mail to an address no mailbox claims bounces while the domain's `catchAll` is `"bounce"`. Set it to `"keep"` and that mail goes to the domain's `catch_all` mailbox instead.

If a Cloudflare routing rule already sends an address somewhere else, creating the mailbox answers `409` with `reason: "routing-rule-exists"` and where the rule points; pass `replaceRoutingRule: true` to repoint it at Mailyard.

## Reading mail over the API

With a `read` key:

- `GET /v1/mailboxes`: the mailboxes the key can read.
- `GET /v1/mailboxes/{id}/threads?folder=inbox`: conversations, newest first. Folders are `inbox`, `archive`, `sent`, `spam`, `trash`, `snoozed` and `drafts`.
- `GET /v1/mailboxes/{id}/threads/{threadId}`: every message in a conversation.
- `GET /v1/mailboxes/{id}/search?q=…`: search.
- `GET /v1/mailboxes/{id}/messages/{messageId}`: one message, with its spam score, the reasons for it, and the rules it matched.

Agents usually do the same through [MCP](/docs/mcp).

## Rules

Each mailbox has an ordered list of rules (**Settings → Rules**, or `/v1/mailboxes/{id}/rules`). A rule has conditions, `match: "all"` or `"any"`, and actions:

- **Conditions:** `from`, `to`, `cc`, `recipients`, `subject`, `listId`, `tag` or `body`, with `contains`, `notContains`, `equals`, `startsWith` or `endsWith`. Matching is case-insensitive and literal (no regular expressions). There are also `hasAttachment` and `automated` (true for auto-replies and bulk mail).
- **Actions:** `label`, `archive`, `trash`, `spam`, `markRead`, `star`, `skipSpamCheck`, `forward` (up to 10 addresses), `autoReply`, `webhook` (to one endpoint) and `assign`.

Rules run in order as mail arrives; one with `stop: true` ends the list when it matches. `POST /v1/mailboxes/{id}/rules/test` shows what the rules would do to a sample message, and `POST /v1/mailboxes/{id}/rules/{ruleId}/apply` runs one rule over mail already in the mailbox. A match sends the `mail.rule_matched` webhook.

## Spam

Every message gets a spam score with its reasons. At or above the mailbox's `spamThreshold` it's filed in spam. Marking mail as spam or not spam adds the sender to the mailbox's block or allow list (`/v1/mailboxes/{id}/senders`), which later mail follows. A rule with `skipSpamCheck` trusts what it matches.

## The inbound ledger

`GET {{origin}}/v1/inbound` lists every message Email Routing handed to Mailyard, whether it reached a mailbox, and how (`mailbox`, `alias`, `group` or `catch_all`). The raw message is stored before anything else happens, and processing is repeat-safe, so a failure is retried rather than lost. `POST /v1/inbound/{id}/reprocess` runs one again, for example after you add the mailbox it was meant for.

New mail sends the `mail.received` [webhook](/docs/webhooks).
