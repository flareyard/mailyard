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
- The public route `/v/:token` (view in browser). `/u/:token`, `/c/:token` and `/f/:formId` are built.
- Passing the brand through to the confirm and after-submit pages, which are unbranded today.
- A whole-workspace export. `/v1/exports` covers contacts only.
- Aligning the live `/u` page with the Flareyard tokens and fonts (GAPS-ops "Not API, but owed").

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
| 1.1 | `GET /v1/me` | **Proposal.** HAL-3307 names it, but the contract says it “has no fixed shape” | Sidebar, avatar menu, workspace switcher, every role-dependent control | Following the contract’s outline `{ user, workspace, role, permissions }`: `{ user: { id, name, email }, workspace: { id, name, host, claimed }, role: "owner"\|"admin"\|"sender"\|"agent"\|"viewer"\|null, via: "session-flareyard"\|"session-key"\|"admin-key", scopes: ("read"\|"send"\|"track"\|"admin")[], permissions: string[], workspaces: [{ name, host }] }`. `role` is null until roles exist (1.11). |
| 1.2 | `POST /v1/session` `{ key }` → HTTP-only cookie | **Planned**, HAL-3307 (“an API key … held in an HTTP-only cookie”). Shape is a proposal. | `auth/sign-in*.html` | 200: `Set-Cookie: my_session=…; HttpOnly; Secure; SameSite=Lax; Path=/`, body as 1.1. |
| 1.3 | Flareyard platform handoff | **Planned**, HAL-3307 (“the Flareyard platform hands off a session”). Endpoints are a proposal. | `sign-in`, `sign-in-flareyard-expired`, `signed-out` | `GET /v1/session/flareyard/start` → redirect with PKCE. `GET /v1/session/flareyard/callback?code=&state=` sets the cookie as 1.2. An expired platform session redirects to `/sign-in?error=flareyard_session_expired`. |
| 1.4 | Distinct key-refusal reasons | **Proposal** | `sign-in-invalid-key`, `-revoked-key`, `-public-key`, `-insufficient-scope` | `401 { _tag: "Unauthorized", reason: "format"\|"unknown"\|"revoked", revokedAt?, revokedBy? }` and `403 { _tag: "Forbidden", reason: "public-key"\|"insufficient-scope", scopes, required, keyName? }`. **Today** `authenticate` answers “Unknown or revoked key.” for both cases, and an admin-key typo gets “Keys start with sk_ (secret) or pk_ (public).” |
| 1.5 | Minimum scope to open the app | **Proposal** | `sign-in-insufficient-scope` | A session needs `read`. A `send`-only key is refused with 1.4. |
| 1.6 | Rate limit on key sign-in | **Proposal** | `sign-in-rate-limited` | `429 { _tag: "RateLimited", retryAfter }` plus `Retry-After`. The 10-tries-a-minute figure on screen is our proposal. |
| 1.7 | Cookie accepted by `ApiKeyAuth` | **Planned**, HAL-3307 | All app screens | Accept the session cookie alongside Bearer. Protect cookie-authenticated writes with CSRF defences (`SameSite=Lax` + `Origin` check). |
| 1.8 | Sign-out: `DELETE /v1/session` | **Proposal** (contract: “not filed”) | Avatar menu, `signed-out`, `invite-wrong-account` | 204, clears the cookie. |
| 1.9 | Session expiry signal | **Proposal** (contract: “not filed”) | `auth/session-expired.html` | `401 { _tag: "Unauthorized", reason: "session-expired" }` on any call opens the re-auth sheet; local drafts are kept. |
| 1.10 | Claim the workspace: `POST /v1/workspace/claim` | **Proposal** | `claim-workspace`, `claim-already-claimed` | `{ workspaceName, name, email }`, admin-key session only. `409 { claimedBy, claimedAt }`. |
| 1.11 | Roles: owner, admin, sender, agent, viewer | **Proposal** (contract: “not filed”) | `states/overview-viewer.html`, `states/no-permission.html`, every disabled-with-reason control | Users plus roles, checked per endpoint. Each refusal says who can: `403 { reason: "role", allowedRoles }`. Until roles exist, the app is the owner view, and the avatar menu says “Roles are a proposal; today access comes from your key’s scopes.” |
| 1.12 | Invites: `GET /v1/invites/{token}`, `POST …/accept`, `GET/POST/DELETE /v1/invites` | **Proposal** (contract: “not filed”) | `invite-valid`, `-expired`, `-used`, `-wrong-account` | `{ token, status: "valid"\|"expired"\|"used", workspace: { name, host }, inviter: { name, email }, email, role, mailboxes, expiresAt, acceptedAt, signedInAs? }`. Accept: `409 { reason: "email-mismatch" }` or `410 { reason: "expired"\|"used" }`. |
| 1.13 | Members: `GET /v1/members` | **Proposal** | Settings run | Listed so the Settings run inherits it. |
| — | Magic links, passkeys, Cloudflare Access | **Proposal** (contract §1) | Not designed in this run | The sign-in card has room for a third method under “or”. |

## 2. Shell

| # | Item | Status | Screens | Proposed shape / note |
|---|---|---|---|---|
| 2.1 | Global search: `GET /v1/search?q=&types=` | **Proposal** (contract: not built) | `shell/command-palette*.html` (footer pill “Search API proposed”) | `{ query, results: [{ type: "thread"\|"contact"\|"campaign"\|"template"\|"mailbox"\|"domain", id, title, subtitle, url, mailboxId? }] }`. Screens and actions resolve on the client today; `GET /v1/mailboxes/{id}/search` is built and covers one mailbox. |
| 2.2 | Activity feed: `GET /v1/activity` | **Proposal** (contract: not built) | Overview → Activity | `{ events: [{ id, kind, text, subject: { type, id, label }, actor, at }], nextCursor }`. |
| 2.3 | A workspace-wide socket | **Proposal** (contract: not built) | — | **No screen depends on it any more.** Mailbox unread counts come from the built per-mailbox socket (2.4). Alerts, health, usage, campaign progress and first-run checks refresh on focus, or are polled while a step is open. A workspace socket would replace polling for alerts, activity and campaign progress. |
| 2.4 | Per-mailbox socket: `GET /v1/mailboxes/{id}/live` | **Built** | Sidebar and bottom-bar unread counts | Events: `hello`, `counts`, `message.added`, `threads.changed`, `labels.changed`, `drafts.changed`, `draft.due`, `error`. The client sends `"ping"` or `{"type":"counts"}`. See HANDOFF §5. |
| 2.5 | Alert `kind` as a fixed set | **Proposal** (`/v1/alerts` and `/resolve` are built; `kind` is still a free `string` at 9428241) | `shell/alerts-drawer.html` | **Raised by the backend today, measured in source:** `delivery_events_missing` (HAL-3341, critical) and `campaign.paused` (the governor’s auto-pause, critical). The drawer shows those as-is. The spec’s other kinds carry a “Proposed kind” pill there: `dns_drift`, `reputation_warning`, `reputation_at_risk`, `bounce_spike`, `complaint_spike`, `quota_80`, `quota_100`, `webhook_dead_letter`, `import_failed`, `domain_activated`. Proposal: publish the kinds as a literal union. |
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
| 3.1 | `GET /v1/mail/attention` | **Proposal** (contract: not built) | Needs you | `{ replyTargetHours, unread: [{ mailboxId, address, count }], waitingForReply, snoozedReturningToday, assignedToMe }`. |
| 3.2 | `GET /v1/stats/inbound?range=` | **Proposal** (contract: not built) | Inbound | `{ range, received, rejected: { total, dmarcFail, rbl }, spam, byMailbox: [{ mailboxId, address, received }] }`. `GET /v1/inbound` is built but has no aggregates. |
| 3.3 | `GET /v1/stats/audience?range=` | **Proposal** (contract: not built) | Audience | `{ range, total, byStatus: { subscribed, unconfirmed, unsubscribed, bounced, complained, suppressed }, new, unsubscribed, suppressed, totalByDay }`. |
| 3.4 | `changedAt` on each domain check | **Proposal** | Drift banner, health strip | `checks[].changedAt: number`. |
| 3.5 | `zoneStatus` and `nameservers` on a domain | **Proposal** | Health strip DNS chip, first-run step 1 | `zoneStatus: "active"\|"pending"\|"moved"\|null`. |
| 3.6 | `GET /v1/automations/summary` | **Planned**, M5 (HAL-3299–3301) | Going out now → Automations running | `{ range, live, automations: [{ id, name, status, activeRuns, enteredToday, failuresToday }] }`. |
| 3.7 | `ratePerHour` on `/v1/campaigns/{id}/pace` | **Proposal** | Going out now (“Pace 160/h”) | `ratePerHour: number\|null`, null while paused. |
| 3.8 | Typed `byStream` keys | **Proposal** | Volume by stream | `{ transactional, campaign, automation, mailbox }`, the governor’s four names. |
| 3.9 | Hourly buckets for 24 h | **Proposal** | Volume at 24 h | `by=hour` → `hours: [{ hour, byStream }]`. The 24 h screen shows one split bar and says so. |

