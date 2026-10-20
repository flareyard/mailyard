/**
 * /sign-in (design: screens/auth/sign-in*.html, 10 states). Three ways in: the Flareyard handoff (HAL-3360), an
 * access key exchanged for the HttpOnly session cookie (HAL-3358), and a sign-in link by email (HAL-3361). Every refusal the API types (HAL-3359) has
 * its own message; the key never touches storage and is cleared from the field once it has been sent.
 */
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { type FormEvent, useEffect, useState } from "react"
import { useCapabilities } from "../auth/capabilities.ts"
import { EmailLinkForm } from "../auth/EmailLinkForm.tsx"
import { FLAREYARD_ERRORS, type FlareyardError, isFlareyardError } from "../auth/flareyard.ts"
import { keyLooksValid, type SignInError, signInError, useSessionActions } from "../auth/session.ts"
import { fixturesEnabled } from "../fixtures/mode.ts"
import { AuthLayout } from "../ui/AuthLayout.tsx"
import { FlareyardMark } from "../ui/FlareyardMark.tsx"
import "../auth/auth.css"
import { Icon } from "../ui/icons.tsx"
import { RequestId } from "../ui/Panel.tsx"

type Search = { next?: string; error?: "session-expired" | FlareyardError }

export const Route = createFileRoute("/sign-in")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    ...(typeof s.next === "string" && s.next.startsWith("/") && !s.next.startsWith("//")
      ? { next: s.next }
      : {}),
    ...(s.error === "session-expired" || isFlareyardError(s.error) ? { error: s.error } : {}),
  }),
  component: SignIn,
})

const SCOPES = ["send", "track", "read", "admin"]

