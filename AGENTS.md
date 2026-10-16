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
- Tests: two Vitest projects. `worker` runs inside workerd via `@cloudflare/vitest-plugin` (not the deprecated `vitest-pool-workers`), with `MAILYARD_SENDER=memory` swapping Email Service out; `unit` runs pure functions (kit, email blocks) in Node. Keep pure tests in `unit`: a workerd worker crashed with "Message is too large" when the kit test shared it with the send and template tests (2026-10-16).
- The app holds no Cloudflare API token. Cloudflare-side config is declared and applied by the platform's OAuth deploy.
- The OpenAPI snapshot in `test/__snapshots__` is the API contract; a change to it is a contract change and needs saying so in the PR.
- Wrangler on the founder's laptop may be logged into a different Cloudflare account from the one holding the sending domains; check `wrangler whoami` before remote work.
