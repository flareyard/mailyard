---
summary: Running Mailyard through Flareyard or deploying it yourself, and what differs between the two.
---

# Self-deploy or Flareyard

Mailyard runs entirely in your own Cloudflare account: a Worker with D1, R2, Queues, Workflows and Durable Objects, using Cloudflare Email Routing to receive and Email Sending to send. There are two ways to put it there. Both give you the same app.

## Through Flareyard

Flareyard deploys Mailyard into your Cloudflare account with one click, using an OAuth grant you give it. You never paste a Cloudflare token or a key.

- **Updates:** a new Mailyard release shows in Flareyard; **Update** deploys it, applies the database migrations and waits for `/healthz` to answer before marking it running. Your data and settings stay.
- **Signing in:** **Open Mailyard** in Flareyard signs you in. Flareyard checks you own the install and hands you over; your first visit makes you the workspace's owner.
- **Cloudflare features:** domain checks, quota and reputation, DNS fixes and routing rules work without extra tokens, because Flareyard makes those calls with your grant.

## Self-deploy

Mailyard works without Flareyard. From a checkout of the repository:

```sh
bun install
bun run deploy
```

That builds the web app, creates the queues, deploys the Worker (Wrangler makes the database and bucket), applies the migrations and sets the signing secrets. It is safe to run again. It ends by printing a one-time claim link: open it, name the workspace and yourself, and you're the owner, signed in. `bun run claim-link https://<your address>` prints a new one.

Some screens need a Cloudflare API token that a self-deploy sets as a Worker secret (Flareyard installs don't need them):

| Secret | Turns on |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_EMAIL_READ_TOKEN` | Sending quota and reputation. |
| `CLOUDFLARE_EMAIL_WRITE_TOKEN` | Pushing suppressions to Cloudflare. |
| `CLOUDFLARE_DNS_TOKEN` | Zone status, DNS checks and fixes, and catching routing rules that already claim an address. |
| `CLOUDFLARE_ANALYTICS_TOKEN` | Mail Email Routing refused before it reached Mailyard. |

Set each with `printf %s "$VALUE" | wrangler secret put NAME`, so the value stays out of your shell history.

## What differs

| | Flareyard | Self-deploy |
|---|---|---|
| Sign-in | Through Flareyard, or email | Email (the claim link makes the owner) |
| Updates | **Update** in Flareyard | `git pull` and `bun run deploy` |
| Cloudflare features | Through your OAuth grant | Through the tokens above |
| Your data | In your account | In your account |

The `/v1/session/flareyard/*` routes exist only on Flareyard installs; on a self-deploy they answer 404 and aren't in `{{origin}}/openapi.json`.

## Health

- `GET {{origin}}/healthz` answers without a key and checks the database.
- `GET {{origin}}/v1/health` (admin key) reports sending, domains and quota.
