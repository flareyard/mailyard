import { and, asc, eq, inArray, isNull } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Bindings } from "../Bindings.ts"
import { invites, mailboxes, mailboxPeople, members, sessions, settings, signInLinks } from "../db/schema.ts"
import { Ids } from "../kit/index.ts"
import { Database, queryIn } from "../services/Database.ts"
import { type Caller, ROOT } from "./apiKeys.ts"
import { recordAudit } from "./audit.ts"
import { randomToken, sha256, timingSafeEqual } from "./crypto.ts"
import { HOLDS_MAIL } from "./mailboxes.ts"
import { parseParty, sendBulkMessage } from "./outbox.ts"
import type { Role } from "./permissions.ts"
import { putWorkspaceSetting, workspaceSetting } from "./sessions.ts"

/**
 * People in the workspace (HAL-3361): claiming it, signing in by email link, invitations, roles,
 * and handing ownership on. Keys keep working beside all of this, checked by their scopes.
 *
 * Mailyard writes to people about their own access only: a sign-in link they asked for, and an
 * invitation the person inviting chose to send. An invitation is drafted first and goes out only on
 * `POST /v1/invites/{id}/send`.
 */

const MINUTE = 60_000
const DAY = 86_400_000
/** A sign-in link works for this long, once. */
export const SIGN_IN_LINK_MS = 15 * MINUTE
/** An invitation can be accepted for this long after it was last sent. */
export const INVITE_MS = 7 * DAY

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Whether a string is an IANA time zone this runtime knows. */
export const isTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export type MailboxAccess = "owner" | "member" | "viewer"
export type InviteRole = Exclude<Role, "owner">
export type MailboxGrant = { readonly mailboxId: string; readonly access: MailboxAccess }

export class PeopleInvalid extends Schema.TaggedError<PeopleInvalid>()("PeopleInvalid", {
  field: Schema.String,
  message: Schema.String,
}) {}
export class MemberNotFound extends Schema.TaggedError<MemberNotFound>()("MemberNotFound", {
  id: Schema.String,
}) {}
export class InviteNotFound extends Schema.TaggedError<InviteNotFound>()("InviteNotFound", {
  id: Schema.String,
}) {}
/** An invitation that can't be used any more: `expired`, `used` or `revoked` (410). */
export class InviteGone extends Schema.TaggedError<InviteGone>()("InviteGone", {
  reason: Schema.Literals(["expired", "used", "revoked"]),
  message: Schema.String,
}) {}
/** Accepting while signed in as someone else (409 `email-mismatch`). */
export class InviteEmailMismatch extends Schema.TaggedError<InviteEmailMismatch>()("InviteEmailMismatch", {
  message: Schema.String,
}) {}
/** Already a member, already invited, or the workspace already claimed (409). */
export class PeopleConflict extends Schema.TaggedError<PeopleConflict>()("PeopleConflict", {
  reason: Schema.Literals(["already-member", "already-invited", "already-claimed"]),
  message: Schema.String,
  claimedBy: Schema.optionalKey(Schema.String),
  claimedAt: Schema.optionalKey(Schema.Number),
}) {}
/** The owner can't be removed or demoted; hand ownership on first (403 `owner`). */
export class OwnerProtected extends Schema.TaggedError<OwnerProtected>()("OwnerProtected", {
  message: Schema.String,
}) {}
/** Claiming needs the admin key; handing ownership on needs the owner (403). */
export class PeopleForbidden extends Schema.TaggedError<PeopleForbidden>()("PeopleForbidden", {
  message: Schema.String,
}) {}
/** No address to send Mailyard's own mail from: set MAILYARD_SYSTEM_FROM or DEFAULT_FROM (503). */
export class SystemSenderMissing extends Schema.TaggedError<SystemSenderMissing>()("SystemSenderMissing", {
  message: Schema.String,
}) {}
export class SignInLinkInvalid extends Schema.TaggedError<SignInLinkInvalid>()("SignInLinkInvalid", {
  reason: Schema.Literals(["unknown", "expired", "used"]),
  message: Schema.String,
}) {}

export const normalizeEmail = (email: string) => email.trim().toLowerCase()

const esc = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

const hashOf = (token: string) => Effect.promise(() => sha256(token))

/** Who Mailyard's own mail comes from: MAILYARD_SYSTEM_FROM, else DEFAULT_FROM. */
const systemFrom = Effect.fn("people.systemFrom")(function* () {
  const env = yield* Bindings
  const raw = env.MAILYARD_SYSTEM_FROM ?? env.DEFAULT_FROM
  if (!raw)
    return yield* new SystemSenderMissing({
      message:
        "Set MAILYARD_SYSTEM_FROM (or DEFAULT_FROM) so Mailyard can send sign-in links and invitations.",
    })
  return parseParty(raw)
})