## 4. First run

| # | Item | Status | Step | Proposed shape / note |
|---|---|---|---|---|
| 4.1 | `GET /v1/domains/candidates` | **Proposal** | 1. Add a domain | `{ candidates: [{ name, zoneId, zoneStatus: "active"\|"pending"\|"none", nameservers, currentNameservers?, registrar, existingMx, inWorkspace }] }`. |
| 4.2 | Turning mail on | **Built**, via `PATCH /v1/domains/{id} { receiving, sending }`, `GET /v1/domains/{id}` checks and `POST …/recheck` | 2. Turn on mail | The spec’s `/enable` and `/checks` paths aren’t needed. The screen polls while open. A `"pending"` value for `checks[].status` would let “checking” come from the API rather than the client: **Proposal**. |
| 4.3 | Routing-rule conflict on mailbox create | **Proposal** | 3. First mailbox, failing | `409 { reason: "routing-rule-exists", ruleDestination }` and `replaceRoutingRule: true` on `POST /v1/mailboxes` (built). |
| 4.4 | `POST /v1/test-send` | **Proposal** | 4. Send a test | `{ from, to }` → `{ messageId }`, then a polled result with `authentication: { spf, dkim, dmarc, dmarcPolicy }` and `deliveryTimeMs`. |
| 4.5 | `GET /v1/verified-addresses` | **Proposal** | 4. Send a test | `{ addresses: [{ email, verifiedAt }] }`. |
| 4.6 | `POST /v1/mailboxes/{id}/imports/probe` | **Proposal** | 5. Old mail, folder list | `{ host, folders: [{ name, messages, suggestedFolder }] }`. The import itself (`/v1/mailboxes/{id}/imports`) is **built**. |
| 4.7 | IMAP import `ratePerMinute`, `etaAt` | **Proposal**, still absent at 9428241 | 5. Old mail, in progress | Not covered by the contact import below: this row is the mailbox (IMAP) import, `/v1/mailboxes/{id}/imports`. Without these fields the screen shows counts and no ETA. |
| 4.8 | Contact CSV import | **Built**, HAL-3291 (PR #28): `POST /v1/imports/contacts`, `GET /v1/imports`, `GET /v1/imports/{id}` | 6. Contacts (`first-run/csv-empty`, `-map`, `-progress`, `-pass`, `-fail`) | The step now follows the built flow and field names exactly. The file is read in the browser for its header and row count, uploaded, then imported with `{ uploadId, mapping, topicIds, onConflict: "update"\|"skip", defaultStatus }`. Progress is polled from `{ status: queued\|running\|completed\|failed, headers, rows, created, updated, skipped, invalid, duplicates, suppressed, errors: [{ line, message }], error }`. What the schema still lacks is listed in 4.9–4.13. |
| 4.9 | `POST /v1/uploads?filename=` in the OpenAPI | **Built, undocumented**: a raw route (`src/workers/uploads.ts`), admin scope, 50 MiB, `201 { id, filename, mimeType, size, sha256, createdAt }` | 6. Contacts | Proposal: describe it in the OpenAPI so the generated client (HAL-3142) gets it. |
| 4.10 | Consent attestation | **Proposal** | 6. Contacts, mapping | The spec asks for a consent checkbox. `POST /v1/imports/contacts` has no field for it, so today it lives only in the screen, which marks it “Consent not recorded yet”. Proposed: `consent: { attestedBy, attestedAt, statement }`, stored on the import and in the audit log. |
| 4.11 | Total rows, for a progress bar | **Proposal** | 6. Contacts, in progress | The import learns its total only at the end of the file. The screen counts rows in the browser before upload (“of about 12,406”). Proposed: `bytesRead` with the upload’s `size`, or `rowsTotal`. |
| 4.12 | Cancel a contact import | **Proposal** | 6. Contacts, in progress | There is no cancel for `/v1/imports/{id}` (the IMAP import has one), so the in-progress screen offers no Cancel. Proposed: `POST /v1/imports/{id}/cancel`. |
| 4.13 | More than 100 row errors | **Proposal** | 6. Contacts, passing | `errors` keeps the first 100 (`MAX_ERRORS`). The screen says so and builds its download from those. Proposed: `GET /v1/imports/{id}/errors.csv` with every rejected row. The spec’s third dedupe policy, “overwrite”, isn’t offered (`onConflict` is `update` or `skip`), and the designs drop it rather than ask for it. |

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
| M1.1 | A **folder enum** with Starred, Assigned to me, Scheduled and All mail | `folders`, `assigned`, `starred`, `scheduled`, `all-mail` | The `folder` query takes `inbox\|archive\|sent\|spam\|trash\|snoozed` only, and `drafts` appears in `/folders` but not in `/threads`. The designs map them like this: Starred is `?starred=true`, Assigned to me is `?assignee=<me>`, Scheduled is `GET …/drafts?status=scheduled`, and Drafts is `…/drafts?status=draft`. **All mail has no mapping.** Proposed: no `folder` means every folder except spam and trash. Confirm or add `folder=all`. |
| M1.2 | Counts for the virtual folders | Folder pane on every screen | `/folders` counts only real folders. Proposed: add `views: { starred, assignedToMe, scheduled, all }` (threads) to `GET …/folders`. `assignedToMe` needs to know who “me” is (GAPS 1.1 `/v1/me`). |
| M1.3 | Who an assignee is | Rows, reader, assign picker | `thread.assignee` is a free `string`, and mailbox members are API keys (`apiKeyId`, `name`). Proposed: `assignee: { id, name } \| null`, where `id` is a user id once people exist (GAPS 1.13), and `bulk { action: "assign", assignee: userId }`. Until then the screens show the name string. |
| M1.4 | Spam score on the list | `spam` rows (“Score 9.8”) | `spamScore` lives on messages, not threads, so the list would need one call per row. Proposed: `thread.spamScore: number \| null` (the latest message's) when `folder=spam`. |
| M1.5 | A thread's scheduled reply | Inbox row chip “Reply sends Sun 08:00 UTC” | Proposed: `thread.scheduledSendAt: number \| null` (the earliest scheduled draft on the thread), so the list doesn't need `…/drafts` too. |
| M1.6 | Total for “1–14 of 312” | List toolbar | `nextCursor` only. The total comes from `/folders` `threads`, which works for real folders; labels and filters have no total. Proposed: `total?: number` on `/threads` when cheap, otherwise the toolbar shows “14 shown”. |
| M1.7 | Drag a thread onto a label | Folder pane `.is-drop` | Not a gap: `bulk { action: "label", labelId }`. |

## M2. Search

| # | Endpoint / field | Screens | Proposed shape |
|---|---|---|---|
| M2.1 | **Operator support** in `q` | `search`, `search-operators`, `search-empty` | `GET …/search?q=` exists, but its description doesn't say which operators the backend parses. The designs use `from: to: subject: has:attachment label: is:unread is:starred before: after: in:`. Confirm each, or return `parsed: { operators: [{ key, value }], terms: string[] }` so the chips match what the server applied. |
| M2.2 | Highlights | Results | Not a gap: the excerpt marks matches with `\u0002…\u0003`. The screens render those as `<mark class="hl">`. Subjects aren't highlighted; proposed: `subjectHighlighted` with the same marks. |
| M2.3 | `GET /v1/search/mail?q=` (all mailboxes) | `search-all` | Not built. `{ query, groups: [{ mailboxId, address, hits: SearchHit[], threads: Thread[] }] }`, limited to the mailboxes the caller can read. |
| M2.4 | Smart folders | “Save as smart folder” | `POST /v1/mailboxes/{id}/smart-folders { name, q }` → `{ id, name, q, threads, unreadThreads }`, listed in `/folders` as `smartFolders`. |
| M2.5 | Sort | “newest first” | The spec says results are ranked by recency, but `hits[].rank` is a text-match rank. Proposed: `sort=recent\|relevance`, defaulting to `recent`. |

## M3. Labels

| # | Endpoint / field | Screens | Proposed shape |
|---|---|---|---|
| M3.1 | `label.color` values | `labels-manage`, every tag | `color` is a free `string \| null`. Brand rules keep green, amber and red for pass, warn and fail, so the designs offer six categorical swatches: `"blue" \| "navy" \| "sky" \| "teal" \| "pine" \| "slate"` (`null` = none). Make it that literal union, so another client can't store `#f38020`. |

## M4. Reader

| # | Endpoint / field | Screens | Proposed shape |
|---|---|---|---|
| M4.1 | Full headers | `thread-details` → Headers | Messages carry `messageId`, `inReplyTo`, `references`, envelope, `via` and `auth`, but no header list. Proposed: `GET …/messages/{id}?include=headers` → `headers: [{ name, value }]` in order. The fallback is to parse `rawUrl` on the client. |
| M4.2 | **ARC** | Authentication line, details | `auth` has `spf`, `dmarc` and `dkim[]`. Add `arc: { result: "pass"\|"fail"\|"none", instance: number, sealer: string \| null } \| null`. `thread-auth-fail` depends on it: DKIM broke at a forwarder and ARC passed. |
| M4.3 | Spam threshold | Details → Spam score | Scores and reasons exist, but the cut-off doesn't, so the drawer says “Higher scores are more likely spam” without a line. Proposed: `spamThreshold: number` on `GET /v1/mailboxes/{id}`. |
| M4.4 | **Delivery status of our sent replies** | `thread`, `thread-delivery`, `sent` | Sent mailbox messages don't link to the message log, where `/v1/messages/{id}` has `status`, `bounceType`, `attempts` and `smtpResponse`. Proposed: `message.delivery: [{ recipient, logId, status: "queued"\|"sent"\|"delivered"\|"deferred"\|"bounced"\|"failed"\|"rejected", at, attempts, nextAttemptAt?, smtpResponse }]` on `folder: "sent"` messages, pushed through `threads.changed`. |
| M4.5 | Internal notes | `thread`, note composer (N) | Not in the API. `GET` comes with the thread as `notes: [{ id, author: { id, name }, body, createdAt }]`. `POST /v1/mailboxes/{id}/threads/{threadId}/notes { body }` and `DELETE …/notes/{noteId}`. Members only, never sent. |
| M4.6 | AI summary | `thread` (“when it's on”) | `POST /v1/mailboxes/{id}/threads/{threadId}/summary` → `{ threadId, text, provider, model, generatedAt }`, cached until a new message arrives. Gated by `GET /v1/settings/ai` (spec; not built). |
| M4.7 | Calendar invites | `thread-invite` | An attachment with `mimeType: text/calendar` exists, but nothing is parsed. Proposed: `message.invite: { uid, method, summary, start, end, location, organizer, attendees: [{ address, partstat }] } \| null`. RSVP: `POST …/messages/{id}/rsvp { response: "accepted"\|"tentative"\|"declined" }` sends the iTIP reply from the mailbox (it counts as one send). |
| M4.8 | Remote images per sender | `remote-bar` “Always show from gmail.com” | The block itself is client-side (frame CSP `img-src data: cid:`). The preference needs storing: `POST /v1/mailboxes/{id}/senders { value, list: "images" }`, or a separate `imageSenders` list. |
| M4.9 | Attachment URLs | Previews, download | Not a gap: `attachmentUrls` on GET message. Confirm they're signed and how long they last (the lightbox opens them directly). The spec's `GET /v1/attachments/:aid` isn't needed. |
| M4.10 | Thread position “1 of 312” | Reader bar | Client-side from the loaded list. Not needed from the API. |

## M5. Composer

| # | Endpoint / field | Screens | Proposed shape |
|---|---|---|---|
| M5.1 | **`POST /v1/uploads`** | `compose-attachments`, attach anywhere | Not built, yet drafts take `attachments: [{ key, filename, mimeType, size }]`, so something must mint `key`. Proposed: `POST /v1/uploads { filename, mimeType, size, mailboxId }` → `{ key, uploadUrl (signed PUT), expiresAt }`. |
| M5.2 | Over the 5 MiB budget → R2 link | `compose-attachments` | Proposed: on send, any attachment past the budget becomes `{ key, link: true }`, and the server inserts a signed download link valid for 7 days. Store `draft.attachments[].delivery: "inline"\|"link"` so the composer can say which. The 7 days is a proposal. |
| M5.3 | Undo send | `compose-undo` | Not a gap. `POST …/drafts/{id}/send { undoSeconds: 10 }` → `{ sendAt, undoUntil }`, and Undo is `POST …/drafts/{id}/cancel`. The spec's `DELETE /v1/sends/:id` isn't needed. |
| M5.4 | **Why a send is refused** | `compose-blocked-quota`, `-reputation`, `-domain`, and Drafts' “Not sent” | Today a draft gets `lastError: string`. Proposed: a typed refusal on send, `409 { _tag: "SendBlocked", reason: "quota_exhausted"\|"reputation_at_risk"\|"domain_unhealthy", resetsAt?, suspendsAt?, domainId?, checkId? }`, mirrored as `draft.blockedReason`. **Policy question:** does the API hold one-to-one replies while reputation is at risk? The designs assume yes. If not, the reputation state becomes a warning with Send enabled. |
| M5.5 | Queue for the reset | Quota state “Queue for 00:00 UTC” | Not a gap: `send { sendAt: usage.today.resetsAt }`. |
| M5.6 | Recipient suggestions | `compose-new` | `GET /v1/contacts?q=` exists but holds only audience contacts. “People you've written to” needs `GET /v1/mailboxes/{id}/correspondents?q=` → `[{ name, address, lastAt }]`. |
| M5.7 | Templates in the composer | “Template” | `GET /v1/templates` exists. Confirm a mailbox draft can be rendered from one (`POST /v1/templates/{id}/render` exists). |
| M5.8 | AI draft | “Draft with AI” | `POST /v1/ai/draft { mailboxId, threadId?, instruction }` → `{ bodyText, bodyHtml }`. Gated by `/v1/settings/ai`. |
| M5.9 | Signature per identity | Composer footer | `mailbox.signature` exists, but aliases (`via: "alias"`) have none. Proposed: identities include `signature`. |
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
| M7.1 | Speed and ETA | `import-running`, folder-pane card | Same as GAPS 4.7: `ratePerMinute`, `etaAt`. |
| M7.2 | Pause and resume | `import-running` | Only `cancel` exists. `POST …/imports/{id}/pause` and `/resume`, plus `status: "paused"`. |
| M7.3 | Retry the failed messages | `import-running`, `import-failed` | `POST …/imports/{id}/retry-failed` → a new import scoped to the failed UIDs. Needs `failedUids` or a reason per failure; today there are counts only. |
| M7.4 | The last error per folder | “Last error: 3 messages over 25 MiB” | `error` is import-level. Add `folders[].lastError: string \| null`. |
| M7.5 | Progress live | Card and page | `ws /v1/mailboxes/{id}/live` has no import event. Add `import.progress { importId, totals, folders }`. Until then, poll `GET …/imports/{id}`. |
| M7.6 | Catch-up after the MX switch | `import-running` second panel | Not a gap: `mode: "catchup"`. Proposed: link the two with `catchupOf: importId`, and give `since` so the panel can say “arrived since 17:22 UTC”. |
| M7.7 | Export link lifetime | `export` | `downloads.mbox\|zip` are signed URLs. Return `downloadsExpireAt` (the designs say 24 hours, which is a proposal). |

## M8. Live, offline, push

| # | Endpoint / field | Screens | Proposed shape |
|---|---|---|---|
| M8.1 | Live new mail | `live-new-mail` | Not a gap: `message.added` and `counts` on `ws /v1/mailboxes/:id/live`. Confirm that `message.added` carries the thread summary (the `Thread` shape) so the row renders without a fetch. |
| M8.2 | Reconnect | `reconnecting` | Client-side (backoff, “try 3 in 8 s”). Proposed: `hello { since }` replies with what changed since the last event id, so nothing is missed. |
| M8.3 | Offline queue | `offline` | Client-side: drafts kept in IndexedDB, and on reconnect `POST …/drafts` then `…/send`. Needs an `idempotency-key` header on draft create and send (today only `POST /v1/send` and `/v1/track` take one). |
| M8.4 | **Web Push** | `push-enable`, `push-settings` | Not built. `GET /v1/push/vapid-key` → `{ publicKey }`. `POST /v1/push/subscriptions { endpoint, keys: { p256dh, auth }, device }` → `{ id }`. `DELETE /v1/push/subscriptions/{id}`. `GET/PUT /v1/push/preferences` → `{ mailboxes: [{ mailboxId, notify: "all"\|"assigned"\|"off" }], alerts: boolean, hideContent: boolean }`. Sends on `message.added` and on assign. |

## M9. Roles

| # | Endpoint / field | Screens | Proposed shape |
|---|---|---|---|
| M9.1 | Which mailboxes a person can read | `agent`, switcher | GAPS 1.1 `me.mailboxes`. An agent sees only the shared mailboxes they're given. |
| M9.2 | Mailbox-level viewer | `mailbox-readonly` | Exists as `members[].role: "viewer"` for API keys. The 403 on a write should name who can: `{ _tag: "Forbidden", reason: "mailbox_role", role: "viewer", owners: [name] }`. |
| M9.3 | Workspace viewer opening Mail | `viewer` | The `403` should say `reason: "role"` (GAPS 1.13). |

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

- `GET /v1/campaigns/{id}/report`, `GET /v1/campaigns/{id}/recipients` and `POST /v1/campaigns/{id}/resend-non-openers`: PR #25, **Built**. The report screens use their live schema; open questions are A7.5 and A7.7; A7.6 is answered.
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
| A1.2 | Field | Multi-value `engagement` and `status` | Filter chips (“Engagement is active, cooling”) | Accept comma lists: `status=subscribed,unconfirmed`. |
| A1.3 | Ahead | `GET /v1/contact-fields` | Column picker, contact profile (field types), import mapping, segment field rules | `{ fields: [{ key, label, type: "text"\|"number"\|"date"\|"boolean", createdAt, usedBy: number }] }`. `fields` on a contact is typed `{}` today, so the UI can’t tell a number from text, and the column picker can’t list custom fields without scanning contacts. |
| A1.4 | Field | When and how each topic subscription changed, on the contact | `contact.html` → Topics and consent | `topics[]` gains `changedAt: number`, `source: string` (`form:frm_…`, `import:imp_…`, `api`, `double-opt-in`, `preference-page`, `one-click`), `confirmedAt: number\|null`. The timeline’s `subscription` items already carry `source`; the contact doesn’t, so the panel would need the whole timeline to render one line. |
| A1.5 | Field | Timeline kinds and message events | `contact.html` → Timeline | Live kinds are `event`, `message` and `subscription`. The spec also wants opens and clicks per message, replies, automation runs and consent records. Proposed: `message.events: [{ type: "delivered"\|"deferred"\|"bounced"\|"opened"\|"clicked"\|"complained", at, machine?: boolean, url?: string }]`, plus three new kinds: `{ kind: "reply", mailboxId, threadId, subject }`, `{ kind: "automation", automationId, automation, version, status, step }` and `{ kind: "consent", topicId, method, formId?, ip, userAgent }`. Add a `kind=` filter for the All/Email/Events/Topics/Automations control. |
| A1.6 | Field | Suppression on the contact | `contact.html`, `contact-suppressed.html` | `suppression: { reason: "hard_bounce"\|"complaint"\|"unsubscribe"\|"manual", source: "cloudflare"\|"bounce-handler"\|"one-click"\|"manual", detail: string\|null, createdAt, cloudflare: "in-sync"\|"missing"\|"not-applicable" } \| null`. `status: "suppressed"` alone can’t say why or from where; `GET /v1/contacts/{id}/export` already has a `suppression` object, so the data exists. |
| A1.7 | **Built** (HAL-3316) · small gaps | `POST /v1/exports`, `GET /v1/exports`, `GET /v1/exports/{id}` | `contacts-export.html`, `contacts-export-ready.html`, `contacts-export-failed.html` | Live. Request: `{ kind: "contacts", filter: { q, status, topicId, engagement, segmentId, field, event }, fields: string[] (≤ 50 custom fields) }`. Response: `{ id, kind, status: "running"\|"completed"\|"failed", rows, fields, filename, url, error, createdAt, finishedAt }`. Up to 10,000 matching contacts the CSV is written in the request and comes back `completed` with a signed `url` good for a day; past that it comes back `running`, a Workflow writes it, and the client polls `GET /v1/exports/{id}`. The fixed columns are `id, email, name, status, engagement, topics, created_at, last_activity_at, last_opened_at, last_clicked_at`. The file is UTF-8 with a BOM, formula-like cells are defused, and each export is audit-logged. Source: `src/exports/contactExport.ts`. **Remaining gaps:** (a) `GET /v1/exports` always returns `url: null`, so each row needs a `GET /v1/exports/{id}` to get a link; that works, but say so in the description. (b) No count before exporting: add `GET /v1/contacts?…&limit=0` returning `count`, or `POST /v1/exports?dryRun=1 → { rows }`, so the sheet can say “418 contacts” from the API rather than the list. (c) No progress while `running`: add `processed`. (d) Nothing tells you when a background export finishes: add an `export_ready` alert. (e) `createdBy` isn’t returned, so the recent list can’t say who exported. |
| A1.8 | Field | Bulk “all that match” | Bulk bar → “Select all 3,702 that match” | `POST /v1/contacts/bulk` takes `ids` only. Accept `{ filter: {…} }` in place of `ids` for a selection across pages, and return `{ updated, skipped, errors, jobId? }`, going async above a threshold. |
| A1.9 | Decision | Role rules for contacts | `contacts-agent.html`, `contact-agent.html`, `contact-sender.html` | The designs assume these rules: agents read contacts only (no edit, import, export, bulk or automation trigger); senders do everything except erasing and removing suppressions; erasing and removing suppressions is for owners and admins. Each 403 should be `{ reason: "role", allowedRoles }` (GAPS.md 1.13). |

## A2. Topics

| # | Status | Endpoint / field | Screens | Proposed shape |
|---|---|---|---|---|
| A2.1 | Ahead | `GET /v1/topics/stats?range=30d` | `topics.html` (30-day trend, new, unsubscribe rate) | `{ range, topics: { [topicId]: { new30d, unsubscribed30d, unsubscribeRate: number\|null, insufficientData: boolean, trend: number[] } } }`. Rates are fractions and null under 100 subscribers. The spec asks for “growth, unsubscribe rate”; `GET /v1/topics` has only `subscribers`. |

## A3. Segments

| # | Status | Endpoint / field | Screens | Proposed shape |
|---|---|---|---|---|
| A3.1 | Field (docs) | The `filter` schema | `segment-builder*.html`, `segment-zero.html` | The OpenAPI still types `filter` as `{}`. The real shape is in `src/segments/rules.ts`: groups `{ type: "all"\|"any", rules }` (at most 4 deep and 50 rules) over leaves `field { field, op, value? }`, `status { in }`, `topic { topicId, state?, is? }`, `event { name, did?, withinDays?, atLeast? }`, `engagement { in }`, `campaign { campaignId, activity: received\|opened\|clicked, did? }` and `created { withinDays?, olderThanDays? }`. The builder and its fixtures now use that shape. Field rules have no “is any of” operator, so “country is NG, GH or KE” is an any-group of three `eq` rules. **Remaining gap:** publish the Rule schema in the OpenAPI, and consider an `in` op for fields. The segments list’s old “didn’t open any campaign in 90 days” example isn’t expressible (a `campaign` rule needs a `campaignId`), so it’s now “Didn’t open September recap”; propose a `campaign` rule with no `campaignId` meaning any campaign, plus `withinDays`. |
| A3.2 | **Built** in the source · docs gap | Which rule failed | `segment-preview-error.html` | `src/domain/segments.ts` returns validation failures as `InvalidRequest { field, message }` with `field` set to the failing rule’s path (for example `…rules[3].rules[1]`), and decode failures with `field: "filter"`. The builder can mark the rule from that. **Remaining gap:** document the path format in the OpenAPI. |
| A3.3 | Field | `usedBy` on segments | `segments.html`, `segments-delete-blocked.html` | `usedBy: [{ type: "campaign"\|"automation", id, name, status }]`. `DELETE /v1/segments/{id}` on a used segment should answer `409 { _tag: "Conflict", reason: "in-use", usedBy }`. |
| A3.4 | Field | Sendable vs suppressed in the count | `segment-builder.html` → Live count split | Preview returns `count` only. Add `sendable` and `excluded: { suppressed, bounced, unsubscribed }`, as `POST /v1/campaigns/{id}/audience/preview` already does for campaigns. |
| A3.5 | Ahead | Natural-language entry | Builder → “Describe it” | `POST /v1/segments/compile { text } → { filter, explanation }`, behind `/v1/settings/ai`. Nothing is saved; the rules land in the builder for review. |
| A3.6 | Field | Preview timing | “Counted just now · 38 ms” | Optional `tookMs` on the preview response. Cosmetic; drop the line if not added. |

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
| A4.1 | Field | Whether verification is actually on | Editor → Bot protection (marked “Secret status not exposed”) | A site key without `TURNSTILE_SECRET` shows the widget but checks nothing, and the admin can’t tell. Add `turnstile: { siteKey, verifying: boolean }` to the form, or `turnstileSecretSet` to `GET /v1/health`’s checks. Optional: create the widget through Cloudflare’s Turnstile API so nobody has to paste a key. |
| A4.2 | Field | Widget mode | Editor → Bot protection | The page always renders `data-size="flexible"`, and the mode (managed, non-interactive, invisible) lives on the Cloudflare widget. No change needed unless keys are created by Mailyard (A4.1); the design says where the mode is set. |
| A4.3 | Field | Submission stats | `forms.html`, editor header (marked “Count ahead”) | `stats: { submissions30d, confirmed30d }` on each form, or `GET /v1/forms/{id}/stats?range=`. |
| A4.4 | Field | Field labels, required and order | Editor → Fields | Labels come from the key (`labelOf`: `first_name` → “First name”) and every custom field is optional. Proposed: `fields: [{ key, label?, required? }]`, keeping plain strings valid. |
| A4.5 | Field | Topic choice for visitors | Editor → Subscribes them to | Visitors get every topic on the form. If a form should let people pick, add `topicChoice: "all"\|"pick"`; the page would then render checkboxes. |
| A4.6 | Field | Embed variants | Editor → Share and embed | Only the fetch snippet is generated. An `?variant=iframe` on `/embed` (or a `snippets` array) would save people from writing the iframe themselves. |

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
| A5.2 | Field | The mapping target vocabulary | `import-mapping.html` | `mapping` is `{ [column]: string }` with no enum or description. The designs send `email`, `name` and `fields.<key>`, and leave unmapped columns out. Publish the allowed targets (and whether `status` and `topics` can be mapped from a column), and say whether a new `fields.<key>` creates the field. |
| A5.3 | Field | The file name on the import | Past imports, report and progress titles | Not returned, so the list shows ids. Add `fileName` and `fileSize` (copied from the upload). |
| A5.4 | Ahead | Cancel | `import-progress.html` → Cancel import (disabled with the reason) | `POST /v1/imports/{id}/cancel` → the import with `status: "cancelled"`. Add `"cancelled"` to the enum. |
| A5.5 | Field | Rate and ETA, and what `rows` means while running | `import-progress.html` | Add `processed: number`, `ratePerMinute: number\|null` and `etaAt: number\|null`. Say whether `rows` is the file’s total from the start or grows as it parses. The screen assumes the total and computes processed as created + updated + skipped + invalid. |
| A5.6 | Field | Column, value and code on each error | `import-row-errors.html` | Add `{ column: string\|null, value: string\|null, code: "invalid_email"\|"missing_email"\|"role_address"\|"invalid_value"\|"parse_error" }` beside `line` and `message`. Also say whether `errors` is capped; if it is, add `errorsTotal` and `GET /v1/imports/{id}/errors?cursor=`. |
| A5.7 | Field | Consent attestation | `import-mapping.html` → attestation (marked “Not recorded yet”) | Accept `consent: { attested: true }` on the request, store `{ attestedBy, attestedAt, importId }` as each imported contact’s consent source, and return it on the import. Until then the checkbox is a client-side gate only. |
| A5.8 | Field | How counts relate | Counts on every import screen | Say whether `duplicates` (repeats within the file) and `suppressed` are part of `skipped`; the screens assume so and show them under it. Also say whether rows before a failure are kept; `import-error.html` assumes they are, because the counts say so. |
| A5.9 | Field | Field types | `import-mapping.html` → Detected type | The mapping carries no type, so custom fields are stored as text and the detected type is browser-only. Pair with A1.3: `mapping: { [column]: { target, type } }` or typed `contact-fields`. |
| A5.10 | Field | Overwrite and name joining | Options, mapping | `onConflict` is `update` or `skip`; my proposed `overwrite` (clear fields where the cell is empty) isn’t there, and the screen no longer offers it. Contacts have one `name`, so First Name and Last Name can’t be joined; the design maps First Name to `name` and Last Name to `fields.last_name`. Proposed: allow `"name.first"` and `"name.last"` targets that the importer joins. |
| A5.11 | Ahead | Live progress | `import-progress.html` | `import.progress { id, …counts }` on `ws: workspace` (GAPS.md 2.3); polling works until then. |
| A5.12 | — | Not a CSV | `import-wrong-file.html` | No API change: caught in the browser before upload. |

## A6. Suppressions

| # | Status | Endpoint / field | Screens | Proposed shape |
|---|---|---|---|---|
| A6.1 | Ahead | `GET/POST/DELETE /v1/suppressions` | `suppressions*.html`, `contact-suppressed.html` | The spec lists it; the OpenAPI has none. `GET → { suppressions: [{ email, reason, source, detail, createdAt, cloudflare: "in-sync"\|"missing"\|"not-applicable" }], total, nextCursor }`. `POST { email, reason: "manual", note }`. `DELETE /v1/suppressions/{email}` needs `confirm: true` and is owner/admin only. Also `POST /v1/suppressions/import` (CSV) and `POST /v1/suppressions/{email}/push` to add it to Cloudflare’s list. |

## A7. Campaigns

| # | Status | Endpoint / field | Screens | Proposed shape |
|---|---|---|---|---|
| A7.1 | Field | Summary rates on the list | `campaigns.html` (delivered, opened, clicked, unsubscribed per sent campaign) | `GET /v1/campaigns` has no stats; the list would need one report call per row. Add `summary: { sent, deliveryRate, openRate, clickRate, unsubscribeRate, insufficientData } \| null` to sent and cancelled items. |
| A7.2 | Field | Status counts for the tabs | `campaigns.html` → status tabs | `GET /v1/campaigns/counts → { draft, scheduled, sending, paused, sent, cancelled }`. |
| A7.3 | Field | Exclusions | `campaign-audience.html` → Leave out | The campaign has `segmentId` and `topicId` only. Add `exclude: { segmentIds: string[], recentlySentDays: number\|null }` to the campaign and honour it in `POST /v1/campaigns/{id}/audience/preview`, whose `excluded` gains `bySegment` and `recentlySent`. Until then, the screen says the exclusions aren’t counted. |
| A7.4 | Field | Link statuses | `campaign-preview.html` → Links | `POST /v1/campaigns/{id}/render` returns no links. Add `links: [{ url, status: number\|null, redirectsTo?: string }]`, or a `GET /v1/campaigns/{id}/links`. The `links` check (in `/checks`) already knows the result. |
| A7.5 | Field (live endpoint) | Not enough data on the report | `campaign-report-insufficient.html` | The live report returns `rates` as plain numbers at any size. The spec and brief want null rates with `insufficientData: true` under 100 sends, like `/v1/stats/delivery`. Until that ships, the screen applies the 100 rule client-side. |
| A7.6 | **Answered** (schema proposal only) | `activity[].hour` | Report → Opens and clicks over time | Measured from the backend source, `src/campaigns/report.ts` at origin/main 9428241: whole hours since the campaign started sending, `floor((first_opened_at − startedAt) / 3600000)`, kept while `h < 168` (the first 7 days). The chart now plots hours 0–167 after sending started, with a mark at each day (24, 48 … 168). Tooltips read “Day 2, hour 5”, plus the clock time worked out from `startedAt`. **Still proposed for the schema:** give `hour` `maximum: 167` and a description (“Whole hours from startedAt to the contact’s first open; the first 7 days only”), so clients don’t read it as an hour of the day. |
| A7.7 | Field (live endpoint) | Resend options | `campaign-resend.html` | `POST /v1/campaigns/{id}/resend-non-openers` takes no body. Proposed: `{ countMachineOpensAsOpened?: boolean (default false), subject?: string }`, plus a dry count, `GET …/resend-non-openers?dryRun=1 → { recipients }`. Also say in the schema description whether machine-only opens currently count as opened; the sheet assumes they do and warns. |
| A7.8 | Field | “Fix” target for each check | `campaign-checks.html`, `campaign-blocked.html` | `checks[]` has `{ id, status, title, detail }`. Add `fix: { label, target: "content"\|"audience"\|"settings.compliance"\|"domains", field?: string, domainId?: string }` so each fix link goes to the right field without the client hard-coding ids. |
| A7.9 | Field | What’s already queued in the window | `campaign-schedule.html` → ETA by day | `GET /v1/usage/forecast` returns `sendableToday`, `additionalDays`, `finishesBy` and `cost`. Add `startAt=` as a parameter and `days: [{ day, available, queued, thisCampaign }]` in the response. |
| A7.10 | Field | Time zone | Schedule → Time zone | `sendAt` is absolute ms, which is right. Store `timezone: string` so the UI can show “10:00 in Lagos” back. |
| A7.11 | Field | `ratePerHour` on pace | `campaign-sending.html` | As GAPS.md 3.8. |
| A7.12 | Field | Pause reason as a code | `campaign-paused-*.html` | `pausedReason` and `pace.reason` are free text. Add `pausedBy: "user"\|"quota"\|"governor.bounce"\|"governor.complaint"\|"reputation"` so the screen can pick its banner and decide whether Resume is allowed (quota pauses resume on their own at the reset). |
| A7.13 | Field | Save conflict | `campaign-editor-error.html` | `PATCH /v1/campaigns/{id}` should accept `ifMatch: updatedAt` and answer `409 { _tag: "Conflict", updatedBy, updatedAt }`. Without it, two editors overwrite each other silently. |
| A7.14 | Field | Test results | Preview → Send a test | `POST /v1/campaigns/{id}/test` returns `status` per address. To show “delivered 4 min ago”, keep the last test on the campaign as `lastTest: { at, results }`. |
| A7.15 | Field | Block document | Content → Blocks | The campaign stores `bodyHtml`/`bodyText` or a template. The block editor needs its source kept: `bodyBlocks: Block[]` (or a `kind: "blocks"` template, as `GET /v1/templates` already has). Merge-field fallbacks are written inline as `{{ first_name | "there" }}`; confirm the renderer’s syntax. |

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
| A8.12 | Alerts | Alerts drawer | New `kind: "automation_failed"`, raised per failing step with a count. |

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
| 1.1 | `GET /v1/messages` filters `stream=`, `templateId=`, `q=` (recipient or message id), `from=`, `to=` | `transactional/messages*.html` | Today only `status`, `recipient`, `cursor`, `limit`. The spec says the log is searchable by recipient *and message id* and filterable by stream and template. Add the four query params; keep the response as is. |
| 1.2 | `events[]` on `GET /v1/messages/{id}` | `message-delivered`, `-bounced`, `-deferred`, `-complained` | `events: [{ type: "accepted"\|"sent"\|"deferred"\|"delivered"\|"bounced"\|"complained"\|"failed"\|"rejected"\|"suppressed"\|"opened"\|"clicked", at: number, attempt?: number, smtpStatus?: string, smtpResponse?: string, mx?: string, bounceType?: "hard"\|"soft", detail?: string }]`, plus `nextAttemptAt: number\|null`. Today a message has one `status`, `attempts`, `smtpResponse` and `updatedAt`, so the trail can't be drawn. The events queue consumer already sees each event. |
| 1.3 | `headers[]`, `idempotencyKey`, `templateVersion`, `source` on a message | Message detail → Headers, Details | `headers: [{ name, value }]` as sent; `idempotencyKey: string\|null`; `templateVersion: number\|null`; `source: "api"\|"smtp"\|"automation"\|"campaign"\|"mailbox"`. |
| 1.4 | `GET /v1/messages/{id}/raw` for sends | Message detail → Raw source | The mailbox side has `…/messages/{messageId}`; outbound messages have no raw source. |
| 1.5 | Request counts per key | `api-keys.html` → Requests, 24 h | `GET /v1/api-keys?include=usage` adds `requests24h: number` per key. Only `lastUsedAt` exists. |
| 1.6 | `POST /v1/api-keys/{id}/rotate` | API keys → Rotate | Spec lists rotate. Proposed: returns `{ key, apiKey }` like create, and revokes the old key after `graceSeconds` (default 0). |
| 1.7 | Template usage | `templates.html` → Used by, Sends 30 d | `GET /v1/templates?include=usage` adds `usage: { sends30d, usedBy: [{ type: "apiKey"\|"automation"\|"campaign", id, name }] }`. |
| 1.8 | Test send of a template | Template editor → Send a test | `POST /v1/templates/{id}/test { to, data, version? }` → `{ messageId }`. Today there's render and preview only. |
| 1.9 | Who edited a template, and when the draft was last saved | Template editor | `versions[].createdBy` exists. Add `latest.updatedAt` and `latest.updatedBy` for the "Draft saved 14 min ago" line. |
| 1.10 | Webhook event catalogue | `webhook-create`, webhook lists | `GET /v1/webhooks` returns `events: string[]`, but neither the schema nor a description says what the strings are. The designs use `email.sent`, `email.delivered`, `email.deferred`, `email.bounced`, `email.complained`, `email.failed`, `email.rejected`, `email.opened`, `email.clicked`, `contact.subscribed`, `contact.unsubscribed` and `inbound.received`: **confirm or correct**, and make it a literal union. |
| 1.11 | Dead-letter count per endpoint | `webhooks.html` → Dead letters; alert `webhook_dead_letter` | `deadLetters: number` on each endpoint. Today it takes a `deliveries?status=dead` call per endpoint. |
| 1.12 | Signature scheme | Webhook detail → Verify the signature | No document says what header and algorithm sign a delivery. The designs show `Mailyard-Signature: t=…, v1=HMAC-SHA256(secret, t + "." + body)` with a 5-minute tolerance, and the SDK (HAL-3142) verifies it. Confirm or correct. |
| 1.13 | Bulk replay | Dead letters → Replay all | `POST /v1/webhooks/{id}/deliveries/replay { status: "dead" }` → `{ queued: number }`. Today it's one call per delivery. |
| 1.14 | `GET /v1/suppressions`, `POST /v1/suppressions`, `DELETE /v1/suppressions/{email}` | `suppressions*.html`, message-bounced → Suppressions | The plan has a D1 `suppressions(email, reason, source, at)` table and the send path checks it, but no endpoint exposes it. List: `{ suppressions: [{ email, reason: "hard_bounce"\|"complaint"\|"unsubscribe"\|"manual", source: "event"\|"import"\|"manual", messageId: string\|null, streams: ("all"\|"campaign"\|"automation")[], at: number, note?: string }], counts: { hard_bounce, complaint, unsubscribe, manual }, nextCursor }`. Delete refuses complaints for bulk streams with `409 { _tag: "Conflict", reason: "complaint" }`. |

## 2. Domains

| # | Endpoint / field | Screens | Proposed shape |
|---|---|---|---|
| 2.1 | `zoneStatus`, `registrar`, `nameservers`, `currentNameservers`, `dnssec` on a domain | `domains.html`, `domain-pending.html`, health strip | Same as foundation GAPS 3.3, extended: `registrar: string\|null`, `dnssec: "active"\|"pending"\|"off"\|null`, `currentNameservers: string[]` while pending. |
| 2.2 | `complaints30d`, `returnPath` | Domain detail → Sending and reputation | `complaints30d: number\|null` (from Cloudflare's reputation per domain) and `returnPath: string` (the `cf-bounce.<domain>` host). The return path can be derived client-side today. |
| 2.3 | Fix records | Domain failing → Fix records | `POST /v1/domains/{id}/fix` re-applies every `expectedRecords` entry that fails, returns the domain. Today recheck only reads. |
| 2.4 | Live check status while rechecking | `domain-rechecking.html` | Add `"checking"` to `checks[].status`, or push `domain.checks` over `ws: workspace` (foundation 2.3). |
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
| 3.1 | Rates per day: `GET /v1/stats/delivery?range=&by=day` | Sending → Rates over time; Reputation history | `{ range, days: [{ day, sent, delivered, rates: { bounceRate, complaintRate, rejectionRate, insufficientData } }] }`. Per-day `insufficientData` drives the hatched under-100 part of each chart. |
| 3.2 | Delivery time | Sending → Delivery time, median | `deliveryTime: { medianMs, p95Ms }` on `/v1/stats/delivery`. The spec says it comes from `deliveryTimeMs`, which isn't on any response. |
| 3.3 | `GET /v1/stats/deferrals?range=` | Sending → Deferral reasons | `{ range, reasons: [{ reason, smtpStatus, provider, count }] }`. |
| 3.4 | `GET /v1/stats/engagement?range=&by=` | `engagement.html` | `{ range, estimate: true, campaigns: [{ id, name, delivered, uniqueOpens, machineOpens, uniqueClicks, unsubscribed }], automationSteps: [{ automationId, step, delivered, uniqueClicks }], byHour: number[7][24], unsubscribesByTopic: [{ topicId, name, count }] }`. PR #25's campaign report covers one campaign; this is across all. |
| 3.5 | `GET /v1/stats/inbound` with `by=day` and `topSenders` | `inbound.html` | Foundation GAPS 3.5 plus `days: [{ day, received }]` and `topSenders: [{ address, received }]`. |
| 3.6 | `GET /v1/stats/response-times?range=` | Inbound → Response times | `{ range, mailboxes: [{ mailboxId, address, assignees: [{ name, threads, firstResponseMedianMin, resolutionMedianHours }] }] }`. Needs assignment, which the mail screens own. |
| 3.7 | `GET /v1/stats/audience` | `audience.html` | Foundation GAPS 3.6. |
| 3.8 | `GET /v1/usage/storage` | Usage → Mail held in R2 | `{ totalBytes, byMailbox: [{ mailboxId, address, bytes }] }`. |
| 3.9 | CSV export | Every chart → CSV; Export sheet | `format=csv` on each stats endpoint, or `GET /v1/stats/export?range=&charts=` returning a zip. Rates stay fractions in the CSV. |

**Used as-is:** `GET /v1/stats/providers` (`providers[].{ provider, delivered, deferred, bounced, complained, total }`), `GET /v1/usage/forecast?recipients=` (both union arms: `possible: true` with `sendableToday, additionalDays, finishesBy, cost.{ billedAfter, extraUsd }`, and `possible: false` with `reason`), `GET /v1/usage` including `today.source: "cloudflare-unreachable"` (Usage · quota unknown).

## 4. Settings

| # | Endpoint / field | Screens | Proposed shape |
|---|---|---|---|
| 4.1 | `GET /v1/members`, `PATCH /v1/members/{id}`, `DELETE /v1/members/{id}`, `GET/POST/DELETE /v1/invites`, `POST /v1/invites/{id}/resend` | `members*.html` | `{ members: [{ id, name, email, role, mailboxIds, lastActiveAt, joinedAt }], invites: [{ id, email, role, mailboxIds, invitedBy, createdAt, expiresAt }] }`. Same model as foundation GAPS 1.13. Removing or demoting the owner: `403 { _tag: "Forbidden", reason: "owner" }`. |
| 4.2 | Mailbox members by person, not by key | Mailbox detail → Members and access | `PUT /v1/mailboxes/{id}/members` takes `{ apiKeyId, role: "owner"\|"member"\|"viewer" }`. With people and roles (4.1), it should take `{ memberId, access }`. The design labels access Owner, Member and Viewer to match today's enum. |
| 4.3 | Aliases as their own resource | Mailboxes → Aliases | The spec names `/v1/aliases`; today aliases, groups and the catch-all are mailboxes with `kind: "alias"\|"group"\|"catch_all"` and `targetIds`. **Not a gap**: the designs use `GET /v1/mailboxes?kind=` and `PATCH { targets }`. |
| 4.4 | Rule match counts | Rules → matches, last match | `matches: number`, `lastMatchAt: number\|null` on each rule. |
| 4.5 | Rule test outcome shape | Rule editor → Test | `POST /v1/mailboxes/{id}/rules/test` exists, but `outcome` and `filedWith` are typed `any`. Proposed: `outcome: { labels: string[], forwardedTo: string[], folder, stoppedAt: string\|null }`, `filedWith: "inbox"\|"spam"\|…`. |
| 4.6 | `GET /v1/gmail-mode`, `POST /v1/gmail-mode/check` | `gmail-mode*.html` | `{ address, gmail, steps: [{ id: "verify"\|"route"\|"smtp"\|"test", title, status: "pass"\|"running"\|"waiting"\|"fail", detail, checkedAt }], smtp: { host, port, security, username } }`. Spike S4 decides whether "Send mail as" works with `api_token` at all. |
| 4.7 | Compliance additions | `tracking.html` | `GET/PUT /v1/settings/compliance` has `postalAddress, linkAllowlist, seedAddresses, trackingOrigin`. Add `trackOpensDefault`, `trackClicksDefault`, `doubleOptInDefault`, `preferencePage: { useBrand, showTopicDescriptions }`, and a `trackingOriginCheck: { cname, certificate, checkedAt }` for the live check under the hostname. |
| 4.8 | Brand keys in the OpenAPI, and a contrast check | `brand*.html`, every public page | The server validates `BrandSettings` (`src/domain/brand.ts`): `colors.{ bg, surface, fg, muted, border, lime, indigo, body, red, white }` as `#rrggbb`, `fonts.{ display, body, mono }`, `logoUrl` and `fontsHref` as http(s) URLs. The designs now use those names; the live `/u` page reads `bg, surface, fg, muted, border` and uses `indigo` as its accent. The OpenAPI still types `colors` and `fonts` as free maps and `PUT` as `any`: publish the struct. Proposed on top: reject a `PUT` whose text fails AA (`400 { field: "colors.indigo", message: "White text on this accent is 3.1:1; AA needs 4.5:1" }`), and a logo upload (`POST /v1/uploads` then `logoUrl`) so nobody hotlinks. |
| 4.9 | `GET/PUT /v1/settings/ai` | `ai.html` | `{ provider: { kind: "workers-ai"\|"openai-compatible", model, baseUrl: string\|null, keySet: boolean }, features: [{ id: "spam"\|"summary"\|"reply"\|"triage"\|"subject", enabled, sends: string }] }`. |
| 4.10 | `GET /v1/integrations`, MCP tokens | `integrations.html` | `{ mcp: { endpoint, tokens: [{ id, name, prefix, scopes, lastUsedAt, createdAt }] }, hermes: { connected, lane, mailboxes, since }, supportInbox: { installed }, webhooks: { count, failing } }`, plus `POST/DELETE /v1/integrations/mcp/tokens`. |
| 4.11 | Workspace export: everything in one signed download | `import-export.html`, `export-ready.html` | **Partly built:** `POST /v1/exports`, `GET /v1/exports`, `GET /v1/exports/{id}` (new in 47426a9) export **contacts** only: `{ kind: "contacts", filter?, fields? }` → `{ id, kind, status: "running"\|"completed"\|"failed", rows, fields, filename, url, error, createdAt, finishedAt }`. Per-mailbox export (`POST /v1/mailboxes/{id}/exports`) is built too. **Gap:** `kind` for mail, templates and settings, and an "everything" export that bundles them: `{ kind: "workspace" }` → `parts: [{ kind, format, items, bytes }]`. |
| 4.12 | `GET /v1/audit` with filters and CSV | `audit*.html` | `{ entries: [{ id, at, actor: { type: "user"\|"key"\|"system", id, name }, via: "web"\|"api"\|"mcp", ip, location, action, target: { type, id, label }, before: object\|null, after: object\|null }], nextCursor }`; query `actor=`, `action=`, `target=`, `from=`, `to=`, `format=csv`. |
| 4.13 | `DELETE /v1/workspace` | `danger-delete-workspace.html` | Owner only; body `{ confirm: "<workspace name>" }`; `202 { deletesAt }` with a short grace window. |
| 4.14 | Delete mailbox guard | `danger-delete-mailbox.html` | `DELETE /v1/mailboxes/{id}` returns `409 Conflict` with a message today. Proposed: `reason: "no-recent-export"\|"alias-targets"`, `aliasIds: string[]`, so the sheet can say which aliases break. |

**Used as-is:** `GET /v1/sending/governor` and `GET/PUT /v1/settings/sending` (every field, including `503 GovernorUnreachable`), `GET /v1/mailboxes`, `PATCH /v1/mailboxes/{id}` (`signature`, `autoReply.{ enabled, subject, body, startsAt, endsAt }`, `forwarding.{ enabled, to, keepCopy }`), the rules CRUD and `PUT …/rules/order`, `GET /v1/imports` (contact imports, new since the vendored copy) and `GET /v1/mailboxes/{id}/imports`.

## 5. Public pages

| # | Endpoint / field | Screens | Proposed shape |
|---|---|---|---|
| 5.1 | **Built:** `GET /u/:token`, `POST /u/:token` (HAL-3297) | `email-preferences-*.html` | One page for unsubscribe and the preference centre; there is no separate `/p` route. Page data (`preferences()` in `unsubscribe-domain.ts`): `{ email (masked, "ng•••••••@gmail.com"), unsubscribedFromAll, blocked, focusTopicId, topics: [{ id, name, description, subscribed }] (live topics, by name), brand }`, plus a `notice` after a POST ("Your choices are saved." or "You're unsubscribed from everything. You won't get any more of these emails."). Actions: `action=save` with `topic=` per ticked box, or `action=all`. `List-Unsubscribe=One-Click` (RFC 8058) and the mailto unsubscribe act at once with no page (2xx). A bad token renders "This link isn't valid" unbranded with `400`. **Opening the link doesn't unsubscribe**: the email's topic is outlined and stays ticked until Save. Every state is designed: from an email (focused), saved, unsubscribed from everything, blocked, no lists, link not valid. |
| 5.2 | Proposed additions to `/u` | `email-preferences-proposals-brand`, `-resubscribe-proposal-default`, `-invalid-request-proposal` | Each is drawn inside a dashed "Proposed" frame on top of the live page. (a) **Focus wording:** a line naming the list the email came from, with "manage topics instead". Needs no data: the topic name is already in `topics` by `focusTopicId`. (b) **Resubscribe:** `action=resubscribe` restores the topics `action=all` removed, within a short window; needs the previous states kept (the timeline event `email.unsubscribed` with `how: "preference page"` could carry them). (c) **Fresh link on a bad token:** `POST /p/request { email }` mails a new `/u` link if the address is on a list and answers the same either way. (d) `unsubscribedFromAll` is in the page data but the page doesn't use it; when true and no notice is set, say so above the list. |
| 5.3 | **Built:** `GET /c/:token` (since 11a2439) | `confirm-*.html` | `handleConfirm` in `public.ts` renders a plain page: 200 "You're subscribed · Thanks: you'll now receive {topic}." (one topic per link), 200 "We can't send to this address" when the address is blocked, 410 "This link has expired · Sign up again and we'll send a fresh link.", 400 "This link isn't valid · Check you copied the whole link from the email.", and 503 when the consent key isn't set. **Remaining gaps:** it doesn't redirect to the form's `redirectUrl` (the spec says it should), and there's no resend; `POST /c/resend` stays proposed. |
| 5.4 | **Built:** `GET /f/:formId`, `POST /v1/forms/:id/submit`, Turnstile, `GET /v1/forms/{id}/embed` (HAL-3317) | `signup-*.html` | Page (`forms-page.ts`): logo or brand name, the form's `name` and `description`, its live topics read-only ("You'll get all of these"; visitors don't pick), Email (required), Name (optional), each custom field in `fields` labelled from its name with autofill hints, a honeypot (`_hp`), the Turnstile widget when `turnstileSiteKey` is set, "Sign up", and the unsubscribe fine print. Submit answers HTML for a browser and JSON for a script: 200 "Check your inbox" (`status: confirm`, double opt-in pending), 200 "You're subscribed" (`subscribed`, the same page for an address that was already on the list, by design), 303 to `redirectUrl` when set, 400 "Please try again" when Turnstile fails (closed: no token, rejected, or Cloudflare unreachable), 400 "Email needed" or "Check your email address", 429 "Too many tries", and 404 "Form not found" for an unknown *or archived* form. A filled honeypot gets the confirm page and nothing is written. **Remaining gaps (proposed, framed in the screens):** (a) re-render the form with the error and what was typed (`renderFormPage` already takes `error`; the handler never passes it); (b) a path with JavaScript off, since a form with a site key then always fails closed. |
| 5.5 | `GET /v/:token` (still a gap) | `view-*.html` | The campaign's rendered HTML with this recipient's merge fields. `POST /v1/campaigns/{id}/render` exists for the owner; the public route doesn't. |

## 6. Not API, but owed

| # | Item | Where | Note |
|---|---|---|---|
| 6.1 | Coursified's brand for the "customised" public pages | `screens/ops/assets/coursified/` | Logo (`coursified-mark.svg`) and fonts (Outfit 500, Figtree 400/600, both OFL) are copied from the Coursified repo (`~/dev/coursified/brand`, `DESIGN.md`): `colors.indigo` `#2E5BFF` (accent), `fg` `#0E0E0E`, `bg` `#F4F4F2`, `muted` `#71717A`, `border` `#E4E4E7`, `surface` `#EEF2FF`, `white` `#FFFFFF`. In production these come from `GET /v1/settings/brand`, with `fontsHref` loading the fonts. Coursified's own design contract says its brand is light-only, so its public pages don't follow the reader's dark mode. |
| 6.2 | Align the live `/u` page with the design | `email-preferences-*.html` vs `unsubscribe-worker.ts` | The live page sets its own CSS: `system-ui` type, and defaults of `#2f5bd8` accent, `#fcfcfc` page, `#ebedef` notices, `#0c0c0c` text, `#5c5f66` muted and `#d5d8dc` lines (from `DEFAULT_THEME`, an MBPrep-derived theme with `indigo` replaced), with `color-scheme: light` only. The designs use Flareyard tokens by default (Funnel Display and Sans, gray-1000 actions, light and dark) and the workspace's own fonts when set. To align: (1) the default theme takes the Flareyard token values; (2) load `fontsHref` and use `fonts.display` and `fonts.body`, which the page ignores today; (3) follow `prefers-color-scheme` for the default brand; (4) the design's card, the "From this email" tag on the focused topic, success and warning colours on the notices, and a footer with the compliance postal address and privacy link. None needs a new endpoint. |
| 6.3 | The Turnstile widget | `signup-*.html` | Drawn as a labelled placeholder box: the real widget (`data-size="flexible"`) is a Cloudflare iframe that can't render offline. |
| 6.4 | Brand the public result pages | `confirm-brand.html`, `signup-submitted-brand.html` | `/c` results and every `/f` submit result use one unbranded `page()` (system-ui, no logo, light and dark), while the form page itself is branded. The design shows them in the workspace brand, like the form page. No new endpoint: pass the brand into `page()`. |
