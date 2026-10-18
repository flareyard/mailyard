# Mailyard web app

The browser app for Mailyard: React 19, Vite, TanStack Router and TanStack Query. The API Worker serves it as Workers Static Assets from `web/dist`, so the app and `/v1` share an origin and the session cookie stays first-party.

## Run it

```sh
cd web
bun install
bun run dev:fixtures   # every screen on the designs' fixtures, no backend needed
bun run dev            # against an API: MAILYARD_API=https://… (default http://localhost:8787, i.e. `wrangler dev`)
```

`?fixtures=1` turns fixture mode on for a tab, and `?fixtures=0` turns it off.

## How it's put together

| Path | What |
|---|---|
| `src/api/client.ts` | The typed client: `api.GET("/v1/…")`, typed from `src/api/schema.d.ts`. Regenerate with `bun run api:types` after an API change, and the compiler lists every screen that has to follow. |
| `src/auth/` | The session (HAL-3358): `POST /v1/session` exchanges a key for the HttpOnly cookie; `GET /v1/me` says who you are. `capabilities.ts` reads `/openapi.json`, so screens that wait on an unbuilt route light up the moment it deploys. |
| `src/live/` | The mailbox socket: reconnect with backoff and jitter, and resume from the last seq. |
| `src/shell/` | The app frame: sidebar, top bar, ⌘K, alerts, banners and the usage meter. |
| `src/ui/` | Shared pieces: `Panel` (loading, error, empty), icons, the wordmark, the auth layout. |
| `src/routes/` | File routes. `_app` is everything behind sign-in. Lists keep their filters in the URL. |
| `src/styles/` | The design system from the OpenDesign project, copied as is. The class names are the API, so a screen ports one to one from its static HTML. Don't reformat these files; change them like design files. |
| `src/fixtures/` | `fixtures.json`, extracted from the design screens with `bun run fixtures` (set `MAILYARD_DESIGNS` to the OpenDesign project). The design repo's contract check validates them against the live OpenAPI. |

## Checks

- `bun run typecheck` and `bun run test` (Vitest) both run in the repo's `bun run check`.
- `bun run audit` (root: `bun run check:ui`) is the responsive audit. It builds in fixture mode, serves the production build, and fails on horizontal overflow, crushed text or a touch target under 24 px. It covers phones, a phone on its side, tablets both ways and desktops, plus zoom from 110 to 200%. Pages are listed in `e2e/pages.txt`; add every new route and state there. For WebKit, run it with `AUDIT_ENGINE=webkit` inside Microsoft's Playwright image.
- `bun run e2e:session` drives sign-in end to end against a running Mailyard: the redirect, a refused key, sign-in, the HttpOnly cookie, `/v1/me` on the cookie, the CSRF-checked DELETE, and sign-out. Point it at a local `wrangler dev` with a throwaway `ADMIN_KEY` in `.dev.vars`: `MAILYARD_E2E_BASE=http://127.0.0.1:8787 MAILYARD_E2E_KEY=… bun run e2e:session`. Never point it at production.