/** Sends one of Mailyard's own messages on the `system` stream: no contact is created for it. */
const sendSystemMail = Effect.fn("people.sendSystemMail")(function* (input: {
  readonly to: { readonly email: string; readonly name?: string | undefined }
  readonly subject: string
  readonly html: string
  readonly text: string
  readonly key: string
}) {
  const from = yield* systemFrom()
  return yield* sendBulkMessage({
    stream: "system",
    message: {
      from: from.name ? { email: from.email, name: from.name } : { email: from.email },
      to: [input.to.name ? { email: input.to.email, name: input.to.name } : { email: input.to.email }],
      subject: input.subject,
      html: input.html,
      text: input.text,
    },
    contactId: null,
    campaignId: null,
    idempotencyKey: input.key,
  }).pipe(
    // A send that can't be built or stored is Mailyard's fault, not the caller's: a 500.
    Effect.catchTags({
      BlobStoreError: Effect.die,
      InvalidMessage: Effect.die,
      TrackingKeyMissing: Effect.die,
    }),
  )
})

export const memberView = (m: typeof members.$inferSelect) => ({
  id: m.id,
  email: m.email,
  name: m.name,
  role: m.role,
  timeZone: m.timeZone,
  createdAt: m.createdAt,
  lastActiveAt: m.lastActiveAt,
})

/** The workspace's name for mail: the one it was claimed with, else "Mailyard". */
const workspaceName = Effect.fn("people.workspaceName")(function* () {
  return (yield* workspaceSetting()).name ?? "Mailyard"
})

/** Checks mailbox grants: real mailboxes that hold mail, each once. */
const checkGrants = Effect.fn("people.checkGrants")(function* (grants: ReadonlyArray<MailboxGrant>) {
  const ids = [...new Set(grants.map((g) => g.mailboxId))]
  if (ids.length !== grants.length)
    return yield* new PeopleInvalid({ field: "mailboxes", message: "A mailbox is listed twice." })
  if (ids.length === 0) return
  const found = yield* queryIn("people.grantMailboxes", ids, (db, chunk) =>
    db
      .select({ id: mailboxes.id, kind: mailboxes.kind })
      .from(mailboxes)
      .where(inArray(mailboxes.id, chunk))
      .all(),
  )
  const usable = new Set(found.filter((m) => HOLDS_MAIL.has(m.kind)).map((m) => m.id))
  const bad = ids.find((id) => !usable.has(id))
  if (bad)
    return yield* new PeopleInvalid({
      field: "mailboxes",
      message: `${bad} isn't a mailbox that holds mail.`,
    })
})

/** Replaces a person's mailbox grants. */
const setGrants = Effect.fn("people.setGrants")(function* (
  memberId: string,
  grants: ReadonlyArray<MailboxGrant>,
) {
  const database = yield* Database
  yield* database.query("people.setGrants", (db) =>
    db.batch([
      db.delete(mailboxPeople).where(eq(mailboxPeople.memberId, memberId)),
      ...grants.map((g) =>
        db.insert(mailboxPeople).values({ mailboxId: g.mailboxId, memberId, role: g.access }),
      ),
    ] as unknown as Parameters<typeof db.batch>[0]),
  )
})

/** A person's mailbox grants. */
export const grantsOf = Effect.fn("people.grantsOf")(function* (memberIds: ReadonlyArray<string>) {
  if (memberIds.length === 0) return new Map<string, Array<MailboxGrant & { address: string }>>()
  const rows = yield* queryIn("people.grants", [...memberIds], (db, chunk) =>
    db
      .select({
        memberId: mailboxPeople.memberId,
        mailboxId: mailboxPeople.mailboxId,
        access: mailboxPeople.role,
        address: mailboxes.address,
      })
      .from(mailboxPeople)
      .innerJoin(mailboxes, eq(mailboxes.id, mailboxPeople.mailboxId))
      .where(inArray(mailboxPeople.memberId, chunk))
      .all(),
  )
  const out = new Map<string, Array<MailboxGrant & { address: string }>>()
  for (const r of rows) {
    const list = out.get(r.memberId) ?? []
    list.push({ mailboxId: r.mailboxId, access: r.access, address: r.address })
    out.set(r.memberId, list)
  }
  return out
})

const findMember = Effect.fn("people.findMember")(function* (id: string) {
  const database = yield* Database
  const m = yield* database.query("members.get", (db) =>
    db.select().from(members).where(eq(members.id, id)).get(),
  )
  if (!m || m.removedAt !== null) return yield* new MemberNotFound({ id })
  return m
})

const findByEmail = Effect.fn("people.findByEmail")(function* (email: string) {
  const database = yield* Database
  return (
    (yield* database.query("members.byEmail", (db) =>
      db.select().from(members).where(eq(members.email, email)).get(),
    )) ?? null
  )
})

/** Ends every session a person has, as when they're removed or demoted. */
const endSessionsOf = Effect.fn("people.endSessions")(function* (memberId: string, now = Date.now()) {
  const database = yield* Database
  yield* database.query("people.endSessions", (db) =>
    db
      .update(sessions)
      .set({ endedAt: now })
      .where(and(eq(sessions.memberId, memberId), isNull(sessions.endedAt)))
      .run(),
  )
})

const actorOf = (caller: Caller) => caller.keyId

// ---------------------------------------------------------------------------------------------
// Signing in by email link
// ---------------------------------------------------------------------------------------------

const signInMail = (input: { name: string; workspace: string; url: string }) => ({
  subject: `Sign in to ${input.workspace}`,
  html: `<p>Hi ${esc(input.name)},</p><p>Use this link to sign in to ${esc(input.workspace)} on Mailyard. It works once, for 15 minutes.</p><p><a href="${esc(input.url)}">Sign in</a></p><p>If you didn't ask to sign in, ignore this message: nobody can use the link without your inbox.</p>`,
  text: `Hi ${input.name},\n\nUse this link to sign in to ${input.workspace} on Mailyard. It works once, for 15 minutes.\n\n${input.url}\n\nIf you didn't ask to sign in, ignore this message: nobody can use the link without your inbox.\n`,
})

