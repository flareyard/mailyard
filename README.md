# Mailyard

Email on your own Cloudflare account: inboxes, Plunk-compatible sending, contacts, campaigns and automations. A Flareyard app.

Status: pre-alpha. Licensed [AGPL-3.0](LICENSE). Run it in your own Cloudflare account, through [Flareyard](https://app.flareyard.dev) or by yourself (below). [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

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

## Docs

Every install serves its own docs, readable signed out: `/docs` for people, any page as Markdown with `.md` added, `/llms.txt` and `/llms-full.txt` for agents, and `mailyard://docs/<page>` as MCP resources. Examples use the install's own address.

- The guides are Markdown in `docs/site/` (`NN-slug.md`, front matter with a one-line `summary:`, `{{origin}}` where the install's address goes). After editing one, run `bun run docs:build`; `bun run check` fails while `src/docs/content.gen.ts` is stale.
- The HTTP API and MCP tool pages are written from `/openapi.json` and the MCP tool list on each request, so they can't drift.

## Releasing through Flareyard

`bun run release` builds `flareyard-release.json` with the platform's CLI. That's `packages/manifest/src/release-cli.ts` in a checkout of flareyard/flareyard, at `../flareyard` unless `FLAREYARD_DIR` says otherwise. The release holds the manifest, the bindings mapped to named resources, and the module `wrangler deploy --dry-run` emits. The platform contract is `docs/apps-contract.md` in that repo.

- `health` is `/healthz`. It answers without a key, reads the database and calls nothing outside, and the platform waits for its 200 after every deploy. `/v1/health` is the fuller status (sending, domains, quota). It needs the admin key, so the manifest offers it as `status` for the platform's dashboard.
- `settings`, `status` and `cost.units` are contract v1.2 (flareyard/flareyard#15). Each setting is a Worker var the platform sets at install and changes with an update: `MAILYARD_UNDO_SECONDS`, `MAILYARD_TRACK_OPENS`, `MAILYARD_TRACK_CLICKS`, `MAILYARD_PUBLIC_ORIGIN`, `MAILYARD_CLASSIFIER` with `CLASSIFIER_URL` and `CLASSIFIER_MODEL`, `MAILYARD_ASSISTANT` with `ASSISTANT_MODEL`, `ASSISTANT_URL` and `AI_GATEWAY_ID` (the summaries, reply drafts, categories and segment-from-a-sentence helpers; each is also off until turned on in Settings), and the SMTP fallback's host, port and username. The platform reads `status` with the generated `ADMIN_KEY`.
- `cloudflareApi` is contract v1.3 (flareyard/flareyard#24, HAL-3558). Installed through Flareyard, Mailyard pastes no Cloudflare tokens: the platform sets `FLAREYARD_CF_API` (the relay's URL), `FLAREYARD_CF_TOKEN` (this install's key) and `CLOUDFLARE_ACCOUNT_ID`, and the relay makes each call with your OAuth grant. Every call Mailyard makes is a route in `cloudflareApi.routes`, each under a scope it asks for; `test/cloudflareRelay.test.ts` fails if the code calls an undeclared route or declares one it never calls. Email Routing's analytics are GraphQL: the one query Mailyard sends is declared word for word in `cloudflareApi.graphql` (flareyard/flareyard#25), under the optional `account-analytics.read` scope, and the test checks the text sent matches it.
- When the relay, not Cloudflare, refuses a call, every response that reports it carries `relay: { reason, code, scope? }` beside its `message` (the `RelayRefusal` schema in `/openapi.json`). The reasons: `install_key_invalid` (10401), `relay_disconnected` (10402), `route_undeclared` (10403), `scope_not_granted` (10404, with the `scope` to grant), `wrong_account` (10405), `request_too_large` (10413), `rate_limited` (10429) and `cloudflare_unreachable` (10502). They appear on domain fixes, DMARC changes, suppression push, removal and sync, verified addresses, the first-run zone list, a domain's zone details, a new mailbox's routing check and the overview's routing rejections.
- `signIn` is contract v1.3 (flareyard/flareyard#26, HAL-3360). On an install Flareyard made, the platform sets `FLAREYARD_URL` and `FLAREYARD_INSTALL_ID`, and "Open Mailyard" goes to `/v1/session/flareyard/start`. That's a PKCE hand-off to Flareyard, which checks the person owns the install. They come back signed in: as the member with their email, as owner of a workspace nobody has claimed yet, or as a new admin. Self-deployed installs leave both vars unset: the routes answer 404 and `/openapi.json` doesn't list them, so the app offers email sign-in only.
- `bun run manifest`, part of `bun run check`, checks that every binding's scope is required, that every queue consumer has a dead-letter queue, and that `wrangler.jsonc` names resources without ids.

## Connecting MCP clients

`/mcp` takes an API key (`purpose: mcp`, made on Settings → Agents), or an OAuth sign-in, so Claude.ai and other MCP clients connect with a button instead of a pasted key (HAL-3462, the MCP authorization spec of 2026-07-28). Give the client `https://<your host>/mcp`. Mailyard is its own authorization server:

- **Discovery:** `/.well-known/oauth-protected-resource/mcp` (RFC 9728) and `/.well-known/oauth-authorization-server` (RFC 8414). `/mcp` answers 401 with a `WWW-Authenticate` that points to them. A tool the connection wasn't granted the scope for answers 403 `insufficient_scope` with every scope needed, so the client can ask for more.
- **Clients:** an https `client_id` is the client's metadata document (fetched, cached a day). Older clients register at `/oauth/register` (RFC 7591). Public clients only, with PKCE S256 and the `resource` parameter (RFC 8707). The answer carries `iss` (RFC 9207).
- **Consent:** the person signs in (an emailed link brings them back) and picks the scopes (`read`, `send`; `admin` only on request and only if they hold it) and the mailboxes. A viewer can't hand out `send`.
- **Tokens:** a grant is a `purpose: mcp` key with what was chosen, so agent limits, approvals and the audit of reads apply. Access tokens last an hour and work only on `/mcp`. Refresh tokens rotate, and reusing a spent one revokes the grant. Grants show on `GET /v1/integrations` (`oauth.grants`) and are revoked with `DELETE /v1/integrations/oauth-grants/{id}`, `/oauth/revoke`, or by revoking the key.

## Deploying it yourself

Mailyard runs without Flareyard. Everything Flareyard adds (signing in from its dashboard, Cloudflare calls through its relay) switches on only when the platform installs it. A self-deployed install signs people in with emailed links and takes optional tokens for the extra screens.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/flareyard/mailyard)

The button needs the repository to be public. From a clone, with Wrangler signed in to your account:

```sh
bun install
bun run deploy
```

`bun run deploy` (`scripts/deploy.ts`) does the whole first deploy, and is safe to run again:

1. Builds the web app.
2. Creates any queue `wrangler.jsonc` names that doesn't exist, with its dead-letter queue.
3. Deploys the Worker. Wrangler provisions the `mailyard` D1 database and the `mailyard-store` bucket by name. `wrangler.jsonc` has no resource ids, so don't commit any ids Wrangler writes back.
4. Applies the D1 migrations.
5. Sets `UNSUBSCRIBE_KEY`, `WEBHOOK_SIGNING_KEY` and `FILE_SIGNING_KEY` if they're missing. Each is a fresh random value piped straight to Wrangler, never printed or saved.
6. Prints a one-time **claim link** (`/claim#token=…`) while nobody has claimed the workspace. Open it, name the workspace and yourself, and you're its owner, signed in. No admin key is pasted. `bun run claim-link https://<your address>` prints a new link and voids the old one.

**Optional.** Each of these turns on one extra screen (`.dev.vars.example` lists them). Set them with `printf %s "$VALUE" | wrangler secret put NAME`, so the value never lands in your shell history:

- `ADMIN_KEY`: a root key for scripts. The claim link makes it unnecessary.
- `DEFAULT_FROM`, and the SMTP fallback (`cloudflare-app.json`).
- `CLOUDFLARE_ACCOUNT_ID` with `CLOUDFLARE_EMAIL_READ_TOKEN` (Email Sending: Read; Queues: Read for delivery-event checks) shows quota and reputation. With Email Routing Addresses: Read it also lists the account's verified addresses, which a test send can mail for free. `CLOUDFLARE_EMAIL_WRITE_TOKEN` (Email Sending: Edit) pushes suppressions.
- `CLOUDFLARE_DNS_TOKEN` lets the domain screens show zone status, nameservers, registrar, DNSSEC and complaints, list the account's other zones, and fix records. It needs Zone, DNS and Email Sending: Read, plus Email Routing and Email Sending: Edit for fixing. With Email Routing Rules: Edit too, creating a mailbox catches a routing rule that already sends that address elsewhere, and can repoint it at Mailyard.
- `CLOUDFLARE_ANALYTICS_TOKEN` (Analytics: Read and Zone: Read) fills the Inbound screen's upstream rejections: mail Email Routing refused for failing DMARC, SPF or DKIM before it reached Mailyard. Cloudflare keeps 31 days of it.

Through Flareyard, none of these tokens are asked for: the relay makes those calls with your OAuth grant.

**After the first deploy:**

1. **Delivery events.** Subscribe the events queue to each sending domain, and to each sending subdomain on its own: a subscription for the exact domain the mail is sent from is what made in.flareyard.dev's events flow (measured 2026-10-17). A domain without one never leaves `sent`, so bounces and complaints don't reach suppression or the send governor. The hourly watchdog raises a critical alert for any sending domain whose mail is still silent after 6 hours. With the read-only token connected (it also needs Queues: Read), `/v1/health` and `GET /v1/sending/events` name a missing subscription before anything is sent.
   ```sh
   wrangler queues subscription create mailyard-email-events --source email.sending \
     --zone-id <zone id> --domain <sending domain> \
     --events message.delivered,message.deferred,message.bounced,message.failed,message.rejected,message.complained
   ```
2. **Inbound.** Route a domain's mail to the Worker with Email Routing, then add the domain in Mailyard (`POST /v1/domains`).
   - **A subdomain leaves the apex alone.** `POST /zones/<zone id>/email/routing/dns` with `{"name": "in.example.com"}` adds MX and SPF records on that subdomain only. Routing's DKIM key `cf2024-1._domainkey` goes on the apex, beside any existing provider's records, and the apex MX is not touched. Measured 2026-10-17 on in.flareyard.dev, with flareyard.dev's mail still on Spacemail.
   - **The apex moves its mail.** The same call without a subdomain adds and locks Cloudflare's MX on the apex, so the current provider stops receiving. Import the mailbox first (`POST /v1/mailboxes/:id/imports`), then switch.
   - **Point the catch-all at the Worker:**
     ```sh
     PUT /zones/<zone id>/email/routing/rules/catch_all
     {"matchers":[{"type":"all"}],"actions":[{"type":"worker","value":["mailyard-api"]}],"enabled":true}
     ```
   - **To send from the same domain,** onboard it for Email Sending (`POST /zones/<zone id>/email/sending/subdomains` with `{"name": "in.example.com"}`). That adds `cf-bounce.<domain>` records and `_dmarc.<domain>`.
   - **A throw in `email()` is a temporary failure.** Measured 2026-10-17 with a build that threw for one address: Gmail neither bounced nor delivered, then delivered 7.5 minutes after sending, once the real build was back. Until the raw message is in R2, the handler throws rather than accepting.
3. **Hostnames.** A deployment can answer on several hostnames: Workers Custom Domains you add in the dashboard or with `wrangler`. Don't add them to `wrangler.jsonc`, because other installs don't own them. Set `MAILYARD_PUBLIC_ORIGIN` to the one people should use (for example `https://mail.example.com`), as a Worker var or the install's "Public address" setting.
   - Unsubscribe, confirm, view, tracking, file and automation-run links are built on it, whichever hostname a send or request came through.
   - On the other hostnames, a browser GET for an app page gets a 308 to it. API, MCP, webhook and public-page paths are never redirected, so keys and SDKs can use any hostname. For the redirect to reach app pages, `assets.run_worker_first` must be `true`.
   - Cookie-signed writes from it pass the session CSRF check on any hostname.
   - The founder's install uses `https://mail.flareyard.dev` for the app and `https://api.mail.flareyard.dev` for keys, SDKs and MCP. The workers.dev address keeps working.
