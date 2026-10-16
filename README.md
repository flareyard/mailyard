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