/** Mints a one-time sign-in link for a member and mails it to them. */
const mailSignInLink = Effect.fn("people.mailSignInLink")(function* (
  member: typeof members.$inferSelect,
  origin: string,
  returnTo: string | null = null,
  now = Date.now(),
) {
  const database = yield* Database
  const token = randomToken(32)
  const id = `sil_${yield* (yield* Ids).next}`
  const tokenHash = yield* hashOf(token)
  yield* database.query("signInLinks.create", (db) =>
    db
      .insert(signInLinks)
      .values({
        id,
        memberId: member.id,
        tokenHash,
        createdAt: now,
        expiresAt: now + SIGN_IN_LINK_MS,
        returnTo: safeReturn(returnTo),
      })
      .run(),
  )
  const url = `${origin}/v1/session/link/${token}`
  const mail = signInMail({ name: member.name, workspace: yield* workspaceName(), url })
  yield* sendSystemMail({ to: { email: member.email, name: member.name }, ...mail, key: `sign-in:${id}` })
})

/**
 * Where a sign-in link may send someone afterwards: only back to an OAuth authorization on this site
 * (HAL-3462), so a link can't be turned into an open redirect.
 */
export const safeReturn = (returnTo: string | null | undefined) =>
  returnTo && /^\/oauth\/authorize\?[^\s]*$/.test(returnTo) && returnTo.length <= 4000 ? returnTo : null

/**
 * `POST /v1/session/link { email }`: mails a sign-in link to a current member. The answer is the same
 * whether or not the address belongs to someone, so it can't be used to learn who's in the workspace.
 */
export const requestSignInLink = Effect.fn("people.requestSignInLink")(function* (
  email: string,
  origin: string,
  returnTo: string | null = null,
) {
  const address = normalizeEmail(email)
  if (!EMAIL.test(address) || address.length > 254) return { sent: true }
  const member = yield* findByEmail(address)
  if (!member || member.removedAt !== null) return { sent: true }
  yield* systemFrom()
  yield* mailSignInLink(member, origin, returnTo)
  return { sent: true }
})

/** Uses a sign-in link: once, within 15 minutes, for a member who's still in the workspace. */
export const redeemSignInLink = (token: string, now = Date.now()) =>
  redeemSignInLinkFor(token, now).pipe(Effect.map((r) => r.member))

/** `redeemSignInLink`, with where the link was asked to land afterwards. */
export const redeemSignInLinkFor = Effect.fn("people.redeemSignInLink")(function* (
  token: string,
  now = Date.now(),
) {
  const database = yield* Database
  const tokenHash = yield* hashOf(token)
  const link = yield* database.query("signInLinks.find", (db) =>
    db.select().from(signInLinks).where(eq(signInLinks.tokenHash, tokenHash)).get(),
  )
  if (!link)
    return yield* new SignInLinkInvalid({ reason: "unknown", message: "This sign-in link isn't valid." })
  if (link.usedAt !== null)
    return yield* new SignInLinkInvalid({
      reason: "used",
      message: "This sign-in link was already used. Ask for a new one.",
    })
  if (now >= link.expiresAt)
    return yield* new SignInLinkInvalid({
      reason: "expired",
      message: "This sign-in link expired. Ask for a new one.",
    })
  // Claim the link before anything else, so two clicks can't both sign in.
  const claimed = yield* database.query("signInLinks.use", (db) =>
    db
      .update(signInLinks)
      .set({ usedAt: now })
      .where(and(eq(signInLinks.id, link.id), isNull(signInLinks.usedAt)))
      .run(),
  )
  if ((claimed.meta.changes ?? 0) === 0)
    return yield* new SignInLinkInvalid({
      reason: "used",
      message: "This sign-in link was already used. Ask for a new one.",
    })
  const member = yield* findMember(link.memberId).pipe(
    Effect.catchTag("MemberNotFound", () =>
      Effect.fail(new SignInLinkInvalid({ reason: "unknown", message: "This sign-in link isn't valid." })),
    ),
  )
  return { member, returnTo: safeReturn(link.returnTo) }
})

/** A member as a caller, for opening their session. */
export const callerFor = (m: typeof members.$inferSelect): Caller => ({
  keyId: m.id,
  kind: "secret",
  scopes: [],
  member: { id: m.id, role: m.role, email: m.email, name: m.name },
})

// ---------------------------------------------------------------------------------------------
// Claiming the workspace, and handing it on
// ---------------------------------------------------------------------------------------------

/**
 * `POST /v1/workspace/claim`: the person holding the admin key names the workspace and becomes its
 * owner. Only once, only with the admin key. Until then the admin key acts as the owner.
 */
