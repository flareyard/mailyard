/**
 * /invite/$token (design: auth/invite-{valid,expired,used,wrong-account}.html; GAPS 1.12). Public; reads the
 * session cookie when there is one. `GET /v1/invites/{token}` says whether the invite is valid, expired or used,
 * and `signedInAs` when someone else is signed in; `POST …/accept` answers `409 email-mismatch` or
 * `410 expired | used`. It's HAL-3361, not built yet: until the routes are in the API's OpenAPI the screen says
 * so, shows what each role can do, and the accept button is disabled with the reason. Nothing fakes success.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { ApiError } from "../api/client.ts"
import { useCapabilities } from "../auth/capabilities.ts"
import { Gated } from "../auth/NoPermission.tsx"
import { meQuery, useSessionActions } from "../auth/session.ts"
import {
  type Invite,
  initials,
  plannedCall,
  ROLE_LABEL,
  ROLE_SUMMARY,
  type Role,
} from "../first-run/planned.ts"
import { AuthLayout } from "../ui/AuthLayout.tsx"
import { Icon } from "../ui/icons.tsx"
import { RequestId } from "../ui/Panel.tsx"

export const Route = createFileRoute("/invite/$token")({ component: InvitePage })

const ROLES: Role[] = ["owner", "admin", "sender", "agent", "viewer"]
const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  })
const dayTime = (iso: string) =>
  `${day(iso)} at ${new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" })} UTC`

function InvitePage() {
  const { token } = Route.useParams()
  const caps = useCapabilities()
  const live = caps.has("GET", "/v1/invites/{token}")
  const invite = useQuery({
    queryKey: ["invite", token],
    queryFn: () => plannedCall<Invite>("GET", `/v1/invites/${encodeURIComponent(token)}`),
    enabled: caps.ready && live,
    retry: false,
  })
  const [refused, setRefused] = useState<"expired" | "used" | "email-mismatch" | null>(null)

  if (!caps.ready || (live && invite.isPending))
    return (
      <AuthLayout caption="Invited to a yard someone else keeps tidy.">
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

  if (!live) return <NotLive />

  if (invite.isError) {
    const e = invite.error
    return (
      <AuthLayout caption="Invited to a yard someone else keeps tidy.">
        <div>
          <h1>
            {e instanceof ApiError && e.status === 404
              ? "This invite link doesn’t work"
              : "The invite didn’t load"}
          </h1>
          <p className="lede">
            {e instanceof ApiError && e.status === 404
              ? "No invite matches this link. It may have been cut short when it was copied, or the invite was withdrawn. Ask whoever sent it for a new one."
              : "Mailyard couldn’t be reached. Check your connection and reload."}
          </p>
        </div>
        {e instanceof ApiError && e.requestId ? <RequestId id={e.requestId} /> : null}
        <Link className="btn btn-secondary btn-lg btn-block" to="/sign-in">
          Go to sign in
        </Link>
      </AuthLayout>
    )
  }

  const inv = invite.data
  if (!inv) return <NotLive />
  const status = refused === "expired" || refused === "used" ? refused : inv.status
  if (status === "expired") return <Expired inv={inv} />
  if (status === "used") return <Used inv={inv} />
  if (
    refused === "email-mismatch" ||
    (inv.signedInAs && inv.signedInAs.toLowerCase() !== inv.email.toLowerCase())
  )
    return <WrongAccount inv={inv} token={token} />
  return <Valid inv={inv} token={token} onRefused={setRefused} />
}

function Inviter({ inv }: { inv: Invite }) {
  return (
    <div className="person">
      <span className="avatar avatar-lg" aria-hidden="true">
        {initials(inv.inviter.name)}
      </span>
      <span className="p-meta">
        <span className="p-name">{inv.inviter.name} invited you</span>
        <span className="p-mail">{inv.inviter.email}</span>
      </span>
    </div>
  )
}

function RoleCard({ role, mailboxes }: { role: Role; mailboxes: string[] }) {
  const r = ROLE_SUMMARY[role]
  return (
    <div className="role-card" data-od-id="invite-role">
      <div className="spread">
        <span className="t-h4">
          You’ll join as{" "}
          <span className="pill pill-role">
            <Icon name="shield" />
            {ROLE_LABEL[role]}
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
      {mailboxes.length ? (
        <p className="t-small muted">
          Mailboxes: <span className="mono">{mailboxes.join(", ")}</span>
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

function NotLive() {
  return (
    <AuthLayout caption="Invited to a yard someone else keeps tidy.">
      <div>
        <h1>Join a workspace on Mailyard</h1>
        <p className="lede">
          This link is an invite to a Mailyard workspace. Invites name the address they were sent to and the
          role you’ll have.
        </p>
      </div>
      <div className="callout callout-info" role="status">
        <Icon name="info" />
        <div className="stack stack-4">
          <span>
            <b>Invites arrive with people and roles (HAL-3361).</b> This Mailyard can’t read or accept invites
            yet, so this link can’t be checked. Ask whoever sent it for an access key from Settings → API keys
            meanwhile.
          </span>
          <span>
            <span className="pill pill-proposal">Planned · HAL-3361</span>
          </span>
        </div>
      </div>
      <RolesTable />
      <div className="stack stack-8">
        <Gated
          allowed={false}
          reason="Accepting invites isn’t live yet"
          who="It arrives with HAL-3361 (people and roles)."
          block
        >
          <button className="btn btn-primary btn-lg btn-block" type="button" data-od-id="accept-invite">
            Accept invite
          </button>
        </Gated>
        <Link className="link" to="/sign-in">
          Sign in with an access key instead
        </Link>
      </div>
    </AuthLayout>
  )
}

function useAccept(token: string, onRefused: (r: "expired" | "used" | "email-mismatch") => void) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  return useMutation({
    mutationFn: () =>
      plannedCall<{ redirect?: string } | undefined>(
        "POST",
        `/v1/invites/${encodeURIComponent(token)}/accept`,
      ),
    onSuccess: async (res) => {
      // Accepting may hand over to Flareyard to sign in as the invited address; follow it when it does.
      if (res && typeof res.redirect === "string" && res.redirect.startsWith("/")) {
        window.location.assign(res.redirect)
        return
      }
      await qc.invalidateQueries({ queryKey: meQuery.queryKey })
      navigate({ to: "/" })
    },
    onError: (e) => {
      if (!(e instanceof ApiError)) return
      const reason = e.body.reason
      if (e.status === 409 && reason === "email-mismatch") onRefused("email-mismatch")
      if (e.status === 410 && (reason === "expired" || reason === "used")) onRefused(reason)
    },
  })
}

function Valid({
  inv,
  token,
  onRefused,
}: {
  inv: Invite
  token: string
  onRefused: (r: "expired" | "used" | "email-mismatch") => void
}) {
  const caps = useCapabilities()
  const acceptLive = caps.has("POST", "/v1/invites/{token}/accept")
  const accept = useAccept(token, onRefused)
  return (
    <AuthLayout caption="Invited to a yard someone else keeps tidy.">
      <div>
        <h1>Join {inv.workspace.name} on Mailyard</h1>
        <p className="lede">
          This invite is for <span className="mono">{inv.email}</span>. It expires on {day(inv.expiresAt)}.
        </p>
      </div>
      <Inviter inv={inv} />
      <RoleCard role={inv.role} mailboxes={inv.mailboxes} />
      <RolesTable mine={inv.role} />
      <div className="stack stack-8">
        <Gated
          allowed={acceptLive}
          reason="Accepting invites isn’t live yet"
          who="It arrives with HAL-3361 (people and roles)."
          block
        >
          <button
            className={`btn btn-primary btn-lg btn-block${accept.isPending ? " is-loading" : ""}`}
            type="button"
            onClick={() => accept.mutate()}
            disabled={accept.isPending}
            data-endpoint="POST /v1/invites/{token}/accept (planned, HAL-3361)"
            data-od-id="accept-invite"
          >
            {accept.isPending ? <span className="spinner" aria-hidden="true" /> : null}
            {accept.isPending ? "Accepting…" : "Accept invite"}
          </button>
        </Gated>
        <p className="hint">
          You’ll sign in with Flareyard as {inv.email}. No Flareyard account yet? It’s made for you on the
          next step.
        </p>
        {accept.isError &&
        !(
          accept.error instanceof ApiError &&
          (accept.error.status === 409 || accept.error.status === 410)
        ) ? (
          <div className="callout callout-fail" role="alert">
            <Icon name="warn" />
            <div className="stack stack-4">
              <span>
                {accept.error instanceof ApiError
                  ? accept.error.message
                  : "Mailyard couldn’t be reached. The invite wasn’t accepted."}
              </span>
              {accept.error instanceof ApiError && accept.error.requestId ? (
                <RequestId id={accept.error.requestId} />
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </AuthLayout>
  )
}

function Expired({ inv }: { inv: Invite }) {
  const first = inv.inviter.name.split(/\s+/)[0] ?? inv.inviter.name
  return (
    <AuthLayout caption="Invited to a yard someone else keeps tidy.">
      <div className="callout callout-warn">
        <Icon name="clock" />
        <span>
          <b>This invite expired on {day(inv.expiresAt)}.</b> Invites last 7 days.
        </span>
      </div>
      <div>
        <h1>Ask for a new invite</h1>
        <p className="lede">
          {inv.inviter.name} invited <span className="mono">{inv.email}</span> to {inv.workspace.name} as{" "}
          {/^[aeiou]/i.test(inv.role) ? "an" : "a"} {inv.role}. They can send a fresh link from Settings →
          Members.
        </p>
      </div>
      <Inviter inv={inv} />
      <a
        className="btn btn-secondary btn-lg btn-block"
        href={`mailto:${inv.inviter.email}?subject=${encodeURIComponent("New Mailyard invite")}`}
      >
        <Icon name="envelope" />
        Email {first}
      </a>
    </AuthLayout>
  )
}

function Used({ inv }: { inv: Invite }) {
  const first = inv.inviter.name.split(/\s+/)[0] ?? inv.inviter.name
  return (
    <AuthLayout caption="Invited to a yard someone else keeps tidy.">
      <div className="callout callout-info">
        <Icon name="info" />
        <span>
          <b>This invite was already accepted</b>
          {inv.acceptedAt ? ` on ${dayTime(inv.acceptedAt)}` : ""}, as{" "}
          <span className="mono">{inv.email}</span>.
        </span>
      </div>
      <div>
        <h1>You may already be in</h1>
        <p className="lede">
          If that was you, sign in. If it wasn’t, tell {inv.inviter.name}: they can remove the member and send
          a new invite.
        </p>
      </div>
      <Link className="btn btn-primary btn-lg btn-block" to="/sign-in">
        Sign in
      </Link>
      <a className="link" href={`mailto:${inv.inviter.email}`}>
        Email {first}
      </a>
    </AuthLayout>
  )
}

function WrongAccount({ inv, token }: { inv: Invite; token: string }) {
  const { signOut } = useSessionActions()
  const navigate = useNavigate()
  const caps = useCapabilities()
  const sessionsLive = caps.has("DELETE", "/v1/session")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const local = (a: string) => `${a.split("@")[0]}@`
  return (
    <AuthLayout caption="Invited to a yard someone else keeps tidy.">
      <div className="callout callout-warn">
        <Icon name="user" />
        <span>
          <b>
            You’re signed in as <span className="mono">{inv.signedInAs ?? "another account"}</span>
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
      <RoleCard role={inv.role} mailboxes={inv.mailboxes} />
      <div className="stack stack-8">
        <Gated
          allowed={sessionsLive}
          reason="Signing out isn’t live yet"
          who="It arrives with sessions (HAL-3358)."
          block
        >
          <button
            className={`btn btn-primary btn-lg btn-block${busy ? " is-loading" : ""}`}
            type="button"
            data-endpoint="DELETE /v1/session (planned, HAL-3358)"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              setError(null)
              try {
                await signOut()
                navigate({ to: "/sign-in", search: { next: `/invite/${token}` } })
              } catch (e) {
                setError(e)
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? <span className="spinner" aria-hidden="true" /> : null}
            Sign out and accept as {local(inv.email)}
          </button>
        </Gated>
        <Link className="btn btn-ghost btn-lg btn-block" to="/">
          Stay signed in as {inv.signedInAs ? local(inv.signedInAs) : "you"}
        </Link>
        {error ? (
          <div className="callout callout-fail" role="alert">
            <Icon name="warn" />
            <span>
              {error instanceof ApiError
                ? error.message
                : "Mailyard couldn’t be reached. You’re still signed in."}
            </span>
          </div>
        ) : null}
      </div>
    </AuthLayout>
  )
}
