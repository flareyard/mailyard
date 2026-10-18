---
name: deploy
description: Deploy a change to a running Mailyard on Cloudflare, by hand with Wrangler or as a Flareyard release: migrations first, then the Worker, then a live check. Use when shipping a merged change, adding a migration, queue, secret or Durable Object, or building flareyard-release.json.
---

# Deploy

Mailyard is one Worker (`mailyard-api`: `fetch`, `queue`, `email`, `scheduled`) with D1, R2, queues, Workflows and two Durable Object classes, all declared in `wrangler.jsonc` without ids. The Flareyard platform deploys it with the user's OAuth token from a release; until then, Wrangler does. The first deploy's one-time setup (queues, secrets, delivery-event subscriptions, Email Routing) is in `README.md`, "Deploying by hand"; this skill is every deploy after it.

## Steps

1. **Green first.** `bun run check` and `bun run build` pass on exactly what you're deploying (the merged `main`, normally).
2. **The right account.** `wrangler whoami` names the account holding the `mailyard` database and the sending domains. A laptop can be logged into another one; deploying there creates a second, empty Mailyard.
3. **New resources before code.** For each kind the change adds:
   - **D1 migration** (`migrations/NNNN_*.sql`, from `bun run db:generate --name <change>`): `wrangler d1 migrations apply mailyard --remote`, then `wrangler d1 migrations list mailyard --remote` shows none pending. Migrations are additive and append-only, and code must work before and after one runs, because the old Worker serves while it applies.
   - **Queue**: `wrangler queues create <name>` and `wrangler queues create <name>-dlq` (every consumer has a dead-letter queue; `bun run manifest` checks it).
   - **Secret**: pipe it in, `printf %s "$VALUE" | wrangler secret put <NAME>`, so it never reaches shell history or a log; declare it in `cloudflare-app.json` too.
   - **Durable Object class**: a new `{ "tag": "vN", "new_sqlite_classes": [...] }` entry in `wrangler.jsonc` `migrations`, appended, never edited.
   - **Mailbox schema** (`src/mailbox/schema.ts`): nothing to run. Each mailbox migrates itself when its Durable Object next wakes.
   Done when every resource the diff introduces exists remotely.
4. **Deploy the Worker.** `wrangler deploy`. Leave out any ids Wrangler writes back into `wrangler.jsonc`; the file stays id-free.
5. **Check it live.** `curl -s <url>/healthz` answers 200 (the platform waits for the same thing), then `GET /v1/health` with the admin key shows sending, domains and quota. Then call the endpoint the change touched, read-only where you can: read the key into a shell variable from the gitignored `.env` and pass the variable, never the value. For a change to mail flow, `wrangler tail mailyard-api` while it runs.
   Done when `/healthz` is 200 and the changed behaviour answers as the tests say it should.
6. **Release for the platform** (when asked): `bun run release` writes `flareyard-release.json` with the platform's CLI from a flareyard/flareyard checkout (`../flareyard` unless `FLAREYARD_DIR` says otherwise). A new binding means its OAuth scope must be in `cloudflare-app.json`; `bun run manifest` refuses one that isn't. Publishing a release to the catalog is the owner's call, not part of a deploy.

## Rolling back

`wrangler rollback` returns the Worker to the previous version. D1 migrations don't roll back; that's why they're additive, so the old code still runs on the new schema.