export const claimWorkspace = Effect.fn("people.claim")(function* (
  caller: Caller,
  input: { readonly workspaceName: string; readonly name: string; readonly email: string },
  origin: string,
  now = Date.now(),
) {
  if (caller.keyId !== ROOT.keyId)
    return yield* new PeopleForbidden({ message: "Claiming the workspace needs the admin key." })
  const setting = yield* workspaceSetting()
  if (setting.claimedAt !== undefined)
    return yield* new PeopleConflict({
      reason: "already-claimed",
      message: "This workspace has already been claimed.",
      ...(setting.claimedBy ? { claimedBy: setting.claimedBy } : {}),
      claimedAt: setting.claimedAt,
    })
  const email = normalizeEmail(input.email)
  if (!EMAIL.test(email))
    return yield* new PeopleInvalid({ field: "email", message: "Enter an email address." })
  const name = input.name.trim()
  const workspace = input.workspaceName.trim()
  if (!name) return yield* new PeopleInvalid({ field: "name", message: "Enter your name." })
  if (!workspace) return yield* new PeopleInvalid({ field: "workspaceName", message: "Name the workspace." })
  const database = yield* Database
  const existing = yield* findByEmail(email)
  const id = existing?.id ?? `mem_${yield* (yield* Ids).next}`
  if (existing)
    yield* database.query("members.reclaim", (db) =>
      db.update(members).set({ name, role: "owner", removedAt: null }).where(eq(members.id, id)).run(),
    )
  else
    yield* database.query("members.createOwner", (db) =>
      db.insert(members).values({ id, email, name, role: "owner", createdAt: now }).run(),
    )
  yield* putWorkspaceSetting({ ...setting, name: workspace, claimedBy: id, claimedAt: now })
  yield* recordAudit({
    actor: actorOf(caller),
    action: "workspace.claim",
    target: id,
    after: { workspace, email },
  })
  // Just written, so not finding it is a fault.
  const member = yield* findMember(id).pipe(Effect.catchTag("MemberNotFound", Effect.die))
  // The owner signs in from their inbox; without a sender they sign in with the admin key for now.
  const linkSent = yield* mailSignInLink(member, origin).pipe(
    Effect.as(true),
    Effect.catchTag("SystemSenderMissing", () => Effect.succeed(false)),
  )
  return { member: memberView(member), signInLinkSent: linkSent }
})

/**
 * Who someone signing in through Flareyard is here (HAL-3360). The platform has checked they own this
 * install, so they hold its Cloudflare account and could reach everything anyway:
 * - a current member with that email signs in as themselves;
 * - an unclaimed workspace is claimed by them, as owner;
 * - otherwise they join as an admin (or come back, if they were removed).
 * Each change is audited, so nobody gains access silently.
 */
export const signInFromFlareyard = Effect.fn("people.flareyard")(function* (
  user: { readonly id: string; readonly email: string; readonly name: string | null },
  now = Date.now(),
) {
  const email = normalizeEmail(user.email)
  if (!EMAIL.test(email))
    return yield* new PeopleInvalid({ field: "email", message: "Flareyard didn't give an email address." })
  const name = (user.name ?? "").trim() || email.split("@")[0] || email
  const database = yield* Database
  const existing = yield* findByEmail(email)
  if (existing && existing.removedAt === null) return { member: existing, joined: null }
  const setting = yield* workspaceSetting()
  const claiming = setting.claimedAt === undefined
  const role = claiming ? ("owner" as const) : ("admin" as const)
  const id = existing?.id ?? `mem_${yield* (yield* Ids).next}`
  if (existing)
    yield* database.query("members.flareyardReturn", (db) =>
      db.update(members).set({ role, removedAt: null }).where(eq(members.id, id)).run(),
    )
  else
    yield* database.query("members.flareyardJoin", (db) =>
      db.insert(members).values({ id, email, name, role, createdAt: now }).run(),
    )
  if (claiming) yield* putWorkspaceSetting({ ...setting, claimedBy: id, claimedAt: now })
  yield* recordAudit({
    actor: `flareyard:${user.id}`,
    action: claiming ? "workspace.claim" : "member.join",
    target: id,
    after: { email, role, via: "flareyard-install-owner", returning: existing !== undefined },
  })
  const member = yield* findMember(id).pipe(Effect.catchTag("MemberNotFound", Effect.die))
  return { member, joined: claiming ? ("claimed" as const) : ("admin" as const) }
})

/**
 * The one-time claim link a self-deployed install starts with (HAL-3587): `bun run deploy` (or
 * `bun run claim-link`) stores the SHA-256 of a fresh token under this settings key and prints
 * `<origin>/claim#token=<token>` in the deploy output, which only whoever deployed it sees. No
 * ADMIN_KEY is pasted anywhere. Minting again replaces it; claiming spends it.
 */
export const CLAIM_SETTING = "claim"

/**
 * `POST /v1/workspace/claim/link`: claims an unclaimed workspace with the claim link's token, as
 * its owner, and signs them in. The token is checked and spent before anything else is written, so
 * two tabs can't both claim.
 */
