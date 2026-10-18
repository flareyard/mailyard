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
| `tools/manifest/` | Validator for `cloudflare-app.json` (copy of the platform's schema) and its check against `wrangler.jsonc` |
| `docs/` | The plan (`email-platform.html`) and the UI spec with the API contract (`email-ui.html`) |

## Releasing through Flareyard

`bun run release` builds `flareyard-release.json` with the platform's CLI. That's `packages/manifest/src/release-cli.ts` in a checkout of flareyard/flareyard, at `../flareyard` unless `FLAREYARD_DIR` says otherwise. The release holds the manifest, the bindings mapped to named resources, and the module `wrangler deploy --dry-run` emits. The platform contract is `docs/apps-contract.md` in that repo.

- `health` is `/healthz`. It answers without a key, reads the database and calls nothing outside, and the platform waits for its 200 after every deploy. `/v1/health` is the fuller status (sending, domains, quota). It needs the admin key, so the manifest offers it as `status` for the platform's dashboard.
- `settings`, `status` and `cost.units` are contract v1.2 (flareyard/flareyard#15). Each setting is a Worker var the platform sets at install and changes with an update: `MAILYARD_UNDO_SECONDS`, `MAILYARD_TRACK_OPENS`, `MAILYARD_TRACK_CLICKS`, `MAILYARD_PUBLIC_ORIGIN`, `MAILYARD_CLASSIFIER` with `CLASSIFIER_URL` and `CLASSIFIER_MODEL`, `MAILYARD_ASSISTANT` with `ASSISTANT_MODEL`, `ASSISTANT_URL` and `AI_GATEWAY_ID` (the summaries, reply drafts, categories and segment-from-a-sentence helpers; each is also off until turned on in Settings), and the SMTP fallback's host, port and username. The platform reads `status` with the generated `ADMIN_KEY`.
- `cloudflareApi` is contract v1.3 (flareyard/flareyard#24, HAL-3558). Installed through Flareyard, Mailyard pastes no Cloudflare tokens: the platform sets `FLAREYARD_CF_API` (the relay's URL), `FLAREYARD_CF_TOKEN` (this install's key) and `CLOUDFLARE_ACCOUNT_ID`, and the relay makes each call with your OAuth grant. Every call Mailyard makes is a route in `cloudflareApi.routes`, each under a scope it asks for; `test/cloudflareRelay.test.ts` fails if the code calls an undeclared route or declares one it never calls. Email Routing's analytics are GraphQL: the one query Mailyard sends is declared word for word in `cloudflareApi.graphql` (flareyard/flareyard#25), under the optional `account-analytics.read` scope, and the test checks the text sent matches it.
- When the relay, not Cloudflare, refuses a call, every response that reports it carries `relay: { reason, code, scope? }` beside its `message` (the `RelayRefusal` schema in `/openapi.json`). The reasons: `install_key_invalid` (10401), `relay_disconnected` (10402), `route_undeclared` (10403), `scope_not_granted` (10404, with the `scope` to grant), `wrong_account` (10405), `request_too_large` (10413), `rate_limited` (10429) and `cloudflare_unreachable` (10502). They appear on domain fixes, DMARC changes, suppression push, removal and sync, verified addresses, the first-run zone list, a domain's zone details, a new mailbox's routing check and the overview's routing rejections.
- `bun run manifest`, part of `bun run check`, checks that every binding's scope is required, that every queue consumer has a dead-letter queue, and that `wrangler.jsonc` names resources without ids.

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
   - The SMTP fallback is optional too (`cloudflare-app.json`).
   - **Self-hosted only:** without Flareyard's relay, these optional tokens stand in for it. On the platform they aren't needed, and the install form doesn't ask for them. `CLOUDFLARE_ACCOUNT_ID` with `CLOUDFLARE_EMAIL_READ_TOKEN` (Email Sending: Read; Queues: Read for delivery-event checks) shows quota and reputation. `CLOUDFLARE_EMAIL_WRITE_TOKEN` (Email Sending: Edit) pushes suppressions.
   - `CLOUDFLARE_DNS_TOKEN` (optional) lets the domain screens show zone status, nameservers, registrar, DNSSEC and complaints, list the account's other zones, and fix records: Zone, DNS and Email Sending: Read, plus Email Routing and Email Sending: Edit for fixing. With Email Routing Rules: Edit too, creating a mailbox catches a routing rule that already sends that address elsewhere, and can repoint it at Mailyard.
   - `CLOUDFLARE_ANALYTICS_TOKEN` (self-hosted only, optional, Analytics: Read and Zone: Read; on the platform the relay does this with `account-analytics.read`) fills the Inbound screen's upstream rejections: mail Email Routing refused for failing DMARC, SPF or DKIM before it reached Mailyard. Cloudflare keeps 31 days of it.
   - The read-only token with Email Routing Addresses: Read also lists the account's verified addresses, which a test send can mail for free.

   For example: `printf %s "$VALUE" | wrangler secret put ADMIN_KEY`.
5. **Delivery events.** Subscribe the events queue to each sending domain, and to each sending subdomain on its own: a subscription for the exact domain the mail is sent from is what made in.flareyard.dev's events flow (measured 2026-10-17). A domain without one never leaves `sent`, so bounces and complaints don't reach suppression or the send governor. The hourly watchdog raises a critical alert for any sending domain whose mail is still silent after 6 hours. With the read-only token connected (it also needs Queues: Read), `/v1/health` and `GET /v1/sending/events` name a missing subscription before anything is sent.
   ```sh
   wrangler queues subscription create mailyard-email-events --source email.sending \
     --zone-id <zone id> --domain <sending domain> \
     --events message.delivered,message.deferred,message.bounced,message.failed,message.rejected,message.complained
   ```
6. **Inbound.** Route a domain's mail to the Worker with Email Routing, then add the domain in Mailyard (`POST /v1/domains`).
   - **A subdomain leaves the apex alone.** `POST /zones/<zone id>/email/routing/dns` with `{"name": "in.example.com"}` adds MX and SPF records on that subdomain only. Routing's DKIM key `cf2024-1._domainkey` goes on the apex, beside any existing provider's records, and the apex MX is not touched. Measured 2026-10-17 on in.flareyard.dev, with flareyard.dev's mail still on Spacemail.
   - **The apex moves its mail.** The same call without a subdomain adds and locks Cloudflare's MX on the apex, so the current provider stops receiving. Import the mailbox first (`POST /v1/mailboxes/:id/imports`), then switch.
   - **Point the catch-all at the Worker:**
     ```sh
     PUT /zones/<zone id>/email/routing/rules/catch_all
     {"matchers":[{"type":"all"}],"actions":[{"type":"worker","value":["mailyard-api"]}],"enabled":true}
     ```
   - **To send from the same domain,** onboard it for Email Sending (`POST /zones/<zone id>/email/sending/subdomains` with `{"name": "in.example.com"}`). That adds `cf-bounce.<domain>` records and `_dmarc.<domain>`.
   - **A throw in `email()` is a temporary failure.** Measured 2026-10-17 with a build that threw for one address: Gmail neither bounced nor delivered, then delivered 7.5 minutes after sending, once the real build was back. Until the raw message is in R2, the handler throws rather than accepting.
7. **Hostnames.** A deployment can answer on several hostnames: Workers Custom Domains you add in the dashboard or with `wrangler`. Don't add them to `wrangler.jsonc`, because other installs don't own them. Set `MAILYARD_PUBLIC_ORIGIN` to the one people should use (for example `https://mail.example.com`), as a Worker var or the install's "Public address" setting.
   - Unsubscribe, confirm, view, tracking, file and automation-run links are built on it, whichever hostname a send or request came through.
   - On the other hostnames, a browser GET for an app page gets a 308 to it. API, MCP, webhook and public-page paths are never redirected, so keys and SDKs can use any hostname. For the redirect to reach app pages, `assets.run_worker_first` must be `true`.
   - Cookie-signed writes from it pass the session CSRF check on any hostname.
   - The founder's install uses `https://mail.flareyard.dev` for the app and `https://api.mail.flareyard.dev` for keys, SDKs and MCP. The workers.dev address keeps working.
