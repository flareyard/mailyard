# Contributing

Thanks for helping. Mailyard is AGPL-3.0: changes you contribute are under the same licence.

## Getting set up

```sh
bun install && (cd web && bun install)
bun run check   # typecheck, lint, manifest check, Worker tests (in workerd), web checks
bun run dev     # local Worker with Wrangler
```

## How changes land

- One change per pull request, with tests. The Worker's tests run inside workerd (`@cloudflare/vitest-plugin`); `bun run check` must pass.
- Database changes are new Drizzle migrations (`bun run db:generate --name <change>`). Never edit one that has shipped.
- Cloudflare primitives own durability and timing (Durable Objects, Queues, Workflows); Effect owns behaviour inside handlers. Dependencies are pinned exactly.
- An API change shows in `/openapi.json`'s committed snapshot (`test/__snapshots__/health.test.ts.snap`), so reviewers see it.
- Anything Mailyard calls on Cloudflare's API is declared in `cloudflare-app.json` (`cloudflareApi.routes`). `test/cloudflareRelay.test.ts` fails otherwise.

## Reporting a security problem

See [SECURITY.md](SECURITY.md). Please don't open a public issue.