export const claimWithLink = Effect.fn("people.claimWithLink")(function* (
  input: {
    readonly claimToken: string
    readonly workspaceName: string
    readonly name: string
    readonly email: string
  },
  origin: string,
) {
  const setting = yield* workspaceSetting()
  if (setting.claimedAt !== undefined)
    return yield* new PeopleConflict({
      reason: "already-claimed",
      message: "This workspace has already been claimed. Sign in instead.",
      ...(setting.claimedBy ? { claimedBy: setting.claimedBy } : {}),
      claimedAt: setting.claimedAt,
    })
  // The same checks claimWorkspace makes, first: a typo mustn't spend the link.
  if (!EMAIL.test(normalizeEmail(input.email)))
    return yield* new PeopleInvalid({ field: "email", message: "Enter an email address." })
  if (!input.name.trim()) return yield* new PeopleInvalid({ field: "name", message: "Enter your name." })
  if (!input.workspaceName.trim())
    return yield* new PeopleInvalid({ field: "workspaceName", message: "Name the workspace." })
  const database = yield* Database
  const row = yield* database.query("settings.claim", (db) =>
    db.select().from(settings).where(eq(settings.key, CLAIM_SETTING)).get(),
  )
  const stored = (row?.value as { tokenHash?: unknown } | undefined)?.tokenHash
  const presented = yield* hashOf(input.claimToken)
  const invalid = new PeopleInvalid({
    field: "claimToken",
    message:
      "This claim link isn't valid any more. Run `bun run claim-link` where you deployed for a new one.",
  })
  if (typeof stored !== "string" || !timingSafeEqual(presented, stored)) return yield* invalid
  const spent = yield* database.query("settings.claimSpend", (db) =>
    db
      .delete(settings)
      .where(and(eq(settings.key, CLAIM_SETTING), eq(settings.updatedAt, row?.updatedAt ?? -1)))
      .run(),
  )
  if ((spent.meta.changes ?? 0) === 0) return yield* invalid
  const claimed = yield* claimWorkspace(ROOT, input, origin)
  return yield* findMember(claimed.member.id).pipe(Effect.catchTag("MemberNotFound", Effect.die))
})

/** `POST /v1/workspace/transfer { memberId }`: the owner hands ownership on and becomes an admin. */
export const transferOwnership = Effect.fn("people.transfer")(function* (caller: Caller, memberId: string) {
  if (caller.member?.role !== "owner")
    return yield* new PeopleForbidden({ message: "Only the owner can hand ownership on." })
  if (memberId === caller.keyId)
    return yield* new PeopleInvalid({ field: "memberId", message: "You're already the owner." })
  const target = yield* findMember(memberId)
  const database = yield* Database
  yield* database.query("members.transfer", (db) =>
    db.batch([
      db.update(members).set({ role: "owner" }).where(eq(members.id, target.id)),
      db.update(members).set({ role: "admin" }).where(eq(members.id, caller.keyId)),
    ]),
  )
  const setting = yield* workspaceSetting()
  yield* putWorkspaceSetting({ ...setting, claimedBy: target.id })
  yield* recordAudit({ actor: actorOf(caller), action: "workspace.transfer", target: target.id })
  return memberView(yield* findMember(target.id))
})

// ---------------------------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------------------------

/**
 * Inviters' names by id. A key (or the admin key, `root`) has no name a person should see, so it
 * maps to nothing and the invitation shows `invitedBy: null`, as the public view does (HAL-3492).
 */
const inviterNames = Effect.fn("people.inviterNames")(function* (ids: ReadonlyArray<string>) {
  const wanted = [...new Set(ids.filter((id) => id.startsWith("mem_")))]
  if (wanted.length === 0) return new Map<string, string>()
  const rows = yield* queryIn("invites.inviterNames", wanted, (db, chunk) =>
    db.select({ id: members.id, name: members.name }).from(members).where(inArray(members.id, chunk)).all(),
  )
  return new Map(rows.map((r) => [r.id, r.name]))
})

const inviteView = (
  i: typeof invites.$inferSelect,
  names: ReadonlyMap<string, string>,
  now = Date.now(),
) => ({
  id: i.id,
  email: i.email,
  role: i.role,
  mailboxes: i.mailboxes,
  message: i.message,
  invitedBy: names.get(i.invitedBy) ?? null,
  invitedById: i.invitedBy,
  createdAt: i.createdAt,
  expiresAt: i.expiresAt,
  sentAt: i.sentAt,
  sendCount: i.sendCount,
  status: (i.revokedAt !== null
    ? "revoked"
    : i.acceptedAt !== null
      ? "accepted"
      : i.sentAt === null
        ? "draft"
        : now >= i.expiresAt
          ? "expired"
          : "sent") as "revoked" | "accepted" | "draft" | "expired" | "sent",
})

/** `GET /v1/members`: everyone in the workspace, with their mailboxes, and the open invitations. */
export const listMembers = Effect.fn("people.list")(function* () {
  const database = yield* Database
  const rows = yield* database.query("members.list", (db) =>
    db.select().from(members).where(isNull(members.removedAt)).orderBy(asc(members.name)).limit(500).all(),
  )
  const grants = yield* grantsOf(rows.map((r) => r.id))
  const open = yield* database.query("invites.open", (db) =>
    db
      .select()
      .from(invites)
      .where(and(isNull(invites.acceptedAt), isNull(invites.revokedAt)))
      .orderBy(asc(invites.createdAt))
      .limit(500)
      .all(),
  )
  const inviters = yield* inviterNames(open.map((i) => i.invitedBy))
  return {
    members: rows.map((r) => ({ ...memberView(r), mailboxes: grants.get(r.id) ?? [] })),
    invites: open.map((i) => inviteView(i, inviters)),
  }
})

