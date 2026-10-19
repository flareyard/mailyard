/**
 * /claim (design: auth/claim-workspace.html, auth/claim-already-claimed.html; live contract HAL-3361). The first
 * person in with the deploy's admin key (Bearer or an admin-key session) claims the workspace and becomes its
 * owner; the admin key stays as break-glass. `POST /v1/workspace/claim { workspaceName, name, email }` answers
 * `{ member, signInLinkSent }`; a second claim gets `409 { reason: "already-claimed", claimedBy, claimedAt }`.
 * On a deploy older than HAL-3361 the route isn't in its OpenAPI, and the form says so instead of failing.
 *
 * Self-deployed installs have no admin key by default (HAL-3587): `bun run deploy` (or `bun run claim-link`) prints
 * `/claim#token=…`. The token lives in the fragment so it never reaches logs or a Referer; the page reads it once,
 * clears it from the address bar, and claims with `POST /v1/workspace/claim/link`, which signs the owner in.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { type FormEvent, useRef, useState } from "react"
import { ApiError, api, unwrap } from "../api/client.ts"
import { useCapabilities } from "../auth/capabilities.ts"
import { takeClaimToken } from "../auth/claimLink.ts"
import { Gated } from "../auth/NoPermission.tsx"
import { type Me, meQuery, useMe } from "../auth/session.ts"
import { describe, FieldError } from "../first-run/ui.tsx"
import { toDate } from "../lib/format.ts"
import { AuthLayout } from "../ui/AuthLayout.tsx"
import { FlareyardMark } from "../ui/FlareyardMark.tsx"
import { Icon } from "../ui/icons.tsx"
import { RequestId } from "../ui/Panel.tsx"

export const Route = createFileRoute("/claim")({ component: Claim })

type Claimed = { claimedBy: string | null; claimedAt: string | number | null }

/**
 * The claim-link exchange. It's called by path until the route is in this build's generated types (HAL-3587); the
 * answer is the `/v1/me` body, and the session cookie is set.
 */
