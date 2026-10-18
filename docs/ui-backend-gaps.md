# Mailyard web app: what the backend still has to build

**For the Mailyard backend session.** Measured on 2026-10-17 against the live OpenAPI (103 paths) and `origin/main` at `47426a9`. Every row in the area files below has been re-checked against that document. Rows marked Built are there only for context. Re-measure before you build against a row, because the designs were drawn while the API was moving.

The designs are in the OpenDesign project `b1698bbb-7505-4158-92b1-a5f83bfb75f3`. Open `index.html` to browse every screen, and use `system*.html` for the components. Every screen panel has a `data-endpoint` naming its source, marked `(proposed)` or `(planned, HAL-…)` where that source isn't built yet.

## Priority order (what unblocks the UI issues soonest)

**P1. The app can't be signed into without these (HAL-3307).** See GAPS.md §1 and §2.7.
- Key-to-cookie sessions: `POST /v1/session`, `DELETE /v1/session`, and the auth middleware accepting the cookie (with CSRF protection) alongside Bearer.
- The Flareyard platform handoff, start and callback.
- `GET /v1/me` → `{ user, workspace, role, permissions, via, scopes }`.
- Typed refusal reasons: `format`, `unknown`, `revoked`, `public-key`, `insufficient-scope`, `session-expired`; a 429 with `retryAfter`; and a `requestId` on every error.

**P2. The Overview and the shell.** See GAPS.md §2 and §3.
- `/v1/mail/attention`, `/v1/stats/inbound`, `/v1/stats/audience`, `/v1/activity`, `/v1/automations/summary`, and `/v1/search`.
- A fixed set of alert kinds. Only `delivery_events_missing` and `campaign.paused` exist today.
- Per-domain health with a `changedAt` per check.
- Hourly data for the 24 h range.

**P3. Mail (HAL-3308).** See GAPS-mail.md.
- `POST /v1/uploads` in the OpenAPI. It works, but isn't documented, and drafts and imports both need it.
- A link from a sent copy to its delivery status, and typed reasons for a refused send.
- An import-progress event on the mailbox socket, the All mail folder mapping, and the list of supported search operators.

**P4. Audience and campaigns (HAL-3310).** See GAPS-audience.md.
- What contact import still lacks: cancel, total rows, rate and ETA, a consent attestation, and more than 100 row errors.
- The suppressions API.
- Segment and campaign fields.
- Automations (M5, HAL-3299–3301), designed ahead of the API.

**P5. Ops, settings and recipient pages (HAL-3309).** See GAPS-ops.md.
- The message events trail and headers.
- DMARC reports, and the domain import workflow.
- Rates by day, deferral reasons and engagement stats.
- Members, invites and roles; Gmail mode; AI and integrations settings; workspace export; the audit log.
- ~~The public route `/v/:token` (view in browser).~~ Built (HAL-3377), with `/u/:token`, `/c/:token` and `/f/:formId`.
- ~~Passing the brand through to the confirm and after-submit pages.~~ Built (HAL-3377).
- A whole-workspace export. `/v1/exports` covers contacts only.
- ~~Aligning the live `/u` page with the Flareyard tokens and fonts.~~ Built (HAL-3377).

**Questions for you, collected from the runs:**
- Does the API hold one-to-one replies while reputation is at risk? The Mail designs assume it does.
- The webhook event names, and the signature header name.
- How the import counts relate: are duplicates and suppressed contacts counted inside "skipped"?
- `activity[].hour` in the campaign report is hours since sending started (0–167). Please give it `maximum: 167` and a description in the schema.
- The HAL-3341 alert links to the domain by name, while every other domain reference uses its `dom_…` id.

---


<!-- ===== GAPS.md ===== -->

## Area: Foundation: auth, shell, first run, Overview

(From `GAPS.md`, verbatim.)

# Mailyard web app: API gaps (foundation run)

_Second follow-up, 2026-10-17: re-measured against 100 paths at `9428241`. Contact CSV import moved to Built (4.8); `/v1/sending/events` is new and Built (3, HAL-3341); the `/v1/health` check names are now the real ones. Every other row was re-checked and is still absent from the live document._

What the foundation designs (auth, shell, first run, Overview) need beyond what the backend has built.