export const getMember = Effect.fn("people.get")(function* (id: string) {
  const m = yield* findMember(id)
  const grants = yield* grantsOf([id])
  return { ...memberView(m), mailboxes: grants.get(id) ?? [] }
})

/**
 * `PATCH /v1/members/{id}`: role, name, time zone and mailboxes. Nobody becomes owner this way (hand
 * ownership on instead), and the owner can't be demoted. A changed role ends the person's sessions,
 * so the new one applies everywhere at once.
 */
export const updateMember = Effect.fn("people.update")(function* (
  caller: Caller,
  id: string,
  input: {
    readonly role?: InviteRole | undefined
    readonly name?: string | undefined
    readonly timeZone?: string | undefined
    readonly mailboxes?: ReadonlyArray<MailboxGrant> | undefined
  },
) {
  const before = yield* findMember(id)
  if (input.role !== undefined && before.role === "owner")
    return yield* new OwnerProtected({ message: "The owner can't be demoted. Hand ownership on first." })
  if (input.name !== undefined && !input.name.trim())
    return yield* new PeopleInvalid({ field: "name", message: "A name can't be empty." })
  if (input.timeZone !== undefined && !isTimeZone(input.timeZone))
    return yield* new PeopleInvalid({ field: "timeZone", message: `${input.timeZone} isn't a time zone.` })
  if (input.mailboxes) yield* checkGrants(input.mailboxes)
  const database = yield* Database
  const set = {
    ...(input.role !== undefined ? { role: input.role } : {}),
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.timeZone !== undefined ? { timeZone: input.timeZone } : {}),
  }
  if (Object.keys(set).length > 0)
    yield* database.query("members.update", (db) =>
      db.update(members).set(set).where(eq(members.id, id)).run(),
    )
  if (input.mailboxes) yield* setGrants(id, input.mailboxes)
  if (input.role !== undefined && input.role !== before.role) yield* endSessionsOf(id)
  yield* recordAudit({
    actor: actorOf(caller),
    action: "member.update",
    target: id,
    before: { role: before.role, name: before.name },
    after: input,
  })
  return yield* getMember(id)
})

/** `PATCH /v1/me`: a person changes their own name and time zone. */
export const updateSelf = Effect.fn("people.updateSelf")(function* (
  caller: Caller,
  input: { readonly name?: string | undefined; readonly timeZone?: string | undefined },
) {
  if (!caller.member)
    return yield* new PeopleForbidden({ message: "Only a signed-in person has a profile; keys don't." })
  return yield* updateMember(caller, caller.keyId, { name: input.name, timeZone: input.timeZone })
})

/**
 * `DELETE /v1/members/{id}`: removes someone. Their sessions end, their mailboxes are taken back,
 * and the row stays so the audit log still names them. The owner can't be removed.
 */
export const removeMember = Effect.fn("people.remove")(function* (
  caller: Caller,
  id: string,
  now = Date.now(),
) {
  const m = yield* findMember(id)
  if (m.role === "owner")
    return yield* new OwnerProtected({ message: "The owner can't be removed. Hand ownership on first." })
  const database = yield* Database
  yield* database.query("members.remove", (db) =>
    db.batch([
      db.update(members).set({ removedAt: now }).where(eq(members.id, id)),
      db.delete(mailboxPeople).where(eq(mailboxPeople.memberId, id)),
    ]),
  )
  yield* endSessionsOf(id, now)
  yield* recordAudit({ actor: actorOf(caller), action: "member.remove", target: id, before: memberView(m) })
  return memberView({ ...m, removedAt: now })
})

// ---------------------------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------------------------

const inviteMail = (input: {
  workspace: string
  inviter: string
  role: string
  message: string | null
  url: string
}) => ({
  subject: `${input.inviter} invited you to ${input.workspace} on Mailyard`,
  html: `<p>${esc(input.inviter)} invited you to join ${esc(input.workspace)} on Mailyard as ${input.role === "admin" || input.role === "agent" ? "an" : "a"} ${esc(input.role)}.</p>${input.message ? `<blockquote>${esc(input.message)}</blockquote>` : ""}<p><a href="${esc(input.url)}">Accept the invitation</a></p><p>The invitation lasts 7 days. If you weren't expecting it, ignore this message.</p>`,
  text: `${input.inviter} invited you to join ${input.workspace} on Mailyard as a ${input.role}.\n${input.message ? `\n${input.message}\n` : ""}\nAccept the invitation: ${input.url}\n\nThe invitation lasts 7 days. If you weren't expecting it, ignore this message.\n`,
})

/** The person or key who invited, for the invitation's wording. */
const inviterName = (caller: Caller) => caller.member?.name ?? "The workspace admin"

const findInvite = Effect.fn("people.findInvite")(function* (id: string) {
  const database = yield* Database
  const i = yield* database.query("invites.get", (db) =>
    db.select().from(invites).where(eq(invites.id, id)).get(),
  )
  if (!i) return yield* new InviteNotFound({ id })
  return i
})

/**
 * `POST /v1/invites`: drafts an invitation and returns it with the email it would send. Nothing goes
 * out until the person inviting calls `POST /v1/invites/{id}/send`.
 */