async function claimWithLink(body: {
  claimToken: string
  workspaceName: string
  name: string
  email: string
}) {
  const res = await fetch("/v1/workspace/claim/link", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new ApiError(res.status, json)
  return json as Me
}

function Claim() {
  const me = useMe()
  const caps = useCapabilities()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [claimToken] = useState(takeClaimToken)
  const viaLink = claimToken !== null
  const live = viaLink
    ? caps.has("POST", "/v1/workspace/claim/link")
    : caps.has("POST", "/v1/workspace/claim")
  const [linkSpent, setLinkSpent] = useState(false)
  const workspace = me.data?.workspace.name ?? ""
  const [wsName, setWsName] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [claimed, setClaimed] = useState<Claimed | null>(null)
  const [done, setDone] = useState<{ email: string; workspace: string; linkSent: boolean } | null>(null)
  const refs = {
    ws: useRef<HTMLInputElement>(null),
    name: useRef<HTMLInputElement>(null),
    email: useRef<HTMLInputElement>(null),
  }
  const workspaceName = wsName ?? workspace

  const claim = useMutation({
    mutationFn: async (body: { workspaceName: string; name: string; email: string }) => {
      if (claimToken) {
        const me = await claimWithLink({ claimToken, ...body })
        return { me, member: null, signInLinkSent: false }
      }
      const res = await unwrap(api.POST("/v1/workspace/claim", { body }))
      return { me: null, member: res.member, signInLinkSent: res.signInLinkSent }
    },
    onSuccess: async (res, body) => {
      if (res.me) {
        // Signed in as the owner by the same request: straight into setup.
        qc.setQueryData(meQuery.queryKey, res.me)
        navigate({ to: "/", search: { step: "domain" } })
        return
      }
      await qc.invalidateQueries({ queryKey: meQuery.queryKey })
      setDone({
        email: res.member?.email ?? body.email,
        workspace: body.workspaceName,
        linkSent: res.signInLinkSent,
      })
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 400 && e.body.field === "claimToken") setLinkSpent(true)
      else if (e instanceof ApiError && e.status === 409 && e.reason === "already-claimed")
        setClaimed({
          claimedBy: typeof e.body.claimedBy === "string" ? e.body.claimedBy : null,
          claimedAt:
            typeof e.body.claimedAt === "string" || typeof e.body.claimedAt === "number"
              ? e.body.claimedAt
              : null,
        })
      else if (e instanceof ApiError && e.status === 400 && typeof e.body.field === "string")
        setErrors({ [e.body.field === "workspaceName" ? "ws" : e.body.field]: e.message })
    },
  })

  if (claimed) return <AlreadyClaimed claimed={claimed} workspace={workspace} />
  if (done)
    return <ClaimedNow done={done} onContinue={() => navigate({ to: "/", search: { step: "domain" } })} />

  if (linkSpent) return <LinkSpent />

  const adminKey = me.data?.via === "admin-key"
  const signedOut = me.error instanceof ApiError && me.error.status === 401

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const errs: Record<string, string> = {}
    if (!workspaceName.trim()) errs.ws = "Name the workspace; it shows in the sidebar and on invites."
    if (!name.trim()) errs.name = "Your name, as members will see it."
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
      errs.email = "An email address, for alerts and to match your Flareyard account."
    setErrors(errs)
    const first = (["ws", "name", "email"] as const).find((k) => errs[k])
    if (first) return refs[first].current?.focus()
    claim.mutate({ workspaceName: workspaceName.trim(), name: name.trim(), email: email.trim() })
  }

  const blocked = viaLink
    ? caps.ready && !live
      ? {
          reason: "This Mailyard can’t take a claim link",
          who: "Update the deploy to a release with claim links.",
        }
      : null
    : !live
      ? {
          reason: "This Mailyard can’t be claimed yet",
          who: "Update the deploy to a release with people and roles (HAL-3361).",
        }
      : signedOut || !me.data
        ? {
            reason: "Sign in with the admin key first",
            who: "Only the deploy’s admin key can claim a workspace.",
          }
        : !adminKey
          ? {
              reason: "Only the admin key can claim",
              who: "You’re signed in with a scoped key. Sign in with the admin key this Mailyard was deployed with.",
            }
          : null

  return (
    <AuthLayout>
      <div>
        {viaLink ? (
          <span className="pill pill-role">
            <Icon name="link" />
            Opened from your claim link
          </span>
        ) : adminKey ? (
          <span className="pill pill-role">
            <Icon name="key" />
            Signed in with the admin key
          </span>
        ) : null}
        <h1 style={adminKey || viaLink ? { marginTop: 12 } : undefined}>Claim this workspace</h1>
        <p className="lede">
          This Mailyard has no owner yet. Claim it and you become the owner; the admin key stays as a
          break-glass key. Next comes a short setup checklist.
        </p>
      </div>

      {caps.ready && !live ? (
        <div className="callout callout-info" role="status">
          <Icon name="info" />
          <div className="stack stack-4">
            <span>
              <b>This Mailyard can’t be claimed yet.</b> Owners arrive with people and roles (HAL-3361), which
              this deploy doesn’t have. Update it from Flareyard; until then the admin key and the keys in
              Settings → API keys are how you get in.
            </span>
          </div>
        </div>
      ) : null}
      {!viaLink && live && signedOut ? (
        <div className="callout callout-warn" role="alert">
          <Icon name="lock" />
          <span>
            <b>Sign in with the admin key first.</b>{" "}
            <Link className="link" to="/sign-in" search={{ next: "/claim" }}>
              Sign in
            </Link>
            , then come back here.
          </span>
        </div>
      ) : null}
      {!viaLink && live && me.data && !adminKey ? (
        <div className="callout callout-warn" role="alert">
          <Icon name="key" />
          <span>
            You’re signed in with {me.data.key ? <b>{me.data.key.name}</b> : "a scoped key"}. Claiming needs
            the admin key this Mailyard was deployed with, or the claim link the deploy printed.
          </span>
        </div>
      ) : null}

      <form
        className="stack stack-16"
        onSubmit={submit}
        noValidate
        data-endpoint={
          viaLink ? "POST /v1/workspace/claim/link (HAL-3587)" : "POST /v1/workspace/claim (built, HAL-3361)"
        }
      >
        <div className="field">
          <label className="label" htmlFor="ws-name">
            Workspace name
          </label>
          <input
            ref={refs.ws}
            className="input"
            id="ws-name"
            value={workspaceName}
            onChange={(e) => setWsName(e.target.value)}
            disabled={claim.isPending}
            {...describe(errors.ws, "ws-err", "ws-hint")}
          />
          {errors.ws ? <FieldError id="ws-err">{errors.ws}</FieldError> : null}
          <p className="hint" id="ws-hint">
            Shown in the sidebar and on invites. You can change it later.
          </p>
        </div>
        <div className="field">
          <label className="label" htmlFor="you-name">
            Your name
          </label>
          <input
            ref={refs.name}
            className="input"
            id="you-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            disabled={claim.isPending}
            {...describe(errors.name, "name-err")}
          />
          {errors.name ? <FieldError id="name-err">{errors.name}</FieldError> : null}
        </div>
        <div className="field">
          <label className="label" htmlFor="you-mail">
            Your email
          </label>
          <input
            ref={refs.email}
            className="input mono"
            id="you-mail"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            disabled={claim.isPending}
            {...describe(errors.email, "mail-err", "mail-hint")}
          />
          {errors.email ? <FieldError id="mail-err">{errors.email}</FieldError> : null}
          <p className="hint" id="mail-hint">
            For alerts and sign-in links. If you installed from Flareyard, use the same email there.
          </p>
        </div>
        {claim.isError &&
        !(claim.error instanceof ApiError && (claim.error.status === 409 || claim.error.status === 400)) ? (
          <div className="callout callout-fail" role="alert">
            <Icon name="warn" />
            <div className="stack stack-4">
              <span>
                {claim.error instanceof ApiError
                  ? claim.error.message
                  : "Mailyard couldn’t be reached. Nothing was claimed."}
              </span>
              {claim.error instanceof ApiError && claim.error.requestId ? (
                <RequestId id={claim.error.requestId} />
              ) : null}
            </div>
          </div>
        ) : null}
        <Gated allowed={!blocked} reason={blocked?.reason} who={blocked?.who} block>
          <button
            className={`btn btn-primary btn-lg btn-block${claim.isPending ? " is-loading" : ""}`}
            type="submit"
            disabled={claim.isPending}
            data-od-id="claim-workspace"
          >
            {claim.isPending ? <span className="spinner" aria-hidden="true" /> : null}
            {claim.isPending ? "Claiming…" : "Claim workspace"}
            {claim.isPending ? null : <Icon name="arrow-right" />}
          </button>
        </Gated>
      </form>
      <p className="hint">
        Step 1 of 2 · then{" "}
        <Link className="link" to="/">
          the setup checklist
        </Link>
      </p>
    </AuthLayout>
  )
}