function SignIn() {
  const { next, error: initial } = Route.useSearch()
  const navigate = useNavigate()
  const { signIn } = useSessionActions()
  const caps = useCapabilities()
  const [key, setKey] = useState("")
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<SignInError | null>(
    initial === "session-expired" ? { kind: "session-expired" } : null,
  )
  const flareyardError = isFlareyardError(initial) ? FLAREYARD_ERRORS[initial] : null
  const [wait, setWait] = useState(0)

  useEffect(() => {
    if (error?.kind !== "rate-limited") return
    setWait(error.retryAfter)
    const t = setInterval(() => {
      setWait((w) => {
        if (w > 1) return w - 1
        clearInterval(t)
        return 0
      })
    }, 1000)
    return () => clearInterval(t)
  }, [error])

  const sessionsLive = caps.has("POST", "/v1/session")
  const flareyardLive = caps.has("GET", "/v1/session/flareyard/start")

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!keyLooksValid(key)) return setError({ kind: "format" })
    setBusy(true)
    setError(null)
    try {
      await signIn(key)
      setKey("")
      navigate({ to: next ?? "/" })
    } catch (err) {
      setError(signInError(err))
    } finally {
      setBusy(false)
    }
  }

  const fieldError = error ? message(error) : null
  const limited = error?.kind === "rate-limited" && wait > 0

  // Email sign-in is always offered; the access key is the fallback for the admin key and API keys.
  const otherWays = (
    <>
      <EmailLinkForm />
      <div className="or">or use an access key</div>

      <form className="stack stack-12" onSubmit={submit} noValidate>
        <div className="field">
          <label className="label" htmlFor="key">
            Access key
          </label>
          <div className={`input-group${fieldError ? " is-error" : ""}`}>
            <input
              className="input mono"
              id="key"
              name="key"
              type={show ? "text" : "password"}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="sk_… or your admin key"
              autoComplete="off"
              spellCheck={false}
              disabled={limited || busy}
              {...(fieldError
                ? { "aria-invalid": true, "aria-describedby": "key-err" }
                : { "aria-describedby": "key-hint" })}
            />
            <button
              className="btn btn-ghost"
              type="button"
              style={{ borderRadius: 0, height: "auto", borderLeft: "1px solid var(--my-border)" }}
              aria-label={show ? "Hide key" : "Show key"}
              aria-pressed={show}
              onClick={() => setShow(!show)}
            >
              <Icon name="eye" />
            </button>
          </div>
          {fieldError ? (
            <div className="field-error" id="key-err" role="alert">
              <Icon name="x-circle" />
              <div>{fieldError}</div>
            </div>
          ) : null}
          <p className="hint" id="key-hint">
            A secret key from <b>Settings → API keys</b>, or the admin key this Mailyard was deployed with.
          </p>
        </div>

        {error?.kind === "insufficient-scope" ? (
          <div className="callout callout-warn" role="alert">
            <Icon name="lock" />
            <div className="stack stack-8">
              <span>
                <b>This key can’t open Mailyard.</b> The app needs the <b>{error.required}</b> scope.
              </span>
              <span className="cluster cluster-4">
                {SCOPES.map((s) =>
                  s === error.required ? (
                    <span key={s} className="pill pill-fail">
                      <span className="dot" />
                      {s} · needed
                    </span>
                  ) : error.scopes.includes(s) ? (
                    <span key={s} className="pill pill-pass">
                      <span className="dot" />
                      {s}
                    </span>
                  ) : (
                    <span key={s} className="pill pill-neutral">
                      {s}
                    </span>
                  ),
                )}
              </span>
              <span className="t-small muted">
                Keys made for apps should stay narrow. Use a key with read, or make one in Settings → API
                keys.
              </span>
            </div>
          </div>
        ) : null}

        {error?.kind === "unreachable" ? (
          <div className="callout callout-fail" role="alert">
            <Icon name="wifi-off" />
            <span>
              <b>Mailyard isn’t answering.</b> Check your connection, or whether the Worker is deployed.
              Nothing was sent.
            </span>
          </div>
        ) : null}
        {error?.kind === "other" ? (
          <div className="callout callout-fail" role="alert">
            <Icon name="warn" />
            <div className="stack stack-4">
              <span>{error.message}</span>
              {error.requestId ? <RequestId id={error.requestId} /> : null}
            </div>
          </div>
        ) : null}

        {!caps.ready ? null : !sessionsLive ? (
          <div className="callout callout-info" role="status">
            <Icon name="info" />
            <span>
              Browser sign-in arrives with HAL-3358 (sessions). Until it deploys, this form can’t exchange a
              key. The API itself works with Bearer keys today.
            </span>
          </div>
        ) : null}

        {limited ? (
          <span className="has-reason" style={{ display: "flex", width: "100%" }}>
            <button
              className="btn btn-secondary btn-lg btn-block"
              type="button"
              aria-disabled="true"
              aria-describedby="key-why"
            >
              Try again in {wait} s
            </button>
            <span className="reason-pop" id="key-why" role="tooltip">
              <b>Too many failed sign-ins from this network. Try again in {wait} seconds.</b>
            </span>
          </span>
        ) : (
          <button
            className={`btn btn-secondary btn-lg btn-block${busy ? " is-loading" : ""}`}
            type="submit"
            disabled={busy || !sessionsLive}
          >
            {busy ? <span className="spinner" aria-hidden="true" /> : null}
            {busy ? "Checking the key…" : "Sign in with key"}
          </button>
        )}
        <p
          className="hint cluster"
          style={{ ["--gap" as string]: "6px", alignItems: "flex-start", flexWrap: "nowrap" }}
        >
          <Icon name="shield" />
          <span>
            Mailyard swaps the key for a session in the <code className="mono">__Host-mailyard_session</code>{" "}
            cookie: HTTP-only, so the key isn’t kept in this page and scripts can’t read the session. It lasts
            14 days from your last visit, 30 days at most.
          </span>
        </p>
      </form>
    </>
  )

  return (
    <AuthLayout>
      <div>
        <h1>Sign in to Mailyard</h1>
        <p className="lede">Email on your own Cloudflare account.</p>
      </div>

      {error?.kind === "session-expired" ? (
        <div className="callout callout-info" role="status">
          <Icon name="clock" />
          <span>Your session ended. Sessions last 14 days from your last visit and 30 days at most.</span>
        </div>
      ) : null}
      {flareyardError ? (
        <div className="callout callout-warn" role="alert">
          <Icon name="warn" />
          <span>{flareyardError}</span>
        </div>
      ) : null}

      {/* Installs Flareyard made list the hand-off in /openapi.json; self-hosted installs never show it (HAL-3360). */}
      {flareyardLive ? (
        <div className="stack stack-8">
          <a
            className="btn btn-primary btn-lg btn-block fy-btn"
            href={`/v1/session/flareyard/start?return=${encodeURIComponent(next ?? "/")}`}
          >
            <FlareyardChip />
            Continue with Flareyard
          </a>
          <p className="hint">
            This Mailyard was installed from Flareyard. If you're signed in there, it's one click.
          </p>
        </div>
      ) : null}
      {flareyardLive ? (
        <details className="other-ways">
          <summary>Other ways to sign in</summary>
          {otherWays}
        </details>
      ) : (
        otherWays
      )}
      {fixturesEnabled() ? <p className="t-small muted">Fixture mode: any key signs in.</p> : null}
    </AuthLayout>
  )
}

function message(e: SignInError): string | null {
  switch (e.kind) {
    case "format":
      return "That isn’t a key Mailyard recognises. Secret keys start with sk_; the admin key is the whole value it was deployed with, so check none of it was cut off."
    case "unknown":
      return "No key with that value exists in this workspace. It may belong to another Mailyard, or it was deleted."
    case "revoked":
      return `This key was revoked${e.revokedAt ? ` on ${new Date(e.revokedAt).toLocaleString("en", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC` : ""}, so it can’t sign in or send. Make a new one in Settings → API keys with a key that has the admin scope, or get a sign-in link by email.`
    case "public-key":
      return "That’s a public key (pk_). Public keys can only track events from a website, so they can’t open the app. Use a secret key (sk_) or the admin key."
    default:
      return null
  }
}

function FlareyardChip() {
  return (
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
  )
}
