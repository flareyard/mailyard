# Mailyard

Email on the user's own Cloudflare account: inboxes, Plunk-compatible sending, contacts, campaigns, automations. One of the Flareyard apps; the platform that deploys it lives in `flareyard/flareyard`.

Plan: `docs/email-platform.html`. UI spec and API contract: `docs/email-ui.html`.

## Name

Mailyard (founder, 2026-10-17). It was Mailflare, then Flaremail was considered; both are taken in this exact niche: hieunc229/mailflare (~5k stars, email on Workers, mailflare.co), an npm `flaremail` package and several "FlareMail" Cloudflare email repos. On 2026-10-17 `mailyard` was free on npm, with only small unrelated GitHub repos, and mailyard.dev and mailyard.app were unregistered.

## Linear

- Initiative: Flareyard (I-22)
- Team: Hallelx2
- Project: Mailyard (P-HAL-120). Milestones M0 spikes → M7 catalog. Label `flareyard:apps`.
- Repo: `flareyard/mailyard` (private until launch). Domain import is a platform feature: Flareyard Platform (P-HAL-116), HAL-3124.

## Repo rules

- Self-contained (founder, 2026-10-16): no shared package with other Flareyard repos for now. `src/kit` is Mailyard's own copy; shared components get extracted later, once several apps have them.
- TypeScript on Workers, bun, exact pins. `bun run check` must pass before any PR; `bun run build` is the real build.
- Effect 4 in the core (sending, pipelines, queues, services); plain TypeScript at the edges people customise. Before writing Effect code, read the `AGENTS.md` and `ai-docs/` inside the installed `effect` package: v4 renamed much of v3.
- Import Effect by module, never from the barrel: `import * as Effect from "effect/Effect"`, not `import { Effect } from "effect"`. The barrel pulls in all of Effect: 877 KiB against 357 KiB for the same handler (HAL-3116). The Worker is built with `minify` and uploads source maps.
- Inbound mail (`src/inbound`, `src/workers/inbound.ts`): the raw `.eml` goes to R2 before anything else, so after that nothing is dropped. Every later step (ledger row, resolution, attachments, MailboxDO delivery) is idempotent and retried from the `mailyard-inbound` queue or `POST /v1/inbound/{id}/reprocess`. A bounce can only happen inside `email()`; later attempts mark a message `held` instead.
- One Worker exports `fetch`, `queue` and `email` (2026-10-17). The plan's separate inbound Worker isn't needed for isolation, because each invocation already has its own CPU budget and exceptions. One Worker also keeps a single binding set for the OAuth deploy. `src/workers/inbound.ts` is self-contained if it's ever split out.
- Mailboxes (`src/mailbox`, `src/objects/MailboxDO.ts`): one Durable Object per mailbox, a single writer over its own SQLite. `MailboxStore` is synchronous and transactional; the DO shell broadcasts the events it returns over hibernating WebSockets and keeps the alarm in step with the `schedule` table.
  - The schema is versioned in `src/mailbox/schema.ts`. Append a migration; never edit a shipped one.
  - Threads are connected components over shared message-ids, plus a symmetric subject fallback. They must not depend on arrival order; `test/mailbox/threading.test.ts` checks this with fast-check.
  - Refusals are thrown as `Error("<code>: …")`; map them with `mailboxErrorCode`.
- Sending from a mailbox (`src/mail/`) always goes through the mailbox's schedule:
  - "Send" means scheduling the draft for now plus the undo window (`MAILYARD_UNDO_SECONDS`, 10 by default), and undo means unscheduling it. The DO alarm hands due drafts to `mailyard-mailbox-send`, whose consumer sends through `sendFromMailbox` and files the sent copy.
  - Email Service assigns every Message-ID and refuses a custom one (measured 2026-10-17). Sent copies take the returned id, and `setMessageId` fills it in after a deferred first attempt.
  - Files are served from R2 through Worker-signed links (`GET /v1/files/{token}`), because R2 presigned URLs need S3 credentials the Worker doesn't hold.
- Inbox rules and spam (`src/rules/`): `planFiling` decides per mailbox, from its rules (literal matching only, no regex, so a rule can't hang the pipeline), its sender lists (block always spam, allow never), the auth score, and the `Classifier`.
  - The classifier is off by default and runs only on doubtful scores, from 1 to 5 points.
  - Forwards, auto-replies and rule webhooks run only for a newly stored copy, so retries never repeat them. Auto-replies follow RFC 3834's guards.
- Imports and exports run as Workflows (`src/workflows/mailbox.ts`). Every step reconnects (a socket can't outlive one) and is idempotent.
  - Imported messages get a content-derived id and are de-duplicated by Message-ID.
  - IMAP is read-only: `EXAMINE` and `BODY.PEEK[]`.
  - The password is sealed while the Workflow runs and wiped when it ends.
  - Exports write R2 multipart parts of exactly 8 MiB, because R2 needs equal non-final parts.
- D1 is deployed (since 2026-10-17): migrations are append-only. Run `bun run db:generate --name <change>`, then `wrangler d1 migrations apply mailyard --remote` before deploying code that needs it. Never edit or regenerate a shipped migration.
- DNS checks (`src/domain/dnsChecks.ts`) go through the `Dns` service over DoH. In tests, `test/dns.ts` answers DoH from a table, and `LIVE_DNS=1` runs the read-only check against bridgehook.dev.
- Tests never bind queue consumers: `vitest.config.ts` strips them from the generated Wrangler config, and tests drive consumers with `createMessageBatch` (HAL-3218).
- Tests: two Vitest projects. `worker` runs inside workerd via `@cloudflare/vitest-plugin` (not the deprecated `vitest-pool-workers`), with `MAILYARD_SENDER=memory` swapping Email Service out; `unit` runs pure functions (kit, email blocks) in Node. Keep pure tests in `unit`: a workerd worker crashed with "Message is too large" when the kit test shared it with the send and template tests (2026-10-16).
- The app holds no Cloudflare API token. Cloudflare-side config is declared and applied by the platform's OAuth deploy.
- The OpenAPI snapshot in `test/__snapshots__` is the API contract; a change to it is a contract change and needs saying so in the PR.
- Wrangler on the founder's laptop may be logged into a different Cloudflare account from the one holding the sending domains; check `wrangler whoami` before remote work.