function AlreadyClaimed({ claimed, workspace }: { claimed: Claimed; workspace: string }) {
  const caps = useCapabilities()
  const flareyard = caps.has("GET", "/v1/session/flareyard/start")
  const at = toDate(claimed.claimedAt)
  const when = at
    ? at.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      })
    : null
  return (
    <AuthLayout>
      <div>
        <h1>This workspace already has an owner</h1>
        <p className="lede">
          {claimed.claimedBy ?? "Someone"} claimed {workspace || "this workspace"}
          {when ? ` on ${when}` : ""}. The admin key still works as a break-glass key, but the workspace
          belongs to its owner now.
        </p>
      </div>
      <div className="stack stack-8">
        {flareyard ? (
          <a
            className="btn btn-primary btn-lg btn-block fy-btn"
            href="/v1/session/flareyard/start?return=%2F"
            data-od-id="continue-with-flareyard"
          >
            <span
              className="fy-chip"
              style={{
                display: "grid",
                placeItems: "center",
                width: 22,
                height: 22,
                borderRadius: 4,
                background: "var(--background-100)",
                color: "var(--gray-1000)",
              }}
            >
              <FlareyardMark />
            </span>
            Continue with Flareyard
          </a>
        ) : null}
        <Link className={`btn btn-lg btn-block ${flareyard ? "btn-secondary" : "btn-primary"}`} to="/sign-in">
          <Icon name="mail" />
          Sign in with an email link
        </Link>
        <p className="hint">
          If you're a member, a link goes to your inbox. If you're not, ask the owner for an invite.
        </p>
      </div>
      <Link className="link" to="/sign-in">
        Back to sign in
      </Link>
    </AuthLayout>
  )
}

/** Claimed: you're the owner. The backend emails a sign-in link to the owner's address when it can. */
function ClaimedNow({
  done,
  onContinue,
}: {
  done: { email: string; workspace: string; linkSent: boolean }
  onContinue: () => void
}) {
  return (
    <AuthLayout>
      <div className="callout callout-ok" role="status">
        <Icon name="check-circle" />
        <span>
          <b>You own {done.workspace} now.</b> The admin key stays as a break-glass key.
        </span>
      </div>
      <div>
        <h1>{done.linkSent ? "Check your email" : "You’re the owner"}</h1>
        <p className="lede">
          {done.linkSent ? (
            <>
              A sign-in link is on its way to <span className="mono">{done.email}</span>. Open it to sign in
              as yourself, not the admin key. It works once.
            </>
          ) : (
            <>
              Mailyard couldn’t email a sign-in link (no system sender is set), so keep using the admin key
              for now. Once a sender is set, sign in by email as <span className="mono">{done.email}</span>.
            </>
          )}
        </p>
      </div>
      <button className="btn btn-primary btn-lg btn-block" type="button" onClick={onContinue}>
        Continue to the setup checklist
        <Icon name="arrow-right" />
      </button>
    </AuthLayout>
  )
}

/** The claim link was used or replaced by a newer one: say how to get a fresh one, and offer email sign-in. */
function LinkSpent() {
  const host = typeof window === "undefined" ? "" : window.location.origin
  return (
    <AuthLayout>
      <div>
        <h1>This claim link has been used</h1>
        <p className="lede">
          Claim links work once, and a newer one replaces older ones. Make a new link where you deployed
          Mailyard:
        </p>
      </div>
      <pre className="input mono" style={{ whiteSpace: "pre-wrap", height: "auto", padding: 12 }}>
        bun run claim-link {host}
      </pre>
      <p className="hint">
        Already claimed it?{" "}
        <Link className="link" to="/sign-in">
          Sign in with an email link
        </Link>
        .
      </p>
    </AuthLayout>
  )
}