**Measured against:**
- `reference/openapi.json`, the live document (`Mailyard API 0.0.1`, **100 paths**), re-fetched 2026-10-17 at `origin/main 9428241`. Every row below was re-measured against it on the second follow-up.
- The backend source at `9428241` (local clone of `flareyard/mailyard`), read where the OpenAPI is silent: `src/domain/insights.ts` for the `/v1/health` check names, `src/domain/eventCoverage.ts` for HAL-3341, `src/imports/contactImport.ts` and `src/workers/uploads.ts` for the CSV import. The local clone is at `fc9c0e5`, one PR later (#30, contacts filters); none of those files changed in it.
- `reference/backend-contract.md`, the backend session’s own statement of what’s built, planned and only proposed. It was measured on 2026-10-17 at `origin/main ab33e9b`.

Re-check both before building against any row; the backend files issues from these designs.

## How to read the status column

| Status | Meaning |
|---|---|
| **Built** | In the live OpenAPI and the contract. Screens use it as-is. |
| **Planned** | Filed in Linear, not built. The issue is named. Field shapes here are still a proposal. |
| **Proposal** | Not filed. The contract says “design these as proposals”, and every shape below is ours, for the backend to accept, change or refuse. |

The screens follow the same split:

- Every element fed by a planned or proposed endpoint carries `(proposed)` or `(planned, HAL-…)` in its `data-endpoint`.
- Each also shows a dashed blue **Proposed API** / **Planned · HAL-…** pill, so no screen implies something exists that the contract says isn’t built.
- Fixtures for these endpoints are labelled `(proposed)` in their `data-fixture` key.

---

## 1. Session, sign-in and people

The contract (§1) says no human sign-in is built. Every caller today is a Bearer key (`sk_…` scoped, `pk_…`, or the deploy-time `ADMIN_KEY`), and keys carry scopes, not roles. The auth screens show **Planned · HAL-3307** on sign-in and **Proposal · not filed** on everything else.

| # | Item | Status | Screens | Proposed shape |
|---|---|---|---|---|
| 1.1 | `GET /v1/me` | **Built**, HAL-3358: `{ user: null, workspace, role: null, via: "session-key"\|"admin-key"\|"api-key", key: { id, name, prefix } \| null, scopes, permissions, workspaces, session: { id, expiresAt, absoluteExpiresAt } \| null }`. `user` and `role` stay null until HAL-3361. | Sidebar, avatar menu, workspace switcher, every role-dependent control | Following the contract’s outline `{ user, workspace, role, permissions }`: `{ user: { id, name, email }, workspace: { id, name, host, claimed }, role: "owner"\|"admin"\|"sender"\|"agent"\|"viewer"\|null, via: "session-flareyard"\|"session-key"\|"admin-key", scopes: ("read"\|"send"\|"track"\|"admin")[], permissions: string[], workspaces: [{ name, host }] }`. `role` is null until roles exist (1.11). |
| 1.2 | `POST /v1/session` `{ key }` → HTTP-only cookie | **Built**, HAL-3358: needs `read`; sets `__Host-mailyard_session` (HttpOnly, Secure, SameSite=Lax, Path=/), D1-backed, 14 days sliding and 30 days at most; the body is `/v1/me`. A cross-site sign-in is `403 reason: "csrf"`. | `auth/sign-in*.html` | 200: `Set-Cookie: my_session=…; HttpOnly; Secure; SameSite=Lax; Path=/`, body as 1.1. |
| 1.3 | Flareyard platform handoff | **Planned**, HAL-3307 (“the Flareyard platform hands off a session”). Endpoints are a proposal. | `sign-in`, `sign-in-flareyard-expired`, `signed-out` | `GET /v1/session/flareyard/start` → redirect with PKCE. `GET /v1/session/flareyard/callback?code=&state=` sets the cookie as 1.2. An expired platform session redirects to `/sign-in?error=flareyard_session_expired`. |
| 1.4 | Distinct key-refusal reasons | **Built**, HAL-3359 (`csrf` added by HAL-3358) | `sign-in-invalid-key`, `-revoked-key`, `-public-key`, `-insufficient-scope` | `401 { _tag: "Unauthorized", reason: "format"\|"unknown"\|"revoked", revokedAt?, revokedBy? }` and `403 { _tag: "Forbidden", reason: "public-key"\|"insufficient-scope", scopes, required, keyName? }`. **Today** `authenticate` answers “Unknown or revoked key.” for both cases, and an admin-key typo gets “Keys start with sk_ (secret) or pk_ (public).” |
| 1.5 | Minimum scope to open the app | **Built**, HAL-3358: a session needs `read` (`403 insufficient-scope`, `required: "read"`); a pk_ key gets `public-key`. | `sign-in-insufficient-scope` | A session needs `read`. A `send`-only key is refused with 1.4. |
| 1.6 | Rate limit on key sign-in | **Built**, HAL-3359; `POST /v1/session` failures count against the same limit (HAL-3358) | `sign-in-rate-limited` | `429 { _tag: "RateLimited", retryAfter }` plus `Retry-After`. The 10-tries-a-minute figure on screen is our proposal. |
| 1.7 | Cookie accepted by `ApiKeyAuth` | **Built**, HAL-3358: `ApiKeyAuth` and the raw routes accept the cookie when there is no Bearer header. Cookie-signed writes, sign-in/out and WebSockets need this origin (or `MAILYARD_PUBLIC_ORIGIN`) in `Origin`, or `Sec-Fetch-Site: same-origin`; otherwise `403 reason: "csrf"`. | All app screens | Accept the session cookie alongside Bearer. Protect cookie-authenticated writes with CSRF defences (`SameSite=Lax` + `Origin` check). |
| 1.8 | Sign-out: `DELETE /v1/session` | **Built**, HAL-3358: `DELETE /v1/session` (204, idempotent, clears the cookie), plus `GET /v1/sessions`, `DELETE /v1/sessions/{id}` and `DELETE /v1/sessions` (`{ ended }`, keeps the current one). | Avatar menu, `signed-out`, `invite-wrong-account` | 204, clears the cookie. |
| 1.9 | Session expiry signal | **Built**, HAL-3358: an ended, expired or revoked-key session is `401 reason: "session-expired"` with a clearing Set-Cookie. | `auth/session-expired.html` | `401 { _tag: "Unauthorized", reason: "session-expired" }` on any call opens the re-auth sheet; local drafts are kept. |
| 1.10 | Claim the workspace: `POST /v1/workspace/claim` | **Built**, HAL-3361: admin key only (Bearer or session); creates the owner, names the workspace and mails them a sign-in link (`signInLinkSent`). `409 { reason: "already-claimed", claimedBy, claimedAt }` | `claim-workspace`, `claim-already-claimed` | `{ workspaceName, name, email }`, admin-key session only. `409 { claimedBy, claimedAt }`. |
| 1.11 | Roles: owner, admin, sender, agent, viewer | **Built**, HAL-3361: the matrix is `src/domain/permissions.ts`; people are checked by role, keys by scope. A refusal is `403 { reason: "role", role, required, allowedRoles }`; `/v1/me.permissions` reads the same table | `states/overview-viewer.html`, `states/no-permission.html`, every disabled-with-reason control | Users plus roles, checked per endpoint. Each refusal says who can: `403 { reason: "role", allowedRoles }`. Until roles exist, the app is the owner view, and the avatar menu says “Roles are a proposal; today access comes from your key’s scopes.” |
| 1.12 | Invites: `GET /v1/invites/{token}`, `POST …/accept`, `GET/POST/DELETE /v1/invites` | **Built**, HAL-3361: invitations are drafted (`POST /v1/invites` returns `{ invite, draft }`) and go out only on `POST /v1/invites/{id}/send` (or `/resend`, which mints a new link). The emailed link is `<origin>/invite/{token}`. Accept answers `409 email-mismatch`, `410 expired|used|revoked`, and signs the person in | `invite-valid`, `-expired`, `-used`, `-wrong-account` | `{ token, status: "valid"\|"expired"\|"used", workspace: { name, host }, inviter: { name, email }, email, role, mailboxes, expiresAt, acceptedAt, signedInAs? }`. Accept: `409 { reason: "email-mismatch" }` or `410 { reason: "expired"\|"used" }`. |
| 1.13 | Members: `GET /v1/members` | **Built**, HAL-3361: `GET /v1/members` → `{ members: [{ id, email, name, role, timeZone, createdAt, lastActiveAt, mailboxes }], invites }`; `PATCH`/`DELETE /v1/members/{id}`; `POST /v1/workspace/transfer` | Settings run | Listed so the Settings run inherits it. |
| — | Magic links, passkeys, Cloudflare Access | **Proposal** (contract §1) | Not designed in this run | The sign-in card has room for a third method under “or”. |

## 2. Shell

| # | Item | Status | Screens | Proposed shape / note |
|---|---|---|---|---|
| 2.1 | Global search: `GET /v1/search?q=&types=` | **Built** (HAL-3363) | `shell/command-palette*.html` (footer pill “Search API proposed”) | `GET /v1/search?q=&types=&limit=` → `{ query, results: [{ type: thread\|contact\|campaign\|template\|mailbox\|domain, id, title, subtitle, url, mailboxId? }], partial }`, only what the caller can read: contacts by email prefix (an index range), names for the rest, threads from the mail search. |
| 2.2 | Activity feed: `GET /v1/activity` | **Built** (HAL-3362) | Overview → Activity | `GET /v1/activity?cursor=&limit=` → `{ events: [{ id, kind, text, subject: { type, id, label }, actor: { type: "key"\|"system", id, name }, at }], nextCursor }`. Kinds: `audit.<action>`, `alert.<kind>`, `email.bounced`, `email.complained`; newest first across all three. |
| 2.3 | A workspace-wide socket | **Proposal** (contract: not built) | — | **No screen depends on it any more.** Mailbox unread counts come from the built per-mailbox socket (2.4). Alerts, health, usage, campaign progress and first-run checks refresh on focus, or are polled while a step is open. A workspace socket would replace polling for alerts, activity and campaign progress. |
| 2.4 | Per-mailbox socket: `GET /v1/mailboxes/{id}/live` | **Built** | Sidebar and bottom-bar unread counts | Events: `hello`, `counts`, `message.added`, `threads.changed`, `labels.changed`, `drafts.changed`, `draft.due`, `error`. The client sends `"ping"` or `{"type":"counts"}`. See HANDOFF §5. |
| 2.5 | Alert `kind` as a fixed set | **Built** (HAL-3364) | `shell/alerts-drawer.html` | `kind` is a literal union: `delivery_events_missing`, `campaign_paused` (was `campaign.paused`), `dns_drift`, `reputation_warning`, `reputation_at_risk`, `bounce_spike`, `complaint_spike`, `quota_80`, `quota_100`, `webhook_dead_letter`, `import_failed`, `export_ready`, `domain_activated`, `automation_failed`. Alerts gain `count` and `updatedAt`; `GET /v1/alerts` takes `kind=` and `severity=` and returns `open: { total, critical, warning, info }` for the bell. Events raise their own (a dead delivery, a failed import or run, a large export finishing, a domain's first full pass); the hourly sweep raises and clears the states (DNS drift, reputation, spikes, quota). Notices clear themselves: `export_ready` after a day, `domain_activated` and `import_failed` after a week. No workspace socket yet (2.3): the drawer polls. |
| 2.6 | Structured banner data | **Proposal** | `shell/banners.html`, states | Today the banners are derived client-side from built endpoints: reputation (`status`, `graceStartedAt`, `policy.suspension_after_hours`), usage (`overQuota`, `resetsAt`), domain checks, and `/v1/sending/events` for the new delivery-events banner (§3, Built). Proposed: a `changedAt` per check (3.4) so the drift banner can say when. |
| 2.7 | Request id on errors | **Proposal** | `states/overview-error.html` | `requestId` in every `{ _tag, … }` error, plus an `x-request-id` header. Until then show the `cf-ray` header, which is what `sign-in-unreachable` uses. |
| 2.8 | Unread on the mailbox list | **Proposal**, convenience only | Sidebar first paint | `GET /v1/mailboxes` has no unread count. The socket’s `counts` event covers it once connected, and `GET /v1/mailboxes/{id}/folders` (`unreadThreads`) is the built fallback. |

## 3. Overview

**Built and used exactly as the contract states:**

- `GET /v1/health` → `{ status: "ok"|"warn"|"fail", checks: [{ name, status: "ok"|"warn"|"fail"|"unknown", detail }], checkedAt }`. The schema has no names, but the source fixes them: `database`, `sending`, `domains`, `delivery_events` (HAL-3341), `reputation`, `quota` and `webhooks`. The health strip’s “Mailyard” row shows all seven with those names, and prints the `detail` of any `warn` or `fail` underneath. The foundation run’s fixture used invented names (`cloudflare-api`, `governor`, `queues`); it is now derived exactly as `insights.health` builds the response.
- `GET /v1/usage` → `today: { sent, quota, remaining, overQuota, resetsAt, source }`, `month: { from, billed, included, overage, costUsd, projectedBilled, projectedCostUsd }`, `pricing`. The quota meter has a designed state for each `source`:
  - `cloudflare`;
  - `cloudflare-unreachable`: quota unknown, sending uses the fallback (`states/cloudflare-unreachable.html`);
  - `not-connected`: connect in Settings (`states/cloudflare-not-connected.html`).

  In both non-`cloudflare` states, `quota`, `remaining`, `overQuota` and `resetsAt` are treated as null.
- `GET /v1/stats/delivery?range=` → `{ range, from, totals, rates }`.
  - **Rates are fractions** (`0.02` = 2%). This answers the earlier GAPS question 3.11.
  - Every rate is `null` with `insufficientData: true` when the range holds fewer than `minimumSends` sends. The screens then say “Not enough data yet” with *n of 100* and never draw a percentage.
  - The complaint rate is measured against **deliveries**; its label reads “Complaint rate · of delivered”.
- `GET /v1/reputation`:
  - **The thresholds are the account’s own Cloudflare policy.** `policySource` says which: `account`, or `measured-2026-10-16` when the account policy can’t be read. The rates panel footer names it.
  - When `source` is `not-connected`, the health strip and the rates panel say **“judged on our own rates”** instead of showing a Cloudflare verdict.
- `GET /v1/stats/volume`, `/v1/stats/providers`, `/v1/alerts`, `/v1/domains` (with checks), `/v1/campaigns?status=active`, `/v1/campaigns/{id}/pace`, `/v1/usage/forecast`.
- **New since the first follow-up:** `GET /v1/sending/events` → `{ domains: [{ domain, subscribed: boolean|null, withEvents, silent, status: "ok"|"warn"|"unknown", detail }] }` (HAL-3341, PR #27). It feeds a “Delivery events” chip on each sending domain in the health strip. When a domain is `warn`, it also drives the critical “Delivery events aren’t reaching Mailyard” banner (`states/overview-delivery-events-missing.html`, `shell/banners.html`). Note that the `/v1/health` check for the same condition is `fail`, not `warn`, and the matching alert is `critical`; the designs follow the source.

**Not built:**

| # | Item | Status | Panel | Proposed shape |
|---|---|---|---|---|
| 3.1 | `GET /v1/mail/attention` | **Built** (HAL-3362) | Needs you | `{ replyTargetHours, unread: [{ mailboxId, address, count }], unreadTotal, waitingForReply, oldestWaitingAt, snoozedReturningToday, assignedToMe, mailboxes: [per-mailbox counts], unavailable }`. Waiting = inbox conversations whose latest message is someone else's and older than `MAILYARD_REPLY_TARGET_HOURS` (24, or `?replyTargetHours=`). Over the mailboxes the caller can read. |
| 3.2 | `GET /v1/stats/inbound?range=` | **Built** (HAL-3362) | Inbound | `?range=24h\|7d\|30d\|90d` → `{ range, received, rejected: { total, noSuchAddress, dmarcFail: null, rbl: null }, held, spam, byMailbox: [{ mailboxId, address, received, spam }], days: [{ day, received, rejected, spam }], topSenders, topSendersEstimate }`. DMARC and listed-sender rejections happen in Email Routing before Mailyard; reading them is HAL-3393. |
| 3.3 | `GET /v1/stats/audience?range=` | **Built** (HAL-3362) | Audience | `{ range, asOf, total, byStatus, new, unsubscribed, suppressed, totalByDay: [{ day, total\|null }] }`. Counts by status are the hourly snapshot (`asOf`); `new`, `unsubscribed` and `suppressed` are live for the range. |
| 3.4 | `changedAt` on each domain check | **Built**, HAL-3365: `checks[].changedAt`. | Drift banner, health strip | `checks[].changedAt: number`. |
| 3.5 | `zoneStatus` and `nameservers` on a domain | **Built**, HAL-3365: `zoneStatus` (summary and detail), `nameservers`, `currentNameservers` (public DNS, no token needed). | Health strip DNS chip, first-run step 1 | `zoneStatus: "active"\|"pending"\|"moved"\|null`. |
| 3.6 | `GET /v1/automations/summary` | **Planned**, M5 (HAL-3299–3301) | Going out now → Automations running | `{ range, live, automations: [{ id, name, status, activeRuns, enteredToday, failuresToday }] }`. |
| 3.7 | `ratePerHour` on `/v1/campaigns/{id}/pace` | **Built**, HAL-3419: sends in the trailing hour, from `hourly_stats`; null while paused. | Going out now (“Pace 160/h”) | `ratePerHour: number\|null`, null while paused. |
| 3.8 | Typed `byStream` keys | **Built**, HAL-3419: always the four keys; replies count as mailbox, tests aren't charted. | Volume by stream | `{ transactional, campaign, automation, mailbox }`, the governor’s four names. |
| 3.9 | Hourly buckets for 24 h | **Built**, HAL-3419: `by=hour` → `hours: [{ hour, byStream }]`, 24 buckets. | Volume at 24 h | `by=hour` → `hours: [{ hour, byStream }]`. The 24 h screen shows one split bar and says so. |

## 4. First run

| # | Item | Status | Step | Proposed shape / note |
|---|---|---|---|---|
| 4.1 | `GET /v1/domains/candidates` | **Built**, HAL-3365: `{ connected, candidates: [{ name, zoneId, zoneStatus, nameservers, registrar, inWorkspace, workspaceDomains, existingMx }] }`; needs CLOUDFLARE_DNS_TOKEN. | 1. Add a domain | `{ candidates: [{ name, zoneId, zoneStatus: "active"\|"pending"\|"none", nameservers, currentNameservers?, registrar, existingMx, inWorkspace }] }`. |
| 4.2 | Turning mail on | **Built**, via `PATCH /v1/domains/{id} { receiving, sending }`, `GET /v1/domains/{id}` checks and `POST …/recheck` | 2. Turn on mail | The spec’s `/enable` and `/checks` paths aren’t needed. The screen polls while open. A `"pending"` value for `checks[].status` would let “checking” come from the API rather than the client: **Proposal**. |
| 4.3 | Routing-rule conflict on mailbox create | **Built** (HAL-3378) | 3. First mailbox, failing | `POST /v1/mailboxes`: an enabled Email Routing rule for exactly that address that doesn't go to Mailyard's Worker (a forward, a drop, another Worker) answers `409 { reason: "routing-rule-exists", ruleDestination, ruleAction, ruleId }`. `replaceRoutingRule: true` repoints it at Mailyard, keeping its matcher and priority. The create's answer says `routing: "clear" \| "replaced" \| "unchecked"`, which is `unchecked` without the zone token (CLOUDFLARE_DNS_TOKEN, which needs Email Routing Rules: Edit) and for catch-alls. |
| 4.4 | `POST /v1/test-send` | **Built** (HAL-3378) | 4. Send a test | `{ from, to? }` → the test, then poll `GET /v1/test-send/{id}` → `{ status: sending\|sent\|delivered\|received\|failed, deliveryTimeMs, authentication: { spf, spfDomain, dkim, dkimDomain, dmarc, dmarcPolicy } }`. Without `to`, it goes to `mailyard-test@` on a receiving domain (the sender's own when it receives): the pipeline reads the receiving side's verdicts, takes the policy from DNS, and drops the mail (`consumed`) before any catch-all. With `to`, it reports delivery only. |
| 4.5 | `GET /v1/verified-addresses` | **Built** (HAL-3378) | 4. Send a test | `{ available: true, addresses: [{ email, verifiedAt }] }`, Email Routing's verified destination addresses (sends to them are free and outside the quota), or `{ available: false, reason }` when the read token lacks Email Routing Addresses: Read. |
| 4.6 | `POST /v1/mailboxes/{id}/imports/probe` | **Built** (HAL-3399) | 5. Old mail, folder list | `POST /v1/mailboxes/{id}/imports/probe { host, port?, username, password }` → `{ host, port, folders: [{ name, messages, folder, label, skipped, skipReason }] }`; the password is used for that one connection only. |
| 4.7 | IMAP import `ratePerMinute`, `etaAt` | **Proposal**, still absent at 9428241 | 5. Old mail, in progress | Not covered by the contact import below: this row is the mailbox (IMAP) import, `/v1/mailboxes/{id}/imports`. Without these fields the screen shows counts and no ETA. |
| 4.8 | Contact CSV import | **Built**, HAL-3291 (PR #28): `POST /v1/imports/contacts`, `GET /v1/imports`, `GET /v1/imports/{id}` | 6. Contacts (`first-run/csv-empty`, `-map`, `-progress`, `-pass`, `-fail`) | The step now follows the built flow and field names exactly. The file is read in the browser for its header and row count, uploaded, then imported with `{ uploadId, mapping, topicIds, onConflict: "update"\|"skip", defaultStatus }`. Progress is polled from `{ status: queued\|running\|completed\|failed, headers, rows, created, updated, skipped, invalid, duplicates, suppressed, errors: [{ line, message }], error }`. What the schema still lacks is listed in 4.9–4.13. |
| 4.9 | `POST /v1/uploads?filename=` in the OpenAPI | **Built and documented** (HAL-3398) | 6. Contacts | `/openapi.json` now describes the raw routes too: `POST /v1/uploads`, `POST /v1/mailboxes/{id}/uploads`, `GET …/live`, `…/raw`, `…/attachments/{id}`, `GET /v1/files/{token}`. A test checks each described route is served. |
| 4.10 | Consent attestation | **Proposal** | 6. Contacts, mapping | The spec asks for a consent checkbox. `POST /v1/imports/contacts` has no field for it, so today it lives only in the screen, which marks it “Consent not recorded yet”. Proposed: `consent: { attestedBy, attestedAt, statement }`, stored on the import and in the audit log. **Built (HAL-3371):** `consent: { attested: true, statement? }` on the request; the import returns `consent { attested, statement, attestedBy, attestedAt }`, it's audited, and every subscription the import makes stores it as `evidence` on its `subscription_changes` row. |
| 4.11 | Total rows, for a progress bar | **Proposal** | 6. Contacts, in progress | The import learns its total only at the end of the file. The screen counts rows in the browser before upload (“of about 12,406”). Proposed: `bytesRead` with the upload’s `size`, or `rowsTotal`. **Built (HAL-3371):** `bytesRead` of `size` (exact from the start), `processed`, `ratePerMinute`, `etaAt`, `startedAt`. |
| 4.12 | Cancel a contact import | **Proposal** | 6. Contacts, in progress | There is no cancel for `/v1/imports/{id}` (the IMAP import has one), so the in-progress screen offers no Cancel. Proposed: `POST /v1/imports/{id}/cancel`. **Built (HAL-3371):** `POST /v1/imports/{id}/cancel` → `status: "cancelled"`. The Workflow is terminated; rows already written stay. 400 once it's finished. |
| 4.13 | More than 100 row errors | **Proposal** | 6. Contacts, passing | `errors` keeps the first 100 (`MAX_ERRORS`). The screen says so and builds its download from those. Proposed: `GET /v1/imports/{id}/errors.csv` with every rejected row. The spec’s third dedupe policy, “overwrite”, isn’t offered (`onConflict` is `update` or `skip`), and the designs drop it rather than ask for it. **Built (HAL-3371):** `errorsTotal`, and `GET /v1/imports/{id}/errors.csv` with every rejected row (`line,column,value,code,message`), written to R2 step by step as the import runs. |

## 5. Not gaps

- **`/u/:token`**, the unsubscribe and preference page, is built. It returns HTML, so it isn’t in the OpenAPI. Nothing in this run depends on it.

## 6. Brand

### 6.1 Proposal: a data palette in the Flareyard tokens

`brand/tokens.css` has scales but no chart palette, so `mailyard.css` derives one (§1, `--data-*`) and keeps it there. Proposed addition to `tokens.css` and `tokens.json`, with the same names in every Flareyard app:

| Token | Light | Dark | Job |
|---|---|---|---|
| `--data-1` | `blue-800` | `blue-700` | First categorical series |
| `--data-2` | `teal-700` | `teal-700` | Second series |
| `--data-3` | `blue-1000` | `blue-900` | Third series |
| `--data-4` | `gray-800` | `gray-800` | Fourth series, “other”, totals |
| `--data-good` / `--data-warn` / `--data-bad` | `green-700` / `amber-700` / `red-700` | same | Meaning only: passing, warning, failing. Never used for categories. |
| `--data-track` | `gray-200` | `gray-200` | Bar and meter tracks |

The tokens are aliases of existing scale steps, so no new colour values. Ember stays out of charts (it’s the accent), and so does Cloudflare orange. Measured against `background-100`, every series holds at least 3:1 (WCAG 1.4.11). Light: 4.43, 3.24, 17.41, 3.64. Dark: 5.61, 6.12, 10.48, 4.24. The first draft used `blue-600` and `gray-700` in light (1.89 and 2.58); both were replaced. Mailyard maps streams onto them: transactional → 1, campaign → 2, automation → 3, replies → 4. Once the tokens land, `mailyard.css` keeps its `--data-transactional`-style names as aliases of `--data-1…4`.

### 6.2 Usage when Cloudflare isn’t reachable

`usage.today.source` can be `cloudflare-unreachable` or `not-connected`. Both are designed (see §3), with no API change needed.


<!-- ===== GAPS-mail.md ===== -->

## Area: Mail (HAL-3308)

(From `GAPS-mail.md`, verbatim.)

# Mailyard web app: Mail gaps (HAL-3308)

These are the endpoints and fields the Mail screens need that the live API doesn't have yet. The screens are in `screens/mail/`.

- **Measured against:** `reference/openapi.json`, the live document (`Mailyard API 0.0.1`, 93 paths), fetched 2026-10-17. Also `reference/backend-contract.md` (flareyard-80, origin/main ab33e9b, 2026-10-17).
- **Not measured since:** anything after 2026-10-17. The backend session is building now, so re-check the live document before building against any row here.
- **How a row shows up on screen.** A proposal's UI carries a dashed blue **Proposed API** pill. Its `data-endpoint` ends in `(proposed)`, and the response it renders is embedded as `<script type="application/json" data-fixture>`. Fixture keys under `_ahead` are proposals; every other key is a live field name.
- **Conventions.** Shapes follow the API: Effect Schema, `camelCase`, epoch-millisecond timestamps in mailbox endpoints, and errors as `{ _tag, message, … }`. Foundation gaps (`GAPS.md` 1.x–5.x) are cited, not repeated.

**What Mail can build on today.** These are live and the screens use them as they are:

- `/v1/mailboxes` (list, detail, members)
- `/v1/identities`
- `…/folders`
- `…/threads` (with `folder`, `labelId`, `unread`, `starred`, `assignee` and `cursor`)
- `…/threads/{threadId}`
- `…/threads/bulk`, whose actions are archive, inbox, trash, delete, spam, notSpam, read, unread, star, unstar, label, unlabel, move, snooze, unsnooze and assign
- `…/search`
- `…/messages/{messageId}` (GET with `body`, `rawUrl` and `attachmentUrls`; PATCH)
- `…/labels` (CRUD)
- `…/drafts` (CRUD, plus `send {sendAt, undoSeconds}` and `cancel`)
- `…/folders/{folder}/empty`
- `…/rules` (CRUD, `order`, `test`)
- `…/senders`
- `…/imports` (create, list, get, cancel)
- `…/exports`
- `/v1/contacts?q=`
- `/v1/messages/{id}`

The mailbox socket `ws /v1/mailboxes/:id/live` is **built**, with the events hello, counts, message.added, threads.changed, labels.changed, drafts.changed, draft.due and error.

---

## M1. Folders and lists

| # | Endpoint / field | Screens | Proposed shape |
|---|---|---|---|
| M1.1 | A **folder enum** with Starred, Assigned to me, Scheduled and All mail | `folders`, `assigned`, `starred`, `scheduled`, `all-mail` | **Built** (HAL-3405): `folder=all` on `GET …/threads` (every folder but spam and trash). Starred and Assigned to me are the `starred=true` and `assignee=<keyId>` filters; Scheduled is `GET …/drafts?status=scheduled`. |
| M1.2 | Counts for the virtual folders | Folder pane on every screen | **Built** (HAL-3405): `GET …/folders` → `views: { starred, assignedToMe, scheduled, all: { threads, unreadThreads } }`, read through an index or a kept count. |
| M1.3 | Who an assignee is | Rows, reader, assign picker | **Built** (HAL-3405): `assignedTo: { id, name } \| null` beside `assignee` (the key id, unchanged): the key's name until people exist (HAL-3361). |
| M1.4 | Spam score on the list | `spam` rows (“Score 9.8”) | **Built** (HAL-3405): `thread.spamScore` (the highest of its spam messages) when listing `folder=spam`. |
| M1.5 | A thread's scheduled reply | Inbox row chip “Reply sends Sun 08:00 UTC” | **Built** (HAL-3405): `thread.scheduledSendAt`, the earliest scheduled draft in the conversation. |
| M1.6 | Total for “1–14 of 312” | List toolbar | **Built** (HAL-3405): `total` on `GET …/threads` for a plain folder (no other filter), from the kept counts; null otherwise. |
| M1.7 | Drag a thread onto a label | Folder pane `.is-drop` | Not a gap: `bulk { action: "label", labelId }`. |

## M2. Search

| # | Endpoint / field | Screens | Proposed shape |
|---|---|---|---|
| M2.1 | **Operator support** in `q` | `search`, `search-operators`, `search-empty` | **Built** (HAL-3406): the `q` description lists every operator (from:, to:, cc:, subject:, body:, in:, label:, is:unread, is:starred, has:attachment, before:, after:), and the response says what it understood: `parsed: { operators, terms, unsupported }`. Unknown operators are searched as words and listed in `unsupported`. |
| M2.2 | Highlights | Results | **Built** (HAL-3406): hits have `subject` (plain) and `subjectHighlighted` (matches in `\u0002…\u0003`, as `excerpt`). |
| M2.3 | `GET /v1/search/mail?q=` (all mailboxes) | `search-all` | **Built** (HAL-3363): `GET /v1/search/mail?q=&sort=&limit=` → `{ query, parsed, groups: [{ mailboxId, address, hits, threads }], searched, partial: [{ mailboxId, reason: timeout\|error }] }`, each readable mailbox searched at once within 2.5 s. |
| M2.4 | Smart folders | “Save as smart folder” | **Built** (HAL-3406): `GET/POST …/smart-folders`, `PATCH/DELETE …/smart-folders/{id}`, `{ id, name, q, createdAt }`, listed in `GET …/folders` as `smartFolders`. Opening one is `GET …/search?q=<q>`. No counts per smart folder: a count would be a search on every folder pane load. |
| M2.5 | Sort | “newest first” | **Built** (HAL-3406): `sort=recent\|relevance`, defaulting to recent; the response echoes `sort`. |

## M3. Labels

| # | Endpoint / field | Screens | Proposed shape |
|---|---|---|---|
| M3.1 | `label.color` values | `labels-manage`, every tag | **Built** (HAL-3407): `color` is `"blue"\|"navy"\|"sky"\|"teal"\|"pine"\|"slate"\|null`. Old hex values moved to the nearest palette colour when each mailbox migrated; hex is refused from now on. |

## M4. Reader

| # | Endpoint / field | Screens | Proposed shape |
|---|---|---|---|
| M4.1 | Full headers | `thread-details` → Headers | **Built** (HAL-3407): `GET …/messages/{id}?include=headers` → `headers: [{ name, value }]`, every header in the order it arrived (newest hop first). |
| M4.2 | **ARC** | Authentication line, details | **Built** (HAL-3407): `auth.arc: { result, instance, sealer } \| null`, from the newest ARC-Seal (i=, d=, cv=) and the receiver's arc= verdict. Messages stored before this have the verdict with instance and sealer null. |
| M4.3 | Spam threshold | Details → Spam score | **Built** (HAL-3407): `mailbox.spamThreshold` (default 5, `spamThresholdIsDefault`), settable 1 to 20 with `PATCH /v1/mailboxes/{id}` (null for the default); filing uses it. |
| M4.4 | **Delivery status of our sent replies** | `thread`, `thread-delivery`, `sent` | **Built** (HAL-3408): a sent copy's `delivery.recipients: [{ recipient, kind: to\|cc\|bcc, status, at, attempts, smtpResponse }]`, seeded when the send goes out (suppressed recipients as `suppressed`) and moved by each recipient's own delivery events (never backwards; deferrals counted). Each change is pushed as `delivery.changed { messageId, logId, recipients }` on the mailbox's live socket. |
| M4.5 | Internal notes | `thread`, note composer (N) | **Built** (HAL-3407): `notes: [{ id, body, author: { id, name }, createdAt }]` with the thread; `POST …/threads/{id}/notes { body }` (members and owners), `DELETE …/notes/{id}` (its author, or the owner or an admin: 403 otherwise). Pushed as `notes.changed` on the socket; never sent. |
| M4.6 | AI summary | `thread` (“when it's on”) | `POST /v1/mailboxes/{id}/threads/{threadId}/summary` → `{ threadId, text, provider, model, generatedAt }`, cached until a new message arrives. Gated by `GET /v1/settings/ai` (spec; not built). |
| M4.7 | Calendar invites | `thread-invite` | An attachment with `mimeType: text/calendar` exists, but nothing is parsed. Proposed: `message.invite: { uid, method, summary, start, end, location, organizer, attendees: [{ address, partstat }] } \| null`. RSVP: `POST …/messages/{id}/rsvp { response: "accepted"\|"tentative"\|"declined" }` sends the iTIP reply from the mailbox (it counts as one send). |
| M4.8 | Remote images per sender | `remote-bar` “Always show from gmail.com” | The block itself is client-side (frame CSP `img-src data: cid:`). The preference needs storing: `POST /v1/mailboxes/{id}/senders { value, list: "images" }`, or a separate `imageSenders` list. |
| M4.9 | Attachment URLs | Previews, download | Not a gap: `attachmentUrls` on GET message. Confirm they're signed and how long they last (the lightbox opens them directly). The spec's `GET /v1/attachments/:aid` isn't needed. |
| M4.10 | Thread position “1 of 312” | Reader bar | Client-side from the loaded list. Not needed from the API. |

## M5. Composer

| # | Endpoint / field | Screens | Proposed shape |
|---|---|---|---|
| M5.1 | **`POST /v1/uploads`** | `compose-attachments`, attach anywhere | **Built** (HAL-3398): `POST /v1/mailboxes/{id}/uploads?filename=` with the file as the body (25 MiB) → `201 { key, filename, mimeType, size, sha256 }`, the key a draft attachment takes; documented in the OpenAPI. `POST /v1/uploads` is the import upload (50 MiB). Kept as two routes: different limits, scopes and lifetimes. |
| M5.2 | Over the 5 MiB budget → R2 link | `compose-attachments` | **Built** (HAL-3398): sends already link what doesn't fit; each draft attachment now says `delivery: "inline"\|"link"`, from the same plan the send uses. Links last as `LARGE_ATTACHMENT_LINK_TTL_SECONDS` says. |
| M5.3 | Undo send | `compose-undo` | Not a gap. `POST …/drafts/{id}/send { undoSeconds: 10 }` → `{ sendAt, undoUntil }`, and Undo is `POST …/drafts/{id}/cancel`. The spec's `DELETE /v1/sends/:id` isn't needed. |
| M5.4 | **Why a send is refused** | `compose-blocked-quota`, `-reputation`, `-domain`, and Drafts' “Not sent” | **Built** (HAL-3397): `409 { _tag: "SendBlocked", reason: "quota_exhausted"\|"domain_unhealthy"\|"all_recipients_suppressed", message, resetsAt?, domainId? }` on `POST …/drafts/{id}/send`, checked again as it goes out; a refusal then puts `blockedReason` (and `lastError`) on the draft. `domain_unhealthy` = sending off, an unknown domain, or an open critical `dns_drift`. Reputation never blocks person-to-person mail. |
| M5.5 | Queue for the reset | Quota state “Queue for 00:00 UTC” | Not a gap: `send { sendAt: usage.today.resetsAt }`. |
| M5.6 | Recipient suggestions | `compose-new` | **Built** (HAL-3398): `GET /v1/mailboxes/{id}/correspondents?q=&limit=` → `{ correspondents: [{ address, name, received, sent, lastAt }] }`, address or name prefix, most recent first. Kept per mailbox as mail is filed (spam, trash and automated senders left out). |
| M5.7 | Templates in the composer | “Template” | `GET /v1/templates` exists. Confirm a mailbox draft can be rendered from one (`POST /v1/templates/{id}/render` exists). |
| M5.8 | AI draft | “Draft with AI” | `POST /v1/ai/draft { mailboxId, threadId?, instruction }` → `{ bodyText, bodyHtml }`. Gated by `/v1/settings/ai`. |
| M5.9 | Signature per identity | Composer footer | **Built** (HAL-3398): `GET /v1/identities` gives each identity `signature`; an alias takes its mailbox's when it has none of its own. |
| M5.10 | Time zone | Every “08:00 UTC” | Times are shown in UTC because nothing stores the user's zone. Proposed: `me.timeZone` (GAPS 1.1). The snooze and schedule pickers would then show local time with UTC beside it. |

## M6. Rules and senders

| # | Endpoint / field | Screens | Proposed shape |
|---|---|---|---|
| M6.1 | Match counts | `rules` (“212 matches · last 2 min ago”) | Not in `Rule`. Add `matchCount: number, lastMatchedAt: number \| null`. |
| M6.2 | Assign as a rule action | `rule-from-message` | Actions are label, archive, trash, spam, markRead, star, skipSpamCheck, forward, autoReply and webhook. Add `{ type: "assign", assignee }`. |
| M6.3 | Run a rule on existing mail | `rule-from-message` checkbox | `POST …/rules/{ruleId}/apply { folder? }` → `{ matched, updated }`. |
| M6.4 | Rule from a search | `search` “Make a rule” | Client-side: map operators to conditions (`from:` → `{field:"from", op:"contains"}`). Needs M2.1 to be exact. |
| M6.5 | `rules/test` outcome types | Test result | `outcome` and `filedWith` are untyped (`?`) in the OpenAPI. Type them, for example `outcome: "inbox"\|"spam"\|"trash"\|"archive"` and `filedWith: { labelIds, folder }`. |

## M7. Import and export

| # | Endpoint / field | Screens | Proposed shape |
|---|---|---|---|
| M7.1 | Speed and ETA | `import-running`, folder-pane card | **Built** (HAL-3399): `ratePerMinute` (over moving time, paused time out; null for the first minute) and `etaAt` (while running). |
| M7.2 | Pause and resume | `import-running` | **Built** (HAL-3399): `POST …/imports/{id}/pause` and `/resume`, `status: "paused"`, `pausedAt`. Pausing stops between batches; resume carries on from the same batch. A pause longer than 7 days ends the import (credentials wiped). |
| M7.3 | Retry the failed messages | `import-running`, `import-failed` | **Built** (HAL-3399): failed UIDs are kept per folder (first 1,000; `folders[].retryable`). `POST …/imports/{id}/retry-failed { password }` starts a new import of just those (`retryOf`). IMAP only; the password is given again because the first import's was wiped. |
| M7.4 | The last error per folder | “Last error: 3 messages over 25 MiB” | **Built** (HAL-3399): `folders[].lastError`. |
| M7.5 | Progress live | Card and page | **Built** (HAL-3399): `import.progress { importId, status, totals, ratePerMinute, etaAt, folders, seq }` on the mailbox's live socket after planning, each batch, pause, resume and the end. |
| M7.6 | Catch-up after the MX switch | `import-running` second panel | **Built** (HAL-3399): a catch-up has `catchupOf` (the import it continues) and `since` (when that one finished). |
| M7.7 | Export link lifetime | `export` | **Built** (HAL-3399): `downloadsExpireAt` on an export, with each read signing a fresh pair of links (a week). |

## M8. Live, offline, push

| # | Endpoint / field | Screens | Proposed shape |
|---|---|---|---|
| M8.1 | Live new mail | `live-new-mail` | Not a gap: `message.added` and `counts` on `ws /v1/mailboxes/:id/live`. Confirm that `message.added` carries the thread summary (the `Thread` shape) so the row renders without a fetch. |
| M8.2 | Reconnect | `reconnecting` | **Built** (HAL-3397): every frame carries `seq`, and `hello` the latest. Reconnect with `…/live?since=<seq>` or send `{ type: "resume", since }`: the missed frames, then `{ type: "resumed", since, seq, replayed }`, or `{ type: "reset", seq, counts }` when they're older than the kept 1,000 or a day (refetch). |
| M8.3 | Offline queue | `offline` | **Built** (HAL-3397): `idempotency-key` on `POST …/drafts` and `POST …/drafts/{id}/send` (24 h): a repeat returns the same draft or send; a different body under the same key is `409 IdempotencyConflict`. |
| M8.4 | **Web Push** | `push-enable`, `push-settings` | Not built. `GET /v1/push/vapid-key` → `{ publicKey }`. `POST /v1/push/subscriptions { endpoint, keys: { p256dh, auth }, device }` → `{ id }`. `DELETE /v1/push/subscriptions/{id}`. `GET/PUT /v1/push/preferences` → `{ mailboxes: [{ mailboxId, notify: "all"\|"assigned"\|"off" }], alerts: boolean, hideContent: boolean }`. Sends on `message.added` and on assign. |

## M9. Roles

| # | Endpoint / field | Screens | Proposed shape |
|---|---|---|---|
| M9.1 | Which mailboxes a person can read | `agent`, switcher | **Built**, HAL-3361: `/v1/me.mailboxes` lists `{ id, address, access }`; agents see only theirs. Keys keep `mailboxes: null`.
| M9.2 | Mailbox-level viewer | `mailbox-readonly` | **Built**, HAL-3361: a viewer's write is `403 { reason: "mailbox_role", role: "viewer", owners: [names] }`.
| M9.3 | Workspace viewer opening Mail | `viewer` | **Built**, HAL-3361: a role refusal is `403 { reason: "role", role, allowedRoles }`.

---

## Not API, but owed

- **Label swatches in the tokens.** The six swatch names map to token steps in `css/mail.css` (`.lc-*`). Give them names in `brand/tokens.css` when the data palette lands (GAPS 5.1).
- **The sandbox recipe.** Email HTML renders in an `<iframe sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox">` with a CSP meta of `script-src 'none'; img-src data: cid:`. `allow-same-origin` lets the app size the frame; scripts never run. “Show images” re-renders with `img-src https:`. The server should still strip `<script>`, `on*` handlers and `<form>`, as a second line of defence.


<!-- ===== GAPS-audience.md ===== -->

## Area: Audience, campaigns, automations (HAL-3310)

(From `GAPS-audience.md`, verbatim.)

# Mailyard · Audience, Campaigns and Automations: API gaps

Everything the screens in `screens/audience/` need that the live API doesn't have yet, with the screen that needs it and a proposed shape. Merge into `GAPS.md` as sections A1 to A9.

**Measured on 2026-10-17 against the refreshed `reference/openapi.json`**: 103 paths, origin/main 47426a9. Where the OpenAPI leaves something undocumented (filter syntax, the rule tree, export behaviour), I read the backend source at that commit (`flareyard/mailyard`) and cite the file. Compared with the 93-path snapshot this run started from, ten paths are new:

- `GET /v1/campaigns/{id}/report`, `GET /v1/campaigns/{id}/recipients` and `POST /v1/campaigns/{id}/resend-non-openers`: PR #25, **Built**. The report screens use their live schema; the open question is A7.5; A7.6 is answered and A7.7 is built (HAL-3429).
- `POST /v1/imports/contacts`, `GET /v1/imports` and `GET /v1/imports/{id}`: HAL-3291, **Built**. The import screens use their live schema; what’s still missing is A5.1–A5.11.
- `GET /v1/forms/{id}/embed` and the public page and submit: HAL-3317 (PR #31, 47426a9), **Built**; see A4.
- `POST /v1/exports`, `GET /v1/exports` and `GET /v1/exports/{id}`: HAL-3316 (PR #30), **Built**, together with the `segmentId`, `field` and `event` filters on `GET /v1/contacts`. The contacts list and export screens use them; see A1.1 and A1.7.
- `GET /v1/sending/events`, which no screen here needs.

Every other row below was re-checked field by field against the 103-path document and is still missing.

How the screens mark things:

- `data-endpoint` names the endpoint behind each panel; `(ahead)` means it's designed ahead of the API.
- A dashed blue **Ahead of the API** pill (`.pill-ahead`) marks a panel whose source isn't built.
- A green **Live API** pill marks panels on endpoints that landed during this run: the report, the imports, the contacts filters, the exports and the forms.

Status words used in this file:

- **Built**: in the live OpenAPI; the screens use its field names.
- **Ahead**: not in the OpenAPI and not in flight; designed to the spec in `email-ui.html`.
- **Next**: listed as next work in backend-contract §5, but not built.
- **Field**: the endpoint exists, but a field the screen needs doesn't.

---

## A1. Contacts

| # | Status | Endpoint / field | Screens | Proposed shape |
|---|---|---|---|---|
| A1.1 | **Built** (HAL-3316) · docs gap | `segmentId`, `field` and `event` filters on `GET /v1/contacts` | `contacts-selected.html`, `contacts-add-filter.html`, `contacts-no-match.html`, `contacts-invalid-filter.html` | Live. `segmentId` applies a saved segment’s rules. `field=key:op[:value]` filters on `email`, `name` or a custom field, with `op` one of `eq neq contains notContains startsWith endsWith gt gte lt lte exists missing`; the value is everything after the second colon, and `gt`/`gte`/`lt`/`lte` compare numbers when the value is numeric. `event=[!]name[:days]` means did the event within the last 1–3,650 days, or with `!`, didn’t. `field` and `event` repeat; every filter is ANDed with `q`, `status`, `topicId` and `engagement`. Bad syntax is a `400 InvalidRequest` with a plain message (“The gte filter on courses_completed needs a value.”), which `contacts-invalid-filter.html` shows; an unknown segment is a `404`. Source: `src/domain/contactFilters.ts`. **Remaining gap:** the OpenAPI types `field` and `event` as `string \| string[]` with no description. Add the syntax and the op list as descriptions, so clients don’t have to read the source. |
| A1.2 | **Built** (HAL-3422) | Multi-value `engagement` and `status` | Filter chips (“Engagement is active, cooling”) | Accept comma lists: `status=subscribed,unconfirmed`. |
| A1.3 | **Built** (HAL-3422) | `GET /v1/contact-fields` | Column picker, contact profile (field types), import mapping, segment field rules | `{ fields: [{ key, label, type: "text"\|"number"\|"date"\|"boolean", createdAt, usedBy: number }] }`. `fields` on a contact is typed `{}` today, so the UI can’t tell a number from text, and the column picker can’t list custom fields without scanning contacts. |
| A1.4 | **Built** (HAL-3422) | When and how each topic subscription changed, on the contact | `contact.html` → Topics and consent | `topics[]` gains `changedAt: number`, `source: string` (`form:frm_…`, `import:imp_…`, `api`, `double-opt-in`, `preference-page`, `one-click`), `confirmedAt: number\|null`. The timeline’s `subscription` items already carry `source`; the contact doesn’t, so the panel would need the whole timeline to render one line. |
| A1.5 | **Built** (HAL-3422) | Timeline kinds and message events | `contact.html` → Timeline | Live kinds are `event`, `message` and `subscription`. The spec also wants opens and clicks per message, replies, automation runs and consent records. Proposed: `message.events: [{ type: "delivered"\|"deferred"\|"bounced"\|"opened"\|"clicked"\|"complained", at, machine?: boolean, url?: string }]`, plus three new kinds: `{ kind: "reply", mailboxId, threadId, subject }`, `{ kind: "automation", automationId, automation, version, status, step }` and `{ kind: "consent", topicId, method, formId?, ip, userAgent }`. Add a `kind=` filter for the All/Email/Events/Topics/Automations control. |
| A1.6 | **Built** (HAL-3422) | Suppression on the contact | `contact.html`, `contact-suppressed.html` | `suppression: { reason: "hard_bounce"\|"complaint"\|"unsubscribe"\|"manual", source: "cloudflare"\|"bounce-handler"\|"one-click"\|"manual", detail: string\|null, createdAt, cloudflare: "in-sync"\|"missing"\|"not-applicable" } \| null`. `status: "suppressed"` alone can’t say why or from where; `GET /v1/contacts/{id}/export` already has a `suppression` object, so the data exists. |
| A1.7 | **Built** (HAL-3316) · small gaps | `POST /v1/exports`, `GET /v1/exports`, `GET /v1/exports/{id}` | `contacts-export.html`, `contacts-export-ready.html`, `contacts-export-failed.html` | Live. Request: `{ kind: "contacts", filter: { q, status, topicId, engagement, segmentId, field, event }, fields: string[] (≤ 50 custom fields) }`. Response: `{ id, kind, status: "running"\|"completed"\|"failed", rows, fields, filename, url, error, createdAt, finishedAt }`. Up to 10,000 matching contacts the CSV is written in the request and comes back `completed` with a signed `url` good for a day; past that it comes back `running`, a Workflow writes it, and the client polls `GET /v1/exports/{id}`. The fixed columns are `id, email, name, status, engagement, topics, created_at, last_activity_at, last_opened_at, last_clicked_at`. The file is UTF-8 with a BOM, formula-like cells are defused, and each export is audit-logged. Source: `src/exports/contactExport.ts`. **Remaining gaps:** (a) `GET /v1/exports` always returns `url: null`, so each row needs a `GET /v1/exports/{id}` to get a link; that works, but say so in the description. (b) No count before exporting: add `GET /v1/contacts?…&limit=0` returning `count`, or `POST /v1/exports?dryRun=1 → { rows }`, so the sheet can say “418 contacts” from the API rather than the list. (c) No progress while `running`: add `processed`. (d) Nothing tells you when a background export finishes: add an `export_ready` alert. (e) `createdBy` isn’t returned, so the recent list can’t say who exported. **Built (HAL-3371):** `POST /v1/exports?dryRun=1` → `{ dryRun: true, rows }` (nothing written). Exports carry `processed`, `total` (matching at start) and `createdBy`; a large one raises `export_ready`. |
| A1.8 | **Built** (HAL-3422) | Bulk “all that match” | Bulk bar → “Select all 3,702 that match” | `POST /v1/contacts/bulk` takes `ids` only. Accept `{ filter: {…} }` in place of `ids` for a selection across pages, and return `{ updated, skipped, errors, jobId? }`, going async above a threshold. |
| A1.9 | Decision | Role rules for contacts | `contacts-agent.html`, `contact-agent.html`, `contact-sender.html` | The designs assume these rules: agents read contacts only (no edit, import, export, bulk or automation trigger); senders do everything except erasing and removing suppressions; erasing and removing suppressions is for owners and admins. Each 403 should be `{ reason: "role", allowedRoles }` (GAPS.md 1.13). **Built as written**, HAL-3361: agents read contacts only; senders edit, import, export and bulk-edit, but erasing and lifting suppressions is owner and admin (`contacts.erase`). |

## A2. Topics

| # | Status | Endpoint / field | Screens | Proposed shape |
|---|---|---|---|---|
| A2.1 | **Built** (HAL-3423) | `GET /v1/topics/stats?range=30d` | `topics.html` (30-day trend, new, unsubscribe rate) | `{ range, topics: { [topicId]: { new30d, unsubscribed30d, unsubscribeRate: number\|null, insufficientData: boolean, trend: number[] } } }`. Rates are fractions and null under 100 subscribers. The spec asks for “growth, unsubscribe rate”; `GET /v1/topics` has only `subscribers`. |

## A3. Segments

| # | Status | Endpoint / field | Screens | Proposed shape |
|---|---|---|---|---|
| A3.1 | **Built** (HAL-3423) | The `filter` schema | `segment-builder*.html`, `segment-zero.html` | The OpenAPI still types `filter` as `{}`. The real shape is in `src/segments/rules.ts`: groups `{ type: "all"\|"any", rules }` (at most 4 deep and 50 rules) over leaves `field { field, op, value? }`, `status { in }`, `topic { topicId, state?, is? }`, `event { name, did?, withinDays?, atLeast? }`, `engagement { in }`, `campaign { campaignId, activity: received\|opened\|clicked, did? }` and `created { withinDays?, olderThanDays? }`. The builder and its fixtures now use that shape. Field rules have no “is any of” operator, so “country is NG, GH or KE” is an any-group of three `eq` rules. **Remaining gap:** publish the Rule schema in the OpenAPI, and consider an `in` op for fields. The segments list’s old “didn’t open any campaign in 90 days” example isn’t expressible (a `campaign` rule needs a `campaignId`), so it’s now “Didn’t open September recap”; propose a `campaign` rule with no `campaignId` meaning any campaign, plus `withinDays`. |
| A3.2 | **Built** (HAL-3423) | Which rule failed | `segment-preview-error.html` | `src/domain/segments.ts` returns validation failures as `InvalidRequest { field, message }` with `field` set to the failing rule’s path (for example `…rules[3].rules[1]`), and decode failures with `field: "filter"`. The builder can mark the rule from that. **Remaining gap:** document the path format in the OpenAPI. |
| A3.3 | **Built** (HAL-3423) | `usedBy` on segments | `segments.html`, `segments-delete-blocked.html` | `usedBy: [{ type: "campaign"\|"automation", id, name, status }]`. `DELETE /v1/segments/{id}` on a used segment should answer `409 { _tag: "Conflict", reason: "in-use", usedBy }`. |
| A3.4 | **Built** (HAL-3423) | Sendable vs suppressed in the count | `segment-builder.html` → Live count split | Preview returns `count` only. Add `sendable` and `excluded: { suppressed, bounced, unsubscribed }`, as `POST /v1/campaigns/{id}/audience/preview` already does for campaigns. |
| A3.5 | Ahead | Natural-language entry | Builder → “Describe it” | `POST /v1/segments/compile { text } → { filter, explanation }`, behind `/v1/settings/ai`. Nothing is saved; the rules land in the builder for review. |
| A3.6 | **Built** (HAL-3423) | Preview timing | “Counted just now · 38 ms” | Optional `tookMs` on the preview response. Cosmetic; drop the line if not added. |

## A4. Forms (HAL-3317, PR #31, 47426a9)

**Built** (re-measured from `reference/openapi.json`, 103 paths; source in `mailyard-src/live/forms-domain.ts`, `forms-page.ts` and `forms-turnstile.ts`):

| # | Status | Endpoint / field | Screens | What the live API does |
|---|---|---|---|---|
| A4.B1 | **Built** | Form fields | `form-editor.html`, `forms.html` | `{ id, name (1–100), topicIds (≥ 1, existing and not archived), fields (custom keys only, matching `^[A-Za-z_][A-Za-z0-9_]{0,63}$`, never `email` or `name`), redirectUrl (https or null), description (≤ 500 or null), turnstileSiteKey (or null), archived, createdAt }`. A bad field is a `400 InvalidRequest { field, message }` with plain messages (“That isn’t a Turnstile site key.”, “The redirect must be an https URL.”), checked one field at a time; see `form-editor-invalid.html`. |
| A4.B2 | **Built** | `GET /f/{formId}` and `POST /v1/forms/{id}/submit` | Editor preview (the page itself is the Ops run’s) | The page shows the brand, the form’s `name` as its heading, `description`, every topic as “You’ll get all of these”, Email (required), Name (optional) and the custom fields (optional, labelled from the key, with autofill hints), a honeypot, Turnstile when a site key is set, and “Sign up”. It’s styled from Settings → Brand, light and dark. Submit answers `{ status: "subscribed"\|"confirm", redirectUrl }` and never reveals whether the address was already known. An archived form is “not found”. |
| A4.B3 | **Built** | `GET /v1/forms/{id}/embed` → `{ pageUrl, html }` | `form-editor.html` → Share and embed | One generated snippet: the same fields as a plain `<form class="mailyard-form">` that posts with `fetch` (CORS allows any origin) and falls back to a normal post without JavaScript, plus the Turnstile script when a site key is set. The editor shows it verbatim (ported from `embedSnippet()`). No iframe snippet is generated; the page allows framing, so pointing an iframe at `pageUrl` works. |
| A4.B4 | **Built** | Turnstile verification | Editor → Bot protection | With a form `turnstileSiteKey` and the deploy’s `TURNSTILE_SECRET`, every submission’s token goes to siteverify before anything is written. It fails closed: a missing token, a rejected one, or no answer from Cloudflare (5 s timeout) refuses the submission. |

**Still gaps:**

| # | Status | Missing | Screens | Proposed field or endpoint |
|---|---|---|---|---|
| A4.1 | **Built** (HAL-3424) | Whether verification is actually on | Editor → Bot protection (marked “Secret status not exposed”) | A site key without `TURNSTILE_SECRET` shows the widget but checks nothing, and the admin can’t tell. Add `turnstile: { siteKey, verifying: boolean }` to the form, or `turnstileSecretSet` to `GET /v1/health`’s checks. Optional: create the widget through Cloudflare’s Turnstile API so nobody has to paste a key. |
| A4.2 | Field | Widget mode | Editor → Bot protection | The page always renders `data-size="flexible"`, and the mode (managed, non-interactive, invisible) lives on the Cloudflare widget. No change needed unless keys are created by Mailyard (A4.1); the design says where the mode is set. |
| A4.3 | **Built** (HAL-3424) | Submission stats | `forms.html`, editor header (marked “Count ahead”) | `stats: { submissions30d, confirmed30d }` on each form, or `GET /v1/forms/{id}/stats?range=`. |
| A4.4 | **Built** (HAL-3424) | Field labels, required and order | Editor → Fields | Labels come from the key (`labelOf`: `first_name` → “First name”) and every custom field is optional. Proposed: `fields: [{ key, label?, required? }]`, keeping plain strings valid. |
| A4.5 | **Built** (HAL-3424) | Topic choice for visitors | Editor → Subscribes them to | Visitors get every topic on the form. If a form should let people pick, add `topicChoice: "all"\|"pick"`; the page would then render checkboxes. |
| A4.6 | **Built** (HAL-3424) | Embed variants | Editor → Share and embed | Only the fetch snippet is generated. An `?variant=iframe` on `/embed` (or a `snippets` array) would save people from writing the iframe themselves. |

## A5. Contact import (HAL-3291)

**Built** (re-measured from `reference/openapi.json`, 100 paths, 2026-10-17):

| # | Status | Endpoint / field | Screens | What the live API does |
|---|---|---|---|---|
| A5.B1 | **Built** | `POST /v1/imports/contacts` | `import-mapping.html` → Start import | One step. Request: `{ uploadId, mapping: { [column]: target }, topicIds?, onConflict?: "update"\|"skip", defaultStatus?: "subscribed"\|"unsubscribed" }`. It returns the import. My proposed two-step upload-then-confirm (with server-side column detection) isn’t how it works: the browser reads the headers and first 20 rows itself, so the mapping step stays and runs client-side. |
| A5.B2 | **Built** | `GET /v1/imports/{id}` | `import-progress.html`, `import-done.html`, `import-row-errors.html`, `import-error.html` | `{ id, uploadId, status: "queued"\|"running"\|"completed"\|"failed", mapping, topicIds, onConflict, defaultStatus, headers, rows, created, updated, skipped, invalid, duplicates, suppressed, errors: [{ line, message }], error, createdAt, finishedAt }`. The screens poll it every 2 s. |
| A5.B3 | **Built** | `GET /v1/imports?cursor=&limit=` | `import-upload.html` → Past imports | Same item shape, with `nextCursor`. |
| A5.B4 | **Built** | Per-row errors | `import-row-errors.html`, `import-error.html` | `errors[]` as `{ line, message }`. “Download errors as CSV” is built in the browser from `errors[]` plus the local file; no server report URL is needed. |
| A5.B5 | **Built** | Whole-import failure | `import-error.html` | `status: "failed"` with an `error` string, and the counts so far. |

**Still gaps:**

| # | Status | Missing | Screens | Proposed field or endpoint |
|---|---|---|---|---|
| A5.1 | Ahead | Something to mint `uploadId` | `import-upload.html` | Nothing in the API issues an `uploadId`: no path has `upload` in it. Use GAPS-mail M5.1’s `POST /v1/uploads { filename, mimeType, size }` → `{ key, uploadUrl (signed PUT), expiresAt }`, and either call that `key` `uploadId` here or rename the import field to `uploadKey`; one name for both. Add `purpose: "contacts-import"` so the Worker can cap size and type. |
| A5.2 | Field | The mapping target vocabulary | `import-mapping.html` | `mapping` is `{ [column]: string }` with no enum or description. The designs send `email`, `name` and `fields.<key>`, and leave unmapped columns out. Publish the allowed targets (and whether `status` and `topics` can be mapped from a column), and say whether a new `fields.<key>` creates the field. **Built (HAL-3371):** targets are `email`, `name`, `name.first` + `name.last` (joined), `status`, `fields.<name>`, `ignore`, documented on the request. A registered field is read as its type; a new name is stored as text and registers itself. |
| A5.3 | Field | The file name on the import | Past imports, report and progress titles | Not returned, so the list shows ids. Add `fileName` and `fileSize` (copied from the upload). **Built (HAL-3371):** `fileName`, `fileSize`. |
| A5.4 | Ahead | Cancel | `import-progress.html` → Cancel import (disabled with the reason) | `POST /v1/imports/{id}/cancel` → the import with `status: "cancelled"`. Add `"cancelled"` to the enum. **Built (HAL-3371):** see 4.12. |
| A5.5 | Field | Rate and ETA, and what `rows` means while running | `import-progress.html` | Add `processed: number`, `ratePerMinute: number\|null` and `etaAt: number\|null`. Say whether `rows` is the file’s total from the start or grows as it parses. The screen assumes the total and computes processed as created + updated + skipped + invalid. **Built (HAL-3371):** `processed` (= `rows`, which grows while running), `ratePerMinute`, `etaAt`, plus `bytesRead`/`size`. |
| A5.6 | Field | Column, value and code on each error | `import-row-errors.html` | Add `{ column: string\|null, value: string\|null, code: "invalid_email"\|"missing_email"\|"role_address"\|"invalid_value"\|"parse_error" }` beside `line` and `message`. Also say whether `errors` is capped; if it is, add `errorsTotal` and `GET /v1/imports/{id}/errors?cursor=`. **Built (HAL-3371):** each error has `column`, `value`, `code: missing_email\|invalid_email\|invalid_value\|parse_error`. `errors` is capped at 100; `errorsTotal` and `errors.csv` have them all. (`role_address` isn't a check Mailyard makes.) |
| A5.7 | Field | Consent attestation | `import-mapping.html` → attestation (marked “Not recorded yet”) | Accept `consent: { attested: true }` on the request, store `{ attestedBy, attestedAt, importId }` as each imported contact’s consent source, and return it on the import. Until then the checkbox is a client-side gate only. **Built (HAL-3371):** see 4.10. |
| A5.8 | Field | How counts relate | Counts on every import screen | Say whether `duplicates` (repeats within the file) and `suppressed` are part of `skipped`; the screens assume so and show them under it. Also say whether rows before a failure are kept; `import-error.html` assumes they are, because the counts say so. **Built (HAL-3371):** documented: rows = created + updated + skipped + invalid + duplicates; `suppressed` is part of `created`; `duplicates` isn't part of `skipped`; rows written before a failure or a cancel are kept. |
| A5.9 | Field | Field types | `import-mapping.html` → Detected type | The mapping carries no type, so custom fields are stored as text and the detected type is browser-only. Pair with A1.3: `mapping: { [column]: { target, type } }` or typed `contact-fields`. **Built (HAL-3371):** through the field registry: `PATCH /v1/contact-fields/{key} { type }` makes later imports read that column as number, boolean or date; a cell that isn't one is an `invalid_value` error. |
| A5.10 | Field | Overwrite and name joining | Options, mapping | `onConflict` is `update` or `skip`; my proposed `overwrite` (clear fields where the cell is empty) isn’t there, and the screen no longer offers it. Contacts have one `name`, so First Name and Last Name can’t be joined; the design maps First Name to `name` and Last Name to `fields.last_name`. Proposed: allow `"name.first"` and `"name.last"` targets that the importer joins. **Built (HAL-3371):** `name.first` and `name.last` join into `name`. `overwrite` stays out, as the designs dropped it. |
| A5.11 | Ahead | Live progress | `import-progress.html` | `import.progress { id, …counts }` on `ws: workspace` (GAPS.md 2.3); polling works until then. |
| A5.12 | — | Not a CSV | `import-wrong-file.html` | No API change: caught in the browser before upload. |

## A6. Suppressions

| # | Status | Endpoint / field | Screens | Proposed shape |
|---|---|---|---|---|
| A6.1 | Built | `GET/POST/DELETE /v1/suppressions` | `suppressions*.html`, `contact-suppressed.html` | **Built** (HAL-3372). `GET /v1/suppressions?reason=&source=&cloudflare=&q=&cursor=` → `{ suppressions: [{ email, reason, source, messageId, note, bulkOnly, streams, cloudflare: "in-sync"\|"missing"\|"not-applicable"\|"unchecked", at, updatedAt }], counts: { total, hard_bounce, complaint, unsubscribe, manual }, cloudflare: { readable, writable, checkedAt, cloudflareOnly, error }, nextCursor }`. `GET /v1/suppressions/{email}` adds the contact, its status before, and Cloudflare's own entries. `POST /v1/suppressions { email, reason?, note?, bulkOnly?, push? }`. `PATCH /v1/suppressions/{email} { note?, bulkOnly? }`. `DELETE /v1/suppressions/{email} { confirm: true }` restores the contact's status and removes Cloudflare's entries; a complaint is refused with `409 { _tag: "Conflict", reason: "complaint" }`, and `bulkOnly: true` is how transactional mail reaches that person. `POST /v1/suppressions/{email}/push`, `POST /v1/suppressions/import` (CSV from `/v1/uploads`, other providers' reason words mapped), `GET /v1/suppressions/imports[/{id}]`, `POST /v1/suppressions/sync` (also hourly). Owner/admin only means the `admin` scope until roles land (HAL-3361). |

## A7. Campaigns

| # | Status | Endpoint / field | Screens | Proposed shape |
|---|---|---|---|---|
| A7.1 | **Built** (HAL-3428) | Summary rates on the list | `campaigns.html` (delivered, opened, clicked, unsubscribed per sent campaign) | `GET /v1/campaigns` has no stats; the list would need one report call per row. Add `summary: { sent, deliveryRate, openRate, clickRate, unsubscribeRate, insufficientData } \| null` to sent and cancelled items. |
| A7.2 | **Built** (HAL-3428) | Status counts for the tabs | `campaigns.html` → status tabs | `GET /v1/campaigns/counts → { draft, scheduled, sending, paused, sent, cancelled }`. |
| A7.3 | Field | Exclusions | `campaign-audience.html` → Leave out | **Built** (HAL-3429): `exclude: { segmentIds (≤10), recentlySentDays (1–90) \| null } \| null` on the campaign, in create and PATCH. The preview, the snapshot and every chunk honour it, and the preview's `excluded` gains `bySegment: [{ segmentId, name, count }]` and `recentlySent`, with each contact counted once. Only other campaigns' mail counts as recently sent. A segment a campaign leaves out is in use, so it can't be deleted, and an audience over 90 parameters is refused with `field: "exclude"`. |
| A7.4 | Field | Link statuses | `campaign-preview.html` → Links | **Built** (HAL-3430): `POST /v1/campaigns/{id}/render` returns `links: [{ url, status: number\|null, error, redirectsTo, checkedAt }]`, read from `link_checks`, which the `links_resolve` check writes. Never-followed links have a null `status` and `checkedAt`. `checkLinks: true` in the body follows links not checked in the last hour (at most 30) before answering. |
| A7.5 | **Built** (HAL-3428) | Not enough data on the report | `campaign-report-insufficient.html` | The live report returns `rates` as plain numbers at any size. The spec and brief want null rates with `insufficientData: true` under 100 sends, like `/v1/stats/delivery`. Until that ships, the screen applies the 100 rule client-side. |
| A7.6 | **Answered** (schema proposal only) | `activity[].hour` | Report → Opens and clicks over time | Measured from the backend source, `src/campaigns/report.ts` at origin/main 9428241: whole hours since the campaign started sending, `floor((first_opened_at − startedAt) / 3600000)`, kept while `h < 168` (the first 7 days). The chart now plots hours 0–167 after sending started, with a mark at each day (24, 48 … 168). Tooltips read “Day 2, hour 5”, plus the clock time worked out from `startedAt`. **Still proposed for the schema:** give `hour` `maximum: 167` and a description (“Whole hours from startedAt to the contact’s first open; the first 7 days only”), so clients don’t read it as an hour of the day. |
| A7.7 | Field (live endpoint) | Resend options | `campaign-resend.html` | **Built** (HAL-3429): `POST …/resend-non-openers { countMachineOpensAsOpened?, subject? }`, where an empty body still works. The dry run is `GET …/resend-non-openers?countMachineOpensAsOpened=true` → `{ recipients, sendable, countMachineOpensAsOpened }`, and it creates nothing. Machine-only opens do **not** count as opened by default, so those people get the resend; the schema says so. Segments gained `includeMachine` on campaign `opened`/`clicked` rules. |
| A7.8 | Field | “Fix” target for each check | `campaign-checks.html`, `campaign-blocked.html` | **Built** (HAL-3430): every check has `fix: { label, target: "content"\|"audience"\|"settings.compliance"\|"domains", field?, domainId? } \| null`. `content` names a campaign field (subject, bodyHtml, bodyBlocks, bodyText, templateId, fromAddress, replyTo, trackClicks); `settings.compliance` names linkAllowlist, trackingOrigin or postalAddress; `domains` carries `domainId` once the domain exists. Only `unsubscribe` has `fix: null`. There's a new `merge_fields` check (warn) for placeholders the renderer leaves as typed. |
| A7.9 | Field | What’s already queued in the window | `campaign-schedule.html` → ETA by day | **Built** (HAL-3429): `GET /v1/usage/forecast?recipients&startAt&campaignId` returns `startAt` and `days: [{ day, available, queued, thisCampaign }]`, from today to the finish. Scheduled and sending campaigns are served first, on the bulk share (the transactional reserve is left out). `campaignId` keeps a scheduled campaign from queueing behind itself. Automations aren't forecast. |
| A7.10 | **Built** (HAL-3428) | Time zone | Schedule → Time zone | `sendAt` is absolute ms, which is right. Store `timezone: string` so the UI can show “10:00 in Lagos” back. |
| A7.11 | Field | `ratePerHour` on pace | `campaign-sending.html` | As GAPS.md 3.8. |
| A7.12 | **Built** (HAL-3428) | Pause reason as a code | `campaign-paused-*.html` | `pausedReason` and `pace.reason` are free text. Add `pausedBy: "user"\|"quota"\|"governor.bounce"\|"governor.complaint"\|"reputation"` so the screen can pick its banner and decide whether Resume is allowed (quota pauses resume on their own at the reset). **Quota holds (HAL-3431):** `quota` is gone from `pausedBy`. A quota hold isn't a pause, because the campaign carries on at the reset by itself. A sending campaign the governor holds shows `heldUntil` (ms) and `heldBy: "quota"\|"warmup"`, with `status` still "sending". |
| A7.13 | **Built** (HAL-3428) | Save conflict | `campaign-editor-error.html` | `PATCH /v1/campaigns/{id}` should accept `ifMatch: updatedAt` and answer `409 { _tag: "Conflict", updatedBy, updatedAt }`. Without it, two editors overwrite each other silently. |
| A7.14 | **Built** (HAL-3428) | Test results | Preview → Send a test | `POST /v1/campaigns/{id}/test` returns `status` per address. To show “delivered 4 min ago”, keep the last test on the campaign as `lastTest: { at, results }`. |
| A7.15 | Field | Block document | Content → Blocks | **Built** (HAL-3430, HAL-3433): `bodyBlocks: BlocksDocument \| null` on the campaign, in create and PATCH and copied by a resend, rendered through the template kit in the brand. It can't sit beside `bodyHtml` or `templateId`, and its strings are syntax-checked on save. A section error names the string it's in: `field: "bodyBlocks.blocks[3].text"`, with a message starting `In blocks[3].text:`. **Syntax confirmed:** a fallback is `{{ name ?? "there" }}` (single quotes work too). The pipe form `{{ first_name \| "there" }}` isn't parsed and would go out as typed, which the `merge_fields` check flags. |

## A8. Automations (M5, HAL-3299–3301)

The OpenAPI has **no automation endpoints at all**: re-measured live, zero paths match `automation`. Everything below is designed ahead, to the spec’s contract row: “/v1/automations (+ dry-run, publish, runs, summary) · /runs/:id/exit|retry · run counts per node”.

| # | Endpoint | Screens | Proposed shape |
|---|---|---|---|
| A8.1 | `GET /v1/automations?range=` | `automations*.html` | `{ range, summary: { live, activeRuns, entered, completed, failed }, automations: [{ id, name, status: "draft"\|"live"\|"paused", trigger: { kind: "event"\|"created"\|"segment"\|"topic"\|"date", event?, segmentId?, topicId?, field? }, version, publishedVersion: number\|null, activeRuns, entered, completed, failed, goal: { event, rate: number\|null } \| null, updatedAt }] }`. Summary is the same read model as GAPS.md 3.7. |
| A8.2 | `GET/PATCH /v1/automations/{id}` | `automation-builder*.html` | `{ id, name, status, version, publishedVersion, graph: { nodes: [{ id, type: "trigger"\|"wait"\|"wait_until"\|"wait_event"\|"branch"\|"send"\|"update"\|"topic"\|"webhook"\|"exit", config }], edges: [{ from, to, port?: "yes"\|"no"\|"event"\|"timeout" }] }, counts: { [nodeId]: { here, passed, failed } }, validation: [{ nodeId, code: "missing_content"\|"unreachable"\|"no_exit"\|"invalid_config", message }], updatedAt, updatedBy }`. PATCH saves the draft version only. No positions are stored: the canvas lays out from the graph. |
| A8.3 | `POST /v1/automations/{id}/dry-run` | `automation-dry-run.html` | `{ contactId, version?: "draft"\|number, assume?: { [nodeId]: "happens"\|"times-out"\|"yes"\|"no" } } → { path: [{ nodeId, at, outcome: "would-run"\|"would-wait"\|"yes"\|"no"\|"timed-out", detail }], endsAt }`. Nothing is sent. |
| A8.4 | `POST /v1/automations/{id}/publish` | `automation-publish.html` | `{ note } → { version, runsByVersion: [{ version, active }] }`. `409` with `validation` when there are issues. |
| A8.5 | `GET /v1/automations/{id}/versions` | `automation-versions.html` | `{ versions: [{ version, status: "draft"\|"live"\|"finishing"\|"retired", note, publishedAt, publishedBy, activeRuns, updatedAt, editedBy }] }`. The spec doesn’t list this endpoint, but “running contacts finish on their old version” can’t be shown without it. Also `POST …/versions/{n}/restore` to make an old version the draft. |
| A8.6 | `GET /v1/automations/{id}/runs?status=&version=&cursor=` | `automation-runs*.html` | `{ runs: [{ id, contactId, email, version, nodeId, step, status: "active"\|"waiting"\|"completed"\|"exited"\|"failed", enteredAt, nextAt, error }], total, nextCursor }` |
| A8.7 | `GET /v1/runs/{id}`, `POST /v1/runs/{id}/exit`, `POST /v1/runs/{id}/retry` | `automation-run-failed.html` | `GET → run + steps: [{ nodeId, label, at, outcome, detail, response?: { status, headers, body } }]`. Retry re-runs the failed step only. |
| A8.8 | `POST /v1/automations/{id}/nodes/{nodeId}/test` | Inspector → “Send a test request” | Webhook nodes only: sends a signed test request and returns `{ status, tookMs, body }`. |
| A8.9 | Pause and resume | `automations.html` | `POST /v1/automations/{id}/pause\|resume`. A pause holds runs where they are. |
| A8.10 | Manual trigger | `contact.html` → Trigger automation | `POST /v1/automations/{id}/enter { contactId }` |
| A8.11 | Live counts | Node counts | Push `automation.counts { id, counts }` on `ws: workspace` (GAPS.md 2.3); until then, poll A8.2 on focus. |
| A8.12 | Alerts | Alerts drawer | **Built** (HAL-3364): `automation_failed:<automationId>`, with `count` = runs failed in the last 24 hours and the step most of them failed on in `detail`. Retrying them, or a quiet day, clears it. |
| A8.13 | Alert channels | Settings → Alerts | **Built** (HAL-3465): `GET/PUT /v1/settings/alerts { channels: [{ kind: "email"\|"webhook", target, kinds?, minSeverity }], defaultEmail? }` → the same plus `effective: { criticalEmail, note }`. An email `target` is an address; a webhook `target` is an endpoint id. A channel takes `kinds` (all when empty) at or above `minSeverity`. With no channels, critical alerts mail `defaultEmail`, else the owner, else nobody (the `note` says so). An alert is sent when it opens and again when its severity rises. Email goes on the `system` stream; webhooks get the new `alert.raised` event `{ alertId, key, kind, severity, title, detail, subject, escalated }`, sent to every endpoint subscribed to it and to webhook channels. |

## A9. Design decisions to confirm

| # | Item | What the designs do |
|---|---|---|
| A9.1 | Viewers and reports | Viewers can’t open Campaigns or Automations from the sidebar (as the foundation locks them). The spec says viewers read reports, so `campaign-report-viewer.html`, `campaigns-viewer.html` and `automations-viewer.html` are reachable from links (Overview → Going out now, Analytics), read-only. |
| A9.2 | Resume after a reputation pause | Offered as “Resume anyway…”, a secondary action with a warning, rather than blocked. Quota pauses can’t be resumed early, because nothing can send. |
| A9.3 | Machine-only opens in A/B | The report shows the winner by the campaign’s `ab.metric`. When it’s opens, the screen recommends clicks next time, because machine opens decide open-based tests. |


<!-- ===== GAPS-ops.md ===== -->

## Area: Transactional, domains, analytics, settings, public pages (HAL-3309)

(From `GAPS-ops.md`, verbatim.)

# Mailyard ops screens: API gaps (HAL-3309)

What the Transactional, Domains, Analytics, Settings and public-page designs need that the live API doesn't have yet. Merge into `GAPS.md` after the foundation's own sections.

- **Measured against:** the live document at `mailyard-api.halleluyaholudele.workers.dev/openapi.json`, re-fetched 2026-10-17 during this run (`Mailyard API 0.0.1`, 100 paths, 139 operations). It has 7 operations more than the vendored `reference/openapi.json` (93 paths): `GET /v1/imports`, `GET /v1/imports/{id}`, `POST /v1/imports/contacts`, `GET /v1/sending/events`, and the three campaign report endpoints from PR #25. The screens use the new ones as built.
- **Status vocabulary:** follows `reference/backend-contract.md`. "Proposed" means not built and not filed: the backend files issues from these designs. Every screen marks a proposed panel or field with a dashed "Proposed API" pill, and its `data-endpoint` says `(proposed)`.
- **Shapes:** Effect Schema conventions as the live API uses them: camelCase, epoch milliseconds for table timestamps (`createdAt: number`), ISO strings where the neighbouring endpoint already uses them, errors as `{ _tag, message, … }`, lists as `{ <plural>, nextCursor }`. **Rates are fractions** (`0.0094`), null with `insufficientData: true` under `minimumSends`.
- **Re-measured (follow-up, 2026-10-17):** against the refreshed `reference/openapi.json` (100 paths, 139 operations; identical to the live fetch above) and the backend source at `origin/main` 9428241, now fc9c0e5 (adds HAL-3316, contacts filters and exports, outside this area). What moved: the public `/u/:token` page is built (HAL-3297; §5), the `delivery_events` health check and alert are built (HAL-3341; §2), and the brand keys are named in the server's schema (§4.8). No other row here became live.
- **Re-measured again (2026-10-17, origin/main 47426a9, 103 paths):** HAL-3317 (PR #31) built the hosted signup page `GET /f/:formId`, Turnstile and `GET /v1/forms/{id}/embed`. Reading `src/workers/public.ts` also showed that `GET /c/:token` has been built since 11a2439, earlier than every measurement in this file, so §5.3 was stale from the start. `POST/GET /v1/exports` (contacts only) is new. See §5 and §4.11.
- **What this file isn't:** a measurement after that. Re-check before building against any row.

---

## 1. Transactional

| # | Endpoint / field | Screens | Proposed shape |
|---|---|---|---|
| 1.1 | `GET /v1/messages` filters `stream=`, `templateId=`, `q=` (recipient or message id), `from=`, `to=` | `transactional/messages*.html` | **Built**, HAL-3413: `stream`, `templateId`, `q` (id, Cloudflare id or recipient prefix), `from` and `to`, each served by an index. |
| 1.2 | `events[]` on `GET /v1/messages/{id}` | `message-delivered`, `-bounced`, `-deferred`, `-complained` | **Built**, HAL-3413: `events[]` (accepted, sent, deferred, delivered, bounced, complained, failed, rejected, suppressed, opened, clicked), kept by triggers on `messages_out`, plus `nextAttemptAt`. Messages sent before 2026-10-18 have no trail. |
| 1.3 | `headers[]`, `idempotencyKey`, `templateVersion`, `source` on a message | Message detail → Headers, Details | **Built**, HAL-3413: `headers[]` (what Mailyard handed Email Service), `idempotencyKey` (the caller's own), `templateVersion` and `source`. |
| 1.4 | `GET /v1/messages/{id}/raw` for sends | Message detail → Raw source | **Built**, HAL-3413: `GET /v1/messages/{id}/raw`, rebuilt as RFC 5322 from the stored copy. |
| 1.5 | Request counts per key | `api-keys.html` → Requests, 24 h | **Built**, HAL-3414: `?include=usage` adds `requests24h`, counted on write into an hourly per-key rollup. |
| 1.5b | Key `purpose` (`api` \| `mcp`) | Settings → Integrations, API keys | **Built**, HAL-3410: `purpose` on every key, optional on `POST /v1/api-keys` (default `api`; a public key can't be `mcp`, 400), and `GET /v1/api-keys?purpose=mcp` filters. A label, not a permission. |
| 1.6 | `POST /v1/api-keys/{id}/rotate` | API keys → Rotate | **Built**, HAL-3414: `{ graceSeconds? }` (0 to a week) → `{ key, apiKey, previous: { id, revokedAt } }`; the new key keeps the scopes, purpose and mailbox memberships. |
| 1.7 | Template usage | `templates.html` → Used by, Sends 30 d | **Built**, HAL-3415: `?include=usage` adds `usage: { sends30d, usedBy }` (automations, campaigns, API keys), from a trigger-kept daily rollup. |
| 1.8 | Test send of a template | Template editor → Send a test | **Built**, HAL-3415: `POST /v1/templates/{id}/test { to, data?, version?, from? }` sends the latest version (default) to 1–5 addresses, marked [Test], on the `test` stream. |
| 1.9 | Who edited a template, and when the draft was last saved | Template editor | **Built**, HAL-3415: `latest.updatedAt` and `latest.updatedBy`. |
| 1.10 | Webhook event catalogue | `webhook-create`, webhook lists | `GET /v1/webhooks` returns `events: string[]`, but neither the schema nor a description says what the strings are. The designs use `email.sent`, `email.delivered`, `email.deferred`, `email.bounced`, `email.complained`, `email.failed`, `email.rejected`, `email.opened`, `email.clicked`, `contact.subscribed`, `contact.unsubscribed` and `inbound.received`: **confirm or correct**, and make it a literal union. |
| 1.11 | Dead-letter count per endpoint | `webhooks.html` → Dead letters; alert `webhook_dead_letter` | **Built**, HAL-3416: `deadLetters` on every endpoint, counted from an (endpoint, status) index. |
| 1.12 | Signature scheme | Webhook detail → Verify the signature | No document says what header and algorithm sign a delivery. The designs show `Mailyard-Signature: t=…, v1=HMAC-SHA256(secret, t + "." + body)` with a 5-minute tolerance, and the SDK (HAL-3142) verifies it. Confirm or correct. |
| 1.13 | Bulk replay | Dead letters → Replay all | **Built**, HAL-3416: returns `{ replayed, remaining }`, at most 500 per call; call again while `remaining` > 0. |
| 1.14 | `GET /v1/suppressions`, `POST /v1/suppressions`, `DELETE /v1/suppressions/{email}` | `suppressions*.html`, message-bounced → Suppressions | **Built** (HAL-3372). `GET /v1/suppressions?reason=&source=&cloudflare=&q=&cursor=` → `{ suppressions: [{ email, reason, source, messageId, note, bulkOnly, streams, cloudflare: "in-sync"\|"missing"\|"not-applicable"\|"unchecked", at, updatedAt }], counts: { total, hard_bounce, complaint, unsubscribe, manual }, cloudflare: { readable, writable, checkedAt, cloudflareOnly, error }, nextCursor }`. `GET /v1/suppressions/{email}` adds the contact, its status before, and Cloudflare's own entries. `POST /v1/suppressions { email, reason?, note?, bulkOnly?, push? }`. `PATCH /v1/suppressions/{email} { note?, bulkOnly? }`. `DELETE /v1/suppressions/{email} { confirm: true }` restores the contact's status and removes Cloudflare's entries; a complaint is refused with `409 { _tag: "Conflict", reason: "complaint" }`, and `bulkOnly: true` is how transactional mail reaches that person. `POST /v1/suppressions/{email}/push`, `POST /v1/suppressions/import` (CSV from `/v1/uploads`, other providers' reason words mapped), `GET /v1/suppressions/imports[/{id}]`, `POST /v1/suppressions/sync` (also hourly). Owner/admin only means the `admin` scope until roles land (HAL-3361). |

## 2. Domains

| # | Endpoint / field | Screens | Proposed shape |
|---|---|---|---|
| 2.1 | `zoneStatus`, `registrar`, `nameservers`, `currentNameservers`, `dnssec` on a domain | `domains.html`, `domain-pending.html`, health strip | **Built**, HAL-3365: read at each recheck and stored; null without CLOUDFLARE_DNS_TOKEN except `currentNameservers`. |
| 2.2 | `complaints30d`, `returnPath` | Domain detail → Sending and reputation | **Built**, HAL-3365: `complaints30d` from Email Sending's per-subdomain complaints (summed in 7-day windows), `returnPath` from the sending subdomain. |
| 2.3 | Fix records | Domain failing → Fix records | **Built**, HAL-3365: `POST /v1/domains/{id}/fix` → `{ domain, actions[] }` via Email Routing's enable-DNS, Email Sending's fix-DNS and a DMARC TXT; 409 `FixRefused` with `reason` without a token. |
| 2.4 | Live check status while rechecking | `domain-rechecking.html` | **Built**, HAL-3365: `checking` is a check status while a recheck runs. |
| 2.5 | `GET /v1/domains/{id}/dmarc?range=` | `dmarc.html`, `dmarc-empty.html` | `{ domainId, range, reports, reporters: string[], policy: { record, p, pct, rua: string[] }, totals: { messages, dmarcPass, spfAligned, dkimAligned }, sources: [{ ip, provider, messages, spfPass, dkimPass, dmarcPass, known, reason: string\|null }], recommendation: { safeToQuarantine, blockers: string[], nextRecord } }`. Needs the inbound address that parses DMARC XML (plan, M1–M2). |
| 2.6 | Mark a DMARC source as known; change policy with preview | DMARC → Mark as known, Preview the DNS change | `POST /v1/domains/{id}/dmarc/sources/{ip}/known`, `PATCH /v1/domains/{id}/dmarc { p, pct }` with `?dryRun=1` returning `{ before, after }` records. |
| 2.7 | Domain import: `GET /v1/domains/candidates`, `POST /v1/domains/import`, `GET /v1/domains/imports/{id}`, `PATCH /v1/domains/imports/{id}/records`, `POST …/retry`, `DELETE …` | `import-*.html` | `{ id, domain, status: "running"\|"waiting"\|"active"\|"failed"\|"cancelled", step: "detected"\|"records"\|"dnssec"\|"nameservers"\|"waiting"\|"active", registrar, registrarConnected, detected: { registrar, nameservers, dnssec, zoneId }, cloudflareNameservers, records: [{ id, type, name, value, source: "scan"\|"registrar"\|"probe", proxied, flag: "conflict"\|"unknown"\|null, excluded, note }], checks: [{ at, result }], nextCheckAt, probe: [{ record, before, now, same }], error?: { step, message, providerCode } }`. The spec places the Workflow in the platform (HAL-3096); Mailyard proxies it. Progress on `ws: workspace`. |
| 2.8 | What drove a reputation spike | `reputation-at-risk.html` → What drove the spike | `GET /v1/reputation/drivers?window=24h` → `{ drivers: [{ type: "campaign"\|"automation"\|"template", id, name, sent, bouncedHard, complained, bounceRate }] }`. |

**Built and used as-is:**
- `GET /v1/sending/events` feeds "Sending events" on the domain detail: `domains[].{ domain, subscribed, withEvents, silent, status: "ok"|"warn"|"unknown", detail }`.
- **HAL-3341 (PR #27):** a sending domain whose delivery events never arrive. This is about the events-queue subscription, not a missing DNS record. `GET /v1/health` gains a `delivery_events` check (`fail` when any sending domain warns, `detail` is the domains' own text). An hourly watchdog opens the alert `kind: "delivery_events_missing"`, `severity: "critical"`, `subject: { type: "domain", id: <domain name> }`. The OpenAPI shape of `/v1/health` didn't change; the check name and wording come from `src/domain/insights.ts` and `eventCoverage.ts`. Shown in `domains.html` (callout and a "No delivery events" state) and `domain-no-events.html`. Not a gap, but worth knowing: the alert's `subject.id` is the domain *name*, while other domain alerts use the domain id (`dom_…`), so the drawer's link has to resolve it by name.

## 3. Analytics

| # | Endpoint / field | Screens | Proposed shape |
|---|---|---|---|
| 3.1 | Rates per day: `GET /v1/stats/delivery?range=&by=day` | Sending → Rates over time; Reputation history | **Built**, HAL-3420: `?by=day` adds `days: [{ day, totals, rates }]`, each with its own `insufficientData`. |
| 3.2 | Delivery time | Sending → Delivery time, median | **Built**, HAL-3420: `deliveryTime: { medianMs, p95Ms, samples, approximate, buckets }` from a histogram kept by a trigger on delivered events. |
| 3.3 | `GET /v1/stats/deferrals?range=` | Sending → Deferral reasons | **Built**, HAL-3420: `{ range, reasons: [{ reason, smtpStatus, provider, count }] }`, top 50. |
| 3.4 | `GET /v1/stats/engagement?range=&by=` | `engagement.html` | **Built**, HAL-3421: `{ range, estimate, campaigns: [{ …, openRate, clickRate }], byHour (Mon–Sun × 24 UTC hours), unsubscribesByTopic }`, from trigger-kept rollups. |
| 3.5 | `GET /v1/stats/inbound` with `by=day` and `topSenders` | `inbound.html` | **Built** (HAL-3362): `days` and `topSenders` are on `GET /v1/stats/inbound`. |
| 3.6 | `GET /v1/stats/response-times?range=` | Inbound → Response times | **Built** (HAL-3362): `{ range, mailboxes: [{ mailboxId, address, assignees: [{ assigneeId, name, threads, answered, firstResponseMedianMin, firstResponseP90Min, resolutionMedianHours: null }] }], unavailable }`. Resolution needs a resolved-at the store doesn't keep yet: HAL-3392. |
| 3.7 | `GET /v1/stats/audience` | `audience.html` | **Built** (HAL-3362), as foundation 3.3. |
| 3.8 | `GET /v1/usage/storage` | Usage → Mail held in R2 | **Built**, HAL-3421: `{ totalBytes, mailBytes, exportsBytes, uploadsBytes, byMailbox: [{ mailboxId, address, messages, bytes }] }`, from recorded sizes. |
| 3.9 | CSV export | Every chart → CSV; Export sheet | **Built**, HAL-3421: `GET /v1/stats/{chart}.csv` for volume, delivery, providers, deferrals, engagement, engagement-hours, unsubscribes, inbound, audience; rates stay fractions. |

**Used as-is:** `GET /v1/stats/providers` (`providers[].{ provider, delivered, deferred, bounced, complained, total }`), `GET /v1/usage/forecast?recipients=` (both union arms: `possible: true` with `sendableToday, additionalDays, finishesBy, cost.{ billedAfter, extraUsd }`, and `possible: false` with `reason`), `GET /v1/usage` including `today.source: "cloudflare-unreachable"` (Usage · quota unknown).

## 4. Settings

| # | Endpoint / field | Screens | Proposed shape |
|---|---|---|---|
| 4.1 | `GET /v1/members`, `PATCH /v1/members/{id}`, `DELETE /v1/members/{id}`, `GET/POST/DELETE /v1/invites`, `POST /v1/invites/{id}/resend` | `members*.html` | **Built**, HAL-3361: as shown, plus `POST /v1/invites/{id}/send` (an invitation is a draft until sent). `members[].mailboxes` lists `{ mailboxId, access, address }`. |
| 4.2 | Mailbox members by person, not by key | Mailbox detail → Members and access | **Built**, HAL-3361: `PUT /v1/mailboxes/{id}/members` also takes `{ memberId, access }`; `GET /v1/mailboxes/{id}` adds `people: [{ memberId, name, email, access, role }]`. |
| 4.3 | Aliases as their own resource | Mailboxes → Aliases | The spec names `/v1/aliases`; today aliases, groups and the catch-all are mailboxes with `kind: "alias"\|"group"\|"catch_all"` and `targetIds`. **Not a gap**: the designs use `GET /v1/mailboxes?kind=` and `PATCH { targets }`. |
| 4.4 | Rule match counts | Rules → matches, last match | **Built** (HAL-3396): `matchCount` and `lastMatchedAt` on each rule, counted once per stored copy as mail arrives. Also an `assign` action and `POST /v1/mailboxes/{id}/rules/{ruleId}/apply { folder?, cursor?, limit? }` → `{ examined, matched, changed, skippedActions, nextCursor }` (never sends). |
| 4.5 | Rule test outcome shape | Rule editor → Test | **Built** (HAL-3396): `outcome: { matched, folder, labelIds, markRead, star, skipSpamCheck, forwards, autoReplies, webhooks, assignee, stoppedAt }`, `filedWith: { folder, spamScore, spamReasons, rulesMatched }`. |
| 4.6 | `GET /v1/gmail-mode`, `POST /v1/gmail-mode/check` | `gmail-mode*.html` | `{ address, gmail, steps: [{ id: "verify"\|"route"\|"smtp"\|"test", title, status: "pass"\|"running"\|"waiting"\|"fail", detail, checkedAt }], smtp: { host, port, security, username } }`. Spike S4 decides whether "Send mail as" works with `api_token` at all. |
| 4.7 | Compliance additions | `tracking.html` | `GET/PUT /v1/settings/compliance` has `postalAddress, linkAllowlist, seedAddresses, trackingOrigin`. Add `trackOpensDefault`, `trackClicksDefault`, `doubleOptInDefault`, `preferencePage: { useBrand, showTopicDescriptions }`, and a `trackingOriginCheck: { cname, certificate, checkedAt }` for the live check under the hostname. **Built (HAL-3376):** `trackOpensDefault`, `trackClicksDefault` and `doubleOptInDefault` (null: the deploy's settings, double opt-in on) shape new campaigns and topics. `preferencePage { useBrand, showTopicDescriptions }` drives `/u`. `trackingOriginCheck { host, cname, certificate: valid\|failed, routesHere, checkedAt }` is written when `trackingOrigin` changes; recheck it with `POST /v1/settings/compliance/tracking-check`. |
| 4.8 | Brand keys in the OpenAPI, and a contrast check | `brand*.html`, every public page | The server validates `BrandSettings` (`src/domain/brand.ts`): `colors.{ bg, surface, fg, muted, border, lime, indigo, body, red, white }` as `#rrggbb`, `fonts.{ display, body, mono }`, `logoUrl` and `fontsHref` as http(s) URLs. The designs now use those names; the live `/u` page reads `bg, surface, fg, muted, border` and uses `indigo` as its accent. The OpenAPI still types `colors` and `fonts` as free maps and `PUT` as `any`: publish the struct. Proposed on top: reject a `PUT` whose text fails AA (`400 { field: "colors.indigo", message: "White text on this accent is 3.1:1; AA needs 4.5:1" }`), and a logo upload (`POST /v1/uploads` then `logoUrl`) so nobody hotlinks. **Built (HAL-3376):** the OpenAPI publishes `BrandSettings` itself (typed `colors.*` hex, `fonts.*`, https `logoUrl`/`fontsHref`). A PUT failing AA answers `400 { field: "colors.indigo" (or fg, body, muted), message: "White text on the accent is 1.4:1; AA needs 4.5:1…" }`, checked on the colours merged over the defaults. `logoUploadId` (PNG, JPEG, WebP or GIF by its bytes, ≤1 MiB; SVG refused) is stored and served at `/brand/logo/<sha256>.<ext>`, immutable. |
| 4.9 | `GET/PUT /v1/settings/ai` | `ai.html` | `{ provider: { kind: "workers-ai"\|"openai-compatible", model, baseUrl: string\|null, keySet: boolean }, features: [{ id: "spam"\|"summary"\|"reply"\|"triage"\|"subject", enabled, sends: string }] }`. |
| 4.10 | `GET /v1/integrations`, MCP tokens | `integrations.html` | **Built** (HAL-3466), read-only: `{ mcp: { endpoint, keyCount, agentCount, lastUsedAt, keys: [{ id, name, prefix, scopes, lastUsedAt, createdAt, agent: { id, name, mailboxId, address } \| null }] \| null }, webhooks: { count, enabled, paused, failing, deadLetters, held, failingEndpoints: [{ id, url, deadLetters, lastFailureAt, lastSuccessAt }] }, hermes: { connected, lane, mailboxes, allMailboxes, since, available }, siblings: [{ app: "support-inbox", name, via, connected, keyId, lastUsedAt }] }`. Needs `settings.read`; `mcp.keys` and `siblings[].keyId` are null without `keys.manage`. MCP keys are made and revoked on `/v1/api-keys` (`purpose: mcp`) and `/v1/agents`, not here. `hermes` is `{ connected, lane, mailboxes, allMailboxes, since, available }`, from the mail-events lane (HAL-3306, `GET/PUT /v1/settings/mail-events`, `docs/mail-events.md`). Support Inbox is recognised by an MCP key whose name contains "Support Inbox". |
| 4.11 | Workspace export: everything in one signed download | `import-export.html`, `export-ready.html` | **Partly built:** `POST /v1/exports`, `GET /v1/exports`, `GET /v1/exports/{id}` (new in 47426a9) export **contacts** only: `{ kind: "contacts", filter?, fields? }` → `{ id, kind, status: "running"\|"completed"\|"failed", rows, fields, filename, url, error, createdAt, finishedAt }`. Per-mailbox export (`POST /v1/mailboxes/{id}/exports`) is built too. **Gap:** `kind` for mail, templates and settings, and an "everything" export that bundles them: `{ kind: "workspace" }` → `parts: [{ kind, format, items, bytes }]`. **Built (HAL-3451):** `POST /v1/exports { kind: "workspace" }` (admin; no filters) runs WorkspaceExportWorkflow. `GET /v1/exports/{id}` → `parts: [{ kind: mail\|contacts\|templates\|lists\|settings\|audit\|manifest, format, filename, items, bytes, status, error, mailboxId, url }]`, each link good for a day, and `url` is the manifest. Mail is one part per mailbox holding mail (its own mbox export). Settings leave out webhook secrets and key hashes; automation steps' secrets are redacted. An `export_ready` alert fires when it's done ("finished with gaps" when a part failed). |
| 4.12 | `GET /v1/audit` with filters and CSV | `audit*.html` | `{ entries: [{ id, at, actor: { type: "user"\|"key"\|"system", id, name }, via: "web"\|"api"\|"mcp", ip, location, action, target: { type, id, label }, before: object\|null, after: object\|null }], nextCursor }`; query `actor=`, `action=`, `target=`, `from=`, `to=`, `format=csv`. **Built (HAL-3376):** `GET /v1/audit` with those filters (`action` exact, or a family ending in `.`), `cursor`/`limit`, and `format=csv` (up to 10,000 rows, `x-truncated`, formula-safe cells). Admin scope. `actor.type` is `key`, `root` or `system`; `via` comes from the key's purpose (`api`\|`mcp`); `ip` and `location` aren't recorded, so they're always null. `target.label` is the thing's current name. |
| 4.13 | `DELETE /v1/workspace` | `danger-delete-workspace.html` | **Built**, HAL-3448: owner only (the admin key while unclaimed); `{ confirm }` must match `GET /v1/me` `workspace.name` exactly, else `400 field: "confirm"`. `202 { requestedAt, requestedBy, deletesAt, exportId }`, 7 days out, with a workspace export started. Meanwhile sending is `409 { reason: "workspace-deleting", deletesAt }`, receiving goes on, every response carries `x-workspace-deleting`, and `POST /v1/workspace/restore` calls it off. `GET /v1/workspace/deletion` → `{ status: none\|scheduled\|deleting\|deleted, deletion, files }`; after the end the owner gets fresh links to the kept export. |
| 4.14 | Delete mailbox guard | `danger-delete-mailbox.html` | `DELETE /v1/mailboxes/{id}` returns `409 Conflict` with a message today. Proposed: `reason: "no-recent-export"\|"alias-targets"`, `aliasIds: string[]`, so the sheet can say which aliases break. **Built (HAL-3376):** the 409 carries `reason: "alias-targets"` with `aliasIds`, `"no-recent-export"` (no complete export holds at least as many messages as the mailbox does now, so one taken before newer mail doesn't count), or `"catch-all-keeps"`. |

**Used as-is:** `GET /v1/sending/governor` and `GET/PUT /v1/settings/sending` (every field, including `503 GovernorUnreachable`), `GET /v1/mailboxes`, `PATCH /v1/mailboxes/{id}` (`signature`, `autoReply.{ enabled, subject, body, startsAt, endsAt }`, `forwarding.{ enabled, to, keepCopy }`), the rules CRUD and `PUT …/rules/order`, `GET /v1/imports` (contact imports, new since the vendored copy) and `GET /v1/mailboxes/{id}/imports`.

## 5. Public pages

| # | Endpoint / field | Screens | Proposed shape |
|---|---|---|---|
| 5.1 | **Built:** `GET /u/:token`, `POST /u/:token` (HAL-3297) | `email-preferences-*.html` | One page for unsubscribe and the preference centre; there is no separate `/p` route. Page data (`preferences()` in `unsubscribe-domain.ts`): `{ email (masked, "ng•••••••@gmail.com"), unsubscribedFromAll, blocked, focusTopicId, topics: [{ id, name, description, subscribed }] (live topics, by name), brand }`, plus a `notice` after a POST ("Your choices are saved." or "You're unsubscribed from everything. You won't get any more of these emails."). Actions: `action=save` with `topic=` per ticked box, or `action=all`. `List-Unsubscribe=One-Click` (RFC 8058) and the mailto unsubscribe act at once with no page (2xx). A bad token renders "This link isn't valid" unbranded with `400`. **Opening the link doesn't unsubscribe**: the email's topic is outlined and stays ticked until Save. Every state is designed: from an email (focused), saved, unsubscribed from everything, blocked, no lists, link not valid. |
| 5.2 | **Built** (HAL-3377): the proposed additions to `/u` | `email-preferences-proposals-brand`, `-resubscribe-proposal-default`, `-invalid-request-proposal` | (a) **Focus:** the line under the heading names the list the email came from ("This email came from **News**"), and that topic carries a "From this email" tag. (b) **Resubscribe:** `action=resubscribe` within 24 hours of "unsubscribe from everything" puts back exactly the topics it removed, and the contact's status. The removed topics ride on the `email.unsubscribed` event as `restore`, and the undo writes `email.resubscribed`. Past the window, the page says to tick lists instead. (c) **Fresh link:** the link-not-valid page has an email field posting to `POST /p/request { email }`. It mails a new `/u` link from the person's list sender, at most one a contact an hour, rate limited by IP, with the same page either way. (d) `unsubscribedFromAll` shows as an info notice above the list, with the undo while it's open. |
| 5.3 | **Built:** `GET /c/:token` (since 11a2439; branded and redirecting, HAL-3377) | `confirm-*.html` | The page wears the workspace brand (or Flareyard's look) with a success notice. A link from a signup form follows the form's `redirectUrl` after 3 seconds, through a `Refresh` header and a meta refresh (no JavaScript), with a Continue button. Confirm tokens now carry `formId`; older links still confirm, without the redirect. Statuses: 200 subscribed, 200 "We can't send to this address", 410 expired, 400 not valid, 503 no consent key. **Remaining:** `POST /c/resend` stays proposed. |
| 5.4 | **Built:** `GET /f/:formId`, `POST /v1/forms/:id/submit`, Turnstile, `GET /v1/forms/{id}/embed` (HAL-3317) | `signup-*.html` | Page (`forms-page.ts`): logo or brand name, the form's `name` and `description`, its live topics read-only ("You'll get all of these"; visitors don't pick), Email (required), Name (optional), each custom field in `fields` labelled from its name with autofill hints, a honeypot (`_hp`), the Turnstile widget when `turnstileSiteKey` is set, "Sign up", and the unsubscribe fine print. Submit answers HTML for a browser and JSON for a script: 200 "Check your inbox" (`status: confirm`, double opt-in pending), 200 "You're subscribed" (`subscribed`, the same page for an address that was already on the list, by design), 303 to `redirectUrl` when set, 400 "Please try again" when Turnstile fails (closed: no token, rejected, or Cloudflare unreachable), 400 "Email needed" or "Check your email address", 429 "Too many tries", and 404 "Form not found" for an unknown *or archived* form. A filled honeypot gets the confirm page and nothing is written. **Remaining gaps (proposed, framed in the screens):** (a) re-render the form with the error and what was typed (`renderFormPage` already takes `error`; the handler never passes it); (b) a path with JavaScript off, since a form with a site key then always fails closed. **Inline errors (HAL-3443):** a failed browser submit re-renders the form with the error under its field (`aria-invalid`, `aria-describedby`, focus moved there), every value kept, and a summary line on top. A missing topic choice errors on the picker; a rate limit or a failed Turnstile check errors on the form as a whole. JSON callers still get `{ error, field }`. |
| 5.5 | **Built** (HAL-3377): `GET /v/:token` | `view-*.html` | Every campaign mail ends with "View this email in your browser" (in its text part too) unless the content places `{{ view_url }}` itself. The signed link opens the stored copy that recipient got, with the open pixel removed so reading it isn't counted, and tracked links kept. A test send, or a recipient not sent yet, gets a fresh render. The page sends no scripts (CSP `default-src 'none'`). Click tracking and the link checks leave the view link alone, like `/u`. 400 for a bad link, 404 for a deleted campaign. |

## 6. Not API, but owed

| # | Item | Where | Note |
|---|---|---|---|
| 6.1 | Coursified's brand for the "customised" public pages | `screens/ops/assets/coursified/` | Logo (`coursified-mark.svg`) and fonts (Outfit 500, Figtree 400/600, both OFL) are copied from the Coursified repo (`~/dev/coursified/brand`, `DESIGN.md`): `colors.indigo` `#2E5BFF` (accent), `fg` `#0E0E0E`, `bg` `#F4F4F2`, `muted` `#71717A`, `border` `#E4E4E7`, `surface` `#EEF2FF`, `white` `#FFFFFF`. In production these come from `GET /v1/settings/brand`, with `fontsHref` loading the fonts. Coursified's own design contract says its brand is light-only, so its public pages don't follow the reader's dark mode. |
| 6.2 | **Built** (HAL-3377): `/u` aligned with the design | `email-preferences-*.html` | One shell for every public page (`src/public/shell.ts`). Without a brand it uses Flareyard's tokens: Funnel Display and Sans from Google Fonts, gray-1000 actions, ember focus rings, and the light and dark values from `tokens.css` under `prefers-color-scheme`. With a brand it uses the brand's colours, logo, `fontsHref` and `fonts.display`/`fonts.body`, with dark neutrals around the brand accent. The card, the "From this email" tag, success, warning, danger and info notices, and a footer with the compliance postal address, the new `privacyUrl` and the site link. The responsive audit (`bun tools/public/preview.ts`, 22 states × 2 looks) passes at every device size: no overflow, no crushed text, no target under 24px (44px on touch). |
| 6.3 | The Turnstile widget | `signup-*.html` | Drawn as a labelled placeholder box: the real widget (`data-size="flexible"`) is a Cloudflare iframe that can't render offline. |
| 6.4 | **Built** (HAL-3377): brand the public result pages | `confirm-brand.html`, `signup-submitted-brand.html` | Every `/c` and `/f` submit result renders through the same shell as `/u`, with a coloured notice for its outcome. |
