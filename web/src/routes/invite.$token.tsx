/**
 * /invite/$token (design: auth/invite-{valid,expired,used,wrong-account}.html; live contract HAL-3361).
 * Public. `GET /v1/invites/{token}` describes the invite (`404` unknown, `410 { reason: expired | used | revoked }`);
 * `POST …/accept { name? }` answers the /v1/me body and sets the session cookie, or refuses with
 * `409 email-mismatch | already-member` or `410`. Accepting lands you in the app, signed in.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { type FormEvent, useState } from "react"
import { ApiError, api, type paths, unwrap } from "../api/client.ts"
import { useCapabilities } from "../auth/capabilities.ts"
import { Gated } from "../auth/NoPermission.tsx"
import { meQuery, useMe, useSessionActions } from "../auth/session.ts"
import { inviteDay, inviterName, inviteState } from "../first-run/invite.ts"
import { initials, ROLE_LABEL, ROLE_SUMMARY, type Role } from "../first-run/roles.ts"
import { AuthLayout } from "../ui/AuthLayout.tsx"
import { Icon } from "../ui/icons.tsx"
import { RequestId } from "../ui/Panel.tsx"

export const Route = createFileRoute("/invite/$token")({ component: InvitePage })

type Invite = paths["/v1/invites/{token}"]["get"]["responses"][200]["content"]["application/json"]

const ROLES: Role[] = ["owner", "admin", "sender", "agent", "viewer"]
const article = (r: string) => (/^[aeiou]/i.test(r) ? "an" : "a")

function InvitePage() {
  const { token } = Route.useParams()
  const caps = useCapabilities()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const live = caps.has("GET", "/v1/invites/{token}")
  const invite = useQuery({
    queryKey: ["invite", token],
    queryFn: () => unwrap(api.GET("/v1/invites/{token}", { params: { path: { token } } })),
    enabled: caps.ready && live,
    retry: false,
  })
  const accept = useMutation({
    mutationFn: (name: string | undefined) =>
      unwrap(
        api.POST("/v1/invites/{token}/accept", { params: { path: { token } }, body: name ? { name } : {} }),
      ),
    onSuccess: (me) => {
      // Accepting signs you in: the answer is the /v1/me body, and the cookie is set.
      qc.setQueryData(meQuery.queryKey, me)
      navigate({ to: "/" })
    },
  })

  const state = inviteState({
    ready: caps.ready,
    live,
    pending: invite.isPending,
    error: invite.error,
    hasInvite: Boolean(invite.data),
    acceptError: accept.error,
  })
  const inv = invite.data

  switch (state) {
    case "loading":
      return (
        <AuthLayout>
          <div className="stack stack-8" aria-busy="true">
            <span className="sr-only" role="status">
              Loading the invite…
            </span>
            <span className="sk sk-title" />
            <span className="sk sk-text" />
            <span className="sk sk-text" style={{ width: "70%" }} />
          </div>
        </AuthLayout>
      )
    case "not-live":
      return <NotLive />
    case "unknown":
    case "unreachable":
      return <Broken error={invite.error} unknown={state === "unknown"} />
    case "expired":
      return <Gone title="This invite expired." note="Invites last 7 days." inv={inv} />
    case "revoked":
      return <Gone title="This invite was withdrawn." note="Whoever sent it took it back." inv={inv} />
    case "used":
      return <Used inv={inv} />
    case "already-member":
      return <AlreadyMember inv={inv} />
    case "wrong-account":
      return inv ? (
        <WrongAccount inv={inv} onAccept={() => accept.mutate(undefined)} busy={accept.isPending} />
      ) : (
        <Broken error={accept.error} unknown={false} />
      )
    default:
      return inv ? <Valid inv={inv} accept={accept} /> : <Broken error={invite.error} unknown />
  }
}

function Inviter({ inv }: { inv: Invite }) {
  const who = inviterName(inv.invitedBy, inv.workspace)
  return (
    <div className="person">
      <span className="avatar avatar-lg" aria-hidden="true">
        {initials(inv.invitedBy?.trim() || inv.workspace)}
      </span>
      <span className="p-meta">
        <span className="p-name">{who} invited you</span>
        <span className="p-mail">to {inv.workspace}</span>
      </span>
    </div>
  )
}

function RoleCard({ inv }: { inv: Invite }) {
  const r = ROLE_SUMMARY[inv.role]
  const boxes = inv.mailboxes.filter((m) => m.address)
  return (
    <div className="role-card" data-od-id="invite-role">
      <div className="spread">
        <span className="t-h4">
          You’ll join as{" "}
          <span className="pill pill-role">
            <Icon name="shield" />
            {ROLE_LABEL[inv.role]}
          </span>
        </span>
      </div>
      <ul className="role-list">
        {r.can.map((c) => (
          <li key={c}>
            <Icon name="check" label="Can" />
            <span>{c}</span>
          </li>
        ))}
        {r.cannot.map((c) => (
          <li key={c}>
            <Icon name="x" label="Can’t" />
            <span>{c}</span>
          </li>
        ))}
      </ul>
      {boxes.length ? (
        <p className="t-small muted">
          Mailboxes:{" "}
          {boxes.map((m, i) => (
            <span key={m.mailboxId}>
              {i ? ", " : ""}
              <span className="mono">{m.address}</span>
              {m.access !== "member" ? ` (${m.access})` : ""}
            </span>
          ))}
        </p>
      ) : null}
    </div>
  )
}

function RolesTable({ mine }: { mine?: Role }) {
  return (
    <details>
      <summary
        className="label"
        style={{ cursor: "pointer", minHeight: 44, lineHeight: "44px", display: "list-item" }}
      >
        Compare all roles
      </summary>
      <table className="roles-table">
        <tbody>
          {ROLES.map((r) => (
            <tr key={r} className={r === mine ? "is-mine" : ""}>
              <td>{ROLE_LABEL[r]}</td>
              <td>{ROLE_SUMMARY[r].table}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  )
}

function Refusal({ error, what }: { error: unknown; what: string }) {
  if (!error) return null
  return (
    <div className="callout callout-fail" role="alert">
      <Icon name="warn" />
      <div className="stack stack-4">
        <span>{error instanceof ApiError ? error.message : `Mailyard couldn’t be reached. ${what}`}</span>
        {error instanceof ApiError && error.requestId ? <RequestId id={error.requestId} /> : null}
      </div>
    </div>
  )
}

function Valid({
  inv,
  accept,
}: {
  inv: Invite
  accept: { mutate: (n: string | undefined) => void; isPending: boolean; error: unknown }
}) {
  const me = useMe()
  const signedIn = Boolean(me.data?.user)
  const [name, setName] = useState("")
  const submit = (e: FormEvent) => {
    e.preventDefault()
    accept.mutate(name.trim() || undefined)
  }
  return (
    <AuthLayout>
      <div>
        <h1>Join {inv.workspace} on Mailyard</h1>
        <p className="lede">
          This invite is for <span className="mono">{inv.email}</span>. It expires on{" "}
          {inviteDay(inv.expiresAt)}.
        </p>
      </div>
      <Inviter inv={inv} />
      {inv.message ? (
        <blockquote className="callout callout-info" style={{ margin: 0 }}>
          <Icon name="envelope" />
          <span>“{inv.message}”</span>
        </blockquote>
      ) : null}
      <RoleCard inv={inv} />
      <RolesTable mine={inv.role} />
      <form className="stack stack-12" onSubmit={submit} noValidate>
        {signedIn ? null : (
          <div className="field">
            <label className="label" htmlFor="inv-name">
              Your name <span className="opt">· optional</span>
            </label>
            <input
              className="input"
              id="inv-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              disabled={accept.isPending}
              aria-describedby="inv-name-hint"
            />
            <p className="hint" id="inv-name-hint">
              How {inv.workspace} sees you. You can change it later.
            </p>
          </div>
        )}
        <button
          className={`btn btn-primary btn-lg btn-block${accept.isPending ? " is-loading" : ""}`}
          type="submit"
          disabled={accept.isPending}
          data-endpoint="POST /v1/invites/{token}/accept (built, HAL-3361)"
          data-od-id="accept-invite"
        >
          {accept.isPending ? <span className="spinner" aria-hidden="true" /> : null}
          {accept.isPending ? "Accepting…" : "Accept invite"}
        </button>
        <p className="hint">
          Accepting signs you in to {inv.workspace} as {inv.email} on this browser.
        </p>
        <Refusal error={accept.error} what="The invite wasn’t accepted." />
      </form>
    </AuthLayout>
  )
}

function Gone({ title, note, inv }: { title: string; note: string; inv: Invite | undefined }) {
  return (
    <AuthLayout>
      <div className="callout callout-warn">
        <Icon name="clock" />
        <span>
          <b>{title}</b> {note}
        </span>
      </div>
      <div>
        <h1>Ask for a new invite</h1>
        <p className="lede">
          {inv
            ? `${inviterName(inv.invitedBy, inv.workspace)} invited ${inv.email} to ${inv.workspace} as ${article(inv.role)} ${inv.role}. `
            : ""}
          Whoever invited you can send a fresh link from Settings → Members.
        </p>
      </div>
      <Link className="btn btn-secondary btn-lg btn-block" to="/sign-in">
        Already a member? Sign in
      </Link>
    </AuthLayout>
  )
}

function Used({ inv }: { inv: Invite | undefined }) {
  return (
    <AuthLayout>
      <div className="callout callout-info">
        <Icon name="info" />
        <span>
          <b>This invite was already accepted</b>
          {inv ? (
            <>
              , as <span className="mono">{inv.email}</span>
            </>
          ) : null}
          .
        </span>
      </div>
      <div>
        <h1>You may already be in</h1>
        <p className="lede">
          If that was you, sign in. If it wasn’t, tell whoever invited you: they can remove the member and
          send a new invite.
        </p>
      </div>
      <Link className="btn btn-primary btn-lg btn-block" to="/sign-in">
        Sign in
      </Link>
    </AuthLayout>
  )
}

function AlreadyMember({ inv }: { inv: Invite | undefined }) {
  return (
    <AuthLayout>
      <div className="callout callout-info">
        <Icon name="check-circle" />
        <span>
          <b>You’re already a member{inv ? ` of ${inv.workspace}` : ""}.</b> There’s nothing to accept.
        </span>
      </div>
      <div>
        <h1>You’re in</h1>
        <p className="lede">Open the app, or sign in if this browser isn’t signed in yet.</p>
      </div>
      <Link className="btn btn-primary btn-lg btn-block" to="/">
        Open Mailyard
      </Link>
      <Link className="link" to="/sign-in">
        Sign in
      </Link>
    </AuthLayout>
  )
}

function WrongAccount({ inv, onAccept, busy }: { inv: Invite; onAccept: () => void; busy: boolean }) {
  const me = useMe()
  const { signOut } = useSessionActions()
  const [leaving, setLeaving] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const current = me.data?.user?.email ?? me.data?.key?.name ?? null
  const local = (a: string) => `${a.split("@")[0]}@`
  return (
    <AuthLayout>
      <div className="callout callout-warn" role="alert">
        <Icon name="user" />
        <span>
          <b>
            You’re signed in as <span className="mono">{current ?? "another account"}</span>
          </b>
          , but this invite is for <span className="mono">{inv.email}</span>.
        </span>
      </div>
      <div>
        <h1>Switch accounts to accept</h1>
        <p className="lede">
          Invites belong to the address they were sent to, so a forwarded link can’t give someone else access.
        </p>
      </div>
      <Inviter inv={inv} />
      <RoleCard inv={inv} />
      <div className="stack stack-8">
        <button
          className={`btn btn-primary btn-lg btn-block${leaving || busy ? " is-loading" : ""}`}
          type="button"
          data-endpoint="DELETE /v1/session · POST /v1/invites/{token}/accept"
          disabled={leaving || busy}
          onClick={async () => {
            setLeaving(true)
            setError(null)
            try {
              await signOut()
              onAccept()
            } catch (e) {
              setError(e)
            } finally {
              setLeaving(false)
            }
          }}
        >
          {leaving || busy ? <span className="spinner" aria-hidden="true" /> : null}
          Sign out and accept as {local(inv.email)}
        </button>
        <Link className="btn btn-ghost btn-lg btn-block" to="/">
          Stay signed in{current?.includes("@") ? ` as ${local(current)}` : ""}
        </Link>
        <Refusal error={error} what="You’re still signed in." />
      </div>
    </AuthLayout>
  )
}

function Broken({ error, unknown }: { error: unknown; unknown: boolean }) {
  return (
    <AuthLayout>
      <div>
        <h1>{unknown ? "This invite link doesn’t work" : "The invite didn’t load"}</h1>
        <p className="lede">
          {unknown
            ? "No invite matches this link. It may have been cut short when it was copied. Ask whoever sent it for a new one."
            : "Mailyard couldn’t be reached. Check your connection and reload."}
        </p>
      </div>
      {error instanceof ApiError && error.requestId ? <RequestId id={error.requestId} /> : null}
      <Link className="btn btn-secondary btn-lg btn-block" to="/sign-in">
        Go to sign in
      </Link>
    </AuthLayout>
  )
}

/** For a deploy older than HAL-3361: the route isn't in its OpenAPI, so say so rather than fail. */
function NotLive() {
  return (
    <AuthLayout>
      <div>
        <h1>Join a workspace on Mailyard</h1>
        <p className="lede">
          This link is an invite to a Mailyard workspace. Invites name the address they were sent to and the
          role you’ll have.
        </p>
      </div>
      <div className="callout callout-info" role="status">
        <Icon name="info" />
        <span>
          <b>This Mailyard can’t read invites yet.</b> Invites arrive with people and roles (HAL-3361); update
          the deploy, or ask whoever sent the link for an access key meanwhile.
        </span>
      </div>
      <RolesTable />
      <Gated
        allowed={false}
        reason="This Mailyard can’t accept invites yet"
        who="Update the deploy to a release with people and roles (HAL-3361)."
        block
      >
        <button className="btn btn-primary btn-lg btn-block" type="button" data-od-id="accept-invite">
          Accept invite
        </button>
      </Gated>
    </AuthLayout>
  )
}