export const createInvite = Effect.fn("people.invite")(function* (
  caller: Caller,
  input: {
    readonly email: string
    readonly role: InviteRole
    readonly mailboxes?: ReadonlyArray<MailboxGrant> | undefined
    readonly message?: string | undefined
  },
  origin: string,
  now = Date.now(),
) {
  const email = normalizeEmail(input.email)
  if (!EMAIL.test(email) || email.length > 254)
    return yield* new PeopleInvalid({ field: "email", message: "Enter an email address." })
  const existing = yield* findByEmail(email)
  if (existing && existing.removedAt === null)
    return yield* new PeopleConflict({
      reason: "already-member",
      message: `${email} is already in the workspace.`,
    })
  const database = yield* Database
  const open = yield* database.query("invites.openForEmail", (db) =>
    db
      .select({ id: invites.id })
      .from(invites)
      .where(and(eq(invites.email, email), isNull(invites.acceptedAt), isNull(invites.revokedAt)))
      .get(),
  )
  if (open)
    return yield* new PeopleConflict({
      reason: "already-invited",
      message: `${email} already has an open invitation (${open.id}). Send or revoke that one.`,
    })
  const grants = input.mailboxes ?? []
  yield* checkGrants(grants)
  const message = input.message?.trim() ? input.message.trim().slice(0, 1000) : null
  const id = `inv_${yield* (yield* Ids).next}`
  // The real token is minted when the invitation is sent; until then nothing can accept it.
  const placeholder = yield* hashOf(`unsent:${id}:${randomToken(16)}`)
  yield* database.query("invites.create", (db) =>
    db
      .insert(invites)
      .values({
        id,
        email,
        role: input.role,
        mailboxes: [...grants],
        message,
        tokenHash: placeholder,
        invitedBy: caller.keyId,
        createdAt: now,
        expiresAt: now + INVITE_MS,
      })
      .run(),
  )
  yield* recordAudit({
    actor: actorOf(caller),
    action: "invite.create",
    target: id,
    after: { email, role: input.role },
  })
  const invite = yield* findInvite(id).pipe(Effect.catchTag("InviteNotFound", Effect.die))
  const from = yield* systemFrom().pipe(Effect.option)
  const draft = inviteMail({
    workspace: yield* workspaceName(),
    inviter: inviterName(caller),
    role: input.role,
    message,
    url: `${origin}/invite/…`,
  })
  return {
    invite: inviteView(invite, yield* inviterNames([invite.invitedBy]), now),
    draft: {
      from: from._tag === "Some" ? from.value.email : null,
      to: email,
      ...draft,
    },
  }
})

/**
 * `POST /v1/invites/{id}/send` (and `/resend`): mints a fresh link, so any earlier one stops working,
 * restarts the 7 days and mails it. The person inviting chose to send it; this is the only way an
 * invitation leaves Mailyard.
 */
export const sendInvite = Effect.fn("people.sendInvite")(function* (
  caller: Caller,
  id: string,
  origin: string,
  now = Date.now(),
) {
  const invite = yield* findInvite(id)
  if (invite.revokedAt !== null)
    return yield* new InviteGone({ reason: "revoked", message: "This invitation was revoked." })
  if (invite.acceptedAt !== null)
    return yield* new InviteGone({ reason: "used", message: "This invitation was already accepted." })
  yield* systemFrom()
  const existing = yield* findByEmail(invite.email)
  if (existing && existing.removedAt === null)
    return yield* new PeopleConflict({
      reason: "already-member",
      message: `${invite.email} is already in the workspace.`,
    })
  const token = randomToken(32)
  const tokenHash = yield* hashOf(token)
  const database = yield* Database
  const sendCount = invite.sendCount + 1
  yield* database.query("invites.send", (db) =>
    db
      .update(invites)
      .set({ tokenHash, sentAt: now, sendCount, expiresAt: now + INVITE_MS })
      .where(eq(invites.id, id))
      .run(),
  )
  const mail = inviteMail({
    workspace: yield* workspaceName(),
    inviter: inviterName(caller),
    role: invite.role,
    message: invite.message,
    url: `${origin}/invite/${token}`,
  })
  yield* sendSystemMail({ to: { email: invite.email }, ...mail, key: `invite:${id}:${sendCount}` })
  yield* recordAudit({ actor: actorOf(caller), action: "invite.send", target: id, after: { sendCount } })
  const updated = yield* findInvite(id)
  return inviteView(updated, yield* inviterNames([updated.invitedBy]), now)
})

/** `DELETE /v1/invites/{id}`: the invitation's link stops working. */
export const revokeInvite = Effect.fn("people.revokeInvite")(function* (
  caller: Caller,
  id: string,
  now = Date.now(),
) {
  const invite = yield* findInvite(id)
  if (invite.acceptedAt !== null)
    return yield* new InviteGone({ reason: "used", message: "This invitation was already accepted." })
  const database = yield* Database
  if (invite.revokedAt === null)
    yield* database.query("invites.revoke", (db) =>
      db.update(invites).set({ revokedAt: now }).where(eq(invites.id, id)).run(),
    )
  yield* recordAudit({ actor: actorOf(caller), action: "invite.revoke", target: id })
  const updated = yield* findInvite(id)
  return inviteView(updated, yield* inviterNames([updated.invitedBy]), now)
})

/** `GET /v1/invites`: every invitation not yet accepted or revoked. */
export const listInvites = Effect.fn("people.listInvites")(function* () {
  return { invites: (yield* listMembers()).invites }
})

