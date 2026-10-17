# Mailyard

Email on your own Cloudflare account: inboxes, Plunk-compatible sending, contacts, campaigns and automations. A Flareyard app.

Status: pre-alpha, private. The public README comes later.

```sh
bun install
bun run check    # typecheck, Biome, manifest check, tests (inside workerd)
bun run build    # wrangler dry-run build
```

| Path | What |
|---|---|
| `src/workers/` | Worker entry points: the HTTP API and the queue consumers |
| `src/http/` | The schema-first API (`effect/http-api`), auth middleware, handlers |
| `src/domain/` | Sending, contacts, events, delivery events, API keys, idempotency |
| `src/kit/` | Sender (Email Service + SMTP failover), BlobStore, Ids, retry policy |
| `src/db/`, `migrations/` | D1 schema (Drizzle) and migrations |
| `tools/manifest/` | Validator for `cloudflare-app.json` (copy of the platform's schema) |
| `docs/` | The plan (`email-platform.html`) and the UI spec with the API contract (`email-ui.html`) |

## Deploying by hand

Until the Flareyard platform deploys it with your OAuth token, Mailyard deploys with Wrangler. These are the steps used for the first deploy (2026-10-17, HAL-3157).

1. **Queues.** Wrangler provisions D1 and R2 on deploy, but not queues that appear only as consumers. Create them first:
   ```sh
   for q in mailyard-send mailyard-email-events mailyard-webhooks mailyard-inbound; do
     wrangler queues create $q && wrangler queues create $q-dlq
   done
   ```
2. **Deploy.** Run `wrangler deploy`. It creates the `mailyard` D1 database and the `mailyard-store` bucket, then uploads the Worker and the `MailboxDO` class. `wrangler.jsonc` has no resource ids, so don't commit any ids Wrangler writes back.
3. **Migrations.** Run `wrangler d1 migrations apply mailyard --remote`.
4. **Secrets.** Pipe each value in, so it never lands in your shell history:
   - `ADMIN_KEY`, `WEBHOOK_SIGNING_KEY` and `UNSUBSCRIBE_KEY`: random, 32 bytes or more.
   - `DEFAULT_FROM` (optional).
   - The SMTP fallback and the read-only Cloudflare token are optional too (`cloudflare-app.json`).

   For example: `printf %s "$VALUE" | wrangler secret put ADMIN_KEY`.
5. **Delivery events.** Subscribe the events queue to each sending domain:
   ```sh
   wrangler queues subscription create mailyard-email-events --source email.sending \
     --zone-id <zone id> --domain <sending domain> \
     --events message.delivered,message.deferred,message.bounced,message.failed,message.rejected,message.complained
   ```
6. **Inbound.** Routing a domain's mail to the Worker turns on Email Routing for that zone, and that replaces the domain's MX records. Do it only for a domain whose mail should move to Mailyard.