/** The invitation a token opens, or why it can't be used. */
const inviteByToken = Effect.fn("people.inviteByToken")(function* (token: string, now = Date.now()) {
  const database = yield* Database
  const tokenHash = yield* hashOf(token)
  const invite = yield* database.query("invites.byToken", (db) =>
    db.select().from(invites).where(eq(invites.tokenHash, tokenHash)).get(),
  )
  if (!invite || invite.sentAt === null) return yield* new InviteNotFound({ id: "token" })
  if (invite.revokedAt !== null)
    return yield* new InviteGone({
      reason: "revoked",
      message: "This invitation was revoked. Ask for a new one.",
    })
  if (invite.acceptedAt !== null)
    return yield* new InviteGone({
      reason: "used",
      message: "This invitation was already accepted. Sign in instead.",
    })
  if (now >= invite.expiresAt)
    return yield* new InviteGone({
      reason: "expired",
      message: "This invitation expired. Ask for a new one.",
    })
  return invite
})

/** `GET /v1/invites/{token}`: what an invitation offers, for the accept screen. No sign-in needed. */
export const describeInvite = Effect.fn("people.describeInvite")(function* (token: string) {
  const invite = yield* inviteByToken(token)
  const database = yield* Database
  const inviter = yield* database.query("invites.inviter", (db) =>
    db.select({ name: members.name }).from(members).where(eq(members.id, invite.invitedBy)).get(),
  )
  const addresses = invite.mailboxes.length
    ? yield* queryIn(
        "invites.mailboxes",
        invite.mailboxes.map((m) => m.mailboxId),
        (db, chunk) =>
          db
            .select({ id: mailboxes.id, address: mailboxes.address })
            .from(mailboxes)
            .where(inArray(mailboxes.id, chunk))
            .all(),
      )
    : []
  const byId = new Map(addresses.map((a) => [a.id, a.address]))
  return {
    email: invite.email,
    role: invite.role,
    workspace: yield* workspaceName(),
    invitedBy: inviter?.name ?? null,
    message: invite.message,
    expiresAt: invite.expiresAt,
    mailboxes: invite.mailboxes.map((m) => ({ ...m, address: byId.get(m.mailboxId) ?? null })),
  }
})

/**
 * `POST /v1/invites/{token}/accept { name? }`: joins the workspace with the invitation's role and
 * mailboxes, and returns the member so the handler can sign them in. The link went to the invited
 * address, so holding it is the proof of that address. Someone already signed in as another person
 * gets `email-mismatch`; someone removed earlier comes back with the new role.
 */
export const acceptInvite = Effect.fn("people.accept")(function* (
  token: string,
  input: { readonly name?: string | undefined },
  signedIn: Caller | null,
  now = Date.now(),
) {
  const invite = yield* inviteByToken(token, now)
  if (signedIn?.member && signedIn.member.email !== invite.email)
    return yield* new InviteEmailMismatch({
      message: `You're signed in as ${signedIn.member.email}, but this invitation is for ${invite.email}. Sign out, then open it again.`,
    })
  const database = yield* Database
  const existing = yield* findByEmail(invite.email)
  if (existing && existing.removedAt === null)
    return yield* new PeopleConflict({
      reason: "already-member",
      message: `${invite.email} is already in the workspace.`,
    })
  const name = input.name?.trim() || existing?.name || invite.email.split("@")[0] || invite.email
  // Take the invitation first, so it can only be used once.
  const taken = yield* database.query("invites.take", (db) =>
    db
      .update(invites)
      .set({ acceptedAt: now })
      .where(and(eq(invites.id, invite.id), isNull(invites.acceptedAt), isNull(invites.revokedAt)))
      .run(),
  )
  if ((taken.meta.changes ?? 0) === 0)
    return yield* new InviteGone({
      reason: "used",
      message: "This invitation was already accepted. Sign in instead.",
    })
  const id = existing?.id ?? `mem_${yield* (yield* Ids).next}`
  if (existing)
    yield* database.query("members.rejoin", (db) =>
      db
        .update(members)
        .set({ name, role: invite.role, removedAt: null, lastActiveAt: now })
        .where(eq(members.id, id))
        .run(),
    )
  else
    yield* database.query("members.join", (db) =>
      db
        .insert(members)
        .values({ id, email: invite.email, name, role: invite.role, createdAt: now, lastActiveAt: now })
        .run(),
    )
  // Mailboxes removed since the invitation was written are skipped rather than failing the join.
  const still = invite.mailboxes.length
    ? new Set(
        (yield* queryIn(
          "invites.stillThere",
          invite.mailboxes.map((m) => m.mailboxId),
          (db, chunk) =>
            db.select({ id: mailboxes.id }).from(mailboxes).where(inArray(mailboxes.id, chunk)).all(),
        )).map((m) => m.id),
      )
    : new Set<string>()
  yield* setGrants(
    id,
    invite.mailboxes.filter((m) => still.has(m.mailboxId)),
  )
  yield* database.query("invites.acceptedBy", (db) =>
    db.update(invites).set({ acceptedBy: id }).where(eq(invites.id, invite.id)).run(),
  )
  yield* recordAudit({ actor: id, action: "invite.accept", target: invite.id, after: { role: invite.role } })
  return yield* findMember(id)
})
